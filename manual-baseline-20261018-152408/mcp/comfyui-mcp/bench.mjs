#!/usr/bin/env node
/**
 * bench.mjs — 直接对 ComfyUI 跑固定参数的一次出图，用于对比显存竞争的影响。
 *
 *   node bench.mjs [--resolution 768] [--steps 10] [--label with-ollama]
 *
 * 固定 seed，重复运行可比较耗时。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const base = String(cfg.comfyui.baseURL).replace(/\/+$/, "");
const resolution = Number(arg("resolution", 768));
const steps = Number(arg("steps", 10));
const label = arg("label", "run");
const seed = Number(arg("seed", 123456));

const graph = JSON.parse(fs.readFileSync(path.join(__dirname, "workflow.api.json"), "utf8"));
graph[cfg.comfyui.promptNodeId].inputs.prompt = "a red rose with dew drops, macro, soft light";
graph[cfg.comfyui.promptNodeId].inputs.negative_prompt = "低清, 模糊, 文字";
graph[cfg.comfyui.promptNodeId].inputs.resolution = resolution;
graph[cfg.comfyui.seedNodeId].inputs.seed = seed;
graph[cfg.comfyui.seedNodeId].inputs.steps = steps;

const t0 = Date.now();
const submit = await fetch(`${base}/prompt`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt: graph, client_id: "bench" }),
});
const submitJson = await submit.json();
if (!submit.ok) {
  console.error("提交失败：", JSON.stringify(submitJson).slice(0, 500));
  process.exit(1);
}
const promptId = submitJson.prompt_id;
console.log(`[${label}] 已提交 ${promptId}，分辨率 ${resolution}，步数 ${steps}`);

let first = null;
while (true) {
  const res = await fetch(`${base}/history/${promptId}`);
  const entry = (await res.json())[promptId];
  if (entry) {
    const images = Object.values(entry.outputs || {}).flatMap((o) => o.images || []);
    if (images.length) {
      console.log(`[${label}] 完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${images[0].filename}`);
      break;
    }
    if (entry.status?.status_str === "error") {
      console.error(`[${label}] 执行失败：${JSON.stringify(entry.status.messages).slice(0, 400)}`);
      process.exit(1);
    }
  }
  if (!first) first = Date.now();
  await new Promise((r) => setTimeout(r, 1000));
}
