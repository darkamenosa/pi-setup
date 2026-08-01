import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	getAgentDir,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const TOOL_NAME = "grok_search";
const DEFAULT_MODEL = process.env.GROK_SEARCH_MODEL || "grok-4.20-multi-agent";
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const DEFAULT_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const FETCH_TIMEOUT_MS = 120_000;
const SUBAGENT_CAPABILITY_REQUEST_CHANNEL = "pi-subagent:capability-request:v1";
const SUBAGENT_CAPABILITY_RESPONSE_CHANNEL = "pi-subagent:capability-response:v1";
const SUBAGENT_CAPABILITY_VERSION = 1;
const GROK_VERSION_PATH = join(homedir(), ".grok", "version.json");
const OUTPUT_DIR = process.env.GROK_SEARCH_OUTPUT_DIR || join(getAgentDir(), "grok-search", "outputs");

interface GrokSearchParams {
	query: string;
	model?: string;
	maxOutputTokens?: number;
}

interface GrokSearchResult {
	output: string;
	details: Record<string, unknown>;
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

function readJsonFile(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(parsed) ? parsed : undefined;
	} catch (error) {
		throw new Error(`Failed to read ${path}: ${formatError(error)}`);
	}
}

async function getPiGrokAccessToken(ctx: ExtensionContext): Promise<string> {
	const model = ctx.modelRegistry.getAll().find((candidate) => candidate.provider === "xai");
	if (!model || !ctx.modelRegistry.isUsingOAuth(model)) {
		throw new Error("Pi xAI OAuth is not configured. Run /login xai, then retry.");
	}
	const result = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!result.ok) throw new Error(`Pi xAI OAuth failed: ${result.error}`);
	const accessToken = readString(result.apiKey);
	if (!accessToken) throw new Error("Pi xAI OAuth did not provide an access token.");
	return accessToken;
}

function getGrokVersion(): string {
	try {
		const version = readJsonFile(GROK_VERSION_PATH);
		return readString(version?.version) ?? "0.2.93";
	} catch {
		return "0.2.93";
	}
}

function getGrokUserAgent(): string {
	const platform = process.platform === "darwin" ? "macos" : process.platform;
	const arch = process.arch === "arm64" ? "aarch64" : process.arch;
	return `grok-shell/${getGrokVersion()} (${platform}; ${arch})`;
}

