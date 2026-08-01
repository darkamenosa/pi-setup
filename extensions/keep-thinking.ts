/**
 * Keep Thinking
 *
 * Pi extension that folds GPT-5.5 reasoning-truncation continuation rounds into
 * one assistant message. It watches for the observed `518 * n - 2` reasoning
 * token fingerprint, replays safe thinking blocks, asks the model to continue
 * in a hidden commentary message, and withholds tentative final output until a
 * clean round completes.
 */

import {
	azureOpenAIResponsesApi,
	createAssistantMessageEventStream,
	openAICodexResponsesApi,
	openAICompletionsApi,
	openAIResponsesApi,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
	type Usage,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type Delegate = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;

type SupportedApi = "openai-codex-responses" | "openai-responses" | "azure-openai-responses" | "openai-completions";

type StopGuard = "clean" | "no_replayable_thinking" | "max_continue" | "tier_out_of_window" | "max_total_output_tokens";

interface KeepThinkingConfig {
	enabled: boolean;
	truncationStep: number;
	maxContinue: number;
	minTier: number;
	maxTier: number;
	markerText: string;
	maxTotalOutputTokens: number;
	chatCompletionsBestEffort: boolean;
	logPath: string;
	logCleanRounds: boolean;
	writeSessionDiagnostics: boolean;
	writeSessionEntries: boolean;
}

interface RoundInfo {
	round: number;
	reasoningTokens?: number;
	tier?: number;
	truncated: boolean;
	decision: "continue" | StopGuard | "error";
	api: string;
	replayableThinking: boolean;
}

interface DetectionEntry {
	model: string;
	provider?: string;
	api?: string;
	responseModel?: string;
	reasoningTokens: number;
	tier: number;
	rounds?: RoundInfo[];
	continued: boolean;
	stoppedReason?: string;
	timestamp: number;
}

interface BufferedText {
	type: "text";
	started: boolean;
	deltas: string[];
	block: TextContent;
}

interface BufferedToolCall {
	type: "toolCall";
	started: boolean;
	deltas: string[];
	block: ToolCall;
}

type BufferedBlock = BufferedText | BufferedToolCall;

const ENTRY_TYPE = "keep-thinking-detection";
const STATUS_KEY = "keep-thinking";
const LOG_SCHEMA = "keep-thinking.v1";
const LOG_DATE_TOKEN = "{date}";
const BLUE = "\x1b[38;5;39m";
const GREEN = "\x1b[38;5;42m";
const YELLOW = "\x1b[38;5;220m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const DEFAULT_CONFIG: KeepThinkingConfig = {
	enabled: true,
	truncationStep: 518,
	maxContinue: 0,
	minTier: 1,
	maxTier: 0,
	markerText: "Continue thinking...",
	maxTotalOutputTokens: 0,
	chatCompletionsBestEffort: true,
	logPath: `~/.pi/agent/logs/keep-thinking/${LOG_DATE_TOKEN}.jsonl`,
	logCleanRounds: false,
	writeSessionDiagnostics: false,
	writeSessionEntries: false,
};

let config: KeepThinkingConfig = loadConfigFromEnv(DEFAULT_CONFIG);
const recentDetections: DetectionEntry[] = [];
const handledMessageKeys = new Set<string>();
const handledMessageOrder: string[] = [];
const MAX_HANDLED_MESSAGE_KEYS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function envString(name: string, fallback: string): string {
	const value = process.env[name];
	return value === undefined || value.trim() === "" ? fallback : value;
}

function envBoolean(name: string, fallback: boolean): boolean {
	const value = process.env[name];
	if (value === undefined) return fallback;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return fallback;
}

function envInteger(name: string, fallback: number, options: { min?: number } = {}): number {
	const value = process.env[name];
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) return fallback;
	if (options.min !== undefined && parsed < options.min) return fallback;
	return parsed;
}

function loadConfigFromEnv(defaults: KeepThinkingConfig): KeepThinkingConfig {
	return {
		...defaults,
		enabled: envBoolean("PI_KEEP_THINKING_ENABLED", defaults.enabled),
		truncationStep: envInteger("PI_KEEP_THINKING_TRUNCATION_STEP", defaults.truncationStep, { min: 1 }),
		maxContinue: envInteger("PI_KEEP_THINKING_MAX_CONTINUE", defaults.maxContinue, { min: 0 }),
		minTier: envInteger("PI_KEEP_THINKING_MIN_TIER", defaults.minTier, { min: 1 }),
		maxTier: envInteger("PI_KEEP_THINKING_MAX_TIER", defaults.maxTier, { min: 0 }),
		markerText: envString("PI_KEEP_THINKING_MARKER_TEXT", defaults.markerText),
		maxTotalOutputTokens: envInteger("PI_KEEP_THINKING_MAX_TOTAL_OUTPUT_TOKENS", defaults.maxTotalOutputTokens, { min: 0 }),
		chatCompletionsBestEffort: envBoolean("PI_KEEP_THINKING_CHAT_COMPLETIONS_BEST_EFFORT", defaults.chatCompletionsBestEffort),
		logPath: envString("PI_KEEP_THINKING_LOG_PATH", defaults.logPath),
		logCleanRounds: envBoolean("PI_KEEP_THINKING_LOG_CLEAN", defaults.logCleanRounds),
		writeSessionDiagnostics: envBoolean("PI_KEEP_THINKING_SESSION_DIAGNOSTICS", defaults.writeSessionDiagnostics),
		writeSessionEntries: envBoolean("PI_KEEP_THINKING_SESSION_ENTRIES", defaults.writeSessionEntries),
	};
}

function expandHome(filePath: string): string {
	if (filePath === "~") return os.homedir();
	if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
	return filePath;
}

