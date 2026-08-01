/**
 * TPS Tracker
 *
 * Measures one logical assistant response and keeps that Pi process's previous
 * completed value in the footer while the next response runs.
 */

import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "tps";
const CONFIG_PATH = join(getAgentDir(), "tps-tracker.json");
const LOCK_RETRY_MS = 25;
const GREEN = "\x1b[38;5;42m";
const RESET = "\x1b[0m";

interface TpsConfig {
	enabled: boolean;
}

interface ActiveCall {
	startedAt: number;
	firstOutputAt?: number;
	provider?: string;
	model?: string;
	api?: string;
	streamInvocations: number;
}

interface TpsRecord {
	provider?: string;
	model?: string;
	api?: string;
	inputTokens?: number;
	outputTokens: number;
	reasoningTokens?: number;
	ttftMs?: number;
	durationMs: number;
	endToEndTps: number;
	stopReason?: string;
}

interface LockOwner {
	nonce: string;
	pid: number;
	createdAt: number;
}

const DEFAULT_CONFIG: TpsConfig = { enabled: true };

let config: TpsConfig = { ...DEFAULT_CONFIG };
let activeCall: ActiveCall | undefined;
let lastRecord: TpsRecord | undefined;
let configWatcher: FSWatcher | undefined;
let configRefreshPromise: Promise<void> = Promise.resolve();

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

async function readTpsConfig(path = CONFIG_PATH): Promise<TpsConfig> {
	try {
		const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
		if (!isRecord(raw) || typeof raw.enabled !== "boolean") throw new Error(`Invalid TPS config at ${path}`);
		return { enabled: raw.enabled };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
		throw error;
	}
}

async function setTpsEnabled(path: string, enabled: boolean): Promise<TpsConfig> {
	return withFileLock(path, async () => {
		const next = { enabled };
		await writeJsonAtomic(path, next);
		return next;
	});
}

function monotonicNow(): number {
	return globalThis.performance?.now?.() ?? Date.now();
}

function modelLabel(ctx: ExtensionContext): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
}

function startCall(ctx: ExtensionContext): void {
	if (activeCall) {
		activeCall.streamInvocations += 1;
		return;
	}
	const model = ctx.model;
	activeCall = {
		startedAt: monotonicNow(),
		provider: model?.provider,
		model: model?.id,
		api: typeof model?.api === "string" ? model.api : undefined,
		streamInvocations: 1,
	};
}

function formatTps(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value) || value < 0) return "--";
	return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

function formatMs(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value) || value < 0) return "--";
	if (value < 1000) return `${Math.round(value)}ms`;
	return `${(value / 1000).toFixed(2)}s`;
}

function statusTextForRecord(record: TpsRecord): string {
	return `${GREEN}TPS: ${formatTps(record.endToEndTps)} tok/s${RESET}`;
}

function updateStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	if (!config.enabled) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, lastRecord ? statusTextForRecord(lastRecord) : undefined);
}

function isOutputDeltaEvent(type: string): boolean {
	return type === "text_delta" || type === "thinking_delta" || type === "toolcall_delta";
}

function finishCallFromMessage(message: Record<string, unknown>, ctx: ExtensionContext, stopReason?: string): void {
	const call = activeCall;
	if (!call) return;
	activeCall = undefined;

	const now = monotonicNow();
	const usage = isRecord(message.usage) ? message.usage : undefined;
	if (typeof usage?.output !== "number" || usage.output < 0) {
		updateStatus(ctx);
		return;
	}
	const outputTokens = usage.output;
	const durationMs = Math.max(1, now - call.startedAt);
	lastRecord = {
		provider: typeof message.provider === "string" ? message.provider : call.provider,
		model: typeof message.model === "string" ? message.model : call.model,
		api: typeof message.api === "string" ? message.api : call.api,
		inputTokens: typeof usage.input === "number" ? usage.input : undefined,
		outputTokens,
		reasoningTokens: typeof usage.reasoning === "number" ? usage.reasoning : undefined,
		ttftMs: call.firstOutputAt !== undefined ? call.firstOutputAt - call.startedAt : undefined,
		durationMs,
		endToEndTps: outputTokens / (durationMs / 1000),
		stopReason,
	};
	updateStatus(ctx);
}

function formatRecord(record: TpsRecord): string {
	const model = `${record.provider ?? "?"}/${record.model ?? "?"}`;
	const reason = record.stopReason ? ` stop=${record.stopReason}` : "";
	return `${model}: ${formatTps(record.endToEndTps)} tok/s, output=${record.outputTokens}, ttft=${formatMs(record.ttftMs)}, duration=${formatMs(record.durationMs)}${reason}`;
}

