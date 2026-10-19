#!/usr/bin/env node
/**
 * verify-lifecycle.mjs — 验证"服务退出会带走自启的 ComfyUI"。
 *
 * 做法：文件承载 stdio 起一个 server 实例，让它执行 comfyui_power start，
 * 然后立刻 EOF（等价于宿主关闭 stdin）。server 必须先把在途调用跑完，
 * 再在退出时 taskkill 掉自己拉起的 ComfyUI。
 *
 *   node verify-lifecycle.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stamp = `${process.pid}-${Date.now()}`;
const inFile = path.join(os.tmpdir(), `life-in-${stamp}.jsonl`);
const outFile = path.join(os.tmpdir(), `life-out-${stamp}.jsonl`);

const messages = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "lifecycle-check", version: "1" } },
  },
  { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "comfyui_power", arguments: { action: "start" } } },
];
fs.writeFileSync(inFile, `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`, "utf8");

const fdIn = fs.openSync(inFile, "r");
const fdOut = fs.openSync(outFile, "w");
const child = spawn(process.execPath, [path.join(__dirname, "server.mjs")], {
  cwd: __dirname,
  stdio: [fdIn, fdOut, "inherit"],
});

const base = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")).comfyui.baseURL;
  } catch {
    return "http://127.0.0.1:8188";
  }
})();

async function online() {
  try {
    const res = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

child.on("exit", async (code) => {
  clearTimeout(timer);
  const lines = fs
    .readFileSync(outFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const call = lines.find((m) => m.id === 2);
  console.log("comfyui_power start →", (call?.result?.content?.[0]?.text ?? "(无回答)").slice(0, 200));
  console.log(`server 退出码 ${code}`);

  await new Promise((r) => setTimeout(r, 2500));
  const stillUp = await online();
  console.log(stillUp ? "❌ 服务退出后 ComfyUI 仍在运行（自愈会兜住，但退出钩子没生效）" : "✅ 服务退出后 ComfyUI 已被带走");
  process.exit(stillUp ? 1 : 0);
});

const timer = setTimeout(() => {
  console.error("超时：120s 内未见 server 退出");
  child.kill();
}, 120000);