function localDateKey(date = new Date()): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function keepThinkingLogPathPattern(): string | undefined {
	const configured = config.logPath.trim();
	if (!configured) return undefined;
	if (["0", "false", "off", "none", "disabled"].includes(configured.toLowerCase())) return undefined;
	const expanded = expandHome(configured);
	if (!expanded.includes(LOG_DATE_TOKEN) && (expanded.endsWith(path.sep) || path.extname(expanded) === "")) {
		return path.join(expanded, `${LOG_DATE_TOKEN}.jsonl`);
	}
	return expanded;
}

function keepThinkingLogPath(date = new Date()): string | undefined {
	const pattern = keepThinkingLogPathPattern();
	if (!pattern) return undefined;
	return pattern.replaceAll(LOG_DATE_TOKEN, localDateKey(date));
}

async function writeKeepThinkingLog(entry: Record<string, unknown>): Promise<void> {
	const logPath = keepThinkingLogPath();
	if (!logPath) return;
	try {
		await fs.mkdir(path.dirname(logPath), { recursive: true });
		const now = Date.now();
		await fs.appendFile(
			logPath,
			`${JSON.stringify({ schema: LOG_SCHEMA, timestamp: now, iso: new Date(now).toISOString(), ...entry })}\n`,
			"utf8",
		);
	} catch {
		// Keep Thinking must never fail the model turn because external logging failed.
	}
}

function messageKey(message: AssistantMessage): string | undefined {
	if (message.responseId) return `${message.provider ?? ""}/${message.model ?? ""}/${message.responseId}`;
	if (!message.timestamp) return undefined;
	return `${message.provider ?? ""}/${message.model ?? ""}/${message.timestamp}/${message.usage?.reasoning ?? ""}/${message.usage?.output ?? ""}`;
}

function rememberHandledMessage(message: AssistantMessage): void {
	const key = messageKey(message);
	if (!key || handledMessageKeys.has(key)) return;
	handledMessageKeys.add(key);
	handledMessageOrder.push(key);
	while (handledMessageOrder.length > MAX_HANDLED_MESSAGE_KEYS) {
		const oldKey = handledMessageOrder.shift();
		if (oldKey) handledMessageKeys.delete(oldKey);
	}
}

function wasHandledByKeepThinking(message: AssistantMessage): boolean {
	const key = messageKey(message);
	return Boolean(key && handledMessageKeys.has(key));
}

function hasTruncatedRound(rounds: RoundInfo[]): boolean {
	return rounds.some((round) => round.truncated);
}

function shouldWriteSummaryLog(rounds: RoundInfo[], continued: boolean, stoppedReason: string | undefined): boolean {
	return config.logCleanRounds || continued || Boolean(stoppedReason) || hasTruncatedRound(rounds);
}

interface StatsWindow {
	label: string;
	sinceMs?: number;
}

interface KeepThinkingStats {
	window: StatsWindow;
	filesRead: number;
	records: number;
	malformedRecords: number;
	preventedMessages: number;
	preventedRounds: number;
	fingerprintRounds: number;
	summaryRecords: number;
	unsupportedRecords: number;
	errorRecords: number;
	fingerprintCounts: Map<number, number>;
	decisionCounts: Map<string, number>;
	stoppedReasons: Map<string, number>;
	byApi: Map<string, number>;
	byModel: Map<string, number>;
	latestInteresting: Array<{ timestamp?: number; event?: string; model?: string; api?: string; rounds: number[]; stoppedReason?: string }>;
}

function parseStatsWindow(input: string): StatsWindow | undefined {
	const value = input.trim().toLowerCase();
	if (!value || value === "all") return { label: "all" };
	const match = value.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/);
	if (!match) return undefined;
	const amount = Number.parseInt(match[1], 10);
	if (!Number.isFinite(amount) || amount <= 0) return undefined;
	const unit = match[2];
	const multiplier = unit.startsWith("m") ? 60_000 : unit.startsWith("h") ? 3_600_000 : 86_400_000;
	return { label: value, sinceMs: Date.now() - amount * multiplier };
}

async function keepThinkingLogFiles(): Promise<string[]> {
	const pattern = keepThinkingLogPathPattern();
	if (!pattern) return [];
	if (!pattern.includes(LOG_DATE_TOKEN)) return [pattern];

	const dir = path.dirname(pattern);
	const base = path.basename(pattern);
	const [prefix, suffix] = base.split(LOG_DATE_TOKEN);
	const files: string[] = [];
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			if (!entry.name.startsWith(prefix) || !entry.name.endsWith(suffix)) continue;
			files.push(path.join(dir, entry.name));
		}
	} catch {
		// Missing log directory is a valid no-data state.
	}

	// Backward compatibility with the pre-rotation default used briefly during development.
	// Only include it when the user did not point stats at a custom log location.
	if (pattern === expandHome(DEFAULT_CONFIG.logPath)) {
		const legacyPath = expandHome("~/.pi/agent/logs/keep-thinking.jsonl");
		try {
			await fs.access(legacyPath);
			files.push(legacyPath);
		} catch {
			// ignore
		}
	}

	return [...new Set(files)].sort();
}

function incrementCounter<K>(counter: Map<K, number>, key: K, by = 1): void {
	counter.set(key, (counter.get(key) ?? 0) + by);
}

