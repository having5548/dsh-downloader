/**
 * Minimal HTTP/1.1 client for the download pipeline.
 *
 * Deliberately built on `node:http` / `node:tls` instead of undici so that the
 * proxy hop is explicit and observable: the caller passes a `{ host, port }`
 * HTTP-CONNECT proxy (in practice always the plugin's own loopback rule core),
 * and nothing about the request depends on a process-wide dispatcher.
 *
 * Every `openTarget` resolves on response headers; the body stays streaming on
 * the returned `res` for the caller to consume or discard.
 * @module dsh-downloader/http
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

/** User agent used for every plugin-originated request. */
export const DEFAULT_UA = "DeepSeek-Harness/dsh-downloader (+https://github.com/having5548/dsh-downloader)";

/**
 * Parse a proxy URL into `{ socks, host, port, raw, auth }`, or null.
 * @param value - `host:port`, `http://…`, `https://…`, `socks5://…` or null.
 */
export function parseProxyUrl(value) {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	const raw = value.trim();
	try {
		const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
		const protocol = url.protocol.toLowerCase();
		const socks = protocol === "socks5:" || protocol === "socks5h:" || protocol === "socks4:" || protocol === "socks:";
		const supported = socks || protocol === "http:" || protocol === "https:";
		if (!supported) return null;
		const port = Number(url.port) || (socks ? 1080 : protocol === "https:" ? 443 : 80);
		const auth = url.username.length > 0
			? { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }
			: null;
		return { socks, secure: protocol === "https:", host: url.hostname, port, raw, auth };
	} catch {
		return null;
	}
}

/**
 * Open an HTTP CONNECT tunnel through `proxy` to `host:port`.
 * @param proxy - a parsed proxy (must not be a SOCKS proxy).
 * @returns the raw tunnelled socket.
 */
export function connectTunnel(proxy, host, port, timeoutMs) {
	return new Promise((resolve, reject) => {
		const headers = { Host: `${host}:${port}` };
		if (proxy.auth !== null && proxy.auth !== undefined) {
			const token = Buffer.from(`${proxy.auth.username}:${proxy.auth.password}`).toString("base64");
			headers["Proxy-Authorization"] = `Basic ${token}`;
		}
		const transport = proxy.secure === true ? https : http;
		const request = transport.request({
			host: proxy.host,
			port: proxy.port,
			method: "CONNECT",
			path: `${host}:${port}`,
			headers,
			agent: false,
			...(proxy.secure === true ? { rejectUnauthorized: true } : {})
		});
		const timer = setTimeout(() => request.destroy(new Error(`代理 CONNECT 超时（${timeoutMs}ms）`)), timeoutMs);
		request.once("connect", (response, socket) => {
			clearTimeout(timer);
			if (response.statusCode === 200) resolve(socket);
			else {
				socket.destroy();
				reject(new Error(`代理 CONNECT 被拒绝：HTTP ${response.statusCode}`));
			}
		});
		request.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		request.end();
	});
}

/**
 * Start one HTTP(S) request, optionally through an HTTP CONNECT proxy.
 *
 * Resolves as soon as response headers arrive. `result.abort()` tears the
 * request down; the caller owns `result.res`.
 *
 * @param rawUrl - absolute http/https URL.
 * @param options - method, headers, proxy (`{host,port,socks,auth,secure}`|null), timeoutMs, signal, insecure, body.
 * @returns `{ status, statusMessage, headers, res, url, abort }`.
 */
