#!/usr/bin/env node
/**
 * edit_experiment.mjs — 单图改图实验（不修改任何工作流文件，只提交临时 API 图）
 *
 *   node edit_experiment.mjs --ref <参考图路径> --prompt "把红色的雨伞改成蓝色" \
 *        [--mode ref|img2img] [--denoise 1.0] [--size 768] [--steps 10] [--seed 123]
 *
 * 两种接法：
 *   ref     ：LoadImage → VAEEncode → ReferenceLatent(正向条件)，KSampler 用空 latent
 *              （Qwen-Image 2.1 的"参考 latent"路线；不经过文本编码器的视觉塔）
 *   img2img ：LoadImage → VAEEncode → 直接当 KSampler.latent_image，靠 denoise 控制改动幅度
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};

const BASE = "http://127.0.0.1:8188";
const COMFY = "D:/ComfyUI_windows_portable/ComfyUI";
const INPUT_DIR = path.join(COMFY, "input");
const UNET = arg("unet", "Qwen21\\qwen-image-2.1-UC-Q4_K_M.gguf");
// 文本编码器：默认用 fp8 safetensors（含视觉塔）；要对比旧的 GGUF 就传 --clip-loader CLIPLoaderGGUF --clip <文件名>
const CLIP = arg("clip", "Qwen21\\qwen3vl_8b_fp8_heretic.safetensors");
const CLIP_LOADER = arg("clip-loader", "CLIPLoader");
const VAE = arg("vae", "Qwen21\\texture_fix_vae_for_qwen_image_2.1_bf16.safetensors");

const refPath = arg("ref");
const prompt = arg("prompt", "");
const negative = arg("negative", "低分辨率，低画质，肢体畸形，手指畸形，过饱和，蜡像感，模糊，文字");
const mode = arg("mode", "ref");
const denoise = Number(arg("denoise", mode === "img2img" ? 0.6 : 1.0));
const size = Number(arg("size", 768));
const steps = Number(arg("steps", 10));
const cfg = Number(arg("cfg", 4));
const seed = Number(arg("seed", 12345));
const prefix = arg("prefix", `DSH_EDIT_${mode}`);
// --lora "名字:强度" 可重复，按顺序串成 LoRA 链
const loras = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--lora" && argv[i + 1]) {
    const s = argv[i + 1];
    const m = /^(.*?):([0-9.]+)$/.exec(s);
    loras.push(m ? { name: m[1], strength: Number(m[2]) } : { name: s, strength: 1 });
  }
}

if (!refPath) {
  console.error("缺少 --ref <参考图>");
  process.exit(1);
}

// 1) 把参考图放进 ComfyUI 的 input 目录（LoadImage 只认这里）
fs.mkdirSync(INPUT_DIR, { recursive: true });
const ext = (path.extname(refPath) || ".png").toLowerCase();
const refName = `dsh_ref_${Date.now().toString(36)}${ext}`;
fs.copyFileSync(refPath, path.join(INPUT_DIR, refName));
console.log(`[参考图] ${refPath}\n        → input/${refName}（${(fs.statSync(path.join(INPUT_DIR, refName)).size / 1024).toFixed(0)} KB）`);

// 2) 组装临时 API 图
const graph = {
  "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: UNET } },
  "2": { class_type: CLIP_LOADER, inputs: { clip_name: CLIP, type: "qwen_image" } },
  "3": { class_type: "VAELoader", inputs: { vae_name: VAE } },
  "4": {
    class_type: "TextEncodeQwenImage21",
    inputs: { clip: ["2", 0], prompt, negative_prompt: negative, resolution: size },
  },
  "10": { class_type: "LoadImage", inputs: { image: refName } },
  "11": { class_type: "VAEEncode", inputs: { pixels: ["10", 0], vae: ["3", 0] } },
  "9": { class_type: "DshEmptyQwenImage21Latent", inputs: { width: size, height: size, batch_size: 1 } },
  "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["3", 0] } },
  "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: prefix } },
};

// LoRA 链（可选）：UnetLoader → lora1 → lora2 → … → KSampler.model
let modelRef = ["1", 0];
loras.forEach((l, i) => {
  const id = `lora${i + 1}`;
  graph[id] = {
    class_type: "LoraLoaderModelOnly",
    inputs: { model: modelRef, lora_name: l.name, strength_model: l.strength },
  };
  modelRef = [id, 0];
});
if (loras.length) console.log(`[LoRA] ${loras.map((l) => `${l.name}@${l.strength}`).join(" + ")}`);

if (mode === "ref") {
  graph["12"] = { class_type: "ReferenceLatent", inputs: { conditioning: ["4", 0], latent: ["11", 0] } };
  graph["5"] = {
    class_type: "KSampler",
    inputs: {
      model: modelRef, positive: ["12", 0], negative: ["4", 1], latent_image: ["9", 0],
      seed, steps, cfg, sampler_name: "euler", scheduler: "simple", denoise,
    },
  };
} else if (mode === "node4") {
  // 官方设计的那条路：参考图喂给 TextEncodeQwenImage21 的 images，并把 vae 接上
  // （此时节点自己 keep_vision=False，用 VAE 编码出的参考 latent；画布跟参考图走）
  graph["4"].inputs["images.image_1"] = ["10", 0];
  graph["4"].inputs.vae = ["3", 0];
  graph["5"] = {
    class_type: "KSampler",
    inputs: {
      model: modelRef, positive: ["4", 0], negative: ["4", 1], latent_image: ["4", 2],
      seed, steps, cfg, sampler_name: "euler", scheduler: "simple", denoise,
    },
  };
} else {
  graph["5"] = {
    class_type: "KSampler",
    inputs: {
      model: modelRef, positive: ["4", 0], negative: ["4", 1], latent_image: ["11", 0],
      seed, steps, cfg, sampler_name: "euler", scheduler: "simple", denoise,
    },
  };
}

// 3) 提交并等结果
const t0 = Date.now();
const submit = await fetch(`${BASE}/prompt`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt: graph, client_id: "dsh-edit-experiment" }),
});
const sj = await submit.json();
if (!submit.ok || (sj.node_errors && Object.keys(sj.node_errors).length)) {
  console.error("提交被拒：", JSON.stringify(sj).slice(0, 800));
  process.exit(1);
}
const pid = sj.prompt_id;
console.log(`[提交] ${pid}  模式=${mode} denoise=${denoise} 尺寸=${size} 步数=${steps} seed=${seed}`);

while (true) {
  await new Promise((r) => setTimeout(r, 2000));
  const h = await (await fetch(`${BASE}/history/${pid}`)).json();
  const entry = h[pid];
  if (entry) {
    if (entry.status?.status_str === "error") {
      console.error("执行失败：", JSON.stringify(entry.status.messages).slice(0, 600));
      process.exit(1);
    }
    const imgs = Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? []);
    if (imgs.length) {
      console.log(`[完成] ${(Date.now() - t0) / 1000 | 0}s → ${path.join(COMFY, "output", imgs[0].filename)}`);
      break;
    }
  }
  if (Date.now() - t0 > 25 * 60 * 1000) {
    console.error("超时（25 分钟）");
    process.exit(1);
  }
}