function logRecordTimestamp(record: Record<string, unknown>): number | undefined {
	if (typeof record.timestamp === "number" && Number.isFinite(record.timestamp)) return record.timestamp;
	if (typeof record.iso === "string") {
		const parsed = Date.parse(record.iso);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}
function stoppedReasonForRecord(record: Record<string, unknown>): string | undefined {
	return typeof record.stoppedReason === "string" ? record.stoppedReason : undefined;
}

function roundReasoningTokens(round: unknown): number | undefined {
	if (!isRecord(round)) return undefined;
	const value = round.reasoningTokens;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isFingerprintRound(round: unknown): boolean {
	if (!isRecord(round)) return false;
	if (round.truncated === true) return true;
	const tokens = roundReasoningTokens(round);
	return tierFor(tokens) !== undefined;
}

async function computeKeepThinkingStats(window: StatsWindow): Promise<KeepThinkingStats> {
	const stats: KeepThinkingStats = {
		window,
		filesRead: 0,
		records: 0,
		malformedRecords: 0,
		preventedMessages: 0,
		preventedRounds: 0,
		fingerprintRounds: 0,
		summaryRecords: 0,
		unsupportedRecords: 0,
		errorRecords: 0,
		fingerprintCounts: new Map(),
		decisionCounts: new Map(),
		stoppedReasons: new Map(),
		byApi: new Map(),
		byModel: new Map(),
		latestInteresting: [],
	};

	for (const file of await keepThinkingLogFiles()) {
		let text: string;
		try {
			text = await fs.readFile(file, "utf8");
			stats.filesRead += 1;
		} catch {
			continue;
		}

		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(line) as Record<string, unknown>;
			} catch {
				stats.malformedRecords += 1;
				continue;
			}

			const timestamp = logRecordTimestamp(record);
			if (window.sinceMs !== undefined && (timestamp === undefined || timestamp < window.sinceMs)) continue;
			stats.records += 1;

			const event = typeof record.event === "string" ? record.event : "unknown";
			if (event === "summary") stats.summaryRecords += 1;
			else if (event === "unsupported_api_or_unwrapped_stream") stats.unsupportedRecords += 1;
			else if (event.endsWith("_error")) stats.errorRecords += 1;

			const api = typeof record.api === "string" ? record.api : "unknown";
			const model = typeof record.model === "string" ? record.model : "unknown";
			const rounds = Array.isArray(record.rounds) ? record.rounds : [];
			if (rounds.length === 0 && typeof record.reasoningTokens === "number" && Number.isFinite(record.reasoningTokens)) {
				rounds.push({
					reasoningTokens: record.reasoningTokens,
					truncated: tierFor(record.reasoningTokens) !== undefined,
					decision: stoppedReasonForRecord(record) ?? event,
				});
			}
			let continuedRounds = 0;
			const fingerprintTokens: number[] = [];

			for (const round of rounds) {
				if (!isRecord(round)) continue;
				const decision = typeof round.decision === "string" ? round.decision : "unknown";
				incrementCounter(stats.decisionCounts, decision);
				if (decision === "continue") continuedRounds += 1;

				if (isFingerprintRound(round)) {
					const tokens = roundReasoningTokens(round);
					stats.fingerprintRounds += 1;
					if (tokens !== undefined) {
						fingerprintTokens.push(tokens);
						incrementCounter(stats.fingerprintCounts, tokens);
					}
				}
			}

			if (continuedRounds > 0) {
				stats.preventedMessages += 1;
				stats.preventedRounds += continuedRounds;
				incrementCounter(stats.byApi, api, continuedRounds);
				incrementCounter(stats.byModel, model, continuedRounds);
			}

			const stoppedReason = typeof record.stoppedReason === "string" ? record.stoppedReason : undefined;
			if (stoppedReason) incrementCounter(stats.stoppedReasons, stoppedReason);
			if (continuedRounds > 0 || stoppedReason || event !== "summary") {
				stats.latestInteresting.push({ timestamp, event, model, api, rounds: fingerprintTokens, stoppedReason });
				stats.latestInteresting = stats.latestInteresting
					.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
					.slice(0, 8);
			}
		}
	}

	return stats;
}

