#!/usr/bin/env node
/**
 * verify-patch.mjs — 用 dsh-app-boot 真正的 patch 应用函数预演一次，
 * 确认 mcp-comfyui 这次真的会被插入（而不是又被忽略）。
 */
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire("C:/Users/28256/.dsh/profiles/desktop/package.json");
const YAML = require("yaml");

const patchPath = "C:/Users/28256/.dsh/profiles/desktop/cordis.patch.yml";
const patches = YAML.parse(fs.readFileSync(patchPath, "utf8"));
console.log(`patch 文件解析 OK：${patches.length} 条 patch 指令`);
for (const p of patches) {
  console.log(`  - ${p.insert ? "insert" : `id:${p.id}`}${p.insert ? ` (${p.insert.length} 条)` : ""}`);
}

// 代表性地基：desktop profile 由 dsh-base + dsh-web-app 等 bundle 组合而来
const base = [
  { id: "ui-settings-general", name: "@deepseek-ai/dsh-client-ui-settings-general", config: { welcomeNoticeVersion: "2026-08-13.1" } },
  { id: "desktop-shell", name: "dsh-plugin-desktop", config: { mode: "advanced" } },
  { id: "desktop-notifications", name: "dsh-plugin-desktop/notifications", config: { enabled: true } },
  { id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai", config: {} },
  { id: "agent-default-model", name: "@deepseek-ai/dsh-agent-default-model", config: { provider: "deepseek-official", model: "deepseek-flash" } },
];

let apply = null;
try {
  const mod = require("@deepseek-ai/dsh-app-boot");
  apply = mod.applyEntryPatches ?? mod.applyPatches;
  console.log(`\ndsh-app-boot 导出：${Object.keys(mod).filter((k) => /patch/i.test(k)).join(", ") || "(无 patch 相关导出)"}`);
} catch (err) {
  console.log(`\n无法加载 dsh-app-boot：${err.message}`);
}

if (apply) {
  const warns = [];
  const out = apply(base, patches, (fmt, ...args) => warns.push(fmt.replace("%C", args[0])));
  const inserted = out.find((e) => e.id === "mcp-comfyui");
  console.log(`\n应用结果：${base.length} → ${out.length} 条`);
  console.log(`警告：${warns.length ? warns.join(" | ") : "（无）"}`);
  if (inserted) {
    console.log("插入成功，name =", inserted.name);
    console.log("config =", JSON.stringify(inserted.config, null, 2));
  } else {
    console.log("❌ 没有插入 mcp-comfyui");
    process.exitCode = 1;
  }
}

// 插件本体能否从该 profile 解析到
try {
  console.log("\ndsh-mcp-client 解析路径：", require.resolve("@deepseek-ai/dsh-mcp-client"));
} catch (err) {
  console.log("\n❌ 无法解析 @deepseek-ai/dsh-mcp-client：", err.message);
  process.exitCode = 1;
}