function responsesUrl(): string {
	const baseUrl = (process.env.GROK_CLI_CHAT_PROXY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
	return `${baseUrl}/responses`;
}

function positiveInteger(value: number | undefined, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
	return value;
}

function buildSearchRequest(params: GrokSearchParams): Record<string, unknown> {
	const query = params.query.trim();
	if (!query) throw new Error("query must not be empty.");
	return {
		model: params.model?.trim() || DEFAULT_MODEL,
		input: query,
		tools: [{ type: "web_search" }, { type: "x_search" }],
		store: false,
		stream: false,
		max_output_tokens: params.maxOutputTokens !== undefined
			? positiveInteger(params.maxOutputTokens, "maxOutputTokens")
			: DEFAULT_MAX_OUTPUT_TOKENS,
	};
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

function formatHttpFailure(response: Response, body: { json: unknown; text: string }): string {
	const record = isRecord(body.json) ? body.json : {};
	const error = isRecord(record.error) ? record.error : undefined;
	const code = readString(error?.code) ?? readString(error?.type) ?? readString(record.code);
	const message = readString(error?.message) ?? readString(record.message) ?? body.text.slice(0, 800);
	return `Grok search failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})${code ? ` [${code}]` : ""}${message ? `: ${message}` : ""}`;
}

function collectSearchResponse(value: unknown): { output: string; sources: string[]; usage?: unknown } {
	if (!isRecord(value)) throw new Error("Grok search returned an invalid response.");
	if (readString(value.status) && value.status !== "completed") {
		const error = isRecord(value.error) ? readString(value.error.message) : undefined;
		throw new Error(`Grok search response status is ${String(value.status)}${error ? `: ${error}` : ""}.`);
	}
	const outputItems = Array.isArray(value.output) ? value.output : [];
	const text: string[] = [];
	const sources: string[] = [];
	for (const item of outputItems) {
		if (!isRecord(item)) continue;
		if (item.type === "message" && Array.isArray(item.content)) {
			for (const content of item.content) {
				if (!isRecord(content)) continue;
				const outputText = readString(content.text);
				if (content.type === "output_text" && outputText) text.push(outputText);
				if (Array.isArray(content.annotations)) {
					for (const annotation of content.annotations) {
						if (!isRecord(annotation)) continue;
						const url = readString(annotation.url);
						if (url) sources.push(url);
					}
				}
			}
		}
		if ((item.type === "web_search_call" || item.type === "x_search_call") && isRecord(item.action)) {
			const actionSources = Array.isArray(item.action.sources) ? item.action.sources : [];
			for (const source of actionSources) {
				if (!isRecord(source)) continue;
				const url = readString(source.url);
				if (url) sources.push(url);
			}
		}
	}
	const output = text.join("\n\n").trim();
	if (!output) throw new Error("Grok search response is missing assistant output text.");
	return { output, sources: [...new Set(sources)], ...(value.usage !== undefined ? { usage: value.usage } : {}) };
}

async function runSearch(
	params: GrokSearchParams,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<GrokSearchResult> {
	const accessToken = await getPiGrokAccessToken(ctx);
	const request = buildSearchRequest(params);
	const model = String(request.model);
	const version = getGrokVersion();
	const response = await fetch(responsesUrl(), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
			"Content-Type": "application/json",
			"User-Agent": getGrokUserAgent(),
			"x-grok-client-version": version,
			"x-grok-client-identifier": "grok-shell",
			"x-grok-model-override": model,
			"X-XAI-Token-Auth": "xai-grok-cli",
		},
		body: JSON.stringify(request),
		signal: timeoutSignal(FETCH_TIMEOUT_MS, signal),
	});
	const body = await readJsonOrText(response);
	if (!response.ok) throw new Error(formatHttpFailure(response, body));
	const result = collectSearchResponse(body.json);
	return {
		output: result.output,
		details: {
			request: { model, query: params.query },
			credentialSource: "pi-xai-oauth",
			sources: result.sources,
			...(result.usage !== undefined ? { usage: result.usage } : {}),
		},
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

const GrokSearchParamsSchema = Type.Object({
	query: Type.String({ description: "Search query or research question." }),
	model: Type.Optional(Type.String({ description: `Grok search model override (default ${DEFAULT_MODEL}).` })),
	maxOutputTokens: Type.Optional(Type.Integer({ description: `Response output-token cap (default ${DEFAULT_MAX_OUTPUT_TOKENS}).` })),
});

export const __grokSearchTest = {
	buildSearchRequest,
	collectSearchResponse,
	getPiGrokAccessToken,
};

export default function grokSearch(pi: ExtensionAPI) {
	const childMode = process.env.PI_SUBAGENT_CHILD === "1";
	if (!childMode) registerSubagentToolCapability(pi);

	pi.registerTool({
		name: TOOL_NAME,
		label: "Grok Search",
		description: `Search the live web and X with ${DEFAULT_MODEL} using Pi's xAI OAuth. Use only when the user explicitly asks for Grok search, or when codex_search is unavailable or fails. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Search the live web and X through Pi's xAI OAuth when Grok search is explicitly requested or Codex search is unavailable.",
		promptGuidelines: [
			"Use codex_search by default for web research when codex_search is available.",
			`Use ${TOOL_NAME} when the user explicitly asks to search with Grok, or when codex_search is unavailable or fails.`,
			`${TOOL_NAME} is a general search tool that can search both the web and X; it is not limited to X searches.`,
			`After ${TOOL_NAME} returns, cite or summarize the source URLs present in its output when answering the user.`,
		],
		parameters: GrokSearchParamsSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: `Searching with ${params.model || DEFAULT_MODEL}...` }] });
			const result = await runSearch(params as GrokSearchParams, ctx, signal);
			const truncated = await truncateToolText(result.output);
			return {
				content: [{ type: "text", text: truncated.text }],
				details: { ...result.details, ...truncated.details },
			};
		},
		renderCall(args, theme) {
			const query = typeof args.query === "string" ? args.query.slice(0, 100) : "";
			return new Text(`${theme.fg("toolTitle", theme.bold(TOOL_NAME))} ${theme.fg("muted", query)}`, 0, 0);
		},
		renderResult(result, { isPartial, expanded }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Searching with Grok..."), 0, 0);
			const details = result.details as Record<string, unknown> | undefined;
			const request = details?.request as Record<string, unknown> | undefined;
			let text = theme.fg("success", "Grok search complete");
			if (request?.model) text += theme.fg("muted", ` (${String(request.model)})`);
			if (details?.truncation) text += theme.fg("warning", " truncated");
			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") text += `\n${theme.fg("dim", content.text.split("\n").slice(0, 24).join("\n"))}`;
			}
			return new Text(text, 0, 0);
		},
	});

	if (!childMode) pi.registerCommand("grok-search", {
		description: "Check Pi xAI OAuth for Grok search",
		handler: async (_args, ctx) => {
			try {
				await getPiGrokAccessToken(ctx);
				ctx.ui.notify(
					[
						"Grok search: Pi xAI OAuth ready",
						`Default model: ${DEFAULT_MODEL}`,
						"Reasoning effort: provider default (currently medium)",
						`Output dir: ${OUTPUT_DIR}`,
					].join("\n"),
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Grok search auth error: ${formatError(error)}`, "error");
			}
		},
	});
}