function formatCounter<K>(counter: Map<K, number>, empty = "none", limit = 8): string {
	const entries = [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
	if (entries.length === 0) return empty;
	return entries.map(([key, value]) => `${String(key)}×${value}`).join(", ");
}

function renderKeepThinkingStats(stats: KeepThinkingStats): string {
	const lines = [
		`Keep Thinking stats (${stats.window.label})`,
		`Log pattern: ${keepThinkingLogPathPattern() ?? "disabled"}`,
		`Today's log: ${keepThinkingLogPath() ?? "disabled"}`,
		`Files read: ${stats.filesRead}`,
		`Records: ${stats.records}${stats.malformedRecords ? ` (${stats.malformedRecords} malformed skipped)` : ""}`,
		`Prevented: ${stats.preventedMessages} messages, ${stats.preventedRounds} rounds`,
		`Fingerprint rounds: ${stats.fingerprintRounds}`,
		`Event records: summary=${stats.summaryRecords}, unsupported=${stats.unsupportedRecords}, errors=${stats.errorRecords}`,
		`Fingerprint counts: ${formatCounter(stats.fingerprintCounts)}`,
		`Decisions: ${formatCounter(stats.decisionCounts)}`,
		`Stopped reasons: ${formatCounter(stats.stoppedReasons)}`,
		`Prevented by API: ${formatCounter(stats.byApi)}`,
		`Prevented by model: ${formatCounter(stats.byModel)}`,
	];

	if (stats.latestInteresting.length > 0) {
		lines.push("", "Latest interesting events:");
		for (const item of stats.latestInteresting) {
			const when = item.timestamp ? new Date(item.timestamp).toISOString() : "unknown-time";
			const rounds = item.rounds.length > 0 ? ` rounds=${item.rounds.join("+")}` : "";
			const stopped = item.stoppedReason ? ` stop=${item.stoppedReason}` : "";
			lines.push(`- ${when} ${item.event ?? "unknown"} ${item.api ?? "unknown"}/${item.model ?? "unknown"}${rounds}${stopped}`);
		}
	}

	return lines.join("\n");
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function cloneUsage(usage: Usage | undefined): Usage {
	return usage ? cloneJson(usage) : zeroUsage();
}

function addUsage(acc: Usage, usage: Usage | undefined): void {
	if (!usage) return;
	acc.input += usage.input || 0;
	acc.output += usage.output || 0;
	acc.cacheRead += usage.cacheRead || 0;
	acc.cacheWrite += usage.cacheWrite || 0;
	acc.cacheWrite1h = (acc.cacheWrite1h || 0) + (usage.cacheWrite1h || 0);
	acc.reasoning = (acc.reasoning || 0) + (usage.reasoning || 0);
	acc.totalTokens += usage.totalTokens || 0;
	acc.cost.input += usage.cost?.input || 0;
	acc.cost.output += usage.cost?.output || 0;
	acc.cost.cacheRead += usage.cost?.cacheRead || 0;
	acc.cost.cacheWrite += usage.cost?.cacheWrite || 0;
	acc.cost.total += usage.cost?.total || 0;
}

function agentFacingUsage(first: Usage | undefined, total: Usage, finalRound: Usage | undefined, flushedFinal: boolean): Usage {
	const firstUsage = first ?? zeroUsage();
	const finalUsage = finalRound ?? zeroUsage();
	const reasoning = total.reasoning || 0;
	const finalNonReasoning = flushedFinal ? Math.max(0, (finalUsage.output || 0) - (finalUsage.reasoning || 0)) : 0;
	const usage: Usage = {
		input: firstUsage.input || 0,
		output: reasoning + finalNonReasoning,
		cacheRead: firstUsage.cacheRead || 0,
		cacheWrite: firstUsage.cacheWrite || 0,
		cacheWrite1h: firstUsage.cacheWrite1h || 0,
		reasoning,
		totalTokens: (firstUsage.input || 0) + (firstUsage.cacheRead || 0) + (firstUsage.cacheWrite || 0) + reasoning + finalNonReasoning,
		cost: cloneJson(total.cost),
	};
	return usage;
}

function tierFor(tokens: number | undefined, step = config.truncationStep): number | undefined {
	if (tokens === undefined || tokens === null) return undefined;
	if (!Number.isFinite(tokens) || tokens < step - 2) return undefined;
	if ((tokens + 2) % step !== 0) return undefined;
	return (tokens + 2) / step;
}

function tierWithinWindow(tier: number, minTier: number, maxTier: number): boolean {
	return tier >= minTier && (maxTier === 0 || tier <= maxTier);
}

function continuationWithinLimit(round: number, maxContinue: number): boolean {
	return maxContinue === 0 || round <= maxContinue;
}

function shouldContinueFor(tokens: number | undefined): boolean {
	const tier = tierFor(tokens);
	return tier !== undefined && tierWithinWindow(tier, config.minTier, config.maxTier);
}

function gpt55FamilyMatches(value: string | undefined): boolean {
	if (!value) return false;
	// Boundary-aware: matches gpt-5.5, gpt-5.5-pro, openai/gpt-5.5,
	// openai.gpt-5.5; avoids gpt-5.50.
	return /(^|[^a-z0-9])gpt-5\.5($|[^a-z0-9])/i.test(value);
}

function isGpt55Model(model: Model<Api>, responseModel?: string): boolean {
	return [model.id, model.name, `${model.provider}/${model.id}`, `${model.provider}.${model.id}`, responseModel].some(
		gpt55FamilyMatches,
	);
}

function isGpt55AssistantMessage(message: AssistantMessage, ctxModel?: Model<Api>): boolean {
	return [
		ctxModel?.id,
		ctxModel?.name,
		ctxModel ? `${ctxModel.provider}/${ctxModel.id}` : undefined,
		message.model,
		message.responseModel,
		message.provider ? `${message.provider}/${message.model}` : undefined,
	].some(gpt55FamilyMatches);
}

function thinkingBlockFromPartial(event: Extract<AssistantMessageEvent, { type: "thinking_start" | "thinking_delta" | "thinking_end" }>): ThinkingContent | undefined {
	const block = event.partial.content[event.contentIndex];
	return block?.type === "thinking" ? cloneJson(block) : undefined;
}

function textBlockFromPartial(event: Extract<AssistantMessageEvent, { type: "text_start" | "text_delta" | "text_end" }>): TextContent | undefined {
	const block = event.partial.content[event.contentIndex];
	return block?.type === "text" ? cloneJson(block) : undefined;
}

function toolCallBlockFromPartial(event: Extract<AssistantMessageEvent, { type: "toolcall_start" | "toolcall_delta" | "toolcall_end" }>): ToolCall | undefined {
	const block = event.partial.content[event.contentIndex];
	return block?.type === "toolCall" ? cloneJson(block) : undefined;
}

function hasResponsesReasoningSignature(block: ThinkingContent): boolean {
	if (!block.thinkingSignature) return false;
	try {
		const parsed = JSON.parse(block.thinkingSignature) as unknown;
		if (!isRecord(parsed)) return false;
		if (parsed.type !== "reasoning") return false;
		return Boolean(parsed.encrypted_content || parsed.content || parsed.summary || parsed.id);
	} catch {
		return false;
	}
}

function hasChatCompletionsReplayCarrier(block: ThinkingContent): boolean {
	if (!config.chatCompletionsBestEffort) return false;
	if (!block.thinking.trim()) return false;
	const sig = block.thinkingSignature;
	return sig === "reasoning_content" || sig === "reasoning" || sig === "reasoning_text";
}

function isReplayableThinking(api: SupportedApi, block: ThinkingContent): boolean {
	if (api === "openai-completions") return hasChatCompletionsReplayCarrier(block);
	return hasResponsesReasoningSignature(block);
}

function makeCommentaryBlock(round: number): TextContent {
	return {
		type: "text",
		text: config.markerText,
		textSignature: JSON.stringify({
			v: 1,
			id: `msg_keep_thinking_${round}`,
			phase: "commentary",
		}),
	};
}

function makeReplayAssistant(model: Model<Api>, round: number, thinking: ThinkingContent[], finalMessage: AssistantMessage): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		responseModel: finalMessage.responseModel,
		responseId: finalMessage.responseId,
		content: [...thinking.map(cloneJson), makeCommentaryBlock(round)],
		usage: cloneUsage(finalMessage.usage),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function appendDetection(entry: DetectionEntry, pi?: ExtensionAPI): void {
	recentDetections.unshift(entry);
	if (recentDetections.length > 20) recentDetections.pop();
	if (config.writeSessionEntries) pi?.appendEntry(ENTRY_TYPE, entry);
}

function ensureOuterStarted(
	stream: AssistantMessageEventStream,
	outerRef: { message?: AssistantMessage },
	partial: AssistantMessage,
): AssistantMessage {
	if (outerRef.message) return outerRef.message;
	outerRef.message = {
		...cloneJson(partial),
		content: [],
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: outerRef.message });
	return outerRef.message;
}

function getBuffered(buffers: Map<number, BufferedBlock>, index: number, type: BufferedBlock["type"]): BufferedBlock | undefined {
	const existing = buffers.get(index);
	if (existing?.type === type) return existing;
	return undefined;
}

function createBufferedText(buffers: Map<number, BufferedBlock>, index: number, block?: TextContent): BufferedText {
	const existing = getBuffered(buffers, index, "text") as BufferedText | undefined;
	if (existing) return existing;
	const created: BufferedText = {
		type: "text",
		started: true,
		deltas: [],
		block: block ?? { type: "text", text: "" },
	};
	buffers.set(index, created);
	return created;
}

function createBufferedToolCall(buffers: Map<number, BufferedBlock>, index: number, block?: ToolCall): BufferedToolCall {
	const existing = getBuffered(buffers, index, "toolCall") as BufferedToolCall | undefined;
	if (existing) return existing;
	const created: BufferedToolCall = {
		type: "toolCall",
		started: true,
		deltas: [],
		block: block ?? { type: "toolCall", id: "", name: "", arguments: {} },
	};
	buffers.set(index, created);
	return created;
}

function flushBufferedBlock(stream: AssistantMessageEventStream, outer: AssistantMessage, block: BufferedBlock): void {
	const contentIndex = outer.content.length;
	if (block.type === "text") {
		const finalBlock: TextContent = cloneJson(block.block);
		const finalText = finalBlock.text || block.deltas.join("");
		const liveBlock: TextContent = { type: "text", text: "", textSignature: finalBlock.textSignature };
		outer.content.push(liveBlock);
		stream.push({ type: "text_start", contentIndex, partial: outer });
		const deltas = block.deltas.length > 0 ? block.deltas : finalText ? [finalText] : [];
		for (const delta of deltas) {
			if (!delta) continue;
			liveBlock.text += delta;
			stream.push({ type: "text_delta", contentIndex, delta, partial: outer });
		}
		liveBlock.text = finalText;
		liveBlock.textSignature = finalBlock.textSignature;
		stream.push({ type: "text_end", contentIndex, content: finalText, partial: outer });
		return;
	}

	const finalToolCall: ToolCall = cloneJson(block.block);
	const liveToolCall: ToolCall = {
		type: "toolCall",
		id: finalToolCall.id,
		name: finalToolCall.name,
		arguments: {},
		thoughtSignature: finalToolCall.thoughtSignature,
	};
	outer.content.push(liveToolCall);
	stream.push({ type: "toolcall_start", contentIndex, partial: outer });
	const argumentDelta = block.deltas.length > 0 ? block.deltas.join("") : JSON.stringify(finalToolCall.arguments ?? {});
	if (argumentDelta.length > 0) {
		stream.push({ type: "toolcall_delta", contentIndex, delta: argumentDelta, partial: outer });
	}
	outer.content[contentIndex] = finalToolCall;
	stream.push({ type: "toolcall_end", contentIndex, toolCall: finalToolCall, partial: outer });
}

function doneReason(message: AssistantMessage): Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse"> {
	if (message.content.some((block) => block.type === "toolCall")) return "toolUse";
	if (message.stopReason === "length") return "length";
	return "stop";
}

