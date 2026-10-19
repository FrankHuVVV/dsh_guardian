#!/usr/bin/env node
/**
 * verify_video_graphs.mjs — 只做"提交阶段"校验：把 H3 视频工作流提交给 ComfyUI，
 * 看是否被接受（有没有缺模型/缺节点/LoRA 名对不上），然后立刻把任务从队列删掉并打断。
 *
 *   node verify_video_graphs.mjs [--source <参考图路径>]
 *
 * 不做完整渲染 —— 这台机器上 H3 一步约 24 分钟，完整渲染不现实。
 */
import fs from "node:fs";

const BASE = "http://127.0.0.1:8188";
const DEPLOY = "C:/Users/28256/.dsh/mcp/comfyui-mcp";
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const caseSrc = arg("source", "C:/Users/28256/Documents/deepseek-harness/default-workspace/comfy-out/QwenImage21_00025_.png");

const cfg = JSON.parse(fs.readFileSync(`${DEPLOY}/config.json`, "utf8"));

/** 把参考图放进 ComfyUI 的 input 目录（ref2v 需要） */
const INPUT = cfg.comfyui.inputDir ?? "D:/ComfyUI_windows_portable/ComfyUI/input";
let refName = null;
if (fs.existsSync(caseSrc)) {
  refName = `dsh_verify_${Date.now().toString(36)}.png`;
  fs.copyFileSync(caseSrc, `${INPUT}/${refName}`);
}

const post = async (u, body) => {
  const r = await fetch(`${BASE}${u}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const t = await r.text();
  let j = null;
  try {
    j = JSON.parse(t);
  } catch {}
  return { status: r.status, json: j, text: t };
};

for (const key of ["h3_t2v", "h3_ref2v"]) {
  const entry = cfg.workflows[key];
  const raw = JSON.parse(fs.readFileSync(`${DEPLOY}/workflows/${key}.api.json`, "utf8"));
  const graph = raw.prompt && typeof raw.prompt === "object" ? raw.prompt : raw;

  // 用最小尺寸/最少帧，仅为了快速通过校验（并尽量缩短模型加载）
  graph[String(entry.width.node)].inputs[entry.width.input] = 512;
  graph[String(entry.height.node)].inputs[entry.height.input] = 288;
  graph[String(entry.length.node)].inputs[entry.length.input] = 24;
  graph[String(entry.steps.node)].inputs[entry.steps.input] = 1;
  if (entry.imageRef) {
    if (!refName) {
      console.log(`⏭  ${key}：没有可用的参考图，跳过`);
      continue;
    }
    const lid = String(entry.imageRef.node);
    graph[lid] = { class_type: "LoadImage", inputs: { image: refName } };
    graph[String(entry.imageRef.consumer)].inputs[entry.imageRef.input] = [lid, 0];
  }

  const res = await post("/prompt", { prompt: graph, client_id: "dsh-verify" });
  const nodeErrors = res.json?.node_errors ?? {};
  const bad = Object.entries(nodeErrors);
  if (res.status === 200 && res.json?.prompt_id && !bad.length) {
    const pid = res.json.prompt_id;
    console.log(`✅ ${key}：提交被接受（prompt_id=${pid}），无 node_errors → 图结构、模型与 LoRA 名全部有效`);
    // 立刻撤销：删队列 + 打断
    await post("/queue", { delete: [pid] });
    await post("/interrupt");
    console.log(`   ↩ 已从队列删除并打断（不做完整渲染）`);
  } else {
    console.log(`❌ ${key}：提交被拒 HTTP ${res.status}`);
    console.log("   error:", JSON.stringify(res.json?.error ?? null).slice(0, 300));
    for (const [nid, e] of bad) console.log(`   节点 ${nid}: ${JSON.stringify(e).slice(0, 300)}`);
  }
}
console.log("\n说明：提交被接受 = ComfyUI 认可这份图（节点类齐全、模型文件存在、LoRA 名匹配）。");
