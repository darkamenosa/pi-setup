/*
 * Context and output-limit recovery around Pi core compaction.
 *
 * Pi owns compaction settings, overflow retries, and session checkpoints. This
 * extension also applies Pi's configured threshold between model turns so a
 * long tool loop compacts before its next request. For compatible openai-codex
 * Responses requests it adds a process-local OpenAI-native checkpoint beside
 * Pi's portable text summary. The native compaction item never enters JSONL.
 */

import { createHash, randomUUID } from "node:crypto";
import { arch, platform, release } from "node:os";

import {
	compact,
	convertToLlm,
	getAgentDir,
	sessionEntryToContextMessages,
	SettingsManager,
	type CompactionEntry,
	type CompactionResult,
	type CompactionSettings,
	type ContextUsage,
	type ExtensionAPI,
	type ExtensionContext,
	type InputEvent,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";

const CONTINUATION_MESSAGE_TYPE = "autocompact-continuation";
const CONTINUATION_MARKER_CONTENT = "[pi-incomplete-turn-continuation]";
const PROACTIVE_CONTINUATION_MARKER_CONTENT = "[pi-proactive-compaction-continuation]";
const BUFFERED_INPUT_MESSAGE_TYPE = "autocompact-buffered-input";
const BUFFERED_INPUT_EVENT_CHANNEL = "pi:autocompact-buffered-input:v1";
const PROACTIVE_INTERRUPT_DIAGNOSTIC = "autocompact_proactive_interrupt";
const NATIVE_DETAILS_KEY = "openaiNativeCompaction";
const NATIVE_BOUNDARY_MESSAGE_TYPE = "autocompact-native-boundary";
const NATIVE_BOUNDARY_PREFIX = "pi-native-compaction-boundary";
const NATIVE_COMPACTION_FEATURE = "remote_compaction_v2";
const NATIVE_COMPACTION_VERSION = 1;
const NATIVE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const NATIVE_MAX_RETRIES = 2;
const NATIVE_MAX_RETRY_DELAY_MS = 60 * 1000;
const RETAINED_USER_TOKEN_BUDGET = 64_000;
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const COMPACTION_SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";
const OMITTED_TOOL_OUTPUT = "Tool output omitted because the context window was exceeded before compaction.";
const CAPABILITY_REQUEST_CHANNEL = "pi-subagent:capability-request:v1";
const CAPABILITY_RESPONSE_CHANNEL = "pi-subagent:capability-response:v1";
const CAPABILITY_VERSION = 1;
const TRANSIENT_GOAL_CONTEXT_TYPES = new Set(["goal-ui", "goal-context", "goal-budget-wrap", "goal-continuation"]);

interface AssistantMessage {
	role?: string;
	content?: Array<Record<string, unknown>>;
	stopReason?: string;
	timestamp?: number;
	usage?: Partial<Usage>;
	diagnostics?: Array<{
		type: string;
		timestamp: number;
		error?: { name?: string; message: string; stack?: string; code?: string | number };
		details?: Record<string, unknown>;
	}>;
}

interface ContinuationDetails {
	continuationId: string;
	inputGeneration: number;
	standalone: boolean;
	reason?: "output-limit" | "proactive-compaction";
}

interface ProactiveCompactionAttempt {
	id: string;
	inputGeneration: number;
	sessionId: string;
	committed: boolean;
	interruptionObserved: boolean;
	goalOwnedRun: boolean;
}

interface BufferedInput {
	replayId: string;
	text: string;
	images?: InputEvent["images"];
	streamingBehavior?: InputEvent["streamingBehavior"];
}

interface BufferedInputDetails {
	replayId: string;
	streamingBehavior?: InputEvent["streamingBehavior"];
}

interface NativeCompactionMetadata {
	version: number;
	artifactId: string;
	modelKey: string;
	transient: true;
}

interface NativeCompactionDetails {
	readFiles?: string[];
	modifiedFiles?: string[];
	[NATIVE_DETAILS_KEY]?: NativeCompactionMetadata;
}

interface RequestTemplate {
	modelKey: string;
	instructions: string;
	tools: unknown[];
	parallelToolCalls: boolean;
	toolChoice: unknown;
	reasoning?: Record<string, unknown>;
	text?: Record<string, unknown>;
	serviceTier?: string;
	temperature?: number;
}

interface ResponseItem extends Record<string, unknown> {
	type?: string;
}

interface NativeArtifact {
	artifactId: string;
	modelKey: string;
	principal: string;
	sessionId: string;
	sourceLeafId: string | null;
	compactionEntryId?: string;
	replacementHistory: ResponseItem[];
	usage?: Usage;
}

interface BoundaryExpectation {
	boundaryId: string;
	artifactId: string;
	fingerprint: string;
	startMarker: string;
	endMarker: string;
}

interface NativeResponseResult {
	compactionItem: ResponseItem;
	usage?: Usage;
}

interface NativeEventState {
	completed: boolean;
	compactionItems: ResponseItem[];
	usageValue?: unknown;
	serviceTier?: string;
}

class NativeCompactionError extends Error {
	constructor(
		message: string,
		readonly retryable = false,
		readonly retryAfterMs?: number,
	) {
		super(message);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function lastAssistantMessage(messages: AssistantMessage[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "assistant") return messages[index];
	}
	return undefined;
}

function isEmptyAssistantContent(content: AssistantMessage["content"]): boolean {
	if (!Array.isArray(content)) return false;
	return content.every((part) => part.type === "text" && (typeof part.text !== "string" || part.text.length === 0));
}

function hasZeroUsage(usage: AssistantMessage["usage"]): boolean {
	return usage?.input === 0
		&& usage.output === 0
		&& usage.cacheRead === 0
		&& usage.cacheWrite === 0
		&& usage.totalTokens === 0;
}

function markProactiveInterrupt<T extends AssistantMessage>(
	message: T,
	signalAborted: boolean,
	attemptId: string,
): T | undefined {
	if (
		message.role !== "assistant"
		|| (message.stopReason !== "error" && message.stopReason !== "aborted")
		|| !signalAborted
		|| !isEmptyAssistantContent(message.content)
		|| !hasZeroUsage(message.usage)
	) return;
	if (message.diagnostics?.some((diagnostic) => diagnostic.type === PROACTIVE_INTERRUPT_DIAGNOSTIC)) {
		return message.stopReason === "aborted" ? message : { ...message, stopReason: "aborted" };
	}
	return {
		...message,
		stopReason: "aborted",
		diagnostics: [
			...(message.diagnostics ?? []),
			{
				type: PROACTIVE_INTERRUPT_DIAGNOSTIC,
				timestamp: message.timestamp ?? Date.now(),
				details: { attemptId },
			},
		],
	};
}

function goalStatuses(ctx: ExtensionContext): Array<string | null> {
	const statuses: Array<string | null> = [];
	for (const candidate of ctx.sessionManager.getBranch()) {
		const entry = candidate as {
			type?: string;
			customType?: string;
			data?: { goal?: { status?: unknown } | null };
		};
		if (entry.type !== "custom" || entry.customType !== "goal") continue;
		statuses.push(typeof entry.data?.goal?.status === "string" ? entry.data.goal.status : null);
	}
	return statuses;
}

function goalOwnsCurrentRun(
	statuses: Array<string | null>,
	runStartedWithActiveGoal: boolean,
	goalEntryCountAtRunStart: number,
): boolean {
	return runStartedWithActiveGoal
		|| statuses.slice(goalEntryCountAtRunStart).includes("active")
		|| statuses.at(-1) === "active";
}

function continuationPrompt(standalone: boolean, reason: "output-limit" | "proactive-compaction" = "output-limit"): string {
	const outputInstruction = standalone
		? "Produce a complete standalone replacement response, including any useful content from the interrupted prefix, because this mode displays only the final assistant response."
		: "Continue from the interrupted response without restarting completed work.";
	if (reason === "proactive-compaction") {
		return `Continue the interrupted task after proactive context compaction.

Pi paused between model turns before sending the next request because the conversation crossed the configured compaction threshold. Resume from the compaction checkpoint and current worktree state without restarting completed work. ${standalone ? "Produce a complete standalone final response when the task is done because this mode displays only the final assistant response." : "Continue the same implementation flow."} If newer user or extension instructions appear after this marker, follow them instead. Do not merely explain the compaction or ask the user to repeat the task.`;
	}
	return `Continue the interrupted ordinary task.

The previous assistant response stopped because it reached the model's maximum output-token limit and is incomplete. ${outputInstruction} Continue from the current conversation context and worktree state. If compaction just occurred, use its summary as the continuity checkpoint. If newer user or extension instructions appear after this marker, follow them instead of autonomously continuing the older task. Do not merely explain the interruption or ask the user to repeat the task.`;
}

function shouldCompactBeforeNextTurn(
	usage: ContextUsage | undefined,
	settings: CompactionSettings | null,
): boolean {
	if (!settings?.enabled || usage?.tokens === null || usage?.tokens === undefined || usage.contextWindow <= 0) return false;
	return usage.tokens > usage.contextWindow - settings.reserveTokens;
}

function compactionWasCancelled(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.message === "Compaction cancelled");
}

function normalizeBaseUrl(baseUrl: unknown): string {
	const value = typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : CODEX_BASE_URL;
	return value.replace(/\/+$/, "");
}

function modelKey(model: Model<any>): string {
	return `${model.provider}:${model.api}:${model.id}:${normalizeBaseUrl(model.baseUrl)}`;
}

function supportsNativeCompaction(model: Model<any> | undefined): model is Model<any> {
	if (!model || model.provider !== "openai-codex" || model.api !== "openai-codex-responses") return false;
	try {
		const base = new URL(normalizeBaseUrl(model.baseUrl));
		return base.protocol === "https:" && base.hostname === "chatgpt.com" && base.port === "" && base.pathname.replace(/\/+$/, "") === "/backend-api";
	} catch {
		return false;
	}
}

function nativeEndpoint(model: Model<any>): string {
	if (!supportsNativeCompaction(model)) throw new Error("OpenAI native compaction requires the trusted ChatGPT Codex endpoint.");
	return `${normalizeBaseUrl(model.baseUrl)}/codex/responses`;
}

function extractAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("invalid token");
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
		const auth = isRecord(payload[JWT_CLAIM_PATH]) ? payload[JWT_CLAIM_PATH] : undefined;
		const accountId = auth?.chatgpt_account_id;
		if (typeof accountId !== "string" || !accountId) throw new Error("missing account id");
		return accountId;
	} catch {
		throw new Error("OpenAI Codex credentials do not contain a usable account ID.");
	}
}

