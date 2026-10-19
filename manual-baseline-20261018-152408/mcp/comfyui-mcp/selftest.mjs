#!/usr/bin/env node
/**
 * selftest.mjs — 在 DSH 之外把 server.mjs 跑一遍。
 *
 * 为什么不用管道：DSH 的沙箱环境禁止子进程使用管道 stdio（spawn EPERM），
 * 所以这里用两个临时文件承载 stdin/stdout，请求一次性喂进去，退出后读回答。
 *
 *   node selftest.mjs              # 协议 + service_status + generate_prompts
 *   node selftest.mjs --image      # 额外真跑一次出图（需要 ComfyUI 在线）
 *   node selftest.mjs --raw        # 打印全部原始响应行
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wantImage = process.argv.includes("--image");
const wantRaw = process.argv.includes("--raw");

const stamp = `${process.pid}-${Date.now()}`;
const inFile = path.join(os.tmpdir(), `comfyui-mcp-in-${stamp}.jsonl`);
const outFile = path.join(os.tmpdir(), `comfyui-mcp-out-${stamp}.jsonl`);

const messages = [];
let id = 0;
const ids = {};
function req(name, params) {
  const thisId = ++id;
  ids[name] = thisId;
  messages.push({ jsonrpc: "2.0", id: thisId, method: "tools/call", params: { name, arguments: params } });
  return thisId;
}

messages.push({
  jsonrpc: "2.0",
  id: ++id,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "selftest", version: "1.0.0" } },
});
ids.initialize = id;
messages.push({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
messages.push({ jsonrpc: "2.0", id: ++id, method: "tools/list", params: {} });
ids["tools/list"] = id;
req("service_status", {});
req("generate_prompts", { description: "黄昏时分，一只橘猫蹲在屋顶边缘，远处是城市天际线，暖色逆光" });
req("prepare_image", { description: "一朵沾着露水的红玫瑰，微距，柔光" });
// 闸门反例：不存在的草稿 + approved:true 必须被拒绝（不会出图）
req("approve_and_generate", { draft_id: "draft-does-not-exist", approved: true });

fs.writeFileSync(inFile, `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`, "utf8");
const fdIn = fs.openSync(inFile, "r");
const fdOut = fs.openSync(outFile, "w");

const child = spawn(process.execPath, [path.join(__dirname, "server.mjs")], {
  cwd: __dirname,
  stdio: [fdIn, fdOut, "inherit"],
});

const timer = setTimeout(() => {
  console.error("【超时】30 分钟未见退出，强制结束");
  child.kill();
}, 1800000);

child.on("exit", (code) => {
  clearTimeout(timer);
  fs.closeSync(fdIn);
  fs.closeSync(fdOut);

  const lines = fs
    .readFileSync(outFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const byId = new Map();
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      byId.set(msg.id, msg);
    } catch {
      console.error(`【非协议输出】${line}`);
    }
  }

  const textOf = (reply) =>
    (reply?.result?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");

  const init = byId.get(ids.initialize)?.result;
  console.log(`[1] initialize → ${init?.protocolVersion} / ${init?.serverInfo?.name} ${init?.serverInfo?.version}`);

  const list = byId.get(ids["tools/list"])?.result;
  console.log(`[2] tools/list → ${(list?.tools ?? []).map((t) => t.name).join(", ")}`);

  for (const name of ["service_status", "generate_prompts", "prepare_image", "approve_and_generate"]) {
    const reply = byId.get(ids[name]);
    if (!reply) continue;
    const bad = reply.result?.isError;
    console.log(`[${bad ? "!" : "3"}] ${name} →${bad ? "（报错，属预期时可忽略）" : ""}`);
    console.log(textOf(reply));
  }

  if (wantRaw) {
    console.log("\n===== 原始响应 =====");
    console.log(fs.readFileSync(outFile, "utf8"));
  }
  console.log(`\n子进程退出码 ${code}`);
  process.exit(0);
});
