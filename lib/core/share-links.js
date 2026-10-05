/**
 * 分享链接（share link）订阅解析。
 *
 * 市面上很大一部分机场返回的不是 Clash YAML，而是**一行一个节点 URI**：
 * base64 裹一层，解开是 `hysteria2://…` / `ss://…` / `trojan://…` / `vless://…`。
 * 本模块把它转成与 Clash YAML `proxies:` 完全一致的节点对象，这样下游
 * （规则引擎、`connectThrough`）一行都不用改。
 *
 * 解析结果里保留原始 URI 的语义字段；**不认识的参数不猜**，宁可少写。
 * @module dsh-downloader/share-links
 */

/** base64 解码，容忍 urlsafe 与缺失的 padding。 */
function decodeBase64(text) {
	const normalized = String(text).replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	return Buffer.from(padded, "base64").toString("utf8");
}

/** 是否是 base64（而不是明文）。 */
function looksBase64(text) {
	const compact = String(text).replace(/\s+/g, "");
	if (compact.length === 0 || compact.length % 4 === 1) return false;
	return /^[A-Za-z0-9+/=_-]+$/.test(compact) && !/:/.test(compact.slice(0, 32));
}

/** `#名称` → 名称（解码失败就用原文）。 */
function fragmentName(hash) {
	if (typeof hash !== "string" || hash.length === 0) return "";
	const text = hash.startsWith("#") ? hash.slice(1) : hash;
	if (text.length === 0) return "";
	try {
		return decodeURIComponent(text).trim();
	} catch {
		return text.trim();
	}
}

/** 布尔开关：`1` / `true` / 存在。 */
function truthyParam(value) {
	if (value === null || value === undefined) return false;
	const text = String(value).toLowerCase();
	return text === "1" || text === "true" || text === "yes";
}

/** 把一个 URI 拆成各段。 */
function dissect(uri) {
	const hashAt = uri.indexOf("#");
	const hash = hashAt === -1 ? "" : uri.slice(hashAt);
	let rest = hashAt === -1 ? uri : uri.slice(0, hashAt);
	const schemeEnd = rest.indexOf("://");
	const scheme = rest.slice(0, schemeEnd).toLowerCase();
	rest = rest.slice(schemeEnd + 3);
	const queryAt = rest.indexOf("?");
	const query = queryAt === -1 ? "" : rest.slice(queryAt + 1);
	if (queryAt !== -1) rest = rest.slice(0, queryAt);
	const slashAt = rest.indexOf("/");
	const authority = slashAt === -1 ? rest : rest.slice(0, slashAt);
	return { scheme, authority, query, hash, params: new URLSearchParams(query) };
}

/** `user:pass@host:port` → 拆开；没有 `@` 时整个都是 host:port。 */
function splitAuthority(authority) {
	const at = authority.lastIndexOf("@");
	if (at === -1) return { userinfo: "", host: authority };
	return { userinfo: authority.slice(0, at), host: authority.slice(at + 1) };
}

/** `host:port` → `{ host, port }`，支持 `[v6]:port`。 */
function splitHostPort(value) {
	const text = String(value);
	if (text.startsWith("[")) {
		const end = text.indexOf("]");
		const host = text.slice(1, end);
		const port = text.slice(end + 2);
		return { host, port: Number.parseInt(port, 10) };
	}
	const colon = text.lastIndexOf(":");
	if (colon === -1) return { host: text, port: Number.NaN };
	return { host: text.slice(0, colon), port: Number.parseInt(text.slice(colon + 1), 10) };
}

/** 解析 `user:pass`（各段会做 URL 解码）。 */
function splitUserinfo(userinfo) {
	if (userinfo.length === 0) return { username: "", password: "" };
	const colon = userinfo.indexOf(":");
	const decode = (value) => {
		try {
			return decodeURIComponent(value);
		} catch {
			return value;
		}
	};
	if (colon === -1) return { username: decode(userinfo), password: "" };
	return { username: decode(userinfo.slice(0, colon)), password: decode(userinfo.slice(colon + 1)) };
}

/** 传输层相关参数（ws / grpc / h2）→ Clash 字段。 */
function networkFields(params, scheme) {
	const network = (params.get("type") ?? "tcp").toLowerCase();
	const fields = { network };
	if (network === "ws") {
		const path = params.get("path") ?? "/";
		const host = params.get("host") ?? "";
		fields["ws-opts"] = host.length > 0 ? { path, headers: { Host: host } } : { path };
	}
	if (network === "grpc") fields["grpc-opts"] = { "grpc-service-name": params.get("serviceName") ?? "" };
	if (scheme === "http" && network === "h2") fields["h2-opts"] = { path: params.get("path") ?? "/", host: [params.get("host") ?? ""] };
	return fields;
}

const SKIP = Symbol("skip");