function buildNativeHeaders(
	apiKey: string,
	accountId: string,
	additionalHeaders: Record<string, string> | undefined,
	sessionId: string,
): Record<string, string> {
	const headers = new Headers(additionalHeaders);
	const features = (headers.get("x-codex-beta-features") ?? "")
		.split(",")
		.map((feature) => feature.trim())
		.filter(Boolean);
	if (!features.includes(NATIVE_COMPACTION_FEATURE)) features.push(NATIVE_COMPACTION_FEATURE);
	headers.set("Authorization", `Bearer ${apiKey}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "pi");
	headers.set("User-Agent", `pi-autocompact (${platform()} ${release()}; ${arch()})`);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("x-codex-beta-features", features.join(","));
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	headers.set("session-id", sessionId);
	headers.set("x-client-request-id", randomUUID());
	return Object.fromEntries(headers.entries());
}

function discoverFastMode(pi: ExtensionAPI, model: Model<any>): "priority" | "off" | undefined {
	const eventBus = pi.events;
	if (!eventBus?.on) return undefined;
	const requestId = randomUUID();
	let mode: "priority" | "off" | undefined;
	const stop = eventBus.on(CAPABILITY_RESPONSE_CHANNEL, (value) => {
		if (
			!isRecord(value)
			|| value.version !== CAPABILITY_VERSION
			|| value.requestId !== requestId
			|| value.kind !== "fast-mode"
			|| (value.fastMode !== "priority" && value.fastMode !== "off")
		) return;
		mode = value.fastMode;
	});
	try {
		eventBus.emit(CAPABILITY_REQUEST_CHANNEL, {
			version: CAPABILITY_VERSION,
			requestId,
			target: { provider: model.provider, api: model.api },
		});
	} finally {
		stop();
	}
	return mode;
}

function nativeMetadata(details: unknown): NativeCompactionMetadata | undefined {
	if (!isRecord(details)) return undefined;
	const value = details[NATIVE_DETAILS_KEY];
	if (
		!isRecord(value)
		|| value.version !== NATIVE_COMPACTION_VERSION
		|| typeof value.artifactId !== "string"
		|| typeof value.modelKey !== "string"
		|| value.transient !== true
	) {
		return undefined;
	}
	return value as unknown as NativeCompactionMetadata;
}

function latestCompaction(entries: SessionEntry[]): CompactionEntry<NativeCompactionDetails> | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		if (entries[index]?.type === "compaction") return entries[index] as CompactionEntry<NativeCompactionDetails>;
	}
	return undefined;
}

function mergePreviousFileOperations(
	preparation: SessionBeforeCompactEvent["preparation"],
	branchEntries: SessionEntry[],
): SessionBeforeCompactEvent["preparation"] {
	const fileOps = {
		read: new Set(preparation.fileOps.read),
		written: new Set(preparation.fileOps.written),
		edited: new Set(preparation.fileOps.edited),
	};
	const previous = latestCompaction(branchEntries);
	if (isRecord(previous?.details)) {
		for (const path of Array.isArray(previous.details.readFiles) ? previous.details.readFiles : []) {
			if (typeof path === "string") fileOps.read.add(path);
		}
		for (const path of Array.isArray(previous.details.modifiedFiles) ? previous.details.modifiedFiles : []) {
			if (typeof path === "string") fileOps.edited.add(path);
		}
	}
	return { ...preparation, fileOps };
}

function combineUsage(first: Usage | undefined, second: Usage | undefined): Usage | undefined {
	if (!first) return second;
	if (!second) return first;
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
			: {}),
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
			: {}),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
		},
	};
}

function captureRequestTemplate(payload: unknown, model: Model<any>): RequestTemplate | undefined {
	if (!supportsNativeCompaction(model) || !isRecord(payload) || !Array.isArray(payload.input)) return undefined;
	if (payload.model !== model.id) return undefined;
	if (typeof payload.instructions !== "string") return undefined;
	return {
		modelKey: modelKey(model),
		instructions: payload.instructions,
		tools: Array.isArray(payload.tools) ? cloneJson(payload.tools) : [],
		parallelToolCalls: payload.parallel_tool_calls !== false,
		toolChoice: payload.tool_choice === undefined ? "auto" : cloneJson(payload.tool_choice),
		...(isRecord(payload.reasoning) ? { reasoning: cloneJson(payload.reasoning) } : {}),
		...(isRecord(payload.text) ? { text: cloneJson(payload.text) } : {}),
		...(typeof payload.service_tier === "string" ? { serviceTier: payload.service_tier } : {}),
		...(typeof payload.temperature === "number" ? { temperature: payload.temperature } : {}),
	};
}

function supportsImageInput(model: Model<any>): boolean {
	return Array.isArray(model.input) && model.input.includes("image");
}

function userResponseContent(model: Model<any>, content: unknown): unknown[] {
	const parts = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
	const output: unknown[] = [];
	let imagePlaceholderAdded = false;
	for (const part of parts) {
		if (!isRecord(part)) continue;
		if (part.type === "text" && typeof part.text === "string") {
			output.push({ type: "input_text", text: part.text });
			imagePlaceholderAdded = false;
			continue;
		}
		if (part.type !== "image" || typeof part.data !== "string" || typeof part.mimeType !== "string") continue;
		if (supportsImageInput(model)) {
			output.push({ type: "input_image", detail: "auto", image_url: `data:${part.mimeType};base64,${part.data}` });
		} else if (!imagePlaceholderAdded) {
			output.push({ type: "input_text", text: "(image omitted: model does not support images)" });
			imagePlaceholderAdded = true;
		}
	}
	return output;
}

function toolResultOutput(model: Model<any>, content: unknown): string | unknown[] {
	const parts = Array.isArray(content) ? content : [];
	const text = parts
		.filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => (part as { text: string }).text)
		.join("\n");
	const images = parts.filter((part) => isRecord(part) && part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string");
	if (images.length === 0 || !supportsImageInput(model)) return text || (images.length > 0 ? "(tool image omitted: model does not support images)" : "(no tool output)");
	return [
		...(text ? [{ type: "input_text", text }] : []),
		...images.map((part) => ({
			type: "input_image",
			detail: "auto",
			image_url: `data:${String(part.mimeType)};base64,${String(part.data)}`,
		})),
	];
}

function parsedTextSignature(value: unknown): { id?: string; phase?: string } {
	if (typeof value !== "string" || !value) return {};
	if (!value.startsWith("{")) return { id: value };
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.id !== "string") return {};
		return {
			id: parsed.id,
			...(parsed.phase === "commentary" || parsed.phase === "final_answer" ? { phase: parsed.phase } : {}),
		};
	} catch {
		return {};
	}
}

function parsedReasoningItem(value: unknown): ResponseItem | undefined {
	if (typeof value !== "string" || !value) return undefined;
	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) && parsed.type === "reasoning" ? cloneJson(parsed) as ResponseItem : undefined;
	} catch {
		return undefined;
	}
}

function responseCallId(item: ResponseItem): string | undefined {
	return typeof item.call_id === "string" && item.call_id ? item.call_id : undefined;
}

function expectedOutputType(type: unknown): string | undefined {
	if (type === "function_call" || type === "local_shell_call") return "function_call_output";
	if (type === "custom_tool_call") return "custom_tool_call_output";
	if (type === "tool_search_call") return "tool_search_output";
	return undefined;
}

function normalizeCallOutputs(items: ResponseItem[]): ResponseItem[] {
	const callTypes = new Map<string, string>();
	for (const item of items) {
		const callId = responseCallId(item);
		const outputType = expectedOutputType(item.type);
		if (callId && outputType) callTypes.set(callId, outputType);
	}
	const withSyntheticOutputs: ResponseItem[] = [];
	for (const item of items) {
		const callId = responseCallId(item);
		const outputType = expectedOutputType(item.type);
		withSyntheticOutputs.push(item);
		if (!callId || !outputType) continue;
		if (items.some((candidate) => candidate.type === outputType && responseCallId(candidate) === callId)) continue;
		withSyntheticOutputs.push(
			outputType === "tool_search_output"
				? { type: outputType, call_id: callId, status: "completed", execution: "client", tools: [] }
				: { type: outputType, call_id: callId, output: "No result provided" },
		);
	}
	return withSyntheticOutputs.filter((item) => {
		if (item.type !== "function_call_output" && item.type !== "custom_tool_call_output" && item.type !== "tool_search_output") return true;
		const callId = responseCallId(item);
		return item.execution === "server" || (callId !== undefined && callTypes.get(callId) === item.type);
	});
}

function messagesToResponseItems(model: Model<any>, messages: unknown[]): ResponseItem[] {
	const llmMessages = convertToLlm(messages as never) as Array<Record<string, unknown>>;
	const items: ResponseItem[] = [];
	const customCalls = new Set<string>();
	let messageIndex = 0;
	for (const message of llmMessages) {
		if (message.role === "user") {
			const content = userResponseContent(model, message.content);
			if (content.length > 0) items.push({ role: "user", content });
			messageIndex++;
			continue;
		}
		if (message.role === "assistant") {
			if (message.stopReason === "error" || message.stopReason === "aborted" || !Array.isArray(message.content)) {
				messageIndex++;
				continue;
			}
			const sameModel = message.provider === model.provider && message.api === model.api && message.model === model.id;
			let textIndex = 0;
			for (const block of message.content) {
				if (!isRecord(block)) continue;
				if (block.type === "thinking") {
					const reasoning = sameModel ? parsedReasoningItem(block.thinkingSignature) : undefined;
					if (reasoning) items.push(reasoning);
					else if (!sameModel && typeof block.thinking === "string" && block.thinking.trim()) {
						items.push({
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: block.thinking, annotations: [] }],
							status: "completed",
							id: `msg_pi_${messageIndex}_${textIndex++}`,
						});
					}
					continue;
				}
				if (block.type === "text" && typeof block.text === "string") {
					const signature = sameModel ? parsedTextSignature(block.textSignature) : {};
					const fallbackId = textIndex === 0 ? `msg_pi_${messageIndex}` : `msg_pi_${messageIndex}_${textIndex}`;
					textIndex++;
					const id = signature.id && signature.id.length <= 64 ? signature.id : fallbackId;
					items.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: block.text, annotations: [] }],
						status: "completed",
						id,
						...(signature.phase ? { phase: signature.phase } : {}),
					});
					continue;
				}
				if (block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
				const [callId, itemId] = block.id.split("|");
				if (itemId?.startsWith("ctc_")) {
					const args = isRecord(block.arguments) ? Object.values(block.arguments) : [];
					const input = args.length === 1 && typeof args[0] === "string" ? args[0] : JSON.stringify(block.arguments ?? {});
					items.push({ type: "custom_tool_call", call_id: callId, name: block.name, input, ...(sameModel ? { id: itemId } : {}) });
					customCalls.add(callId);
				} else {
					items.push({
						type: "function_call",
						call_id: callId,
						name: block.name,
						arguments: JSON.stringify(block.arguments ?? {}),
						...(sameModel && itemId?.startsWith("fc_") ? { id: itemId } : {}),
					});
				}
			}
			messageIndex++;
			continue;
		}
		if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			const callId = message.toolCallId.split("|")[0];
			items.push({
				type: customCalls.has(callId) ? "custom_tool_call_output" : "function_call_output",
				call_id: callId,
				output: toolResultOutput(model, message.content),
			});
		}
		messageIndex++;
	}
	return normalizeCallOutputs(items);
}

function contextMessages(entries: SessionEntry[]): unknown[] {
	return entries.flatMap((entry) => sessionEntryToContextMessages(entry));
}

function nativeHistoryBlockReason(model: Model<any>, entries: SessionEntry[]): string | undefined {
	for (const message of contextMessages(entries)) {
		if (!isRecord(message)) continue;
		if (message.role === "toolResult" && Array.isArray(message.addedToolNames) && message.addedToolNames.length > 0) {
			return "deferred tool loading is present";
		}
		if (
			message.role === "assistant"
			&& (message.provider !== model.provider || message.api !== model.api || message.model !== model.id)
			&& Array.isArray(message.content)
			&& message.content.some((part) => isRecord(part) && part.type === "toolCall" && typeof part.id === "string" && part.id.includes("|"))
		) {
			return "foreign Responses tool-call history is present";
		}
		if (Array.isArray(message.content) && message.content.some((part) => isRecord(part) && part.type === "image")) {
			return "image content is present";
		}
	}
	return undefined;
}

function postCompactionEntries(entries: SessionEntry[], compactionEntryId: string): SessionEntry[] | undefined {
	const compactionIndex = entries.findIndex((entry) => entry.id === compactionEntryId && entry.type === "compaction");
	if (compactionIndex < 0) return undefined;
	const compaction = entries[compactionIndex] as CompactionEntry;
	const parentIndex = entries.findIndex((entry, index) => index > compactionIndex && entry.id === compaction.parentId);
	if (parentIndex < 0) return undefined;
	return entries.slice(parentIndex + 1);
}

function genuineUserItems(model: Model<any>, entries: SessionEntry[]): ResponseItem[] {
	const messages = entries
		.filter((entry) => (
			(entry.type === "message" && entry.message.role === "user")
			|| (entry.type === "custom_message" && entry.customType === BUFFERED_INPUT_MESSAGE_TYPE)
		))
		.flatMap((entry) => sessionEntryToContextMessages(entry));
	return messagesToResponseItems(model, messages)
		.filter(isUserResponseMessage)
		.map((item) => ({ ...cloneJson(item), type: "message" }));
}

function isUserResponseMessage(item: ResponseItem): boolean {
	return item.role === "user" && (item.type === "message" || item.type === undefined) && Array.isArray(item.content);
}

function approximateTextTokens(text: string): number {
	return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function utf8Prefix(text: string, byteBudget: number): string {
	let used = 0;
	let result = "";
	for (const character of text) {
		const bytes = Buffer.byteLength(character, "utf8");
		if (used + bytes > byteBudget) break;
		result += character;
		used += bytes;
	}
	return result;
}

function utf8Suffix(text: string, byteBudget: number): string {
	let used = 0;
	const result: string[] = [];
	for (const character of Array.from(text).reverse()) {
		const bytes = Buffer.byteLength(character, "utf8");
		if (used + bytes > byteBudget) break;
		result.push(character);
		used += bytes;
	}
	return result.reverse().join("");
}

function truncateTextToTokenBudget(text: string, tokenBudget: number): string {
	const byteBudget = Math.max(0, tokenBudget * 4);
	const totalBytes = Buffer.byteLength(text, "utf8");
	if (totalBytes <= byteBudget) return text;
	const leftBudget = Math.floor(byteBudget / 2);
	const rightBudget = byteBudget - leftBudget;
	const removedTokens = Math.ceil(Math.max(0, totalBytes - byteBudget) / 4);
	return `${utf8Prefix(text, leftBudget)}…${removedTokens} tokens truncated…${utf8Suffix(text, rightBudget)}`;
}

function approximateMessageTokens(item: ResponseItem): number {
	if ((item.type !== "message" && item.type !== undefined) || !Array.isArray(item.content)) return 1;
	const tokens = item.content.reduce((total, part) => {
		if (!isRecord(part) || (part.type !== "input_text" && part.type !== "output_text") || typeof part.text !== "string") return total;
		return total + approximateTextTokens(part.text);
	}, 0);
	return Math.max(1, tokens);
}

function truncateMessage(item: ResponseItem, tokenBudget: number): ResponseItem | undefined {
	if ((item.type !== "message" && item.type !== undefined) || !Array.isArray(item.content)) return cloneJson(item);
	let remaining = Math.max(0, tokenBudget);
	const content: unknown[] = [];
	for (const part of item.content) {
		if (!isRecord(part)) continue;
		if (part.type === "input_image" || part.type === "input_audio") {
			content.push(cloneJson(part));
			continue;
		}
		if ((part.type !== "input_text" && part.type !== "output_text") || typeof part.text !== "string" || remaining === 0) continue;
		const tokens = approximateTextTokens(part.text);
		if (tokens <= remaining) {
			content.push(cloneJson(part));
			remaining -= tokens;
			continue;
		}
		const text = truncateTextToTokenBudget(part.text, remaining);
		remaining = 0;
		if (text) content.push({ ...cloneJson(part), text });
	}
	return content.length > 0 ? { ...cloneJson(item), type: "message", content } : undefined;
}

function truncateRetainedUsers(items: ResponseItem[], tokenBudget = RETAINED_USER_TOKEN_BUDGET): ResponseItem[] {
	let remaining = tokenBudget;
	const retained: ResponseItem[] = [];
	for (const item of [...items].reverse()) {
		if (remaining === 0) break;
		const tokens = approximateMessageTokens(item);
		if (tokens <= remaining) {
			retained.push(cloneJson(item));
			remaining -= tokens;
			continue;
		}
		const truncated = truncateMessage(item, remaining);
		if (truncated) retained.push(truncated);
		remaining = 0;
	}
	return retained.reverse();
}

function buildReplacementHistory(retainedUsers: ResponseItem[], compactionItem: ResponseItem): ResponseItem[] {
	if (compactionItem.type !== "compaction" || typeof compactionItem.encrypted_content !== "string" || !compactionItem.encrypted_content) {
		throw new NativeCompactionError("OpenAI native compaction returned an invalid compaction item.");
	}
	return [...truncateRetainedUsers(retainedUsers), cloneJson(compactionItem)];
}

function estimateJsonTokens(value: unknown): number {
	return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
}

function rewrittenToolOutput(item: ResponseItem): ResponseItem | undefined {
	if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
		return { ...cloneJson(item), output: OMITTED_TOOL_OUTPUT };
	}
	if (item.type === "tool_search_output") {
		return { ...cloneJson(item), tools: [] };
	}
	return undefined;
}

function trimTrailingToolOutputs(
	input: ResponseItem[],
	instructions: string,
	tools: unknown[],
	contextWindow: number,
): ResponseItem[] {
	const trimmed = input.map(cloneJson);
	let tokens = estimateJsonTokens(instructions) + estimateJsonTokens(tools) + trimmed.reduce((sum, item) => sum + estimateJsonTokens(item), 0);
	for (let index = trimmed.length - 1; index >= 0 && tokens > contextWindow; index--) {
		const rewritten = rewrittenToolOutput(trimmed[index]);
		if (!rewritten) break;
		tokens -= estimateJsonTokens(trimmed[index]);
		trimmed[index] = rewritten;
		tokens += estimateJsonTokens(rewritten);
	}
	return trimmed;
}

function buildNativeRequestBody(
	model: Model<any>,
	template: RequestTemplate,
	input: ResponseItem[],
	sessionId: string,
): Record<string, unknown> {
	return {
		model: model.id,
		instructions: template.instructions,
		input: [...input.map(cloneJson), { type: "compaction_trigger" }],
		tools: cloneJson(template.tools),
		parallel_tool_calls: template.parallelToolCalls,
		tool_choice: cloneJson(template.toolChoice),
		stream: true,
		store: false,
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: sessionId,
		...(template.reasoning ? { reasoning: cloneJson(template.reasoning) } : {}),
		...(template.text ? { text: cloneJson(template.text) } : {}),
		...(template.serviceTier ? { service_tier: template.serviceTier } : {}),
		...(template.temperature !== undefined ? { temperature: template.temperature } : {}),
	};
}

function retryAfterMs(headers: Headers): number | undefined {
	const millisValue = headers.get("retry-after-ms");
	const millis = millisValue === null ? Number.NaN : Number(millisValue);
	if (Number.isFinite(millis)) return Math.max(0, millis);
	const value = headers.get("retry-after");
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(value);
	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function terminalUsageError(value: string): boolean {
	return /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|usage_limit_reached|usage_not_included|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(value);
}

function retryableStatus(status: number, code: string | undefined): boolean {
	if (status === 429 && code && terminalUsageError(code)) return false;
	return status === 408 || status === 409 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function responseFailure(response: Response): Promise<NativeCompactionError> {
	const body = await response.text().catch(() => "");
	let errorCode: string | undefined;
	try {
		const parsed = JSON.parse(body) as unknown;
		if (isRecord(parsed) && isRecord(parsed.error)) {
			const candidate = parsed.error.code ?? parsed.error.type;
			if (typeof candidate === "string" && /^[a-zA-Z0-9_.-]+$/.test(candidate)) errorCode = candidate;
		}
	} catch {
		// The response status is sufficient and raw provider bodies are never surfaced.
	}
	return new NativeCompactionError(
		`OpenAI native compaction failed with HTTP ${response.status}${errorCode ? ` (${errorCode})` : ""}.`,
		retryableStatus(response.status, errorCode),
		retryAfterMs(response.headers),
	);
}

function eventErrorCode(event: Record<string, unknown>): string | undefined {
	const directError = isRecord(event.error) ? event.error : undefined;
	const response = isRecord(event.response) ? event.response : undefined;
	const responseError = isRecord(response?.error) ? response.error : undefined;
	for (const value of [event.code, directError?.code, responseError?.code, responseError?.type]) {
		if (typeof value === "string" && /^[a-zA-Z0-9_.-]+$/.test(value)) return value;
	}
	return undefined;
}

function retryableEventCode(code: string | undefined): boolean {
	if (!code || terminalUsageError(code)) return false;
	return /server_error|rate_limit|overload|service_unavailable|upstream|timeout|temporar/i.test(code);
}

function eventFailureMessage(event: Record<string, unknown>): string {
	const code = eventErrorCode(event);
	return `OpenAI native compaction returned ${String(event.type)}${code ? ` (${code})` : ""}.`;
}

function acceptNativeEvent(state: NativeEventState, value: unknown): void {
	if (!isRecord(value) || typeof value.type !== "string") return;
	if (value.type === "error" || value.type === "response.failed" || value.type === "response.incomplete") {
		const message = eventFailureMessage(value);
		throw new NativeCompactionError(message, value.type !== "response.incomplete" && retryableEventCode(eventErrorCode(value)));
	}
	if (value.type === "response.output_item.done" && isRecord(value.item)) {
		if (value.item.type === "compaction") state.compactionItems.push(value.item as ResponseItem);
		return;
	}
	if (value.type !== "response.completed" && value.type !== "response.done") return;
	const response = isRecord(value.response) ? value.response : undefined;
	if (response?.status !== undefined && response.status !== "completed" && !(value.type === "response.done" && response.status === "done")) {
		throw new NativeCompactionError(`OpenAI native compaction completed with status ${String(response.status)}.`);
	}
	state.completed = true;
	state.usageValue = response?.usage;
	state.serviceTier = typeof response?.service_tier === "string" ? response.service_tier : undefined;
}

function parseSseBlock(block: string): unknown | undefined {
	const data = block
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n")
		.trim();
	if (!data || data === "[DONE]") return undefined;
	try {
		return JSON.parse(data) as unknown;
	} catch {
		throw new NativeCompactionError("OpenAI native compaction returned malformed SSE JSON.");
	}
}

function drainSseBlocks(buffer: string, onEvent: (value: unknown) => void): string {
	while (true) {
		const match = /\r?\n\r?\n/.exec(buffer);
		if (!match || match.index === undefined) return buffer;
		const block = buffer.slice(0, match.index);
		buffer = buffer.slice(match.index + match[0].length);
		const event = parseSseBlock(block);
		if (event !== undefined) onEvent(event);
	}
}

function usageFromResponse(model: Model<any>, value: unknown, requestedServiceTier?: string, responseServiceTier?: string): Usage | undefined {
	if (!isRecord(value)) return undefined;
	const inputTokens = typeof value.input_tokens === "number" && Number.isFinite(value.input_tokens) ? Math.max(0, value.input_tokens) : 0;
	const outputTokens = typeof value.output_tokens === "number" && Number.isFinite(value.output_tokens) ? Math.max(0, value.output_tokens) : 0;
	const inputDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : undefined;
	const outputDetails = isRecord(value.output_tokens_details) ? value.output_tokens_details : undefined;
	const cacheRead = typeof inputDetails?.cached_tokens === "number" && Number.isFinite(inputDetails.cached_tokens) ? Math.max(0, inputDetails.cached_tokens) : 0;
	const cacheWrite = typeof inputDetails?.cache_write_tokens === "number" && Number.isFinite(inputDetails.cache_write_tokens) ? Math.max(0, inputDetails.cache_write_tokens) : 0;
	const usage: Usage = {
		input: Math.max(0, inputTokens - cacheRead - cacheWrite),
		output: outputTokens,
		cacheRead,
		cacheWrite,
		...(typeof outputDetails?.reasoning_tokens === "number" && Number.isFinite(outputDetails.reasoning_tokens)
			? { reasoning: Math.max(0, outputDetails.reasoning_tokens) }
			: {}),
		totalTokens: typeof value.total_tokens === "number" && Number.isFinite(value.total_tokens)
			? Math.max(0, value.total_tokens)
			: inputTokens + outputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	const serviceTier = responseServiceTier === "default" && (requestedServiceTier === "priority" || requestedServiceTier === "flex")
		? requestedServiceTier
		: responseServiceTier ?? requestedServiceTier;
	const multiplier = serviceTier === "flex" ? 0.5 : serviceTier === "priority" ? (model.id === "gpt-5.5" ? 2.5 : 2) : 1;
	if (multiplier !== 1) {
		usage.cost.input *= multiplier;
		usage.cost.output *= multiplier;
		usage.cost.cacheRead *= multiplier;
		usage.cost.cacheWrite *= multiplier;
		usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	}
	return usage;
}

async function readNativeResponse(response: Response, model: Model<any>, requestedServiceTier?: string): Promise<NativeResponseResult> {
	const state: NativeEventState = { completed: false, compactionItems: [] };
	const accept = (value: unknown) => acceptNativeEvent(state, value);
	if (!response.body) {
		let buffer = await response.text();
		buffer = drainSseBlocks(`${buffer}\n\n`, accept);
		if (buffer.trim()) throw new NativeCompactionError("OpenAI native compaction ended with an incomplete SSE event.", true);
	} else {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of response.body) {
			buffer += decoder.decode(chunk, { stream: true });
			buffer = drainSseBlocks(buffer, accept);
			if (state.completed) break;
		}
		buffer += decoder.decode();
		if (!state.completed && buffer.trim()) {
			buffer = drainSseBlocks(`${buffer}\n\n`, accept);
			if (buffer.trim()) throw new NativeCompactionError("OpenAI native compaction ended with an incomplete SSE event.", true);
		}
	}
	if (!state.completed) throw new NativeCompactionError("OpenAI native compaction stream ended before response.completed.", true);
	if (state.compactionItems.length !== 1) {
		throw new NativeCompactionError(`OpenAI native compaction expected one compaction item, received ${state.compactionItems.length}.`);
	}
	const compactionItem = state.compactionItems[0];
	if (typeof compactionItem.encrypted_content !== "string" || !compactionItem.encrypted_content) {
		throw new NativeCompactionError("OpenAI native compaction returned an invalid compaction item.");
	}
	return {
		compactionItem,
		usage: usageFromResponse(model, state.usageValue, requestedServiceTier, state.serviceTier),
	};
}

function linkedTimeoutSignal(parent: AbortSignal): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
	const controller = new AbortController();
	let timeoutReached = false;
	const abort = () => controller.abort(parent.reason);
	if (parent.aborted) abort();
	else parent.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => {
		timeoutReached = true;
		controller.abort(new Error("OpenAI native compaction timed out."));
	}, NATIVE_REQUEST_TIMEOUT_MS);
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			parent.removeEventListener("abort", abort);
		},
		timedOut: () => timeoutReached,
	};
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason ?? new Error("Request aborted."));
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error("Request aborted."));
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

async function requestNativeCompaction(params: {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	accountId: string;
	sessionId: string;
	template: RequestTemplate;
	input: ResponseItem[];
	signal: AbortSignal;
}): Promise<NativeResponseResult> {
	const timeout = linkedTimeoutSignal(params.signal);
	try {
		for (let attempt = 0; ; attempt++) {
			try {
				const response = await fetch(nativeEndpoint(params.model), {
					method: "POST",
					headers: buildNativeHeaders(params.apiKey, params.accountId, params.headers, params.sessionId),
					body: JSON.stringify(buildNativeRequestBody(params.model, params.template, params.input, params.sessionId)),
					signal: timeout.signal,
					redirect: "error",
				});
				if (!response.ok) throw await responseFailure(response);
				return await readNativeResponse(response, params.model, params.template.serviceTier);
			} catch (error) {
				if (params.signal.aborted) throw error;
				if (timeout.timedOut()) throw new NativeCompactionError("OpenAI native compaction timed out.");
				const failure = error instanceof NativeCompactionError
					? error
					: new NativeCompactionError("OpenAI native compaction transport failed.", true);
				if (!failure.retryable || attempt >= NATIVE_MAX_RETRIES) throw failure;
				const delay = failure.retryAfterMs ?? 1000 * (2 ** attempt);
				if (delay > NATIVE_MAX_RETRY_DELAY_MS) {
					throw new NativeCompactionError(`OpenAI requested a retry delay longer than ${NATIVE_MAX_RETRY_DELAY_MS / 1000} seconds.`);
				}
				await sleep(delay, timeout.signal);
			}
		}
	} finally {
		timeout.dispose();
	}
}

function messageSignature(message: unknown): string {
	if (!isRecord(message)) return JSON.stringify(message);
	return JSON.stringify({
		role: message.role,
		content: message.content,
		summary: message.summary,
		tokensBefore: message.tokensBefore,
		customType: message.customType,
		details: message.details,
		toolCallId: message.toolCallId,
		timestamp: message.timestamp,
	});
}

function boundaryMarker(kind: "start" | "end", boundaryId: string): string {
	return `[${NATIVE_BOUNDARY_PREFIX}:${kind}:${boundaryId}]`;
}

function responseItemMarker(item: unknown): string | undefined {
	if (!isRecord(item) || item.role !== "user" || !Array.isArray(item.content) || item.content.length !== 1) return undefined;
	const part = item.content[0];
	return isRecord(part) && part.type === "input_text" && typeof part.text === "string" ? part.text : undefined;
}

function normalizedFingerprintValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizedFingerprintValue);
	if (!isRecord(value)) return value;
	const result: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (key === "id" && typeof child === "string" && /^msg_pi_\d+(?:_\d+)?$/.test(child)) continue;
		result[key] = normalizedFingerprintValue(child);
	}
	return result;
}

function responseItemsFingerprint(items: unknown[]): string {
	return createHash("sha256").update(JSON.stringify(normalizedFingerprintValue(items))).digest("hex");
}

function stripBoundaryItems(input: unknown[], boundary: BoundaryExpectation): unknown[] {
	return input.filter((item) => {
		const marker = responseItemMarker(item);
		return marker !== boundary.startMarker && marker !== boundary.endMarker;
	});
}

function patchNativePayload(
	payload: unknown,
	boundary: BoundaryExpectation | null,
	artifact: NativeArtifact | null,
): { payload: unknown; patched: boolean } {
	if (!isRecord(payload) || !Array.isArray(payload.input)) return { payload, patched: false };
	if (!boundary) return { payload, patched: false };
	const fallback = { ...payload, input: stripBoundaryItems(payload.input, boundary) };
	if (!artifact || boundary.artifactId !== artifact.artifactId) return { payload: fallback, patched: false };
	const startIndexes: number[] = [];
	const endIndexes: number[] = [];
	for (let index = 0; index < payload.input.length; index++) {
		const marker = responseItemMarker(payload.input[index]);
		if (marker === boundary.startMarker) startIndexes.push(index);
		if (marker === boundary.endMarker) endIndexes.push(index);
	}
	if (startIndexes.length !== 1 || endIndexes.length !== 1 || startIndexes[0] >= endIndexes[0]) return { payload: fallback, patched: false };
	const start = startIndexes[0];
	const end = endIndexes[0];
	const compactedPrefix = payload.input.slice(start + 1, end);
	if (responseItemsFingerprint(compactedPrefix) !== boundary.fingerprint) return { payload: fallback, patched: false };
	const input = [
		...payload.input.slice(0, start),
		...artifact.replacementHistory.map(cloneJson),
		...payload.input.slice(end + 1),
	];
	return { payload: { ...payload, input: stripBoundaryItems(input, boundary) }, patched: true };
}

function canSkipBoundaryMessage(message: unknown): boolean {
	return isRecord(message) && message.role === "custom";
}

function removedByGoalContextHook(message: unknown): boolean {
	return isRecord(message) && message.role === "custom" && typeof message.customType === "string" && TRANSIENT_GOAL_CONTEXT_TYPES.has(message.customType);
}

function markNativeBoundary(
	messages: unknown[],
	ctx: ExtensionContext,
	artifact: NativeArtifact | null,
): { messages: unknown[]; boundary: BoundaryExpectation | null } {
	const model = ctx.model;
	if (!artifact || !supportsNativeCompaction(model) || artifact.modelKey !== modelKey(model)) return { messages, boundary: null };
	const entries = ctx.sessionManager.buildContextEntries();
	const compactionIndex = entries.findIndex((entry) => entry.type === "compaction" && entry.id === artifact.compactionEntryId);
	if (compactionIndex < 0) return { messages, boundary: null };
	const compaction = entries[compactionIndex] as CompactionEntry;
	const parentIndex = entries.findIndex((entry, index) => index > compactionIndex && entry.id === compaction.parentId);
	if (parentIndex < 0) return { messages, boundary: null };
	const summaryMessage = sessionEntryToContextMessages(compaction)[0];
	const summarySignature = messageSignature(summaryMessage);
	const summaryIndex = messages.findIndex((message) => messageSignature(message) === summarySignature);
	if (summaryIndex < 0) return { messages, boundary: null };

	const expectedTail = contextMessages(entries.slice(compactionIndex + 1, parentIndex + 1));
	let expectedIndex = 0;
	let endIndex = summaryIndex + 1;
	for (let index = summaryIndex + 1; index < messages.length; index++) {
		const signature = messageSignature(messages[index]);
		while (expectedIndex < expectedTail.length && messageSignature(expectedTail[expectedIndex]) !== signature) {
			if (!canSkipBoundaryMessage(expectedTail[expectedIndex])) return { messages, boundary: null };
			expectedIndex++;
		}
		if (expectedIndex >= expectedTail.length) break;
		expectedIndex++;
		endIndex = index + 1;
	}
	if (expectedTail.slice(expectedIndex).some((message) => !canSkipBoundaryMessage(message))) {
		return { messages, boundary: null };
	}

	const boundaryId = randomUUID();
	const startMarker = boundaryMarker("start", boundaryId);
	const endMarker = boundaryMarker("end", boundaryId);
	const timestamp = Date.now();
	const startMessage = {
		role: "custom",
		customType: NATIVE_BOUNDARY_MESSAGE_TYPE,
		content: startMarker,
		display: false,
		timestamp,
	};
	const endMessage = {
		role: "custom",
		customType: NATIVE_BOUNDARY_MESSAGE_TYPE,
		content: endMarker,
		display: false,
		timestamp,
	};
	const compactedMessages = messages.slice(summaryIndex, endIndex);
	const fingerprintMessages = compactedMessages.filter((message) => !removedByGoalContextHook(message));
	const freshGoalMessages = compactedMessages.filter(removedByGoalContextHook);
	const marked = [
		...messages.slice(0, summaryIndex),
		startMessage,
		...fingerprintMessages,
		endMessage,
		...freshGoalMessages,
		...messages.slice(endIndex),
	];
	try {
		const prefixItems = messagesToResponseItems(model, [startMessage, ...fingerprintMessages, endMessage]);
		const start = prefixItems.findIndex((item) => responseItemMarker(item) === startMarker);
		const end = prefixItems.findIndex((item) => responseItemMarker(item) === endMarker);
		if (start < 0 || end <= start) return { messages, boundary: null };
		return {
			messages: marked,
			boundary: {
				boundaryId,
				artifactId: artifact.artifactId,
				fingerprint: responseItemsFingerprint(prefixItems.slice(start + 1, end)),
				startMarker,
				endMarker,
			},
		};
	} catch {
		return { messages, boundary: null };
	}
}

function compactionSummaryText(summary: string): string {
	return `${COMPACTION_SUMMARY_PREFIX}${summary}${COMPACTION_SUMMARY_SUFFIX}`;
}

function safeErrorMessage(error: unknown): string {
	if (error instanceof NativeCompactionError) return error.message;
	return "OpenAI native compaction was unavailable.";
}

export const __autocompactTest = {
	NATIVE_REQUEST_TIMEOUT_MS,
	RETAINED_USER_TOKEN_BUDGET,
	buildNativeHeaders,
	buildNativeRequestBody,
	buildReplacementHistory,
	captureRequestTemplate,
	combineUsage,
	compactionSummaryText,
	drainSseBlocks,
	extractAccountId,
	genuineUserItems,
	markNativeBoundary,
	messagesToResponseItems,
	modelKey,
	nativeEndpoint,
	patchNativePayload,
	responseItemsFingerprint,
	shouldCompactBeforeNextTurn,
	retryableEventCode,
	supportsNativeCompaction,
	markProactiveInterrupt,
	trimTrailingToolOutputs,
	truncateRetainedUsers,
	usageFromResponse,
};

export default function autocompact(pi: ExtensionAPI) {
	let inputGeneration = 0;
	let continuationQueued = false;
	let activeContinuationId: string | null = null;
	let activeContinuationGeneration: number | null = null;
	let runStartedWithActiveGoal = false;
	let goalEntryCountAtRunStart = 0;
	let activeArtifact: NativeArtifact | null = null;
	let pendingArtifact: NativeArtifact | null = null;
	let currentBoundary: BoundaryExpectation | null = null;
	let requestTemplate: RequestTemplate | null = null;
	let nativeHooksRegistered = false;
	let nativeCompactionCount = 0;
	let lastNativeStatus = "not attempted";
	let settingsManager: SettingsManager | null = null;
	let compactionSettings: CompactionSettings | null = null;
	let proactiveAttempt: ProactiveCompactionAttempt | null = null;
	const bufferedInputs: BufferedInput[] = [];
	let inputInHandoff: BufferedInput | null = null;
	let proactiveRetrySuppressed = false;
	let proactiveCompactionCount = 0;
	let lastProactiveStatus = "not attempted";

	function clearContinuation(): void {
		continuationQueued = false;
		activeContinuationId = null;
		activeContinuationGeneration = null;
	}

	function clearNativeState(): void {
		activeArtifact = null;
		pendingArtifact = null;
		currentBoundary = null;
		requestTemplate = null;
	}

	function reset(): void {
		clearContinuation();
		clearNativeState();
		proactiveAttempt = null;
		bufferedInputs.length = 0;
		inputInHandoff = null;
		proactiveRetrySuppressed = false;
		runStartedWithActiveGoal = false;
		goalEntryCountAtRunStart = 0;
	}

	function queueContinuation(
		ctx: ExtensionContext,
		reason: "output-limit" | "proactive-compaction" = "output-limit",
		expectedInputGeneration = inputGeneration,
	): void {
		if (
			continuationQueued
			|| activeContinuationId !== null
			|| inputGeneration !== expectedInputGeneration
			|| ctx.hasPendingMessages()
		) return;
		const continuationId = randomUUID();
		continuationQueued = true;
		activeContinuationId = continuationId;
		activeContinuationGeneration = inputGeneration;
		const details: ContinuationDetails = {
			continuationId,
			inputGeneration,
			standalone: ctx.mode === "print",
			reason,
		};
		try {
			pi.sendMessage(
				{
					customType: CONTINUATION_MESSAGE_TYPE,
					content: reason === "proactive-compaction" ? PROACTIVE_CONTINUATION_MARKER_CONTENT : CONTINUATION_MARKER_CONTENT,
					display: false,
					details,
				},
				ctx.isIdle()
					? { triggerTurn: true }
					: { triggerTurn: true, deliverAs: reason === "proactive-compaction" ? "followUp" : "steer" },
			);
		} catch (error) {
			clearContinuation();
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Failed to continue incomplete turn: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		}
	}

	function handOffNextBufferedInput(ctx: ExtensionContext): void {
		if (inputInHandoff || bufferedInputs.length === 0) return;
		const input = bufferedInputs.shift()!;
		inputInHandoff = input;
		const content = input.images?.length
			? [{ type: "text" as const, text: input.text }, ...input.images]
			: input.text;
		const deliverAs = ctx.isIdle() ? undefined : (input.streamingBehavior ?? "followUp");
		try {
			pi.sendMessage(
				{
					customType: BUFFERED_INPUT_MESSAGE_TYPE,
					content,
					display: true,
					details: {
						replayId: input.replayId,
						streamingBehavior: input.streamingBehavior,
					} satisfies BufferedInputDetails,
				},
				deliverAs ? { triggerTurn: true, deliverAs } : { triggerTurn: true },
			);
		} catch (error) {
			inputInHandoff = null;
			bufferedInputs.unshift(input);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Compaction finished, but buffered input could not be handed back to Pi: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		}
	}

	function bufferInput(event: InputEvent, ctx: ExtensionContext): void {
		const input: BufferedInput = {
			replayId: randomUUID(),
			text: event.text,
			images: event.images ? [...event.images] : undefined,
			streamingBehavior: event.streamingBehavior,
		};
		bufferedInputs.push(input);
		pi.events.emit(BUFFERED_INPUT_EVENT_CHANNEL, {
			sessionId: ctx.sessionManager.getSessionId(),
			replayId: input.replayId,
			pending: true,
			source: event.source,
		});
		lastProactiveStatus = "proactive compaction is finishing; newer user input will run next";
		if (bufferedInputs.length === 1 && ctx.hasUI) ctx.ui.notify(lastProactiveStatus, "info");
	}

	function createSettingsManager(ctx: ExtensionContext): SettingsManager {
		return SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
	}

	async function refreshCompactionSettings(ctx: ExtensionContext): Promise<void> {
		try {
			if (!settingsManager) settingsManager = createSettingsManager(ctx);
			else await settingsManager.reload();
			compactionSettings = settingsManager.getCompactionSettings();
		} catch {
			compactionSettings = null;
			lastProactiveStatus = "compaction settings could not be loaded";
		}
	}

	function finishProactiveCompaction(
		attemptId: string,
		ctx: ExtensionContext,
		error?: unknown,
	): void {
		const attempt = proactiveAttempt;
		if (!attempt || attempt.id !== attemptId) return;
		proactiveAttempt = null;

		let currentSessionId: string;
		try {
			currentSessionId = ctx.sessionManager.getSessionId();
		} catch {
			return;
		}
		if (currentSessionId !== attempt.sessionId) return;

		const cancelled = error !== undefined && !attempt.committed && compactionWasCancelled(error);
		if (error && !attempt.committed) {
			proactiveRetrySuppressed = true;
			lastProactiveStatus = cancelled
				? "proactive compaction was cancelled; task left idle"
				: "proactive compaction failed; continuing through Pi's normal recovery path";
			if (!cancelled && ctx.hasUI) ctx.ui.notify(lastProactiveStatus, "warning");
		} else {
			proactiveRetrySuppressed = false;
			proactiveCompactionCount++;
			lastProactiveStatus = "proactive compaction completed; continuation queued";
		}

		if (bufferedInputs.length > 0) {
			lastProactiveStatus = "proactive compaction settled; handing back newer user input";
			handOffNextBufferedInput(ctx);
			return;
		}
		if (cancelled) return;
		const currentGoalStatus = goalStatuses(ctx).at(-1);
		if (
			attempt.goalOwnedRun
			&& (currentGoalStatus === "paused" || currentGoalStatus === null || currentGoalStatus === "usageLimited")
		) {
			lastProactiveStatus = "proactive compaction completed; inactive goal left idle";
			return;
		}
		queueContinuation(ctx, "proactive-compaction", attempt.inputGeneration);
	}

	function startProactiveCompaction(ctx: ExtensionContext): void {
		const statuses = goalStatuses(ctx);
		const attempt: ProactiveCompactionAttempt = {
			id: randomUUID(),
			inputGeneration,
			sessionId: ctx.sessionManager.getSessionId(),
			committed: false,
			interruptionObserved: false,
			goalOwnedRun: goalOwnsCurrentRun(statuses, runStartedWithActiveGoal, goalEntryCountAtRunStart),
		};
		proactiveAttempt = attempt;
		clearContinuation();
		lastProactiveStatus = "context threshold crossed; proactive compaction started";
		if (ctx.hasUI) ctx.ui.notify("Context threshold reached; compacting before the next model turn. Wait before running slash commands.", "info");
		try {
			ctx.compact({
				onComplete: () => finishProactiveCompaction(attempt.id, ctx),
				onError: (error) => finishProactiveCompaction(attempt.id, ctx, error),
			});
		} catch (error) {
			finishProactiveCompaction(attempt.id, ctx, error);
		}
	}

	function blockSessionChangeDuringActiveWork(ctx: ExtensionContext): { cancel: true } | undefined {
		if (!proactiveAttempt && !inputInHandoff && bufferedInputs.length === 0 && ctx.isIdle()) return;
		if (ctx.hasUI) ctx.ui.notify("The active model turn or proactive compaction must settle before changing sessions.", "warning");
		return { cancel: true };
	}

	function registerNativeHooks(): void {
		if (nativeHooksRegistered) return;
		nativeHooksRegistered = true;

		pi.on("context", async (event, ctx) => {
			const marked = markNativeBoundary(event.messages, ctx, activeArtifact);
			currentBoundary = marked.boundary;
			return marked.boundary ? { messages: marked.messages as typeof event.messages } : undefined;
		});

		pi.on("before_provider_request", async (event, ctx) => {
			const model = ctx.model;
			if (supportsNativeCompaction(model)) {
				const captured = captureRequestTemplate(event.payload, model);
				if (captured) requestTemplate = captured;
			}
			const boundary = currentBoundary;
			currentBoundary = null;
			if (!boundary) return;
			if (!activeArtifact || !supportsNativeCompaction(model)) {
				return patchNativePayload(event.payload, boundary, null).payload;
			}
			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok || !auth.apiKey || extractAccountId(auth.apiKey) !== activeArtifact.principal) {
					return patchNativePayload(event.payload, boundary, null).payload;
				}
				return patchNativePayload(event.payload, boundary, activeArtifact).payload;
			} catch {
				return patchNativePayload(event.payload, boundary, null).payload;
			}
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		reset();
		settingsManager = null;
		await refreshCompactionSettings(ctx);
		registerNativeHooks();
	});
	pi.on("session_tree", async (_event, ctx) => {
		reset();
		await refreshCompactionSettings(ctx);
	});
	pi.on("session_shutdown", async () => {
		reset();
		settingsManager = null;
		compactionSettings = null;
	});
	pi.on("model_select", async () => {
		currentBoundary = null;
		requestTemplate = null;
		proactiveRetrySuppressed = false;
	});

	pi.on("session_before_switch", async (_event, ctx) => blockSessionChangeDuringActiveWork(ctx));
	pi.on("session_before_fork", async (_event, ctx) => blockSessionChangeDuringActiveWork(ctx));

	pi.on("session_before_tree", async (_event, ctx) => {
		if (proactiveAttempt) return blockSessionChangeDuringActiveWork(ctx);
		if (continuationQueued) {
			if (ctx.hasUI) ctx.ui.notify("Incomplete-turn recovery is queued; run /tree again after it settles.", "warning");
			return { cancel: true };
		}
		if (activeContinuationId !== null) {
			ctx.abort();
			clearContinuation();
			if (ctx.hasUI) ctx.ui.notify("Incomplete-turn recovery stopped; run /tree again after the turn settles.", "warning");
			return { cancel: true };
		}
		return blockSessionChangeDuringActiveWork(ctx);
	});

	pi.on("input", (event, ctx) => {
		inputGeneration++;
		proactiveRetrySuppressed = false;
		if (!proactiveAttempt && !inputInHandoff && bufferedInputs.length === 0) return { action: "continue" };
		bufferInput(event, ctx);
		return { action: "handled" };
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message as AssistantMessage & {
			customType?: string;
			details?: Partial<BufferedInputDetails>;
		};
		if (
			proactiveAttempt
			&& !proactiveAttempt.interruptionObserved
			&& ctx.sessionManager.getSessionId() === proactiveAttempt.sessionId
		) {
			const interrupted = markProactiveInterrupt(message, ctx.signal?.aborted === true, proactiveAttempt.id);
			if (interrupted) {
				proactiveAttempt.interruptionObserved = true;
				return { message: interrupted as typeof event.message };
			}
		}
		if (
			!inputInHandoff
			|| message.role !== "custom"
			|| message.customType !== BUFFERED_INPUT_MESSAGE_TYPE
			|| message.details?.replayId !== inputInHandoff.replayId
		) return;
		inputInHandoff = null;
		handOffNextBufferedInput(ctx);
		if (!inputInHandoff && bufferedInputs.length === 0) {
			pi.events.emit(BUFFERED_INPUT_EVENT_CHANNEL, {
				sessionId: ctx.sessionManager.getSessionId(),
				pending: false,
			});
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		await refreshCompactionSettings(ctx);
		if (continuationQueued) {
			continuationQueued = false;
		} else {
			clearContinuation();
		}
		const statuses = goalStatuses(ctx);
		goalEntryCountAtRunStart = statuses.length;
		runStartedWithActiveGoal = statuses.at(-1) === "active";
		if (!proactiveAttempt) handOffNextBufferedInput(ctx);
	});

	pi.on("turn_start", async (event, ctx) => {
		handOffNextBufferedInput(ctx);
		if (event.turnIndex === 0 || ctx.mode === "print" || ctx.mode === "json") return;
		if (
			ctx.signal?.aborted === true
			|| proactiveAttempt
			|| inputInHandoff
			|| bufferedInputs.length > 0
			|| proactiveRetrySuppressed
			|| ctx.hasPendingMessages()
		) return;
		if (!shouldCompactBeforeNextTurn(ctx.getContextUsage(), compactionSettings)) return;
		startProactiveCompaction(ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		const statuses = goalStatuses(ctx);
		const goalOwnsRun = goalOwnsCurrentRun(statuses, runStartedWithActiveGoal, goalEntryCountAtRunStart);
		runStartedWithActiveGoal = false;
		goalEntryCountAtRunStart = statuses.length;
		clearContinuation();
		const lastAssistant = lastAssistantMessage(event.messages as AssistantMessage[]);
		if (lastAssistant?.stopReason !== "length" || goalOwnsRun || ctx.hasPendingMessages()) return;
		queueContinuation(ctx);
	});

	pi.on("context", async (event) => {
		let lastContinuationIndex = -1;
		let standalone = false;
		let reason: "output-limit" | "proactive-compaction" = "output-limit";
		for (let index = 0; index < event.messages.length; index++) {
			const message = event.messages[index] as {
				customType?: string;
				details?: Partial<ContinuationDetails>;
			};
			if (
				message.customType === CONTINUATION_MESSAGE_TYPE
				&& message.details?.continuationId === activeContinuationId
				&& message.details.inputGeneration === activeContinuationGeneration
			) {
				lastContinuationIndex = index;
				standalone = message.details.standalone === true;
				reason = message.details.reason === "proactive-compaction" ? "proactive-compaction" : "output-limit";
			}
		}

		const messages: typeof event.messages = [];
		for (let index = 0; index < event.messages.length; index++) {
			const message = event.messages[index];
			const custom = message as { customType?: string };
			if (custom.customType !== CONTINUATION_MESSAGE_TYPE) {
				messages.push(message);
				continue;
			}
			if (index !== lastContinuationIndex) continue;
			messages.push({ ...message, content: continuationPrompt(standalone, reason), display: false });
		}
		return { messages };
	});

	pi.on("session_before_compact", async (event, ctx) => {
		pendingArtifact = null;
		const model = ctx.model;
		if (!supportsNativeCompaction(model)) return;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) return;
		const preparation = mergePreviousFileOperations(event.preparation, event.branchEntries);
		const fastMode = discoverFastMode(pi, model);
		const template = requestTemplate ? { ...requestTemplate } : null;
		if (template && fastMode === "priority") template.serviceTier = "priority";
		if (template && fastMode === "off") delete template.serviceTier;
		const portableServiceTier = fastMode === "priority" ? "priority" : fastMode === "off" ? undefined : template?.serviceTier;
		const portableStream = portableServiceTier
			? ((streamModel: Model<any>, context: Parameters<typeof streamSimple>[1], options: Parameters<typeof streamSimple>[2]) =>
				streamSimple(streamModel, context, { ...options, serviceTier: portableServiceTier } as never))
			: undefined;
		const portablePromise = compact(
			preparation,
			model,
			auth.apiKey,
			auth.headers,
			event.customInstructions,
			event.signal,
			ctx.thinkingLevel ?? pi.getThinkingLevel(),
			portableStream,
			auth.env,
		);
		const portableOnly = async (status: string) => {
			try {
				const portable = await portablePromise;
				if (event.signal.aborted) return;
				lastNativeStatus = status;
				return { compaction: portable };
			} catch {
				return;
			}
		};

		if (event.reason === "overflow") return portableOnly("overflow used portable compaction");
		if (event.customInstructions?.trim()) return portableOnly("focused compaction used portable compaction");
		if (!template || template.modelKey !== modelKey(model)) {
			return portableOnly("no compatible request template; used portable compaction");
		}
		const entries = ctx.sessionManager.buildContextEntries();
		const blockReason = nativeHistoryBlockReason(model, entries);
		if (blockReason) return portableOnly(`${blockReason}; used portable compaction`);

		let principal: string;
		let nativeInput: ResponseItem[];
		let retainedUsers: ResponseItem[];
		const sessionId = ctx.sessionManager.getSessionId();
		const sourceLeafId = ctx.sessionManager.getLeafId();
		try {
			principal = extractAccountId(auth.apiKey);
			const canChain = activeArtifact
				&& activeArtifact.modelKey === modelKey(model)
				&& activeArtifact.principal === principal
				&& activeArtifact.sessionId === sessionId
				&& activeArtifact.compactionEntryId !== undefined;
			const postEntries = canChain ? postCompactionEntries(entries, activeArtifact.compactionEntryId!) : undefined;
			if (canChain && postEntries) {
				nativeInput = [...activeArtifact.replacementHistory.map(cloneJson), ...messagesToResponseItems(model, contextMessages(postEntries))];
				retainedUsers = [
					...activeArtifact.replacementHistory
						.filter(isUserResponseMessage)
						.map(cloneJson),
					...genuineUserItems(model, postEntries),
				];
			} else {
				nativeInput = messagesToResponseItems(model, contextMessages(entries));
				retainedUsers = genuineUserItems(model, entries);
			}
			nativeInput = trimTrailingToolOutputs(nativeInput, template.instructions, template.tools, model.contextWindow);
		} catch {
			return portableOnly("native input could not be prepared; used portable compaction");
		}

		const nativeAbortController = new AbortController();
		const nativeSignal = AbortSignal.any([event.signal, nativeAbortController.signal]);
		const nativePromise = requestNativeCompaction({
			model,
			apiKey: auth.apiKey,
			headers: auth.headers,
			accountId: principal,
			sessionId,
			template,
			input: nativeInput,
			signal: nativeSignal,
		});
		const guardedPortablePromise = portablePromise.catch((error: unknown) => {
			nativeAbortController.abort(error);
			throw error;
		});
		const [portableResult, nativeResult] = await Promise.allSettled([guardedPortablePromise, nativePromise]);
		if (portableResult.status === "rejected" || event.signal.aborted) return;

		const portable = portableResult.value as CompactionResult<NativeCompactionDetails>;
		if (nativeResult.status === "rejected") {
			lastNativeStatus = safeErrorMessage(nativeResult.reason);
			if (ctx.hasUI) ctx.ui.notify(`${lastNativeStatus} Pi's portable compaction was kept.`, "warning");
			return { compaction: portable };
		}

		let replacementHistory: ResponseItem[];
		try {
			replacementHistory = buildReplacementHistory(retainedUsers, nativeResult.value.compactionItem);
		} catch (error) {
			lastNativeStatus = safeErrorMessage(error);
			if (ctx.hasUI) ctx.ui.notify(`${lastNativeStatus} Pi's portable compaction was kept.`, "warning");
			return { compaction: portable };
		}
		const artifactId = randomUUID();
		pendingArtifact = {
			artifactId,
			modelKey: modelKey(model),
			principal,
			sessionId,
			sourceLeafId,
			replacementHistory,
			usage: nativeResult.value.usage,
		};
		const details: NativeCompactionDetails = {
			...(isRecord(portable.details) ? portable.details : {}),
			[NATIVE_DETAILS_KEY]: {
				version: NATIVE_COMPACTION_VERSION,
				artifactId,
				modelKey: modelKey(model),
				transient: true,
			},
		};
		lastNativeStatus = "native checkpoint created; awaiting session commit";
		return {
			compaction: {
				...portable,
				details,
				usage: combineUsage(portable.usage, nativeResult.value.usage),
			},
		};
	});

	pi.on("session_compact", async (_event, ctx) => {
		if (proactiveAttempt && ctx.sessionManager.getSessionId() === proactiveAttempt.sessionId) {
			proactiveAttempt.committed = true;
			proactiveRetrySuppressed = false;
		}
		const branch = ctx.sessionManager.getBranch();
		const committed = latestCompaction(branch);
		const metadata = nativeMetadata(committed?.details);
		if (
			pendingArtifact
			&& committed
			&& metadata?.artifactId === pendingArtifact.artifactId
			&& metadata.modelKey === pendingArtifact.modelKey
			&& committed.parentId === pendingArtifact.sourceLeafId
			&& ctx.sessionManager.getSessionId() === pendingArtifact.sessionId
		) {
			activeArtifact = { ...pendingArtifact, compactionEntryId: committed.id };
			nativeCompactionCount++;
			lastNativeStatus = "active process-local checkpoint";
		} else {
			activeArtifact = null;
			if (pendingArtifact) lastNativeStatus = "native checkpoint was not committed; using portable context";
		}
		pendingArtifact = null;
		currentBoundary = null;
	});

	pi.registerCommand("autocompact", {
		description: "Explain OpenAI native compaction and incomplete-turn recovery",
		handler: async (_args, ctx) => {
			const nativeSupport = supportsNativeCompaction(ctx.model) ? "supported for the current model" : "not used for the current model";
			ctx.ui.notify(
				[
					"Pi core owns compaction settings and overflow retries; this extension also checks that configured threshold between model turns so long tool loops compact before their next request.",
					`OpenAI native compaction is ${nativeSupport}; encrypted checkpoints remain process-local and Pi's text summary is the durable fallback.`,
					"Overflow compactions and focused /compact requests intentionally use Pi's portable compaction.",
					"Plain input arriving during proactive compaction is handed back as an ordered, model-visible custom user message; wait for it to settle before running slash commands or quitting.",
					"This extension also resumes ordinary responses interrupted by the model's output-token limit; active /goal work continues through the goal extension.",
					`Proactive compactions completed this runtime: ${proactiveCompactionCount}. Last status: ${lastProactiveStatus}.`,
					`Native checkpoints committed this runtime: ${nativeCompactionCount}. Last status: ${lastNativeStatus}.`,
				].join("\n"),
				"info",
			);
		},
	});
}
