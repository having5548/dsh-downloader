// ---------------------------------------------------------------------------
// Vendored from dsh-clash-proxy 0.2.0 (MIT).
// Source: H:\mycode\example\dsh-clash\lib\core\vmess.js
// UNMODIFIED except where a line is marked [dsh-downloader].
// ---------------------------------------------------------------------------
import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * VMess AEAD client (alterId = 0, security AES-128-GCM, Option = ChunkStream).
 *
 * Faithful port of v2ray-core's v5 `proxy/vmess/aead` and `encoding/client`:
 * - authID  = AES-block(KDF16(cmdKey, "AES Auth ID Encryption")) over
 *   [time(8)][rand(4)][crc32(12) BE(4)]
 * - header  = authID(16) || AEAD-length(18) || connectionNonce(8) || AEAD-payload
 * - body    = chunks: [plain BE16 size][AES-128-GCM payload], nonce =
 *   [count(2)][requestBodyIV[2:12]], keys = the random 16-byte request keys
 * - response = AEAD header under SHA256-derived keys, then same chunking
 *
 * Only the ChunkStream option bit is sent: no shake masking, no padding —
 * servers accept any option subset and mirror it in their responses.
 * @module dsh-clash-proxy/vmess
 */

const KDF_SALT_AUTH_ID = "AES Auth ID Encryption";
const KDF_SALT_HEADER_LEN_KEY = "VMess Header AEAD Key_Length";
const KDF_SALT_HEADER_LEN_IV = "VMess Header AEAD Nonce_Length";
const KDF_SALT_HEADER_KEY = "VMess Header AEAD Key";
const KDF_SALT_HEADER_IV = "VMess Header AEAD Nonce";
const KDF_SALT_RESP_LEN_KEY = "AEAD Resp Header Len Key";
const KDF_SALT_RESP_LEN_IV = "AEAD Resp Header Len IV";
const KDF_SALT_RESP_KEY = "AEAD Resp Header Key";
const KDF_SALT_RESP_IV = "AEAD Resp Header IV";
const KDF_BASE = "VMess AEAD KDF";

