# comfyui-mcp — 本地提示词 → 本地出图 的 DSH MCP 服务

把「在 DSH 里描述画面」变成一条本地流水线：

```
你 → DSH agent（deepseek，带工具）
       └─ mcp__comfyui__prepare_image("一个穿红汉服的少女，樱花树下，金色午后光")
            （→ 提示词原样给用户过目，用户点头后才 approve_and_generate 出图）
            ├─ Ollama  http://127.0.0.1:11434   本地 7B → { positive, negative }
            └─ ComfyUI http://127.0.0.1:8188    Qwen-Image 2.1 GGUF 文生图 → PNG
       ← 提示词 + 图片本地路径（默认复制到 <workspace>/comfy-out/）
```

**关键点：Ollama 的模型不进 DSH 的模型选择器。** 它是被 agent 调用的本地文本服务，
所以「模型不支持 tools」这件事在这里不构成任何障碍——请求里根本不含 tools。

## 文件

| 文件 | 作用 |
|---|---|
| `server.mjs` | MCP stdio server，零依赖（Node ≥ 18 的全局 `fetch`）；stdout 是协议通道，日志走 stderr + `comfyui-mcp.log` |
| `config.json` | 全部可调参数：两个服务的地址、Ollama 模型名、工作流路径、采样默认值、收图目录 |
| `workflow.api.json` | ComfyUI 的 **API 格式**工作流（由 UI 格式转换而来，节点 1~7） |
| `selftest.mjs` | 不经 DSH 直接跑一遍协议与工具：`node selftest.mjs [--image] [--raw]` |
| `verify-lifecycle.mjs` | 回归测试：服务退出是否带走了自启的 ComfyUI |
| `bench.mjs` | 定参数压测出图：`node bench.mjs --steps 10 --resolution 768 --seed 777` |
| `comfyui-mcp.log` | 运行日志（自动生成） |
| `comfyui-launch.log` | 按需拉起的 ComfyUI 自己的控制台输出（自动生成） |
| `comfyui-mcp.state.json` | 记录自启 ComfyUI 的 pid，供强杀后自愈（自动生成） |

## 工具

| 工具名（在 DSH 中显示） | 作用 | 备注 |
|---|---|---|
| `mcp__comfyui__service_status` | 自检 Ollama / ComfyUI 是否在线、本机模型是否齐备 | 报错后第一步 |
| `mcp__comfyui__generate_prompts` | 描述 → `{positive, negative}` | **只出文字、不留草稿、绝不出图** |
| `mcp__comfyui__generate_image` | 用户直接给出的提示词 → 图片 | 只用于"人给的词"，不用于模型生成的词 |
| `mcp__comfyui__prepare_image` | 描述 → 正/负提示词 + `draft_id` | **人工过目第一步：绝不出图** |
| `mcp__comfyui__prepare_edit` | 参考图 + 修改要求 → 编辑指令 + `draft_id` | **改图第一步：绝不出图** |
| `mcp__comfyui__approve_and_generate` | 凭 `draft_id` + `approved:true` 出图（文生图/改图由草稿类型决定） | **第二步：闸门** |
| `mcp__comfyui__comfyui_power` | `status` / `start` / `stop` / `free_vram` | 管 ComfyUI 的启停与显存（见"方案二"） |

## 采样参数（按 Qwen-Image-2.1 官方建议）

| 项 | 值 | 依据 |
|---|---|---|
| 步数 | **25**（默认） | 2.1 是**全量非蒸馏**模型，作者："更多步不会让文字更清晰，反而开始烧高光" |
| CFG（无文字） | **1.0**（默认单段） | 作者对无文字场景的推荐；也最省时间 |
| CFG（图内有文字） | 两段式 **1.0 → 3.0** | 前段锁构图/材质，后段配负面词重写文字；用 `cfg_high: 3` 开启 |
| 两段分界 | `cfg_split_step`，默认 `round(步数 × 0.56)`（25 步→**14**，作者建议 12~17） | 同上 |
| 采样器 | `euler` / `simple` | 工作流原值，保持不动 |

**实测 A/B**（同提示词、同种子 4242、768²、25 步）：

| 配置 | 耗时 | 观感 |
|---|---|---|
| 单段 cfg 1.0 | **97.8 s** | 略平、柔和 |
| 两段式 1.0 → 3.0（分界 14） | **118.0 s** | 石头纹理对比略强，整体几乎一致 |

→ **差了约 24 秒**，原因是后段 cfg > 1 时每步要跑两遍（有条件 + 无条件）。
所以默认设成**单段 cfg 1.0**；只有"图里要有可读文字"时才传 `cfg_high: 3`。

工作流改动：节点 5 `KSampler` → `KSamplerAdvanced`（前段），新增节点 11 `KSamplerAdvanced`（后段），
`VAEDecode` 的输入改接后段。UI 工作流与 API 工作流都已改（UI 改前备份 `*.bak-2026-09-28T13-24-20`）。
只给一个 `cfg` 参数时两段同值，等于"一发到底"。

## 改图工具（人工过目 → 出图）

```
prepare_edit(source_image, instruction)
   → 参考图复制进 ComfyUI/input/，本地 7B 写成一条编辑指令，返回 draft_id   ← 绝不出图
   → 把 instruction / positive / negative 贴给用户过目
        ├─ 同意   → approve_and_generate(draft_id, approved=true)     → 走参考图路线出图
        ├─ 要改词 → 同一调用带上新的 positive/negative
        └─ 放弃   → approve_and_generate(draft_id, approved=false)    → 草稿作废
```

- **画布跟随参考图**（参考图被缩放到约 `resolution²` 的框内，默认 1024）；想更贴近原图就传 `denoise`（0.6~0.8，映射为 `start_at_step`）。
- 参考图来源可以直接是 DSH 附件路径；附件没有扩展名，工具按魔数补 `.png/.jpg/.webp` 再放进 `input/`。
- 草稿与文生图共用同一套闸门规则：一次性、30 分钟过期、伪造 id 直接拒。

**实测**（参考图＝雨夜红伞，指令"把红色的雨伞改成深蓝色"）：
7B 写出的编辑指令 `将红色的雨伞更改为深蓝色，保留人物的外貌、动作、雨夜街道的构图、光线以及整体风格不变`；
同意后出图 152 s（1024²，含冷启动），结果红伞变深蓝、构图与人物保留 ✅。