export function openTarget(rawUrl, options = {}) {
	const {
		method = "GET",
		headers = {},
		proxy = null,
		timeoutMs = 20000,
		signal = null,
		insecure = false,
		body = null
	} = options;

	return new Promise((resolve, reject) => {
		let url;
		try {
			url = new URL(rawUrl);
		} catch {
			reject(new Error(`无效的 URL：${rawUrl}`));
			return;
		}
		const isHttps = url.protocol === "https:";
		const port = Number(url.port) || (isHttps ? 443 : 80);

		const controller = new AbortController();
		const onOuterAbort = () => controller.abort(new Error("调用方已取消"));
		if (signal !== null && signal !== undefined) {
			if (signal.aborted) {
				reject(new Error("调用方已取消"));
				return;
			}
			signal.addEventListener("abort", onOuterAbort, { once: true });
		}
		const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）：${url.host}`)), timeoutMs);

		let settled = false;
		let request = null;
		const finish = (error, response) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onOuterAbort);
			if (error !== null && error !== undefined) reject(error instanceof Error ? error : new Error(String(error)));
			else {
				resolve({
					status: response.statusCode,
					statusMessage: response.statusMessage,
					headers: response.headers,
					res: response,
					url: url.href,
					abort: () => {
						try {
							request?.destroy();
						} catch {
							/* already gone */
						}
					}
				});
			}
		};

		const baseHeaders = { "User-Agent": DEFAULT_UA, "Accept-Encoding": "identity", ...headers };
		const onResponse = (response) => finish(null, response);
		const onRequestError = (error) => {
			const reason = controller.signal.reason;
			finish(controller.signal.aborted && reason instanceof Error ? reason : error);
		};

		if (proxy !== null && proxy !== undefined && proxy.socks === true) {
			finish(new Error("SOCKS 代理由规则内核处理，请改传内核的 HTTP 端口"));
			return;
		}

		if (proxy !== null && proxy !== undefined && isHttps) {
			connectTunnel(proxy, url.hostname, port, Math.min(timeoutMs, 15000))
				.then((socket) => {
					socket.once("error", () => {});
					const tlsSocket = tls.connect({ socket, servername: url.hostname, rejectUnauthorized: !insecure });
					tlsSocket.once("error", () => {});
					request = https.request(
						url,
						{ method, headers: baseHeaders, signal: controller.signal, agent: false, createConnection: () => tlsSocket },
						onResponse
					);
					request.once("error", onRequestError);
					if (body !== null && body !== undefined) request.end(body);
					else request.end();
				})
				.catch((error) => finish(error));
			return;
		}

		try {
			if (proxy !== null && proxy !== undefined) {
				// Plaintext http through a proxy: absolute-form request line.
				request = http.request(
					{
						host: proxy.host,
						port: proxy.port,
						path: url.href,
						method,
						headers: { ...baseHeaders, Host: url.host },
						signal: controller.signal,
						agent: false
					},
					onResponse
				);
			} else if (isHttps) {
				request = https.request(url, { method, headers: baseHeaders, signal: controller.signal, agent: false, rejectUnauthorized: !insecure }, onResponse);
			} else {
				request = http.request(url, { method, headers: baseHeaders, signal: controller.signal, agent: false }, onResponse);
			}
		} catch (error) {
			finish(error);
			return;
		}

		request.once("error", onRequestError);
		if (body !== null && body !== undefined) request.end(body);
		else request.end();
	});
}

/** Read a response body up to `limit` bytes and decode it as UTF-8. */
export async function readBody(result, limit = 64 * 1024) {
	const chunks = [];
	let size = 0;
	await new Promise((resolve, reject) => {
		result.res.on("data", (chunk) => {
			size += chunk.length;
			if (size <= limit) chunks.push(chunk);
			else result.abort();
		});
		result.res.once("end", resolve);
		result.res.once("aborted", () => reject(new Error("响应被中断")));
		result.res.once("error", reject);
	});
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * Follow redirects and return the final response.
 *
 * `onHop` (optional) is called once per hop with `{ status, url, location }`
 * before the redirect is followed, so callers can log the chain.
 */
export async function httpFlow(rawUrl, options = {}) {
	const { maxRedirects = 10, onHop, ...rest } = options;
	let current = rawUrl;
	let redirects = 0;
	for (;;) {
		const result = await openTarget(current, rest);
		if ([301, 302, 303, 307, 308].includes(result.status)) {
			const location = result.headers.location;
			result.res.resume();
			result.abort();
			if (typeof location !== "string" || location.length === 0) throw new Error(`HTTP ${result.status} 重定向缺少 Location 头`);
			if (++redirects > maxRedirects) throw new Error(`重定向次数超过上限（> ${maxRedirects}）`);
			const next = new URL(location, current).href;
			onHop?.({ status: result.status, url: current, location: next });
			current = next;
			continue;
		}
		return { ...result, redirects };
	}
}

/** Open a plain TCP connection with a deadline. Rejects on error or timeout. */
export function tcpConnect(host, port, timeoutMs = 3000) {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host, port });
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`TCP 连接超时（${timeoutMs}ms）`));
		}, timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timer);
			resolve(socket);
		});
		socket.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}
