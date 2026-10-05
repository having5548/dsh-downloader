/**
 * Session guard: keep the harness's own model traffic off the proxy.
 *
 * The downloader never touches the LLM connection, but DSH's *launch-time*
 * proxy policy does: `$DSH_HOME/.env` may set `HTTP_PROXY` / `HTTPS_PROXY`, and
 * when the proxy app is closed every request that goes through it fails — the
 * model connection breaks and the session dies.
 *
 * The fix is the same one that makes the downloader's own routing safe: list the
 * domestic AI platforms in `NO_PROXY`, so they are resolved and reached
 * directly no matter what the proxy is doing.
 *
 * This module only ever edits the `NO_PROXY` entry of `$DSH_HOME/.env`:
 * - it never adds or changes `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`;
 * - it backs the file up before the first write;
 * - it merges rather than replaces, so hand-written entries survive;
 * - nothing runs unless a caller explicitly asks for `apply`.
 * @module dsh-downloader/session-guard
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Loopback entries every bypass list should carry, for consumers beyond DSH. */
export const LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "::1", "[::1]"];

/** Proxy variable names that mean "a global proxy is configured". */
const PROXY_LINE = /^\s*(https?_proxy|all_proxy)\s*=\s*(.+?)\s*$/i;
/** The one line this module owns. */
const NO_PROXY_LINE = /^\s*no_proxy\s*=/i;

/** Split a bypass list on commas and whitespace, dropping blanks. */
export function splitEntries(value) {
	if (typeof value !== "string") return [];
	return value
		.split(/[,\s]+/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/** Read the current NO_PROXY value out of an `.env` body, or "". */
export function readNoProxy(content) {
	for (const line of String(content ?? "").split(/\r?\n/)) {
		if (NO_PROXY_LINE.test(line)) return line.slice(line.indexOf("=") + 1).trim();
	}
	return "";
}

/** Domains from `domains` that the existing bypass list does not already cover. */
export function missingDomains(existing, domains) {
	const keys = new Set(splitEntries(existing).map((entry) => entry.toLowerCase()));
	if (keys.has("*")) return [];
	return domains.filter((domain) => {
		const lower = domain.toLowerCase();
		return !keys.has(lower) && !keys.has(`.${lower}`);
	});
}

/**
 * Merge the loopback entries and the missing domains into an existing bypass list,
 * preserving the caller's entries and order. A list of `*` bypasses everything and
 * is returned unchanged.
 */
export function composeNoProxy(existing, domains) {
	const entries = splitEntries(existing);
	if (entries.includes("*")) return "*";
	const seen = new Set(entries.map((entry) => entry.toLowerCase()));
	const out = [...entries];
	for (const domain of domains) {
		// Both spellings: DSH matches a bare suffix against subdomains, while older
		// curl/git/npm want the leading-dot form.
		for (const entry of [domain, `.${domain}`]) {
			const key = entry.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(entry);
		}
	}
	for (const entry of LOOPBACK_NO_PROXY) {
		const key = entry.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(entry);
	}
	return out.join(",");
}

/** Replace the NO_PROXY line, or append one. Other lines are untouched. */
export function upsertNoProxy(content, value) {
	const text = String(content ?? "");
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const hadTrailingNewline = text.endsWith("\n");
	const lines = text.length === 0 ? [] : text.split(/\r?\n/);
	if (hadTrailingNewline && lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	const next = `NO_PROXY=${value}`;
	let replaced = false;
	const out = [];
	for (const line of lines) {
		if (!NO_PROXY_LINE.test(line)) {
			out.push(line);
			continue;
		}
		// Keep the first occurrence (rewritten) and drop later duplicates.
		if (!replaced) {
			out.push(next);
			replaced = true;
		}
	}
	if (!replaced) out.push(next);
	return `${out.join(eol)}${eol}`;
}

/** The `NO_PROXY=` line the user should end up with. */
export function buildNoProxyLine(existing, domains) {
	return `NO_PROXY=${composeNoProxy(existing, missingDomains(existing, domains))}`;
}

/** The `$DSH_HOME/.env` path. */
export function envFilePath(home) {
	const root = typeof home === "string" && home.length > 0 ? home : process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh");
	return join(root, ".env");
}

/** Read and describe the guard state without changing anything. */
export function inspectGuard({ envPath, domains }) {
	const result = {
		env_path: envPath,
		exists: false,
		proxy_vars: [],
		no_proxy_set: false,
		no_proxy_entries: 0,
		covered: false,
		missing: [...domains],
		suggested_line: `NO_PROXY=${composeNoProxy("", domains)}`,
		needs_apply: true
	};
	let content = "";
	if (existsSync(envPath)) {
		result.exists = true;
		try {
			content = readFileSync(envPath, "utf8");
		} catch (error) {
			result.read_error = error instanceof Error ? error.message : String(error);
			return result;
		}
	}
	for (const line of content.split(/\r?\n/)) {
		const match = PROXY_LINE.exec(line);
		if (match !== null) result.proxy_vars.push(match[1].toUpperCase());
	}
	const current = readNoProxy(content);
	result.no_proxy_set = current.length > 0;
	result.no_proxy_entries = splitEntries(current).length;
	result.missing = missingDomains(current, domains);
	result.covered = result.missing.length === 0;
	result.suggested_line = buildNoProxyLine(current, domains);
	result.needs_apply = !result.covered;
	return result;
}

/** Newest backup next to `envPath`, or null. */
export function latestBackup(envPath) {
	const dir = dirname(envPath);
	if (!existsSync(dir)) return null;
	const prefix = `${basename(envPath)}.bak-`;
	const candidates = readdirSync(dir)
		.filter((name) => name.startsWith(prefix))
		.map((name) => join(dir, name))
		.sort();
	return candidates.length === 0 ? null : candidates[candidates.length - 1];
}

/**
 * Merge the AI-platform domains into `$DSH_HOME/.env`'s NO_PROXY entry.
 * Writes nothing when the file is already sufficient.
 * @returns `{ changed, envPath, backupPath, noProxy, added, previous }`.
 */
export function applyGuard({ envPath, domains, stamp }) {
	const before = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
	const previous = readNoProxy(before);
	const added = missingDomains(previous, domains);
	if (added.length === 0) {
		return { changed: false, envPath, backupPath: null, noProxy: previous, added: [], previous };
	}
	const noProxy = composeNoProxy(previous, added);
	const after = upsertNoProxy(before, noProxy);
	if (after === before) {
		return { changed: false, envPath, backupPath: null, noProxy: previous, added: [], previous };
	}
	let backupPath = null;
	if (existsSync(envPath)) {
		const suffix = stamp ?? new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
		backupPath = `${envPath}.bak-${suffix}`;
		copyFileSync(envPath, backupPath);
	} else {
		mkdirSync(dirname(envPath), { recursive: true });
	}
	writeFileSync(envPath, after, "utf8");
	return { changed: true, envPath, backupPath, noProxy, added, previous };
}

/** Restore the newest backup over `$DSH_HOME/.env`. */
export function restoreGuard({ envPath }) {
	const backupPath = latestBackup(envPath);
	if (backupPath === null) throw new Error(`no backup to restore next to ${envPath}`);
	copyFileSync(backupPath, envPath);
	return { restored: true, envPath, backupPath };
}
