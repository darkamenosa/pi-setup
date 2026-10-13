import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";

import {
	convertToPng,
	detectSupportedImageMimeTypeFromFile,
	getAgentDir,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "codex_image";
const CODEX_PROVIDER_ID = "openai-codex";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
// Mirror codex-rs/ext/image-generation/src/tool.rs, not the Responses image tool.
const IMAGE_MODEL = "gpt-image-2";
const MAX_EDIT_IMAGES = 5;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface ImageParams {
	prompt: string;
	images?: string[];
	output?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function accountIdFromAccessToken(token: string): string {
	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
	} catch {
		// Report the missing claim below without exposing the credential.
	}
	const claim = isRecord(payload) ? payload["https://api.openai.com/auth"] : undefined;
	const accountId = isRecord(claim) ? readString(claim.chatgpt_account_id) : undefined;
	if (!accountId) throw new Error("Pi OpenAI Codex OAuth token has no ChatGPT account id. Run /login openai-codex, then retry.");
	return accountId;
}

function codexBackendUrl(baseUrl: string, operation: "generations" | "edits"): string {
	const base = baseUrl.replace(/\/+$/, "");
	return `${base.endsWith("/codex") ? base : `${base}/codex`}/images/${operation}`;
}

function resolveImagePath(path: string, cwd: string): string {
	const normalized = path.replace(/^@/, "");
	if (!normalized.trim()) throw new Error("Image path must not be empty.");
	return resolve(cwd, normalized.startsWith("~/") ? join(homedir(), normalized.slice(2)) : normalized);
}

function imageOutputPath(params: ImageParams, cwd: string, sessionId: string): string {
	if (params.output !== undefined) {
		const path = resolveImagePath(params.output, cwd);
		if (extname(path).toLowerCase() !== ".png") throw new Error("output must be a .png file path.");
		return path;
	}
	// Same session-scoped artifact layout and sanitization as Codex's artifact.rs.
	const session = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "generated_image";
	return resolve(getAgentDir(), "codex-image", "outputs", session, `${randomUUID()}.png`);
}

async function imageUrl(path: string, cwd: string, signal?: AbortSignal): Promise<{ image_url: string }> {
	signal?.throwIfAborted();
	const absolutePath = resolveImagePath(path, cwd);
	if (!(await stat(absolutePath)).isFile()) throw new Error(`Reference image is not a file: ${absolutePath}`);
	const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
	if (!mimeType) throw new Error(`Unsupported reference image: ${absolutePath}. Use PNG, JPEG, WebP, GIF, or BMP.`);
	const bytes = await readFile(absolutePath, { signal });
	let image: { data: string; mimeType: string } = { data: bytes.toString("base64"), mimeType };
	// Like Codex's PromptImageMode::Original: retain PNG/JPEG/WebP; convert other formats.
	if (mimeType === "image/gif" || mimeType === "image/bmp") {
		const png = await convertToPng(image.data, mimeType);
		if (!png) throw new Error(`Unable to convert reference image to PNG: ${absolutePath}`);
		image = png;
	}
	signal?.throwIfAborted();
	return { image_url: `data:${image.mimeType};base64,${image.data}` };
}

function decodeImage(body: unknown): Buffer {
	const first = isRecord(body) && Array.isArray(body.data) ? body.data[0] : undefined;
	const encoded = isRecord(first) ? readString(first.b64_json) : undefined;
	if (!encoded) throw new Error("Codex image response contains no image data.");
	const bytes = Buffer.from(encoded, "base64");
	// Node's base64 decoder silently ignores malformed input; Codex's decoder rejects it.
	if (bytes.toString("base64") !== encoded) throw new Error("Codex image response contains invalid base64.");
	if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
		throw new Error("Codex image response is not a PNG.");
	}
	return bytes;
}

function imageHttpError(response: Response, body: unknown): Error {
	const record = isRecord(body) ? body : {};
	const error = isRecord(record.error) ? record.error : record;
	const code = (readString(error.code) ?? readString(error.type))?.slice(0, 100);
	const message = readString(error.message)?.slice(0, 800);
	const retryAfter = response.headers.get("retry-after")?.slice(0, 100);
	return new Error([
		`Codex image request failed (${response.status})${code ? ` [${code}]` : ""}.`,
		message,
		response.status === 401 ? "Run /login openai-codex, then retry." : undefined,
		retryAfter ? `Retry-After: ${retryAfter}.` : undefined,
	].filter(Boolean).join(" "));
}

