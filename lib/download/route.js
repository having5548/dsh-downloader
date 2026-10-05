/**
 * Route decision for one download target.
 *
 * The decision is made **offline** from the rule engine (embedded CN domain
 * suffixes and CN CIDR blocks + the AI-platform protection list + the
 * subscription's own rules), so routing never depends on a reachable GeoIP
 * service. Online lookups live in `net-probe.js` and are used only by the
 * `dsh_geo_check` diagnostic tool.
 *
 * 面向模型与用户的文案一律中文；标识符、配置字段名、协议名保持原样。
 * @module dsh-downloader/route
 */
import { isHttpUrl, isPrivateIp } from "./util.js";

/** Raised when a target must go through a proxy but no usable exit exists. */
export class NoUpstreamError extends Error {
	constructor(message, hint) {
		super(message);
		this.name = "NoUpstreamError";
		this.hint = hint;
	}
}

/** Extract the hostname from a URL without throwing. */
export function hostOf(rawUrl) {
	try {
		return new URL(rawUrl).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/**
 * True for hosts that must never be sent to a proxy: loopback, `.local`
 * names, and private/loopback IP literals. The rule tables cannot express
 * "this machine", so the check lives here rather than in `RuleEngine`.
 */
function isLocalHost(host) {
	if (host.length === 0) return false;
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
	if (host.startsWith("[") && host.endsWith("]")) {
		const inner = host.slice(1, -1);
		return inner === "::1" || isPrivateIp(inner);
	}
	return isPrivateIp(host);
}

/**
 * Decide whether a target is fetched directly or through the rule core.
 *
 * @param target - the download URL.
 * @param upstream - the resolved upstream (`{ mode, engine, available, description }`).
 * @param forceRoute - `auto` | `direct` | `proxy`.
 * @returns `{ route, reason, host, warning }`.
 * @throws {NoUpstreamError} when the target needs a proxy and none is usable.
 */
export function decideRoute(target, upstream, forceRoute = "auto") {
	if (!isHttpUrl(target)) throw new Error(`不是 http/https 下载地址：${target}`);
	const host = hostOf(target);
	const forced = String(forceRoute ?? "auto").toLowerCase();

	if (forced === "direct") {
		return { route: "direct", reason: "调用方指定直连", host, warning: null };
	}
	if (forced === "proxy") {
		if (upstream.available !== true) {
			throw new NoUpstreamError(
				`调用方指定走代理，但没有可用的代理出口（${upstream.reason}）`,
				"请在「设置 → 下载代理」里填写订阅地址或 proxyUrl。"
			);
		}
		if (isLocalHost(host)) {
			return { route: "direct", reason: `${host} 是本机或私有地址，回环流量永不经过代理`, host, warning: null };
		}
		return { route: "proxy", reason: "调用方指定走代理", host, warning: null };
	}

	if (isLocalHost(host)) {
		return { route: "direct", reason: `${host} 是本机或私有地址`, host, warning: null };
	}

	if (upstream.engine === null || upstream.engine === undefined) {
		return {
			route: "direct",
			reason: upstream.reason ?? "未配置代理，直接下载",
			host,
			warning: "未配置代理，所有目标都会直接下载"
		};
	}

	const decision = upstream.engine.decide(host);
	if (decision === "reject") throw new Error(`当前规则拒绝访问该主机：${host}`);
	if (decision === "direct") {
		return { route: "direct", reason: `当前规则判定 ${host} 直连`, host, warning: null };
	}
	if (upstream.available !== true) {
		throw new NoUpstreamError(
			`当前规则要求 ${host} 走代理，但没有可用节点（${upstream.reason}）`,
			"请在「设置 → 下载代理」检查订阅，或传 force_route=\"direct\" 绕过。"
		);
	}
	return { route: "proxy", reason: `当前规则判定 ${host} 走代理`, host, warning: null };
}
