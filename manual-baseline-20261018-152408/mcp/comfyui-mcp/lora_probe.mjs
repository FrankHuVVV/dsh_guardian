#!/usr/bin/env node
/**
 * lora_probe.mjs — 逐个检测 LoRA 能不能被 ComfyUI 正确加载。
 *
 * 对每个 LoRA 提交一次极短任务（默认 512² / 1 步），并读取 ComfyUI 控制台在这段时间里
 * 新写入的内容，统计 `lora key not loaded` 的条数 —— 那就是没能映射到模型上的键。
 *
 *   node lora_probe.mjs [--size 512] [--steps 1] [--strength 1.0] [--loras a.safetensors,b.safetensors]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const BASE = String(cfg.comfyui.baseURL).replace(/\/+$/, "");
/**
 * ComfyUI 控制台日志的路径：优先用「运行副本」那一份（MCP 服务在部署目录里跑，
 * 它把 ComfyUI 的 stdout/stderr 写到自己目录下的 launchLogFile）。
 * 只按脚本自身目录解析会读到工作区里的另一份空文件 —— 之前就栽在这里。
 */
function resolveLog() {
  const name = path.basename(cfg.comfyui.lifecycle?.launchLogFile ?? "comfyui-launch.log");
  const candidates = [
    arg("log", null),
    path.join(os.homedir(), ".dsh", "mcp", "comfyui-mcp", name),
    path.resolve(__dirname, name),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c) && fs.statSync(c).size > 0) return c;
  return candidates[candidates.length - 1];
}
const LOG = resolveLog();
const size = Number(arg("size", 512));
const steps = Number(arg("steps", 1));
const strength = Number(arg("strength", 1.0));
const only = arg("loras", "");

// 工作流模板（部署目录里的那份）
const wfRaw = JSON.parse(fs.readFileSync(path.resolve(__dirname, cfg.comfyui.apiWorkflowFile), "utf8"));
const template = wfRaw.prompt && typeof wfRaw.prompt === "object" ? wfRaw.prompt : wfRaw;

const listRes = await fetch(`${BASE}/object_info/LoraLoaderModelOnly`, { signal: AbortSignal.timeout(15000) });
const loraList = (await listRes.json())?.LoraLoaderModelOnly?.input?.required?.lora_name?.[0] ?? [];
const targets = only ? only.split(",").map((s) => s.trim()).filter(Boolean) : loraList;
console.log(`待测 LoRA：${targets.length} 个（${size}² / ${steps} 步 / strength ${strength}）\n`);

function buildGraph(loraName) {
  const g = structuredClone(template);
  g["9"] = { class_type: "DshEmptyQwenImage21Latent", inputs: { width: size, height: size, batch_size: 1 } };
  g["4"].inputs.prompt = "a stone lantern in a mossy garden after rain, overcast light, detailed";
  g["4"].inputs.negative_prompt = "模糊, 低质量";
  g["4"].inputs.resolution = size;
  g["5"].inputs.steps = steps;
  g["5"].inputs.cfg = 1;
  g["5"].inputs.noise_seed = 1234;
  g["5"].inputs.end_at_step = steps;
  if (g["11"]) g["11"].inputs = { ...g["11"].inputs, steps, start_at_step: steps, end_at_step: 10000 };
  // 插入 LoRA
  g["lora1"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: loraName, strength_model: strength } };
  for (const nid of ["5", "11"]) if (g[nid]?.inputs) g[nid].inputs.model = ["lora1", 0];
  for (const nid of ["6", "7"]) if (g[nid]?.inputs) g[nid].inputs.filename_prefix = `LORA_PROBE_${loraName.replace(/[^A-Za-z0-9]/g, "_").slice(0, 24)}`;
  return g;
}

const results = [];
// 日志可能滞后于任务完成，所以用"累计计数 + 差集"来归属，而不是按字节窗口切。
function readUnmatched() {
  const counts = new Map();
  try {
    const txt = fs.readFileSync(LOG, "utf8");
    for (const m of txt.matchAll(/lora key not loaded: (\S+)/g)) {
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
  } catch {}
  return counts;
}
const diffSince = (prev, next) => {
  const out = [];
  for (const [k, c] of next) {
    const d = c - (prev.get(k) ?? 0);
    if (d > 0) out.push([k, d]);
  }
  return out;
};
// 基线：历史日志里已有的未匹配键不算到本次头上
let seenCounts = readUnmatched();
if (seenCounts.size) {
  console.log(`（基线：日志里已有 ${[...seenCounts.values()].reduce((a, b) => a + b, 0)} 行历史未匹配键，只统计新增）\n`);
}

for (const lora of targets) {
  const t0 = Date.now();
  let status = "?";
  try {
    const res = await fetch(`${BASE}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: buildGraph(lora), client_id: "lora-probe" }),
    });
    const j = await res.json();
    if (!res.ok || Object.keys(j.node_errors ?? {}).length) {
      status = `提交被拒：${JSON.stringify(j.error ?? j.node_errors).slice(0, 160)}`;
    } else {
      const pid = j.prompt_id;
      while (true) {
        await new Promise((r) => setTimeout(r, 1500));
        const h = await (await fetch(`${BASE}/history/${pid}`)).json();
        const e = h[pid];
        if (e) {
          if (e.status?.status_str === "error") {
            status = `执行失败：${JSON.stringify(e.status.messages).slice(0, 160)}`;
            break;
          }
          if (Object.values(e.outputs ?? {}).some((o) => o.images?.length)) {
            status = "OK";
            break;
          }
        }
        if (Date.now() - t0 > 6 * 60 * 1000) {
          status = "超时";
          break;
        }
      }
    }
  } catch (err) {
    status = `异常：${err?.message}`;
  }

  await new Promise((r) => setTimeout(r, 2500)); // 等控制台把警告写完
  const now = readUnmatched();
  const added = diffSince(seenCounts, now);
  seenCounts = now;
  const missing = added.reduce((a, [, c]) => a + c, 0);
  const firstMissing = added[0]?.[0] ?? null;
  const applied = missing ? "部分键未加载" : "全部键已加载";

  results.push({ lora, status, missingKeys: missing, firstMissing, applied, sec: ((Date.now() - t0) / 1000).toFixed(0) });
  console.log(
    `${status === "OK" ? "✅" : "❌"} ${lora}\n     用时 ${((Date.now() - t0) / 1000).toFixed(0)}s | ${applied}` +
      (missing ? ` | 未加载键 ${missing} 个，例如 ${firstMissing}` : ""),
  );
}

console.log("\n=== 汇总 ===");
for (const r of results) {
  const verdict = r.status !== "OK" ? `执行问题：${r.status}` : r.missingKeys > 0 ? `可用（${r.missingKeys} 个键未匹配）` : "完全可用";
  console.log(`${r.lora.padEnd(52)} ${verdict}`);
}
