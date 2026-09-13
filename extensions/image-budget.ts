/**
 * image-budget — standalone, zero-dependency Pi extension.
 *
 * Keeps image-heavy sessions under provider request-size limits (e.g. Ollama
 * Cloud rejecting ~16 MiB bodies with "failed to read request body").
 *
 * Two layers, both running in the `context` hook before every LLM call:
 *
 * 1. Evict (always available, pure JS): image blocks older than the last
 *    KEEP_RECENT_USER_TURNS completed turns are replaced with a text marker
 *    naming the source file, so the model can `read` the full image again
 *    when it actually needs it. OpenClaw-style "compress by default,
 *    re-read full on demand".
 *
 * 2. Compress (best effort, no npm deps): oversized images are resized and
 *    re-encoded to JPEG by shelling out to the first available system tool:
 *    sips (built into macOS), ImageMagick (`magick`, or `convert` for IM6 on
 *    Unix), or ffmpeg — works on macOS, Linux, and Windows. Results are
 *    cached by content hash, so each image is encoded once, not once per
 *    turn. When no tool exists, compression is skipped silently and eviction
 *    still bounds the payload.
 *
 * Originals on disk are never modified. Session history is not rewritten —
 * the `context` event hands us a deep copy that only affects the outgoing
 * request.
 *
 * Copy this file into ~/.pi/agent/extensions/ (or .pi/extensions/ in a
 * project). No npm install, no build step.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Tunables (edit here; no config system by design — single copy-paste file)
// ---------------------------------------------------------------------------

/** Completed user turns whose images stay inline; older images are evicted. */
const KEEP_RECENT_USER_TURNS = 3;

/** Compress any remaining image larger than this many encoded bytes. */
const MAX_IMAGE_BYTES = 1024 * 1024;

/** Compress any image whose long side exceeds this many pixels. */
const MAX_IMAGE_SIDE = 1536;

/** Descending resize/quality attempts; first result under MAX_IMAGE_BYTES wins. */
const COMPRESS_LADDER: Array<{ side: number; quality: number }> = [
	{ side: 1536, quality: 75 },
	{ side: 1280, quality: 60 },
	{ side: 1024, quality: 50 },
];

const MARKER_NO_PATH = "[image omitted — already processed; re-read the source file if needed]";

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** sha256(image bytes) -> compressed block, so encoding happens once. */
const compressCache = new Map<string, { data: string; mimeType: string }>();

/** sha256(image bytes) -> source path, learned from tool results, for markers. */
const pathByHash = new Map<string, string>();

/** sha256(image bytes) -> true, to notify once per newly compressed image. */
const reportedCompressions = new Set<string>();

/** sha256(image bytes) -> true, to notify once when an image first becomes evictable. */
const reportedEvictions = new Set<string>();

let compressorName: string | null | undefined; // undefined = not probed yet

// ---------------------------------------------------------------------------
// Content-block helpers (Pi message vocabulary)
// ---------------------------------------------------------------------------