function addDiagnostic(message: AssistantMessage, details: Record<string, unknown>): void {
	if (!config.writeSessionDiagnostics) return;
	message.diagnostics = [
		...(message.diagnostics ?? []),
		{
			type: "keep-thinking",
			timestamp: Date.now(),
			details,
		},
	];
}

function makeErrorMessage(model: Model<Api>, error: unknown, partial?: AssistantMessage): AssistantMessage {
	return {
		role: "assistant",
		content: partial?.content ? cloneJson(partial.content) : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		responseModel: partial?.responseModel,
		responseId: partial?.responseId,
		usage: partial?.usage ? cloneUsage(partial.usage) : zeroUsage(),
		stopReason: partial?.stopReason === "aborted" ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
		diagnostics: config.writeSessionDiagnostics
			? [
				{
					type: "keep-thinking-error",
					timestamp: Date.now(),
					error: {
						name: error instanceof Error ? error.name : "Error",
						message: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
					},
				},
			]
			: undefined,
	};
}

function wrapStream(api: SupportedApi, delegate: Delegate, pi: ExtensionAPI): Delegate {
	return (model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		if (!config.enabled || !isGpt55Model(model)) {
			return delegate(model, context, options);
		}
		return foldStream(api, delegate, model, context, options, pi);
	};
}

