import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---- Inlined Codex OAuth helpers (standalone extension; keep duplicated intentionally) ----
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const AUTH_LOCK_STALE_MS = 30_000;
const AUTH_LOCK_MAX_ATTEMPTS = 30;
const FETCH_TIMEOUT_MS = 60_000;

const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";

interface CodexOAuthCredential {
	accessToken: string;
	refreshToken?: string;
	accountId: string;
	email?: string;
	planType?: string;
	expiresAt?: number;
	isFedrampAccount: boolean;
	authPath?: string;
	source: "env" | "auth.json";
}

interface LoadedAuthJson {
	path: string;
	json: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	if (signal?.aborted) return Promise.reject(new Error("Operation aborted"));
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(resolve, ms);
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Operation aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function timeoutSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
	if (!parent) return AbortSignal.timeout(timeoutMs);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
	const onAbort = () => controller.abort(parent.reason);
	parent.addEventListener("abort", onAbort, { once: true });
	controller.signal.addEventListener(
		"abort",
		() => {
			clearTimeout(timeout);
			parent.removeEventListener("abort", onAbort);
		},
		{ once: true },
	);
	return controller.signal;
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> {
	if (!token) return {};
	const payload = token.split(".")[1];
	if (!payload) return {};
	try {
		return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function readAuthClaim(token: string | undefined): Record<string, unknown> {
	const claim = decodeJwtPayload(token)[CHATGPT_AUTH_CLAIM];
	return isRecord(claim) ? claim : {};
}

function expiresFromJwt(token: string | undefined): number | undefined {
	const exp = decodeJwtPayload(token).exp;
	if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) return undefined;
	const ms = exp * 1000;
	return Number.isSafeInteger(ms) ? ms : undefined;
}

function isAccessTokenFresh(accessToken: string | undefined, leewayMs = ACCESS_TOKEN_REFRESH_WINDOW_MS): boolean {
	const expiresAt = expiresFromJwt(accessToken);
	return expiresAt === undefined || expiresAt > Date.now() + leewayMs;
}

function codexHome(): string {
	return readString(process.env.CODEX_HOME) ?? join(homedir(), ".codex");
}

function codexAuthPath(): string {
	return readString(process.env.CODEX_AUTH_JSON) ?? join(codexHome(), "auth.json");
}

function loadAuthJson(path = codexAuthPath()): LoadedAuthJson | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(parsed) ? { path, json: parsed } : undefined;
	} catch (error) {
		throw new Error(`Failed to read Codex auth file ${path}: ${formatError(error)}`);
	}
}

function getTokens(authJson: Record<string, unknown>): Record<string, unknown> | undefined {
	return isRecord(authJson.tokens) ? authJson.tokens : undefined;
}

function tokenStringFromMaybeSerializedIdToken(value: unknown): string | undefined {
	if (typeof value === "string") return readString(value);
	if (isRecord(value)) return readString(value.raw_jwt);
	return undefined;
}

function credentialFromAuthJson(loaded: LoadedAuthJson): CodexOAuthCredential | undefined {
	const tokens = getTokens(loaded.json);
	if (!tokens) return undefined;
	const accessToken = readString(tokens.access_token);
	const refreshToken = readString(tokens.refresh_token);
	if (!accessToken) return undefined;
	const idToken = tokenStringFromMaybeSerializedIdToken(tokens.id_token);
	const accessClaim = readAuthClaim(accessToken);
	const idClaim = readAuthClaim(idToken);
	const accountId =
		readString(tokens.account_id) ??
		readString(accessClaim.chatgpt_account_id) ??
		readString(idClaim.chatgpt_account_id);
	if (!accountId) {
		throw new Error("Codex OAuth access token does not contain a ChatGPT account id. Re-run `codex login`.");
	}
	return {
		accessToken,
		...(refreshToken ? { refreshToken } : {}),
		accountId,
		...(readString(idClaim.email) ?? readString(decodeJwtPayload(idToken).email) ? { email: readString(idClaim.email) ?? readString(decodeJwtPayload(idToken).email) } : {}),
		...(readString(idClaim.chatgpt_plan_type) ? { planType: readString(idClaim.chatgpt_plan_type) } : {}),
		expiresAt: expiresFromJwt(accessToken),
		isFedrampAccount: idClaim.chatgpt_account_is_fedramp === true || accessClaim.chatgpt_account_is_fedramp === true,
		authPath: loaded.path,
		source: "auth.json",
	};
}

