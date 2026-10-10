/**
 * Segmented (multi-connection) download.
 *
 * Modelled on gopeed's `internal/protocol/http/fetcher.go`: instead of splitting
 * the file into fixed equal parts, every connection owns a chunk and, when it
 * finishes, **steals the tail half of the chunk with the most work left**. That
 * is what keeps a slow server from holding up the whole transfer — a static
 * split is only as fast as its slowest connection.
 *
 * Everything here is opt-in: the caller falls back to a single stream whenever
 * the server does not advertise byte ranges, the resource is too small for
 * threads to pay off, or a range response turns out to be unusable.
 * @module dsh-downloader/segmented
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { httpFlow } from "./http.js";
import { humanSize } from "./util.js";

/** Smallest slice worth a separate request (gopeed's `stealMinChunkSize`). */
export const STEAL_MIN_BYTES = 512 * 1024;

/** Below this, one connection is faster than the coordination overhead. */
export const SEGMENT_MIN_TOTAL = 1024 * 1024;

/** Raised when the segmented attempt cannot proceed and the caller must retry single-stream. */
export class RangeUnusableError extends Error {
	constructor(message) {
		super(message);
		this.name = "RangeUnusableError";
	}
}

/** True when the response advertises byte-range support. */
export function supportsRanges(status, headers) {
	if (status === 206) return true;
	const accept = String(headers?.["accept-ranges"] ?? "").toLowerCase();
	return accept.includes("bytes");
}

/**
 * Parse a `Content-Range: bytes start-end/total` header.
 * @returns `{ start, end, total }`; `total` is null for `*`.
 */
export function parseContentRange(value) {
	const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value ?? "").trim());
	if (match === null) return null;
	return {
		start: Number.parseInt(match[1], 10),
		end: Number.parseInt(match[2], 10),
		total: match[3] === "*" ? null : Number.parseInt(match[3], 10)
	};
}

/** Split `total` into up to `threads` starting chunks. */
export function planChunks(total, threads) {
	const count = Math.max(1, Math.min(Number(threads) || 1, Math.max(1, Math.floor(total / STEAL_MIN_BYTES))));
	const size = Math.ceil(total / count);
	const chunks = [];
	for (let begin = 0; begin < total; begin += size) {
		chunks.push({ begin, end: Math.min(begin + size, total) - 1 });
	}
	return chunks;
}

/**
 * Take the next slice of work.
 *
 * Picks the chunk with the most bytes left and cuts **half of it** off, so a
 * worker that just finished keeps pulling its weight while a slow one still
 * makes progress. A chunk smaller than two steal-minimums is handed over whole.
 * @returns `{ begin, end }` or null when everything is claimed.
 */
export function stealSlice(chunks) {
	let best = null;
	for (const chunk of chunks) {
		const remain = chunk.end - chunk.begin + 1;
		if (remain <= 0) continue;
		if (best === null || remain > best.end - best.begin + 1) best = chunk;
	}
	if (best === null) return null;
	const remain = best.end - best.begin + 1;
	const take = remain >= 2 * STEAL_MIN_BYTES ? Math.floor(remain / 2) : remain;
	const slice = { begin: best.begin, end: best.begin + take - 1 };
	best.begin += take;
	return slice;
}

/** Bytes still unclaimed across every chunk. */
export function remainingBytes(chunks) {
	let total = 0;
	for (const chunk of chunks) total += Math.max(0, chunk.end - chunk.begin + 1);
	return total;
}

/**
 * Write a whole buffer at an absolute offset.
 *
 * `fs.promises.FileHandle.write` is promise-only — passing it a callback the way
 * `fs.write` takes one silently ignores the callback and the promise never
 * settles (which hangs the whole download).
 */
async function writeAt(handle, buffer, offset) {
	const { bytesWritten } = await handle.write(buffer, 0, buffer.length, offset);
	if (bytesWritten !== buffer.length) {
		throw new Error(`写入不完整：偏移 ${offset} 期望 ${buffer.length} 字节，实际 ${bytesWritten}`);
	}
}

/**
 * Fetch one slice into the file at its absolute offset.
 * @throws {RangeUnusableError} when the response is not the requested 206.
 */
