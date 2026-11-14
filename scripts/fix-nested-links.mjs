#!/usr/bin/env node
/**
 * 修复 profile 里被 pnpm 留下「空壳」的嵌套依赖目录。
 *
 * 背景：DSH 的插件加载器**按每个包自己声明的 dependencies 构造路径**
 * （`<包>/node_modules/<依赖>/<main>`）并直接 open；而 pnpm 的扁平布局有时只
 * 建出空目录、不填内容。于是会出现：
 *
 *   ENOENT: open '...\node_modules\@having5548\dsh-downloader\node_modules\
 *                 @deepseek-ai\schemastery\lib\index.mjs'
 *
 * 现象是插件「failed to import」、整条 entry 不激活（连带其它插件也报同一路径）。
 *
 * 本脚本把「缺的嵌套依赖」指回顶层的同名包（Windows 用 junction，其它平台用
 * 符号链接）。可反复执行：已经正确的会跳过。
 *
 * 用法：
 *   node scripts/fix-nested-links.mjs                  # 修当前目录下的 node_modules
 *   node scripts/fix-nested-links.mjs <profileDir>     # 修指定 profile
 *   node scripts/fix-nested-links.mjs --dry-run        # 只看要做什么
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const profileDir = resolve(args.find((arg) => !arg.startsWith("--")) ?? process.cwd());
const modules = join(profileDir, "node_modules");

if (!existsSync(modules)) {
	console.error(`找不到 ${modules} —— 参数应当是 profile 目录（含 node_modules 的那层）`);
	process.exit(1);
}

/** 枚举 node_modules 下的包目录（含 @scope/name 形式）。 */
function listPackages() {
	const found = [];
	for (const entry of readdirSync(modules, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (entry.name === ".bin" || entry.name.startsWith(".")) continue;
		if (entry.name.startsWith("@")) {
			for (const inner of readdirSync(join(modules, entry.name), { withFileTypes: true })) {
				if (inner.isDirectory()) found.push(`${entry.name}/${inner.name}`);
			}
			continue;
		}
		found.push(entry.name);
	}
	return found;
}

function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function link(from, to) {
	if (process.platform === "win32") {
		execFileSync("cmd", ["/c", "mklink", "/J", from, to], { stdio: "pipe" });
		return;
	}
	execFileSync("ln", ["-s", to, from], { stdio: "pipe" });
}

const fixed = [];
const skipped = [];

for (const name of listPackages()) {
	const pkgDir = join(modules, name);
	const manifest = readJson(join(pkgDir, "package.json"));
	if (manifest === null) continue;
	const deps = Object.keys(manifest.dependencies ?? {});
	if (deps.length === 0) continue;

	for (const dep of deps) {
		const nested = join(pkgDir, "node_modules", dep);
		const hoisted = join(modules, dep);
		// 已经有内容就不管；只有「不存在 / 空目录 / 断链」才修。
		let needsFix = false;
		if (!existsSync(nested)) {
			needsFix = true;
		} else {
			try {
				const stat = lstatSync(nested);
				if (stat.isDirectory() && readdirSync(nested).length === 0) needsFix = true;
			} catch {
				needsFix = true;
			}
		}
		if (!needsFix) continue;
		if (!existsSync(hoisted)) {
			skipped.push(`${dep}（顶层也没有）`);
			continue;
		}
		if (statSync(hoisted) === undefined) continue;
		const parent = dirname(nested);
		const relative = `${name} → ${dep}`;
		if (dryRun) {
			fixed.push(`[dry-run] ${relative}`);
			continue;
		}
		try {
			if (existsSync(nested)) {
				// 空目录：先删掉再建链接
				execFileSync(process.platform === "win32" ? "cmd" : "rm", process.platform === "win32" ? ["/c", "rmdir", nested] : ["-rf", nested], { stdio: "pipe" });
			}
			if (!existsSync(parent)) {
				execFileSync(process.platform === "win32" ? "cmd" : "mkdir", process.platform === "win32" ? ["/c", "mkdir", parent] : ["-p", parent], { stdio: "pipe" });
			}
			link(nested, hoisted);
			fixed.push(relative);
		} catch (error) {
			skipped.push(`${relative} —— ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

console.log(`profile: ${profileDir}`);
console.log(`已修 ${fixed.length} 条${dryRun ? "（干跑）" : ""}`);
for (const line of fixed) console.log(`  + ${line}`);
if (skipped.length > 0) {
	console.log(`跳过 ${skipped.length} 条`);
	for (const line of skipped) console.log(`  - ${line}`);
}
console.log("");
console.log("修完重启 DSH，或对受影响的插件重新启用一次。");