function credentialFromEnv(): CodexOAuthCredential | undefined {
	const accessToken = readString(process.env.CODEX_ACCESS_TOKEN);
	if (!accessToken) return undefined;
	const claim = readAuthClaim(accessToken);
	const accountId = readString(claim.chatgpt_account_id);
	if (!accountId) {
		throw new Error("CODEX_ACCESS_TOKEN is set, but it does not contain a ChatGPT account id claim.");
	}
	return {
		accessToken,
		accountId,
		expiresAt: expiresFromJwt(accessToken),
		isFedrampAccount: claim.chatgpt_account_is_fedramp === true,
		source: "env",
	};
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isRecord(error) && error.code === "EPERM";
	}
}

function lockHasLiveOwner(lockPath: string): boolean {
	try {
		const [pidText] = readFileSync(lockPath, "utf8").split(":", 1);
		const pid = Number(pidText);
		return Number.isSafeInteger(pid) && pid > 0 && isProcessAlive(pid);
	} catch {
		return false;
	}
}

async function withAuthLock<T>(authPath: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	const lockPath = `${authPath}.lock`;
	await mkdir(dirname(authPath), { recursive: true });
	let acquired = false;
	for (let attempt = 0; attempt < AUTH_LOCK_MAX_ATTEMPTS; attempt++) {
		if (signal?.aborted) throw new Error("Operation aborted");
		try {
			writeFileSync(lockPath, `${process.pid}:${Date.now()}`, { encoding: "utf8", flag: "wx", mode: 0o600 });
			acquired = true;
			break;
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") throw error;
			try {
				const lockStat = await stat(lockPath);
				if (Date.now() - lockStat.mtimeMs > AUTH_LOCK_STALE_MS && !lockHasLiveOwner(lockPath)) {
					await rm(lockPath, { force: true });
				}
			} catch {
				// Lock disappeared or could not be inspected; retry.
			}
			await sleep(100 * (attempt + 1), signal);
		}
	}
	if (!acquired) throw new Error(`Timed out waiting for Codex auth lock ${lockPath}`);
	try {
		return await fn();
	} finally {
		await rm(lockPath, { force: true }).catch(() => undefined);
	}
}

async function readJsonOrText(response: Response): Promise<{ json: unknown; text: string }> {
	const text = await response.text();
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	return { json, text };
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatHttpFailure(context: string, response: Response, body: { json: unknown; text: string }): string {
	const record = isRecord(body.json) ? body.json : {};
	const nestedError = isRecord(record.error) ? record.error : undefined;
	const code = readString(record.code) ?? readString(nestedError?.code) ?? readString(nestedError?.type);
	const message = readString(record.message) ?? readString(nestedError?.message) ?? body.text.slice(0, 800);
	return `${context} failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})${code ? ` [${code}]` : ""}${message ? `: ${message}` : ""}`;
}

interface RefreshResponse {
	id_token?: unknown;
	access_token?: unknown;
	refresh_token?: unknown;
}

async function requestTokenRefresh(refreshToken: string, signal?: AbortSignal): Promise<RefreshResponse> {
	const response = await fetch(readString(process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE) ?? DEFAULT_REFRESH_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			client_id: CODEX_OAUTH_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		}),
		signal: timeoutSignal(FETCH_TIMEOUT_MS, signal),
	});
	const body = await readJsonOrText(response);
	if (!response.ok) throw new Error(formatHttpFailure("Codex OAuth token refresh", response, body));
	return (isRecord(body.json) ? body.json : {}) as RefreshResponse;
}