/** `ss://` —— 三种写法都要认。 */
function parseSs(uri, name) {
	const { authority, query, params } = dissect(uri);
	const decodedAuthority = looksBase64(authority) && !authority.includes(":") ? decodeBase64(authority) : authority;
	const { userinfo, host } = splitAuthority(decodedAuthority);
	let cipher = "";
	let password = "";
	if (userinfo.length > 0 && !userinfo.includes(":")) {
		// ss://base64(method:password)@host:port
		const inner = looksBase64(userinfo) || !userinfo.includes(":") ? decodeBase64(userinfo) : userinfo;
		const colon = inner.indexOf(":");
		cipher = colon === -1 ? inner : inner.slice(0, colon);
		password = colon === -1 ? "" : inner.slice(colon + 1);
	} else {
		const pair = splitUserinfo(userinfo);
		cipher = pair.username;
		password = pair.password;
	}
	const target = splitHostPort(host);
	if (!target.host) return SKIP;
	const node = { name, type: "ss", server: target.host, port: target.port, cipher, password };
	if (query.length > 0 && params.get("plugin")) {
		// 带插件的 ss 需要额外实现，交回调用方记为「不支持」。
		node.__unsupported = `ss 插件 ${params.get("plugin")}`;
	}
	return node;
}

/** `trojan://` */
function parseTrojan(uri, name) {
	const { authority, params } = dissect(uri);
	const { userinfo, host } = splitAuthority(authority);
	const target = splitHostPort(host);
	if (!target.host) return SKIP;
	const node = {
		...networkFields(params, "trojan"),
		name,
		type: "trojan",
		server: target.host,
		port: target.port,
		password: splitUserinfo(userinfo).username
	};
	const sni = params.get("sni") ?? params.get("peer");
	if (sni !== null) node.sni = sni;
	if (truthyParam(params.get("allowInsecure")) || truthyParam(params.get("insecure"))) node["skip-cert-verify"] = true;
	if (params.get("alpn")) node.alpn = params.get("alpn").split(",");
	return node;
}

/** `vmess://base64(json)` */
function parseVmess(uri, name) {
	const body = uri.slice(uri.indexOf("://") + 3);
	const json = decodeBase64(body.split("#")[0]);
	let spec;
	try {
		spec = JSON.parse(json);
	} catch {
		return SKIP;
	}
	if (spec === null || typeof spec !== "object" || spec.add === undefined) return SKIP;
	const node = {
		name: name.length > 0 ? name : String(spec.ps ?? `${spec.add}:${spec.port}`),
		type: "vmess",
		server: String(spec.add),
		port: Number.parseInt(String(spec.port), 10),
		uuid: String(spec.id ?? ""),
		alterId: Number.parseInt(String(spec.aid ?? 0), 10) || 0,
		cipher: String(spec.scy ?? "auto")
	};
	if (String(spec.tls ?? "").toLowerCase() === "tls") node.tls = true;
	const sni = spec.sni ?? spec.host;
	if (sni) node.servername = String(sni);
	const network = String(spec.net ?? "tcp").toLowerCase();
	node.network = network;
	if (network === "ws") {
		const headers = spec.host ? { Host: String(spec.host) } : {};
		node["ws-opts"] = { path: String(spec.path ?? "/"), headers };
	}
	if (network === "grpc") node["grpc-opts"] = { "grpc-service-name": String(spec.path ?? "") };
	if (spec.fp) node["client-fingerprint"] = String(spec.fp);
	return node;
}

/** `vless://` */
function parseVless(uri, name) {
	const { authority, params } = dissect(uri);
	const { userinfo, host } = splitAuthority(authority);
	const target = splitHostPort(host);
	if (!target.host) return SKIP;
	const security = (params.get("security") ?? "none").toLowerCase();
	const node = {
		...networkFields(params, "vless"),
		name,
		type: "vless",
		server: target.host,
		port: target.port,
		uuid: splitUserinfo(userinfo).username
	};
	if (security === "tls" || security === "reality" || security === "xtls") node.tls = true;
	const sni = params.get("sni") ?? params.get("peer") ?? params.get("host");
	if (sni) node.servername = sni;
	if (params.get("flow")) node.flow = params.get("flow");
	if (params.get("fp")) node["client-fingerprint"] = params.get("fp");
	if (params.get("alpn")) node.alpn = params.get("alpn").split(",");
	if (truthyParam(params.get("allowInsecure")) || truthyParam(params.get("insecure"))) node["skip-cert-verify"] = true;
	if (security === "reality") {
		const publicKey = params.get("pbk") ?? "";
		if (publicKey.length === 0) return SKIP;
		node["reality-opts"] = { "public-key": publicKey, "short-id": params.get("sid") ?? "" };
	}
	return node;
}

