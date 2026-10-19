#!/usr/bin/env node
/**
 * add_lora_node.mjs — 在 UI 工作流里接一个 LoraLoaderModelOnly（默认旁路 mode=4）。
 *
 *   UnetLoaderGGUF → LoRA → 每个采样节点（前段/后段各自独立连线）
 *
 * 同时修一处接线问题：上一版脚本让两个采样节点共用了一个 link id（其中一个实际是悬空的），
 * 这里按节点类型动态找出所有采样节点，各给一条独立连线。
 *
 *   node add_lora_node.mjs [--restore <备份路径>]
 *
 * 改前备份。API 工作流的 LoRA 由 server.mjs 每次调用动态插入。
 */
import fs from "node:fs";

const UI_WF = "D:/ComfyUI_windows_portable/ComfyUI/user/default/workflows/Qwen-Image-2.1-UC-GGUF-T2I.json";
const DEFAULT_LORA = "Qwen-Image-2.1-Natural-Exposure-LoRA-4000.safetensors";
const SAMPLER_TYPES = new Set(["KSamplerAdvanced", "KSampler"]);
const TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

const argv = process.argv.slice(2);
const restoreIdx = argv.indexOf("--restore");
if (restoreIdx >= 0 && argv[restoreIdx + 1]) {
  const src = argv[restoreIdx + 1];
  const bak = `${UI_WF}.bak-${TS}`;
  fs.copyFileSync(UI_WF, bak);
  fs.copyFileSync(src, UI_WF);
  console.log(`已从 ${src} 恢复；当前状态另存为 ${bak.split("/").pop()}`);
}

const wf = JSON.parse(fs.readFileSync(UI_WF, "utf8"));
fs.copyFileSync(UI_WF, `${UI_WF}.bak-${TS}`);

const n1 = wf.nodes.find((n) => n.id === 1);
if (!n1) throw new Error("找不到节点 1（UnetLoaderGGUF）");
const samplers = wf.nodes.filter((n) => SAMPLER_TYPES.has(n.type));
if (!samplers.length) throw new Error("没找到任何采样节点");
const existing = wf.nodes.find((n) => n.type === "LoraLoaderModelOnly");
if (existing) {
  console.log(`已有 LoraLoaderModelOnly（节点 ${existing.id}），先移除再重建`);
  wf.nodes = wf.nodes.filter((n) => n !== existing);
  wf.links = wf.links.filter((l) => l[1] !== existing.id && l[3] !== existing.id);
}

const nextId = () => Math.max(...wf.nodes.map((n) => n.id)) + 1;
const nextLink = () => Math.max(0, ...wf.links.map((l) => l[0])) + 1;
const LORA_ID = nextId();

// 1) 清掉旧的 model 连线（任何来源 → 采样节点的 slot 0），并清空节点 1 的输出连线
const stale = wf.links.filter((l) => samplers.some((s) => s.id === l[3]) && l[4] === 0);
wf.links = wf.links.filter((l) => !stale.includes(l));
n1.outputs[0].links = [];

// 2) 连线：1 → LoRA → 各采样节点
const linkIn = nextLink();
wf.links.push([linkIn, 1, 0, LORA_ID, 0, "MODEL"]);
n1.outputs[0].links = [linkIn];

const loraOutLinks = [];
for (const sNode of samplers) {
  const modelIn = sNode.inputs.find((i) => i.name === "model");
  if (!modelIn) continue;
  const lid = nextLink();
  wf.links.push([lid, LORA_ID, 0, sNode.id, 0, "MODEL"]);
  modelIn.link = lid;
  loraOutLinks.push(lid);
}

// 3) 插入 LoRA 节点（mode=4 旁路：需要时在界面里 Ctrl+B 启用）
for (const n of wf.nodes) if (n.order >= 3) n.order += 1;
wf.nodes.push({
  id: LORA_ID,
  type: "LoraLoaderModelOnly",
  pos: [40, 470],
  size: [420, 100],
  flags: {},
  order: 3,
  mode: 4,
  inputs: [{ name: "model", type: "MODEL", link: linkIn }],
  outputs: [{ name: "MODEL", type: "MODEL", links: loraOutLinks, slot_index: 0 }],
  properties: { "Node name for S&R": "LoraLoaderModelOnly" },
  widgets_values: [DEFAULT_LORA, 1.0],
  title: "LoRA（默认旁路，Ctrl+B 启用）",
});
wf.last_node_id = Math.max(wf.last_node_id ?? 0, LORA_ID);
wf.last_link_id = Math.max(wf.last_link_id ?? 0, ...wf.links.map((l) => l[0]));

const note = wf.nodes.find((n) => n.type === "Note");
if (note && typeof note.widgets_values?.[0] === "string" && !note.widgets_values[0].includes("LoRA 节点")) {
  note.widgets_values[0] +=
    `\n10) 已接好 LoRA 节点（默认旁路 mode=4）：界面上选中它按 Ctrl+B 启用，下拉选 models/loras 里的文件、调 strength_model。可串多个。`;
}

fs.writeFileSync(UI_WF, `${JSON.stringify(wf, null, 2)}\n`, "utf8");
console.log(`LoRA 节点：${LORA_ID}（mode=4 旁路，默认 ${DEFAULT_LORA}@1.0）`);
console.log(`连线：1 →(${linkIn}) LoRA →(${loraOutLinks.join(", ")}) 采样节点 ${samplers.map((s) => s.id).join(", ")}`);
console.log(`清理旧 model 连线 ${stale.length} 条；备份 .bak-${TS}`);
