// ---------------------------------------------------------------------------
// Vendored from dsh-clash-proxy 0.2.0 (MIT).
// Source: H:\mycode\example\dsh-clash\lib\core\rules.js
// UNMODIFIED except where a line is marked [dsh-downloader].
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Rule engine: decides `direct` | `proxy` | `reject` per target host.
 *
 * Matching order for a hostname:
 * 1. user extraRules, in order (DOMAIN, DOMAIN-SUFFIX, DOMAIN-KEYWORD, IP-CIDR)
 * 2. subscription passthrough rules (same types, DIRECT/REJECT only)
 * 3. the embedded CN domain suffix table → direct
 * 4. default → proxy
 *
 * IP literals skip domain rules and use the embedded CN CIDR tables plus any
 * custom IP-CIDR rules, defaulting to proxy.
 * @module dsh-clash-proxy/rules
 */

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "data");

function loadJson(name) {
	return JSON.parse(gunzipSync(readFileSync(join(dataDir, name))).toString("utf8"));
}

/** Embedded domestic domain suffixes (DOMAIN-SUFFIX semantics). */
const CN_SUFFIXES = new Set(loadJson("cn-domains.json.gz"));
/** Embedded domestic IPv4 CIDRs [[baseInt, prefixLen], ...] sorted by base. */
const CN_CIDRS4 = loadJson("cn-cidrs.json.gz");
/** Embedded domestic IPv6 CIDRs [network(6×u16), prefixLen] parsed at load. */
const CN_CIDRS6 = loadJson("cn-cidrs6.json.gz").map((cidr) => {
	const slash = cidr.indexOf("/");
	const network = cidr.slice(0, slash);
	const prefix = Number(cidr.slice(slash + 1));
	const parts = network.split(":");
	const groups = new Array(8).fill(0);
	if (parts.includes("")) {
		// "::" compression: place the right-hand groups at the tail.
		const empty = parts.indexOf("");
		const left = parts.slice(0, empty);
		const right = parts.slice(empty + 1);
		left.forEach((part, index) => {
			if (part.length > 0) groups[index] = parseInt(part, 16);
		});
		right.forEach((part, index) => {
			if (part.length > 0) groups[8 - right.length + index] = parseInt(part, 16);
		});
	} else {
		parts.forEach((part, index) => {
			groups[index] = parseInt(part, 16);
		});
	}
	return { groups, prefix };
}).sort((a, b) => {
	for (let i = 0; i < 8; i++) if (a.groups[i] !== b.groups[i]) return a.groups[i] - b.groups[i];
	return a.prefix - b.prefix;
});

/** IPv4 dotted string → uint32. */
export function ipv4ToInt(ip) {
	const parts = ip.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
	return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

/** IPv6 string → 8×uint16 groups (uncompressed). */
export function ipv6ToGroups(ip) {
	if (ip.includes("::")) {
		const [left, right] = ip.split("::");
		const leftGroups = left.length > 0 ? left.split(":").map((part) => parseInt(part, 16)) : [];
		const rightGroups = right.length > 0 ? right.split(":").map((part) => parseInt(part, 16)) : [];
		if (leftGroups.length + rightGroups.length > 7 || leftGroups.some(Number.isNaN) || rightGroups.some(Number.isNaN)) return null;
		const middle = new Array(8 - leftGroups.length - rightGroups.length).fill(0);
		return [...leftGroups, ...middle, ...rightGroups];
	}
	const groups = ip.split(":").map((part) => parseInt(part, 16));
	if (groups.length !== 8 || groups.some(Number.isNaN)) return null;
	return groups;
}

/** True when the IPv4 int falls inside any embedded CN CIDR. */
export function inCnCidr4(ipInt) {
	for (const [base, prefix] of CN_CIDRS4) {
		if (base > ipInt) return false; // sorted: no later row can match
		const mask = prefix === 0 ? 0 : (-1 << (32 - prefix)) >>> 0;
		if ((ipInt & mask) === (base & mask)) return true;
	}
	return false;
}

/** True when the IPv6 groups fall inside any embedded CN CIDR. */
export function inCnCidr6(groups) {
	for (const { groups: network, prefix } of CN_CIDRS6) {
		let before = false;
		let equal = true;
		for (let i = 0; i < 8 && equal; i++) {
			if (groups[i] !== network[i]) {
				equal = false;
				before = groups[i] < network[i];
			}
		}
		if (before) return false; // sorted
		if (!equal) continue;
		// network equals the prefix bits so far — compare remaining bits below.
		let matched = true;
		for (let bit = 0; bit < prefix; bit++) {
			const groupIndex = bit >> 4;
			const bitIndex = 15 - (bit & 15);
			if (((groups[groupIndex] >> bitIndex) & 1) !== ((network[groupIndex] >> bitIndex) & 1)) {
				matched = false;
				break;
			}
		}
		if (matched) return true;
	}
	return false;
}

/**
 * Compile a rule line ("TYPE,param[,param],TARGET") into a matcher.
 * Supported types: DOMAIN, DOMAIN-SUFFIX, DOMAIN-KEYWORD, IP-CIDR, IP-CIDR6,
 * MATCH, GEOIP (CN only). Unknown types yield null.
 */
function compileRule(line) {
	if (typeof line !== "string") return null;
	const trimmed = line.trim();
	if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("//")) return null;
	const parts = trimmed.split(",").map((part) => part.trim());
	const target = (parts.pop() ?? "").toUpperCase();
	if (target !== "DIRECT" && target !== "PROXY" && target !== "REJECT" && target !== "REJECT-DROP") return null;
	const action = target === "REJECT-DROP" ? "reject" : target.toLowerCase();
	const type = (parts.shift() ?? "").toUpperCase();
	const param = parts.join(",");
	switch (type) {
		case "DOMAIN":
			return { match: (host) => host === param.toLowerCase(), action };
		case "DOMAIN-SUFFIX":
			return { match: (host) => host === param.toLowerCase() || host.endsWith(`.${param.toLowerCase()}`), action };
		case "DOMAIN-KEYWORD":
			return { match: (host) => host.includes(param.toLowerCase()), action };
		case "IP-CIDR": {
			const slash = param.indexOf("/");
			const base = ipv4ToInt(param.slice(0, slash));
			const prefix = Number(param.slice(slash + 1));
			if (base === null || !Number.isInteger(prefix)) return null;
			const mask = prefix === 0 ? 0 : (-1 << (32 - prefix)) >>> 0;
			return { matchIp: (ipInt) => (ipInt & mask) === (base & mask), action };
		}
		case "IP-CIDR6": {
			const slash = param.indexOf("/");
			const groups = ipv6ToGroups(param.slice(0, slash));
			const prefix = Number(param.slice(slash + 1));
			if (groups === null || !Number.isInteger(prefix)) return null;
			return {
				matchIp6: (candidate) => {
					for (let bit = 0; bit < prefix; bit++) {
						const groupIndex = bit >> 4;
						const bitIndex = 15 - (bit & 15);
						if (((candidate[groupIndex] >> bitIndex) & 1) !== ((groups[groupIndex] >> bitIndex) & 1)) return false;
					}
					return true;
				},
				action
			};
		}
		case "MATCH":
			return { match: () => true, action };
		default:
			return null;
	}
}

