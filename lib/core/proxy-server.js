// ---------------------------------------------------------------------------
// Vendored from dsh-clash-proxy 0.2.0 (MIT).
// Source: H:\mycode\example\dsh-clash\lib\core\proxy-server.js
// UNMODIFIED except where a line is marked [dsh-downloader].
// ---------------------------------------------------------------------------
import net from "node:net";
import { connectThrough } from "./transports.js";

/**
 * The loopback rule-splitting proxy server.
 *
 * One port speaks both:
 * - HTTP proxy: CONNECT for tunnels, absolute-form GET/POST for plain http
 * - SOCKS5: greeting/negotiation then TCP connect
 *
 * Every target is decided by the {@link RuleEngine}: `direct` connects
 * straight to the destination, `proxy` goes through the current upstream
 * node, `reject` drops the connection. Byte counters feed the GUI traffic
 * panel. No system proxy, no TUN, loopback only.
 * @module dsh-clash-proxy/proxy-server
 */

/** Pipe an async iterable of chunks into a writable socket. */
async function pumpInto(iterable, socket, counter) {
	try {
		for await (const chunk of iterable) {
			if (socket.destroyed) return;
			counter?.(chunk.length);
			if (!socket.write(chunk)) await new Promise((resolve) => socket.once("drain", resolve));
		}
		if (!socket.destroyed) socket.end();
	} catch (error) {
		// [dsh-downloader] surface the relay failure instead of failing silently.
		if (process.env.DSH_PROXY_DEBUG === "1") console.error("[proxy] relay failed:", error instanceof Error ? error.message : String(error));
		socket.destroy();
	}
}

/** Pipe one socket into another (plain duplex). */
function pipeSockets(source, target, counter) {
	source.on("data", (chunk) => {
		counter?.(chunk.length);
		if (!target.write(chunk)) source.pause();
	});
	target.on("drain", () => source.resume());
	source.on("end", () => target.end());
	source.on("close", () => target.destroy());
	source.on("error", () => target.destroy());
}

export class ProxyServer {
	#engine;
	#resolveNode;
	#server = null;
	#port = 0;
	/** @type {{up: number, down: number}} */
	counters = { up: 0, down: 0 };

	/**
	 * @param engine - rule engine deciding direct/proxy/reject.
	 * @param resolveNode - thunk returning the current upstream node
	 * (null → direct-only fallback when no node is selected).
	 */
	constructor({ engine, resolveNode }) {
		this.#engine = engine;
		this.#resolveNode = resolveNode;
	}

	/** Bound loopback port (0 until started). */
	get port() {
		return this.#port;
	}

