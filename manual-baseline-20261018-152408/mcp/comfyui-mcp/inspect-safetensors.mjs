#!/usr/bin/env node
/**
 * inspect-safetensors.mjs — 只读 safetensors 文件头，验证张量构成。
 * 不加载权重、不下载任何东西：safetensors 的头就是 8 字节长度 + 一段 JSON。
 *
 *   node inspect-safetensors.mjs "D:/.../qwen3vl_8b_fp8_heretic.safetensors"
 */
import fs from "node:fs";

const p = process.argv[2];
if (!p) {
  console.error("用法: node inspect-safetensors.mjs <文件路径>");
  process.exit(1);
}

const st = fs.statSync(p);
const fd = fs.openSync(p, "r");
const lenBuf = Buffer.alloc(8);
fs.readSync(fd, lenBuf, 0, 8, 0);
const headerLen = Number(lenBuf.readBigUInt64LE(0));
const head = Buffer.alloc(headerLen);
fs.readSync(fd, head, 0, headerLen, 8);
fs.closeSync(fd);

const meta = JSON.parse(head.toString("utf8"));
const names = Object.keys(meta).filter((k) => k !== "__metadata__");

const byDtype = {};
for (const n of names) {
  const d = meta[n].dtype;
  byDtype[d] = (byDtype[d] ?? 0) + 1;
}
const count = (re) => names.filter((n) => re.test(n)).length;
const sample = (re, k = 4) => names.filter((n) => re.test(n)).slice(0, k);

console.log(`文件: ${p}`);
console.log(`大小: ${(st.size / 1073741824).toFixed(2)} GB  (${st.size} 字节)`);
console.log(`头长: ${headerLen} 字节；张量总数: ${names.length}`);
console.log(`\n[dtype 分布]`);
for (const [d, c] of Object.entries(byDtype).sort((a, b) => b[1] - a[1])) console.log(`  ${d.padEnd(10)} ${c}`);

console.log(`\n[视觉塔] 含 visual 的张量数: ${count(/visual\./)}    ← 期望 351`);
console.log(`  样本: ${sample(/visual\./, 5).join(", ") || "（无！）"}`);
console.log(`  patch_embed: ${sample(/visual\.patch_embed/, 3).join(", ") || "无"}`);
console.log(`  blocks: ${count(/visual\.blocks\./)} 个    merger: ${count(/visual\.merger/)} 个`);
const visDtypes = {};
for (const n of names.filter((x) => /visual\./.test(x))) {
  const d = meta[n].dtype;
  visDtypes[d] = (visDtypes[d] ?? 0) + 1;
}
console.log(`  视觉塔 dtype: ${Object.entries(visDtypes).map(([d, c]) => `${d}×${c}`).join(", ") || "无"}`);

console.log(`\n[语言塔] 二级前缀分布（model.* 下）:`);
const lv2 = {};
for (const n of names) {
  const parts = n.split(".");
  const k = parts.slice(0, 2).join(".");
  lv2[k] = (lv2[k] ?? 0) + 1;
}
for (const [k, c] of Object.entries(lv2).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${k.padEnd(24)} ${c}`);

const fp8 = names.filter((n) => meta[n].dtype?.startsWith("F8"));
console.log(`\n[量化] FP8 张量: ${fp8.length}    ← 期望 254（FFN/attn/embed/lm_head 的 2-D 权重）`);
console.log(`  样本: ${fp8.slice(0, 3).join(", ")}`);
console.log(`  是否有 language_model. 前缀（应为 0）: ${count(/^language_model\./)}`);
const emb = names.find((n) => /embed_tokens/.test(n));
console.log(`  embed_tokens: ${emb ? `${emb} (${meta[emb].dtype})` : "未找到"}`);