function saveRefreshedAuth(loaded: LoadedAuthJson, refresh: RefreshResponse): LoadedAuthJson {
	const tokens = getTokens(loaded.json);
	if (!tokens) throw new Error("Codex auth file is missing tokens");
	const idToken = readString(refresh.id_token);
	const accessToken = readString(refresh.access_token);
	const refreshToken = readString(refresh.refresh_token);
	if (idToken) tokens.id_token = idToken;
	if (accessToken) tokens.access_token = accessToken;
	if (refreshToken) tokens.refresh_token = refreshToken;
	loaded.json.last_refresh = new Date().toISOString();
	writeFileSync(loaded.path, `${JSON.stringify(loaded.json, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	return loadAuthJson(loaded.path) ?? loaded;
}

async function refreshAuthJsonCredential(loaded: LoadedAuthJson, signal?: AbortSignal): Promise<CodexOAuthCredential> {
	const before = credentialFromAuthJson(loaded);
	if (!before?.refreshToken) throw new Error("Codex auth file has no refresh token. Re-run `codex login`.");
	const refresh = await requestTokenRefresh(before.refreshToken, signal);
	const nextLoaded = saveRefreshedAuth(loaded, refresh);
	const credential = credentialFromAuthJson(nextLoaded);
	if (!credential) throw new Error("Codex token refresh succeeded, but refreshed auth could not be loaded.");
	return credential;
}

async function loadCodexOAuthCredential(options: { allowRefresh?: boolean; signal?: AbortSignal } = {}): Promise<CodexOAuthCredential> {
	const envCredential = credentialFromEnv();
	if (envCredential) {
		if (!isAccessTokenFresh(envCredential.accessToken)) {
			throw new Error("CODEX_ACCESS_TOKEN is expired or expiring soon. Refresh it with `codex login` or unset CODEX_ACCESS_TOKEN to use ~/.codex/auth.json.");
		}
		return envCredential;
	}

	const authPath = codexAuthPath();
	const loaded = loadAuthJson(authPath);
	if (!loaded) {
		throw new Error(`No local Codex OAuth credentials found at ${authPath}. Run \`codex login\` first.`);
	}

	const credential = credentialFromAuthJson(loaded);
	if (!credential) {
		throw new Error(`Codex auth file ${authPath} does not contain ChatGPT OAuth tokens. Run \`codex login\`.`);
	}
	if (!options.allowRefresh || isAccessTokenFresh(credential.accessToken)) return credential;

	return withAuthLock(authPath, async () => {
		const reloaded = loadAuthJson(authPath);
		if (!reloaded) throw new Error(`Codex auth file disappeared: ${authPath}`);
		const current = credentialFromAuthJson(reloaded);
		if (!current) throw new Error(`Codex auth file ${authPath} does not contain ChatGPT OAuth tokens.`);
		if (isAccessTokenFresh(current.accessToken)) return current;
		return refreshAuthJsonCredential(reloaded, options.signal);
	}, options.signal);
}

function hasUsableCodexOAuthCredential(): boolean {
	try {
		const envCredential = credentialFromEnv();
		if (envCredential) return isAccessTokenFresh(envCredential.accessToken);
		const loaded = loadAuthJson();
		if (!loaded) return false;
		const credential = credentialFromAuthJson(loaded);
		return !!credential && (isAccessTokenFresh(credential.accessToken) || !!credential.refreshToken);
	} catch {
		return false;
	}
}

function codexBackendBaseUrl(): string {
	return readString(process.env.CODEX_BACKEND_BASE_URL) ?? DEFAULT_CODEX_BASE_URL;
}

function codexBackendUrl(path: string, baseUrl = codexBackendBaseUrl()): string {
	const normalizedBase = baseUrl.replace(/\/+$/, "");
	const normalizedPath = path.replace(/^\/+/, "");
	if (normalizedBase.endsWith("/codex")) return `${normalizedBase}/${normalizedPath}`;
	return `${normalizedBase}/codex/${normalizedPath}`;
}

function buildCodexHeaders(credential: CodexOAuthCredential, extraHeaders: Record<string, string> = {}): Headers {
	const headers = new Headers(extraHeaders);
	headers.set("Authorization", `Bearer ${credential.accessToken}`);
	headers.set("ChatGPT-Account-ID", credential.accountId);
	headers.set("originator", "pi-codex-extension");
	headers.set("User-Agent", `pi-codex-extension (${process.platform}; ${process.arch})`);
	if (credential.isFedrampAccount) headers.set("X-OpenAI-Fedramp", "true");
	return headers;
}

