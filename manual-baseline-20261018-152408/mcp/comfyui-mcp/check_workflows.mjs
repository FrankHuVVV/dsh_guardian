#!/usr/bin/env node
/**
 * check_workflows.mjs — 体检：ComfyUI 里 4 套工作流依赖的节点与模型是否齐备。
 *
 *   node check_workflows.mjs
 *
 * 检查项：
 *  1) 节点类是否存在（/object_info/<class>）
 *  2) 工作流引用的每个模型名是否出现在加载器的可选列表里（含子目录分隔符差异）
 *  3) LoRA 名是否在列表里
 */
import fs from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:8188";
const DEPLOY = "C:/Users/28256/.dsh/mcp/comfyui-mcp";

const j = async (u) => {
  const r = await fetch(`${BASE}${u}`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${u} → HTTP ${r.status}`);
  return r.json();
};

const info = await j("/object_info");
const has = (cls) => !!info[cls];

const WF = {
  qwen_t2i: `${DEPLOY}/workflow.api.json`,
  qwen_edit: `${DEPLOY}/workflow.api.json`,
  h3_t2v: `${DEPLOY}/workflows/h3_t2v.api.json`,
  h3_ref2v: `${DEPLOY}/workflows/h3_ref2v.api.json`,
};

// 加载器可选列表
const lists = {
  unet: info.UnetLoaderGGUF?.input?.required?.unet_name?.[0] ?? [],
  clip: {
    CLIPLoader: info.CLIPLoader?.input?.required?.clip_name?.[0] ?? [],
    CLIPLoaderGGUF: info.CLIPLoaderGGUF?.input?.required?.clip_name?.[0] ?? [],
  },
  vae: info.VAELoader?.input?.required?.vae_name?.[0] ?? [],
  lora: info.LoraLoaderModelOnly?.input?.required?.lora_name?.[0] ?? [],
};
console.log("=== 加载器可选数量 ===");
console.log(`  unet ${lists.unet.length} | clip(CLIPLoader) ${lists.clip.CLIPLoader.length} | clip(GGUF) ${lists.clip.CLIPLoaderGGUF.length} | vae ${lists.vae.length} | lora ${lists.lora.length}`);

/** ComfyUI 在 Windows 上可能返回反斜杠，也可能返回正斜杠，统一比较 */
const same = (a, b) => {
  const norm = (s) => String(s).replace(/[\\/]+/g, "/").toLowerCase();
  return norm(a) === norm(b);
};
const inList = (list, name) => list.some((x) => same(x, name));
const findIn = (list, name) => list.find((x) => same(x, name)) ?? null;

const problems = [];
for (const [key, file] of Object.entries(WF)) {
  if (!fs.existsSync(file)) {
    problems.push(`${key}: 工作流文件不存在 ${file}`);
    continue;
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const g = raw.prompt && typeof raw.prompt === "object" ? raw.prompt : raw;
  console.log(`\n=== ${key}（${path.basename(file)}，${Object.keys(g).length} 个节点）===`);

  const classes = [...new Set(Object.values(g).map((n) => n.class_type))];
  const missingNodes = classes.filter((c) => !has(c));
  console.log(`  节点类 ${classes.length} 个${missingNodes.length ? `，缺 ${missingNodes.join(", ")}` : "，全部存在 ✅"}`);
  if (missingNodes.length) problems.push(`${key}: 缺节点类 ${missingNodes.join(", ")}`);

  for (const [id, node] of Object.entries(g)) {
    const inp = node.inputs ?? {};
    const cf = node.class_type;
    let list = null;
    let name = null;
    let label = null;
    if (cf === "UnetLoaderGGUF") (list = lists.unet), (name = inp.unet_name), (label = "unet");
    else if (cf === "CLIPLoader" || cf === "CLIPLoaderGGUF") (list = lists.clip[cf]), (name = inp.clip_name), (label = `clip(${cf})`);
    else if (cf === "VAELoader") (list = lists.vae), (name = inp.vae_name), (label = "vae");
    else if (/LoraLoader/.test(cf)) (list = lists.lora), (name = inp.lora_name), (label = "lora");
    if (!list || !name) continue;
    if (!inList(list, name)) {
      console.log(`  ❌ 节点 ${id} ${label}: ${name} —— 不在列表里（相似候选：${list.filter((x) => String(x).split(/[\\/]/).pop().toLowerCase() === String(name).split(/[\\/]/).pop().toLowerCase()).join(" | ") || "无"}）`);
      problems.push(`${key} 节点${id} ${label} 找不到 ${name}`);
    } else {
      const actual = findIn(list, name);
      console.log(`  ✅ 节点 ${id} ${label}: ${name}`);
      if (actual !== name) console.log(`     （列表中实际写作：${actual}）`);
    }
  }
}

console.log("\n=== 结论 ===");
if (!problems.length) console.log("全部通过：节点与模型引用都能对上 ✅");
else {
  console.log(`发现 ${problems.length} 处问题：`);
  for (const p of problems) console.log(" - " + p);
}
