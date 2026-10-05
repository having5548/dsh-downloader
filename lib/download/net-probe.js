/**
 * Network diagnostics used by the `dsh_geo_check` tool and by the route
 * decider's "unknown geography" fallback.
 *
 * These helpers are never on the hot download path: routing prefers the
 * offline rule engine, so a sandbox with no DNS or no ICMP still downloads fine.
 * @module dsh-downloader/net-probe
 */
import dns from "node:dns/promises";
import { spawn } from "node:child_process";
import { openTarget, readBody, tcpConnect } from "./http.js";

/** Resolve every A/AAAA record for a host. Returns [] on failure. */
export async function resolveHost(host) {
	try {
		const records = await dns.lookup(host, { all: true, verbatim: true });
		return records.map((record) => record.address);
	} catch {
		return [];
	}
}

/**
 * ICMP ping via the platform `ping` binary.
 * @returns `{ ok, timeMs, raw }` — `ok: false` with a reason when unavailable.
 */
export function icmpPing(host, timeoutMs = 3000) {
	return new Promise((resolve) => {
		const windows = process.platform === "win32";
		const argv = windows ? ["-n", "1", "-w", String(timeoutMs), host] : ["-c", "1", "-W", String(Math.ceil(timeoutMs / 1000)), host];
		let stdout = "";
		let settled = false;
		const done = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		let child;
		try {
			child = spawn(windows ? "ping.exe" : "ping", argv, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
		} catch (error) {
			done({ ok: false, timeMs: null, raw: String(error?.message ?? error) });
			return;
		}
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* already gone */
			}
			done({ ok: false, timeMs: null, raw: "icmp timeout" });
		}, timeoutMs + 1500);
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			done({ ok: false, timeMs: null, raw: String(error?.message ?? error) });
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			// Both the English and the localized Windows output carry "<n>ms" / "=1ms".
			const match = /[=<]\s*([\d.]+)\s*ms/i.exec(stdout);
			done({ ok: code === 0, timeMs: match === null ? null : Number(match[1]), raw: stdout.trim().split(/\r?\n/).slice(0, 4).join(" | ") });
		});
	});
}

/** TCP connect probe. @returns `{ ok, timeMs, error }`. */
export async function tcpPing(host, port = 443, timeoutMs = 3000) {
	const started = Date.now();
	try {
		const socket = await tcpConnect(host, port, timeoutMs);
		const elapsed = Date.now() - started;
		socket.destroy();
		return { ok: true, timeMs: elapsed, error: null };
	} catch (error) {
		return { ok: false, timeMs: null, error: error instanceof Error ? error.message : String(error) };
	}
}

/** GeoIP providers tried in order. Both are keyless. */
const GEO_PROVIDERS = [
	{
		name: "ip-api.com",
		url: (ip) => `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,isp,query`,
		parse: (json) => (json.status === "success"
			? { ip: json.query ?? null, country: json.country ?? null, countryCode: (json.countryCode ?? "").toUpperCase() || null, isp: json.isp ?? null }
			: null)
	},
	{
		name: "ipwho.is",
		url: (ip) => `https://ipwho.is/${encodeURIComponent(ip)}`,
		parse: (json) => (json.success === true
			? { ip: json.ip ?? null, country: json.country ?? null, countryCode: (json.country_code ?? "").toUpperCase() || null, isp: json.connection?.isp ?? null }
			: null)
	}
];

/**
 * Look up the country of an IP address.
 * @param ip - the address to look up.
 * @param options - optional proxy, timeout, and the provider order to try.
 * @returns `{ country, countryCode, isp, provider }` or null.
 */
export async function geoLookupIP(ip, options = {}) {
	const { proxy = null, timeoutMs = 6000, providers = GEO_PROVIDERS, signal = null } = options;
	for (const provider of providers) {
		try {
			const result = await openTarget(provider.url(ip), { proxy, timeoutMs, signal });
			if (result.status < 200 || result.status >= 300) {
				result.res.resume();
				result.abort();
				continue;
			}
			const parsed = provider.parse(JSON.parse(await readBody(result, 64 * 1024)));
			if (parsed !== null) return { ...parsed, provider: provider.name };
		} catch {
			// Try the next provider.
		}
	}
	return null;
}

/** True when the host resolves to at least one non-private address. */
export const __internals = { GEO_PROVIDERS };