	/** Start listening on 127.0.0.1. @returns the bound port. */
	start(port = 0) {
		return new Promise((resolve, reject) => {
			this.#server = net.createServer((client) => this.#handle(client));
			this.#server.once("error", reject);
			this.#server.listen(port, "127.0.0.1", () => {
				this.#port = this.#server.address().port;
				resolve(this.#port);
			});
		});
	}

	/** Stop listening and destroy every in-flight connection. */
	stop() {
		const server = this.#server;
		this.#server = null;
		if (server !== null) server.close();
	}

	/** Route one inbound connection by first byte: 0x05 → SOCKS5, else HTTP. */
	#handle(client) {
		client.once("data", (first) => {
			if (first[0] === 0x05) {
				this.#handleSocks5(client, first).catch(() => client.destroy());
			} else {
				this.#handleHttp(client, first).catch(() => client.destroy());
			}
		});
		client.on("error", () => {});
	}

	/** Connect to the target per rules; returns the duplex face or throws. */
	async #connect(host, port) {
		const action = this.#engine.decide(host);
		if (action === "reject") throw new Error(`rejected by rule: ${host}`);
		const node = action === "proxy" ? this.#resolveNode() : null;
		if (action === "proxy" && (node === null || node === undefined)) throw new Error(`no upstream node available for ${host} (select a node or check the subscription)`);
		// eslint-disable-next-line no-console
		if (process.env.DSH_PROXY_DEBUG === "1") console.error(`[proxy] ${host}:${port} → ${action}${action === "proxy" ? ` via ${typeof node === "string" ? node : node?.name}(${node?.type})` : ""}`);
		return connectThrough(node, host, port);
	}

	#relay(face, client) {
		pumpInto(face.read, client, (bytes) => {
			this.counters.down += bytes;
		}).catch(() => client.destroy());
		client.on("data", (chunk) => {
			this.counters.up += chunk.length;
			face.write(chunk);
		});
		client.on("end", () => face.close());
		client.on("close", () => face.close());
		client.on("error", () => face.close());
	}

	// ---- SOCKS5 inbound ------------------------------------------------------

	async #handleSocks5(client, greeting) {
		const methods = [...greeting.subarray(2, 2 + greeting[1])];
		const method = methods.includes(0x00) ? 0x00 : 0xff;
		client.write(Buffer.from([0x05, method]));
		if (method === 0xff) return client.end();

		const { host, port, rest } = await this.#readSocks5Request(client);
		const action = this.#engine.decide(host);
		if (action === "reject") {
			client.end(Buffer.from([0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
			return;
		}
		try {
			const face = await this.#connect(host, port);
			client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
			if (rest.length > 0) client.unshift(rest);
			this.#relay(face, client);
		} catch (error) {
			client.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
		}
	}

	async #readSocks5Request(client) {
		const header = await new Promise((resolve, reject) => {
			const onData = (chunk) => {
				cleanup();
				resolve(chunk);
			};
			const onError = (error) => {
				cleanup();
				reject(error);
			};
			const cleanup = () => {
				client.off("data", onData);
				client.off("error", onError);
			};
			client.once("data", onData);
			client.once("error", onError);
		});
		const atyp = header[3];
		let host;
		let port;
		let rest;
		if (atyp === 0x01) {
			host = [...header.subarray(4, 8)].join(".");
			port = header.readUInt16BE(8);
			rest = header.subarray(10);
		} else if (atyp === 0x04) {
			const groups = [];
			for (let i = 0; i < 8; i++) groups.push(header.subarray(4 + i * 2, 6 + i * 2).toString("hex"));
			host = groups.join(":").replace(/(^|:)0(:0)+(:|$)/, "::");
			port = header.readUInt16BE(20);
			rest = header.subarray(22);
		} else if (atyp === 0x03) {
			const length = header[4];
			host = header.subarray(5, 5 + length).toString("utf8");
			port = header.readUInt16BE(5 + length);
			rest = header.subarray(7 + length);
		} else {
			throw new Error("socks5: unsupported address type");
		}
		return { host, port, rest };
	}

	// ---- HTTP inbound --------------------------------------------------------

	async #handleHttp(client, first) {
		const head = await this.#readHttpHead(client, first);
		const lines = head.split("\r\n");
		const requestLine = lines[0] ?? "";
		const [method, target] = requestLine.split(" ");
		const headers = {};
		for (const line of lines.slice(1)) {
			const colon = line.indexOf(":");
			if (colon === -1) continue;
			headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
		}
		if (method === "CONNECT") {
			await this.#handleConnect(client, target, headers);
			return;
		}
		if (target !== undefined && (target.startsWith("http://") || target.startsWith("https://"))) {
			await this.#handleAbsolute(client, method, target, requestLine, lines);
			return;
		}
		client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
	}

	async #readHttpHead(client, first) {
		let buffer = first;
		for (;;) {
			const end = buffer.indexOf("\r\n\r\n");
			if (end !== -1) {
				const head = buffer.subarray(0, end).toString("latin1");
				if (buffer.length > end + 4) client.unshift(buffer.subarray(end + 4));
				return head;
			}
			const chunk = await new Promise((resolve, reject) => {
				const onData = (data) => {
					cleanup();
					resolve(data);
				};
				const onError = (error) => {
					cleanup();
					reject(error);
				};
				const cleanup = () => {
					client.off("data", onData);
					client.off("error", onError);
				};
				client.once("data", onData);
				client.once("error", onError);
			});
			buffer = Buffer.concat([buffer, chunk]);
		}
	}

	async #handleConnect(client, target, headers) {
		const colon = target.lastIndexOf(":");
		if (colon <= 0) {
			client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
			return;
		}
		const host = target.slice(0, colon);
		const port = Number(target.slice(colon + 1));
		try {
			const face = await this.#connect(host, port);
			// eslint-disable-next-line no-console
			if (process.env.DSH_PROXY_DEBUG === "1") console.error(`[proxy] tunnel established for ${host}:${port}`);
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			this.#relay(face, client);
		} catch (error) {
			// eslint-disable-next-line no-console
			if (process.env.DSH_PROXY_DEBUG === "1") console.error(`[proxy] connect failed for ${host}:${port}:`, error.message);
			client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
		}
	}

	async #handleAbsolute(client, method, target, requestLine, lines) {
		let url;
		try {
			url = new URL(target);
		} catch {
			client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
			return;
		}
		const host = url.hostname;
		const port = url.port.length > 0 ? Number(url.port) : 80;
		try {
			const face = await this.#connect(host, port);
			// Rebuild the request with an origin-form target and forced close.
			const path = `${url.pathname}${url.search}`;
			const rewritten = lines.slice(1).filter((line) => !/^(proxy-connection|connection):/i.test(line.trim()));
			const outbound = `${method} ${path} HTTP/1.1\r\n${rewritten.join("\r\n")}\r\nConnection: close\r\n\r\n`;
			this.counters.up += Buffer.byteLength(outbound);
			face.write(Buffer.from(outbound));
			pumpInto(face.read, client, (bytes) => {
				this.counters.down += bytes;
			}).catch(() => client.destroy());
		} catch (error) {
			client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
		}
	}
}