async function fetchSlice(slice, handle, context) {
	const { url, proxy, insecure, maxRedirects, validator, timeoutMs, controller, bump, headers } = context;
	const requestHeaders = { ...(headers ?? {}), range: `bytes=${slice.begin}-${slice.end}` };
	if (validator !== null) requestHeaders["if-range"] = validator;

	const flow = await httpFlow(url, {
		proxy,
		headers: requestHeaders,
		insecure,
		maxRedirects,
		timeoutMs,
		signal: controller.signal
	});
	if (flow.status !== 206) {
		try {
			flow.res.resume();
			flow.abort();
		} catch {
			/* already gone */
		}
		throw new RangeUnusableError(`服务端对 Range 请求返回了 HTTP ${flow.status}`);
	}
	const range = parseContentRange(flow.headers["content-range"]);
	if (range === null) {
		flow.res.resume();
		flow.abort();
		throw new RangeUnusableError("Range 响应缺少合法的 Content-Range");
	}
	if (range.start !== slice.begin) {
		flow.res.resume();
		flow.abort();
		throw new RangeUnusableError(`Range 响应起点不符：请求 ${slice.begin}，返回 ${range.start}`);
	}

	let offset = slice.begin;
	let pending = Promise.resolve();
	await new Promise((resolve, reject) => {
		let settled = false;
		const fail = (error) => {
			if (settled) return;
			settled = true;
			try {
				flow.res.destroy();
			} catch {
				/* already gone */
			}
			reject(error);
		};
		flow.res.on("data", (chunk) => {
			if (settled) return;
			// Positional writes let every worker share one file descriptor.
			pending = pending.then(() => {
				if (settled) return undefined;
				return writeAt(handle, chunk, offset).then(() => {
					offset += chunk.length;
					bump(chunk.length);
				});
			}).catch(fail);
		});
		flow.res.once("end", () => {
			pending.then(() => {
				if (settled) return;
				settled = true;
				resolve();
			}, fail);
		});
		flow.res.once("error", fail);
	});
	return offset - slice.begin;
}

/**
 * Download `url` into `handle` using several connections.
 *
 * @param options - target, an open file handle, size, thread count and the same
 * transport knobs the single-stream path takes.
 * @returns `{ bytes, sha256, segments }`.
 * @throws {RangeUnusableError} when the segmented path cannot be used.
 */
export async function downloadSegmented(options) {
	const {
		url,
		handle,
		totalBytes,
		threads = 4,
		proxy = null,
		insecure = false,
		maxRedirects = 10,
		timeoutMs = 20000,
		stallMs = 30000,
		maxBytes = 512 * 1024 * 1024,
		signal = null,
		validator = null,
		headers = null,
		onProgress = null
	} = options;

	if (totalBytes > maxBytes) {
		throw new Error(`服务端声明大小 ${humanSize(totalBytes)}，超过配置上限（${humanSize(maxBytes)}）；提高 max_mb 后重试`);
	}

	const chunks = planChunks(totalBytes, threads);
	const controller = new AbortController();
	const forwardAbort = () => controller.abort(new Error("下载已取消"));
	if (signal !== null && signal !== undefined) {
		if (signal.aborted) throw new Error("下载已取消");
		signal.addEventListener("abort", forwardAbort, { once: true });
	}

	let written = 0;
	let lastTick = Date.now();
	let failure = null;
	const context = {
		url, proxy, insecure, maxRedirects, validator, timeoutMs, controller, headers,
		bump: (bytes) => {
			written += bytes;
			lastTick = Date.now();
			onProgress?.(written);
		}
	};

	const stallWatch = setInterval(() => {
		if (failure === null && Date.now() - lastTick > stallMs) {
			failure = new Error(`下载停滞：已 ${Math.round(stallMs / 1000)} 秒没有收到数据`);
			controller.abort(failure);
		}
	}, 1000);

	try {
		const workerCount = Math.max(1, Math.min(Number(threads) || 1, chunks.length));
		const workers = [];
		for (let index = 0; index < workerCount; index += 1) {
			workers.push((async () => {
				for (;;) {
					if (failure !== null) return;
					const slice = stealSlice(chunks);
					if (slice === null) return;
					await fetchSlice(slice, handle, context);
				}
			})());
		}
		await Promise.all(workers);
		if (failure !== null) throw failure;

		const shortfall = totalBytes - written;
		if (shortfall !== 0) throw new RangeUnusableError(`分片合计 ${written} 字节，与声明大小 ${totalBytes} 不符`);
	} catch (error) {
		if (failure !== null) throw failure;
		throw error;
	} finally {
		clearInterval(stallWatch);
		signal?.removeEventListener("abort", forwardAbort);
	}

	// Hash after the merge: sha256 must cover the file in order, and the workers
	// write out of order.
	const hash = createHash("sha256");
	await new Promise((resolve, reject) => {
		const reader = handle.createReadStream({ autoClose: false, start: 0 });
		reader.on("data", (chunk) => hash.update(chunk));
		reader.once("error", reject);
		reader.once("end", resolve);
	});

	return { bytes: written, sha256: hash.digest("hex"), segments: chunks.length };
}
