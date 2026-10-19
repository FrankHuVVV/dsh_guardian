#!/usr/bin/env node
/**
 * lora_stack_bench.mjs — 实测"同时叠加多个 LoRA"的开销。
 *
 * 同一提示词/尺寸下对比：0 个 → 1 个 → 3 个 → 11 个（全部），并另插两组不同步数，
 * 用来区分「一次性打补丁成本」与「每步采样成本」。
 * 每次记录：墙钟耗时、ComfyUI 自报的 Prompt executed、显存占用、新增未匹配键数。
 *
 *   node lora_stack_bench.mjs --size 512 --steps 12 --seed 2024
 *
 * 注意两点（都踩过）：
 *  1) 每次必须换种子，否则 ComfyUI 命中执行缓存会直接返回上一张图（"3 秒跑完"是假的）。
 *  2) 显存走 HTTP /system_stats —— 沙箱下 Node 捕获 nvidia-smi 输出会 EPERM。
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
const size = Number(arg("size", 512));
const steps = Number(arg("steps", 12));
const seed = Number(arg("seed", 2024));

function resolveLog() {
  const name = path.basename(cfg.comfyui.lifecycle?.launchLogFile ?? "comfyui-launch.log");
  const cands = [
    arg("log", null),
    path.join(os.homedir(), ".dsh", "mcp", "comfyui-mcp", name),
    path.resolve(__dirname, name),
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c) && fs.statSync(c).size > 0) return c;
  return cands[cands.length - 1];
}
const LOG = resolveLog();

const wfRaw = JSON.parse(fs.readFileSync(path.resolve(__dirname, cfg.comfyui.apiWorkflowFile), "utf8"));
const template = wfRaw.prompt && typeof wfRaw.prompt === "object" ? wfRaw.prompt : wfRaw;

const loraRes = await fetch(`${BASE}/object_info/LoraLoaderModelOnly`, { signal: AbortSignal.timeout(15000) });
const ALL = (await loraRes.json())?.LoraLoaderModelOnly?.input?.required?.lora_name?.[0] ?? [];
console.log(`ComfyUI 可见 LoRA：${ALL.length} 个；测试尺寸 ${size}²，基准步数 ${steps}\n`);

const SCENARIOS = [
  { label: "0 个 / 12 步", loras: [], steps: 12 },
  { label: "1 个 / 12 步", loras: [["RadianceChromeVoluptuous_QwenImage2.1_v1.0.safetensors", 0.8]], steps: 12 },
  {
    label: "3 个 / 12 步",
    steps: 12,
    loras: [
      ["RadianceChromeVoluptuous_QwenImage2.1_v1.0.safetensors", 0.8],
      ["Qwen-Image-2.1-Natural-Exposure-LoRA-4000.safetensors", 0.6],
      ["Qwen2.1_Anything2RealCharacters_split.safetensors", 0.5],
    ],
  },
  { label: "11 个 / 12 步 (a)", loras: ALL.map((n) => [n, 1.0]), steps: 12 },
  { label: "11 个 / 12 步 (b)", loras: ALL.map((n) => [n, 1.0]), steps: 12 },
  { label: "11 个 / 25 步", loras: ALL.map((n) => [n, 1.0]), steps: 25 },
  { label: "0 个 / 25 步", loras: [], steps: 25 },
];

function buildGraph(loras, nSteps, runSeed) {
  const g = structuredClone(template);
  const split = Math.max(1, Math.round(nSteps * 0.56));
  g["9"] = { class_type: "DshEmptyQwenImage21Latent", inputs: { width: size, height: size, batch_size: 1 } };
  g["4"].inputs.prompt = "a stone lantern in a mossy temple garden after rain, overcast light, detailed";
  g["4"].inputs.negative_prompt = "模糊, 低质量";
  g["4"].inputs.resolution = size;
  g["5"].inputs.steps = nSteps;
  g["5"].inputs.cfg = 1;
  g["5"].inputs.noise_seed = runSeed;
  g["5"].inputs.end_at_step = split;
  if (g["11"]) {
    g["11"].inputs = {
      ...g["11"].inputs,
      steps: nSteps,
      cfg: 1,
      noise_seed: runSeed,
      start_at_step: split,
      end_at_step: 10000,
    };
  }
  let prev = ["1", 0];
  let i = 0;
  for (const [name, strength] of loras) {
    const id = `lora${++i}`;
    g[id] = {
      class_type: "LoraLoaderModelOnly",
      inputs: { model: prev, lora_name: name, strength_model: strength },
    };
    prev = [id, 0];
  }
  for (const nid of ["5", "11"]) if (g[nid]?.inputs) g[nid].inputs.model = prev;
  g["7"].inputs.filename_prefix = "LORA_BENCH";
  return g;
}

const vramUsed = async () => {
  try {
    const s = await (await fetch(`${BASE}/system_stats`, { signal: AbortSignal.timeout(5000) })).json();
    const d = s.devices?.[0];
    return d ? Math.round((d.vram_total - d.vram_free) / 1048576) : null;
  } catch {
    return null;
  }
};

const unmatchedCount = () => {
  try {
    return (fs.readFileSync(LOG, "utf8").match(/lora key not loaded/g) ?? []).length;
  } catch {
    return 0;
  }
};

const rows = [];
let idx = 0;
for (const sc of SCENARIOS) {
  idx++;
  const beforeUnmatched = unmatchedCount();
  const t0 = Date.now();
  let status = "?";
  let promptId = null;
  try {
    const res = await fetch(`${BASE}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: buildGraph(sc.loras, sc.steps ?? steps, seed + idx * 7919),
        client_id: "lora-bench",
      }),
    });
    const j = await res.json();
    promptId = j.prompt_id;
    if (!res.ok || Object.keys(j.node_errors ?? {}).length) {
      status = `被拒：${JSON.stringify(j.error ?? j.node_errors).slice(0, 200)}`;
    } else {
      while (true) {
        await new Promise((r) => setTimeout(r, 1000));
        const h = await (await fetch(`${BASE}/history/${promptId}`)).json();
        const e = h[promptId];
        if (e) {
          if (e.status?.status_str === "error") {
            status = `失败：${JSON.stringify(e.status.messages).slice(0, 200)}`;
            break;
          }
          if (Object.values(e.outputs ?? {}).some((o) => o.images?.length)) {
            status = "OK";
            break;
          }
        }
        if (Date.now() - t0 > 10 * 60 * 1000) {
          status = "超时";
          break;
        }
      }
    }
  } catch (err) {
    status = `异常：${err?.message}`;
  }

  await new Promise((r) => setTimeout(r, 2000));
  const wall = (Date.now() - t0) / 1000;
  const txt = (() => {
    try {
      return fs.readFileSync(LOG, "utf8");
    } catch {
      return "";
    }
  })();
  const execMatches = [...txt.matchAll(/Prompt executed in ([\d.]+) seconds/g)].map((m) => Number(m[1]));
  const exec = execMatches.length ? execMatches[execMatches.length - 1] : null;
  const unmatched = unmatchedCount() - beforeUnmatched;
  const vram = await vramUsed();

  rows.push({ label: sc.label, n: sc.loras.length, steps: sc.steps ?? steps, status, wall, exec, unmatched, vram });
  console.log(
    `${status === "OK" ? "✅" : "❌"} ${sc.label.padEnd(18)} 链式 ${String(sc.loras.length).padStart(2)} 个 | ` +
      `墙钟 ${wall.toFixed(1)}s | 执行 ${exec ?? "?"}s | 显存 ${vram ?? "?"} MiB | 新增未匹配键 ${unmatched}`,
  );
}

console.log("\n=== 汇总 ===");
console.log("场景".padEnd(20) + "LoRA数  步数   墙钟s   执行s  显存MiB  新增未匹配键");
for (const r of rows) {
  console.log(
    r.label.padEnd(20) +
      String(r.n).padStart(5) +
      String(r.steps).padStart(6) +
      r.wall.toFixed(1).padStart(8) +
      String(r.exec ?? "?").padStart(8) +
      String(r.vram ?? "?").padStart(9) +
      String(r.unmatched).padStart(14),
  );
}

const find = (label) => rows.find((r) => r.label === label);
const a12 = find("0 个 / 12 步");
const a25 = find("0 个 / 25 步");
const b12 = find("11 个 / 12 步 (b)");
const b25 = find("11 个 / 25 步");
if (a12?.exec && a25?.exec && b12?.exec && b25?.exec) {
  const baseSlope = (a25.exec - a12.exec) / 13;
  const loraSlope = (b25.exec - b12.exec) / 13;
  console.log("\n=== 成本拆解 ===");
  console.log(
    `每步采样：无 LoRA ${baseSlope.toFixed(2)} s/步 → 11 个 LoRA ${loraSlope.toFixed(2)} s/步（${(loraSlope / baseSlope).toFixed(2)}×）`,
  );
  console.log(
    `一次性开销（打补丁+反量化重算）：11 个 LoRA 在 12 步那次比无 LoRA 多约 ${(b12.exec - a12.exec - (loraSlope - baseSlope) * 12).toFixed(1)} s`,
  );
}
