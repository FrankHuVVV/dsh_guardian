#!/usr/bin/env node
/**
 * wire_latent_node.mjs — 把 64 通道空 latent 节点接进工作流（方案 b 的接线部分）
 *
 *  1) 给自定义节点补上"宽高就近对齐到 32"与日志（避免填 1000 实际得到 992 的意外）
 *  2) 把 ComfyUI 的 UI 工作流也接上该节点，使界面与 API 工作流一致
 *
 * 两个文件都先备份为 *.bak-<时间戳>。运行：node wire_latent_node.mjs
 */
import fs from "node:fs";
import path from "node:path";

const NODE_DIR = "D:/ComfyUI_windows_portable/ComfyUI/custom_nodes/dsh_latent";
const NODE_FILE = path.join(NODE_DIR, "dsh_empty_latent.py");
const UI_WF = "D:/ComfyUI_windows_portable/ComfyUI/user/default/workflows/Qwen-Image-2.1-UC-GGUF-T2I.json";
const TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

// ---- 1) 节点：加对齐 + 日志 --------------------------------------------------
const nodeSource = `# 为 Qwen-Image 2.1 补一个"真正的空 latent"：形状 [batch, 64, h//16, w//16]，
# 让画布宽高（含任意比例）可以直接指定，不再被 TextEncodeQwenImage21 的方形 latent 限制。
import logging

import torch
from typing_extensions import override

import comfy.model_management
from comfy_api.latest import ComfyExtension, io

LOGGER = logging.getLogger(__name__)

# Qwen-Image 2.1 的 latent 是 16 倍下采样；TextEncodeQwenImage21 自己按 32 对齐参考图，
# 所以这里统一就近对齐到 32 的倍数，免得"填 1000 结果拿到 992"这种意外。
ALIGN = 32


def _align(value) -> int:
    v = int(value)
    if v < ALIGN:
        v = ALIGN
    return max(ALIGN, int(round(v / ALIGN)) * ALIGN)


class DshEmptyQwenImage21Latent(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="DshEmptyQwenImage21Latent",
            display_name="Empty Qwen Image 2.1 Latent (64ch)",
            category="latent/qwen",
            description=(
                "Zero latent shaped [batch, 64, height//16, width//16] for Qwen-Image 2.1，"
                "直接指定画布宽高（任意比例）。宽高会就近对齐到 32 的倍数。"
            ),
            inputs=[
                io.Int.Input("width", default=1024, min=16, max=16384, step=16),
                io.Int.Input("height", default=1024, min=16, max=16384, step=16),
                io.Int.Input("batch_size", default=1, min=1, max=64),
            ],
            outputs=[io.Latent.Output()],
        )

    @classmethod
    def execute(cls, width, height, batch_size=1) -> io.NodeOutput:
        width = _align(width)
        height = _align(height)
        latent = torch.zeros(
            [int(batch_size), 64, height // 16, width // 16],
            device=comfy.model_management.intermediate_device(),
        )
        LOGGER.info(
            "[dsh_latent] empty latent %dx%d (latent %dx%d, 64ch, batch=%d)",
            width, height, latent.shape[-1], latent.shape[-2], int(batch_size),
        )
        return io.NodeOutput({"samples": latent})


class DshLatentExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [DshEmptyQwenImage21Latent]


async def comfy_entrypoint() -> DshLatentExtension:
    return DshLatentExtension()
`;

fs.copyFileSync(NODE_FILE, `${NODE_FILE}.bak-${TS}`);
fs.writeFileSync(NODE_FILE, nodeSource, "utf8");
console.log(`[1] 节点已更新（备份 ${path.basename(NODE_FILE)}.bak-${TS}）`);

// ---- 2) UI 工作流接线 --------------------------------------------------------
const wf = JSON.parse(fs.readFileSync(UI_WF, "utf8"));
fs.copyFileSync(UI_WF, `${UI_WF}.bak-${TS}`);

const NEW_NODE = 9;
const NEW_LINK = 9;

if (wf.nodes.some((n) => n.id === NEW_NODE)) {
  console.log("[2] 工作流里已有节点 9，跳过接线");
} else {
  const ks = wf.nodes.find((n) => n.id === 5);
  const te = wf.nodes.find((n) => n.id === 4);
  const latentInput = ks.inputs.find((i) => i.name === "latent_image");
  latentInput.link = NEW_LINK;

  const teLatentOut = te.outputs.find((o) => o.name === "latent");
  if (teLatentOut) teLatentOut.links = null;

  wf.links = wf.links.filter((l) => l[0] !== 6);
  wf.links.push([NEW_LINK, NEW_NODE, 0, 5, 3, "LATENT"]);

  // 让执行顺序保持在 KSampler 之前
  for (const n of wf.nodes) if (n.order >= 4) n.order += 1;
  wf.nodes.push({
    id: NEW_NODE,
    type: "DshEmptyQwenImage21Latent",
    pos: [520, 700],
    size: [340, 130],
    flags: {},
    order: 4,
    mode: 0,
    inputs: [],
    outputs: [{ name: "LATENT", type: "LATENT", links: [NEW_LINK], slot_index: 0 }],
    properties: { "Node name for S&R": "DshEmptyQwenImage21Latent" },
    widgets_values: [1024, 1024, 1],
    title: "Empty latent 64ch（宽高可控）",
  });

  wf.last_node_id = Math.max(wf.last_node_id ?? 0, NEW_NODE);
  wf.last_link_id = Math.max(wf.last_link_id ?? 0, NEW_LINK);

  const note = wf.nodes.find((n) => n.type === "Note");
  if (note && typeof note.widgets_values?.[0] === "string") {
    note.widgets_values[0] +=
      "\n8) 空 latent 现由自定义节点 DshEmptyQwenImage21Latent 提供（64通道/16倍下采样，宽高任意），" +
      "\n   Text Encode Qwen Image 2.1 的 latent 输出已不再使用——它只能给正方形。";
  }

  fs.writeFileSync(UI_WF, `${JSON.stringify(wf, null, 2)}\n`, "utf8");
  console.log(`[2] UI 工作流已接线（备份 ${path.basename(UI_WF)}.bak-${TS}）`);
  console.log("    节点 9 = DshEmptyQwenImage21Latent；KSampler.latent_image -> [9,0]");
}
