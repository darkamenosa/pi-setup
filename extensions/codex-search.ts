import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_PROVIDER_ID = "openai-codex";
const FETCH_TIMEOUT_MS = 60_000;
const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";

interface PiCodexAuth {
	accessToken: string;
	baseUrl: string;
	headers?: Record<string, string | null>;
	source?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function getPiCodexAuth(ctx: ExtensionContext): Promise<PiCodexAuth> {
	let resolved;
	try {
		resolved = await ctx.modelRegistry.getProviderAuth(CODEX_PROVIDER_ID);
	} catch (error) {
		throw new Error(`Pi OpenAI Codex OAuth failed: ${formatError(error)}`);
	}

	const accessToken = readString(resolved?.auth.apiKey);
	if (!accessToken) {
		throw new Error("Pi OpenAI Codex OAuth is not configured. Run /login openai-codex, then retry.");
	}

	const source = readString(resolved?.source);
	return {
		accessToken,
		baseUrl: readString(resolved?.auth.baseUrl) ?? DEFAULT_CODEX_BASE_URL,
		...(resolved?.auth.headers ? { headers: resolved.auth.headers } : {}),
		...(source ? { source } : {}),
	};
}

function decodeJwtPayload(token: string): Record<string, unknown> {
	const payload = token.split(".")[1];
	if (!payload) return {};
	try {
		return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function accountIdFromAccessToken(accessToken: string): string {
	const claim = decodeJwtPayload(accessToken)[CHATGPT_AUTH_CLAIM];
	const accountId = isRecord(claim) ? readString(claim.chatgpt_account_id) : undefined;
	if (!accountId) {
		throw new Error("Pi OpenAI Codex OAuth access token does not contain a ChatGPT account id. Run /login openai-codex, then retry.");
	}
	return accountId;
}

function timeoutSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
	if (!parent) return AbortSignal.timeout(timeoutMs);
	if (parent.aborted) return AbortSignal.abort(parent.reason);
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

function formatHttpFailure(context: string, response: Response, body: { json: unknown; text: string }): string {
	const record = isRecord(body.json) ? body.json : {};
	const nestedError = isRecord(record.error) ? record.error : undefined;
	const code = readString(record.code) ?? readString(nestedError?.code) ?? readString(nestedError?.type);
	const message = readString(record.message) ?? readString(nestedError?.message) ?? body.text.slice(0, 800);
	return `${context} failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})${code ? ` [${code}]` : ""}${message ? `: ${message}` : ""}`;
}

function codexBackendUrl(path: string, baseUrl: string): string {
	const normalizedBase = baseUrl.replace(/\/+$/, "");
	const normalizedPath = path.replace(/^\/+/, "");
	if (normalizedBase.endsWith("/codex")) return `${normalizedBase}/${normalizedPath}`;
	return `${normalizedBase}/codex/${normalizedPath}`;
}

function buildCodexHeaders(auth: PiCodexAuth, accountId: string, extraHeaders: Record<string, string> = {}): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(auth.headers ?? {})) {
		if (value !== null) headers.set(name, value);
	}
	for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
	headers.set("Authorization", `Bearer ${auth.accessToken}`);
	headers.set("ChatGPT-Account-ID", accountId);
	headers.set("originator", "pi");
	headers.set("User-Agent", `pi-codex-search (${process.platform}; ${process.arch})`);
	return headers;
}

async function codexJsonRequest<T = unknown>(
	path: string,
	body: unknown,
	ctx: ExtensionContext,
	options: { signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<T> {
	const auth = await getPiCodexAuth(ctx);
	const headers = buildCodexHeaders(auth, accountIdFromAccessToken(auth.accessToken), {
		Accept: "application/json",
		"Content-Type": "application/json",
		...(options.headers ?? {}),
	});
	const response = await fetch(codexBackendUrl(path, auth.baseUrl), {
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

async function runSearch(params: CodexSearchParams, ctx: ExtensionContext, signal?: AbortSignal): Promise<{ output: string; details: Record<string, unknown> }> {
	const request = buildSearchRequest(params);
	const response = await codexJsonRequest<CodexSearchResponse>("alpha/search", request, ctx, { signal });
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
	accountIdFromAccessToken,
	buildCodexHeaders,
	createSearchToolSync,
	getPiCodexAuth,
	modelSupportsNativeWebSearch,
};

export default function (pi: ExtensionAPI) {
	const childMode = process.env.PI_SUBAGENT_CHILD === "1";
	if (!childMode) registerSubagentToolCapability(pi);
	const syncSearchToolForModel = createSearchToolSync(pi);
	pi.on("session_start", (_event, ctx) => syncSearchToolForModel(ctx.model));
	pi.on("model_select", (event) => syncSearchToolForModel(event.model));

	pi.registerTool({
		name: TOOL_NAME,
		label: "Codex Search",
		description: `Search the web through Pi's OpenAI Codex OAuth. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Run live web research through Pi's OpenAI Codex OAuth and return cited/current results.",
		promptGuidelines: [
			`Use ${TOOL_NAME} by default for live/current web research instead of Ollama web search or unavailable native web_search tools.`,
			`Use ${TOOL_NAME} when a local/text-only model such as ollama/glm-5.2:cloud needs current information from the web.`,
			`This tool is auto-enabled as the default web-search fallback for models without explicit native web-search capability.`,
			`If ${TOOL_NAME} is unavailable or fails, use grok_search when that tool is available.`,
			`After ${TOOL_NAME} returns, cite or summarize the source URLs present in its output when answering the user.`,
		],
		parameters: CodexSearchParamsSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Searching with Codex..." }] });
			const result = await runSearch(params as CodexSearchParams, ctx, signal);
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
		description: "Check Pi OpenAI Codex OAuth for Codex search",
		handler: async (_args, ctx) => {
			try {
				const auth = await getPiCodexAuth(ctx);
				ctx.ui.notify(
					[`Codex search: ${auth.source ?? "Pi OpenAI Codex OAuth"} ready`, `Default model: ${DEFAULT_SEARCH_MODEL}`, `Output dir: ${OUTPUT_DIR}`].join("\n"),
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Codex search auth error: ${formatError(error)}`, "error");
			}
		},
	});
}