function showStatus(ctx: ExtensionContext): void {
	const lines = [
		`TPS tracker: ${config.enabled ? "enabled" : "disabled"}`,
		`Current model: ${modelLabel(ctx)}`,
		activeCall ? `Current response: running across ${activeCall.streamInvocations} provider stream invocation(s)` : undefined,
		lastRecord ? `Last response in this Pi process: ${formatRecord(lastRecord)}` : "Last response in this Pi process: none",
		"",
		"Usage: /tps [on|off|status]",
	].filter((line): line is string => line !== undefined);
	ctx.ui.notify(lines.join("\n"), "info");
}

function queueConfigRefresh(ctx: ExtensionContext): void {
	configRefreshPromise = configRefreshPromise
		.then(async () => {
			config = await readTpsConfig(CONFIG_PATH);
			if (!config.enabled) activeCall = undefined;
			updateStatus(ctx);
		})
		.catch((error) => ctx.ui.notify(`TPS config refresh failed: ${String(error)}`, "warning"));
}

async function startConfigWatcher(ctx: ExtensionContext): Promise<void> {
	configWatcher?.close();
	configWatcher = undefined;
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	configWatcher = watch(dirname(CONFIG_PATH), (_event, filename) => {
		if (filename !== null && String(filename) !== basename(CONFIG_PATH)) return;
		queueConfigRefresh(ctx);
	});
	configRefreshPromise = configRefreshPromise.then(async () => {
		try {
			config = await readTpsConfig(CONFIG_PATH);
		} catch (error) {
			ctx.ui.notify(`TPS config load failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		updateStatus(ctx);
	});
	await configRefreshPromise;
}

export const __tpsTest = {
	CONFIG_PATH,
	readTpsConfig,
	setTpsEnabled,
};

export default function tpsTracker(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		activeCall = undefined;
		lastRecord = undefined;
		await startConfigWatcher(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		configWatcher?.close();
		configWatcher = undefined;
		activeCall = undefined;
		await configRefreshPromise;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("model_select", async (_event, ctx) => updateStatus(ctx));

	pi.on("before_provider_request", (_event, ctx) => {
		if (!config.enabled) return;
		startCall(ctx);
		updateStatus(ctx);
	});

	pi.on("message_update", (event, ctx) => {
		if (!config.enabled || !activeCall) return;
		const streamEvent = event.assistantMessageEvent;
		if (!isRecord(streamEvent) || typeof streamEvent.type !== "string") return;
		const now = monotonicNow();
		if (isOutputDeltaEvent(streamEvent.type) && activeCall.firstOutputAt === undefined) activeCall.firstOutputAt = now;
		if (streamEvent.type === "done" && isRecord(streamEvent.message)) {
			finishCallFromMessage(streamEvent.message, ctx, typeof streamEvent.reason === "string" ? streamEvent.reason : undefined);
		}
		if (streamEvent.type === "error" && isRecord(streamEvent.error)) {
			finishCallFromMessage(streamEvent.error, ctx, typeof streamEvent.reason === "string" ? streamEvent.reason : undefined);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (!config.enabled || !activeCall) return;
		const message = event.message;
		if (!isRecord(message) || message.role !== "assistant") return;
		finishCallFromMessage(message, ctx, typeof message.stopReason === "string" ? message.stopReason : undefined);
	});

	pi.on("agent_end", async (_event, ctx) => {
		activeCall = undefined;
		updateStatus(ctx);
	});

	pi.registerCommand("tps", {
		description: "Show this Pi process's final model response throughput",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on" || action === "enable") {
				try {
					config = await setTpsEnabled(CONFIG_PATH, true);
				} catch (error) {
					ctx.ui.notify(`TPS config update failed: ${error instanceof Error ? error.message : String(error)}`, "error");
					return;
				}
				updateStatus(ctx);
				ctx.ui.notify("TPS tracker enabled", "info");
				return;
			}
			if (action === "off" || action === "disable") {
				try {
					config = await setTpsEnabled(CONFIG_PATH, false);
				} catch (error) {
					ctx.ui.notify(`TPS config update failed: ${error instanceof Error ? error.message : String(error)}`, "error");
					return;
				}
				activeCall = undefined;
				updateStatus(ctx);
				ctx.ui.notify("TPS tracker disabled", "warning");
				return;
			}
			if (action && action !== "status") {
				ctx.ui.notify("Usage: /tps [on|off|status]", "warning");
				return;
			}
			showStatus(ctx);
		},
	});
}