async function requestImage(params: ImageParams, ctx: ExtensionContext, turnId: string, signal?: AbortSignal) {
	signal?.throwIfAborted();
	// Pi owns credential storage, refresh, and concurrent refresh coordination, as in codex-search.ts.
	let resolved;
	try {
		resolved = await ctx.modelRegistry.getProviderAuth(CODEX_PROVIDER_ID);
	} catch {
		signal?.throwIfAborted();
		throw new Error("Pi OpenAI Codex OAuth failed. Run /login openai-codex, then retry.");
	}
	const accessToken = readString(resolved?.auth.apiKey);
	if (!accessToken) throw new Error("Pi OpenAI Codex OAuth is not configured. Run /login openai-codex, then retry.");
	const headers = new Headers();
	for (const [name, value] of Object.entries(resolved?.auth.headers ?? {})) {
		if (value !== null) headers.set(name, value);
	}
	headers.set("Authorization", `Bearer ${accessToken}`);
	headers.set("ChatGPT-Account-ID", accountIdFromAccessToken(accessToken));
	headers.set("originator", "pi");
	headers.set("User-Agent", `pi-codex-image (${process.platform}; ${process.arch})`);
	headers.set("Accept", "application/json");
	headers.set("Content-Type", "application/json");
	headers.set("x-codex-image-turn-id", turnId);

	const images = [];
	for (const path of params.images ?? []) images.push(await imageUrl(path, ctx.cwd, signal));
	const operation = images.length ? "edits" : "generations";
	const body = {
		prompt: params.prompt,
		background: "auto",
		model: IMAGE_MODEL,
		quality: "auto",
		size: "auto",
		...(images.length ? { images } : {}),
	};
	signal?.throwIfAborted();
	// No automatic retry: a disconnected generation may still consume image quota.
	// No search-style 60-second deadline: Codex documents that images can take minutes.
	const response = await fetch(codexBackendUrl(readString(resolved?.auth.baseUrl) ?? DEFAULT_CODEX_BASE_URL, operation), {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal,
	});
	let result: unknown;
	try {
		result = await response.json();
	} catch {
		signal?.throwIfAborted();
		if (!response.ok) throw imageHttpError(response, undefined);
		throw new Error("Codex image endpoint returned a non-JSON response.");
	}
	signal?.throwIfAborted();
	if (!response.ok) throw imageHttpError(response, result);
	return {
		bytes: decodeImage(result),
		operation,
		requestId: response.headers.get("x-codex-imagegen-request-id")?.slice(0, 200) ?? undefined,
	};
}

export const __codexImageTest = { accountIdFromAccessToken, codexBackendUrl, decodeImage, imageOutputPath };

export default function codexImage(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Codex Image",
		description: "Generate or edit one image with gpt-image-2 through Pi's OpenAI Codex OAuth. Saves a PNG and returns its absolute path, not inline image data. Generation can take several minutes.",
		promptSnippet: "Generate or edit images through Pi's OpenAI Codex OAuth and save PNG files.",
		promptGuidelines: [
			"Use codex_image for requested image generation or editing. Omit images for a new image; provide explicit local paths for edits (up to five).",
			"Inspect reference images before editing with codex_image, using read for image-capable models or codex_vision for text-only models. Ask for a saved file path if a reference has no local path.",
			"codex_image saves a PNG without overwriting existing files. Use its returned path for inspection or subsequent edits; do not claim to have seen the image from the path alone.",
			"Do not automatically repeat a failed codex_image request: a disconnected request may still consume image quota. Do not silently switch models or authentication providers.",
		],
		parameters: Type.Object({
			prompt: Type.String({ minLength: 1, description: "Description of the image to generate, or changes to make to the reference images." }),
			images: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: MAX_EDIT_IMAGES, description: "Local reference image paths for editing. Relative paths resolve from the current project. PNG, JPEG, WebP, GIF, and BMP are supported." })),
			output: Type.Optional(Type.String({ minLength: 1, description: "Optional .png destination, relative to the current project or absolute. Must not already exist. Default: ~/.pi/agent/codex-image/outputs/<session-id>/<uuid>.png." })),
		}),
		async execute(toolCallId, params: ImageParams, signal, onUpdate, ctx) {
			if (!params.prompt.trim()) throw new Error("prompt must not be empty.");
			if ((params.images?.length ?? 0) > MAX_EDIT_IMAGES) throw new Error(`images must contain at most ${MAX_EDIT_IMAGES} paths.`);
			const output = imageOutputPath(params, ctx.cwd, ctx.sessionManager.getSessionId());
			return withFileMutationQueue(output, async () => {
				signal?.throwIfAborted();
				// Reject even dangling symlinks. Exclusive creation below also fences other Pi processes.
				const existing = await lstat(output).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
					return undefined;
				});
				if (existing) throw new Error(`Output already exists; choose another path: ${output}`);
				await mkdir(dirname(output), { recursive: true, mode: 0o700 });
				onUpdate?.({ content: [{ type: "text", text: "Generating image with Codex; this may take a few minutes..." }] });
				const result = await requestImage(params, ctx, ctx.sessionManager.getLeafId() ?? toolCallId, signal);
				signal?.throwIfAborted();
				await writeFile(output, result.bytes, { flag: "wx", mode: 0o600 });
				return {
					content: [{ type: "text", text: `Saved image: ${output}` }],
					details: {
						path: output,
						model: IMAGE_MODEL,
						operation: result.operation,
						bytes: result.bytes.length,
						...(result.requestId ? { requestId: result.requestId } : {}),
					},
				};
			});
		},
	});
}
