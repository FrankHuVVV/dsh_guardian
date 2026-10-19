#!/usr/bin/env node
/**
 * switch_sampler.mjs — 把 UI 工作流的单 KSampler 换成作者推荐的两段式 KSamplerAdvanced。
 *
 *   节点 5  KSamplerAdvanced（前段：add_noise enable, cfg 1.0, 0 → 14, 留噪声）
 *   节点 11 KSamplerAdvanced（后段：add_noise disable, cfg 3.0, 14 → 末尾, 不留噪声）
 *   VAEDecode 的输入从节点 5 改到节点 11
 *
 * 改前备份。API 工作流在工作区里单独维护。
 */
import fs from "node:fs";

const UI_WF = "D:/ComfyUI_windows_portable/ComfyUI/user/default/workflows/Qwen-Image-2.1-UC-GGUF-T2I.json";
const TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

const STEPS = 25;
const SPLIT = 14;
const CFG_LOW = 1.0;
const CFG_HIGH = 3.0;
const SEED = 42;
const SAMPLER = "euler";
const SCHED = "simple";

const wf = JSON.parse(fs.readFileSync(UI_WF, "utf8"));
fs.copyFileSync(UI_WF, `${UI_WF}.bak-${TS}`);

const n5 = wf.nodes.find((n) => n.id === 5);
if (!n5) throw new Error("找不到节点 5");
if (n5.type === "KSamplerAdvanced") {
  console.log("节点 5 已经是 KSamplerAdvanced，跳过");
  process.exit(0);
}
const n6 = wf.nodes.find((n) => n.id === 6);
const NEW_NODE = Math.max(...wf.nodes.map((n) => n.id)) + 1;
const NEW_LINK = Math.max(...wf.links.map((l) => l[0])) + 1;

// 节点 5 → KSamplerAdvanced（前段）
n5.type = "KSamplerAdvanced";
n5.title = "采样前段 (cfg 低)";
if (n5.properties) n5.properties["Node name for S&R"] = "KSamplerAdvanced";
n5.widgets_values = ["enable", SEED, "fixed", STEPS, CFG_LOW, SAMPLER, SCHED, 0, SPLIT, "enable"];
if (n5.outputs?.[0]) n5.outputs[0].links = [NEW_LINK]; // 输出去后段

// 新节点 11：后段
wf.nodes.push({
  id: NEW_NODE,
  type: "KSamplerAdvanced",
  pos: [900, 380],
  size: [340, 300],
  flags: {},
  order: 5,
  mode: 0,
  inputs: [
    { name: "model", type: "MODEL", link: 1 },
    { name: "positive", type: "CONDITIONING", link: 4 },
    { name: "negative", type: "CONDITIONING", link: 5 },
    { name: "latent_image", type: "LATENT", link: NEW_LINK },
  ],
  outputs: [{ name: "LATENT", type: "LATENT", links: [7], slot_index: 0 }],
  properties: { "Node name for S&R": "KSamplerAdvanced" },
  widgets_values: ["disable", SEED, "fixed", STEPS, CFG_HIGH, SAMPLER, SCHED, SPLIT, 10000, "disable"],
  title: "采样后段 (cfg 高, 负面词生效)",
});

// 链接：5 → 11
wf.links.push([NEW_LINK, 5, 0, NEW_NODE, 3, "LATENT"]);
// 原来的 5 → 6 改成 11 → 6
const l7 = wf.links.find((l) => l[0] === 7);
if (l7) l7[1] = NEW_NODE;
// VAEDecode 的输入也跟着走
const vaeIn = n6.inputs.find((i) => i.name === "samples");
if (vaeIn) vaeIn.link = 7;

// 后面的节点 order 顺延
for (const n of wf.nodes) if (n.id !== NEW_NODE && n.order >= 5) n.order += 1;

wf.last_node_id = Math.max(wf.last_node_id ?? 0, NEW_NODE);
wf.last_link_id = Math.max(wf.last_link_id ?? 0, NEW_LINK);

const note = wf.nodes.find((n) => n.type === "Note");
if (note && typeof note.widgets_values?.[0] === "string") {
  note.widgets_values[0] +=
    `\n9) 采样改为两段式（作者建议）：共 ${STEPS} 步，前 ${SPLIT} 步 cfg ${CFG_LOW} 锁构图/材质，` +
    `后段 cfg ${CFG_HIGH} 配负面词重写字与细节。只想一发到底就把两个节点 cfg 设成相同值。`;
}

fs.writeFileSync(UI_WF, `${JSON.stringify(wf, null, 2)}\n`, "utf8");
console.log(`节点 5 → KSamplerAdvanced（前段 cfg ${CFG_LOW}，0→${SPLIT}）`);
console.log(`新增节点 ${NEW_NODE} → KSamplerAdvanced（后段 cfg ${CFG_HIGH}，${SPLIT}→末尾）`);
console.log(`链接 ${NEW_LINK}: 5→${NEW_NODE}；链接 7: ${NEW_NODE}→6`);
console.log(`备份: ${UI_WF.split("/").pop()}.bak-${TS}`);