/** FNV-1a 32-bit hash of a buffer. */
export function fnv1a32(buffer) {
	let hash = 0x811c9dc5;
	for (const byte of buffer) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/** SHA-256 of one buffer. */
const sha256 = (buf) => createHash("sha256").update(buf).digest();

/** Go hmac key padding: zero-pad to 64, then XOR the pad byte. */
function pad64(keyBytes, padByte) {
	const buf = Buffer.alloc(64, padByte);
	for (let i = 0; i < Math.min(keyBytes.length, 64); i++) buf[i] ^= keyBytes[i];
	return buf;
}

/**
 * Xray's VMess AEAD KDF (proxy/vmess/aead/kdf.go), implemented as the exact
 * state machine: a chain of nested HMACs whose ipad blocks all accumulate
 * into one inner SHA-256 state, and whose Sum recursion rewrites that state
 * level by level. Verified against a Go reference (see test/kdf-compare).
 *
 *   level 0: HMAC-SHA256(key="VMess AEAD KDF")
 *   level i: HMAC(key=paths[i-1], hash=level i-1)
 */
export function vmessKdf(key, ...paths) {
	const pads = [{ ipad: pad64(Buffer.from(KDF_BASE), 0x36), opad: pad64(Buffer.from(KDF_BASE), 0x5c) }];
	for (const path of paths) {
		// Paths may be latin1 strings (Buffer.toString("binary")) or raw Buffers;
		// latin1 decoding preserves every byte exactly (UTF-8 would mangle >0x7F).
		const pathBytes = Buffer.isBuffer(path) ? path : Buffer.from(String(path), "latin1");
		pads.push({ ipad: pad64(pathBytes, 0x36), opad: pad64(pathBytes, 0x5c) });
	}
	const levelCount = paths.length;

	// inner0 accumulates every ipad at construction, then the message key.
	let inner = Buffer.concat([...pads.map((entry) => entry.ipad), key]);

	const sumLevel = (level) => {
		if (level === 0) {
			const digest = sha256(inner);
			return sha256(Buffer.concat([pads[0].opad, digest]));
		}
		const innerDigest = sumLevel(level - 1);
		inner = Buffer.concat([...pads.slice(0, level).map((entry) => entry.ipad), pads[level].opad, innerDigest]);
		return sumLevel(level - 1);
	};

	return sumLevel(levelCount);
}

/** KDF16 = first 16 bytes of the KDF output. */
const kdf16 = (key, ...paths) => vmessKdf(key, ...paths).subarray(0, 16);

/** Single-block AES encrypt (authID step). */
function aesBlockEncrypt(key, block) {
	const cipher = createCipheriv("aes-128-ecb", key, null);
	cipher.setAutoPadding(false);
	return Buffer.concat([cipher.update(block), cipher.final()]);
}

/** AES-128-GCM seal. */
function gcmSeal(key, nonce, plaintext, aad) {
	const cipher = createCipheriv("aes-128-gcm", key, nonce);
	if (aad !== undefined && aad.length > 0) cipher.setAAD(aad);
	return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/** AES-128-GCM open. @throws on auth failure. */
function gcmOpen(key, nonce, sealed, aad) {
	const decipher = createDecipheriv("aes-128-gcm", key, nonce);
	if (aad !== undefined && aad.length > 0) decipher.setAAD(aad);
	decipher.setAuthTag(sealed.subarray(sealed.length - 16));
	return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
}

/** CRC-32 (IEEE) — used by the authID. */
function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) {
			crc = (crc >>> 1) ^ ((crc & 1) !== 0 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** Build the 16-byte authID for the current time. */
function createAuthId(cmdKey, now) {
	const time = Buffer.alloc(8);
	time.writeBigUInt64BE(BigInt(now));
	const rand = randomBytes(4);
	const head = Buffer.concat([time, rand]);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(head));
	return aesBlockEncrypt(kdf16(cmdKey, KDF_SALT_AUTH_ID), Buffer.concat([head, checksum]));
}

/** v2ray vmess address encoding: [port BE16][atyp][addr]; atyp 0x01=IPv4, 0x02=domain, 0x03=IPv6. */
export function vmessEncodeAddr(host, port) {
	const portBytes = Buffer.from([port >> 8, port & 0xff]);
	const ip4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) && host.split(".").every((part) => Number(part) <= 255);
	if (ip4) return Buffer.concat([portBytes, Buffer.from([0x01]), Buffer.from(host.split(".").map(Number))]);
	if (host.includes(":")) {
		const groups = host.split(":").map((part) => parseInt(part, 16));
		const addr = Buffer.alloc(16);
		groups.forEach((value, index) => addr.writeUInt16BE(value, index * 2));
		return Buffer.concat([portBytes, Buffer.from([0x03]), addr]);
	}
	const hostBytes = Buffer.from(host);
	return Buffer.concat([portBytes, Buffer.from([0x02, hostBytes.length]), hostBytes]);
}

/**
 * Seal the VMess AEAD request header (authID + encrypted command).
 * @param cmdKey - MD5(uuid), 16 bytes.
 * @param command - the plaintext command buffer.
 */
export function sealVmessAeadHeader(cmdKey, command) {
	const authId = createAuthId(cmdKey, Math.floor(Date.now() / 1000));
	const connectionNonce = randomBytes(8);

	const lengthPlain = Buffer.alloc(2);
	lengthPlain.writeUInt16BE(command.length);
	const lengthSealed = gcmSeal(
		kdf16(cmdKey, KDF_SALT_HEADER_LEN_KEY, authId.toString("binary"), connectionNonce.toString("binary")),
		vmessKdf(cmdKey, KDF_SALT_HEADER_LEN_IV, authId.toString("binary"), connectionNonce.toString("binary")).subarray(0, 12),
		lengthPlain,
		authId
	);

	const payloadSealed = gcmSeal(
		kdf16(cmdKey, KDF_SALT_HEADER_KEY, authId.toString("binary"), connectionNonce.toString("binary")),
		vmessKdf(cmdKey, KDF_SALT_HEADER_IV, authId.toString("binary"), connectionNonce.toString("binary")).subarray(0, 12),
		command,
		authId
	);

	return Buffer.concat([authId, lengthSealed, connectionNonce, payloadSealed]);
}

/**
 * Build the plaintext AEAD command.
 * @param reqKey/reqIV - 16-byte random request body key/IV.
 * @param responseHeader - the V byte to echo-check (random).
 */
export function buildVmessCommand({ reqKey, reqIV, responseHeader, host, port }) {
	const paddingLength = Math.floor(Math.random() * 16);
	const security = (paddingLength << 4) | 0x03; // AES-128-GCM
	const body = Buffer.concat([
		Buffer.from([0x01]), // version
		reqIV,
		reqKey,
		Buffer.from([responseHeader]),
		Buffer.from([0x01]), // Option: ChunkStream only
		Buffer.from([security, 0x00, 0x01]), // security | reserved | cmd TCP
		vmessEncodeAddr(host, port),
		randomBytes(paddingLength)
	]);
	const hash = Buffer.alloc(4);
	hash.writeUInt32BE(fnv1a32(body));
	return Buffer.concat([body, hash]);
}

/** Chunk nonce: [count BE16][iv[2:12]]. */
function chunkNonce(iv, count) {
	const nonce = Buffer.alloc(12);
	nonce.writeUInt16BE(count);
	iv.copy(nonce, 2, 2, 12);
	return nonce;
}

/** One AEAD body chunk writer over a raw byte sink. */
export class VmessChunkWriter {
	#sink;
	#key;
	#iv;
	#count = 0;

	/** @param sink - (buffer) => void sink (e.g. ws frame writer). */
	constructor(sink, key, iv) {
		this.#sink = sink;
		this.#key = key;
		this.#iv = iv;
	}

	write(plaintext) {
		if (plaintext.length === 0) return;
		// The 2-byte chunk length field caps each chunk at 65535 bytes (sealed
		// = plaintext + 16), so split large writes like xray's 8KB slices do.
		for (let offset = 0; offset < plaintext.length; offset += 0x3fff) {
			const part = plaintext.subarray(offset, Math.min(plaintext.length, offset + 0x3fff));
			const sealed = gcmSeal(this.#key, chunkNonce(this.#iv, this.#count++), part);
			const size = Buffer.alloc(2);
			size.writeUInt16BE(sealed.length);
			this.#sink(Buffer.concat([size, sealed]));
		}
	}

	/** Signal end of stream with a zero-length chunk. */
	end() {
		const size = Buffer.alloc(2); // 0x0000
		this.#sink(size);
	}
}

/** AEAD body chunk reader over an async byte source (SocketBuffer-like). */
export class VmessChunkReader {
	#source; // { read(n): Promise<Buffer> }
	#key;
	#iv;
	#count = 0;

	constructor(source, key, iv) {
		this.#source = source;
		this.#key = key;
		this.#iv = iv;
	}

	/** Read one chunk payload; returns null at the terminal (size 0) chunk. */
	async readChunk() {
		const sizeHeader = await this.#source.read(2);
		const size = sizeHeader.readUInt16BE(0);
		if (size === 0) return null;
		const sealed = await this.#source.read(size);
		return gcmOpen(this.#key, chunkNonce(this.#iv, this.#count++), sealed);
	}
}

/**
 * Decode the VMess AEAD response header from the byte source.
 * @returns the plaintext response header (4+ bytes: V, Opt, Cmd, Len, ...).
 */
export async function decodeVmessResponse(source, reqKey, reqIV) {
	const respKey = createHash("sha256").update(reqKey).digest().subarray(0, 16);
	const respIV = createHash("sha256").update(reqIV).digest().subarray(0, 16);

	const lengthSealed = await source.read(18);
	const lengthPlain = gcmOpen(
		kdf16(respKey, KDF_SALT_RESP_LEN_KEY),
		vmessKdf(respIV, KDF_SALT_RESP_LEN_IV).subarray(0, 12),
		lengthSealed
	);
	const payloadLength = lengthPlain.readUInt16BE(0);

	const payloadSealed = await source.read(payloadLength + 16);
	const payload = gcmOpen(
		kdf16(respKey, KDF_SALT_RESP_KEY),
		vmessKdf(respIV, KDF_SALT_RESP_IV).subarray(0, 12),
		payloadSealed
	);

	// Xray EncodeResponseHeader writes the plaintext header as
	//   [V(1)][Option(1)][0x00][0x00]
	// MarshalCommand has no registered factory for ResponseCommand, so it
	// errors and the two zero bytes are written instead (see xray
	// proxy/vmess/encoding/commands.go). There is no trailing content to read.
	return { responseHeader: payload, bodyKey: respKey, bodyIV: respIV };
}
