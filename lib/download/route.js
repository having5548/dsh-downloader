/**
 * Route decision for one download target.
 *
 * The decision is made **offline** from the rule engine (embedded CN domain
 * suffixes and CN CIDR blocks + the subscription's own rules), so routing never
 * depends on a reachable GeoIP service. Online lookups live in `net-probe.js`
 * and are used only by the `dsh_geo_check` diagnostic tool.
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
	if (!isHttpUrl(target)) throw new Error(`not an http/https URL: ${target}`);
	const host = hostOf(target);
	const forced = String(forceRoute ?? "auto").toLowerCase();

	if (forced === "direct") {
		return { route: "direct", reason: "forced to direct by the caller", host, warning: null };
	}
	if (forced === "proxy") {
		if (upstream.available !== true) {
			throw new NoUpstreamError(
				`forced to proxy, but no usable proxy exit is available (${upstream.reason})`,
				"Start a subscription or set a proxy URL in Settings → Download proxy."
			);
		}
		if (isLocalHost(host)) {
			return { route: "direct", reason: `${host} is this machine or a private address; loopback traffic is never proxied`, host, warning: null };
		}
		return { route: "proxy", reason: "forced to proxy by the caller", host, warning: null };
	}

	if (isLocalHost(host)) {
		return { route: "direct", reason: `${host} is this machine or a private address`, host, warning: null };
	}

	if (upstream.engine === null || upstream.engine === undefined) {
		return {
			route: "direct",
			reason: upstream.reason ?? "no proxy configured; downloading directly",
			host,
			warning: "no proxy is configured, so every target is downloaded directly"
		};
	}

	const decision = upstream.engine.decide(host);
	if (decision === "reject") throw new Error(`the active rules reject this host: ${host}`);
	if (decision === "direct") {
		return { route: "direct", reason: `rule engine matched ${host} as domestic/direct`, host, warning: null };
	}
	if (upstream.available !== true) {
		throw new NoUpstreamError(
			`${host} is routed through a proxy by the active rules, but no usable node exists (${upstream.reason})`,
			"Check the subscription in Settings → Download proxy, or pass force_route=\"direct\" to bypass."
		);
	}
	return { route: "proxy", reason: `rule engine matched ${host} as proxied`, host, warning: null };
}
