/**
 * Filename / size / address helpers shared by the download pipeline.
 * @module dsh-downloader/util
 */
import net from "node:net";

/** Render a byte count as a short human string. */
export function humanSize(n) {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = Number(n);
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

/** True for loopback / link-local / private / CGNAT addresses (v4 and v6). */
export function isPrivateIp(ip) {
	const family = net.isIP(ip);
	if (family === 4) {
		const parts = ip.split(".").map(Number);
		if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
		const [a, b] = parts;
		if (a === 0 || a === 10 || a === 127) return true;
		if (a === 169 && b === 254) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
		if (a >= 224) return true; // multicast + reserved
		return false;
	}
	if (family === 6) {
		const host = ip.toLowerCase().split("%")[0];
		if (host === "::" || host === "::1") return true;
		if (host.startsWith("fe80") || host.startsWith("fec0")) return true; // link-local
		if (/^f[cd]/.test(host)) return true; // unique local fc00::/7
		if (host.startsWith("::ffff:")) return isPrivateIp(host.slice(7));
		return false;
	}
	return false;
}

/** Strip path separators, characters Windows rejects, and control characters. */
export function sanitizeFilename(name) {
	const cleaned = String(name ?? "")
		.replace(/[\\/]+/g, "_")
		.replace(/[<>:"|?*]+/g, "_")
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/^\.+$/, "")
		.trim();
	return cleaned.length > 0 ? cleaned.slice(0, 180) : "";
}

/** Best-effort file name from a URL path, or "" when the URL has none. */
export function filenameFromUrl(rawUrl) {
	try {
		const url = new URL(rawUrl);
		const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
		return sanitizeFilename(decodeURIComponent(last));
	} catch {
		return "";
	}
}

/** File name from a Content-Disposition header, or "" when absent/unusable. */
export function filenameFromDisposition(header) {
	if (typeof header !== "string" || header.length === 0) return "";
	const extended = /filename\*\s*=\s*([^;]+)/i.exec(header);
	if (extended !== null) {
		const value = extended[1].trim().replace(/^["']|["']$/g, "");
		const withoutCharset = value.includes("''") ? value.slice(value.indexOf("''") + 2) : value;
		try {
			return sanitizeFilename(decodeURIComponent(withoutCharset));
		} catch {
			return sanitizeFilename(withoutCharset);
		}
	}
	const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(header);
	if (plain === null) return "";
	return sanitizeFilename((plain[2] ?? plain[3] ?? "").trim());
}

/** Decide the file name to save under: Content-Disposition first, then the URL. */
export function pickFilename(rawUrl, headers) {
	const fromHeader = filenameFromDisposition(headers?.["content-disposition"]);
	if (fromHeader.length > 0) return fromHeader;
	const fromUrl = filenameFromUrl(rawUrl);
	if (fromUrl.length > 0) return fromUrl;
	return "download.bin";
}

/** True when the URL scheme is one this plugin downloads. */
export function isHttpUrl(value) {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}