/** `hysteria2://` / `hy2://` */
function parseHysteria2(uri, name) {
	const { authority, params } = dissect(uri);
	const { userinfo, host } = splitAuthority(authority);
	const target = splitHostPort(host);
	if (!target.host) return SKIP;
	const node = {
		name,
		type: "hysteria2",
		server: target.host,
		port: target.port,
		password: splitUserinfo(userinfo).username
	};
	const sni = params.get("sni") ?? params.get("peer");
	if (sni) node.sni = sni;
	if (truthyParam(params.get("insecure")) || truthyParam(params.get("allowInsecure"))) node["skip-cert-verify"] = true;
	if (params.get("obfs")) node.obfs = params.get("obfs");
	if (params.get("obfs-password")) node["obfs-password"] = params.get("obfs-password");
	if (params.get("alpn")) node.alpn = params.get("alpn").split(",");
	if (params.get("mport") ?? params.get("ports")) node.ports = params.get("mport") ?? params.get("ports");
	return node;
}

/** `socks://` / `socks5://` */
function parseSocks(uri, name) {
	const { authority, params } = dissect(uri);
	const { userinfo, host } = splitAuthority(authority);
	const target = splitHostPort(host);
	if (!target.host) return SKIP;
	const pair = splitUserinfo(userinfo);
	const node = { name, type: "socks5", server: target.host, port: target.port };
	if (pair.username.length > 0) node.username = pair.username;
	if (pair.password.length > 0) node.password = pair.password;
	if (truthyParam(params.get("tls"))) node.tls = true;
	return node;
}

/** `http://` / `https://` 作为节点（不是订阅地址）时使用。 */
function parseHttpNode(uri, name, scheme) {
	const { authority, params } = dissect(uri);
	const { userinfo, host } = splitAuthority(authority);
	const target = splitHostPort(host);
	if (!target.host) return SKIP;
	const pair = splitUserinfo(userinfo);
	const node = { name, type: scheme === "https" ? "http" : "http", server: target.host, port: target.port };
	if (scheme === "https") node.tls = true;
	if (pair.username.length > 0) node.username = pair.username;
	if (pair.password.length > 0) node.password = pair.password;
	if (truthyParam(params.get("allowInsecure"))) node["skip-cert-verify"] = true;
	return node;
}

/**
 * 解析一行分享链接。
 * @returns 节点对象；无法处理时返回 `null`。
 */
export function parseShareLink(line) {
	const text = String(line ?? "").trim();
	const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
	if (schemeMatch === null) return null;
	const scheme = schemeMatch[1].toLowerCase();
	const { hash } = dissect(text);
	const rawName = fragmentName(hash);

	let node = null;
	switch (scheme) {
		case "ss":
			node = parseSs(text, rawName);
			break;
		case "trojan":
			node = parseTrojan(text, rawName);
			break;
		case "vmess":
			node = parseVmess(text, rawName);
			break;
		case "vless":
			node = parseVless(text, rawName);
			break;
		case "hysteria2":
		case "hy2":
			node = parseHysteria2(text, rawName);
			break;
		case "socks":
		case "socks5":
			node = parseSocks(text, rawName);
			break;
		case "http":
		case "https":
			node = parseHttpNode(text, rawName, scheme);
			break;
		default:
			return null;
	}
	if (node === SKIP || node === null) return null;
	if (!node.name || node.name.length === 0) node.name = `${node.server}:${node.port}`;
	if (!Number.isFinite(node.port) || node.port <= 0 || node.port > 65535) return null;
	return node;
}

/**
 * 解析整份分享链接列表。
 *
 * 调用方通常先做一次 base64 解包：本函数**也会**自己做一次，
 * 这样明文列表与 base64 列表都能直接吃。
 * @returns `{ proxies, names, skipped }`；一行都没解析出来时返回 null。
 */
export function parseShareLinkList(raw) {
	let text = String(raw ?? "");
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#"));
	// 整份是 base64（且不是 URI 列表）时先解开。
	const first = lines[0] ?? "";
	if (lines.length <= 2 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(first) && looksBase64(first)) {
		try {
			text = decodeBase64(first);
		} catch {
			return null;
		}
	} else {
		text = raw;
	}
	const candidates = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#"));

	const proxies = [];
	const skipped = [];
	for (const line of candidates) {
		if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
			skipped.push({ line: line.slice(0, 40), reason: "不是分享链接" });
			continue;
		}
		const node = parseShareLink(line);
		if (node === null) {
			const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(line)?.[1] ?? "?";
			skipped.push({ line: `${scheme}://…`, reason: `暂不支持的协议或参数：${scheme}` });
			continue;
		}
		if (typeof node.__unsupported === "string") {
			skipped.push({ line: `${node.type}://…`, reason: node.__unsupported });
			continue;
		}
		delete node.__unsupported;
		proxies.push(node);
	}
	if (proxies.length === 0) return null;
	return { proxies, names: proxies.map((node) => node.name), skipped };
}