## 人工过目闸门：先看提示词，再出图

需求是"7B 出完正/负提示词先给我过目，我同意后再送 ComfyUI"。**只靠提醒模型记得问不可靠**，
所以从结构上把关：

```
prepare_image(描述)
   → 本地 7B 生成 positive / negative + draft_id      ← 绝不出图
   → 把两条提示词原样贴给用户过目
        ├─ 用户同意   → approve_and_generate(draft_id, approved=true)   → 出图
        ├─ 用户要改词 → 同一调用带上新的 positive/negative 再 approved=true
        └─ 用户放弃   → approve_and_generate(draft_id, approved=false)  → 草稿作废，不出图
```

| 规则 | 说明 |
|---|---|
| **没有"描述一步出图"的接口** | 组合里已删掉 `describe_and_generate`，跳过过目在工具层面不成立 |
| **草稿一次性** | 同一 `draft_id` 出图成功即作废，重复调用报错 |
| **草稿会过期** | `draftTtlMs` 默认 1800000（30 分钟），过期后必须重新 `prepare_image` |
| **不存在的 draft 直接拒** | 反例测试：`approved=true` + 伪造 id → 报错，不产生任何出图 |
| **改词不用重来** | `approve_and_generate` 可带 `positive` / `negative` 覆盖草稿，并回报 `editedByUser: true` |
| **`generate_image` 的口子** | 保留给"用户直接给出提示词"的场景（人给的词本身就是人批准的） |

`service_status` 里能看到闸门状态：`approvalGate: { required: true, pendingDrafts, draftTtlMs, flow }`。

> 验证记录：`prepare_image` 返回 `drewAnything: false` 且无 `images` 字段；
> `approved:false` 返回"没有提交 ComfyUI"；真 id + `approved:true` 才出图；
> 同一 id 二次调用报 `草稿…不存在、已过期或已用过`。

## 分辨率与画面比例（节点 9 = 64 通道空 latent）

| 想干什么 | 怎么传 | 结果 |
|---|---|---|
| 正方形（旧用法） | `resolution: 1024` | 1024×1024 |
| 指定宽高 | `width: 1344, height: 768` | 1344×768（实测通过） |
| 指定比例 | `aspect: "9:16", resolution: 1024` | **576×1024**（实测通过，resolution 当长边） |
| 只给比例 | `aspect: "16:9"` | 1024×576（长边默认 1024） |

- 三个入口（`generate_image` / `prepare_image` / `approve_and_generate`）都收这些参数；
  `prepare_image` 会把尺寸一起存进草稿，`approve_and_generate` 不传尺寸就沿用草稿里过目过的那个
  （回报 `sizeOverridden: false`）。
- 结果统一回报 `size: { width, height, aspect, source }`；`service_status` 里有 `size: { align, min, max, input }`。
- 宽高会**就近对齐到 32 的倍数**（`sizeAlign`），范围 `sizeMin 256 ~ sizeMax 4096`，超出即夹紧。
- 传 1000 会得到 992（对齐结果），不会被静默截成别的数。

### 为什么要自定义节点

Qwen-Image 2.1 的空 latent 必须是 `[batch, 64, h//16, w//16]`，而 ComfyUI 自带的空 latent 节点都不是这个规格
（`EmptyLatentImage` 4ch、`EmptySD3LatentImage` 16ch、`EmptyQwenImageLayeredLatentImage` 16ch+layers）。
而 `TextEncodeQwenImage21` 在没有参考图时强制 `latent_w = latent_h = resolution`——所以只能出正方形。

