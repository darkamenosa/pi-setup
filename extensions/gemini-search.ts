import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	getAgentDir,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const TOOL_NAME = "gemini_search";
const MODEL = "gemini-3.8-flash-high";
const PRINT_TIMEOUT = "30m"; // User-approved budget; agy's default is only five minutes.
const AGY_BIN = process.env.AGY_BIN?.trim() || "agy";
const OUTPUT_DIR = process.env.GEMINI_SEARCH_OUTPUT_DIR || join(getAgentDir(), "gemini-search", "outputs");
const SUBAGENT_CAPABILITY_REQUEST_CHANNEL = "pi-subagent:capability-request:v1";
const SUBAGENT_CAPABILITY_RESPONSE_CHANNEL = "pi-subagent:capability-response:v1";
const SUBAGENT_CAPABILITY_VERSION = 1;

interface GeminiSearchParams {
	query: string;
}

interface AgySearchResponse {
	conversation_id?: unknown;
	status?: unknown;
	response?: unknown;
	error?: unknown;
	duration_seconds?: unknown;
	num_turns?: unknown;
	usage?: unknown;
}

interface SearchProgress {
	activity: string;
	toolCalls: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function buildSearchPrompt(query: string): string {
	const request = query.trim();
	if (!request) throw new Error("query must not be empty.");
	return [
		"Search the live web to answer the request below.",
		"Use web search and read-URL tools; do not answer only from prior knowledge.",
		"Do not inspect or change local files and do not run terminal commands.",
		"Return a concise, self-contained answer with direct source URLs next to the supported claims.",
		"",
		"Search request:",
		request,
	].join("\n");
}

function buildAgyArgs(query: string, logPath: string): string[] {
	return [
		"--model",
		MODEL,
		"--output-format",
		"stream-json",
		"--print-timeout",
		PRINT_TIMEOUT,
		"--log-file",
		logPath,
		"--disable-slash-commands",
		"--sandbox",
		"--dangerously-skip-permissions",
		"-p",
		buildSearchPrompt(query),
	];
}

function parseAgyResponse(parsed: AgySearchResponse): { output: string; details: Record<string, unknown> } {
	if (!isRecord(parsed)) throw new Error("agy returned an invalid response.");

	const status = readString(parsed.status);
	if (parsed.error === "timeout waiting for response") {
		throw new Error(`Gemini search timed out waiting for a response (configured limit: ${PRINT_TIMEOUT}).`);
	}
	if (status !== "SUCCESS" || readString(parsed.error)) {
		// Opaque provider errors stay out of Pi's durable session; see the native agy log.
		throw new Error(`agy search failed with status ${status === "ERROR" || status === "FAILED" ? status : "unknown"}.`);
	}

	const output = readString(parsed.response);
	if (!output) {
		throw new Error("agy returned no search output.");
	}

	const usage = isRecord(parsed.usage) ? parsed.usage : {};
	const tokenCounts = Object.fromEntries(
		["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"]
			.filter((key) => typeof usage[key] === "number" && Number.isFinite(usage[key]))
			.map((key) => [key, usage[key]]),
	);

	return {
		output,
		details: {
			model: MODEL,
			...(readString(parsed.conversation_id) ? { conversationId: readString(parsed.conversation_id) } : {}),
			...(typeof parsed.duration_seconds === "number" ? { durationSeconds: parsed.duration_seconds } : {}),
			...(typeof parsed.num_turns === "number" ? { numTurns: parsed.num_turns } : {}),
			...(Object.keys(tokenCounts).length ? { usage: tokenCounts } : {}),
		},
	};
}

function stepActivity(step: Record<string, unknown>): string | undefined {
	if (step.step_type === "agent_response") return readString(step.text_delta) ? "Writing answer" : "Researching";
	if (step.step_type !== "tool") return undefined;
	const done = step.state === "DONE";
	if (step.tool_name === "search_web") return done ? "Web search complete" : "Searching the web";
	if (step.tool_name === "read_url_content") {
		const info = isRecord(step.tool_info) ? step.tool_info : {};
		const params = isRecord(info.parameters) ? info.parameters : {};
		let host = "a page";
		try {
			// Show only the host, never credentials, query parameters, or the page body.
			host = new URL(String(params.Url)).hostname || host;
		} catch { /* Keep the generic label for an invalid URL. */ }
		return `${done ? "Read" : "Reading"} ${host}`;
	}
	return done ? "Tool complete" : "Running a tool";
}

function elapsedTime(seconds: number): string {
	const total = Math.floor(seconds);
	return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
}

async function runAgy(
	query: string,
	cwd: string,
	logPath: string,
	diagnostics: Record<string, unknown>,
	signal?: AbortSignal,
	onProgress?: (progress: SearchProgress) => void,
): Promise<{ output: string; details: Record<string, unknown> }> {
	signal?.throwIfAborted();
	const toolSteps = new Set<number>();
	const parsed = await new Promise<ReturnType<typeof parseAgyResponse>>((resolve, reject) => {
		const child = spawn(AGY_BIN, buildAgyArgs(query, logPath), {
			cwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		let pending = "";
		let response: AgySearchResponse | undefined;
		let failure: Error | undefined;
		let exited = false;
		let settled = false;
		let stopping = false;
		let exitCode: number | null = null;
		let exitSignal: string | null = null;
		let killTimer: NodeJS.Timeout | undefined;
		let drainTimer: NodeJS.Timeout | undefined;

		const kill = (signal: NodeJS.Signals) => {
			try {
				if (process.platform === "win32") child.kill(signal);
				else if (child.pid) process.kill(-child.pid, signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error as Error;
			}
		};
		const stop = () => {
			if (stopping || settled) return;
			stopping = true;
			kill("SIGTERM");
			// Cancellation cleanup only, not a search deadline. Do not test child.killed:
			// it means a signal was sent, not that the process actually exited.
			killTimer = setTimeout(() => kill("SIGKILL"), 5000);
			killTimer.unref();
		};
		const processLine = (line: string) => {
			if (!line.trim() || failure) return;
			try {
				const event: unknown = JSON.parse(line);
				if (!isRecord(event)) throw new Error("agy returned an invalid stream event.");
				if (event.event === "result") {
					if (!isRecord(event.result)) throw new Error("agy returned an invalid final result.");
					response = event.result;
					diagnostics.resultStatus = response.status === "SUCCESS" || response.status === "ERROR" || response.status === "FAILED" ? response.status : "unknown";
					diagnostics.timedOut = response.error === "timeout waiting for response";
					onProgress?.({ activity: "Finishing", toolCalls: toolSteps.size });
				} else if (event.event === "init") {
					onProgress?.({ activity: "Gemini connected", toolCalls: toolSteps.size });
				} else if (event.event === "step_update" && isRecord(event.step_update)) {
					const step = event.step_update;
					if (step.step_type === "tool" && Number.isSafeInteger(step.step_index)) toolSteps.add(step.step_index as number);
					const activity = stepActivity(step);
					if (activity) {
						diagnostics.lastActivity = activity;
						onProgress?.({ activity, toolCalls: toolSteps.size });
					}
				}
			} catch (error) {
				failure = error instanceof SyntaxError ? new Error("agy returned invalid stream JSON.") : error as Error;
				stop();
			}
		};
		const finish = () => {
			if (settled) return;
			if (pending.trim()) processLine(pending);
			settled = true;
			if (killTimer) clearTimeout(killTimer);
			if (drainTimer) clearTimeout(drainTimer);
			signal?.removeEventListener("abort", stop);
			if (stopping) kill("SIGKILL"); // Terminate remaining process-group members too.
			child.stdout.destroy();
			child.stderr.destroy();
			diagnostics.exitCode = exitCode;
			diagnostics.exitSignal = exitSignal;
			diagnostics.toolCalls = toolSteps.size;
			try {
				signal?.throwIfAborted();
				if (failure) throw failure;
				// agy emits result.error on stdout before exiting 1 on timeout.
				// Validate that envelope before considering the generic exit code.
				const parsed = response ? parseAgyResponse(response) : undefined;
				if (exitCode !== 0 || exitSignal) {
					throw new Error(`agy search ${exitSignal ? `was terminated (${exitSignal})` : `exited with code ${exitCode}`}.`);
				}
				if (!parsed) throw new Error("agy exited without a final result.");
				resolve(parsed);
			} catch (error) { reject(error); }
		};
		const drainAfterExit = () => {
			if (!exited || settled) return;
			if (drainTimer) clearTimeout(drainTimer);
			// Mirror Pi's waitForChildProcess: drain until idle after exit, so an
			// inherited pipe cannot hang the tool and active output is not cut off.
			drainTimer = setTimeout(finish, 100);
		};
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			pending += chunk;
			let newline;
			while ((newline = pending.indexOf("\n")) !== -1) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				processLine(line);
			}
			drainAfterExit();
		});
		// Drain stderr without copying arbitrary CLI/provider text into session state.
		child.stderr.on("data", drainAfterExit);
		child.once("error", (error) => { failure = error; finish(); });
		child.once("exit", (code, signal) => { exited = true; exitCode = code; exitSignal = signal; drainAfterExit(); });
		child.once("close", finish);
		signal?.addEventListener("abort", stop, { once: true });
		if (signal?.aborted) stop();
	});
	signal?.throwIfAborted();
	return {
		output: parsed.output,
		details: { request: { query, model: MODEL }, ...parsed.details, toolCalls: toolSteps.size },
	};
}

async function runSearch(
	params: GeminiSearchParams,
	cwd: string,
	signal?: AbortSignal,
	onProgress?: (progress: SearchProgress) => void,
): Promise<{ output: string; details: Record<string, unknown> }> {
	const query = params.query.trim();
	if (!query) throw new Error("query must not be empty.");
	signal?.throwIfAborted();
	const started = Date.now();
	const logRoot = resolve(OUTPUT_DIR, "logs");
	await mkdir(logRoot, { recursive: true, mode: 0o700 });
	const logDir = await mkdtemp(join(logRoot, "search-"));
	const logPath = join(logDir, "agy.log");
	const diagnosticsPath = join(logDir, "diagnostics.json");
	await writeFile(logPath, "", { flag: "wx", mode: 0o600 });
	const diagnostics: Record<string, unknown> = {
		startedAt: new Date(started).toISOString(), model: MODEL, printTimeout: PRINT_TIMEOUT,
		logPath, outcome: "error",
	};
	let result: Awaited<ReturnType<typeof runAgy>> | undefined;
	let failure: unknown;
	try {
		result = await runAgy(query, cwd, logPath, diagnostics, signal, onProgress);
		diagnostics.outcome = "success";
	} catch (error) {
		failure = error;
		diagnostics.outcome = signal?.aborted ? "cancelled" : "error";
	}
	let diagnosticsWarning: string | undefined;
	try {
		// A single write in a private per-call directory. No raw query, answer,
		// stderr, provider error, or stream payload is copied into this summary.
		await writeFile(diagnosticsPath, JSON.stringify({
			...diagnostics, elapsedSeconds: (Date.now() - started) / 1000,
		}, null, 2) + "\n", { flag: "wx", mode: 0o600 });
	} catch {
		// A diagnostic write failure must not replace the answer or the original error.
		diagnosticsWarning = "Diagnostic summary could not be written; the native agy log is available.";
	}
	if (!result) {
		const message = failure instanceof Error ? failure.message : "Gemini search failed.";
		throw new Error(`${message}\n${diagnosticsWarning ?? `Diagnostics: ${diagnosticsPath}`}\nagy log: ${logPath}`, { cause: failure });
	}
	return {
		output: result.output,
		details: {
			...result.details, printTimeout: PRINT_TIMEOUT, logPath,
			...(diagnosticsWarning ? { diagnosticsWarning } : { diagnosticsPath }),
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

const GeminiSearchParamsSchema = Type.Object({
	query: Type.String({ description: "Search query or research question." }),
});

export const __geminiSearchTest = {
	buildAgyArgs,
	buildSearchPrompt,
	parseAgyResponse,
	stepActivity,
	elapsedTime,
	runSearch,
};

export default function geminiSearch(pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD !== "1") registerSubagentToolCapability(pi);

	pi.registerTool({
		name: TOOL_NAME,
		label: "Gemini Search",
		description: `Search the live web with ${MODEL} through the local agy CLI, with a 30-minute response-wait limit. Use only when the user explicitly requests Gemini search. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Search the live web with Gemini through the local agy CLI only when the user explicitly requests Gemini search.",
		promptGuidelines: [
			`Use ${TOOL_NAME} only when the user explicitly asks for Gemini search.`,
			`Do not use ${TOOL_NAME} as the default web-search tool or as an automatic fallback.`,
			`Searches stay in the foreground, are cancellable, and have an explicit 30-minute agy response-wait limit. Failures include per-search diagnostic paths.`,
			`After ${TOOL_NAME} returns, cite or summarize the source URLs present in its output when answering the user.`,
		],
		parameters: GeminiSearchParamsSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const started = Date.now();
			let progress: SearchProgress = { activity: "Starting agy", toolCalls: 0 };
			const emitProgress = () => {
				const elapsedSeconds = Math.floor((Date.now() - started) / 1000);
				onUpdate?.({
					content: [{ type: "text", text: `Gemini · ${elapsedTime(elapsedSeconds)} · ${progress.toolCalls} tools · ${progress.activity}` }],
					details: { ...progress, elapsedSeconds },
				});
			};
			emitProgress();
			const timer = onUpdate ? setInterval(emitProgress, 1000) : undefined;
			try {
				const result = await runSearch(params as GeminiSearchParams, ctx.cwd, signal, (next) => {
					if (next.activity === progress.activity && next.toolCalls === progress.toolCalls) return;
					progress = next;
					emitProgress();
				});
				const truncated = await truncateToolText(result.output);
				return {
					content: [{ type: "text", text: truncated.text }],
					details: { ...result.details, ...truncated.details, elapsedSeconds: (Date.now() - started) / 1000 },
				};
			} finally {
				if (timer) clearInterval(timer);
			}
		},
		renderCall(args, theme) {
			const query = typeof args.query === "string" ? args.query.slice(0, 100) : "";
			return new Text(`${theme.fg("toolTitle", theme.bold(TOOL_NAME))} ${theme.fg("muted", query)}`, 0, 0);
		},
		renderResult(result, { isPartial, expanded }, theme, context) {
			if (isPartial || context.isError) {
				const text = result.content.find((item) => item.type === "text");
				return new Text(theme.fg(context.isError ? "error" : "warning", text?.type === "text" ? text.text : "Searching with Gemini..."), 0, 0);
			}
			const details = result.details as Record<string, unknown> | undefined;
			let text = theme.fg("success", "Gemini search complete");
			if (typeof details?.elapsedSeconds === "number") text += theme.fg("muted", ` · ${elapsedTime(details.elapsedSeconds)}`);
			if (typeof details?.toolCalls === "number") text += theme.fg("muted", ` · ${details.toolCalls} tools`);
			if (details?.truncation) text += theme.fg("warning", " truncated");
			if (details?.diagnosticsWarning) text += theme.fg("warning", " · diagnostic summary unavailable");
			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") text += `\n${theme.fg("dim", content.text.split("\n").slice(0, 24).join("\n"))}`;
			}
			return new Text(text, 0, 0);
		},
	});
}
