#!/usr/bin/env node
/**
 * switch_encoder.mjs — 把工作流里的文本编码器从 GGUF 换成 fp8 safetensors。
 *
 *  1) 备份 UI 工作流，然后把节点 2 的 CLIPLoaderGGUF 换成 CLIPLoader，文件名指向 fp8 文件
 *  2) 打印改动前后对照
 *
 * 只改 ComfyUI 的 UI 工作流文件；API 工作流在工作区里由调用方自己维护。
 */
import fs from "node:fs";

const UI_WF = "D:/ComfyUI_windows_portable/ComfyUI/user/default/workflows/Qwen-Image-2.1-UC-GGUF-T2I.json";
const NEW_CLIP = "qwen3vl_8b_fp8_heretic.safetensors";
const NEW_TYPE = "CLIPLoader";
const TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

const wf = JSON.parse(fs.readFileSync(UI_WF, "utf8"));
fs.copyFileSync(UI_WF, `${UI_WF}.bak-${TS}`);

const node = wf.nodes.find((n) => n.id === 2);
if (!node) throw new Error("工作流里找不到节点 2（文本编码器）");

console.log(`改动前: type=${node.type}  widgets=${JSON.stringify(node.widgets_values)}`);
if (node.type === NEW_TYPE && node.widgets_values?.[0] === NEW_CLIP) {
  console.log("已经是新编码器，无需改动");
  process.exit(0);
}

node.type = NEW_TYPE;
node.title = "Load Text Encoder (fp8, 含视觉塔)";
node.widgets_values = [NEW_CLIP, "qwen_image"];
if (node.properties) node.properties["Node name for S&R"] = NEW_TYPE;
if (node.outputs?.[0]) node.outputs[0].name = "CLIP";

fs.writeFileSync(UI_WF, `${JSON.stringify(wf, null, 2)}\n`, "utf8");
console.log(`改动后: type=${node.type}  widgets=${JSON.stringify(node.widgets_values)}`);
console.log(`备份: ${UI_WF.split("/").pop()}.bak-${TS}`);
