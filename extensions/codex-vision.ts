import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { openAICodexResponsesApi, type Api, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_PROVIDER_ID = "openai-codex";

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

const TOOL_NAME = "codex_vision";
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
const DEFAULT_VISION_MODEL = process.env.CODEX_VISION_MODEL || "gpt-5.6-luna";
const MAX_IMAGES_PER_REQUEST = positiveEnvironmentInteger("CODEX_VISION_MAX_IMAGES", 8);
const MAX_IMAGE_BYTES = positiveEnvironmentInteger("CODEX_VISION_MAX_IMAGE_BYTES", 20 * 1024 * 1024);
const IMAGE_STORE_DIR = process.env.CODEX_VISION_STORE_DIR || join(homedir(), ".pi", "agent", "codex-vision", "images");
const BATCH_PREFIX = "batch_";
const IMAGE_REF_PREFIX = "img_";

const SUPPORTED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function positiveEnvironmentInteger(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
	return value;
}

interface StoredImageMeta {
	ref: string;
	mimeType: string;
	path?: string;
	url?: string;
	bytes?: number;
	sha256?: string;
	createdAt: string;
	originalName?: string;
}

interface StoredBatchMeta {
	id: string;
	refs: string[];
	createdAt: string;
	promptPreview?: string;
}

interface PreparedImage {
	label: string;
	data: string;
	mimeType: string;
	bytes: number;
	source: string;
}

let latestBatchId: string | undefined;


function sanitizeId(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96);
}

function extensionFromMimeType(mimeType: string): string {
	switch (mimeType.toLowerCase()) {
		case "image/png":
			return ".png";
		case "image/jpeg":
			return ".jpg";
		case "image/webp":
			return ".webp";
		case "image/gif":
			return ".gif";
		default:
			return ".img";
	}
}

function mimeTypeFromPath(path: string): string | undefined {
	switch (extname(path).toLowerCase()) {
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		default:
			return undefined;
	}
}

function sniffMimeType(buffer: Buffer): string | undefined {
	if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
	if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
	return undefined;
}

function assertSupportedImage(mimeType: string, bytes: number, label: string): void {
	if (!SUPPORTED_MIME_TYPES.has(mimeType.toLowerCase())) {
		throw new Error(`${label} uses unsupported image MIME type ${mimeType}. Supported: ${Array.from(SUPPORTED_MIME_TYPES).join(", ")}`);
	}
	if (bytes <= 0) throw new Error(`${label} is empty.`);
	if (bytes > MAX_IMAGE_BYTES) {
		throw new Error(`${label} is ${formatSize(bytes)}, above codex_vision limit ${formatSize(MAX_IMAGE_BYTES)}.`);
	}
}

async function ensureStoreDir(): Promise<void> {
	await mkdir(IMAGE_STORE_DIR, { recursive: true, mode: 0o700 });
}

function imageMetaPath(ref: string): string {
	return join(IMAGE_STORE_DIR, `${sanitizeId(ref)}.json`);
}

