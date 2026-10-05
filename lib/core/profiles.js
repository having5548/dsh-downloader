/**
 * FlClash-style configuration store.
 *
 * FlClash keeps a *list* of profiles, each of which is either a subscription
 * URL or an imported local file, with its own label, last-update time and
 * auto-update interval; the newest label comes from the response's
 * `Content-Disposition`, and traffic/expiry come from `subscription-userinfo`.
 * This module mirrors that model so the plugin can do the same from the
 * settings panel.
 *
 * Layout under `$DSH_HOME/dsh-downloader/`:
 * - `profiles.json`   — the metadata list (this module owns it)
 * - `profiles/<id>.yaml` — the body of each imported configuration
 *
 * A "file" profile never auto-updates, exactly like FlClash's `realAutoUpdate`.
 * @module dsh-downloader/profiles
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSubscription } from "./subscription.js";
import { filenameFromDisposition } from "../download/util.js";

/** Default auto-update interval for a newly added profile (FlClash's default is comparable). */
export const DEFAULT_AUTO_UPDATE_HOURS = 24;

/** Tolerance for a "合理的" auto-update interval, in hours. */
const MIN_AUTO_UPDATE_HOURS = 1;
const MAX_AUTO_UPDATE_HOURS = 24 * 30;

/** Short, sortable, collision-resistant id (no external dependency). */
function newId() {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Parse the `subscription-userinfo` response header.
 * Format: `upload=0; download=0; total=0; expire=0` (bytes; expire is unix seconds).
 * @returns `{ upload, download, total, expire }`, all numbers, 0 when absent.
 */
export function parseSubscriptionUserinfo(headerValue) {
	const info = { upload: 0, download: 0, total: 0, expire: 0 };
	if (typeof headerValue !== "string" || headerValue.trim().length === 0) return info;
	for (const part of headerValue.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		const key = part.slice(0, eq).trim();
		const value = Number.parseInt(part.slice(eq + 1).trim(), 10);
		if (!Number.isFinite(value)) continue;
		if (key in info) info[key] = value;
	}
	return info;
}

/**
 * Reduce any accepted import string to the raw subscription URL.
 *
 * Accepts a plain `http(s)://` URL and the `clash://` forms FlClash handles as
 * deep links: `clash://install-config?url=<encoded>`, `clash://?url=<encoded>`,
 * and a bare `clash://<encoded url>`.
 * @returns the URL, or null when nothing usable is found.
 */
export function parseImportLink(value) {
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (text.length === 0) return null;
	if (/^https?:\/\//i.test(text)) return text;
	if (!/^clash:\/\//i.test(text)) return null;
	const query = text.slice(text.indexOf("?") + 1);
	const params = new URLSearchParams(text.includes("?") ? query : "");
	const fromQuery = params.get("url") ?? params.get("Url") ?? params.get("URL");
	if (typeof fromQuery === "string" && /^https?:\/\//i.test(fromQuery)) return fromQuery;
	// clash://install-config/<encoded> or clash://<encoded>
	const tail = text.replace(/^clash:\/\//i, "").replace(/^(install-config|config)\/?/i, "");
	if (tail.length === 0) return null;
	try {
		const decoded = decodeURIComponent(tail);
		if (/^https?:\/\//i.test(decoded)) return decoded;
	} catch {
		// Not percent-encoded.
	}
	return /^https?:\/\//i.test(tail) ? tail : null;
}

/** A stable, human label for a URL whose response carried no filename. */
export function labelFromUrl(url) {
	try {
		const parsed = new URL(url);
		return parsed.hostname.replace(/^www\./, "");
	} catch {
		return "配置";
	}
}

/** Reject a label that would escape the profiles directory. */
function safeLabel(value, fallback) {
	const text = String(value ?? "").trim().replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60);
	return text.length > 0 ? text : fallback;
}

/** Validate a configuration body; throws with a readable reason when unusable. */
export function validateConfigText(raw) {
	if (typeof raw !== "string" || raw.trim().length === 0) throw new Error("配置内容为空");
	let parsed;
	try {
		parsed = parseSubscription(raw);
	} catch (error) {
		throw new Error(`无法解析配置：${error instanceof Error ? error.message : String(error)}`);
	}
	if (parsed.names.length === 0) throw new Error("配置里没有解析到任何节点");
	return parsed;
}

export class ProfileStore {
	#dataDir;
	/** @type {{version: number, currentId: string|null, profiles: object[]}} */
	#state = { version: 1, currentId: null, profiles: [] };
	#loaded = false;

	constructor({ dataDir }) {
		this.#dataDir = dataDir;
	}

	get metaPath() {
		return join(this.#dataDir, "profiles.json");
	}

	get bodyDir() {
		return join(this.#dataDir, "profiles");
	}

	bodyPath(id) {
		return join(this.bodyDir, `${id}.yaml`);
	}

	/** Read the metadata file (idempotent). */
	load() {
		if (this.#loaded) return this.#state;
		this.#loaded = true;
		try {
			const parsed = JSON.parse(readFileSync(this.metaPath, "utf8"));
			if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.profiles)) {
				this.#state = {
					version: 1,
					currentId: typeof parsed.currentId === "string" ? parsed.currentId : null,
					profiles: parsed.profiles.filter((item) => item !== null && typeof item === "object" && typeof item.id === "string")
				};
			}
		} catch {
			// First run, or unreadable metadata: start empty rather than fail.
		}
		if (this.#state.currentId === null && this.#state.profiles.length > 0) this.#state.currentId = this.#state.profiles[0].id;
		return this.#state;
	}

	#persist() {
		mkdirSync(this.#dataDir, { recursive: true });
		const temp = `${this.metaPath}.tmp`;
		writeFileSync(temp, JSON.stringify(this.#state, null, 2), "utf8");
		renameSync(temp, this.metaPath);
	}

	#writeBody(id, raw) {
		mkdirSync(this.bodyDir, { recursive: true });
		const target = this.bodyPath(id);
		const temp = `${target}.tmp`;
		writeFileSync(temp, raw, "utf8");
		renameSync(temp, target);
	}

	/** Every profile, with the derived flags the UI needs. */
	list() {
		const state = this.load();
		return state.profiles.map((profile) => ({
			...profile,
			current: profile.id === state.currentId,
			dueAt: profile.source === "url" && profile.autoUpdate === true && typeof profile.lastUpdateAt === "number"
				? profile.lastUpdateAt + profile.autoUpdateHours * 3600 * 1000
				: null
		}));
	}

	/** The selected profile's metadata, or null. */
	current() {
		const state = this.load();
		return state.profiles.find((profile) => profile.id === state.currentId) ?? null;
	}

	get(id) {
		return this.load().profiles.find((profile) => profile.id === id) ?? null;
	}

	/** The configuration body of one profile, or null when the file is gone. */
	body(id) {
		const path = this.bodyPath(id);
		try {
			return readFileSync(path, "utf8");
		} catch {
			return null;
		}
	}

	/** The selected profile's body, or null. */
	currentBody() {
		const profile = this.current();
		return profile === null ? null : this.body(profile.id);
	}

	/** Profiles whose auto-update interval has elapsed. */
	dueProfiles(now = Date.now()) {
		return this.list().filter((profile) => profile.dueAt !== null && profile.dueAt <= now);
	}

	/**
	 * Add a subscription URL.
	 * @param options - `label`, `autoUpdateHours`, and the `fetcher` used to download it.
	 */
	async addFromUrl(url, { label, autoUpdateHours = DEFAULT_AUTO_UPDATE_HOURS, fetcher, fetchProxyUrl = "" } = {}) {
		if (typeof fetcher !== "function") throw new Error("内部错误：缺少抓取函数");
		const response = await fetcher(url, fetchProxyUrl);
		const raw = typeof response === "string" ? response : response.text;
		const headers = typeof response === "string" ? {} : response.headers ?? {};
		validateConfigText(raw);
		const id = newId();
		this.#writeBody(id, raw);
		const profile = {
			id,
			label: safeLabel(label ?? filenameFromDisposition(headers["content-disposition"]) ?? "", labelFromUrl(url)),
			source: "url",
			url,
			autoUpdate: true,
			autoUpdateHours: clampHours(autoUpdateHours),
			lastUpdateAt: Date.now(),
			addedAt: Date.now(),
			subscriptionInfo: parseSubscriptionUserinfo(headers["subscription-userinfo"])
		};
		const state = this.load();
		state.profiles.push(profile);
		if (state.currentId === null) state.currentId = id;
		this.#persist();
		return profile;
	}

	/** Add a configuration the user supplied as a file (never auto-updates). */
	addFromFile(name, raw, { label } = {}) {
		validateConfigText(raw);
		const id = newId();
		this.#writeBody(id, raw);
		const fallback = String(name ?? "").replace(/\.[^.]+$/, "") || "本地配置";
		const profile = {
			id,
			label: safeLabel(label ?? fallback, "本地配置"),
			source: "file",
			url: "",
			autoUpdate: false,
			autoUpdateHours: DEFAULT_AUTO_UPDATE_HOURS,
			lastUpdateAt: Date.now(),
			addedAt: Date.now(),
			subscriptionInfo: null,
			fileName: String(name ?? "")
		};
		const state = this.load();
		state.profiles.push(profile);
		if (state.currentId === null) state.currentId = id;
		this.#persist();
		return profile;
	}

	/** Re-download a URL profile. File profiles are refused, like FlClash. */
	async update(id, { fetcher, fetchProxyUrl = "" } = {}) {
		const profile = this.get(id);
		if (profile === null) throw new Error(`找不到配置：${id}`);
		if (profile.source !== "url" || profile.url.length === 0) throw new Error("本地文件配置不能从网络更新");
		const response = await fetcher(profile.url, fetchProxyUrl);
		const raw = typeof response === "string" ? response : response.text;
		const headers = typeof response === "string" ? {} : response.headers ?? {};
		validateConfigText(raw);
		this.#writeBody(id, raw);
		const fromHeader = filenameFromDisposition(headers["content-disposition"]);
		profile.label = safeLabel(fromHeader ?? profile.label, profile.label);
		profile.lastUpdateAt = Date.now();
		profile.subscriptionInfo = parseSubscriptionUserinfo(headers["subscription-userinfo"]);
		this.#persist();
		return this.get(id);
	}

	remove(id) {
		const state = this.load();
		const index = state.profiles.findIndex((profile) => profile.id === id);
		if (index === -1) throw new Error(`找不到配置：${id}`);
		state.profiles.splice(index, 1);
		try {
			rmSync(this.bodyPath(id), { force: true });
		} catch {
			// The metadata is the source of truth; a stray body is harmless.
		}
		if (state.currentId === id) state.currentId = state.profiles.length > 0 ? state.profiles[0].id : null;
		this.#persist();
		return this.current();
	}

	/** Rename a profile (FlClash lets the label be edited). */
	rename(id, label) {
		const profile = this.get(id);
		if (profile === null) throw new Error(`找不到配置：${id}`);
		profile.label = safeLabel(label, profile.label);
		this.#persist();
		return profile;
	}

	select(id) {
		const state = this.load();
		if (!state.profiles.some((profile) => profile.id === id)) throw new Error(`找不到配置：${id}`);
		state.currentId = id;
		this.#persist();
		return this.current();
	}

	/** Reorder by an explicit id list; unknown ids are ignored, missing ones appended. */
	reorder(ids) {
		const state = this.load();
		const wanted = Array.isArray(ids) ? ids : [];
		const ordered = [];
		for (const id of wanted) {
			const found = state.profiles.find((profile) => profile.id === id);
			if (found !== undefined && !ordered.includes(found)) ordered.push(found);
		}
		for (const profile of state.profiles) if (!ordered.includes(profile)) ordered.push(profile);
		state.profiles = ordered;
		this.#persist();
		return this.list();
	}

	/** Toggle/replace the auto-update settings of one profile. */
	setAutoUpdate(id, enabled, hours) {
		const profile = this.get(id);
		if (profile === null) throw new Error(`找不到配置：${id}`);
		if (profile.source !== "url") throw new Error("本地文件配置没有自动更新");
		profile.autoUpdate = enabled !== false;
		if (hours !== undefined) profile.autoUpdateHours = clampHours(hours);
		this.#persist();
		return profile;
	}

	/** Removed bodies left behind by a crash; keeps the directory tidy. */
	pruneOrphanBodies() {
		const state = this.load();
		const known = new Set(state.profiles.map((profile) => `${profile.id}.yaml`));
		let removed = 0;
		try {
			for (const name of readdirSync(this.bodyDir)) {
				if (known.has(name) || name.endsWith(".tmp")) continue;
				rmSync(join(this.bodyDir, name), { force: true });
				removed += 1;
			}
		} catch {
			// No directory yet.
		}
		return removed;
	}

	/** True when a metadata file already exists (used for the legacy migration path). */
	get exists() {
		return existsSync(this.metaPath);
	}
}

/** Keep an interval inside a sane range. */
function clampHours(value) {
	const hours = Number(value);
	if (!Number.isFinite(hours)) return DEFAULT_AUTO_UPDATE_HOURS;
	return Math.min(MAX_AUTO_UPDATE_HOURS, Math.max(MIN_AUTO_UPDATE_HOURS, Math.round(hours)));
}