type Block = { type: string; [key: string]: unknown };
type AnyMessage = { role: string; content?: unknown; [key: string]: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blocksOf(message: AnyMessage): Block[] | null {
	const content = message.content;
	if (typeof content === "string" || !Array.isArray(content)) return null;
	return content.filter(isRecord) as Block[];
}

function imageBlocks(blocks: Block[]): Array<{ block: Block; hash: string; bytes: number }> {
	const out: Array<{ block: Block; hash: string; bytes: number }> = [];
	for (const block of blocks) {
		if (block.type !== "image" || typeof block.data !== "string") continue;
		const data = block.data;
		out.push({
			block,
			hash: createHash("sha256").update(data, "base64").digest("hex"),
			bytes: Math.floor((data.length * 3) / 4),
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// Image header sniffing (pure JS, no decode)
// ---------------------------------------------------------------------------

function sniffDimensions(
	mimeType: string | undefined,
	buf: Buffer,
): { width: number; height: number } | null {
	// PNG: IHDR width/height at bytes 16..24, big-endian.
	if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) {
		return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
	}
	// GIF: logical screen size at bytes 6..10, little-endian.
	if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49) {
		return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
	}
	// JPEG: scan segment markers for SOF0..SOF3/SOF9 etc.
	if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
		let off = 2;
		while (off + 9 < buf.length) {
			if (buf[off] !== 0xff) break;
			const marker = buf[off + 1];
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
			}
			off += 2 + buf.readUInt16BE(off + 2);
		}
	}
	void mimeType;
	return null;
}

// ---------------------------------------------------------------------------
// System-tool compressor (sips -> magick/convert -> ffmpeg; no npm deps)
// ---------------------------------------------------------------------------

const tmpRoot = join(tmpdir(), "pi-image-budget");
let tmpReady = false;

function detectCompressor(): string | null {
	if (compressorName !== undefined) return compressorName;
	compressorName = null;
	const finder = process.platform === "win32" ? "where" : "which";
	// Windows ships a FAT-to-NTFS `convert.exe` in System32, so the ImageMagick
	// 6 name is only probed on Unix; ImageMagick 7 is `magick` everywhere.
	const candidates = process.platform === "darwin"
		? ["sips", "magick", "convert", "ffmpeg"]
		: process.platform === "win32"
			? ["magick", "ffmpeg"]
			: ["magick", "convert", "ffmpeg"];
	for (const tool of candidates) {
		const probe = spawnSync(finder, [tool], { encoding: "utf8" });
		if (probe.status === 0 && (probe.stdout ?? "").trim().length > 0) {
			compressorName = tool;
			break;
		}
	}
	return compressorName;
}

function extForMime(mimeType: string | undefined): string {
	const m = (mimeType ?? "").toLowerCase();
	if (m.includes("jpeg")) return "jpg";
	if (m.includes("gif")) return "gif";
	if (m.includes("webp")) return "webp";
	return "png";
}

function runCompress(
	tool: string,
	inPath: string,
	outPath: string,
	side: number,
	quality: number,
): boolean {
	let result: ReturnType<typeof spawnSync>;
	if (tool === "sips") {
		result = spawnSync("sips", [
			"-s", "format", "jpeg",
			"-s", "formatOptions", String(quality),
			"--resampleHeightWidthMax", String(side), String(side),
			inPath, "--out", outPath,
		]);
	} else if (tool === "magick" || tool === "convert") {
		result = spawnSync(tool, [
			inPath, "-auto-orient",
			"-resize", `${side}x${side}>`,
			"-quality", String(quality),
			outPath,
		]);
	} else {
		// ffmpeg qscale: 2 = best, 31 = worst. Map percent quality linearly
		// (100 -> 2, 40 -> ~10) instead of passing the percent directly.
		const qscale = Math.max(2, Math.min(31, Math.round(2 + ((100 - quality) * 8) / 60)));
		result = spawnSync("ffmpeg", [
			"-y", "-i", inPath,
			"-vf", `scale='min(${side},iw)':'min(${side},ih)':force_original_aspect_ratio=decrease`,
			"-q:v", String(qscale),
			outPath,
		]);
	}
	return result.status === 0 && existsSync(outPath);
}

export function compressImage(
	hash: string,
	data: string,
	mimeType: string | undefined,
): { data: string; mimeType: string } | null {
	const cached = compressCache.get(hash);
	if (cached) return cached;

	const tool = detectCompressor();
	if (!tool) return null; // no system tool: eviction alone still bounds the payload

	// Never touch GIFs (animation would be lost); eviction covers their size.
	if ((mimeType ?? "").toLowerCase().includes("gif")) return null;

	if (!tmpReady) {
		try {
			mkdirSync(tmpRoot, { recursive: true });
			tmpReady = true;
		} catch {
			return null;
		}
	}

	const buf = Buffer.from(data, "base64");
	const dims = sniffDimensions(mimeType, buf);
	const overSide = dims !== null && Math.max(dims.width, dims.height) > MAX_IMAGE_SIDE;
	if (buf.length <= MAX_IMAGE_BYTES && !overSide) return null;

	const ext = extForMime(mimeType);
	const inPath = join(tmpRoot, `${hash.slice(0, 16)}-in.${ext}`);
	try {
		writeFileSync(inPath, buf);
		for (const step of COMPRESS_LADDER) {
			const outPath = join(tmpRoot, `${hash.slice(0, 16)}-out.jpg`);
			if (!runCompress(tool, inPath, outPath, step.side, step.quality)) continue;
			try {
				const outBuf = readFileSync(outPath);
				if (outBuf.length >= buf.length) continue; // no gain; try lower step
				const compressed = { data: outBuf.toString("base64"), mimeType: "image/jpeg" };
				compressCache.set(hash, compressed);
				return compressed;
			}
			catch {
				continue; // unreadable output; try the next ladder step
			}
		}
	} catch {
		return null;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Eviction (turn tracking, OpenClaw-style)
// ---------------------------------------------------------------------------

function markerFor(hash: string): string {
	const path = pathByHash.get(hash);
	return path
		? `[image omitted — already processed; source: ${path} (use the read tool to view again)]`
		: MARKER_NO_PATH;
}

/**
 * Replace image blocks outside the recent-turn window with text markers.
 * Returns the transformed messages, count, and hashes used for notification deduplication.
 */
export function evictOldImages(messages: AnyMessage[]): {
	messages: AnyMessage[];
	evicted: number;
	evictedHashes: Set<string>;
} {
	const evictedHashes = new Set<string>();
	const userIdx: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i]?.role === "user") userIdx.push(i);
	}
	if (userIdx.length === 0) return { messages, evicted: 0, evictedHashes };

	const lastUser = userIdx[userIdx.length - 1];
	const window = new Set(userIdx.slice(Math.max(0, userIdx.length - KEEP_RECENT_USER_TURNS)));
	// Turn ownership: a user message owns itself; a toolResult belongs to the
	// latest user message at or before it. Messages after the final user message
	// are the active turn and are never evicted.

	let evicted = 0;
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!isRecord(msg)) continue;
		if (msg.role !== "user" && msg.role !== "toolResult") continue;
		if (i > lastUser) continue; // active turn

		let ownerIdx: number;
		if (msg.role === "user") {
			ownerIdx = i;
		} else {
			ownerIdx = -1;
			for (const idx of userIdx) {
				if (idx <= i) ownerIdx = idx;
				else break;
			}
		}
		if (ownerIdx >= 0 && window.has(ownerIdx)) continue;

		const blocks = blocksOf(msg);
		if (!blocks) continue;
		let changed = false;
		const next = blocks.map((block) => {
			if (block.type !== "image" || typeof block.data !== "string") return block;
			evicted++;
			changed = true;
			const hash = createHash("sha256").update(block.data, "base64").digest("hex");
			evictedHashes.add(hash);
			return { type: "text", text: markerFor(hash) } as Block;
		});
		if (changed) msg.content = next;
	}
	return { messages, evicted, evictedHashes };
}