function batchMetaPath(id: string): string {
	return join(IMAGE_STORE_DIR, `${sanitizeId(id)}.json`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function readJsonFile<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function normalizeIncomingImage(image: unknown): { data: string; mimeType: string; originalName?: string } | undefined {
	if (!isRecord(image)) return undefined;
	const directData = readString(image.data);
	const directMime = readString(image.mimeType) ?? readString(image.mediaType);
	if (directData && directMime) {
		return { data: directData, mimeType: directMime, ...(readString(image.name) ? { originalName: readString(image.name) } : {}) };
	}
	const source = isRecord(image.source) ? image.source : undefined;
	if (source?.type === "base64") {
		const data = readString(source.data);
		const mimeType = readString(source.mediaType) ?? readString(source.mimeType);
		if (data && mimeType) return { data, mimeType, ...(readString(image.name) ? { originalName: readString(image.name) } : {}) };
	}
	return undefined;
}

async function storeImageFromBase64(image: { data: string; mimeType: string; originalName?: string }): Promise<StoredImageMeta> {
	const buffer = Buffer.from(image.data, "base64");
	return storeImageBuffer(buffer, image.mimeType, image.originalName ?? "attached image", image.originalName);
}

async function storeImageBuffer(buffer: Buffer, rawMimeType: string, label: string, originalName?: string): Promise<StoredImageMeta> {
	const mimeType = rawMimeType.toLowerCase();
	assertSupportedImage(mimeType, buffer.byteLength, label);
	await ensureStoreDir();
	const sha256 = createHash("sha256").update(buffer).digest("hex");
	const ref = `${IMAGE_REF_PREFIX}${sha256.slice(0, 20)}`;
	const imagePath = join(IMAGE_STORE_DIR, `${ref}${extensionFromMimeType(mimeType)}`);
	if (!existsSync(imagePath)) await writeFile(imagePath, buffer, { mode: 0o600 });
	const meta: StoredImageMeta = {
		ref,
		mimeType,
		path: imagePath,
		bytes: buffer.byteLength,
		sha256,
		createdAt: new Date().toISOString(),
		...(originalName ? { originalName } : {}),
	};
	await writeJson(imageMetaPath(ref), meta);
	return meta;
}

function extractImageFilePathsFromText(text: string, cwd: string): string[] {
	const paths: string[] = [];
	const fileTagPattern = /<file\s+name=(?:"([^"]+)"|'([^']+)')>[\s\S]*?<\/file>/g;
	let match: RegExpExecArray | null;
	while ((match = fileTagPattern.exec(text)) !== null) {
		const rawPath = match[1] ?? match[2];
		if (!rawPath || !mimeTypeFromPath(rawPath)) continue;
		paths.push(resolve(cwd, rawPath.startsWith("@") ? rawPath.slice(1) : rawPath));
	}
	return [...new Set(paths)];
}

async function storeInputImagePaths(paths: string[]): Promise<StoredImageMeta[]> {
	const stored: StoredImageMeta[] = [];
	for (const path of paths.slice(0, MAX_IMAGES_PER_REQUEST)) {
		const fileStat = await stat(path);
		if (!fileStat.isFile()) throw new Error(`${path} is not a file.`);
		if (fileStat.size > MAX_IMAGE_BYTES) throw new Error(`${path} is ${formatSize(fileStat.size)}, above codex_vision limit ${formatSize(MAX_IMAGE_BYTES)}.`);
		const buffer = await readFile(path);
		const mimeType = (mimeTypeFromPath(path) ?? sniffMimeType(buffer))?.toLowerCase();
		if (!mimeType) throw new Error(`Could not infer image MIME type for ${path}.`);
		const meta = await storeImageBuffer(buffer, mimeType, path, basename(path));
		stored.push(meta);
	}
	return stored;
}

async function storeInputImages(images: unknown[] | undefined, promptText: string, fallbackPaths: string[] = []): Promise<StoredBatchMeta | undefined> {
	if ((!Array.isArray(images) || images.length === 0) && fallbackPaths.length === 0) return undefined;
	const refs: string[] = [];
	const errors: string[] = [];
	for (const image of (images ?? []).slice(0, MAX_IMAGES_PER_REQUEST)) {
		const normalized = normalizeIncomingImage(image);
		if (!normalized) {
			errors.push("an attached image had an unsupported internal shape");
			continue;
		}
		try {
			const meta = await storeImageFromBase64(normalized);
			refs.push(meta.ref);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	if ((images?.length ?? 0) > MAX_IMAGES_PER_REQUEST) {
		errors.push(`only the first ${MAX_IMAGES_PER_REQUEST} image(s) were saved`);
	}
	if (refs.length < MAX_IMAGES_PER_REQUEST && fallbackPaths.length > 0) {
		const capacity = MAX_IMAGES_PER_REQUEST - refs.length;
		try {
			const fallback = await storeInputImagePaths(fallbackPaths.slice(0, capacity));
			refs.push(...fallback.map((meta) => meta.ref));
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
		if (fallbackPaths.length > capacity) {
			errors.push(`only the first ${MAX_IMAGES_PER_REQUEST} image file path(s) were saved`);
		}
	}
	if (refs.length === 0 && errors.length > 0) throw new Error(errors.join("; "));
	if (refs.length === 0) return undefined;
	await ensureStoreDir();
	const id = `${BATCH_PREFIX}${Date.now()}_${randomUUID().slice(0, 8)}`;
	const uniqueRefs = [...new Set(refs)];
	const batch: StoredBatchMeta = {
		id,
		refs: uniqueRefs,
		createdAt: new Date().toISOString(),
		promptPreview: promptText.slice(0, 500),
	};
	await writeJson(batchMetaPath(id), { ...batch, ...(errors.length > 0 ? { warnings: errors } : {}) });
	latestBatchId = id;
	return batch;
}

async function findLatestBatch(): Promise<StoredBatchMeta | undefined> {
	if (latestBatchId) {
		const loaded = readJsonFile<StoredBatchMeta>(batchMetaPath(latestBatchId));
		if (loaded?.refs?.length) return loaded;
	}
	try {
		await ensureStoreDir();
		const entries = await readdir(IMAGE_STORE_DIR);
		const batches = entries
			.filter((name) => name.startsWith(BATCH_PREFIX) && name.endsWith(".json"))
			.map((name) => ({ name, path: join(IMAGE_STORE_DIR, name) }))
			.sort((a, b) => b.name.localeCompare(a.name));
		for (const batch of batches) {
			const loaded = readJsonFile<StoredBatchMeta>(batch.path);
			if (loaded?.refs?.length) return loaded;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function loadImageMeta(ref: string): StoredImageMeta | undefined {
	const normalized = sanitizeId(ref);
	return readJsonFile<StoredImageMeta>(imageMetaPath(normalized));
}

async function refsFromImageRefs(imageRefs: string[] | undefined): Promise<string[]> {
	const refs: string[] = [];
	const requested = imageRefs ?? [];
	for (const raw of requested) {
		const ref = raw.trim();
		if (!ref) continue;
		if (ref === "latest") {
			const batch = await findLatestBatch();
			if (!batch) throw new Error("No latest codex_vision image batch is available.");
			refs.push(...batch.refs);
			continue;
		}
		const batchId = ref.startsWith("batch:") ? ref.slice("batch:".length) : ref;
		if (batchId.startsWith(BATCH_PREFIX)) {
			const batch = readJsonFile<StoredBatchMeta>(batchMetaPath(batchId));
			if (!batch?.refs?.length) throw new Error(`Unknown codex_vision batch ref: ${ref}`);
			refs.push(...batch.refs);
			continue;
		}
		refs.push(ref);
	}
	return [...new Set(refs)];
}

async function preparedImageFromMeta(ref: string, signal?: AbortSignal): Promise<PreparedImage> {
	const meta = loadImageMeta(ref);
	if (!meta) throw new Error(`Unknown codex_vision image ref: ${ref}`);
	if (meta.url) return preparedImageFromUrl(meta.url, meta.ref, signal);
	if (!meta.path) throw new Error(`Image ref ${ref} has no local path or URL.`);
	return preparedImageFromPath(meta.path, meta.ref, meta.mimeType);
}

async function preparedImageFromPath(path: string, label?: string, mimeHint?: string): Promise<PreparedImage> {
	const absolute = resolve(path.startsWith("@") ? path.slice(1) : path);
	const fileStat = await stat(absolute);
	if (!fileStat.isFile()) throw new Error(`${absolute} is not a file.`);
	if (fileStat.size > MAX_IMAGE_BYTES) throw new Error(`${absolute} is ${formatSize(fileStat.size)}, above codex_vision limit ${formatSize(MAX_IMAGE_BYTES)}.`);
	const buffer = await readFile(absolute);
	const mimeType = (mimeHint ?? mimeTypeFromPath(absolute) ?? sniffMimeType(buffer))?.toLowerCase();
	if (!mimeType) throw new Error(`Could not infer image MIME type for ${absolute}.`);
	assertSupportedImage(mimeType, buffer.byteLength, absolute);
	return {
		label: label ?? basename(absolute),
		data: buffer.toString("base64"),
		mimeType,
		bytes: buffer.byteLength,
		source: absolute,
	};
}

async function readRemoteImageBody(response: Response, url: string, signal?: AbortSignal): Promise<Buffer> {
	const contentLength = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
		signal?.throwIfAborted();
		await response.body?.cancel().catch(() => undefined);
		signal?.throwIfAborted();
		throw new Error(`Remote image ${url} is ${formatSize(contentLength)}, above codex_vision limit ${formatSize(MAX_IMAGE_BYTES)}.`);
	}
	if (!response.body) return Buffer.alloc(0);

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	while (true) {
		const { done, value } = await reader.read();
		signal?.throwIfAborted();
		if (done) break;
		if (bytes + value.byteLength > MAX_IMAGE_BYTES) {
			await reader.cancel().catch(() => undefined);
			signal?.throwIfAborted();
			throw new Error(`Remote image ${url} exceeds codex_vision limit ${formatSize(MAX_IMAGE_BYTES)}.`);
		}
		chunks.push(value);
		bytes += value.byteLength;
	}
	return Buffer.concat(chunks, bytes);
}

async function preparedImageFromUrl(url: string, label?: string, signal?: AbortSignal): Promise<PreparedImage> {
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`Unsupported image URL protocol: ${parsed.protocol}`);
	const response = await fetch(parsed, { signal });
	if (!response.ok) throw new Error(`Failed to fetch image URL ${url}: ${response.status} ${response.statusText}`);
	const buffer = await readRemoteImageBody(response, url, signal);
	const mimeType = (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || sniffMimeType(buffer));
	if (!mimeType) throw new Error(`Could not infer image MIME type for ${url}.`);
	assertSupportedImage(mimeType, buffer.byteLength, url);
	return {
		label: label ?? parsed.hostname,
		data: buffer.toString("base64"),
		mimeType,
		bytes: buffer.byteLength,
		source: url,
	};
}

function decodedBase64Size(value: string): number {
	const maximumEncodedLength = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
	if (value.length > maximumEncodedLength) {
		throw new Error(`Inline base64 image exceeds codex_vision encoded limit for ${formatSize(MAX_IMAGE_BYTES)}.`);
	}
	let padding = 0;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		const alphaNumeric = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
		if (alphaNumeric || code === 43 || code === 47) {
			if (padding > 0) throw new Error("Inline image contains invalid base64 padding.");
			continue;
		}
		if (code === 61 && index >= value.length - 2) {
			padding++;
			continue;
		}
		throw new Error("Inline image contains invalid base64 data.");
	}
	if (value.length % 4 === 1 || (padding > 0 && value.length % 4 !== 0)) {
		throw new Error("Inline image contains invalid base64 length.");
	}
	return Math.floor(value.length * 3 / 4) - padding;
}

async function preparedImageFromDirectInput(input: Record<string, unknown>, ctx: ExtensionContext, signal?: AbortSignal): Promise<PreparedImage | undefined> {
	const ref = readString(input.ref);
	if (ref) return preparedImageFromMeta(ref, signal);
	const path = readString(input.path);
	if (path) return preparedImageFromPath(resolve(ctx.cwd, path.startsWith("@") ? path.slice(1) : path));
	const url = readString(input.url);
	if (url) return preparedImageFromUrl(url, undefined, signal);
	const base64 = readString(input.base64) ?? readString(input.data);
	const mimeType = readString(input.mimeType) ?? readString(input.mediaType);
	if (base64 && mimeType) {
		const decodedBytes = decodedBase64Size(base64);
		if (decodedBytes > MAX_IMAGE_BYTES) {
			throw new Error(`Inline base64 image is ${formatSize(decodedBytes)}, above codex_vision limit ${formatSize(MAX_IMAGE_BYTES)}.`);
		}
		const buffer = Buffer.from(base64, "base64");
		assertSupportedImage(mimeType.toLowerCase(), buffer.byteLength, "inline base64 image");
		return {
			label: "inline image",
			data: buffer.toString("base64"),
			mimeType: mimeType.toLowerCase(),
			bytes: buffer.byteLength,
			source: "inline base64",
		};
	}
	return undefined;
}

async function prepareImages(params: CodexVisionParams, ctx: ExtensionContext, signal?: AbortSignal): Promise<PreparedImage[]> {
	const directInputs = params.images ?? [];
	if (directInputs.length > MAX_IMAGES_PER_REQUEST) {
		throw new Error(`codex_vision supports at most ${MAX_IMAGES_PER_REQUEST} images per call.`);
	}
	const shouldUseLatest = !params.imageRefs?.length && !params.images?.length;
	const refs = await refsFromImageRefs(shouldUseLatest ? ["latest"] : (params.imageRefs ?? []));
	if (refs.length + directInputs.length > MAX_IMAGES_PER_REQUEST) {
		throw new Error(`codex_vision supports at most ${MAX_IMAGES_PER_REQUEST} images per call.`);
	}
	const images: PreparedImage[] = [];
	for (const ref of refs) images.push(await preparedImageFromMeta(ref, signal));
	for (const input of directInputs) {
		const prepared = await preparedImageFromDirectInput(input as Record<string, unknown>, ctx, signal);
		if (prepared) images.push(prepared);
	}
	const unique = new Map<string, PreparedImage>();
	for (const image of images) unique.set(`${image.mimeType}:${image.data.slice(0, 128)}:${image.bytes}`, image);
	const result = [...unique.values()];
	if (result.length === 0) throw new Error("codex_vision needs at least one image. Provide imageRefs, images, or attach an image to the previous prompt.");
	if (result.length > MAX_IMAGES_PER_REQUEST) throw new Error(`codex_vision supports at most ${MAX_IMAGES_PER_REQUEST} images per call.`);
	return result;
}

function createCodexVisionModel(modelId: string, baseUrl: string): Model<Api> {
	return {
		id: modelId,
		name: modelId,
		api: "openai-codex-responses" as Api,
		provider: "openai-codex",
		baseUrl,
		reasoning: true,
		thinkingLevelMap: { minimal: "low", xhigh: "xhigh" },
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
	};
}

function normalizeReasoning(value: string | undefined): SimpleStreamOptions["reasoning"] {
	if (!value) return "minimal";
	const normalized = value.toLowerCase();
	if (normalized === "off") return undefined;
	if (["minimal", "low", "medium", "high", "xhigh"].includes(normalized)) return normalized as SimpleStreamOptions["reasoning"];
	throw new Error(`Invalid codex_vision reasoning level: ${value}`);
}

async function runCodexVision(params: CodexVisionParams, images: PreparedImage[], ctx: ExtensionContext, signal?: AbortSignal): Promise<{ text: string; details: Record<string, unknown> }> {
	const auth = await getPiCodexAuth(ctx);
	const modelId = params.model?.trim() || DEFAULT_VISION_MODEL;
	const model = createCodexVisionModel(modelId, auth.baseUrl);
	const userContent = [
		{ type: "text" as const, text: params.prompt },
		...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
	];
	const stream = openAICodexResponsesApi().streamSimple(
		model,
		{
			systemPrompt:
				"You are a precise visual analysis assistant. Answer only from the supplied image(s) and the user's prompt. If uncertain, say what is uncertain.",
			messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
		},
		{
			apiKey: auth.accessToken,
			...(auth.headers ? { headers: auth.headers } : {}),
			signal,
			reasoning: normalizeReasoning(params.reasoning),
			transport: "sse",
			maxRetries: 1,
			timeoutMs: 120_000,
		},
	);
	let finalText = "";
	let usage: unknown;
	for await (const event of stream) {
		if (event.type === "done") {
			finalText = event.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
			usage = event.message.usage;
		} else if (event.type === "error") {
			throw new Error(event.error.errorMessage || "Codex vision request failed");
		}
	}
	if (!finalText) finalText = "(Codex vision returned no text.)";
	return {
		text: finalText,
		details: {
			model: modelId,
			imageCount: images.length,
			images: images.map((image) => ({ label: image.label, mimeType: image.mimeType, bytes: image.bytes, source: image.source })),
			credential: { source: auth.source ?? "Pi OpenAI Codex OAuth" },
			usage,
		},
	};
}

async function truncateToolText(text: string): Promise<{ text: string; details: Record<string, unknown> }> {
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) return { text: truncation.content, details: {} };
	const tempDir = join(IMAGE_STORE_DIR, "outputs");
	await mkdir(tempDir, { recursive: true, mode: 0o700 });
	const outputPath = join(tempDir, `vision-output-${Date.now()}-${randomUUID().slice(0, 8)}.txt`);
	await writeFile(outputPath, text, { encoding: "utf8", mode: 0o600 });
	const notice = `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${outputPath}]`;
	return { text: truncation.content + notice, details: { truncation, fullOutputPath: outputPath } };
}

const ImageInputSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Local image path, relative to the current working directory unless absolute." })),
	url: Type.Optional(Type.String({ description: "HTTP(S) image URL to fetch and inspect." })),
	ref: Type.Optional(Type.String({ description: "Saved codex_vision image ref such as img_<hash>." })),
	base64: Type.Optional(Type.String({ description: "Base64 encoded image bytes." })),
	mimeType: Type.Optional(Type.String({ description: "MIME type for base64 image bytes, e.g. image/png." })),
});

const CodexVisionParamsSchema = Type.Object({
	prompt: Type.String({ description: "Question or instructions for visual analysis." }),
	imageRefs: Type.Optional(Type.Array(Type.String({ description: "Saved refs: latest, batch:<id>, batch_<id>, or img_<hash>." }))),
	images: Type.Optional(Type.Array(ImageInputSchema)),
	model: Type.Optional(Type.String({ description: `Codex vision model override (default ${DEFAULT_VISION_MODEL}).` })),
	reasoning: Type.Optional(Type.String({ description: "Reasoning level: off, minimal, low, medium, high, or xhigh. Default minimal." })),
});

type CodexVisionParams = {
	prompt: string;
	imageRefs?: string[];
	images?: Array<Record<string, unknown>>;
	model?: string;
	reasoning?: string;
};

function modelSupportsImages(model: ExtensionContext["model"]): boolean {
	return Array.isArray(model?.input) && model.input.includes("image");
}

function activeModelSupportsImages(ctx: ExtensionContext): boolean {
	return modelSupportsImages(ctx.model);
}

function syncVisionToolForModel(pi: ExtensionAPI, model: ExtensionContext["model"]): void {
	const active = pi.getActiveTools();
	if (modelSupportsImages(model)) {
		if (active.includes(TOOL_NAME)) pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
		return;
	}
	if (!active.includes(TOOL_NAME)) pi.setActiveTools([...active, TOOL_NAME]);
}

function buildImagePromptNote(batch: StoredBatchMeta): string {
	const refs = batch.refs.join(", ");
	return [
		"",
		"[codex-vision attachment bridge]",
		`The current model is text-only, so ${batch.refs.length} attached image(s) were saved for inspection.`,
		`Before answering any image-dependent part of the user's request, call the ${TOOL_NAME} tool with:`,
		`{ "imageRefs": ["batch:${batch.id}"], "prompt": "<the user's visual question>" }`,
		`Saved image refs: ${refs}`,
	].join("\n");
}

export const __codexVisionTest = {
	MAX_IMAGE_BYTES,
	MAX_IMAGES_PER_REQUEST,
	decodedBase64Size,
	getPiCodexAuth,
	preparedImageFromDirectInput,
	prepareImages,
	preparedImageFromUrl,
	readRemoteImageBody,
};

export default function (pi: ExtensionAPI) {
	const childMode = process.env.PI_SUBAGENT_CHILD === "1";
	if (!childMode) registerSubagentToolCapability(pi);
	pi.on("session_start", (_event, ctx) => syncVisionToolForModel(pi, ctx.model));
	pi.on("model_select", (event) => syncVisionToolForModel(pi, event.model));

	if (!childMode) pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		if (activeModelSupportsImages(ctx)) return { action: "continue" };
		const attachedImages = Array.isArray(event.images) ? event.images : [];
		const fallbackPaths = attachedImages.length === 0 ? extractImageFilePathsFromText(event.text, ctx.cwd) : [];
		if (attachedImages.length === 0 && fallbackPaths.length === 0) return { action: "continue" };
		syncVisionToolForModel(pi, ctx.model);
		try {
			const batch = await storeInputImages(attachedImages, event.text, fallbackPaths);
			if (!batch) return { action: "continue" };
			return {
				action: "transform",
				text: `${event.text}${buildImagePromptNote(batch)}`,
				images: [],
			};
		} catch (error) {
			return {
				action: "transform",
				text: `${event.text}\n\n[codex-vision attachment bridge failed to save attached image(s): ${error instanceof Error ? error.message : String(error)}]`,
				images: [],
			};
		}
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Codex Vision",
		description: `Analyze image(s) through Pi's OpenAI Codex OAuth. Use when the active model cannot see images. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Analyze attached, local, or remote images through Pi's OpenAI Codex OAuth for text-only models.",
		promptGuidelines: [
			`Use ${TOOL_NAME} before answering about images when the current model has text-only input, especially local models such as ollama/glm-5.2:cloud.`,
			`This tool is auto-enabled as the default computer-vision fallback for models whose metadata does not include image input support.`,
			`Use ${TOOL_NAME} with imageRefs [\"latest\"] or the batch ref inserted by the codex-vision attachment bridge when a prompt mentions saved image refs.`,
		],
		parameters: CodexVisionParamsSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Preparing image(s) for Codex vision..." }] });
			const images = await prepareImages(params as CodexVisionParams, ctx, signal);
			onUpdate?.({ content: [{ type: "text", text: `Analyzing ${images.length} image(s) with Codex...` }] });
			const result = await runCodexVision(params as CodexVisionParams, images, ctx, signal);
			const truncated = await truncateToolText(result.text);
			return {
				content: [{ type: "text", text: truncated.text }],
				details: { ...result.details, ...truncated.details },
			};
		},
		renderCall(args, theme) {
			const prompt = typeof args.prompt === "string" ? args.prompt.slice(0, 80) : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("codex_vision"))} ${theme.fg("muted", prompt)}`, 0, 0);
		},
		renderResult(result, { isPartial, expanded }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Analyzing image(s)..."), 0, 0);
			const details = result.details as Record<string, unknown> | undefined;
			let text = theme.fg("success", `Codex vision complete`);
			if (details?.model) text += theme.fg("muted", ` (${String(details.model)})`);
			if (details?.truncation) text += theme.fg("warning", " truncated");
			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") text += `\n${theme.fg("dim", content.text.split("\n").slice(0, 24).join("\n"))}`;
			}
			return new Text(text, 0, 0);
		},
	});

	if (!childMode) pi.registerCommand("codex-vision", {
		description: "Check Pi OpenAI Codex OAuth and attachment status",
		handler: async (_args, ctx) => {
			try {
				const auth = await getPiCodexAuth(ctx);
				const latest = await findLatestBatch();
				ctx.ui.notify(
					[`Codex vision: ${auth.source ?? "Pi OpenAI Codex OAuth"} ready`, `Default model: ${DEFAULT_VISION_MODEL}`, `Image store: ${IMAGE_STORE_DIR}`, latest ? `Latest batch: ${latest.id} (${latest.refs.length} image(s))` : "Latest batch: none"].join("\n"),
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Codex vision auth error: ${formatError(error)}`, "error");
			}
		},
	});
}
