/**
 * Streaming file download with integrity, limits, and cancellation.
 *
 * Invariants:
 * - the target file only ever appears complete (written to `<target>.part`,
 *   then renamed);
 * - **every** failure path removes the `.part` file;
 * - the byte count is capped while streaming, so a wrong URL cannot fill a disk.
 * @module dsh-downloader/fetch-file
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { httpFlow, readBody } from "./http.js";
import { humanSize } from "./util.js";
import { RangeUnusableError, SEGMENT_MIN_TOTAL, downloadSegmented, supportsRanges } from "./segmented.js";

/** Raised for a non-2xx response, carrying the status for callers that retry. */
export class HttpStatusError extends Error {
	constructor(message, status, url) {
		super(message);
		this.name = "HttpStatusError";
		this.status = status;
		this.url = url;
	}
}

/** Stream a response body into `partPath`, hashing and capping as it goes. */
function streamToFile(flow, partPath, { maxBytes, stallMs, signal, onProgress }) {
	const hash = createHash("sha256");
	let written = 0;
	let lastTick = Date.now();
	const sink = fs.createWriteStream(partPath);

	return new Promise((resolve, reject) => {
		let failure = null;
		const cleanup = () => {
			clearInterval(stallWatch);
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error) => {
			if (failure === null) failure = error instanceof Error ? error : new Error(String(error));
			try {
				flow.res.destroy();
			} catch {
				/* already gone */
			}
			try {
				sink.destroy();
			} catch {
				/* already gone */
			}
		};
		const onAbort = () => fail(new Error("下载已取消"));
		const stallWatch = setInterval(() => {
			if (Date.now() - lastTick > stallMs) fail(new Error(`下载停滞：已 ${Math.round(stallMs / 1000)} 秒没有收到数据`));
		}, 1000);

		if (signal !== null && signal !== undefined) {
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		flow.res.on("data", (chunk) => {
			if (failure !== null) return;
			written += chunk.length;
			lastTick = Date.now();
			if (written > maxBytes) {
				fail(new Error(`文件超过配置的大小上限（${humanSize(maxBytes)}）；确认文件大小后可提高 max_mb`));
				return;
			}
			hash.update(chunk);
			onProgress?.(written);
			if (!sink.write(chunk)) flow.res.pause();
		});
		sink.on("drain", () => flow.res.resume());
		flow.res.once("end", () => sink.end());
		flow.res.once("error", (error) => fail(error));
		sink.once("error", (error) => fail(error));
		sink.once("close", () => {
			cleanup();
			if (failure !== null) reject(failure);
			else resolve({ bytes: written, sha256: hash.digest("hex") });
		});
	});
}

/** One plain GET streamed into `partPath`; used when the probe body is gone. */
async function attemptSingleStream({ url, partPath, proxy, insecure, maxRedirects, maxBytes, stallMs, signal, onEvent }) {
	const flow = await httpFlow(url, { proxy, insecure, maxRedirects, timeoutMs: 20000, signal });
	if (flow.status >= 400) {
		let snippet = "";
		try {
			snippet = (await readBody(flow, 16 * 1024)).slice(0, 200).replace(/\s+/g, " ");
		} catch {
			/* body already consumed or torn down */
		}
		throw new HttpStatusError(
			`HTTP ${flow.status}${flow.statusMessage ? ` ${flow.statusMessage}` : ""} @ ${flow.url}${snippet ? ` | ${snippet}` : ""}`,
			flow.status,
			flow.url
		);
	}
	const declared = Number(flow.headers["content-length"]);
	if (Number.isFinite(declared) && declared > maxBytes) {
		flow.res.resume();
		flow.abort();
		throw new Error(`服务端声明大小 ${humanSize(declared)}，超过配置上限（${humanSize(maxBytes)}）；提高 max_mb 后重试`);
	}
	const streamed = await streamToFile(flow, partPath, {
		maxBytes,
		stallMs,
		signal,
		onProgress: (bytes) => onEvent?.({ kind: "progress", bytes })
	});
	return {
		...streamed,
		http: {
			status: flow.status,
			redirects: flow.redirects,
			content_length: Number.isFinite(declared) ? declared : null,
			content_type: flow.headers["content-type"] ?? null
		},
		finalUrl: flow.url
	};
}

/**
 * Try the multi-connection path.
 *
 * Returns null (never throws) whenever the segmented attempt is not applicable
 * or turned out to be unusable, so the caller can fall back to one stream. The
 * probe response is discarded: a range request is issued per slice instead, so
 * a server that lies about `Accept-Ranges` costs one wasted request, not a
 * corrupt file.
 */
async function trySegmented(flow, options, context) {
	const { partPath, maxBytes, threads, signal, onEvent, stallMs, onConsume } = context;
	const declaredLength = Number(flow.headers["content-length"]);
	if (threads <= 1) return null;
	if (!Number.isFinite(declaredLength) || declaredLength < SEGMENT_MIN_TOTAL) return null;
	if (!supportsRanges(flow.status, flow.headers)) return null;
	if (declaredLength > maxBytes) return null; // the single-stream path raises the proper error

	// Only headers were needed; drop the body before opening our own requests.
	try {
		flow.res.resume();
		flow.abort();
	} catch {
		/* already gone */
	}
	onConsume();

	const validator = flow.headers.etag ?? flow.headers["last-modified"] ?? null;
	const handle = await fs.promises.open(partPath, "w+");
	try {
		onEvent?.({ kind: "segments", threads, bytes: declaredLength });
		return await downloadSegmented({
			url: flow.url,
			handle,
			totalBytes: declaredLength,
			threads,
			proxy: options.proxy,
			insecure: options.insecure,
			maxRedirects: options.maxRedirects,
			timeoutMs: options.timeoutMs,
			stallMs,
			maxBytes,
			signal,
			validator,
			onProgress: (bytes) => onEvent?.({ kind: "progress", bytes })
		});
	} finally {
		await handle.close().catch(() => {});
	}
}

/**
 * Perform exactly one download attempt through an explicit proxy (or directly).
 *
 * @param options - target, destination, proxy, limits, and cancellation.
 * @returns the attempt result; the caller owns route reporting.
 * @throws {HttpStatusError} on a non-2xx response.
 */
export async function attemptDownload(options) {
	const {
		url,
		savePath,
		overwrite = false,
		proxy = null,
		maxBytes = 512 * 1024 * 1024,
		timeoutS = 600,
		stallS = 30,
		threads = 1,
		insecure = false,
		maxRedirects = 10,
		signal = null,
		onEvent = null
	} = options;

	if (fs.existsSync(savePath) && !overwrite) {
		const stats = fs.statSync(savePath);
		if (stats.isDirectory()) throw new Error(`目标是目录，不是文件：${savePath}`);
		throw new Error(`目标文件已存在：${savePath}（${humanSize(stats.size)}）；加 overwrite=true 覆盖，或换一个 save_path`);
	}

	fs.mkdirSync(path.dirname(savePath), { recursive: true });
	const partPath = `${savePath}.part`;
	const started = Date.now();
	const controller = new AbortController();
	const forwardAbort = () => controller.abort(new Error("下载已取消"));
	if (signal !== null && signal !== undefined) {
		if (signal.aborted) throw new Error("下载已取消");
		signal.addEventListener("abort", forwardAbort, { once: true });
	}
	const deadline = setTimeout(
		() => controller.abort(new Error(`下载超过 ${timeoutS} 秒预算；大文件请提高 timeout_seconds`)),
		Math.max(1, timeoutS) * 1000
	);

	let flow = null;
	try {
		flow = await httpFlow(url, {
			proxy,
			timeoutMs: 20000,
			signal: controller.signal,
			insecure,
			maxRedirects,
			onHop: (hop) => onEvent?.({ kind: "redirect", ...hop })
		});
		if (flow.status >= 400) {
			let snippet = "";
			try {
				snippet = (await readBody(flow, 16 * 1024)).slice(0, 200).replace(/\s+/g, " ");
			} catch {
				/* body already consumed or torn down */
			}
			throw new HttpStatusError(
				`HTTP ${flow.status}${flow.statusMessage ? ` ${flow.statusMessage}` : ""} @ ${flow.url}${snippet ? ` | ${snippet}` : ""}`,
				flow.status,
				flow.url
			);
		}

		const declaredLength = Number(flow.headers["content-length"]);
		if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
			flow.res.resume();
			flow.abort();
			throw new Error(
				`服务端声明大小 ${humanSize(declaredLength)}，超过配置上限（${humanSize(maxBytes)}）；提高 max_mb 后重试`
			);
		}

		let probeConsumed = false;
		const streamed = await (async () => {
			try {
				const segmented = await trySegmented(flow, { url, proxy, insecure, maxRedirects, timeoutMs: 20000 }, {
					partPath,
					maxBytes,
					threads,
					signal: controller.signal,
					onEvent,
					stallMs: Math.max(1, stallS) * 1000,
					onConsume: () => { probeConsumed = true; }
				});
				if (segmented !== null) return { ...segmented, viaThreads: true };
			} catch (error) {
				// A range problem must never lose the download: redo it on one stream.
				if (!(error instanceof RangeUnusableError)) throw error;
				onEvent?.({ kind: "fallback", reason: `分片下载不可用（${error.message}），改用单连接` });
			}
			if (!probeConsumed) {
				return {
					...(await streamToFile(flow, partPath, {
						maxBytes,
						stallMs: Math.max(1, stallS) * 1000,
						signal: controller.signal,
						onProgress: (bytes) => onEvent?.({ kind: "progress", bytes })
					})),
					viaThreads: false
				};
			}
			// The probe body was consumed, so the single-stream retry needs its own request.
			const retried = await attemptSingleStream({
				url: flow.url,
				partPath,
				proxy,
				insecure,
				maxRedirects,
				maxBytes,
				stallMs: Math.max(1, stallS) * 1000,
				signal: controller.signal,
				onEvent
			});
			return { ...retried, viaThreads: false };
		})();

		if (fs.existsSync(savePath) && !overwrite) {
			throw new Error(`下载期间目标文件出现了：${savePath}`);
		}
		fs.renameSync(partPath, savePath);
		const elapsedMs = Date.now() - started;
		return {
			savedTo: savePath,
			bytes: streamed.bytes,
			sha256: streamed.sha256,
			elapsedMs,
			speedBps: elapsedMs > 0 ? Math.round((streamed.bytes / elapsedMs) * 1000) : null,
			viaThreads: streamed.viaThreads,
			segments: streamed.segments ?? null,
			http: {
				status: flow.status,
				redirects: flow.redirects,
				content_length: Number.isFinite(declaredLength) ? declaredLength : null,
				content_type: flow.headers["content-type"] ?? null
			},
			finalUrl: flow.url
		};
	} catch (error) {
		try {
			fs.rmSync(partPath, { force: true });
		} catch {
			/* nothing to clean */
		}
		throw error;
	} finally {
		clearTimeout(deadline);
		signal?.removeEventListener("abort", forwardAbort);
	}
}

/**
 * Download with the automatic direct → proxy fallback.
 *
 * @param options - as {@link attemptDownload} plus `decidedRoute` and `upstream`.
 * @returns the attempt result plus `route` / `routeReason` / `fallbackUsed`.
 */
export async function downloadWithFallback(options) {
	const { decidedRoute, upstream, forceRoute = "auto", onEvent = null, ...attempt } = options;
	const canFallback = decidedRoute.route === "direct" && forceRoute !== "direct" && upstream.available === true && upstream.proxy !== null;

	try {
		const result = await attemptDownload({ ...attempt, proxy: decidedRoute.route === "proxy" ? upstream.proxy : null, onEvent });
		return { ...result, route: decidedRoute.route, routeReason: decidedRoute.reason, fallbackUsed: false };
	} catch (error) {
		if (!canFallback || error instanceof HttpStatusError) throw error;
		onEvent?.({ kind: "fallback", reason: error instanceof Error ? error.message : String(error) });
		const result = await attemptDownload({ ...attempt, proxy: upstream.proxy, onEvent });
		return {
			...result,
			route: "proxy",
			routeReason: `直连失败（${error instanceof Error ? error.message : String(error)}），已改用代理重试`,
			fallbackUsed: true
		};
	}
}