于是工作流里加了 **节点 9 = `DshEmptyQwenImage21Latent`**
（`ComfyUI\custom_nodes\dsh_latent\`，形状 `[batch, 64, h//16, w//16]`），KSampler 的 `latent_image`
改接它，节点 4 的 latent 输出不再使用。**UI 工作流与 API 工作流都已接线**，改前各自备份为 `*.bak-<时间戳>`。
节点会对宽高做 32 对齐并在控制台打印 `[dsh_latent] empty latent 1344x768 ...`。

### 画质提醒

工作流 Note 原文：模型内置采样 shift 0.69 是 **1024×1024 的校准值**，换更大画布或极端比例时，
若觉得画质/构图偏离，可再加 `ModelSamplingFlux` 手动调 shift。

## 提示词被截断的兜底

7B 写长文容易越写越重复，最后被 `max_tokens` 截断、JSON 就断了（实测撞到过一次）。三层兜底：

1. `maxTokens` 提到 **900**；
2. 解析失败时**按字段名把内容抠出来**（`salvagePrompts`：缺收尾引号也能救回 positive，negative 缺失就用工作流默认负面词）；
3. 还失败就用"**硬上限 100 字 / 负面最多 8 词**"的严格指令**自动重试一次**。

结果里带 `salvaged` / `strictRetry` 标记，能看出这次是否走了兜底。

## 文本编码器：已换成 fp8 safetensors（含视觉塔）

**2026-09-28 切换**：`qwen3vl_8b_fp8_heretic.safetensors`（8.70 GiB，[pottokao/Qwen-Image-2.1-Text-Encoder-Heretic-GGUF](https://huggingface.co/pottokao/Qwen-Image-2.1-Text-Encoder-Heretic-GGUF)，去审查 + 带视觉塔）。

| 项 | 旧（`qwen3-vl-8b-heretic-1.3.0-Q4_K_M.gguf`） | 新（fp8 safetensors） |
|---|---|---|
| 加载器 | `CLIPLoaderGGUF` | **`CLIPLoader`**（type 仍是 `qwen_image`） |
| 视觉塔 | **没有**（启动日志一直报 `clip missing: visual.*`） | **351 个 `model.visual.*` 张量，全是 BF16**（读文件头核实） |
| 量化 | Q4_K_M（语言塔） | 254 个 `F8_E4M3` + 496 个 BF16 |
| 参考图编辑 | 官方路线（图喂节点 4）**直接崩**：`mat1 and mat2 shapes cannot be multiplied (2304x1152 and 3456x1152)` | **能跑**（实测换背景、改颜色都成功） |
| 体积 | 4.68 GB | 8.70 GB |

工作流改动：UI 工作流与 `workflow.api.json` 的节点 2 由 `CLIPLoaderGGUF` 换成 `CLIPLoader`，
`clip_name` 指向 fp8 文件（UI 工作流改前备份 `*.bak-2026-09-28T13-11-28`）。
`config.json` 新增 `clipNodeId: "2"`，`service_status` 会报告工作流**实际在用**的加载器与文件名。

**代价（实测）**：

- ComfyUI 侧 `Model QwenImage21TEModel_ prepared for dynamic VRAM loading. **16721MB Staged**`
  —— fp8 会被升到 fp16 加载，**运行期占用约 16.7 GB**（文件本身 8.7 GB），32 GB 内存要留意，
  尤其 Ollama CPU 模式还会占 5 GB；
- 768²/10 步冷跑 `Prompt executed in 61.55 s`（含编码器+DiT 首次加载）；
- 首次那次 ComfyUI 启动等了 68 s（平时 12~32 s），推测受刚写入 8.7 GB 文件的磁盘缓存抖动影响。

**保留的旧文件**：`qwen3-vl-8b-heretic-1.3.0-Q4_K_M.gguf` 仍在目录里，随时可回退（把节点 2 换回 `CLIPLoaderGGUF`）。

## 参考图编辑：两条路线的实测对比

| 路线 | 编码器 | 换伞颜色 | 换白天背景 |
|---|---|---|---|
| `ReferenceLatent`（图不进编码器） | 旧 Q4（无视觉塔） | ✅ 成功，但有光斑伪影 | ❌ 崩坏 |
| 节点 4 `images`+`vae`（官方路线） | 旧 Q4（无视觉塔） | ❌ 直接报错 | ❌ 直接报错 |
| 节点 4 `images`+`vae`（官方路线） | **新 fp8（含视觉塔）** | ✅ **干净，构图完整** | ✅ **成功**（街道变白天，人物保留；伞色被牵动成粉色属指令跟随的副作用） |

工具侧 `edit_experiment.mjs` 已支持 `--clip` / `--clip-loader` 切换对比：
```powershell
node edit_experiment.mjs --mode node4 --ref <参考图> --prompt "把背景换成白天的城市街道" `
  --denoise 1.0 --size 768 --steps 10 --prefix TEST
```
（脚本要求 ComfyUI 已在跑；提交的是临时图，**不改任何工作流文件**。）

## LoRA（已接入工作流）

**两条入口都接好了：**

| 场景 | 怎么用 |
|---|---|
| **工具出图** | 在 `generate_image` / `prepare_image` / `approve_and_generate` 里传 `loras: [{name, strength}]`（可多条，按顺序链式作用）。名字就是 `models/loras` 里的文件名；工具会校验名字并把 LoRA 节点动态插进模型链（`UnetLoaderGGUF → lora1 → lora2 → … → 采样节点`） |
| **ComfyUI 界面** | 工作流里已加好 `LoraLoaderModelOnly` 节点（**默认旁路 mode=4**，Ctrl+B 启用），下拉选文件、调 `strength_model`，可串多个 |

`service_status` 会列出全部可用 LoRA（`loras.available`）。

### 兼容性检测（8 个文件全测过）

LoRA 键名有两派：**拆分式**（`img_mlp.gate_layer` + `proj` + `out`）与**融合式**（`img_mlp.gate_up`）。
本机 DiT 是拆分式命名，所以融合式 LoRA 会丢掉整个 MLP 部分（只加载注意力层）。
判据就是日志里的 `lora key not loaded`。

| 文件 | 键布局 | 结果 |
|---|---|---|
| `qwen-image-2.1-uncensored-lora.safetensors` | `transformer_blocks` + `.default.`，无 MLP 键 | ✅ 完全匹配 |
| `Qwen-Image-2.1-Natural-Exposure-LoRA-4000.safetensors` | 拆分式 | ✅ 完全匹配 |
| `Qwen-Image-2.1_20NSFW_20Image_20Edit.safetensors` | 拆分式 | ✅ 完全匹配 |
| `RadianceChromeVoluptuous_QwenImage2.1_v1.0.safetensors` | 拆分式 | ✅ 完全匹配 |
| `turbo8_lora_step2500.safetensors` | `transformer.` + 拆分式 | ✅ 完全匹配 |
| `nsfw_qwen_21.safetensors` | **融合式 `gate_up`** | ⚠️ 64 键未加载 → 已转换 |
| `Qwen2.1_Anything2RealCharacters.safetensors` | **融合式** | ⚠️ 64 键未加载 → 已转换 |
| `Pornmaster_QI2.1_Breasts_Slider_V1.safetensors` | **融合式** | ⚠️ 42 键未加载 → 已转换 |
| `easternfemale_v2.1.safetensors`（perpetual3x 的 R18 解剖 LoRA） | **融合式** | ⚠️ 64 键未加载 → 已转换，用 `_split` |

## R18 预设配方（已写进工具）

`config.json` 的 `presets` 段定义配方；调用时传 `preset` 即可，**只填补你没显式给的项**
（步数 / LoRA / 尺寸 / cfg），并把触发词与兜底短语贴进提示词（`apply_prompt_scaffold: false` 可关）。

| 预设 | 别名 | 步数 | cfg | 尺寸 | LoRA 组合 | 本机实测执行 | 适用 |
|---|---|---|---|---|---|---|---|
| **`r18_quality`** | `r18` / `quality` | **32** | **2.5** | 832×1216 | `easternfemale_v2.1_split@0.8` + `nsfw_qwen_21@0.6` | **283 s** | ⭐ R18 首选（2026-09-30 按要求由 25 步 / cfg 1 调整） |
| `r18_fast` | `fast` | 8 | 1.0 | 832×1216 | `turbo8@1.0` + `easternfemale_v2.1_split@0.8` | **64 s** | 速度优先；纹理更颗粒、手部更粗 |
| `r18_fast_plus` | `fastplus` | 8 | 1.0 | 832×1216 | 上面再加 `nsfw_qwen_21@0.6` | **69 s** | NSFW 倾向更强，画质三者最糙 |
| `portrait_clean` | `portrait` | 25 | 1.0 | 832×1216 | 无 | ~110 s | 基线对照 |

**cfg 2.5 的代价与收益（同种子 7701 实测）**：执行 135 s → **283 s（+110%）**，因为 cfg > 1 时
每一步都要多跑一遍无条件分支；换来的是负面词**真正生效**——画面更干净、皮肤更细腻，
拉普拉斯锐度 6.06 → 7.66，平均亮度 68.1 → 81.4。要快切 `r18_fast`，要稳用 `r18_quality`。

**同提示词、同种子（7701）对比**：8 步 3 LoRA（69 s）与 8 步 2 LoRA（64 s）在解剖与细节上都明显
劣于 25 步 2 LoRA（135 s）——蒸馏 LoRA 的粗糙纹理吃掉了一部分解剖 LoRA 的收益。
**要 R18 质量就别开 turbo8**；turbo8 只用于"先快速看构图"。

**提示词要点**（cfg > 1 后负面词已生效，正面仍建议写全）：
- 触发词 `nsfw_qwen_lora`（预设会自动补）
- 身份/细节 token：`person_0001`…`person_0123`、`person_XXXX_vulva/_anus/_breasts/_nipples`；纯自然语言也有效
- 解剖兜底：`no censoring, no fused anatomy, no extra or duplicated limbs`
- 皮肤质感：`natural unretouched skin with visible pores, film grain, 85mm lens`

**许可提醒**：`easternfemale_v2.1` 仅限非商用；turbo8 与 Qwen-Image-2.1 同为 Qwen Research License。

### 融合式 → 拆分式转换

```
node convert_lora_fused_split.mjs <输入.safetensors> [输出.safetensors]
```

等价拆分：`gate_up` 的权重是 `[W_gate; W_up]` 上下拼接，所以 `lora_A` 复制给 `gate_layer` 与 `proj` 各一份，
`lora_B` 前一半给 `gate_layer`、后一半给 `proj`。只搬运字节、不做数值运算，**原文件保留**，输出加 `_split` 后缀。

**实测对照**（512² / 1 步）：

| 文件 | 未匹配键 |
|---|---|
| `nsfw_qwen_21.safetensors` | **64** |
| `nsfw_qwen_21_split.safetensors` | **0** ✅ |
| `Qwen2.1_Anything2RealCharacters.safetensors` | **64** |
| `Qwen2.1_Anything2RealCharacters_split.safetensors` | **0** ✅ |

### 效果验证（同提示词、同种子 9999、768²、16 步）

| 无 LoRA | 加 `RadianceChromeVoluptuous@0.8` |
|---|---|
| ![](comfy-out/QwenImage21_00020_.png) | ![](comfy-out/QwenImage21_00021_.png) |

平均每通道差异 **35.0 / 255**，平均亮度 29.7 → **59.1**（Δ+29.4）——LoRA 确实在起作用，不是空转。

### 检测脚本

```
node lora_probe.mjs [--size 512] [--steps 1] [--strength 1.0] [--loras "a.safetensors,b.safetensors"] [--log <路径>]
```

逐个提交极短任务，按文件统计 `lora key not loaded` 的**新增**条数（累计计数差集归属，不按字节窗口切）。
日志要读**运行副本**那份（`~/.dsh/mcp/comfyui-mcp/comfyui-launch.log`），脚本已自动优先选它。

> 踩过的坑：① 探针最初按脚本自身目录解析日志路径，读到的是工作区里不存在的另一份文件，
> 于是所有 LoRA 都被误报成"全部键已加载"；② ComfyUI 的警告可能滞后于任务完成，需等 2~3 秒再读。

### 多个 LoRA 叠加的开销（实测）

`lora_stack_bench.mjs`（512²、同提示词、**每次换种子**避免 ComfyUI 执行缓存）：

| 场景 | 链式 LoRA | 执行时间 | 每步 | 显存 |
|---|---|---|---|---|
| 0 个 / 12 步 | 0 | **17.3 s** | 1.57 s | 6134 MiB |
| 1 个 / 12 步 | 1 | 29.8 s | ~2.5 s | 6134 MiB |
| 3 个 / 12 步 | 3 | 51.6 s | ~4.1 s | 6134 MiB |
| 11 个 / 12 步 | 11 | **112.1 s** | **9.23 s** | ~6.1 GB |
| 11 个 / 25 步 | 11 | 232.3 s | 9.23 s | ~6.1 GB |
| 0 个 / 25 步 | 0 | 37.7 s | 1.57 s | 6134 MiB |

- **每步采样 1.57 → 9.23 s（5.87×）**；12 步从 17 s 变 112 s。
- **一次性开销只有约 3 s**（打补丁）——所以这不是"加载慢"，而是**每一步都在重算**：
  ComfyUI-GGUF 在**反量化时**套 LoRA 补丁（`comfy.lora.calculate_weight` 在 GGUF 的 ops 里），
  挂了补丁的权重无法复用反量化缓存。
- 每个 LoRA 大约再 +0.65 s/步（第一个 +约 1.0 s/步）。
- **显存几乎不变**（稳定 ~6.1 GB）：LoRA 权重常驻 RAM（11 个文件合计约 2.6 GB），代价在算力。

**质量上也不该同时开**：11 个里三组是"同一权重的新旧两份"（原版 + `_split`），
风格类（RadianceChrome / Natural-Exposure）、画风转换类（Anything2Real）、NSFW 与 uncensored 互相打架，
`turbo8` 还是 8 步蒸馏 LoRA 却配 25 步。同种子对照下石灯笼结构直接崩坏（左 0 个 / 右 11 个）。

**建议**：链式 1~3 个为宜；叠加时用 `_split` 版本（否则每次白白加载 170 个未匹配键）；
风格类挑一个、概念类挑一个；`turbo8` 单独用且步数调到 8 左右。
按实测倍率外推，1024²/25 步无 LoRA 约 2~3 分钟，11 个 LoRA 会到 **15 分钟量级**（该档未实测）。

## Turbo8 少步蒸馏 LoRA 的正确用法（已内建支持）

`turbo8_lora_step2500.safetensors` 是 DMD2 蒸馏的 **8 步** LoRA，作者规定：

- **steps 8、cfg 1、euler / simple**；"提高步数或把 cfg 提到 1 以上都不会变好"
- 文生图必须配 **`ModelSamplingFlux`（max_shift 0.6935、base_shift 0.5，且宽高接上）**，
  否则非 1MP 尺寸下噪声调度与训练不一致；改图/抠图在 ~1MP 用默认 shift 即可
- rank 128 / alpha 128，覆盖 attn + MLP + modulation + timestep-embedding（227 层，全匹配）
- 作者离线评测：PickScore 21.94（8 步）vs 22.15（教师 40 步）；文字渲染退化明显（OCR 75% vs 95%）

**工具已内建**：LoRA 文件名里含 `turbo` 时自动插入 `ModelSamplingFlux` 并接好宽高
（也可用 `sampling_shift: true/false` 显式开关）。返回结果里的 `sampling.modelSamplingFlux` 可核对。

### R18 配方（832×1216，本机实测）

| 档位 | 配置 | 执行耗时 | 观感 |
|---|---|---|---|
| **快档** | `turbo8@1.0` + 1 个 NSFW LoRA@0.8，**8 步** | **58 s** | 纹理更颗粒、对比更强，细节略糙 |
| **质量档** | 不用 turbo8，1 个 NSFW LoRA@0.8，**25 步** | **114 s** | 更干净，结构/光影更稳 |

（像素统计：8 步图拉普拉斯锐度 13.13、亮度 56.9；25 步图 11.27 / 69.9；两图平均差 23.3/255。）

**别叠超过 3 个 LoRA**：每个约 +0.65 s/步（512² 实测），11 个时每步 1.57 → 9.23 s（5.87×）。

## 四套 R18 工作流（run_workflow 注册表）

`config.json` 的 `workflows` 段注册了 4 套流程，用 `run_workflow(name=...)` 调用；
每套都支持 `dry_run: true` 先看计划（提示词 / LoRA 清单 / 参数），确认后再正式跑。

| 名称 | 别名 | 类型 | 后端流程 | 参数 |
|---|---|---|---|---|
| `qwen_t2i` | `t2i` / `qwen` / `生图` | 文生图 | `workflow.api.json`（Qwen-Image 2.1 UC Q4 + fp8 视觉编码器 + 两段式 KSamplerAdvanced） | 832×1216、32 步、cfg 2.5、`r18_quality` 那套 LoRA |
| `qwen_edit` | `edit` / `i2i` / `改图` | 图生图 | 同上，走参考图分支（LoadImage → 节点4 images+vae） | 832×1216、25 步、cfg 2.5、**denoise 0.85**（start_at_step≈4） |
| `h3_t2v` | `t2v` / `h3` / `生视频` | 文生视频 | `workflows/h3_t2v.api.json`（MiniMax H3：DiT→6 LoRA→SigmaShift→CLIP(GGUF,type=minimax)→视频VAE+音频VAE→SamplerCustomAdvanced→CreateVideo/SaveVideo） | 960×544、124 帧（≈5.17 s）、8 步、euler+beta、shift 12/5、按场景自动挑 LoRA |
| `h3_ref2v` | `ref2v` / `参考图` / `ref` | 参考图生视频 | `workflows/h3_ref2v.api.json`（多一个 LoadImage → `ref_image_0`，锁人） | 同上；另含 ref2va 专属 LoRA（AfterMidnight / ref2VA_Motion） |

**视频的 LoRA 自动挑选**：`loraCatalog` 按场景关键字挑（手指/自慰/胸部/射精/潮吹…），
`auto_loras: false` 可关掉只留 `baseLoras`，`loras` 参数可完全覆盖。

### 实测结论（RTX 4060 Laptop 8 GB / 32 GB RAM）

| 流程 | 结果 |
|---|---|
| `qwen_t2i` | ✅ 完整跑通，400 s（含冷启动；832×1216 / 32 步 / cfg 2.5） |
| `qwen_edit` | ✅ 完整跑通，261 s（832×1216 / 25 步 / denoise 0.85） |
| `h3_t2v` | ⚠️ **图完全有效，但这台机器渲染不动**：模型初始化 24 分钟，之后约 **1437 s/步**（512×288 / 24 帧 / 4 步那次实测）；按默认（960×544 / 124 帧 / 8 步）外推是**几十小时一个视频** |
| `h3_ref2v` | ⚠️ 同上（提交阶段验证通过） |

视频瓶颈是硬件：H3 需要 10.77 GB DiT + 11.78 GB 文本编码器 + 4.85 GB 视频 VAE ≈ **27 GB**，
8 GB 显存装不下，只能 CPU offload，于是每步都在搬运。两套视频工作流**提交阶段零 `node_errors`**
（节点类齐全、模型文件存在、LoRA 名匹配）——图是对的，只是算不动。

### 在 ComfyUI 界面里用

4 套已放到 `ComfyUI/user/default/workflows/`：

```
R18-Qwen-文生图.api.json      R18-Qwen-改图.api.json
R18-H3-文生视频.api.json       R18-H3-参考图生视频.api.json
```

前端支持直接载入 API 格式 JSON（会自动铺成图），第一次打开后建议 Ctrl+S 存成普通工作流。
**不要用内置模板 “Text to Image (NetaYume Lumina)” 改 Qwen**——那套是 AuraFlow 采样 + `lumina2`
编码器 + SD3 空 latent，把 CLIP/VAE 指到 Qwen 文件上就会报"缺失模型"。

### 已修的坑

1. **`loraCatalog` 里 LoRA 名写成双反斜杠**（`H3R18\\name`）：视频流程自动挑 LoRA 时整链被 ComfyUI 拒绝。
   已改回单反斜杠，并在服务里加了 `canonicalLoraName()`——分隔符/大小写不敏感，提交前一律换成列表里的
   规范名，这类错误不会再出现。
2. `wfApplyLoras` 会先删掉工作流里原有的 LoRA 节点再按配置重建，所以 `baseLoras` / `loraCatalog`
   才是唯一事实来源；改 LoRA 请改配置，不要改 `.api.json`。
3. `dry_run` 与实跑的取值顺序已统一（`args → defaults → 图像预设`），避免"计划 32 步、实跑 25 步"。

## 提示词库（promptLibrary，已写进配置）

生图/改图的**使用提示词**都注册在 `config.json` 的 `promptLibrary` 里，
用 `prompt_preset` 按名字取用；`service_status` 会连提示词一起列出来。

| 名字 | 用途 | target | 绑定预设 |
|---|---|---|---|
| `solo_portrait` | 单人 · 半身肖像（最稳入门） | t2i | `r18_quality` |
| `full_body_standing` | 单人 · 全身站姿 | t2i | `r18_quality` |
| `window_light_nude` | 单人 · 窗户光氛围（背影回眸） | t2i | `r18_quality` |
| `explicit_closeup` | 单人 · 特写（解剖细节，带 `person_0040*`） | t2i | `r18_quality` |
| `lingerie_tease` | 单人 · 内衣/情色写真 | t2i | `r18_quality` |
| `duo_scene` | 双人 · 场景 | t2i | `r18_quality` |
| `edit_undress` | 改图 · 脱衣 | edit | `r18_quality` |
| `edit_lingerie` | 改图 · 换内衣 | edit | `r18_quality` |
| `edit_pose` | 改图 · 改姿势/机位 | edit | `r18_quality` |
| `edit_bg` | 改图 · 换背景 | edit | `r18_quality` |
| `edit_light` | 改图 · 改光线/氛围 | edit | `r18_quality` |
| `edit_detail` | 改图 · 增强解剖细节 | edit | `r18_quality` |

调用方式（`prompt_preset` 与 `preset` 可自由组合，显式参数永远优先）：

```
run_workflow(name="qwen_t2i",  prompt_preset="explicit_closeup",  dry_run=true)
run_workflow(name="qwen_edit", prompt_preset="edit_lingerie", source_image="<路径>")
generate_image(prompt_preset="lingerie_tease", seed=1234)          # 低层工具同样支持
prepare_image(prompt_preset="solo_portrait")                       # 走人工过目闸门
prepare_edit(source_image="<路径>", prompt_preset="edit_undress")
```

脚手架由工作流统一追加，模板里不必重复：
- 生图前缀：`nsfw_qwen_lora, `；后缀：`natural unretouched skin … no fused anatomy, no extra or duplicated limbs`
- 改图前缀：`nsfw_qwen_lora, `；后缀：`，保留主体外貌、动作、构图与光线`

## 改图（i2i）的硬规则与实测

**参考图路线（默认）必须 `denoise = 1.0`。**
`TextEncodeQwenImage21` 接上参考图后输出的 latent 是**空 latent**（参考图走 conditioning），
给它 `denoise 0.85` 等于"拿纯噪声按第 4 步的调度去噪"——画面必然崩坏。
实测三次复现（崩）× 三次对照（好），所以代码里已**强制忽略参考图路线的 denoise<1**，
并在 `sampling.note` 里说明；预设里的 `editDenoise` 也统一改成 1.0。

要"改动更小"请用真 img2img（`mode="img2img"`）：参考图 VAEEncode 成 latent 当起点，
denoise 0.6~0.8 才有意义，代价是**指令跟随明显变弱**（容易只做色调变化而不改内容）。

| 配置 | 实测执行 | 结果 |
|---|---|---|
| `r18_quality`（25 步 / cfg 2.5 / 2 LoRA / denoise 1.0） | **369 s** | 参考图完好，只换衣物，细节最稳 |
| `r18_fast`（8 步 turbo8 / cfg 1 / denoise 1.0） | **92 s** | 同样正确，速度约 1/4；纹理略粗 |

- 画布**跟随参考图**：`resolution` 是面积约束（832² ≈ 0.69 MP），竖构图参考图出图约 **704×992**。
- 改图**不插 `ModelSamplingFlux`**（作者说明：该节点仅用于文生图，改图用默认 shift）。
- 改图的提示词脚手架只用**触发词前缀 + 保留后缀**，不套生图那串英文质量词
  （否则模型容易"重新画一张"而不是"改这张"）。

### 本轮修掉的 4 个 bug

1. **改图 denoise<1 崩坏**：参考图路线误用两段式 + 中点起跑 → 已强制 denoise 1.0。
2. **预设步数被注册表 defaults 覆盖**：`preset="r18_fast"` 仍跑 25 步 → 现在取 `editSteps`/`steps`。
3. **`dry_run` 与实跑口径不一致**（计划 32 步、实跑 25 步）→ 两者用同一套取值顺序。
4. **`pv` 作用域错误**导致实跑报 `pv is not defined` → 已在分支外统一定义。

## 挂载（desktop profile）

编辑 `C:\Users\28256\.dsh\profiles\desktop\cordis.patch.yml`，追加：

```yaml
- id: mcp-comfyui
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: comfyui
    transport: stdio
    command: 'C:\Program Files\nodejs\node.exe'
    args:
      - 'C:\Users\28256\.dsh\mcp\comfyui-mcp\server.mjs'
    cwd: 'C:\Users\28256\.dsh\mcp\comfyui-mcp'
    toolCallTimeoutMs: 1800000
    failOnStartupError: false
    reconnect:
      enabled: true
```

- `toolCallTimeoutMs` 必须放大（默认 60 s 会掐断出图；8 GB 显存下 1024px 可能跑十几分钟）。
- `serverName: comfyui` 决定工具前缀 `mcp__comfyui__`。
- 改完 profile 需要重启 DSH Desktop 才生效；之后工具出现在模型的工具列表里。
- 若想让后续改动热加载，可在 `profiles/desktop/package.json` 的 `dsh.profile` 里加 `"patchReload": "live"`。

## 日常使用

1. **不用再自己开 ComfyUI 了**——`lifecycle.mode = managed` 时，出图会按需自动拉起（12~14 s），
   出图后释放显存，并**直接关闭 ComfyUI**（下次出图会自动再拉起）。（想自己开网页界面就调 `comfyui_power start`，那一次不会被自动关。）
2. Ollama 保持在线（`ollama list` 能看到模型即可）。
3. 在 DSH 里说「画一张……」，或先 `service_status` 自检。

> 如果你想回到旧习惯（自己双击 `run_nvidia_gpu.bat` 手动管理），把 `config.json` 的
> `comfyui.lifecycle.mode` 改成 `"external"` 即可，其余逻辑不变。
> 注意：**不要在 DSH 的沙箱里启动 ComfyUI**（命令行方式），它写自己的 `output/` 会被 ACL 拦下
> （实测 `Permission denied: ...\QwenImage21_0000N_.png`）；由 MCP 服务拉起没有这个问题。

## 方案二：ComfyUI 不常驻（按需启停）——修掉"启动就进恢复模式"

**问题**：DSH 宿主启动（`host-boot`＝恢复模式里的「启动插件服务」）在这台机器上基线要 **17.0 s**，
而 shell 等宿主的调用上限是 **30 s**（`HostRpc` 默认 `timeoutMs = 3e4`，非交互调用）。
只剩 13 s 余量。ComfyUI 一开着，磁盘 I/O（DSH 与 ComfyUI 同在 D: 卷）、CPU、
内存、显存四条线一起挤，17 s 轻松变 30 s+ → 进恢复模式。

**做法**：让 ComfyUI 的生命周期挂在 MCP 服务上，不再常驻。

```json
"lifecycle": {
  "mode": "managed",                 // managed=按需启停；external=你自己管（旧行为）
  "command": "cmd.exe",
  "args": ["/c", "run_nvidia_gpu.bat"],
  "cwd": "D:/ComfyUI_windows_portable",
  "launchLogFile": "./comfyui-launch.log",
  "stateFile": "./comfyui-mcp.state.json",
  "startTimeoutMs": 300000,
  "shutdownAfterGeneration": true,   // 出图一完成就关掉，释放显存
  "shutdownIdleMs": 0,               // 闲置自动关闭已停用（0=不启用）
  "freeVramAfterGeneration": true    // 关之前先把显存放掉
}
```

| 行为 | 说明 |
|---|---|
| **按需拉起** | 出图时若 ComfyUI 没在跑，自动启动并等到就绪（实测 **12~32 s**），无需你开窗口 |
| **出图完成即关闭** | 成功出图后先 `POST /free` 释放显存，再 `taskkill /T /F` 关进程——一次出图一次开关，不再常驻 |
| **队列非空就不关** | 关之前查 `GET /queue`：只要还有运行中/排队中的任务就跳过（见下面的复盘） |
| **只关自己拉起的实例** | 你手动启动的 ComfyUI，自动路径一律不碰 |
| **手动拉起可保留一次** | 用 `comfyui_power start` 亲手拉起的实例，完成一次出图后不会立刻被关（方便你在界面里继续操作），下一次出图完成后恢复自动关 |
| **出图失败/超时不动它** | 失败时既**不释放显存也不关进程**——任务很可能还在跑，动它就是打断它 |
| **服务退出带走它** | DSH 正常关闭时，MCP 服务退出钩子会杀掉自己拉起的 ComfyUI |
| **强杀自愈** | DSH 被任务管理器结束会跳过退出钩子，留下孤儿 ComfyUI。**下次服务启动时按"端口占用者"找到并收掉它**（状态文件只作线索，`netstat -ano` 的端口占用者才是事实） |

工具侧 **`mcp__comfyui__comfyui_power`**：

| action | 作用 |
|---|---|
| `status` | 看在线与否、显存、是否由本服务拉起、关闭策略 |
| `start` | 现在就拉起（例如你想开 ComfyUI 网页界面自己玩） |
| `stop` | 立刻关掉并腾出显存（能按端口收掉孤儿 python） |
| `free_vram` | 只释放显存，不关进程 |

### 复盘：为什么"图还没生完 ComfyUI 就被关了"

旧版是"**闲置 10 分钟自动关**"，而 10 分钟只是"没有新的 MCP 请求"的意思——**你在 ComfyUI 网页界面里自己点的生成，MCP 侧根本看不见**。
日志里抓到的那次：10:45:44 提交（576×1024 / 30 步），11:00:45 工具侧等待超时（旧上限 900 s），
11:10:45 闲置计时到点 → `taskkill` → **还在跑的任务被就地杀掉**。

这次一并修掉三处：

1. **不再有闲置计时**，改成"出图成功完成即关闭"；关之前查队列，非空就跳过 —— 你在界面里的任务再也不会被误杀。
2. **超时不再"顺手释放显存"**：旧代码在失败路径也会 `POST /free`，等于给正在跑的任务来了一下。现在只有成功才动 ComfyUI。
3. **等待上限 900 s → 1500 s**（25 分钟，仍早于 MCP 客户端的 30 分钟），超时信息里带上 `prompt_id` 并说明"没有关它、图会出现在 ComfyUI 的 output/"。

实测：`1088×1920` 这种大画布一次要 **8.8 分钟**，所以上限放宽是必要的。

> 关键坑（实测踩到并修掉）：Node 起的是 `cmd.exe /c run_nvidia_gpu.bat`，**真正的服务是它的子进程 python**。
> 宿主被强杀时 `cmd` 会随 stdin EOF 一起走，python 却会留下。所以"记录子进程 pid"不够，
> 必须按端口占用者（`netstat -ano`）定位。回归测试：`node verify-lifecycle.mjs`。

## 显存策略：Ollama 走 CPU，ComfyUI 独占显卡（8 GB 单卡的关键）

两个服务**任务层面是严格串行的**（先出提示词、拿到 JSON 才提交出图），但 **进程都是常驻的**，
真正的冲突在显存。实测（RTX 4060 Laptop 8 GB，768px / 10 步，固定参数）：

| 场景 | 显存占用 | 出图耗时 | ComfyUI 日志 |
|---|---|---|---|
| Ollama 不占显存，ComfyUI 模型驻留 | 5.4 GB / 剩 2.5 GB | **46.4 s** | 模型初始化 4 秒，之后 4.5 s/it |
| Ollama 把 7B 放显存（4.7 GB） | 7.7 GB / 剩 274 MiB | **332.5 s** | 模型被挤出，边采样边重载，前 4 步 22/79/99/100 秒 |

同一个请求，**差 7 倍**。原因不是算力竞争，而是 8 GB 装不下"Ollama 4.7 GB + ComfyUI 模型"，
ComfyUI 只能把 DiT/文本编码器重新从磁盘流进来。

所以 `config.json` 里默认：

```json
"ollama": { "device": "cpu", "keepAlive": "30m", "unloadAfterPrompt": true }
```

- **`device: "cpu"`（默认）**：提示词生成走原生 `/api/chat` 并带 `num_gpu: 0`，
  Ollama 完全不上显卡（`ollama ps` 显示 `100% CPU`，5.1 GB 在内存里）。实测生成提示词
  **8～11 秒**，显存占用**一点没变**，ComfyUI 的模型一直留在显存里。
  代价只是比 GPU 生成慢几秒——换来每张图省下约 5 分钟。
- **`device: "gpu"`**：走 OpenAI 兼容端点用显卡跑，快几秒，但会挤掉 ComfyUI 的模型；
  此时 `unloadAfterPrompt: true`（默认）会在生成完立刻用原生
  `POST /api/generate {"keep_alive": 0}` 卸载模型，把 4.7 GB 还给 ComfyUI
  （实测显存 7619 MiB → 3038 MiB）。

> 坑：**OpenAI 兼容端点会静默忽略 `keep_alive`**（实测请求成功但模型照旧驻留），
> 想控制驻留必须用原生 `/api/generate`、`/api/chat` 接口。
> 想彻底固定驻留策略，也可以在 Ollama 侧设环境变量 `OLLAMA_KEEP_ALIVE`。

## 实测耗时（RTX 4060 Laptop 8 GB，Qwen-Image 2.1 Q4 + qwen3-vl-8b 文本编码器）

| 步骤 | 实测 |
|---|---|
| `generate_prompts`（`device: cpu`，含模型加载） | 9 ~ 11 s |
| `generate_prompts`（`device: gpu`，热模型） | 1.8 ~ 8 s |
| 出图 768px / 10 步（ComfyUI 模型已驻留） | **46.4 s** |
| 出图 768px / 10 步（模型被挤出、需重载） | 332.5 s ← 所以要走 `device: cpu` |
| 出图 768px / 30 步（第一次，含模型加载） | 约 7 分钟 |
| 出图 768px / 30 步（模型驻留后） | 约 2.5 分钟（30 × 4.5 s + 收尾） |

**调参建议：反复试稿用 `resolution: 768` + `steps: 20`，定稿再上 1024/30。**
MCP 挂载里的 `toolCallTimeoutMs` 因此设成了 30 分钟。

## 更新部署

工作区里的 `tools/comfyui-mcp/` 是唯一源码；`C:\Users\28256\.dsh\mcp\comfyui-mcp\` 是实际被 DSH
加载的副本。改完源码同步过去（改 `config.json` 或 `server.mjs` 后需要重启 DSH Desktop）：

```powershell
Copy-Item "C:\Users\28256\Documents\deepseek-harness\default-workspace\tools\comfyui-mcp\*" `
          "C:\Users\28256\.dsh\mcp\comfyui-mcp\" -Force
```

## 常见故障

| 现象 | 原因 / 处理 |
|---|---|
| `连不上 ComfyUI` | 没启动，或端口不是 8188（改 `config.json` 的 `comfyui.baseURL`） |
| `连不上 Ollama` | `ollama serve` 没跑；或模型名变了（`config.json` 的 `ollama.model`） |
| `ComfyUI 拒绝工作流（node_errors）` | 工作流里的模型文件名对不上（换了 DiT/文本编码器/VAE 后要改 `workflow.api.json`） |
| 出图很慢 | 8 GB 显存跑 Qwen-Image 2.1 Q4 会走 offload；把 `resolution` 降到 768，或 `steps` 降到 20 |
| `等待出图超时` | 调大 `comfyui.generationTimeoutMs`；或先看 ComfyUI 控制台是否在排队 |
| 图片没在 `comfy-out/` | `downloadImages: false`，或 ComfyUI 的 `output/` 里有但取图失败（看 `comfyui-mcp.log`） |
| 改了 ComfyUI 工作流 | 重新导出 API 格式覆盖 `workflow.api.json`；只改提示词/尺寸/步数则不用改文件 |
| `按需拉起超时` | 看 `comfyui-launch.log`（ComfyUI 自己的输出）与 `comfyui-mcp.log`；显存被别的东西占满时启动会变慢 |
| 想让 ComfyUI 一直开着 | `config.json` 的 `shutdownAfterGeneration` 设 `false`（只释放显存不关进程），或直接 `comfyui_power start` 后别管它 |
| 想恢复"闲置自动关" | `shutdownIdleMs` 填毫秒数（例如 `600000`），会与"出图完成即关"同时生效 |
| 想彻底回到手动管理 | `lifecycle.mode` 改成 `"external"` |

## 已验证

- **分辨率与比例**：`width/height` 1344×768 出图并核对 PNG 真实尺寸 ✅；
  `aspect: "9:16"` + `resolution: 1024` → 576×1024 ✅；草稿记住尺寸、approve 不传就沿用（`sizeOverridden: false`）✅。
- **提示词截断兜底**：实测撞到一次"模型重复到被截断"的失败，修复后同一条描述正常出词。
- `initialize` 握手（协议 2025-06-18）、`tools/list`、六个工具的 schema 全部通过。
- **人工过目闸门**：`prepare_image` 只出提示词（`drewAnything: false`、无 `images`）；
  `approved:false` 不出图；伪造/过期/用过的 `draft_id` 一律被拒；真 id + `approved:true` 才出图。
- `service_status`：Ollama 在线 + 模型在列（CPU 模式），ComfyUI 在线/离线与 VRAM、工作流模型文件核对。
- `generate_prompts`：真实调用本地 7B（CPU 模式），返回中文正/负提示词。
- `prepare_image` + `approve_and_generate`：一句中文描述 → 提示词 → 过目 → ComfyUI 出图 → PNG 落到 `comfy-out/`
  （样张：`QwenImage21_00004_.png` 红玫瑰、`QwenImage21_00010_.png` 黄昏灯塔、`QwenImage21_00012_.png` 雨夜红伞）。
- **按需启停**：`comfyui_power start` 冷启动 12~14 s 就绪；出图后显存降到 ~1 GB 占用；
  `stop` 能按端口收掉孤儿 python（实测结束 pid 37144）。
- **出图完成即关闭**：`closedAfterRun: true` / `closeReason: "出图完成即关闭以释放显存"`，随后端口确认已关、显存回到 ~1.1 GB 占用 ✅
- **闲置自动关闭已停用**：`shutdownIdleMs: 0` ✅
- **强杀自愈**：硬杀 MCP 服务后，新实例日志出现
  `发现上次遗留的 ComfyUI（pid=37580）… 先结束它`，端口随即确认关闭，状态文件被清空。

## 设计取舍

- **零依赖**：不装 npm 包，不受 MCP SDK / 上游版本漂移影响；协议版本按客户端请求回显
  （支持 2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05 / 2024-10-07）。
- **API 工作流单独存放**：ComfyUI 的 `/prompt` 只吃 API 格式。UI 格式留给你在界面里改，
  API 格式给机器用，两者分开互不干扰。
- **默认负面词来自工作流**：server 会读 UI 工作流文件里节点 4 的第二个控件作为兜底负面词，
  所以换了工作流不必改代码。
- **图片默认返回路径而非图像块**：deepseek-flash 不吃图片输入，返回图像块只会多出一行诊断；
  需要内联显示时把 `config.json` 的 `returnImageBlocks` 改成 `true`（用支持视觉的模型时）。
