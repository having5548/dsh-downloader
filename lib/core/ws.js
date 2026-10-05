// ---------------------------------------------------------------------------
// Vendored from dsh-clash-proxy 0.2.0 (MIT).
// Source: H:\mycode\example\dsh-clash\lib\core\ws.js
// UNMODIFIED except where a line is marked [dsh-downloader].
// ---------------------------------------------------------------------------
import { randomBytes } from "node:crypto";

/**
 * Minimal WebSocket client: HTTP upgrade handshake + binary frame codec
 * (client frames masked per RFC 6455, server frames expected unmasked).
 * Used as the transport layer for vmess-over-ws nodes.
 * @module dsh-clash-proxy/ws
 */

/**
 * Perform the WebSocket upgrade over an existing TCP socket, reading the
 * response THROUGH the shared {@link SocketBuffer} so any bytes pipelined
 * after the handshake stay buffered for the frame parser.
 * @param buffer - the socket's shared byte buffer.
 * @param path - request path (default "/").
 * @param host - Host header value (usually the node server or ws-opts Host).
 * @param extraHeaders - additional raw header lines.
 */
export async function wsHandshake(buffer, path = "/", host, extraHeaders = []) {
	const socket = buffer.socket;
	const key = randomBytes(16).toString("base64");
	const request = [
		`GET ${path} HTTP/1.1`,
		`Host: ${host}`,
		"Upgrade: websocket",
		"Connection: Upgrade",
		`Sec-WebSocket-Key: ${key}`,
		"Sec-WebSocket-Version: 13",
		...extraHeaders,
		"",
		""
	].join("\r\n");
	await new Promise((resolve, reject) => {
		socket.once("error", reject);
		socket.write(request, () => resolve());
	});
	let head = "";
	for (;;) {
		const byte = await buffer.read(1);
		head += byte.toString("latin1");
		if (head.endsWith("\r\n\r\n")) {
			if (!/^HTTP\/1\.[01] 101\b/.test(head)) {
				throw new Error(`ws: upgrade rejected: ${head.split("\r\n")[0]}`);
			}
			return;
		}
		if (head.length > 65536) throw new Error("ws: handshake header too large");
	}
}

/** Mask a payload with the given 4-byte key. */
function maskPayload(payload, maskKey) {
	const masked = Buffer.alloc(payload.length);
	for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ maskKey[i & 3];
	return masked;
}

/**
 * Frame codec over a socket + its SocketBuffer.
 * write() emits one masked binary frame per call; read() is an async
 * iterable of payload bytes across frames (ping answered, close ends).
 */
export class WsStream {
	#socket;
	#buffer;

	/** @param socket - raw socket. @param buffer - the shared SocketBuffer. */
	constructor(socket, buffer) {
		this.#socket = socket;
		this.#buffer = buffer;
	}

	/** Send a masked binary frame (FIN=1). */
	write(payload) {
		const maskKey = randomBytes(4);
		let header;
		if (payload.length < 126) {
			header = Buffer.from([0x82, 0x80 | payload.length]);
		} else if (payload.length < 65536) {
			header = Buffer.alloc(4);
			header[0] = 0x82;
			header[1] = 0x80 | 126;
			header.writeUInt16BE(payload.length, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 0x82;
			header[1] = 0x80 | 127;
			header.writeBigUInt64BE(BigInt(payload.length), 2);
		}
		this.#socket.write(Buffer.concat([header, maskKey, maskPayload(payload, maskKey)]));
	}

	/** Async iterable of received payload bytes. */
	read() {
		const socket = this.#socket;
		const buffer = this.#buffer;
		return (async function* () {
			for (;;) {
				const b0 = (await buffer.read(1))[0];
				const b1 = (await buffer.read(1))[0];
				const opcode = b0 & 0x0f;
				const masked = (b1 & 0x80) !== 0;
				let length = b1 & 0x7f;
				if (length === 126) length = (await buffer.read(2)).readUInt16BE(0);
				else if (length === 127) length = Number((await buffer.read(8)).readBigUInt64BE(0));
				const maskKey = masked ? await buffer.read(4) : null;
				let payload = await buffer.read(length);
				if (maskKey !== null) payload = maskPayload(payload, maskKey);

				if (opcode === 0x8) return; // close
				if (opcode === 0x9) {
					// ping → pong (masked, echo payload)
					const pongMask = randomBytes(4);
					const pongHeader = Buffer.from([0x8a, 0x80 | payload.length]);
					socket.write(Buffer.concat([pongHeader, pongMask, maskPayload(payload, pongMask)]));
					continue;
				}
				if (opcode === 0xa) continue; // pong
				if (payload.length > 0) yield payload;
			}
		})();
	}
}