/** @typedef {{ruleLines: string[], excludeRules: string[]}} RuleEngineOptions */

export class RuleEngine {
	#hostRules;
	#ipRules;
	#ip6Rules;

	/**
	 * @param extraRules - user rule lines, highest priority.
	 * @param excludeRules - subscription rule lines to drop (substring).
	 * @param subscriptionRules - subscription DIRECT/REJECT passthrough lines.
	 */
	constructor({ extraRules = [], excludeRules = [], subscriptionRules = [] } = {}) {
		this.#hostRules = [];
		this.#ipRules = [];
		this.#ip6Rules = [];
		const lines = [
			...extraRules.filter((line) => typeof line === "string"),
			...subscriptionRules.filter((line) => typeof line === "string" && !excludeRules.some((excluded) => line.includes(excluded)))
		];
		for (const line of lines) {
			const rule = compileRule(line);
			if (rule === null) continue;
			if (rule.matchIp !== undefined) this.#ipRules.push(rule);
			else if (rule.matchIp6 !== undefined) this.#ip6Rules.push(rule);
			else this.#hostRules.push(rule);
		}
	}

	/** Decision for a hostname (lowercased). */
	matchHost(host) {
		for (const rule of this.#hostRules) if (rule.match(host)) return rule.action;
		return null;
	}

	/** Decision for an IPv4 int. */
	matchIp(ipInt) {
		for (const rule of this.#ipRules) if (rule.matchIp(ipInt)) return rule.action;
		if (inCnCidr4(ipInt)) return "direct";
		return null;
	}

	/** Decision for IPv6 groups. */
	matchIp6(groups) {
		for (const rule of this.#ip6Rules) if (rule.matchIp6(groups)) return rule.action;
		if (inCnCidr6(groups)) return "direct";
		return null;
	}

	/** Final decision for a raw host string (hostname or IP literal). */
	decide(rawHost) {
		const host = rawHost.toLowerCase().trim();
		const ip4 = ipv4ToInt(host);
		if (ip4 !== null) return this.matchIp(ip4) ?? "proxy";
		const ip6 = ipv6ToGroups(host);
		if (ip6 !== null) return this.matchIp6(ip6) ?? "proxy";
		const ruleAction = this.matchHost(host);
		if (ruleAction !== null) return ruleAction;
		if (CN_SUFFIXES.has(host) || host.endsWith(".cn")) return "direct";
		for (let dot = host.indexOf("."); dot !== -1; dot = host.indexOf(".", dot + 1)) {
			if (CN_SUFFIXES.has(host.slice(dot + 1))) return "direct";
		}
		return "proxy";
	}
}
