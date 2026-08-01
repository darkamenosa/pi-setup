/**
 * Fast Mode
 *
 * Global `/fast` support for Pi. When enabled, supported official OpenAI
 * Responses payloads receive `service_tier: "priority"`.
 */

import { randomUUID } from "node:crypto";
import { realpathSync, watch, type FSWatcher } from "node:fs";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "fast-mode";
const CONFIG_PATH = join(getAgentDir(), "fast-mode.json");
const FAST_SERVICE_TIER = "priority";
const SUPPORTED_APIS = new Set(["openai-responses", "openai-codex-responses"]);
const SUPPORTED_PROVIDERS = new Set(["openai", "openai-codex"]);
const SUPPORTED_TARGETS_TEXT = "official OpenAI API and OpenAI Codex OAuth models";
const LOCK_RETRY_MS = 25;
const YELLOW = "\x1b[38;5;220m";
const RESET = "\x1b[0m";
const SUBAGENT_CAPABILITY_REQUEST_CHANNEL = "pi-subagent:capability-request:v1";
const SUBAGENT_CAPABILITY_RESPONSE_CHANNEL = "pi-subagent:capability-response:v1";
const SUBAGENT_CAPABILITY_VERSION = 1;

interface FastModeConfig {
	enabled: boolean;
}

interface FastModeStats {
	appliedRequests: number;
	lastAppliedAt?: number;
	lastSkippedReason?: string;
}

interface LockOwner {
	nonce: string;
	pid: number;
	createdAt: number;
}

let config: FastModeConfig = { enabled: false };
const stats: FastModeStats = { appliedRequests: 0 };
let configWatcher: FSWatcher | undefined;
let refreshPromise: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function parseLockOwner(text: string): LockOwner | undefined {
	try {
		const owner = JSON.parse(text) as Partial<LockOwner>;
		if (typeof owner.nonce !== "string" || typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.createdAt !== "number") {
			return undefined;
		}
		return owner as LockOwner;
	} catch {
		return undefined;
	}
}

async function readLockOwner(lockPath: string): Promise<LockOwner | undefined> {
	try {
		return parseLockOwner(await readFile(lockPath, "utf8"));
	} catch {
		return undefined;
	}
}

async function readContendedLockOwner(lockPath: string): Promise<LockOwner | undefined> {
	try {
		const owner = parseLockOwner(await readFile(lockPath, "utf8"));
		if (!owner) throw new Error(`Lock owner is unreadable: ${lockPath}`);
		return owner;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function reclaimDeadLock(lockPath: string, owner: LockOwner): Promise<void> {
	if (processIsAlive(owner.pid)) return;
	const reapedPath = `${lockPath}.reaped.${owner.nonce}`;
	try {
		try {
			await link(lockPath, reapedPath);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "";
			if (code === "ENOENT") return;
			if (code !== "EEXIST") throw error;
		}

		const [marker, current] = await Promise.all([readLockOwner(reapedPath), readLockOwner(lockPath)]);
		if (marker?.nonce !== owner.nonce || current?.nonce !== owner.nonce || processIsAlive(current.pid)) return;
		await rm(lockPath, { force: true });
	} finally {
		const current = await readLockOwner(lockPath);
		if (current?.nonce !== owner.nonce) await rm(reapedPath, { force: true });
	}
}

async function acquireFileLock(path: string): Promise<() => Promise<void>> {
	const lockPath = `${path}.lock`;
	const owner: LockOwner = { nonce: randomUUID(), pid: process.pid, createdAt: Date.now() };
	const candidatePath = `${lockPath}.candidate.${owner.nonce}`;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(candidatePath, JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });

	try {
		while (true) {
			try {
				await link(candidatePath, lockPath);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const current = await readContendedLockOwner(lockPath);
				if (!current) continue;
				await reclaimDeadLock(lockPath, current);
				await sleep(LOCK_RETRY_MS);
			}
		}
	} finally {
		await rm(candidatePath, { force: true });
	}

	return async () => {
		const current = await readLockOwner(lockPath);
		if (current?.nonce !== owner.nonce) return;
		const releasedPath = `${lockPath}.released.${owner.nonce}`;
		try {
			await link(lockPath, releasedPath);
			const stillOwned = await readLockOwner(lockPath);
			if (stillOwned?.nonce === owner.nonce) await rm(lockPath, { force: true });
		} finally {
			await rm(releasedPath, { force: true });
		}
	};
}

async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const release = await acquireFileLock(path);
	try {
		return await operation();
	} finally {
		await release();
	}
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await mkdir(dirname(path), { recursive: true });
	try {
		await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

async function readFastConfig(path = CONFIG_PATH): Promise<FastModeConfig> {
	try {
		const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
		if (!isRecord(raw) || typeof raw.enabled !== "boolean") throw new Error(`Invalid fast mode config at ${path}`);
		return { enabled: raw.enabled };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false };
		throw error;
	}
}

async function setFastEnabled(path: string, enabled?: boolean): Promise<FastModeConfig> {
	return withFileLock(path, async () => {
		const current = await readFastConfig(path);
		const next = { enabled: enabled ?? !current.enabled };
		await writeJsonAtomic(path, next);
		return next;
	});
}

function currentApi(ctx: ExtensionContext): string | undefined {
	return typeof ctx.model?.api === "string" ? ctx.model.api : undefined;
}

function supportsFastTarget(provider: string | undefined, api: string | undefined): boolean {
	return api !== undefined && provider !== undefined && SUPPORTED_APIS.has(api) && SUPPORTED_PROVIDERS.has(provider);
}

function supportsFastPayload(ctx: ExtensionContext): boolean {
	const api = currentApi(ctx);
	const provider = ctx.model?.provider;
	return supportsFastTarget(provider, api);
}

function modelLabel(ctx: ExtensionContext): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
}

function updateStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(
		STATUS_KEY,
		config.enabled && supportsFastPayload(ctx) ? `${YELLOW}Fast: on${RESET}` : undefined,
	);
}

function showStatus(ctx: ExtensionContext): void {
	const lines = [
		`Fast mode: ${config.enabled ? "enabled" : "disabled"}`,
		`Current model: ${modelLabel(ctx)}`,
		`Current API: ${currentApi(ctx) ?? "unknown"}`,
		`Current provider: ${ctx.model?.provider ?? "unknown"}`,
		`Supported providers: ${SUPPORTED_TARGETS_TEXT}`,
		`Active for current model: ${config.enabled && supportsFastPayload(ctx) ? "yes" : "no"}`,
		`Request value when enabled: service_tier=${FAST_SERVICE_TIER}`,
		`Applied provider requests this runtime: ${stats.appliedRequests}`,
	];
	if (stats.lastAppliedAt) lines.push(`Last applied: ${new Date(stats.lastAppliedAt).toLocaleString()}`);
	if (stats.lastSkippedReason) lines.push(`Last skipped: ${stats.lastSkippedReason}`);
	lines.push("", "Usage: /fast [on|off|status]", `Config: ${CONFIG_PATH}`);
	ctx.ui.notify(lines.join("\n"), "info");
}

async function changeEnabled(enabled: boolean | undefined, ctx: ExtensionContext): Promise<void> {
	try {
		config = await setFastEnabled(CONFIG_PATH, enabled);
		updateStatus(ctx);
		ctx.ui.notify(`Fast mode ${config.enabled ? "enabled" : "disabled"}`, config.enabled ? "info" : "warning");
	} catch (error) {
		ctx.ui.notify(`Fast mode config update failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

function withFastServiceTier(payload: Record<string, unknown>): Record<string, unknown> {
	return { ...payload, service_tier: FAST_SERVICE_TIER };
}

function queueConfigRefresh(ctx: ExtensionContext): void {
	refreshPromise = refreshPromise
		.then(async () => {
			config = await readFastConfig(CONFIG_PATH);
			updateStatus(ctx);
		})
		.catch((error) => {
			ctx.ui.notify(`Fast mode config refresh failed: ${String(error)}`, "warning");
		});
}

async function startConfigWatcher(ctx: ExtensionContext): Promise<void> {
	configWatcher?.close();
	configWatcher = undefined;
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	configWatcher = watch(dirname(CONFIG_PATH), (_event, filename) => {
		if (filename !== null && String(filename) !== basename(CONFIG_PATH)) return;
		queueConfigRefresh(ctx);
	});
	refreshPromise = refreshPromise.then(async () => {
		try {
			config = await readFastConfig(CONFIG_PATH);
		} catch (error) {
			ctx.ui.notify(`Fast mode config load failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		updateStatus(ctx);
	});
	await refreshPromise;
}

export const __fastTest = {
	CONFIG_PATH,
	readFastConfig,
	setFastEnabled,
	supportsFastPayload,
	supportsFastTarget,
};

export default function fastMode(pi: ExtensionAPI) {
	const sourcePath = realpathSync(fileURLToPath(import.meta.url));
	pi.events.on(SUBAGENT_CAPABILITY_REQUEST_CHANNEL, (value) => {
		if (!isRecord(value) || value.version !== SUBAGENT_CAPABILITY_VERSION || typeof value.requestId !== "string" || !isRecord(value.target)) return;
		const provider = typeof value.target.provider === "string" ? value.target.provider : undefined;
		const api = typeof value.target.api === "string" ? value.target.api : undefined;
		if (!provider || !api) return;
		pi.events.emit(SUBAGENT_CAPABILITY_RESPONSE_CHANNEL, {
			version: SUBAGENT_CAPABILITY_VERSION,
			requestId: value.requestId,
			kind: "fast-mode",
			extensionPath: sourcePath,
			fastMode: config.enabled && supportsFastTarget(provider, api) ? FAST_SERVICE_TIER : "off",
		});
	});

	pi.on("session_start", async (_event, ctx) => {
		await startConfigWatcher(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		configWatcher?.close();
		configWatcher = undefined;
		await refreshPromise;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!config.enabled) return;
		if (!supportsFastPayload(ctx)) {
			stats.lastSkippedReason = `unsupported provider/api ${ctx.model?.provider ?? "unknown"}/${currentApi(ctx) ?? "unknown"}`;
			updateStatus(ctx);
			return;
		}
		if (!isRecord(event.payload)) {
			stats.lastSkippedReason = "payload was not an object";
			updateStatus(ctx);
			return;
		}

		stats.appliedRequests += 1;
		stats.lastAppliedAt = Date.now();
		stats.lastSkippedReason = undefined;
		updateStatus(ctx);
		return withFastServiceTier(event.payload);
	});

	pi.registerCommand("fast", {
		description: "Toggle OpenAI/OpenAI Codex fast service tier",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on" || action === "enable") return changeEnabled(true, ctx);
			if (action === "off" || action === "disable") return changeEnabled(false, ctx);
			if (action === "status" || action === "config") {
				showStatus(ctx);
				return;
			}
			if (action) {
				ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
				return;
			}
			await changeEnabled(undefined, ctx);
		},
	});
}
