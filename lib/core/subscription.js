// ---------------------------------------------------------------------------
// Vendored from dsh-clash-proxy 0.2.0 (MIT).
// Source: H:\mycode\example\dsh-clash\lib\core\subscription.js
// [dsh-downloader] `fetchSubscription` was rewritten to use this plugin's own
// node:http client instead of undici's ProxyAgent, so the package has no
// undici dependency. `parseSubscription` additionally accepts share-link lists.
// ---------------------------------------------------------------------------
import yaml from "js-yaml";
import { parseShareLinkList } from "./share-links.js";
import { httpFlow, parseProxyUrl, readBody } from "../download/http.js";

/**
 * Clash subscription fetching and parsing.
 *
 * Accepts both a full mihomo config (proxies / proxy-groups / rules) and a
 * bare proxy list, plus the base64-wrapped bodies some providers deliver.
 * @module dsh-downloader/subscription
 */

/**
 * Fetch the raw subscription body together with the response headers.
 *
 * [dsh-downloader] Runs on the plugin's own HTTP client. `fetchProxyUrl` is
 * optional and only ever an `http(s)://` proxy: a subscription typically has to
 * be reachable *before* any node exists, so a SOCKS-only fetch proxy is refused
 * with an actionable message rather than silently ignored.
 *
 * The headers matter because that is where FlClash gets a profile's name
 * (`Content-Disposition`) and its traffic/expiry (`subscription-userinfo`).
 *
 * @param url - the subscription URL.
 * @param fetchProxyUrl - optional http(s) proxy for reaching the subscription itself.
 * @param timeoutMs - request budget.
 * @returns `{ text, headers, status, url, redirects }`.
 */
export async function fetchSubscription(url, fetchProxyUrl, timeoutMs = 30000) {
	let proxy = null;
	if (typeof fetchProxyUrl === "string" && fetchProxyUrl.trim().length > 0) {
		const parsed = parseProxyUrl(fetchProxyUrl);
		if (parsed === null) throw new Error(`fetchProxyUrl 不是可用的代理地址：${fetchProxyUrl}`);
		if (parsed.socks === true) throw new Error("fetchProxyUrl 必须是 http:// 或 https:// 代理；在还没有任何节点时无法使用 SOCKS 代理");
		proxy = parsed;
	}
	const result = await httpFlow(url, {
		proxy,
		timeoutMs,
		maxRedirects: 5,
		headers: { accept: "text/plain, application/yaml, */*" }
	});
	if (result.status < 200 || result.status >= 300) {
		try {
			result.res.resume();
			result.abort();
		} catch {
			/* already gone */
		}
		throw new Error(`订阅地址返回 HTTP ${result.status}`);
	}
	const text = await readBody(result, 8 * 1024 * 1024);
	return { text, headers: result.headers ?? {}, status: result.status, url: result.url, redirects: result.redirects };
}

/** True when the body looks like base64 rather than YAML. */
function looksBase64(text) {
	const head = text.trimStart().slice(0, 64);
	return !/^[a-z_][\w-]*\s*:|\s*-\s/m.test(text) && /^[A-Za-z0-9+/=\r\n]+$/.test(head.replace(/\s+/g, ""));
}

/** Parse one subscription body into proxies, groups, and rules. */
export function parseSubscription(raw) {
	let document = null;
	const attempts = [raw];
	if (looksBase64(raw)) attempts.unshift(Buffer.from(raw.replace(/\s+/g, ""), "base64").toString("utf8"));
	for (const candidate of attempts) {
		try {
			document = yaml.load(candidate);
			if (document !== null && typeof document === "object") break;
			document = null;
		} catch {
			// Try the next representation.
		}
	}
	if (document === null) {
		// 不是 YAML：很大一部分机场返回的是「一行一个分享链接」（常裹一层 base64）。
		const links = parseShareLinkList(raw);
		if (links !== null) {
			return { proxies: links.proxies, groups: [], rules: [], names: links.names, skipped: links.skipped, kind: "share-links" };
		}
		throw new Error("订阅内容既不是 YAML、不是 base64 包裹的 YAML，也不是分享链接列表");
	}

	const payload = Array.isArray(document) ? { proxies: document } : document;
	const rawProxies = Array.isArray(payload?.proxies) ? payload.proxies : [];
	const proxies = rawProxies.filter((proxy) => {
		const name = typeof proxy === "string" ? proxy : proxy?.name;
		if (name === "DIRECT" || name === "REJECT" || name === "REJECT-DROP" || name === "PASS" || name === "COMPATIBLE" || name === "GLOBAL") return false;
		if (typeof name !== "string" || name.length === 0) return false;
		return true;
	});
	const groups = Array.isArray(payload?.["proxy-groups"]) ? payload["proxy-groups"] : [];
	const rules = Array.isArray(payload?.rules) ? payload.rules : [];

	return {
		proxies,
		groups,
		rules,
		names: proxies.map((proxy) => (typeof proxy === "string" ? proxy : String(proxy.name))).filter(Boolean),
		skipped: [],
		kind: "yaml"
	};
}

/** Sanitize group objects: drop group members that do not resolve. */
export function sanitizeGroups(groups, names) {
	const known = new Set(names);
	const clean = [];
	for (const group of groups) {
		if (typeof group !== "object" || group === null) continue;
		const members = Array.isArray(group.proxies)
			? group.proxies.filter((member) => known.has(member) || member === "DIRECT" || member === "REJECT")
			: [];
		if (members.length === 0) continue;
		clean.push({ ...group, proxies: members });
	}
	return clean;
}
