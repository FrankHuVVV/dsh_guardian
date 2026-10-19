#!/usr/bin/env node
/**
 * convert_lora_fused_split.mjs — 把 LoRA 里"融合式"的 img_mlp.gate_up 键拆成 ComfyUI 的拆分式命名。
 *
 * 背景：这些 LoRA 是按官方架构训练的，图像 MLP 用了融合投影 `gate_up`（[gate; up] 一次 GEMM）。
 * ComfyUI 的 SwiGLUFeedForward 两种都支持，但**本机的 DiT GGUF 是拆分式**（`gate_layer` + `proj`），
 * 于是 `img_mlp.gate_up.*` 这些键在加载时被丢弃（日志里 170 行 "lora key not loaded" 全是它）。
 *
 * 拆分是等价的：gate_up 的权重 = [W_gate; W_up] 上下拼接，所以
 *   gate_up.lora_A  → gate_layer.lora_A 与 proj.lora_A（同一个 A，复制）
 *   gate_up.lora_B  → gate_layer.lora_B 取前一半、proj.lora_B 取后一半
 *
 *   node convert_lora_fused_split.mjs <输入.safetensors> [输出.safetensors]
 *
 * safetensors 头是 8 字节长度 + JSON（名字/dtype/shape/偏移），数据紧随其后；
 * 这里只搬运字节，不做数值运算（BF16 原样切割）。
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULTS = {
  dir: "D:/ComfyUI_windows_portable/ComfyUI/models/loras",
};

const src = process.argv[2];
if (!src) {
  console.error("用法: node convert_lora_fused_split.mjs <输入.safetensors> [输出.safetensors]");
  process.exit(1);
}
const out = process.argv[3] ?? path.join(path.dirname(src), `${path.basename(src, ".safetensors")}_split.safetensors`);

const buf = fs.readFileSync(src);
if (buf.toString("latin1", 0, 8) === "\x00\x00\x00\x00\x00\x00\x00\x00") {
  console.error("看起来不是 safetensors（头长 0）");
  process.exit(1);
}
const headerLen = Number(buf.readBigUInt64LE(0));
const header = JSON.parse(buf.toString("utf8", 8, 8 + headerLen));
const dataStart = 8 + headerLen;
const meta = header.__metadata__ ?? null;

const DTYPE_BYTES = { F32: 4, F16: 2, BF16: 2, F8_E4M3: 1, F8_E5M2: 1, I64: 8, I32: 4, U8: 1 };
const numel = (shape) => shape.reduce((a, b) => a * b, 1);

function readTensor(name) {
  const t = header[name];
  if (!t) throw new Error(`缺少张量 ${name}`);
  return buf.subarray(dataStart + t.data_offsets[0], dataStart + t.data_offsets[1]);
}

// 找出所有融合式键
const fused = Object.keys(header).filter((k) => k !== "__metadata__" && /img_mlp\.gate_up\./.test(k));
if (!fused.length) {
  console.log("这个文件没有 img_mlp.gate_up 键，无需转换");
  process.exit(0);
}

const newHeader = {};
const chunks = [];
let offset = 0;
const add = (name, dtype, shape, bytes) => {
  newHeader[name] = { dtype, shape, data_offsets: [offset, offset + bytes.length] };
  chunks.push(bytes);
  offset += bytes.length;
};

// 原样搬运非融合键
for (const [k, t] of Object.entries(header)) {
  if (k === "__metadata__") continue;
  if (/img_mlp\.gate_up\./.test(k)) continue;
  add(k, t.dtype, t.shape, readTensor(k));
}

const report = [];
for (const key of fused) {
  const m = /^(.*)\.img_mlp\.gate_up\.lora_([AB])(.*)$/.exec(key);
  if (!m) continue;
  const [, prefix, ab, suffix] = m;
  const t = header[key];
  const bytes = readTensor(key);
  const elemSize = DTYPE_BYTES[t.dtype];
  if (!elemSize) {
    console.error(`未知 dtype ${t.dtype}（${key}）`);
    process.exit(1);
  }
  const rows = t.shape[0];
  const half = Math.floor(rows / 2);
  if (ab === "A") {
    // A 对两个目标是一样的
    add(`${prefix}.img_mlp.gate_layer.lora_A${suffix}`, t.dtype, t.shape, bytes);
    add(`${prefix}.img_mlp.proj.lora_A${suffix}`, t.dtype, t.shape, bytes);
  } else {
    const rowBytes = (numel(t.shape) / rows) * elemSize; // 每行字节数
    const a = bytes.subarray(0, half * rowBytes);
    const b = bytes.subarray(half * rowBytes);
    add(`${prefix}.img_mlp.gate_layer.lora_B${suffix}`, t.dtype, [half, ...t.shape.slice(1)], a);
    add(`${prefix}.img_mlp.proj.lora_B${suffix}`, t.dtype, [half, ...t.shape.slice(1)], b);
  }
}

const headerJson = JSON.stringify(meta ? { ...newHeader, __metadata__: meta } : newHeader);
const headerPadded = Buffer.from(headerJson, "utf8");
const pad = (8 - ((8 + headerPadded.length) % 8)) % 8;
const headerFinal = Buffer.concat([headerPadded, Buffer.alloc(pad, 0x20)]);

const outBuf = Buffer.alloc(8);
outBuf.writeBigUInt64LE(BigInt(headerFinal.length));
fs.writeFileSync(out, Buffer.concat([outBuf, headerFinal, ...chunks]));

// 统计
const fusedCount = fused.length;
const newKeys = Object.keys(newHeader).length;
const oldKeys = Object.keys(header).filter((k) => k !== "__metadata__").length;
console.log(`输入: ${path.basename(src)}（${oldKeys} 键，其中融合式 ${fusedCount}）`);
console.log(`输出: ${path.basename(out)}（${newKeys} 键）`);
console.log(`  gate_up.lora_A ×${fused.filter((k) => /lora_A/.test(k)).length} → gate_layer + proj 各一份`);
console.log(`  gate_up.lora_B ×${fused.filter((k) => /lora_B/.test(k)).length} → 前一半给 gate_layer、后一半给 proj`);
console.log(`大小: ${(fs.statSync(src).size / 1048576).toFixed(0)} MB → ${(fs.statSync(out).size / 1048576).toFixed(0)} MB`);