// ---------------------------------------------------------------------------
// Size estimation
// ---------------------------------------------------------------------------

export function estimateRequestBytes(messages: AnyMessage[]): number {
	// Approximation: serialized JSON length of the message array, used only
	// for the status line. It never gates behavior.
	try {
		return Buffer.byteLength(JSON.stringify(messages), "utf8");
	} catch {
		return 0;
	}
}

function fmtMiB(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function imageBudget(pi: ExtensionAPI) {
	// Learn source paths so eviction markers can name the file to re-read.
	// `tool_execution_end` carries no args, so pair them via toolCallId from start.
	const argsByCallId = new Map<string, Record<string, unknown>>();
	pi.on("tool_execution_start", (event) => {
		if (isRecord(event.args)) argsByCallId.set(event.toolCallId, event.args);
	});
	pi.on("tool_execution_end", (event) => {
		const args = argsByCallId.get(event.toolCallId);
		argsByCallId.delete(event.toolCallId);
		if (event.isError) return;
		const explicitPath = typeof args?.path === "string" ? args.path : undefined;
		const result = isRecord(event.result) ? event.result : undefined;
		const content = Array.isArray(result?.content) ? (result!.content as unknown[]) : [];
		for (const item of content) {
			if (!isRecord(item)) continue;
			if (item.type === "image" && typeof item.data === "string" && explicitPath) {
				const hash = createHash("sha256").update(item.data, "base64").digest("hex");
				pathByHash.set(hash, explicitPath);
			}
		}
	});

	pi.on("context", async (event, ctx: ExtensionContext) => {
		const messages = event.messages as unknown as AnyMessage[];
		if (!Array.isArray(messages) || messages.length === 0) return;

		// Layer 2: compress remaining oversized images (cached per content hash).
		let compressedCount = 0;
		let compressedBeforeBytes = 0;
		let compressedAfterBytes = 0;
		let hasNewlyReportedWork = false;
		for (const msg of messages) {
			if (!isRecord(msg) || !Array.isArray(msg.content)) continue;
			if (msg.role !== "user" && msg.role !== "toolResult" && msg.role !== "assistant") continue;
			for (let b = 0; b < msg.content.length; b++) {
				const block = msg.content[b];
				if (block?.type !== "image" || typeof block.data !== "string") continue;
				const hash = createHash("sha256").update(block.data, "base64").digest("hex");
				const before = Math.floor((block.data.length * 3) / 4);
				const out = compressImage(hash, block.data, block.mimeType as string | undefined);
				if (out) {
					// Write back to the real content array — blocksOf() copies.
					msg.content[b] = { ...block, data: out.data, mimeType: out.mimeType };
					compressedCount++;
					compressedBeforeBytes += before;
					compressedAfterBytes += Math.floor((out.data.length * 3) / 4);
					if (!reportedCompressions.has(hash)) {
						reportedCompressions.add(hash);
						hasNewlyReportedWork = true;
						const via = detectCompressor();
						ctx.ui.notify(
							`image-budget: compressed an image ${fmtMiB(before)} -> ${fmtMiB(Buffer.byteLength(out.data, "base64"))} (via ${via}); originals on disk are untouched`,
							"info",
						);
					}
				}
			}
		}

		// Layer 1: evict images older than the recent-turn window.
		const { evicted, evictedHashes } = evictOldImages(messages);
		for (const hash of evictedHashes) {
			if (reportedEvictions.has(hash)) continue;
			reportedEvictions.add(hash);
			hasNewlyReportedWork = true;
		}
		const size = estimateRequestBytes(messages);

		if (hasNewlyReportedWork) {
			// Report newly encountered image work once, not on every context rebuild.
			ctx.ui.notify(
				`image-budget: evicted ${evicted}; compressed ${compressedCount} ${compressedCount === 1 ? "image" : "images"}: ${fmtMiB(compressedBeforeBytes)} -> ${fmtMiB(compressedAfterBytes)}, saved ${fmtMiB(compressedBeforeBytes - compressedAfterBytes)}; request approx ${fmtMiB(size)}`,
				"info",
			);
		}

		return { messages: event.messages };
	});
}