#!/usr/bin/env node
/**
 * fix_workflow_links.mjs — 修复 UI 工作流里"一个 link id 被多个输入共用"的问题。
 *
 * ComfyUI 的 UI 格式要求每条连接有独立的 link id。之前生成两段采样时，
 * 后段节点复用了前段的 link id（model / positive / negative），虽然多数情况下能跑，
 * 但图上会出现悬空或错指。这里给每个重复使用的输入连接补一条独立 link，并同步源节点的输出列表。
 *
 *   node fix_workflow_links.mjs
 */
import fs from "node:fs";

const UI_WF = "D:/ComfyUI_windows_portable/ComfyUI/user/default/workflows/Qwen-Image-2.1-UC-GGUF-T2I.json";
const TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

const wf = JSON.parse(fs.readFileSync(UI_WF, "utf8"));
const byId = new Map(wf.nodes.map((n) => [n.id, n]));
const linkById = new Map(wf.links.map((l) => [l[0], l]));
const claimed = new Set(); // 已被占用的 link id（按输入逐个认领）
let nextLink = Math.max(0, ...wf.links.map((l) => l[0])) + 1;
let fixed = 0;
const details = [];

for (const node of wf.nodes) {
  for (const input of node.inputs ?? []) {
    const lid = input.link;
    if (lid === null || lid === undefined) continue;
    const link = linkById.get(lid);
    if (!link) {
      details.push(`✗ 节点 ${node.id}.${input.name} 指向不存在的 link ${lid}（已断开）`);
      input.link = null;
      fixed++;
      continue;
    }
    if (!claimed.has(lid)) {
      claimed.add(lid);
      continue;
    }
    // 重复使用 → 补一条独立连线
    const newId = nextLink++;
    wf.links.push([newId, link[1], link[2], node.id, link[4], link[5]]);
    linkById.set(newId, wf.links[wf.links.length - 1]);
    const src = byId.get(link[1]);
    const out = (src?.outputs ?? []).find((o, idx) => idx === link[2] || (o.slot_index ?? idx) === link[2]);
    if (out) out.links = [...(out.links ?? []), newId];
    input.link = newId;
    claimed.add(newId);
    fixed++;
    details.push(`+ 节点 ${node.id}.${input.name}：link ${lid} 已被占用 → 新建 link ${newId}（源自节点 ${link[1]}）`);
  }
}

// 清理指向已删除节点的 link，以及输出列表里的死引用
const validIds = new Set(wf.links.map((l) => l[0]));
for (const node of wf.nodes) {
  for (const out of node.outputs ?? []) {
    if (!out.links) continue;
    const before = out.links.length;
    out.links = out.links.filter((l) => validIds.has(l));
    if (out.links.length === 0) out.links = null;
    if (out.links?.length !== before) fixed += before - (out.links?.length ?? 0);
  }
}
wf.last_link_id = Math.max(wf.last_link_id ?? 0, nextLink - 1);

fs.copyFileSync(UI_WF, `${UI_WF}.bak-${TS}`);
fs.writeFileSync(UI_WF, `${JSON.stringify(wf, null, 2)}\n`, "utf8");
console.log(details.length ? details.join("\n") : "没有需要修复的连线");
console.log(`共修复 ${fixed} 处；备份 .bak-${TS}`);