function foldStream(
	api: SupportedApi,
	delegate: Delegate,
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	pi: ExtensionAPI,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const outerRef: { message?: AssistantMessage } = {};
		const replayTail: AssistantMessage[] = [];
		const rounds: RoundInfo[] = [];
		const totalUsage = zeroUsage();
		let firstUsage: Usage | undefined;
		let finalRoundUsage: Usage | undefined;
		let continued = false;
		let stoppedReason: string | undefined;

		try {
			for (let round = 1; ; round++) {
				const roundContext: Context = {
					...context,
					messages: [...context.messages, ...replayTail],
				};
				const inner = delegate(model, roundContext, options);
				const thinkingIndexMap = new Map<number, number>();
				const roundThinking: ThinkingContent[] = [];
				const buffers = new Map<number, BufferedBlock>();
				let finalMessage: AssistantMessage | undefined;
				let finalEventType: "done" | "error" | undefined;

				for await (const event of inner) {
					if (event.type === "start") {
						const outer = ensureOuterStarted(stream, outerRef, event.partial);
						outer.responseId ||= event.partial.responseId;
						outer.responseModel ||= event.partial.responseModel;
						continue;
					}

					if (event.type === "thinking_start") {
						const outer = ensureOuterStarted(stream, outerRef, event.partial);
						const block = thinkingBlockFromPartial(event) ?? { type: "thinking", thinking: "" };
						const outerIndex = outer.content.length;
						thinkingIndexMap.set(event.contentIndex, outerIndex);
						outer.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: outerIndex, partial: outer });
						continue;
					}

					if (event.type === "thinking_delta") {
						const outer = ensureOuterStarted(stream, outerRef, event.partial);
						let outerIndex = thinkingIndexMap.get(event.contentIndex);
						if (outerIndex === undefined) {
							outerIndex = outer.content.length;
							thinkingIndexMap.set(event.contentIndex, outerIndex);
							outer.content.push({ type: "thinking", thinking: "" });
							stream.push({ type: "thinking_start", contentIndex: outerIndex, partial: outer });
						}
						const block = outer.content[outerIndex];
						if (block?.type === "thinking") {
							block.thinking += event.delta;
						}
						stream.push({ type: "thinking_delta", contentIndex: outerIndex, delta: event.delta, partial: outer });
						continue;
					}

					if (event.type === "thinking_end") {
						const outer = ensureOuterStarted(stream, outerRef, event.partial);
						let outerIndex = thinkingIndexMap.get(event.contentIndex);
						if (outerIndex === undefined) {
							outerIndex = outer.content.length;
							thinkingIndexMap.set(event.contentIndex, outerIndex);
							outer.content.push({ type: "thinking", thinking: "" });
							stream.push({ type: "thinking_start", contentIndex: outerIndex, partial: outer });
						}
						const finalThinking = thinkingBlockFromPartial(event);
						if (finalThinking) {
							outer.content[outerIndex] = finalThinking;
							roundThinking.push(cloneJson(finalThinking));
						}
						stream.push({
							type: "thinking_end",
							contentIndex: outerIndex,
							content: finalThinking?.thinking ?? event.content,
							partial: outer,
						});
						continue;
					}

					if (event.type === "text_start") {
						createBufferedText(buffers, event.contentIndex, textBlockFromPartial(event));
						continue;
					}
					if (event.type === "text_delta") {
						const buffered = createBufferedText(buffers, event.contentIndex, textBlockFromPartial(event));
						buffered.deltas.push(event.delta);
						continue;
					}
					if (event.type === "text_end") {
						const buffered = createBufferedText(buffers, event.contentIndex, textBlockFromPartial(event));
						const finalText = textBlockFromPartial(event);
						buffered.block = finalText ?? { ...buffered.block, text: event.content };
						continue;
					}

					if (event.type === "toolcall_start") {
						createBufferedToolCall(buffers, event.contentIndex, toolCallBlockFromPartial(event));
						continue;
					}
					if (event.type === "toolcall_delta") {
						const buffered = createBufferedToolCall(buffers, event.contentIndex, toolCallBlockFromPartial(event));
						buffered.deltas.push(event.delta);
						continue;
					}
					if (event.type === "toolcall_end") {
						const buffered = createBufferedToolCall(buffers, event.contentIndex, event.toolCall ?? toolCallBlockFromPartial(event));
						buffered.block = cloneJson(event.toolCall);
						continue;
					}

					if (event.type === "done") {
						finalEventType = "done";
						finalMessage = event.message;
						break;
					}

					if (event.type === "error") {
						finalEventType = "error";
						finalMessage = event.error;
						break;
					}
				}

				if (!finalMessage) {
					finalMessage = await inner.result();
				}

				addUsage(totalUsage, finalMessage.usage);
				if (!firstUsage) firstUsage = cloneUsage(finalMessage.usage);
				finalRoundUsage = cloneUsage(finalMessage.usage);

				if (finalEventType === "error" || finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted") {
					const errorMessage = outerRef.message ?? makeErrorMessage(model, finalMessage.errorMessage ?? "upstream error", finalMessage);
					errorMessage.stopReason = finalMessage.stopReason === "aborted" ? "aborted" : "error";
					errorMessage.errorMessage = finalMessage.errorMessage ?? "upstream error";
					errorMessage.usage = agentFacingUsage(firstUsage, totalUsage, finalMessage.usage, false);
					addDiagnostic(errorMessage, { rounds, stoppedReason: "upstream_error", billedUsage: totalUsage });
					rememberHandledMessage(errorMessage);
					await writeKeepThinkingLog({
						event: "upstream_error",
						provider: model.provider,
						model: model.id,
						api,
						responseModel: finalMessage.responseModel,
						responseId: finalMessage.responseId,
						rounds,
						stoppedReason: "upstream_error",
						billedUsage: totalUsage,
						errorMessage: finalMessage.errorMessage,
					});
					stream.push({ type: "error", reason: errorMessage.stopReason === "aborted" ? "aborted" : "error", error: errorMessage });
					stream.end(errorMessage);
					return;
				}

				const reasoningTokens = finalMessage.usage?.reasoning;
				const tier = tierFor(reasoningTokens);
				const truncated = tier !== undefined;
				const replayableThinking = roundThinking.some((block) => isReplayableThinking(api, block));
				const withinTotalOutputCap =
					config.maxTotalOutputTokens === 0 || (totalUsage.output || 0) < config.maxTotalOutputTokens;
				const canContinue =
					config.enabled &&
					shouldContinueFor(reasoningTokens) &&
					replayableThinking &&
					continuationWithinLimit(round, config.maxContinue) &&
					withinTotalOutputCap;

				let decision: RoundInfo["decision"] = "clean";
				if (canContinue) decision = "continue";
				else if (truncated && !replayableThinking) decision = "no_replayable_thinking";
				else if (truncated && config.maxContinue > 0 && round > config.maxContinue) decision = "max_continue";
				else if (truncated && !withinTotalOutputCap) decision = "max_total_output_tokens";
				else if (truncated) decision = "tier_out_of_window";

				rounds.push({
					round,
					reasoningTokens,
					tier,
					truncated,
					decision,
					api,
					replayableThinking,
				});

				if (canContinue) {
					continued = true;
					replayTail.push(makeReplayAssistant(model, round, roundThinking, finalMessage));
					continue;
				}

				stoppedReason = decision === "clean" ? undefined : decision;
				const outer = ensureOuterStarted(stream, outerRef, finalMessage);
				outer.responseId ||= finalMessage.responseId;
				outer.responseModel ||= finalMessage.responseModel;

				const bufferedBlocks = Array.from(buffers.entries())
					.sort(([a], [b]) => a - b)
					.map(([, block]) => block);
				const safeToFlushToolCalls = !truncated;
				let flushedFinal = false;
				for (const buffered of bufferedBlocks) {
					if (buffered.type === "toolCall" && !safeToFlushToolCalls) continue;
					flushBufferedBlock(stream, outer, buffered);
					flushedFinal = true;
				}

				outer.usage = agentFacingUsage(firstUsage, totalUsage, finalRoundUsage, flushedFinal);
				outer.stopReason = truncated ? "length" : finalMessage.stopReason;
				if (outer.content.some((block) => block.type === "toolCall") && outer.stopReason === "stop") {
					outer.stopReason = "toolUse";
				}
				addDiagnostic(outer, {
					rounds,
					continued,
					stoppedReason,
					billedUsage: totalUsage,
				});
				rememberHandledMessage(outer);
				if (shouldWriteSummaryLog(rounds, continued, stoppedReason)) {
					await writeKeepThinkingLog({
						event: "summary",
						provider: model.provider,
						model: model.id,
						api,
						responseModel: outer.responseModel,
						responseId: outer.responseId,
						continued,
						stoppedReason,
						finalStopReason: outer.stopReason,
						finalReasoning: outer.usage?.reasoning,
						finalOutput: outer.usage?.output,
						rounds,
						billedUsage: totalUsage,
					});
				}

				if (truncated && tier !== undefined) {
					appendDetection(
						{
							model: model.id,
							provider: model.provider,
							api,
							responseModel: finalMessage.responseModel,
							reasoningTokens: reasoningTokens!,
							tier,
							rounds,
							continued,
							stoppedReason,
							timestamp: Date.now(),
						},
						pi,
					);
				}

				stream.push({ type: "done", reason: doneReason(outer), message: outer });
				stream.end(outer);
				return;
			}
		} catch (error) {
			const outer = outerRef.message ?? makeErrorMessage(model, error);
			outer.stopReason = options?.signal?.aborted ? "aborted" : "error";
			outer.errorMessage = error instanceof Error ? error.message : String(error);
			addDiagnostic(outer, { rounds, stoppedReason: "extension_error", billedUsage: totalUsage });
			rememberHandledMessage(outer);
			await writeKeepThinkingLog({
				event: "extension_error",
				provider: model.provider,
				model: model.id,
				api,
				responseModel: outer.responseModel,
				responseId: outer.responseId,
				rounds,
				stoppedReason: "extension_error",
				billedUsage: totalUsage,
				errorMessage: error instanceof Error ? error.message : String(error),
			});
			stream.push({ type: "error", reason: outer.stopReason === "aborted" ? "aborted" : "error", error: outer });
			stream.end(outer);
		}
	})();

	return stream;
}