async function codexJsonRequest<T = unknown>(
	path: string,
	body: unknown,
	options: { signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<T> {
	const credential = await loadCodexOAuthCredential({ allowRefresh: true, signal: options.signal });
	const headers = buildCodexHeaders(credential, {
		Accept: "application/json",
		"Content-Type": "application/json",
		...(options.headers ?? {}),
	});
	const response = await fetch(codexBackendUrl(path), {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: timeoutSignal(FETCH_TIMEOUT_MS, options.signal),
	});
	const responseBody = await readJsonOrText(response);
	if (!response.ok) throw new Error(formatHttpFailure(`Codex ${path}`, response, responseBody));
	if (responseBody.json === undefined) throw new Error(`Codex ${path} returned non-JSON response: ${responseBody.text.slice(0, 800)}`);
	return responseBody.json as T;
}

function describeCredential(credential: CodexOAuthCredential): string {
	const bits = [
		`source=${credential.source}`,
		`account=${credential.accountId}`,
		credential.email ? `email=${credential.email}` : undefined,
		credential.planType ? `plan=${credential.planType}` : undefined,
		credential.expiresAt ? `expires=${new Date(credential.expiresAt).toLocaleString()}` : undefined,
		credential.authPath ? `authPath=${credential.authPath}` : undefined,
	];
	return bits.filter((bit): bit is string => !!bit).join(", ");
}
// ---- End inlined Codex OAuth helpers ----


const TOOL_NAME = "codex_search";
const SUBAGENT_CAPABILITY_REQUEST_CHANNEL = "pi-subagent:capability-request:v1";
const SUBAGENT_CAPABILITY_RESPONSE_CHANNEL = "pi-subagent:capability-response:v1";
const SUBAGENT_CAPABILITY_VERSION = 1;

function registerSubagentToolCapability(pi: ExtensionAPI): void {
	const extensionPath = realpathSync(fileURLToPath(import.meta.url));
	pi.events.on(SUBAGENT_CAPABILITY_REQUEST_CHANNEL, (data) => {
		if (!isRecord(data) || data.version !== SUBAGENT_CAPABILITY_VERSION || typeof data.requestId !== "string") return;
		pi.events.emit(SUBAGENT_CAPABILITY_RESPONSE_CHANNEL, {
			version: SUBAGENT_CAPABILITY_VERSION,
			requestId: data.requestId,
			kind: "read-only-tools",
			extensionPath,
			tools: [TOOL_NAME],
		});
	});
}
const DEFAULT_SEARCH_MODEL = process.env.CODEX_SEARCH_MODEL || "gpt-5.4-mini";
const OUTPUT_DIR = process.env.CODEX_SEARCH_OUTPUT_DIR || join(homedir(), ".pi", "agent", "codex-search", "outputs");

interface CodexSearchResponse {
	encrypted_output?: unknown;
	output?: unknown;
}

interface CodexSearchParams {
	query: string;
	model?: string;
	recencyDays?: number;
	allowedDomains?: string[];
	blockedDomains?: string[];
	contextSize?: string;
	responseLength?: string;
	maxOutputTokens?: number;
	includeImageResults?: boolean;
	location?: {
		country?: string;
		region?: string;
		city?: string;
		timezone?: string;
	};
}

function normalizeEnum<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, label: string): T {
	if (!value) return fallback;
	const normalized = value.toLowerCase();
	const match = allowed.find((item) => item === normalized);
	if (!match) throw new Error(`Invalid ${label}: ${value}. Expected one of ${allowed.join(", ")}.`);
	return match;
}

function cleanDomains(domains: string[] | undefined): string[] | undefined {
	if (!Array.isArray(domains)) return undefined;
	const cleaned = domains
		.map((domain) => domain.trim().toLowerCase())
		.filter(Boolean)
		.map((domain) => domain.replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
	return cleaned.length > 0 ? [...new Set(cleaned)] : undefined;
}

function positiveInteger(value: number | undefined, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
	return value;
}

function modelSupportsNativeWebSearch(model: ExtensionContext["model"]): boolean {
	const record = model as unknown as Record<string, unknown> | undefined;
	if (!record) return false;
	if (record.webSearch === true || record.web_search === true || record.nativeWebSearch === true) return true;
	const capabilityFields = [record.capabilities, record.features, record.tools, record.nativeTools];
	return capabilityFields.some((value) => Array.isArray(value) && value.some((item) => /^(web[_-]?search|search)$/i.test(String(item))));
}

function createSearchToolSync(pi: ExtensionAPI): (model: ExtensionContext["model"]) => void {
	let previousModelHadNativeSearch: boolean | undefined;
	let removedByExtension = false;

	return (model) => {
		const nativeSearch = modelSupportsNativeWebSearch(model);
		const active = pi.getActiveTools();
		if (nativeSearch) {
			if (active.includes(TOOL_NAME)) {
				pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
				removedByExtension = true;
			} else if (previousModelHadNativeSearch !== true) {
				removedByExtension = false;
			}
		} else {
			if (previousModelHadNativeSearch === true && removedByExtension && !active.includes(TOOL_NAME)) {
				pi.setActiveTools([...active, TOOL_NAME]);
			}
			removedByExtension = false;
		}
		previousModelHadNativeSearch = nativeSearch;
	};
}

function buildSearchRequest(params: CodexSearchParams): Record<string, unknown> {
	const contextSize = normalizeEnum(params.contextSize, ["low", "medium", "high"] as const, "medium", "contextSize");
	const responseLength = normalizeEnum(params.responseLength, ["short", "medium", "long"] as const, "medium", "responseLength");
	const allowedDomains = cleanDomains(params.allowedDomains);
	const blockedDomains = cleanDomains(params.blockedDomains);
	const searchQuery: Record<string, unknown> = { q: params.query };
	const recency = positiveInteger(params.recencyDays, "recencyDays");
	if (recency !== undefined) searchQuery.recency = recency;
	if (allowedDomains?.length) searchQuery.domains = allowedDomains;

	const settings: Record<string, unknown> = {
		search_context_size: contextSize,
		allowed_callers: ["direct"],
		external_web_access: "live",
	};
	if (allowedDomains?.length || blockedDomains?.length) {
		settings.filters = {
			...(allowedDomains?.length ? { allowed_domains: allowedDomains } : {}),
			...(blockedDomains?.length ? { blocked_domains: blockedDomains } : {}),
		};
	}
	if (params.includeImageResults) settings.image_settings = { max_results: 4, caption: true };
	if (params.location && Object.values(params.location).some((value) => typeof value === "string" && value.trim())) {
		settings.user_location = {
			type: "approximate",
			...(params.location.country ? { country: params.location.country } : {}),
			...(params.location.region ? { region: params.location.region } : {}),
			...(params.location.city ? { city: params.location.city } : {}),
			...(params.location.timezone ? { timezone: params.location.timezone } : {}),
		};
	}

	const commands: Record<string, unknown> = {
		search_query: [searchQuery],
		response_length: responseLength,
	};
	if (params.includeImageResults) commands.image_query = [searchQuery];

	return {
		id: `pi-codex-search-${Date.now()}-${randomUUID().slice(0, 8)}`,
		model: params.model?.trim() || DEFAULT_SEARCH_MODEL,
		input: params.query,
		commands,
		settings,
		...(params.maxOutputTokens ? { max_output_tokens: positiveInteger(params.maxOutputTokens, "maxOutputTokens") } : {}),
	};
}

async function truncateToolText(text: string): Promise<{ text: string; details: Record<string, unknown> }> {
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) return { text: truncation.content, details: {} };
	await mkdir(OUTPUT_DIR, { recursive: true, mode: 0o700 });
	const outputPath = join(OUTPUT_DIR, `search-output-${Date.now()}-${randomUUID().slice(0, 8)}.txt`);
	await writeFile(outputPath, text, { encoding: "utf8", mode: 0o600 });
	const notice = `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${outputPath}]`;
	return { text: truncation.content + notice, details: { truncation, fullOutputPath: outputPath } };
}

async function runSearch(params: CodexSearchParams, signal?: AbortSignal): Promise<{ output: string; details: Record<string, unknown> }> {
	const request = buildSearchRequest(params);
	const response = await codexJsonRequest<CodexSearchResponse>("alpha/search", request, { signal });
	if (typeof response.output !== "string") throw new Error("Codex search response is missing string output.");
	return {
		output: response.output,
		details: {
			request: {
				id: request.id,
				model: request.model,
				query: params.query,
				contextSize: (request.settings as Record<string, unknown>).search_context_size,
				responseLength: (request.commands as Record<string, unknown>).response_length,
			},
			hasEncryptedOutput: typeof response.encrypted_output === "string" && response.encrypted_output.length > 0,
		},
	};
}

const LocationSchema = Type.Object({
	country: Type.Optional(Type.String({ description: "Country code or country name, e.g. US." })),
	region: Type.Optional(Type.String({ description: "Region/state, e.g. California." })),
	city: Type.Optional(Type.String({ description: "City, e.g. San Francisco." })),
	timezone: Type.Optional(Type.String({ description: "IANA timezone or UTC offset." })),
});

const CodexSearchParamsSchema = Type.Object({
	query: Type.String({ description: "Search query or research question." }),
	model: Type.Optional(Type.String({ description: `Codex search model override (default ${DEFAULT_SEARCH_MODEL}).` })),
	recencyDays: Type.Optional(Type.Integer({ description: "Restrict results to this many recent days." })),
	allowedDomains: Type.Optional(Type.Array(Type.String({ description: "Only search these domains." }))),
	blockedDomains: Type.Optional(Type.Array(Type.String({ description: "Exclude these domains." }))),
	contextSize: Type.Optional(Type.String({ description: "low, medium, or high. Default medium." })),
	responseLength: Type.Optional(Type.String({ description: "short, medium, or long. Default medium." })),
	maxOutputTokens: Type.Optional(Type.Integer({ description: "Optional backend output token cap." })),
	includeImageResults: Type.Optional(Type.Boolean({ description: "Also request image search results/captions when helpful." })),
	location: Type.Optional(LocationSchema),
});

export const __codexSearchTest = {
	createSearchToolSync,
	modelSupportsNativeWebSearch,
};

export default function (pi: ExtensionAPI) {
	if (!hasUsableCodexOAuthCredential()) return;

	const childMode = process.env.PI_SUBAGENT_CHILD === "1";
	if (!childMode) registerSubagentToolCapability(pi);
	const syncSearchToolForModel = createSearchToolSync(pi);
	pi.on("session_start", (_event, ctx) => syncSearchToolForModel(ctx.model));
	pi.on("model_select", (event) => syncSearchToolForModel(event.model));

	pi.registerTool({
		name: TOOL_NAME,
		label: "Codex Search",
		description: `Search the web through OpenAI Codex local OAuth credentials. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Run live web research through Codex OAuth and return cited/current results.",
		promptGuidelines: [
			`Use ${TOOL_NAME} by default for live/current web research instead of Ollama web search or unavailable native web_search tools.`,
			`Use ${TOOL_NAME} when a local/text-only model such as ollama/glm-5.2:cloud needs current information from the web.`,
			`This tool is auto-enabled as the default web-search fallback for models without explicit native web-search capability.`,
			`If ${TOOL_NAME} is unavailable or fails, use grok_search when that tool is available.`,
			`After ${TOOL_NAME} returns, cite or summarize the source URLs present in its output when answering the user.`,
		],
		parameters: CodexSearchParamsSchema,
		async execute(_toolCallId, params, signal, onUpdate) {
			onUpdate?.({ content: [{ type: "text", text: "Searching with Codex..." }] });
			const result = await runSearch(params as CodexSearchParams, signal);
			const truncated = await truncateToolText(result.output);
			return {
				content: [{ type: "text", text: truncated.text }],
				details: { ...result.details, ...truncated.details },
			};
		},
		renderCall(args, theme) {
			const query = typeof args.query === "string" ? args.query.slice(0, 100) : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("codex_search"))} ${theme.fg("muted", query)}`, 0, 0);
		},
		renderResult(result, { isPartial, expanded }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
			const details = result.details as Record<string, unknown> | undefined;
			let text = theme.fg("success", "Codex search complete");
			const request = details?.request as Record<string, unknown> | undefined;
			if (request?.model) text += theme.fg("muted", ` (${String(request.model)})`);
			if (details?.truncation) text += theme.fg("warning", " truncated");
			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") text += `\n${theme.fg("dim", content.text.split("\n").slice(0, 24).join("\n"))}`;
			}
			return new Text(text, 0, 0);
		},
	});

	if (!childMode) pi.registerCommand("codex-search", {
		description: "Show Codex search OAuth status",
		handler: async (_args, ctx) => {
			try {
				const credential = await loadCodexOAuthCredential({ allowRefresh: false, signal: ctx.signal });
				ctx.ui.notify(
					[`Codex search: ${describeCredential(credential)}`, `Default model: ${DEFAULT_SEARCH_MODEL}`, `Output dir: ${OUTPUT_DIR}`].join("\n"),
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Codex search auth error: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