function formatDetection(entry: DetectionEntry): string {
	const tier = `n=${entry.tier}`;
	const stopped = entry.stoppedReason ? ` stop=${entry.stoppedReason}` : "";
	const continued = entry.continued ? "continued" : "detected";
	return `${continued}: ${entry.provider ?? "?"}/${entry.model} reasoning=${entry.reasoningTokens} (${tier})${stopped}`;
}

function detectionMatchesModel(entry: DetectionEntry, model: Model<Api>): boolean {
	if (entry.provider && entry.provider !== model.provider) return false;
	return entry.model === model.id || entry.responseModel === model.id || entry.responseModel === `${model.provider}/${model.id}`;
}

function recentDetectionForModel(model: Model<Api>): DetectionEntry | undefined {
	return recentDetections.find((entry) => detectionMatchesModel(entry, model));
}

function compactDetectionStatus(entry: DetectionEntry): string {
	const label = entry.continued ? `${GREEN}continued${RESET}` : `${YELLOW}detected${RESET}`;
	const stop = entry.stoppedReason ? ` ${DIM}${entry.stoppedReason}${RESET}` : "";
	return ` ${DIM}·${RESET} ${label} n=${entry.tier}/${entry.reasoningTokens}${stop}`;
}

function updateStatus(ctx: ExtensionContext): void {
	const model = ctx.model;
	if (!ctx.hasUI) return;
	if (config.enabled && model && isGpt55Model(model)) {
		const detection = recentDetectionForModel(model);
		ctx.ui.setStatus(STATUS_KEY, `${BLUE}Keep Thinking: on${RESET}${detection ? compactDetectionStatus(detection) : ""}`);
	} else {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

function hasKeepThinkingDiagnostic(message: AssistantMessage): boolean {
	return wasHandledByKeepThinking(message) || Boolean(message.diagnostics?.some((d) => d.type === "keep-thinking" || d.type === "keep-thinking-error"));
}

export const __keepThinkingTest = {
	agentFacingUsage,
	continuationWithinLimit,
	defaultConfig: cloneJson(DEFAULT_CONFIG),
	loadConfigFromEnv,
	tierWithinWindow,
};

export default function (pi: ExtensionAPI) {
	pi.registerProvider("keep-thinking-openai-codex-responses", {
		api: "openai-codex-responses",
		streamSimple: wrapStream("openai-codex-responses", openAICodexResponsesApi().streamSimple as Delegate, pi),
	});
	pi.registerProvider("keep-thinking-openai-responses", {
		api: "openai-responses",
		streamSimple: wrapStream("openai-responses", openAIResponsesApi().streamSimple as Delegate, pi),
	});
	pi.registerProvider("keep-thinking-azure-openai-responses", {
		api: "azure-openai-responses",
		streamSimple: wrapStream("azure-openai-responses", azureOpenAIResponsesApi().streamSimple as Delegate, pi),
	});
	pi.registerProvider("keep-thinking-openai-completions", {
		api: "openai-completions",
		streamSimple: wrapStream("openai-completions", openAICompletionsApi().streamSimple as Delegate, pi),
	});

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		if (!isGpt55AssistantMessage(message, ctx.model)) return;
		if (!config.enabled) return;
		updateStatus(ctx);

		const reasoningTokens = message.usage?.reasoning;
		const tier = tierFor(reasoningTokens);
		if (tier === undefined) return;
		if (hasKeepThinkingDiagnostic(message)) return;

		const entry: DetectionEntry = {
			model: message.model,
			provider: message.provider,
			api: message.api,
			responseModel: message.responseModel,
			reasoningTokens: reasoningTokens!,
			tier,
			continued: false,
			stoppedReason: "unsupported_api_or_unwrapped_stream",
			timestamp: Date.now(),
		};
		appendDetection(entry, pi);
		await writeKeepThinkingLog({ event: "unsupported_api_or_unwrapped_stream", ...entry });
		updateStatus(ctx);
		ctx.ui.notify(`Keep Thinking detected possible GPT-5.5 truncation but did not wrap this stream: reasoning=${reasoningTokens}`, "warning");
	});

	pi.registerCommand("keep-thinking", {
		description: "Show/change GPT-5.5 Keep Thinking status, log path, and external stats",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on") {
				config.enabled = true;
				updateStatus(ctx);
				ctx.ui.notify("Keep Thinking enabled", "info");
				return;
			}
			if (action === "off") {
				config.enabled = false;
				updateStatus(ctx);
				ctx.ui.notify("Keep Thinking disabled", "warning");
				return;
			}
			if (action === "config") {
				ctx.ui.notify(JSON.stringify(config, null, 2), "info");
				return;
			}
			if (action === "log") {
				ctx.ui.notify(
					[`Keep Thinking log pattern: ${keepThinkingLogPathPattern() ?? "disabled"}`, `Today's log: ${keepThinkingLogPath() ?? "disabled"}`].join("\n"),
					"info",
				);
				return;
			}
			if (action === "stats" || action.startsWith("stats ")) {
				const windowArg = args.trim().slice("stats".length).trim();
				const window = parseStatsWindow(windowArg);
				if (!window) {
					ctx.ui.notify("Usage: /keep-thinking stats [all|18h|24h|7d|30m]", "warning");
					return;
				}
				ctx.ui.notify(renderKeepThinkingStats(await computeKeepThinkingStats(window)), "info");
				return;
			}

			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
			const watching = ctx.model ? isGpt55Model(ctx.model) : false;
			const lines = [
				`Keep Thinking: ${config.enabled ? "enabled" : "disabled"}`,
				`Current model: ${model}${watching ? " (GPT-5.5 family)" : ""}`,
				`Fingerprint: reasoning = ${config.truncationStep} * n - 2`,
				`Max continuation rounds: ${config.maxContinue}`,
				`External log pattern: ${keepThinkingLogPathPattern() ?? "disabled"}`,
				`Today's log: ${keepThinkingLogPath() ?? "disabled"}`,
				`Session writes: diagnostics=${config.writeSessionDiagnostics ? "on" : "off"}, custom_entries=${config.writeSessionEntries ? "on" : "off"}`,
				"",
				"Recent detections:",
				...(recentDetections.length > 0 ? recentDetections.slice(0, 8).map((d) => `- ${formatDetection(d)}`) : ["- none"]),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// Custom session entries are disabled by default to keep Pi session JSONL standard.
	// If writeSessionEntries is enabled, render those entries nicely when the host supports it.
	const registerEntryRenderer = (pi as unknown as {
		registerEntryRenderer?: <T>(customType: string, renderer: (entry: { data: T }, options: unknown, theme: { fg: (name: string, text: string) => string }) => Text | undefined) => void;
	}).registerEntryRenderer;
	registerEntryRenderer?.<DetectionEntry>(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		const text = `${theme.fg("warning", "Keep Thinking")} ${formatDetection(data)}`;
		return new Text(text, 0, 0);
	});
}
