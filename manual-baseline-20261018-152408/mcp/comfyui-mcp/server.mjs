#!/usr/bin/env node
/**
 * comfyui-mcp — MCP stdio server for the local pipeline:
 *
 *     DSH agent  →  Ollama (7B, 生成正面/负面提示词)  →  ComfyUI (Qwen-Image 2.1 GGUF 出图)
 *
 * Zero dependencies (Node >= 18: uses global fetch). stdout is the JSON-RPC
 * transport — every diagnostic goes to stderr and/or the log file.
 *
 * Tools
 *   service_status          Ollama / ComfyUI 存活与本机模型自检
 *   comfyui_power           ComfyUI 启停与显存（managed 模式按需拉起）
 *   generate_prompts        描述 → { positive, negative }（只出文字）
 *   prepare_image           描述 → 正/负提示词 + draft_id（文生图第一步）
 *   prepare_edit            参考图 + 修改要求 → 编辑指令 + draft_id（改图第一步）
 *   approve_and_generate    用户同意后凭 draft_id 出图（第二步，闸门）
 *   generate_image          用户直接给出提示词时出图
 *   comfyui_power           ComfyUI 启停与显存
 *
 * This file reads config.json next to it. Nothing is written outside the
 * configured inbox directory.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_NAME = "comfyui-mcp";
const SERVER_VERSION = "1.1.0";

// Protocol revisions the DSH MCP client (official SDK 1.30.0) accepts.
const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const FALLBACK_PROTOCOL = "2025-06-18";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

const DEFAULTS = {
  ollama: {
    baseURL: "http://127.0.0.1:11434",
    model: "hf.co/QuantFactory/Qwen2.5-7B-Instruct-Uncensored-GGUF:Q4_K_M",
    // "cpu"：提示词生成强制走 CPU（num_gpu=0），完全不占显存，8 GB 单卡首选。
    // "gpu"：走 OpenAI 兼容端点用显卡跑，快几秒，但会把 ComfyUI 的模型挤出显存。
    device: "cpu",
    timeoutMs: 180000,
    maxTokens: 900,
    temperature: 0.7,
    // OpenAI 兼容端点会静默忽略 keep_alive，所以"生成完就卸"必须走原生 /api/generate。
    keepAlive: "30m",
    // true：每次生成完提示词立刻卸载 Ollama 模型，把 4.7 GB 显存让给 ComfyUI 采样。
    // 8 GB 显存强烈建议开着；显存充裕、想省下重载时间的机器可以关掉。
    unloadAfterPrompt: true,
  },
  comfyui: {
    baseURL: "http://127.0.0.1:8188",
    apiWorkflowFile: "./workflow.api.json",
    uiWorkflowFile:
      "D:/ComfyUI_windows_portable/ComfyUI/user/default/workflows/Qwen-Image-2.1-UC-GGUF-T2I.json",
    promptNodeId: "4",
    clipNodeId: "2",
    seedNodeId: "5",
    // 两段式采样（作者推荐）：前段 cfg 1 锁构图/材质，后段 cfg 3 + 负面词重写文字
    samplerNode2Id: "11",
    loadImageNodeId: "10",
    // 改图时参考图要复制进 ComfyUI 的 input 目录（LoadImage 只认那里）
    inputDir: "D:/ComfyUI_windows_portable/ComfyUI/input",
    saveNodeId: "7",
    // 64 通道空 latent 节点（自定义节点 DshEmptyQwenImage21Latent），负责任意宽高/比例
    latentNodeId: "9",
    // LoRA：按调用动态插入 LoraLoaderModelOnly 链（只作用于模型侧），采样节点的 model 输入跟着重接
    loraClass: "LoraLoaderModelOnly",
    modelSourceNodeId: "1",
    loraDir: "D:/ComfyUI_windows_portable/ComfyUI/models/loras",
    sizeAlign: 32,
    sizeMin: 256,
    sizeMax: 4096,
    clientId: "dsh-comfyui-mcp",
    defaultResolution: 1024,
    resolutionMin: 512,
    resolutionMax: 2048,
    defaultSteps: 25,
    // Qwen-Image-2.1 是全量（非蒸馏）模型：25 步即可，更多步只会烧高光。
    // 默认单段 cfg 1.0（最快、作者对"无文字"场景的推荐）；
    // 图里要有可读文字时把 cfgHigh 提到 3（后段配负面词重写字），代价约 +20~25% 时间。
    cfgLow: 1.0,
    cfgHigh: 1.0,
    cfgSplitRatio: 0.56,
    defaultCfg: 1.0,
    // 改图默认强度：1.0 = 完全按参考 latent + 指令重构
    editDenoise: 1.0,
    samplerName: "euler",
    scheduler: "simple",
    denoise: 1.0,
    requestTimeoutMs: 60000,
    pollIntervalMs: 1500,
    // 大画布很慢：1088×1920 实测约 8.8 分钟，所以给到 25 分钟
    // （MCP 客户端的 toolCallTimeoutMs 是 30 分钟，服务端要早一步报错）
    generationTimeoutMs: 1500000,
    /**
     * 方案二：拆负载 —— ComfyUI 不再常驻。
     *  managed ：MCP 服务按需拉起 ComfyUI，出图后释放显存，闲置就关掉进程。
     *            因为它是 MCP 服务的子进程，DSH 一重启它就已经没了，
     *            于是"DSH 启动"与"ComfyUI 吃磁盘/CPU/显存"永远不会重叠。
     *  external：沿用旧行为，ComfyUI 由你自己启动、自己管理。
     */
    lifecycle: {
      mode: "managed",
      command: "cmd.exe",
      args: ["/c", "run_nvidia_gpu.bat"],
      cwd: "D:/ComfyUI_windows_portable",
      launchLogFile: "./comfyui-launch.log",
      stateFile: "./comfyui-mcp.state.json",
      startTimeoutMs: 300000,
      // 出图一完成就关掉 ComfyUI 释放显存（队列非空时会自动跳过，见 closeAfterGeneration）
      shutdownAfterGeneration: true,
      // 闲置自动关闭已停用：留 0 表示不启用。改成毫秒数可恢复"闲置多久后关"的行为。
      shutdownIdleMs: 0,
      // 每次出图结束立刻把模型从显存卸载（几十毫秒），不等关进程
      freeVramAfterGeneration: true,
    },
  },
  // 出图先落到对话工作区根目录，等用户判断后再归档到 output / bad_output
  inboxDir: "C:/Users/28256/Documents/deepseek-harness/default-workspace",
  outputDir: null, // 默认 = inboxDir/output
  badOutputDir: null, // 默认 = inboxDir/bad_output
  referringDir: null, // 默认 = inboxDir/referring（改图参考图存档）
  // 预设配方（LoRA 组合 + 步数 + 尺寸 + 提示词脚手架），见 config.json 的 presets
  presets: {},
  // 工作流注册表（一个名字 = 一个 API 工作流 + 节点映射），见 config.json 的 workflows
  workflows: {},
  // LoRA 目录（自动选 LoRA 用）：效果/标签/强度，见 config.json 的 loraCatalog
  loraCatalog: {},
  downloadImages: true,
  // prepare_image 草稿的有效期：超时或已用过的草稿都不能再出图（人工过目闸门）
  draftTtlMs: 1800000,
  // Vision-capable agent models can show the PNG inline; text-only models get a
  // diagnostic line instead, so this defaults to off.
  returnImageBlocks: false,
  logFile: "./comfyui-mcp.log",
};

function resolvePath(p, base = __dirname) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.resolve(base, p);
}

function loadConfig() {
  const cfg = structuredClone(DEFAULTS);
  const file = path.join(__dirname, "config.json");
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err && err.code !== "ENOENT") logLine(`config.json 无法解析，使用内置默认值：${err.message}`);
  }
  if (raw) {
    for (const section of ["ollama", "comfyui"]) {
      if (raw[section] && typeof raw[section] === "object") Object.assign(cfg[section], raw[section]);
    }
    // 其余顶层键全部照搬 —— 之前用白名单，presets / promptLibrary 这类新段落被静默忽略过两次，
    // 所以这里改成通用合并：config.json 里写了什么，运行时就一定拿得到。
    for (const [key, value] of Object.entries(raw)) {
      if (key === "ollama" || key === "comfyui" || value === undefined) continue;
      cfg[key] = value;
    }
  }
  cfg.ollama.baseURL = String(cfg.ollama.baseURL).replace(/\/+$/, "");
  cfg.comfyui.baseURL = String(cfg.comfyui.baseURL).replace(/\/+$/, "");
  cfg.comfyui.apiWorkflowFile = resolvePath(cfg.comfyui.apiWorkflowFile);
  cfg.comfyui.uiWorkflowFile = resolvePath(cfg.comfyui.uiWorkflowFile, process.cwd());
  cfg.inboxDir = resolvePath(cfg.inboxDir, process.cwd());
  cfg.outputDir = resolvePath(cfg.outputDir ?? path.join(cfg.inboxDir, "output"), process.cwd());
  cfg.badOutputDir = resolvePath(cfg.badOutputDir ?? path.join(cfg.inboxDir, "bad_output"), process.cwd());
  cfg.referringDir = resolvePath(cfg.referringDir ?? path.join(cfg.inboxDir, "referring"), process.cwd());
  cfg.logFile = resolvePath(cfg.logFile);
  for (const wf of Object.values(cfg.workflows ?? {})) {
    if (wf?.apiWorkflowFile) wf.apiWorkflowFile = resolvePath(wf.apiWorkflowFile);
  }
  return cfg;
}

const CFG = loadConfig();

/**
 * 当前"正在跟我说话"的那个对话的工作区。
 *
 * DSH 的 MCP 客户端是 profile 级的一条 insert —— 一个进程服务所有对话，
 * 协议里也拿不到调用方身份；但每个对话的会话记录 (~/.dsh/sessions/<转义工作区>/<session>/session.v4.jsonl.zstd)
 * 首帧就是自己的头（含 cwd），而**正在调用的那个对话**的记录必然是最新被写入的。
 * 于是：取 mtime 最新的会话记录 → 读首帧 → 它的 cwd 就是本次调用所属的工作区。
 * 显式传入 workspace 时优先用传入值；这里只是"没传时的兜底"。
 */
let _activeWs = null;
let _activeWsAt = 0;
function activeSessionInfo() {
  if (_activeWs && Date.now() - _activeWsAt < 5000) return _activeWs;
  let best = null;
  try {
    const sessions = path.join(os.homedir(), ".dsh", "sessions");
    const entries = [];
    for (const wsDir of fs.readdirSync(sessions)) {
      const d = path.join(sessions, wsDir);
      let names = [];
      try {
        names = fs.readdirSync(d);
      } catch {
        continue;
      }
      for (const n of names) {
        const f = path.join(d, n, "session.v4.jsonl.zstd");
        try {
          const st = fs.statSync(f);
          if (st.isFile()) entries.push({ f, mtime: st.mtimeMs, wsDir });
        } catch {}
      }
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    for (const e of entries.slice(0, 3)) {
      let head = null;
      try {
        const fd = fs.openSync(e.f, "r");
        const buf = Buffer.alloc(65536);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        head = zlib.zstdDecompressSync(buf.subarray(0, n)).toString("utf8");
      } catch {
        continue;
      }
      for (const line of head.split("\n", 5)) {
        if (!line.includes('"type":"session"')) continue;
        try {
          const j = JSON.parse(line);
          if (j.cwd) {
            best = { workspace: j.cwd, session: j.id ?? null, transcript: e.f, mtime: e.mtime, source: "最近活动的会话记录" };
          }
        } catch {}
        break;
      }
      if (best) break;
    }
  } catch {}
  _activeWs = best;
  _activeWsAt = Date.now();
  return best;
}

/**
 * 归档目录解析：**优先按调用传入的工作区根目录**（ws）；
 * 没传时用"最近活动的会话"的工作区；再兜底才用 config.json 的默认值。
 * 这样同一个 MCP 服务可以服务不同对话/不同工作区：
 *   传 workspace        → <workspace>/{output,bad_output,referring}
 *   没传但有活动会话    → <该对话工作区>/{output,bad_output,referring}
 *   都没有              → config.json 的 inboxDir / outputDir / badOutputDir / referringDir
 */
function workspaceDirs(ws) {
  const raw = ws === undefined || ws === null ? "" : String(ws).trim();
  if (!raw) {
    const act = activeSessionInfo();
    if (act?.workspace) {
      const root = resolvePath(act.workspace);
      return {
        root,
        output: path.join(root, "output"),
        badOutput: path.join(root, "bad_output"),
        referring: path.join(root, "referring"),
        explicit: false,
        source: `自动识别：最近活动的对话 ${act.session ?? ""}`,
      };
    }
    return {
      root: CFG.inboxDir,
      output: CFG.outputDir,
      badOutput: CFG.badOutputDir,
      referring: CFG.referringDir,
      explicit: false,
      source: "config.json 默认值",
    };
  }
  const root = resolvePath(raw);
  return {
    root,
    output: path.join(root, "output"),
    badOutput: path.join(root, "bad_output"),
    referring: path.join(root, "referring"),
    explicit: true,
    source: "调用传入的 workspace",
  };
}

/** 给结果里附一份"这批图会归到哪"的说明，便于核对是否落在当前对话的工作区。 */
function folderView(ws) {
  const d = workspaceDirs(ws);
  return {
    workspace: d.root,
    output: d.output,
    badOutput: d.badOutput,
    referring: d.referring,
    source: d.explicit ? "调用传入的 workspace（当前对话工作区）" : (d.source ?? "默认值"),
  };
}

function logLine(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    process.stderr.write(`[comfyui-mcp] ${msg}\n`);
  } catch {}
  try {
    fs.appendFileSync(CFG.logFile, line);
  } catch {}
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function httpJson(url, { method = "GET", body, timeoutMs = 60000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    const reason = err?.name === "AbortError" ? `请求超时（${timeoutMs}ms）` : err?.message || String(err);
    return { ok: false, status: 0, json: null, text: reason, networkError: true };
  } finally {
    clearTimeout(timer);
  }
}

function shortText(t, n = 400) {
  const s = typeof t === "string" ? t : JSON.stringify(t ?? "");
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ---------------------------------------------------------------------------
// Ollama — prompt generation
// ---------------------------------------------------------------------------

function buildSystemPrompt(language, style, strict = false, intent = "t2i") {
  const langLine =
    language === "en"
      ? "positive 用英文书写。"
      : language === "auto"
        ? "positive 用与用户描述相同的语言书写。"
        : "positive 用中文书写。";
  const styleLine = style ? `画面风格固定为：${style}。` : "";

  if (intent === "edit") {
    // 改图：参考图由工作流喂给模型，这里只需要把它要改什么、要保什么说清楚
    return [
      "你是 Qwen-Image 2.1 的图像编辑提示词工程师。用户会给一张参考图和一句修改要求，你要把它写成一条精确的编辑指令。",
      "",
      strict
        ? "positive：**硬上限 80 字**。句式：先说要改的部分（改成什么样），再说要保留的部分（主体、动作、构图、光线）。写完立刻停。"
        : "positive：一条编辑指令，80~120 字。必须包含两部分：(1) 明确要改什么、改成什么；(2) 明确保留什么（主体外貌、动作、构图、光线、风格）。不要罗列零散关键词，不要出现“提示词/图片/生成”等元话术。",
      strict ? "negative：中文逗号分隔，**最多 8 个词**。" : "negative：用中文逗号分隔的画质缺陷与结构错误词（8~12 个），覆盖清晰度、人体结构、手部、面部细节、文字。",
      langLine,
      styleLine,
      "",
      "只输出 JSON，不要解释，不要 Markdown 代码块。JSON 必须完整闭合。",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    "你是 Qwen-Image 2.1 的提示词工程师。根据用户的描述，产出一组生图提示词。",
    "",
    strict
      ? "positive：一段自然语言画面描述，**硬上限 100 字**。只写最关键的要素（主体、动作、环境、光线、镜头），写完立刻停，绝对不要重复同一句话。"
      : "positive：一段连贯的自然语言画面描述，依次交代主体、外貌与服装、动作与神态、环境、光线、镜头与构图、画质。80~150 字，写完即停，不要重复堆砌，不要出现“提示词/图片/生成”等元话术。",
    strict
      ? "negative：中文逗号分隔，**最多 8 个词**。"
      : "negative：用中文逗号分隔的画质缺陷与结构错误词（8~12 个），覆盖清晰度、人体结构、手部、面部细节、色彩与文字。",
    langLine,
    styleLine,
    "",
    "只输出 JSON，不要解释，不要 Markdown 代码块。JSON 必须完整闭合。",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 兜底解析：模型写太长被 max_tokens 截断时，JSON 会缺收尾的引号和花括号。
 * 这时按字段名把内容抠出来，比整条请求失败强得多。
 */
function salvagePrompts(content) {
  if (typeof content !== "string") return null;
  const grab = (key) => {
    const closed = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(content);
    if (closed) return closed[1];
    const open = new RegExp(`"${key}"\\s*:\\s*"([^"]*)$`).exec(content);
    return open ? open[1] : null;
  };
  const positive = grab("positive");
  if (!positive) return null;
  const negative = grab("negative");
  const unescape = (s) => String(s).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return { positive: unescape(positive), negative: negative ? unescape(negative) : "", salvaged: true };
}

function extractJson(content) {
  if (typeof content !== "string") return null;
  const cleaned = content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {}
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {}
  }
  return null;
}

const PROMPT_SCHEMA = {
  type: "object",
  properties: { positive: { type: "string" }, negative: { type: "string" } },
  required: ["positive", "negative"],
};

/**
 * 原生 /api/chat：可以按请求指定 `num_gpu`。
 *
 * 8 GB 单卡上这是关键：把 Ollama 压到 CPU（num_gpu: 0）后它一点显存都不占，
 * ComfyUI 就能一直把 DiT / 文本编码器留在显存里。实测同一台机器、同样 768px/10 步：
 *   Ollama 占着显存 → 332.5s（ComfyUI 被迫重新加载模型）
 *   Ollama 在 CPU   → 46.4s 且显存占用纹丝不动
 * 代价只是提示词生成从约 4s 变成约 9s（含模型加载）。
 * 另外该端点真正接受 keep_alive（OpenAI 兼容端点会静默忽略）。
 */
async function ollamaChatNative({ system, user, temperature, numGpu }) {
  const options = { temperature, num_predict: CFG.ollama.maxTokens };
  if (numGpu !== undefined) options.num_gpu = numGpu;
  const body = {
    model: CFG.ollama.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    format: PROMPT_SCHEMA,
    stream: false,
    options,
  };
  if (CFG.ollama.keepAlive) body.keep_alive = CFG.ollama.keepAlive;

  const res = await httpJson(`${CFG.ollama.baseURL}/api/chat`, {
    method: "POST",
    body,
    timeoutMs: CFG.ollama.timeoutMs,
  });
  if (res.networkError) {
    throw new Error(
      `连不上 Ollama（${CFG.ollama.baseURL}）：${res.text}。请确认 ollama 已在运行（ollama list）。`,
    );
  }
  if (!res.ok) throw new Error(`Ollama /api/chat 返回 ${res.status}：${shortText(res.text)}`);
  return {
    content: res.json?.message?.content ?? "",
    usage: {
      prompt_tokens: res.json?.prompt_eval_count ?? null,
      completion_tokens: res.json?.eval_count ?? null,
      total_duration_ms: res.json?.total_duration ? Math.round(res.json.total_duration / 1e6) : null,
    },
    model: res.json?.model ?? CFG.ollama.model,
  };
}

/** OpenAI 兼容端点：`device: gpu` 时使用（它忽略 keep_alive，所以要靠 ollamaUnload 收尾）。 */
async function ollamaChatOpenAi({ system, user, temperature }) {
  const body = {
    model: CFG.ollama.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: { name: "image_prompts", schema: PROMPT_SCHEMA } },
    max_tokens: CFG.ollama.maxTokens,
    temperature,
    stream: false,
  };
  if (CFG.ollama.keepAlive) body.keep_alive = CFG.ollama.keepAlive;

  const url = `${CFG.ollama.baseURL}/v1/chat/completions`;
  let res = await httpJson(url, { method: "POST", body, timeoutMs: CFG.ollama.timeoutMs });
  // 某些 Ollama 构建会拒绝未知顶层字段；被拒绝时不带 keep_alive 重试一次。
  if (!res.ok && body.keep_alive && res.status === 400) {
    logLine("Ollama 拒绝了 keep_alive，改为不带该字段重试");
    delete body.keep_alive;
    res = await httpJson(url, { method: "POST", body, timeoutMs: CFG.ollama.timeoutMs });
  }
  if (res.networkError) {
    throw new Error(
      `连不上 Ollama（${CFG.ollama.baseURL}）：${res.text}。请确认 ollama 已在运行（ollama list）。`,
    );
  }
  if (!res.ok) throw new Error(`Ollama 返回 ${res.status}：${shortText(res.text)}`);
  return {
    content: res.json?.choices?.[0]?.message?.content ?? "",
    usage: res.json?.usage ?? null,
    model: res.json?.model ?? CFG.ollama.model,
  };
}

async function ollamaPromptsOnce({ description, style, language = "zh", extraNegative, temperature, strict = false, intent = "t2i" }) {
  const temp = typeof temperature === "number" ? temperature : CFG.ollama.temperature;
  const system = buildSystemPrompt(language, style, strict, intent);
  const device = String(CFG.ollama.device ?? "cpu").toLowerCase();

  const reply =
    device === "gpu"
      ? await ollamaChatOpenAi({ system, user: description, temperature: temp })
      : await ollamaChatNative({ system, user: description, temperature: temp, numGpu: 0 });

  const parsed = extractJson(reply.content) ?? salvagePrompts(reply.content);
  if (!parsed || typeof parsed.positive !== "string" || !parsed.positive.trim()) {
    throw new Error(`Ollama 输出无法解析为 {positive, negative}：${shortText(reply.content, 300)}`);
  }
  const negative = [String(parsed.negative ?? "").trim(), extraNegative ? String(extraNegative).trim() : ""]
    .filter(Boolean)
    .join("，");

  let vramHandoff = null;
  if (device === "gpu" && CFG.ollama.unloadAfterPrompt) {
    await ollamaUnload();
    vramHandoff = "已卸载 Ollama 模型，显存交给 ComfyUI";
  } else if (device === "gpu") {
    vramHandoff = null;
  } else {
    vramHandoff = "Ollama 在 CPU 上生成，未占用显存，ComfyUI 模型保持驻留";
  }

  return {
    positive: parsed.positive.trim(),
    negative: negative || defaultNegative(),
    usage: reply.usage,
    model: reply.model,
    engine: device === "gpu" ? "gpu（OpenAI 兼容端点）" : "cpu（原生 /api/chat, num_gpu=0）",
    salvaged: parsed.salvaged === true || undefined,
    strictRetry: strict || undefined,
    vramHandoff,
  };
}

/**
 * 7B 写长文容易越写越重复，最后被 max_tokens 截断、JSON 就断了。
 * 所以：先用普通指令跑；失败或疑似截断时，用"硬上限 100 字"的严格指令再跑一次。
 */
async function ollamaPrompts(args) {
  try {
    return await ollamaPromptsOnce({ ...args, strict: false });
  } catch (err) {
    logLine(`提示词生成失败（${err?.message || err}），改用严格指令重试一次`);
    return await ollamaPromptsOnce({ ...args, strict: true });
  }
}

/**
 * 原生卸载：POST /api/generate {keep_alive: 0} → done_reason: "unload"。
 * 实测可把显存占用从 7.6 GB 降到 3 GB 左右（ComfyUI 自身缓存除外）。
 * 失败不影响出图，只记日志。
 */
async function ollamaUnload() {
  const res = await httpJson(`${CFG.ollama.baseURL}/api/generate`, {
    method: "POST",
    body: { model: CFG.ollama.model, keep_alive: 0 },
    timeoutMs: 30000,
  });
  if (res.ok) logLine("已卸载 Ollama 模型（显存移交 ComfyUI）");
  else logLine(`Ollama 卸载失败（不致命）：${res.networkError ? res.text : `HTTP ${res.status}`}`);
}

/** 工作流里作者写好的中文负面词，作为兜底。 */let _defaultNegative = null;
function defaultNegative() {
  if (_defaultNegative) return _defaultNegative;
  _defaultNegative = "低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感，构图混乱，文字模糊，扭曲";
  try {
    const ui = JSON.parse(fs.readFileSync(CFG.comfyui.uiWorkflowFile, "utf8").replace(/^\uFEFF/, ""));
    const node = (ui.nodes || []).find((n) => String(n.id) === String(CFG.comfyui.promptNodeId));
    const w = node?.widgets_values;
    if (Array.isArray(w) && typeof w[1] === "string" && w[1].trim()) {
      _defaultNegative = w[1].trim();
      logLine("已从工作流文件读取默认负面提示词");
    }
  } catch {}
  return _defaultNegative;
}

/** 工作流文件里的默认分辨率（node 4 的第三个控件）。 */
function defaultResolution() {
  try {
    const ui = JSON.parse(fs.readFileSync(CFG.comfyui.uiWorkflowFile, "utf8").replace(/^\uFEFF/, ""));
    const node = (ui.nodes || []).find((n) => String(n.id) === String(CFG.comfyui.promptNodeId));
    const w = node?.widgets_values;
    if (Array.isArray(w) && Number.isFinite(Number(w[2]))) return Number(w[2]);
  } catch {}
  return CFG.comfyui.defaultResolution;
}

// ---------------------------------------------------------------------------
// ComfyUI — workflow submission
// ---------------------------------------------------------------------------

let _template = null;
function apiTemplate() {
  if (_template) return _template;
  const raw = JSON.parse(fs.readFileSync(CFG.comfyui.apiWorkflowFile, "utf8").replace(/^\uFEFF/, ""));
  _template = raw.prompt && typeof raw.prompt === "object" ? raw.prompt : raw;
  return _template;
}

/**
 * 尺寸解析：三种给法，优先级从高到低
 *   1) width + height  直接指定（只给一个时按正方形处理）
 *   2) aspect（如 "16:9"）+ resolution（当长边用，省略时用工作流默认）
 *   3) resolution      正方形边长（兼容旧行为）
 * 输出一律就近对齐到 sizeAlign（默认 32）的倍数：Qwen-Image 2.1 的 latent 是 16 倍下采样，
 * 不对齐就会出现"填 1000 实际拿到 992"这类意外。
 */
function resolveSize({ width, height, aspect, resolution } = {}) {
  const align = Number(CFG.comfyui.sizeAlign ?? 32) || 32;
  const min = Number(CFG.comfyui.sizeMin ?? 256) || 256;
  const max = Number(CFG.comfyui.sizeMax ?? 4096) || 4096;
  const snap = (v) => Math.min(max, Math.max(min, Math.round(Number(v) / align) * align));

  const hasW = width !== undefined && width !== null && width !== "";
  const hasH = height !== undefined && height !== null && height !== "";
  if (hasW || hasH) {
    const w = snap(hasW ? width : height);
    const h = snap(hasH ? height : width);
    return { width: w, height: h, source: hasW && hasH ? "width/height" : "单边（按正方形补齐）" };
  }

  const long = snap(resolution ?? CFG.comfyui.defaultResolution ?? 1024);
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x×/]\s*(\d+(?:\.\d+)?)\s*$/i.exec(String(aspect ?? ""));
  if (!m) return { width: long, height: long, source: "resolution（正方形）" };

  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!(a > 0) || !(b > 0)) return { width: long, height: long, source: "resolution（正方形）" };
  const landscape = a >= b;
  const w = landscape ? long : (long * a) / b;
  const h = landscape ? (long * b) / a : long;
  return { width: snap(w), height: snap(h), source: `aspect ${a}:${b} @ 长边 ${long}` };
}

/** 参考图落进 ComfyUI 的 input 目录；DSH 的附件没有扩展名，所以按魔数补一个。 */
function sniffImageExt(buf) {
  if (buf.length > 8 && buf.toString("latin1", 1, 4) === "PNG") return ".png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return ".webp";
  if (buf.toString("latin1", 0, 3) === "GIF") return ".gif";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return ".bmp";
  return ".png";
}

/** 文件名不该出现的字符统一压成 '-'，CJK 保留（体现画面特征用）。 */
function slugify(s, max = 28) {
  const t = String(s ?? "")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
    .replace(/[，。、！？；：“”‘’（）【】《》,.!?;:'"()\[\]]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return t.slice(0, max);
}

/** 预设名简写，让文件名一眼能看出用了哪档。 */
function presetTag(key) {
  return (
    {
      r18_quality: "r18q",
      r18_fast: "r18f",
      r18_fast_plus: "r18fp",
      portrait_clean: "clean",
    }[key] ?? slugify(key ?? "", 12)
  );
}

function uniquePath(dir, base, ext) {
  let p = path.join(dir, `${base}${ext}`);
  let i = 2;
  while (fs.existsSync(p)) {
    p = path.join(dir, `${base}-${i}${ext}`);
    i++;
  }
  return p;
}

/**
 * 参考图落两处：
 *  1) ComfyUI 的 input 目录（LoadImage 只认那里，名字随机避免撞车）
 *  2) 工作区的 referring/ 存档（名字体现来源，便于回看）
 */
function stageReferenceImage(srcPath, ws) {
  const p = String(srcPath);
  if (!fs.existsSync(p)) throw new Error(`参考图不存在：${p}`);
  const buf = fs.readFileSync(p);
  const ext = sniffImageExt(buf);
  const name = `dsh_edit_${Date.now().toString(36)}${ext}`;
  const dir = resolvePath(CFG.comfyui.inputDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buf);

  let referringPath = null;
  try {
    const refDir = workspaceDirs(ws).referring;
    fs.mkdirSync(refDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/(\d{8})(\d{4})/, "$1-$2");
    const base = `ref_${slugify(path.basename(p, path.extname(p)), 24) || "image"}_${stamp}`;
    referringPath = uniquePath(refDir, base, ext);
    fs.writeFileSync(referringPath, buf);
  } catch (err) {
    logLine(`参考图存档到 referring 失败（不致命）：${err?.message || err}`);
  }
  logLine(
    `参考图已就位：input/${name}${referringPath ? `；存档 ${referringPath}` : ""}（${(buf.length / 1024).toFixed(0)} KB，源 ${p}）`,
  );
  return { name, ext, bytes: buf.length, sourcePath: p, referringPath };
}

function buildGraph({
  positive,
  negative,
  resolution,
  width,
  height,
  aspect,
  seed,
  steps,
  cfg,
  cfgLow,
  cfgHigh,
  cfgSplitStep,
  denoise,
  mode = "t2i",
  referenceFile,
  loras,
  samplingShift,
  filenamePrefix,
}) {
  const graph = structuredClone(apiTemplate());
  const promptNode = graph[CFG.comfyui.promptNodeId];
  if (!promptNode) throw new Error(`API 工作流缺少节点 ${CFG.comfyui.promptNodeId}`);
  promptNode.inputs.prompt = positive;
  promptNode.inputs.negative_prompt = negative ?? defaultNegative();

  const isEdit = (mode === "edit" || mode === "img2img") && !!referenceFile;
  const isImg2Img = mode === "img2img" && !!referenceFile;
  const size = resolveSize({ width, height, aspect, resolution });
  const sizeNode = graph[CFG.comfyui.latentNodeId];
  const vaeNodeId = CFG.comfyui.vaeNodeId ?? "3";
  let latentRef = [CFG.comfyui.latentNodeId, 0];

  if (isEdit) {
    // 改图（作者设计的官方路线）：参考图进节点的 images，同时接上 vae →
    // 节点内部 keep_vision=False，参考图走 conditioning，节点输出的 latent 是**空 latent**；
    // 画布跟随参考图，采样必须 denoise 1.0。
    const loadId = CFG.comfyui.loadImageNodeId ?? "10";
    graph[loadId] = { class_type: "LoadImage", inputs: { image: referenceFile } };
    promptNode.inputs.resolution = size.width;
    if (isImg2Img) {
      // 真 img2img：参考图编码成 latent 当起点，denoise 才有意义（代价是指令跟随明显变弱）
      graph["vaeencode"] = { class_type: "VAEEncode", inputs: { pixels: [loadId, 0], vae: [vaeNodeId, 0] } };
      latentRef = ["vaeencode", 0];
    } else {
      promptNode.inputs["images.image_1"] = [loadId, 0];
      promptNode.inputs.vae = [vaeNodeId, 0];
      latentRef = [CFG.comfyui.promptNodeId, 2];
    }
  } else {
    if (sizeNode) {
      sizeNode.inputs.width = size.width;
      sizeNode.inputs.height = size.height;
      sizeNode.inputs.batch_size = sizeNode.inputs.batch_size ?? 1;
    }
    // 旧接线（方形）也同步写一份，保证工作流没接新节点时仍能跑
    promptNode.inputs.resolution = Math.max(size.width, size.height);
  }

  // ---- 采样参数（两段式，作者推荐）----------------------------------------
  const totalSteps = Math.max(1, Math.floor(Number(steps ?? CFG.comfyui.defaultSteps)));
  // 显式给 cfg 就两段同值（等于一发到底）；否则 前段 cfgLow → 后段 cfgHigh
  const single = cfg !== undefined && cfg !== null;
  const lowCfg = single ? Number(cfg) : Number(cfgLow ?? CFG.comfyui.cfgLow ?? 1);
  const highCfg = single ? Number(cfg) : Number(cfgHigh ?? CFG.comfyui.cfgHigh ?? lowCfg);
  const ratio = Number(CFG.comfyui.cfgSplitRatio ?? 0.56);
  // denoise < 1 只对真正的 img2img（VAEEncode 出 latent 当起点）有意义。
  // **参考图路线（node4）的 latent 是空 latent**（参考图走 conditioning），必须从第 0 步全量去噪；
  // 给它 denoise 0.85 等于"拿纯噪声按第 4 步调度去噪"，画面会彻底崩坏（已实测三次复现）。
  let dn = denoise !== undefined && denoise !== null ? Number(denoise) : 1;
  const denoiseIgnored = isEdit && !isImg2Img && dn < 1;
  if (isEdit && !isImg2Img) dn = 1;
  const startStep = dn < 1 ? Math.min(Math.max(0, totalSteps - 1), Math.round(totalSteps * (1 - dn))) : 0;
  const split =
    cfgSplitStep !== undefined && cfgSplitStep !== null
      ? Math.floor(Number(cfgSplitStep))
      : Math.min(Math.max(startStep + 1, Math.round(totalSteps * ratio)), Math.max(startStep + 1, totalSteps - 1));

  const targetSeed = seed !== undefined && seed !== null ? Math.floor(Number(seed)) : Math.floor(Math.random() * 2 ** 31);
  const stage1 = graph[CFG.comfyui.seedNodeId];
  const stage2 = graph[CFG.comfyui.samplerNode2Id];
  // 改图且 denoise<1 = 经典 img2img：从参考 latent 的中点起跑，必须**单段跑完**。
  // 之前硬套两段式（第一段 end_at_step=split、第二段接着跑）会让噪声账目错位，画面直接崩坏。
  const singleStageEdit = isEdit && startStep > 0;
  const twoStage = !singleStageEdit && !!stage2 && stage2.class_type === "KSamplerAdvanced";
  let sampling;

  if (stage1?.class_type === "KSamplerAdvanced") {
    stage1.inputs.model = ["1", 0];
    stage1.inputs.noise_seed = targetSeed;
    stage1.inputs.steps = totalSteps;
    stage1.inputs.cfg = lowCfg;
    stage1.inputs.sampler_name = CFG.comfyui.samplerName;
    stage1.inputs.scheduler = CFG.comfyui.scheduler;
    stage1.inputs.add_noise = "enable";
    stage1.inputs.return_with_leftover_noise = "enable";
    stage1.inputs.start_at_step = startStep;
    stage1.inputs.end_at_step = split;
    stage1.inputs.latent_image = latentRef;
    if (singleStageEdit) {
      // 单段跑到底：不再留噪声、不再接第二段；解码节点直接读第一段的输出
      stage1.inputs.end_at_step = 10000;
      stage1.inputs.return_with_leftover_noise = "disable";
      delete graph[CFG.comfyui.samplerNode2Id];
      const decodeId = CFG.comfyui.decodeNodeId ?? "6";
      if (graph[decodeId]?.inputs) graph[decodeId].inputs.samples = [CFG.comfyui.seedNodeId, 0];
    } else if (twoStage) {
      stage2.inputs.model = ["1", 0];
      if (!stage2.inputs.positive) stage2.inputs.positive = [CFG.comfyui.promptNodeId, 0];
      if (!stage2.inputs.negative) stage2.inputs.negative = [CFG.comfyui.promptNodeId, 1];
      stage2.inputs.latent_image = [CFG.comfyui.seedNodeId, 0];
      stage2.inputs.noise_seed = targetSeed;
      stage2.inputs.steps = totalSteps;
      stage2.inputs.cfg = highCfg;
      stage2.inputs.sampler_name = CFG.comfyui.samplerName;
      stage2.inputs.scheduler = CFG.comfyui.scheduler;
      stage2.inputs.add_noise = "disable";
      stage2.inputs.return_with_leftover_noise = "disable";
      stage2.inputs.start_at_step = split;
      stage2.inputs.end_at_step = 10000;
    }
    sampling = {
      mode: isEdit ? "edit" : "t2i",
      steps: totalSteps,
      twoStage,
      singleStage: singleStageEdit || !twoStage,
      cfgLow: lowCfg,
      cfgHigh: twoStage ? highCfg : null,
      cfgSplitStep: twoStage ? split : null,
      startAtStep: startStep,
      denoise: dn,
      note: singleStageEdit
        ? `改图 img2img：从参考 latent 的第 ${startStep} 步起跑，单段跑完（denoise ${dn}）`
        : twoStage
          ? `前 ${split} 步 cfg ${lowCfg} 锁构图/材质，其余 cfg ${highCfg}（负面词在这段生效）`
          : `单段 cfg ${lowCfg}`,
    };
  } else if (stage1) {
    // 兼容旧的单 KSampler 工作流
    stage1.inputs.seed = targetSeed;
    stage1.inputs.steps = totalSteps;
    stage1.inputs.cfg = lowCfg;
    stage1.inputs.sampler_name = CFG.comfyui.samplerName;
    stage1.inputs.scheduler = CFG.comfyui.scheduler;
    stage1.inputs.denoise = dn;
    stage1.inputs.latent_image = latentRef;
    sampling = {
      mode: isEdit ? "edit" : "t2i",
      steps: totalSteps,
      twoStage: false,
      cfg: lowCfg,
      denoise: dn,
      note: `单段 KSampler cfg ${lowCfg}`,
    };
  }

  // ---- LoRA 链（动态插入在模型源与采样节点之间）---------------------------
  const loraApplied = applyLoras(graph, loras);
  if (loraApplied.applied.length && sampling) {
    sampling.loras = loraApplied.applied.map((l) => ({ name: l.name, strength: l.strength }));
  }
  // 少步蒸馏 LoRA（名字含 turbo）需要 ModelSamplingFlux 才算按训练调度跑；改图不适用
  const shift = maybeInsertFluxShift(graph, loraApplied.modelRef, {
    size,
    loras: loraApplied.applied,
    force: samplingShift,
    mode: isEdit ? (isImg2Img ? "img2img" : "edit") : "t2i",
  });
  if (sampling && shift.inserted) {
    sampling.modelSamplingFlux = { max_shift: 0.6935, base_shift: 0.5, width: size.width, height: size.height };
  }

  const saveNode = graph[CFG.comfyui.saveNodeId];
  if (saveNode && filenamePrefix) saveNode.inputs.filename_prefix = String(filenamePrefix);
  return { graph, seed: targetSeed, size, sampling, squareFallback: !sizeNode, isEdit, loras: loraApplied.applied };
}

/** 接受多种写法：字符串、{name, strength}、"name:0.8"。 */
function normalizeLoras(input) {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : [input];
  const out = [];
  for (const raw of arr) {
    if (!raw) continue;
    if (typeof raw === "string") {
      const m = /^(.*?):([0-9.+-]+)$/.exec(raw.trim());
      if (m && m[1].trim()) out.push({ name: m[1].trim(), strength: Number(m[2]) });
      else out.push({ name: raw.trim(), strength: 1.0 });
    } else if (typeof raw === "object") {
      const name = String(raw.name ?? raw.lora ?? raw.file ?? "").trim();
      if (!name) continue;
      const strength = raw.strength ?? raw.strength_model ?? raw.weight ?? 1.0;
      out.push({ name, strength: Number(strength) });
    }
  }
  return out.filter((l) => l.name);
}

/**
 * 把 LoRA 节点插进模型链：UnetLoader → lora1 → lora2 → … → 采样节点。
 * 只作用于模型侧（这些 Qwen-Image 2.1 LoRA 都是 DiT LoRA，没有文本编码器键）。
 */
function applyLoras(graph, lorasInput) {
  const list = normalizeLoras(lorasInput);
  let prev = [CFG.comfyui.modelSourceNodeId ?? "1", 0];
  if (!list.length) return { modelRef: prev, applied: [] };
  const applied = [];
  let i = 0;
  for (const l of list) {
    const id = `lora${++i}`;
    graph[id] = {
      class_type: CFG.comfyui.loraClass ?? "LoraLoaderModelOnly",
      inputs: { model: prev, lora_name: l.name, strength_model: l.strength },
    };
    prev = [id, 0];
    applied.push({ nodeId: id, name: l.name, strength: l.strength });
  }
  for (const nid of [CFG.comfyui.seedNodeId, CFG.comfyui.samplerNode2Id]) {
    if (graph[nid]?.inputs) graph[nid].inputs.model = prev;
  }
  return { modelRef: prev, applied };
}

/** ComfyUI 认得的所有 LoRA 文件名（带短 TTL，新拷进来的文件才能及时被看到）。 */
let _loraCache = null;
let _loraCacheAt = 0;
const LORA_CACHE_TTL_MS = 30000;
async function availableLoras(force = false) {
  if (_loraCache && !force && Date.now() - _loraCacheAt < LORA_CACHE_TTL_MS) return _loraCache;
  const cls = CFG.comfyui.loraClass ?? "LoraLoaderModelOnly";
  const res = await httpJson(`${CFG.comfyui.baseURL}/object_info/${cls}`, { timeoutMs: 15000 });
  const list = pickEnum(res.json?.[cls]?.input?.required?.lora_name);
  if (list) {
    _loraCache = list;
    _loraCacheAt = Date.now();
  }
  return _loraCache ?? [];
}

/**
 * Turbo8 / viggle-turbo 这类少步蒸馏 LoRA 需要配 ModelSamplingFlux
 * （作者规定 max_shift 0.6935、base_shift 0.5，且宽高要接上），否则非 1MP 尺寸下
 * 噪声调度与训练不一致。LoRA 名字里带 turbo 就自动插；可用 sampling_shift 显式覆盖。
 */
function maybeInsertFluxShift(graph, modelRef, { size, loras, force, mode }) {
  // 作者说明：ModelSamplingFlux 只用于文生图；改图/抠图在 ~1MP 用默认 shift 才是对的
  const auto = mode !== "edit" && mode !== "img2img" && (loras ?? []).some((l) => /turbo/i.test(l.name ?? ""));
  const enabled = force === undefined || force === null ? auto : !!force;
  if (!enabled) return { modelRef, inserted: false };
  graph["fluxshift"] = {
    class_type: "ModelSamplingFlux",
    inputs: {
      model: modelRef,
      max_shift: 0.6935,
      base_shift: 0.5,
      width: size.width,
      height: size.height,
    },
  };
  for (const nid of [CFG.comfyui.seedNodeId, CFG.comfyui.samplerNode2Id]) {
    if (graph[nid]?.inputs) graph[nid].inputs.model = ["fluxshift", 0];
  }
  return { modelRef: ["fluxshift", 0], inserted: true };
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return CFG.comfyui.defaultResolution;
  return Math.min(hi, Math.max(lo, n));
}

async function comfySubmit(graph) {
  const res = await httpJson(`${CFG.comfyui.baseURL}/prompt`, {
    method: "POST",
    body: { prompt: graph, client_id: CFG.comfyui.clientId },
    timeoutMs: CFG.comfyui.requestTimeoutMs,
  });
  if (res.networkError) {
    throw new Error(
      lifeMode() === "managed"
        ? `连不上 ComfyUI（${CFG.comfyui.baseURL}）：${res.text}。managed 模式下本应自动拉起，请用 comfyui_power start 手动重试并查看 comfyui-launch.log。`
        : `连不上 ComfyUI（${CFG.comfyui.baseURL}）：${res.text}。请先运行 ${lifeConf().cwd}\\run_nvidia_gpu.bat。`,
    );
  }
  const nodeErrors = res.json?.node_errors;
  if (!res.ok || (nodeErrors && Object.keys(nodeErrors).length)) {
    throw new Error(`ComfyUI 拒绝工作流（HTTP ${res.status}）：${shortText(res.json?.error?.message ?? nodeErrors ?? res.text, 500)}`);
  }
  const promptId = res.json?.prompt_id;
  if (!promptId) throw new Error(`ComfyUI 未返回 prompt_id：${shortText(res.text)}`);
  return promptId;
}

async function comfyWait(promptId, onTick) {
  const deadline = Date.now() + CFG.comfyui.generationTimeoutMs;
  let lastNote = "";
  while (Date.now() < deadline) {
    const res = await httpJson(`${CFG.comfyui.baseURL}/history/${promptId}`, {
      timeoutMs: CFG.comfyui.requestTimeoutMs,
    });
    if (res.networkError) throw new Error(`查询 ComfyUI 历史失败：${res.text}`);
    const entry = res.json?.[promptId];
    if (entry) {
      const statusStr = entry.status?.status_str;
      if (statusStr === "error") {
        const msgs = (entry.status?.messages ?? [])
          .filter((m) => Array.isArray(m) && m[0] === "execution_error")
          .map((m) => m[1]?.exception_message || m[1]?.node_type || "未知错误");
        throw new Error(`ComfyUI 执行失败：${shortText(msgs.join("; ") || "见 ComfyUI 控制台", 400)}`);
      }
      const images = collectImages(entry);
      if (images.length) return { entry, images };
      if (entry.status?.completed === true && !images.length) {
        throw new Error("ComfyUI 执行完成但没有图片输出，请检查 SaveImage 节点是否启用。");
      }
    }
    if (onTick) {
      const note = await onTick();
      if (note && note !== lastNote) {
        lastNote = note;
        logLine(`等待出图：${note}`);
      }
    }
    await sleep(CFG.comfyui.pollIntervalMs);
  }
  throw new Error(
    `等待出图超时（${Math.round(CFG.comfyui.generationTimeoutMs / 1000)}s）。任务 ${promptId} 可能仍在 ComfyUI 里跑——` +
      `本服务没有关它、也没有释放它的显存；成品会出现在 ComfyUI 的 output/ 目录。` +
      `画布越大越慢（8 GB 显存下 1088×1920 实测约 8.8 分钟），需要更久请调大 config.json 的 generationTimeoutMs。`,
  );
}

async function queueNote() {
  try {
    const res = await httpJson(`${CFG.comfyui.baseURL}/queue`, { timeoutMs: 10000 });
    const running = res.json?.queue_running?.length ?? 0;
    const pending = res.json?.queue_pending?.length ?? 0;
    return `运行中 ${running} / 排队 ${pending}`;
  } catch {
    return "";
  }
}

function collectImages(entry) {
  const out = [];
  for (const [nodeId, nodeOut] of Object.entries(entry.outputs || {})) {
    for (const img of nodeOut.images || []) {
      if (img?.filename) out.push({ nodeId, ...img });
    }
  }
  return out;
}

function viewUrl(img) {
  const q = new URLSearchParams({
    filename: img.filename,
    subfolder: img.subfolder || "",
    type: img.type || "output",
  });
  return `${CFG.comfyui.baseURL}/view?${q.toString()}`;
}

/**
 * 出图落盘：直接放到**对话工作区根目录**，文件名体现画面特征
 *   <模式>_<提示词模板或预设>_<预设档>_<宽x高>_s<种子>_<时间戳>.png
 * 例：t2i_lingerie_tease_r18q_832x1216_s88001_20261001-2231.png
 * 之后由 judge_image 按用户判断移进 output/ 或 bad_output/。
 */
async function saveImages(images, naming = {}, ws) {
  const saved = [];
  const dir = workspaceDirs(ws).root;
  fs.mkdirSync(dir, { recursive: true });
  for (const img of images) {
    const url = viewUrl(img);
    let local = null;
    if (CFG.downloadImages) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(CFG.comfyui.requestTimeoutMs) });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          const ext = path.extname(img.filename) || ".png";
          const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/(\d{8})(\d{4})/, "$1-$2");
          const parts = [
            naming.mode ?? "t2i",
            slugify(naming.tag, 24) || slugify(naming.presetKey, 14) || "img",
            presetTag(naming.presetKey),
            naming.size ?? null,
            naming.seed !== undefined && naming.seed !== null ? `s${naming.seed}` : null,
            stamp,
          ].filter(Boolean);
          local = uniquePath(dir, parts.join("_"), ext);
          fs.writeFileSync(local, buf);
          logLine(`出图已落到工作区：${local}`);
        } else {
          logLine(`取图失败 ${url} → HTTP ${res.status}`);
        }
      } catch (err) {
        logLine(`取图失败 ${url} → ${err?.message || err}`);
      }
    }
    saved.push({ filename: img.filename, subfolder: img.subfolder || "", url, localPath: local, pendingDecision: !!local });
  }
  return saved;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// ComfyUI 生命周期（方案二：拆负载，不常驻）
//   managed  —— 按需拉起、出图后释放显存、闲置关进程；它是本服务的子进程，
//               所以 DSH 重启时它必然已经不在，启动争用从根上消失。
//   external —— 由用户自己启动管理（旧行为）。
// ---------------------------------------------------------------------------

const LIFE = {
  process: null,
  owned: false,
  logFd: null,
  idleTimer: null,
  busy: false,
  lastUsedAt: 0,
  startedAt: null,
  // 用 comfyui_power start 手动拉起时为 true：这一次不自动关，留给你在界面里用
  manualHold: false,
};

function lifeConf() {
  return CFG.comfyui.lifecycle ?? {};
}

function lifeMode() {
  return String(lifeConf().mode ?? "managed").toLowerCase() === "external" ? "external" : "managed";
}

/** 探测 ComfyUI 是否在线；在线则返回 system_stats。 */
async function comfyProbe(timeoutMs = 6000) {
  const res = await httpJson(`${CFG.comfyui.baseURL}/system_stats`, { timeoutMs });
  return res.ok ? res.json : null;
}

/** 按需拉起 ComfyUI 并等到 /system_stats 可应答。 */
async function comfyStart({ waitMs } = {}) {
  const life = lifeConf();
  if (await comfyProbe(4000)) {
    if (!LIFE.owned) logLine("ComfyUI 已在线（非本服务启动，视为外部实例）");
    return { online: true, started: false, owned: LIFE.owned };
  }
  if (lifeMode() === "external") {
    throw new Error(
      `ComfyUI 未启动（lifecycle.mode=external）。请自行运行 ${life.cwd}\\run_nvidia_gpu.bat。`,
    );
  }
  const timeoutMs = waitMs ?? life.startTimeoutMs ?? 300000;
  const logPath = resolvePath(life.launchLogFile ?? "./comfyui-launch.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  LIFE.logFd = fs.openSync(logPath, "a");
  fs.writeSync(LIFE.logFd, `\n=== ${new Date().toISOString()} 按需启动 ComfyUI ===\n`);
  logLine(`按需启动 ComfyUI：${life.command} ${(life.args ?? []).join(" ")}（cwd=${life.cwd}）`);

  const child = spawn(life.command, life.args ?? [], {
    cwd: life.cwd,
    windowsHide: true,
    // 用文件句柄而不是管道：受限环境禁止管道 stdio（spawn EPERM），这里也不需要读输出
    stdio: ["ignore", LIFE.logFd, LIFE.logFd],
  });
  LIFE.process = child;
  LIFE.owned = true;
  LIFE.startedAt = new Date().toISOString();
  writeState({ pid: child.pid, owned: true, startedAt: LIFE.startedAt });
  child.once("exit", (code, signal) => {
    logLine(`ComfyUI 进程退出（code=${code} signal=${signal}）`);
    if (LIFE.process === child) {
      LIFE.process = null;
      LIFE.owned = false;
    }
  });
  child.once("error", (err) => logLine(`ComfyUI 启动失败：${err?.message || err}`));

  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1500);
    if (await comfyProbe(4000)) {
      const listenerPid = await portListenerPid();
      writeState({ pid: child.pid, listenerPid, owned: true, startedAt: LIFE.startedAt });
      logLine(`ComfyUI 就绪，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s（包装 pid=${child.pid}，监听 pid=${listenerPid ?? "?"}）`);
      return { online: true, started: true, owned: true, waitMs: Date.now() - t0, pid: child.pid, listenerPid };
    }
    if (LIFE.process === null) throw new Error("ComfyUI 进程启动后立即退出，详见 comfyui-launch.log");
  }
  throw new Error(`等待 ComfyUI 就绪超时（${Math.round(timeoutMs / 1000)}s），详见 comfyui-launch.log`);
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (process.platform === "win32") {
      const p = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      p.once("exit", () => resolve());
      p.once("error", () => resolve());
    } else {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
      resolve();
    }
  });
}

/**
 * 关掉 ComfyUI。
 *   onlyOwned=true（自动路径）：只关本服务自己拉起的实例。用户手动开的实例一律不碰。
 *   onlyOwned=false（comfyui_power stop 这种显式动作）：外部实例也按端口收掉。
 */
async function comfyStop({ reason, onlyOwned = false } = {}) {
  if (LIFE.idleTimer) {
    clearTimeout(LIFE.idleTimer);
    LIFE.idleTimer = null;
  }
  if (onlyOwned && !LIFE.owned) {
    logLine(`跳过关闭（${reason ?? "自动"}）：这不是本服务拉起的实例，交给你自己管`);
    return { stopped: false, skipped: true, note: "该 ComfyUI 是你自己启动的实例，自动路径不会碰它。" };
  }
  const pid = LIFE.process?.pid;
  const st = readState();
  let killed = null;
  if (LIFE.owned && pid) {
    await killTree(pid);
    killed = pid;
  } else if (LIFE.owned && st.listenerPid) {
    await killTree(st.listenerPid);
    killed = st.listenerPid;
  }
  await sleep(900);

  // 补刀：包装进程可能已经死了，但真正的服务进程（python）还在监听端口
  if (await comfyProbe(3000)) {
    const listener = await portListenerPid();
    if (listener && listener !== killed) {
      await killTree(listener);
      killed = killed ?? listener;
      logLine(`按端口补刀：结束 pid=${listener}`);
    }
  }

  LIFE.process = null;
  LIFE.owned = false;
  writeState({ pid: null, listenerPid: null, owned: false });

  if (killed) {
    logLine(`已关闭 ComfyUI（${reason ?? "手动"}，pid=${killed}）`);
    return { stopped: true, pid: killed };
  }
  return { stopped: false, note: "ComfyUI 本来就没在运行。" };
}

/**
 * 出图收尾：先释放显存，再关进程。
 * 关之前必须先确认 ComfyUI 队列是空的——你完全可能在它的网页界面里点了生成，
 * 那部分任务 MCP 侧看不见，直接 taskkill 就会"图没生完就被关"。
 */
async function closeAfterGeneration() {
  const life = lifeConf();
  if (life.shutdownAfterGeneration === false) {
    return { closed: false, reason: "shutdownAfterGeneration=false，保留进程" };
  }
  if (!LIFE.owned) {
    return { closed: false, reason: "实例不是本服务拉起的，按约定不动它" };
  }
  if (LIFE.manualHold) {
    LIFE.manualHold = false;
    logLine("你刚手动拉起过 ComfyUI，这次不自动关；下次出图完成后照常关");
    return { closed: false, reason: "你刚用 comfyui_power start 手动拉起，本次保留；下次出图完成后再关" };
  }
  const note = await queueNote();
  const queue = await httpJson(`${CFG.comfyui.baseURL}/queue`, { timeoutMs: 10000 });
  const running = queue.json?.queue_running?.length ?? 0;
  const pending = queue.json?.queue_pending?.length ?? 0;
  if (running > 0 || pending > 0) {
    logLine(`出图完成但队列非空（${note || `${running}/${pending}`}），先不关 ComfyUI`);
    return { closed: false, reason: `队列非空（运行 ${running} / 排队 ${pending}），保留进程`, queue: { running, pending } };
  }
  const r = await comfyStop({ reason: "出图完成", onlyOwned: true });
  return { closed: r.stopped === true, pid: r.pid ?? null, reason: "出图完成即关闭以释放显存" };
}

/** 让 ComfyUI 把模型与缓存从显存里放掉（毫秒级，比关进程便宜得多）。 */
async function comfyFreeVram() {
  const res = await httpJson(`${CFG.comfyui.baseURL}/free`, {
    method: "POST",
    body: { unload_models: true, free_memory: true },
    timeoutMs: 30000,
  });
  if (res.ok) logLine("已释放 ComfyUI 显存（unload_models + free_memory）");
  else logLine(`释放显存失败（不致命）：${res.networkError ? res.text : `HTTP ${res.status}`}`);
  return res.ok;
}

/** 每次出图前后都走这里：确保在线、重置闲置计时。 */
async function ensureComfy() {
  LIFE.lastUsedAt = Date.now();
  if (LIFE.idleTimer) {
    clearTimeout(LIFE.idleTimer);
    LIFE.idleTimer = null;
  }
  // 先收掉上次强杀留下的孤儿，避免"接手"一个不该存在的实例
  await reapStaleComfy();
  const stats = await comfyProbe(5000);
  if (stats) return { online: true, started: false, owned: LIFE.owned };
  if (lifeMode() !== "managed") {
    throw new Error(
      `连不上 ComfyUI（${CFG.comfyui.baseURL}）。lifecycle.mode=external，请先运行 ${lifeConf().cwd}\\run_nvidia_gpu.bat。`,
    );
  }
  return comfyStart();
}

/** 出图结束后安排"闲置即关"。 */
function scheduleIdleShutdown() {
  const life = lifeConf();
  const idleMs = Number(life.shutdownIdleMs ?? 0);
  if (LIFE.idleTimer) clearTimeout(LIFE.idleTimer);
  if (!(idleMs > 0) || lifeMode() !== "managed") return;
  LIFE.idleTimer = setTimeout(async () => {
    LIFE.idleTimer = null;
    if (LIFE.busy) return scheduleIdleShutdown();
    if (Date.now() - LIFE.lastUsedAt < idleMs - 1000) return scheduleIdleShutdown();
    if (!LIFE.owned) return;
    await comfyStop({ reason: `闲置 ${Math.round(idleMs / 60000)} 分钟` });
  }, idleMs);
  LIFE.idleTimer.unref?.();
}

/** 本服务退出时必须带走自己拉起的 ComfyUI，避免留下孤儿 python。 */
function shutdownOwnedComfy() {
  const st = readState();
  const pids = new Set();
  if (LIFE.owned && LIFE.process?.pid) pids.add(LIFE.process.pid);
  if (LIFE.owned && st.listenerPid) pids.add(st.listenerPid);
  if (LIFE.owned) {
    const listener = portListenerPidSync();
    if (listener) pids.add(listener);
  }
  for (const pid of pids) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } else {
        process.kill(pid, "SIGKILL");
      }
      logLine(`服务退出，已带走自启的 ComfyUI（pid=${pid}）`);
    } catch {}
  }
  if (pids.size) writeState({ pid: null, listenerPid: null, owned: false });
  LIFE.process = null;
  LIFE.owned = false;
}

// ---- 遗留进程自愈 ----------------------------------------------------------
// DSH 被强杀（任务管理器/崩溃）时 Node 收不到 exit，"服务退出带走 ComfyUI"就失效了，
// 会留下一个孤儿 ComfyUI —— 那正好会让下一次 DSH 启动重新撞上磁盘/CPU/显存争用。
// 所以把子进程 pid 记在状态文件里，新实例启动时先把上次的遗留收掉。

function statePath() {
  return resolvePath(lifeConf().stateFile ?? "./comfyui-mcp.state.json");
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch {
    return {};
  }
}

function writeState(patch) {
  try {
    fs.writeFileSync(statePath(), `${JSON.stringify({ ...readState(), ...patch }, null, 2)}\n`);
  } catch (err) {
    logLine(`状态文件写入失败（不致命）：${err?.message || err}`);
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM"; // 存在但无权限 → 视为存活
  }
}

function comfyPort() {
  try {
    return new URL(CFG.comfyui.baseURL).port || (CFG.comfyui.baseURL.startsWith("https") ? "443" : "80");
  } catch {
    return "8188";
  }
}

function parseNetstatForPort(text, port) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
    if (m && Number(m[1]) === Number(port)) return Number(m[2]);
  }
  return null;
}

/**
 * 谁在监听这个端口。
 * 为什么不靠"记录下来的子进程 pid"：Node 起的是 `cmd.exe /c run_nvidia_game.bat`，
 * 真正的服务是它的子进程 python。宿主被强杀时 cmd 会随 stdin EOF 走掉，python 却会留下——
 * 只看记录的 pid 会得出"已经没了"的错误结论。端口占用者才是唯一可靠的事实。
 * 输出写文件而不是走管道：受限环境禁止管道 stdio（spawn EPERM）。
 */
async function portListenerPid(port = comfyPort()) {
  const outFile = path.join(os.tmpdir(), `comfyui-netstat-${process.pid}-${Date.now()}.txt`);
  let fd;
  try {
    fd = fs.openSync(outFile, "w");
    await new Promise((resolve) => {
      const p = spawn("netstat.exe", ["-ano"], { stdio: ["ignore", fd, fd], windowsHide: true });
      p.once("exit", resolve);
      p.once("error", resolve);
    });
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  let pid = null;
  try {
    pid = parseNetstatForPort(fs.readFileSync(outFile, "utf8"), port);
  } catch {}
  try {
    fs.unlinkSync(outFile);
  } catch {}
  return pid;
}

function portListenerPidSync(port = comfyPort()) {
  const outFile = path.join(os.tmpdir(), `comfyui-netstat-sync-${process.pid}-${Date.now()}.txt`);
  try {
    const fd = fs.openSync(outFile, "w");
    spawnSync("netstat.exe", ["-ano"], { stdio: ["ignore", fd, fd], windowsHide: true });
    fs.closeSync(fd);
    const pid = parseNetstatForPort(fs.readFileSync(outFile, "utf8"), port);
    fs.unlinkSync(outFile);
    return pid;
  } catch {
    return null;
  }
}

/** 启动时收掉上一次运行遗留的、由本服务拉起的 ComfyUI。 */
async function reapStaleComfy() {
  const st = readState();
  if (!st.owned) return null;
  const online = await comfyProbe(3000);
  if (!online) {
    writeState({ pid: null, listenerPid: null, owned: false });
    return null;
  }
  const pid = (pidAlive(st.listenerPid) && st.listenerPid) || (pidAlive(st.pid) && st.pid) || (await portListenerPid());
  if (!pid) {
    logLine("状态文件说启动过 ComfyUI，但既找不到存活进程也找不到端口占用者，清空记录");
    writeState({ pid: null, listenerPid: null, owned: false });
    return null;
  }
  logLine(`发现上次遗留的 ComfyUI（pid=${pid}，启动于 ${st.startedAt ?? "?"}），先结束它`);
  await killTree(pid);
  writeState({ pid: null, listenerPid: null, owned: false });
  await sleep(1200);
  return pid;
}

function lifecycleView() {
  const life = lifeConf();
  return {
    mode: lifeMode(),
    owned: LIFE.owned,
    comfyPid: LIFE.process?.pid ?? null,
    startedAt: LIFE.startedAt,
    busy: LIFE.busy,
    shutdownIdleMs: Number(life.shutdownIdleMs ?? 0),
    shutdownAfterGeneration: life.shutdownAfterGeneration !== false,
    nextShutdownInMs: LIFE.idleTimer ? Math.max(0, Number(life.shutdownIdleMs ?? 0) - (Date.now() - LIFE.lastUsedAt)) : null,
    freeVramAfterGeneration: life.freeVramAfterGeneration !== false,
    startCommand: lifeMode() === "managed" ? `${life.command} ${(life.args ?? []).join(" ")}` : null,
  };
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "service_status",
    description:
      "自检：Ollama 是否在线、ComfyUI 是否在线/是否由本服务按需拉起、显存与工作流模型文件是否齐备。出图前或报错后先跑这个。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "run_workflow",
    description:
      "按注册好的工作流预设直接出图/出视频（覆盖 Qwen 生图、Qwen 改图、MiniMax H3 生视频、H3 参考图生视频）。先用 service_status 看 workflows 列表。只覆盖你显式给的参数，其余沿用预设里的固定提示词脚手架与尺寸/时长。图片几十秒、H3 视频数分钟，别重复调。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "工作流预设名或别名：qwen_t2i / qwen_edit / h3_t2v / h3_ref2v" },
        workspace: {
          type: "string",
          description: "可选：当前对话的工作区根目录（绝对路径）。传了就把产物落到那里并归档到其下 output/ / bad_output/",
        },
        prompt: { type: "string", description: "提示词；省略则用预设自带的固定提示词" },
        negative: { type: "string", description: "负面提示词（仅图像预设有效）" },
        width: { type: "integer" }, height: { type: "integer" },
        resolution: { type: "integer", description: "（仅图像预设）正方形边长或配合 aspect 当长边" },
        aspect: { type: "string", description: "（仅图像预设）如 16:9 / 9:16 / 3:4" },
        length: { type: "integer", description: "（仅视频预设）帧数 @24fps，124 约 5.17s" },
        steps: { type: "integer" }, seed: { type: "integer" },
        filename_prefix: { type: "string" },
        denoise: { type: "number", description: "（仅改图）改动强度，0.85 左右保留主体" },
        source_image: { type: "string", description: "参考图/待改图的本机路径（qwen_edit 与 h3_ref2v 必需）" },
        prompt_preset: {
          type: "string",
          description:
            "提示词库里的现成使用提示词（见 service_status 的 promptLibrary）。改图模板：edit_undress / edit_lingerie / edit_pose / edit_bg / edit_light / edit_detail；生图模板：solo_portrait / full_body_standing / window_light_nude / explicit_closeup / lingerie_tease / duo_scene",
        },
        loras: { type: "array", description: "覆盖预设的 LoRA 链；元素 {name, strength}", items: { type: "object", properties: { name: { type: "string" }, strength: { type: "number" } }, required: ["name"] } },
        preset: { type: "string", description: "（仅图像预设）沿用图像流水线的配方名，如 r18_quality" },
        scene: { type: "string", description: "场景描述（与 prompt 等价；直接用这个也行，会自动据它挑 LoRA）" },
        auto_loras: { type: "boolean", description: "视频预设默认 true：按场景自动挑 LoRA（可在 dry_run 里看到清单）。传 false 则只用预设自带的那套" },
        dry_run: { type: "boolean", description: "true = 只返回计划（提示词/LoRA 清单与作用/参数），不提交 ComfyUI。给用户过目用；确认后去掉本参数再调一次" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "judge_image",
    description:
      "用户看过图并给出判断后调用：verdict=keep 把图移进该工作区的 output/，verdict=discard 移进 bad_output/。**工作区以文件自身位置为准**：图在哪个工作区根目录，就归档到那个工作区；传 workspace 可覆盖。path 可只给文件名（会在所有已知对话工作区里找）。每张图生成后都要先预览并问用户，得到答复再调本工具。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "待归档的图片/视频路径或文件名（刚生成的那张）" },
        workspace: {
          type: "string",
          description:
            "可选：当前对话的工作区根目录（绝对路径）。**一般不用传**：judge_image 会按图片所在位置自动判定工作区；只有图片不在任何已知工作区里时才需要显式指定",
        },
        paths: { type: "array", items: { type: "string" }, description: "可选：一次归档多张" },
        verdict: { type: "string", enum: ["keep", "discard"], description: "keep=可留存（→ output/）；discard=不留存（→ bad_output/）" },
        note: { type: "string", description: "可选：用户给出的原因，仅记录" },
      },
      required: ["verdict"],
      additionalProperties: false,
    },
  },
  {
    name: "comfyui_power",
    description:
      "控制 ComfyUI 进程：status 看状态与显存；start 拉起；stop 关闭（用完就关，别让它常驻占显存/磁盘，否则会拖慢 DSH 启动）；free_vram 只清显存不关进程。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "start", "stop", "free_vram"], description: "默认 status" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "generate_prompts",
    description:
      "把一句中文画面描述交给本地 Ollama 模型，返回生图用的正面与负面提示词 {positive, negative}。只生成文字，不触发出图。",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "对画面的一句话或一段中文描述" },
        style: { type: "string", description: "可选，固定画面风格，例如 电影感写实 / 国风插画 / 赛博朋克" },
        language: { type: "string", enum: ["zh", "en", "auto"], description: "正面提示词语言，默认 zh" },
        extra_negative: { type: "string", description: "可选，追加到负面提示词的额外内容" },
      },
      required: ["description"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_image",
    description:
      "把提示词送 ComfyUI 出图。**仅当提示词由用户直接给出时使用**；若提示词来自本地模型，必须先走 prepare_image → 用户过目 → approve_and_generate，不要用本工具绕过去。耗时通常几十秒到几分钟，别重复调。",
    inputSchema: {
      type: "object",
      properties: {
        positive: { type: "string", description: "正面提示词（用户提供）" },
        workspace: {
          type: "string",
          description:
            "可选：当前对话的工作区根目录（绝对路径）。传了就把图落到那里，并在其下归档 output/ 与 bad_output/；不传则用 config.json 的默认目录",
        },
        negative: { type: "string", description: "负面提示词；省略时使用工作流内置的中文负面词" },
        width: { type: "integer", description: "画布宽（像素，256~4096，就近对齐到 32）；与 height 配对使用，优先于 aspect/resolution" },
        height: { type: "integer", description: "画布高（像素，256~4096，就近对齐到 32）" },
        aspect: { type: "string", description: "画面比例，如 16:9 / 9:16 / 3:2 / 21:9 / 1:1；此时 resolution 当作长边（省略则用 1024）" },
        resolution: { type: "integer", description: "正方形边长，或配合 aspect 当长边用" },
        seed: { type: "integer", description: "随机种子；省略则每次随机" },
        steps: { type: "integer", description: "采样步数，默认 25（Qwen-Image-2.1 全量模型，更多步只会烧高光）" },
        cfg: { type: "number", description: "只给一个 CFG 值（两段同值，等于一发到底）；不传则走两段式 1.0 → 3.0" },
        cfg_low: { type: "number", description: "两段式前段的 CFG，默认 1.0（锁构图/材质，负面词此段不生效）" },
        cfg_high: { type: "number", description: "两段式后段的 CFG，默认 3.0（配负面词重写文字/细节）；设成与 cfg_low 相同即关闭第二段" },
        cfg_split_step: { type: "integer", description: "两段的分界步，默认 round(步数 × 0.56)（25 步→14，作者建议 12~17）" },
        filename_prefix: { type: "string", description: "文件名前缀，默认沿用工作流的 QwenImage21" },
        loras: {
          type: "array",
          description: "要叠加的 LoRA 列表（可多条，按顺序链式作用）。元素为 {name: 文件名, strength: 强度}；先调 service_status 看 available 列表",
          items: {
            type: "object",
            properties: { name: { type: "string" }, strength: { type: "number", description: "默认 1.0；0.6~0.8 更弱" } },
            required: ["name"],
          },
        },
        sampling_shift: {
          type: "boolean",
          description: "少步蒸馏 LoRA（turbo8/viggle-turbo）需要的 ModelSamplingFlux。名字含 turbo 时默认自动插入；传 false 关掉、true 强制开",
        },
        preset: {
          type: "string",
          description:
            "预设配方名（先用 service_status 看 presets）。会填补你没显式给的步数/LoRA/尺寸，并把触发词与兜底短语贴到提示词上。推荐 r18_quality / r18_fast / r18_fast_plus",
        },
        prompt_preset: {
          type: "string",
          description:
            "提示词库里的现成使用提示词（见 service_status 的 promptLibrary）：如 solo_portrait / full_body_standing / explicit_closeup / lingerie_tease / duo_scene。给了它就可以不写 positive，且会带上对应的 preset",
        },
        apply_prompt_scaffold: { type: "boolean", description: "是否让预设自动贴触发词与兜底短语，默认 true；传 false 则原样使用你给的提示词" },
      },
      required: ["positive"],
      additionalProperties: false,
    },
  },
  {
    name: "prepare_image",
    description:
      "文生图第一步（人工过目用）：把中文描述交给本地 7B 生成正面/负面提示词，存成草稿并返回 draft_id。**本工具绝不出图**。拿到结果后必须把 positive / negative 原样贴给用户看，等用户明确同意再调 approve_and_generate。",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "对画面的一句话或一段中文描述" },
        workspace: {
          type: "string",
          description: "可选：当前对话的工作区根目录（绝对路径），随草稿记住，出图时按它归档",
        },
        style: { type: "string", description: "可选，固定画面风格" },
        language: { type: "string", enum: ["zh", "en", "auto"], description: "正面提示词语言，默认 zh" },
        extra_negative: { type: "string", description: "可选，追加到负面提示词的额外内容" },
        width: { type: "integer", description: "画布宽（像素，256~4096，就近对齐到 32）；与 height 配对，优先于 aspect/resolution" },
        height: { type: "integer", description: "画布高（像素，256~4096，就近对齐到 32）" },
        aspect: { type: "string", description: "画面比例，如 16:9 / 9:16 / 3:2 / 21:9 / 1:1；此时 resolution 当长边" },
        resolution: { type: "integer", description: "正方形边长，或配合 aspect 当长边用（默认 1024）" },
        preset: {
          type: "string",
          description: "可选：预设配方名（见 service_status 的 presets）。会把触发词贴进提示词、并让步数/LoRA/尺寸跟随预设",
        },
        prompt_preset: {
          type: "string",
          description: "可选：提示词库里的现成模板（见 service_status 的 promptLibrary）。给了它就可以不写 description",
        },
        loras: {
          type: "array",
          description: "可选：出图时要叠加的 LoRA（尺寸与 LoRA 会一起写进草稿，随提示词一起过目）",
          items: {
            type: "object",
            properties: { name: { type: "string" }, strength: { type: "number" } },
            required: ["name"],
          },
        },
      },
      required: ["description"],
      additionalProperties: false,
    },
  },
  {
    name: "prepare_edit",
    description:
      "改图第一步（人工过目用）：给一张参考图 + 一句修改要求，本地 7B 把它写成精确的编辑指令并存成草稿。**绝不出图**。用户发图说“把背景换成……/给她换件衣服”时用这个；拿到结果先把 instruction/positive/negative 贴给用户过目。",
    inputSchema: {
      type: "object",
      properties: {
        source_image: { type: "string", description: "参考图路径（用户发来的图片文件，DSH 附件路径即可）" },
        workspace: {
          type: "string",
          description: "可选：当前对话的工作区根目录（绝对路径）；参考图会存档到 <workspace>/referring/，出图也归档到那里",
        },
        preset: {
          type: "string",
          description:
            "可选：配方预设（见 service_status 的 presets），如 r18_quality / r18_fast。会带上 LoRA 组合、步数（editSteps）与 denoise（editDenoise=0.85），并自动补触发词与保留后缀",
        },
        instruction: { type: "string", description: "你想怎么改，例如“把背景换成白天的城市街道，人物保持不变”" },
        style: { type: "string", description: "可选，固定风格" },
        language: { type: "string", enum: ["zh", "en", "auto"], description: "编辑指令语言，默认 zh" },
        extra_negative: { type: "string", description: "可选，追加的负面词" },
        resolution: { type: "integer", description: "参考图缩放到的框（约 resolution²，画布比例跟随参考图），默认 1024" },
        denoise: { type: "number", description: "改动强度：1.0=完全按指令重构（默认）；0.6~0.8 更贴近原图" },
        aspect: { type: "string", description: "可选，仅用于推算缩放框" },
      },
      required: ["source_image", "instruction"],
      additionalProperties: false,
    },
  },
  {
    name: "approve_and_generate",
    description:
      "出图第二步：用户过目并明确同意后，用 draft_id 正式出图（文生图或改图，由草稿类型决定）。approved 必须为 true；用户要求改词就同时传修改后的 positive/negative；用户放弃就传 false（草稿作废，不出图）。草稿一次性使用，过期需重新 prepare_image / prepare_edit。",
    inputSchema: {
      type: "object",
      properties: {
        draft_id: { type: "string", description: "prepare_image 或 prepare_edit 返回的 draft_id" },
        workspace: { type: "string", description: "可选：覆盖草稿记住的工作区（一般不用传）" },
        approved: { type: "boolean", description: "用户是否明确同意这组提示词；没得到明确同意就必须是 false" },
        positive: { type: "string", description: "可选：用户要求修改后的正面提示词/编辑指令，覆盖草稿" },
        negative: { type: "string", description: "可选：用户要求修改后的负面提示词，覆盖草稿" },
        width: { type: "integer", description: "可选（仅文生图）：覆盖草稿里的画布宽（256~4096，对齐 32）" },
        height: { type: "integer", description: "可选（仅文生图）：覆盖草稿里的画布高" },
        aspect: { type: "string", description: "可选（仅文生图）：覆盖草稿比例，如 16:9；需与 resolution 搭配当长边" },
        resolution: { type: "integer", description: "可选：文生图=正方形边长/长边；改图=参考图缩放框（默认沿用草稿）" },
        denoise: { type: "number", description: "可选（仅改图）：改动强度，1.0 完全重构，0.6~0.8 更贴近原图" },
        seed: { type: "integer", description: "随机种子" },
        steps: { type: "integer", description: "采样步数，默认 25" },
        cfg: { type: "number", description: "只给一个 CFG 值（两段同值）" },
        cfg_low: { type: "number", description: "两段式前段 CFG，默认 1.0" },
        cfg_high: { type: "number", description: "两段式后段 CFG，默认 3.0" },
        cfg_split_step: { type: "integer", description: "两段分界步，默认 round(步数 × 0.56)" },
        filename_prefix: { type: "string", description: "文件名前缀" },
        preset: { type: "string", description: "可选：覆盖草稿的预设（不传则沿用草稿里过目过的那个）" },
        loras: {
          type: "array",
          description: "可选：覆盖草稿里的 LoRA 列表（不传就用草稿里过目过的那套）",
          items: {
            type: "object",
            properties: { name: { type: "string" }, strength: { type: "number" } },
            required: ["name"],
          },
        },
      },
      required: ["draft_id", "approved"],
      additionalProperties: false,
    },
  },
];

async function toolServiceStatus() {
  const report = {
    ollama: { baseURL: CFG.ollama.baseURL, model: CFG.ollama.model, online: false, models: [], modelPresent: false },
    comfyui: {
      baseURL: CFG.comfyui.baseURL,
      online: false,
      workflowFile: CFG.comfyui.apiWorkflowFile,
      workflowReady: false,
      loadedModels: null,
      vram: null,
    },
    inboxDir: CFG.inboxDir,
  };

  const tags = await httpJson(`${CFG.ollama.baseURL}/api/tags`, { timeoutMs: 8000 });
  if (tags.ok && tags.json?.models) {
    report.ollama.online = true;
    report.ollama.models = tags.json.models.map((m) => m.name);
    report.ollama.modelPresent = report.ollama.models.includes(CFG.ollama.model);
  } else {
    report.ollama.error = tags.networkError ? tags.text : `HTTP ${tags.status}`;
  }

  // /api/ps 报当前驻留显存的模型 —— 判断"此刻是谁占着显存"的关键信息。
  const ps = await httpJson(`${CFG.ollama.baseURL}/api/ps`, { timeoutMs: 8000 });
  if (ps.ok) {
    report.ollama.loaded = (ps.json?.models ?? []).map((m) => ({
      name: m.name,
      sizeGiB: m.size ? Number((m.size / 1073741824).toFixed(2)) : null,
      processor: m.size_vram ? (m.size_vram >= m.size * 0.99 ? "100% GPU" : "部分 GPU") : "100% CPU",
      expiresAt: m.expires_at ?? null,
    }));
    report.ollama.unloadAfterPrompt = CFG.ollama.unloadAfterPrompt;
    report.ollama.device = String(CFG.ollama.device ?? "cpu").toLowerCase();
    report.ollama.engine =
      report.ollama.device === "gpu"
        ? "gpu（OpenAI 兼容端点，会与 ComfyUI 抢显存）"
        : "cpu（原生 /api/chat + num_gpu=0，不占显存）";
  }

  report.comfyui.workflowReady = fs.existsSync(CFG.comfyui.apiWorkflowFile);

  const stats = await httpJson(`${CFG.comfyui.baseURL}/system_stats`, { timeoutMs: 8000 });
  if (stats.ok) {
    report.comfyui.online = true;
    const dev = stats.json?.devices?.[0];
    if (dev) {
      report.comfyui.vram = {
        totalMiB: Math.round((dev.vram_total ?? 0) / 1048576),
        freeMiB: Math.round((dev.vram_free ?? 0) / 1048576),
        name: dev.name,
      };
    }
    const diT = await httpJson(`${CFG.comfyui.baseURL}/object_info/UnetLoaderGGUF`, { timeoutMs: 10000 });
    // 文本编码器既可能是 GGUF 也可能是 safetensors，两种加载器都查一遍
    const clipGguf = await httpJson(`${CFG.comfyui.baseURL}/object_info/CLIPLoaderGGUF`, { timeoutMs: 10000 });
    const clipSafe = await httpJson(`${CFG.comfyui.baseURL}/object_info/CLIPLoader`, { timeoutMs: 10000 });
    const unetList = pickEnum(diT.json?.UnetLoaderGGUF?.input?.required?.unet_name);
    const clipList =
      pickEnum(clipGguf.json?.CLIPLoaderGGUF?.input?.required?.clip_name) ??
      pickEnum(clipSafe.json?.CLIPLoader?.input?.required?.clip_name);
    // 工作流实际用的是哪个加载器 + 哪个文件，直接从工作流里读，避免报告与实际不一致
    const wf = apiTemplate();
    const clipNode = wf?.[CFG.comfyui.clipNodeId] ?? null;
    report.comfyui.loadedModels = {
      unet: unetList,
      clip: clipList,
      inUse: clipNode
        ? { loader: clipNode.class_type, clip: clipNode.inputs?.clip_name ?? null, type: clipNode.inputs?.type ?? null }
        : null,
    };
  } else {
    report.comfyui.error = stats.networkError ? stats.text : `HTTP ${stats.status}`;
  }

  report.comfyui.lifecycle = lifecycleView();
  pruneDrafts();
  report.approvalGate = {
    required: true,
    pendingDrafts: DRAFTS.size,
    draftTtlMs: draftTtlMs(),
    flow: "prepare_image → 用户过目 → approve_and_generate(approved=true)",
  };
  report.size = {
    latentNodeId: CFG.comfyui.latentNodeId,
    align: CFG.comfyui.sizeAlign,
    min: CFG.comfyui.sizeMin,
    max: CFG.comfyui.sizeMax,
    input: "width/height 直接给；aspect +（resolution=长边）；只给 resolution 则为正方形",
  };
  const stage1 = apiTemplate()?.[CFG.comfyui.seedNodeId];
  report.sampling = {
    steps: CFG.comfyui.defaultSteps,
    twoStage: !!apiTemplate()?.[CFG.comfyui.samplerNode2Id],
    cfgLow: CFG.comfyui.cfgLow,
    cfgHigh: CFG.comfyui.cfgHigh,
    cfgSplitRatio: CFG.comfyui.cfgSplitRatio,
    graphSampler: stage1?.class_type ?? null,
  };
  report.edit = {
    supported: true,
    flow: "prepare_edit(source_image, instruction) → 用户过目 → approve_and_generate(draft_id, approved=true)",
    defaultDenoise: CFG.comfyui.editDenoise,
    inputDir: CFG.comfyui.inputDir,
  };
  if (report.comfyui.online) {
    const loras = await availableLoras();
    report.loras = {
      available: loras,
      count: loras.length,
      dir: CFG.comfyui.loraDir,
      usage: 'generate_image / prepare_image / approve_and_generate 传 loras: ["名字"] 或 [{name, strength}]；可多条链式叠加',
    };
  }
  report.workflows = Object.fromEntries(
    Object.entries(CFG.workflows ?? {}).map(([k, v]) => [k, { label: v.label ?? null, kind: v.kind ?? null, file: v.apiWorkflowFile ?? null, alias: v.alias ?? [] }]),
  );
  report.presets = Object.fromEntries(
    Object.entries(CFG.presets ?? {}).map(([k, v]) => [
      k,
      {
        label: v.label ?? null,
        alias: v.alias ?? [],
        steps: v.steps ?? null,
        size: v.width && v.height ? `${v.width}x${v.height}` : null,
        loras: (v.loras ?? []).map((l) => `${l.name}@${l.strength}`),
        notes: v.notes ?? null,
      },
    ]),
  );
  // 提示词库：写进配置的现成使用提示词（run_workflow / generate_image / prepare_* 用 prompt_preset 选）
  report.promptLibrary = Object.fromEntries(
    Object.entries(CFG.promptLibrary ?? {}).map(([k, v]) => [
      k,
      { label: v.label ?? null, target: v.target ?? null, preset: v.preset ?? null, prompt: v.prompt ?? null },
    ]),
  );
  // 出图归档：新图先落工作区根目录，用户判断后进 output / bad_output；改图参考图存 referring
  report.folders = {
    defaultWorkspace: CFG.inboxDir,
    output: CFG.outputDir,
    badOutput: CFG.badOutputDir,
    referring: CFG.referringDir,
    perCallOverride:
      "所有出图/归档工具都接受 workspace 参数（当前对话工作区根目录）；传了就落在 <workspace>/{,output,bad_output,referring}；不传时自动按“最近活动的会话记录”识别当前对话的工作区；再兜底才用上面这组默认值",
    rule: "每张图生成后先贴给用户预览并询问能否留存；keep → output/，discard → bad_output/；改图参考图自动存档到 referring/",
  };
  // 诊断：这个服务进程能不能看到对话身份（说明它是 profile 级共享进程还是按会话拉起）
  report.process = {
    cwd: process.cwd(),
    dshEnv: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("DSH_"))),
    activeSession: activeSessionInfo(),
  };
  report.pendingReview = pendingReviewFiles();
  report.verdict = [
    report.ollama.online ? "Ollama 在线" : "Ollama 离线（先运行 ollama serve / ollama list 确认）",
    report.ollama.online && !report.ollama.modelPresent
      ? `Ollama 在线但没有该模型：${CFG.ollama.model}`
      : null,
    report.comfyui.online
      ? "ComfyUI 在线"
      : report.comfyui.lifecycle.mode === "managed"
        ? "ComfyUI 未运行（managed 模式，出图时会自动拉起）"
        : "ComfyUI 离线（external 模式，请自行运行 run_nvidia_gpu.bat）",
    report.comfyui.workflowReady ? null : `缺少 API 工作流文件：${CFG.comfyui.apiWorkflowFile}`,
  ]
    .filter(Boolean)
    .join("；");

  return report;
}

function pickEnum(spec) {
  if (!Array.isArray(spec)) return null;
  const first = spec[0];
  return Array.isArray(first) ? first : null;
}

async function toolPrompts(args) {
  if (!args?.description || !String(args.description).trim()) {
    throw new Error("缺少参数 description");
  }
  const started = Date.now();
  const out = await ollamaPrompts({
    description: String(args.description).trim(),
    style: args.style,
    language: args.language || "zh",
    extraNegative: args.extra_negative,
  });
  return {
    ...out,
    elapsedMs: Date.now() - started,
    hint: "只出文字、不留草稿。要走「先给用户过目再出图」的流程，请用 prepare_image → approve_and_generate。",
  };
}

/** 提示词库：按名字（或别名）取预设好的使用提示词。 */
function getPromptPreset(name) {
  if (name === undefined || name === null || String(name).trim() === "") return null;
  const key = String(name).trim();
  const lib = CFG.promptLibrary ?? {};
  let entry = lib[key];
  let usedKey = key;
  if (!entry) {
    const hit = Object.entries(lib).find(([, v]) => (v.alias ?? []).includes(key));
    if (hit) {
      usedKey = hit[0];
      entry = hit[1];
    }
  }
  if (!entry) {
    throw new Error(`未知提示词预设 "${key}"。可用：${Object.keys(lib).join("、") || "（未配置）"}`);
  }
  return { key: usedKey, ...entry };
}

/** 预设配方：按名字（或别名）取出 LoRA 组合 + 步数 + 尺寸 + 提示词脚手架。 */
function getPreset(name) {
  if (name === undefined || name === null || String(name).trim() === "") return null;
  const key = String(name).trim();
  const presets = CFG.presets ?? {};
  let entry = presets[key];
  let usedKey = key;
  if (!entry) {
    const hit = Object.entries(presets).find(([, v]) => (v.alias ?? []).includes(key));
    if (hit) {
      usedKey = hit[0];
      entry = hit[1];
    }
  }
  if (!entry) {
    throw new Error(`未知预设 "${key}"。可用预设：${Object.keys(presets).join("、") || "（未配置）"}`);
  }
  return { key: usedKey, ...entry };
}

/**
 * 把预设的触发词/兜底短语贴到提示词上：前缀看首个触发词是否已在文中，后缀看关键短语是否已在文中。
 * 只补不加戏，返回是否动过手，便于在结果里如实汇报。
 */
function applyPromptScaffold(preset, positive, enabled = true) {
  let out = String(positive ?? "");
  const report = { prefixApplied: false, suffixApplied: false };
  if (!preset || !enabled) return { positive: out, ...report };
  const pre = preset.promptPrefix ? String(preset.promptPrefix) : "";
  if (pre.trim()) {
    const trigger = pre.split(",")[0].trim();
    if (trigger && !out.toLowerCase().includes(trigger.toLowerCase())) {
      out = `${pre}${out}`;
      report.prefixApplied = true;
    }
  }
  const suf = preset.promptSuffix ? String(preset.promptSuffix) : "";
  if (suf.trim()) {
    // 逐个子句去重：提示词库里已经写过的短语不再重复追加
    const missing = suf
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((c) => !out.toLowerCase().includes(c.toLowerCase()));
    if (missing.length) {
      out = `${out.replace(/[,\s，]+$/, "")}, ${missing.join(", ")}`;
      report.suffixApplied = true;
    }
  }
  return { positive: out, ...report };
}

async function toolImage(args) {
  const pp = getPromptPreset(args?.prompt_preset);
  const positiveIn = args?.positive ?? pp?.prompt;
  if (!positiveIn || !String(positiveIn).trim()) throw new Error("缺少参数 positive（或用 prompt_preset 指定一个提示词预设）");
  // 预设：只填补调用方**没显式给**的项，显式参数永远优先
  const preset = getPreset(args.preset ?? pp?.preset);
  const scaffold = applyPromptScaffold(
    preset,
    String(positiveIn).trim(),
    args.apply_prompt_scaffold === undefined ? true : !!args.apply_prompt_scaffold,
  );
  const sizeGiven =
    args.width !== undefined || args.height !== undefined || args.aspect !== undefined || args.resolution !== undefined;
  const { graph, seed, size, sampling, squareFallback, loras: lorasUsed } = buildGraph({
    positive: scaffold.prefixApplied || scaffold.suffixApplied ? scaffold.positive : String(args.positive).trim(),
    negative: args.negative ?? preset?.negative,
    resolution: args.resolution,
    width: sizeGiven ? args.width : preset?.width,
    height: sizeGiven ? args.height : preset?.height,
    aspect: args.aspect,
    seed: args.seed,
    steps: args.steps ?? preset?.steps,
    cfg: args.cfg,
    cfgLow: args.cfg_low ?? (args.cfg === undefined ? preset?.cfgLow : undefined),
    cfgHigh: args.cfg_high ?? (args.cfg === undefined ? preset?.cfgHigh : undefined),
    cfgSplitStep: args.cfg_split_step,
    denoise: args.denoise,
    mode: args.mode === "edit" ? "edit" : "t2i",
    referenceFile: args.reference_file,
    loras: args.loras ?? preset?.loras ?? CFG.comfyui.defaultLoras,
    samplingShift: args.sampling_shift,
    filenamePrefix: args.filename_prefix,
  });
  const started = Date.now();
  // 方案二：出图前确保 ComfyUI 在线（managed 模式下按需拉起）
  const boot = await ensureComfy();
  // LoRA 名字要能被 ComfyUI 解析，否则它只在提交时报 "Value not in list"，这里先给明白话
  if (lorasUsed.length) {
    const missingIn = (names) =>
      lorasUsed
        .map((l) => l.name)
        .filter((n) => !names.includes(n) && !names.some((x) => x.endsWith(`/${n}`) || x === n));
    // 刚拷进来的 LoRA 可能还没进缓存：先常规查一次，缺了再强制刷新一次
    let names = await availableLoras();
    let missing = missingIn(names);
    if (missing.length) {
      names = await availableLoras(true);
      missing = missingIn(names);
    }
    if (missing.length) {
      throw new Error(
        `LoRA 不存在：${missing.join("、")}。\nComfyUI 当前可用：${names.length ? names.join(" | ") : "（读不到列表）"}`,
      );
    }
    logLine(`应用 LoRA：${lorasUsed.map((l) => `${l.name}@${l.strength}`).join(" + ")}`);
  }
  LIFE.busy = true;
  let saved;
  let promptId;
  let afterRun = null;
  let finished = false;
  try {
    promptId = await comfySubmit(graph);
    logLine(`已提交 ComfyUI 任务 ${promptId}（seed=${seed}，${size.width}x${size.height}，source=${size.source}）`);
    const { images } = await comfyWait(promptId, queueNote);
    saved = await saveImages(
      images,
      {
        mode: sampling?.mode ?? (isEdit ? "edit" : "t2i"),
        tag: pp?.key ?? slugify(String(positiveIn).slice(0, 40), 24),
        presetKey: preset?.key ?? null,
        size: `${size.width}x${size.height}`,
        seed,
      },
      args?.workspace ?? args?.workspace_root,
    );
    finished = true;
  } finally {
    LIFE.busy = false;
    LIFE.lastUsedAt = Date.now();
    if (finished) {
      // 出图确实成功了才动 ComfyUI：先释放显存，再关进程
      const freeVram = lifeConf().freeVramAfterGeneration !== false;
      if (freeVram) await comfyFreeVram();
      afterRun = await closeAfterGeneration();
    } else {
      // 失败/超时：任务很可能还在 ComfyUI 里跑，这时释放显存或关进程都会打断它
      logLine("出图未成功完成，保留 ComfyUI 原样不动（任务可能仍在执行）");
      afterRun = { closed: false, reason: "出图未成功完成，保留进程以免打断可能仍在跑的任务" };
    }
    // 旧的"闲置 N 分钟自动关"：shutdownIdleMs=0 时这里是空操作
    scheduleIdleShutdown();
  }
  return {
    promptId,
    seed,
    resolution: graph[CFG.comfyui.promptNodeId]?.inputs?.resolution ?? null,
    size: {
      width: size.width,
      height: size.height,
      aspect: `${size.width}:${size.height}`,
      source: size.source,
      // 工作流没接 64 通道空 latent 节点时会退回方形，这里点明
      squareOnlyFallback: squareFallback || undefined,
    },
    positive: graph[CFG.comfyui.promptNodeId]?.inputs?.prompt,
    negative: graph[CFG.comfyui.promptNodeId]?.inputs?.negative_prompt,
    sampling,
    preset: preset
      ? {
          key: preset.key,
          label: preset.label ?? null,
          steps: preset.steps ?? null,
          loras: (preset.loras ?? []).map((l) => `${l.name}@${l.strength}`),
          notes: preset.notes ?? null,
        }
      : null,
    promptScaffold: scaffold.prefixApplied || scaffold.suffixApplied ? scaffold : null,
    loras: lorasUsed.length ? lorasUsed.map((l) => ({ name: l.name, strength: l.strength })) : null,
    folders: folderView(args?.workspace ?? args?.workspace_root),
    action_required:
      "把上面的图片贴给用户预览，并问一句能否留存；用户答复后立刻调 judge_image(path=localPath 的文件名, verdict=keep|discard, workspace=同一工作区)。没有答复前不要归档。",
    reference: sampling?.mode === "edit" ? graph[CFG.comfyui.loadImageNodeId ?? "10"]?.inputs?.image ?? null : null,
    images: saved,
    elapsedMs: Date.now() - started,
    comfyui: {
      online: true,
      autoStarted: !!boot?.started,
      startupMs: boot?.waitMs ?? 0,
      vramReleasedAfterRun: lifeConf().freeVramAfterGeneration !== false,
      closedAfterRun: afterRun?.closed === true,
      closeReason: afterRun?.reason ?? null,
      idleShutdownMs: Number(lifeConf().shutdownIdleMs ?? 0),
    },
  };
}

const IMG_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?|mp4|webm|mov)$/i;
// 只认本服务生成的命名（<模式>_<标记>_<档>_<宽x高>_s<种子>_<时间戳>），
// 免得工作区里别的图片被误报成"等你判断"。
const OUR_IMAGE_RE = /^(t2i|edit|img2img|video)_.+_s\d+_\d{8}-\d{4}\.[a-z0-9]+$/i;

/** 找出工作区根目录里等用户判断的出图/出视频文件。 */
function pendingReviewFiles(ws) {
  try {
    return fs
      .readdirSync(workspaceDirs(ws).root)
      .filter((f) => IMG_EXT_RE.test(f) && OUR_IMAGE_RE.test(f))
      .sort();
  } catch {
    return [];
  }
}

/** 用户给出判断后归档：keep → output/，discard → bad_output/。路径可只给文件名。 */
/** 所有已知的对话工作区（从 ~/.dsh/sessions 的目录名解码），用于按文件名找图。 */
let _wsCache = null;
let _wsCacheAt = 0;
function knownWorkspaces() {
  if (_wsCache && Date.now() - _wsCacheAt < 60000) return _wsCache;
  const out = new Set([path.normalize(CFG.inboxDir)]);
  try {
    const dir = path.join(os.homedir(), ".dsh", "sessions");
    for (const name of fs.readdirSync(dir)) {
      let s = String(name).replace(/^-+/, "").replace(/-+$/, "");
      s = s.replace(/~([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      s = s.replace(/-/g, "\\").replace(/\\+/g, "\\");
      // 盘符后的那个 '-' 原本是 ':\'，替换成反斜杠后要补回冒号：D\X\Y → D:\X\Y
      s = s.replace(/^([A-Za-z])\\/, "$1:\\");
      if (/^[A-Za-z]:\\/.test(s)) out.add(path.normalize(s));
    }
  } catch {}
  _wsCache = [...out];
  _wsCacheAt = Date.now();
  return _wsCache;
}

/**
 * 归档时**以文件自身位置为准**推断工作区：
 * 文件在 <X>/ 根目录 → 工作区就是 X；
 * 文件已在 <X>/output|bad_output|referring 里 → 工作区是 X。
 * 这样即使调用方忘了传 workspace，也不会把别的对话的图塞进默认工作区。
 */
function inferWorkspaceFromFile(src) {
  const dir = path.dirname(src);
  const base = path.basename(dir).toLowerCase();
  return ["output", "bad_output", "referring"].includes(base) ? path.dirname(dir) : dir;
}

async function toolJudgeImage(args) {
  const verdict = String(args?.verdict ?? "").trim().toLowerCase();
  const keep = verdict === "keep" || verdict === "留存" || args?.keep === true;
  const discard = verdict === "discard" || verdict === "不留存" || args?.keep === false;
  if (!keep && !discard) throw new Error('缺少参数 verdict：传 "keep"（可留存）或 "discard"（不留存）');

  const list = (Array.isArray(args?.paths) ? args.paths : [args?.path ?? args?.paths]).filter(Boolean);
  if (!list.length) throw new Error("缺少参数 path（待归档的图片路径或文件名）");

  const explicitWs = args?.workspace ?? args?.workspace_root ?? null;
  const moved = [];
  const missing = [];
  const usedRoots = new Set();
  const sources = new Set();

  for (const item of list) {
    const raw = String(item).trim();
    // 候选：绝对路径 → 显式工作区 → 默认工作区 → 所有已知对话工作区（含各自归档子目录）
    const cands = [raw];
    if (!path.isAbsolute(raw)) {
      const roots = explicitWs ? [resolvePath(String(explicitWs))] : knownWorkspaces();
      for (const r of roots) {
        cands.push(path.join(r, raw), path.join(r, path.basename(raw)));
        for (const b of ["output", "bad_output", "referring"]) cands.push(path.join(r, b, path.basename(raw)));
      }
      cands.push(path.join(resolvePath(CFG.inboxDir), raw));
    }
    const src = cands.find((c) => {
      try {
        return fs.existsSync(c) && fs.statSync(c).isFile();
      } catch {
        return false;
      }
    });
    if (!src) {
      missing.push(raw);
      continue;
    }
    // 工作区：显式传入优先；否则按文件位置推断（文件在哪儿，就归档到那儿的 output/bad_output）
    const wsRoot = explicitWs ? resolvePath(String(explicitWs)) : inferWorkspaceFromFile(src);
    const dirs = workspaceDirs(wsRoot);
    const dest = keep ? dirs.output : dirs.badOutput;
    fs.mkdirSync(dest, { recursive: true });
    usedRoots.add(dirs.root);
    sources.add(explicitWs ? "调用传入的 workspace" : "按文件所在位置推断");

    const ext = path.extname(src);
    const target = fs.existsSync(path.join(dest, path.basename(src)))
      ? uniquePath(dest, path.basename(src, ext), ext)
      : path.join(dest, path.basename(src));
    try {
      fs.renameSync(src, target);
    } catch {
      fs.copyFileSync(src, target);
      fs.unlinkSync(src);
    }
    moved.push({ from: src, to: target, workspace: dirs.root });
    logLine(`用户判断「${keep ? "可留存" : "不留存"}」：${path.basename(src)} → ${dest}`);
  }
  if (!moved.length) {
    throw new Error(
      `没找到可归档的文件：${missing.join("、")}\n（找过：显式 workspace 或已知对话工作区 ${knownWorkspaces().join(" | ")}）`,
    );
  }
  const roots = [...usedRoots];
  return {
    verdict: keep ? "keep" : "discard",
    dirs: moved.map((m) => m.to),
    workspace: roots.length === 1 ? roots[0] : roots,
    workspaceSource: [...sources].join(" / "),
    moved,
    missing: missing.length ? missing : undefined,
    note: keep ? "已存入该工作区的 output/" : "已存入该工作区的 bad_output/",
  };
}

/** 显式控制 ComfyUI 的启停 —— 让"不用就关掉"可以被一句话执行。 */async function toolPower(args) {
  const action = String(args?.action ?? "status").toLowerCase();
  if (action === "start") {
    const r = await comfyStart();
    // 手动拉起视为"我要在界面里用"，本次出图完成后不自动关（仅跳过这一次）
    LIFE.manualHold = true;
    return { action, ...r, note: "本次手动拉起：完成一次出图后不会自动关闭，方便你在 ComfyUI 界面里操作。", lifecycle: lifecycleView() };
  }
  if (action === "stop") {
    const r = await comfyStop({ reason: "手动" });
    return { action, ...r, lifecycle: lifecycleView() };
  }
  if (action === "free_vram") {
    const ok = await comfyFreeVram();
    return { action, freed: ok, lifecycle: lifecycleView() };
  }
  const stats = await comfyProbe(6000);
  return {
    action: "status",
    online: !!stats,
    vram: stats?.devices?.[0]
      ? {
          totalMiB: Math.round((stats.devices[0].vram_total ?? 0) / 1048576),
          freeMiB: Math.round((stats.devices[0].vram_free ?? 0) / 1048576),
        }
      : null,
    lifecycle: lifecycleView(),
  };
}

// ---------------------------------------------------------------------------
// 人工审核闸门
//   需求：本地 7B 出完正面/负面提示词后，先给用户过目，用户同意才送 ComfyUI。
//   光靠"提醒模型记得问"不可靠，所以从结构上把关：
//     prepare_image        只生成提示词 + 存草稿，绝不出图
//     approve_and_generate 必须带 approved:true 和有效 draft_id 才出图
//   组合里没有"描述一步出图"的接口，跳过过目在工具层面不成立。
// ---------------------------------------------------------------------------

const DRAFTS = new Map();
let draftSeq = 0;

function draftTtlMs() {
  const n = Number(CFG.draftTtlMs ?? 1800000);
  return Number.isFinite(n) && n > 0 ? n : 1800000;
}

function pruneDrafts() {
  const now = Date.now();
  for (const [id, d] of DRAFTS) {
    if (d.used || now - d.createdAt > d.ttlMs) DRAFTS.delete(id);
  }
}

function newDraft({ description, positive, negative, engine, usage, size, kind = "t2i", reference = null, denoise = null, instruction = null, loras = null, presetKey = null, workspace = null }) {
  pruneDrafts();
  const id = `draft-${Date.now().toString(36)}-${(++draftSeq).toString(36)}`;
  const draft = {
    id,
    kind,
    presetKey,
    workspace,
    description,
    instruction,
    reference,
    denoise,
    loras: normalizeLoras(loras),
    positive,
    negative,
    engine,
    usage,
    size,
    createdAt: Date.now(),
    ttlMs: draftTtlMs(),
    used: false,
  };
  DRAFTS.set(id, draft);
  logLine(
    `已生成草稿 ${id}（${kind}${size ? `，${size.width}x${size.height}` : ""}${reference ? `，参考图 ${reference.name}` : ""}，等待用户过目，${Math.round(draft.ttlMs / 60000)} 分钟内有效）`,
  );
  return draft;
}

/** 改图第一步：把参考图 + 修改要求变成一条编辑指令，存草稿，绝不出图。 */
async function toolPrepareEdit(args) {
  const src = args?.source_image ?? args?.reference_file ?? args?.image;
  if (!src || !String(src).trim()) throw new Error("缺少参数 source_image（参考图路径）");
  // 提示词库里的改图模板可以直接当指令用，省掉一次本地 7B 写词
  const pp = getPromptPreset(args?.prompt_preset);
  const instruction = String(args?.instruction ?? args?.description ?? pp?.prompt ?? "").trim();
  if (!instruction) throw new Error("缺少参数 instruction（你想怎么改），或用 prompt_preset 选一个改图模板");
  // 预设（如 r18_quality）在改图这条路上同样生效：LoRA 组合、步数/cfg 随草稿一起过目
  const preset = getPreset(args?.preset ?? pp?.preset);

  const staged = stageReferenceImage(String(src).trim(), args?.workspace ?? args?.workspace_root);
  const prompts = pp
    ? { positive: pp.prompt, negative: "", engine: `promptLibrary:${pp.key}` }
    : await ollamaPrompts({
        description: instruction,
        style: args.style,
        language: args.language || "zh",
        extraNegative: args.extra_negative,
        intent: "edit",
      });
  // 改图只贴触发词前缀（不套生图那串英文质量词——那会把模型推向"重新画一张"而不是"改这张"）
  const scaffolded = applyPromptScaffold(
    preset ? { promptPrefix: preset.promptPrefix } : null,
    prompts.positive,
    args.apply_prompt_scaffold === undefined ? true : !!args.apply_prompt_scaffold,
  );
  const EDIT_KEEP = "，保留主体外貌、动作、构图与光线";
  let positive = scaffolded.positive;
  if (!positive.includes("保留主体外貌")) positive = `${positive.replace(/[，,\s]+$/, "")}${EDIT_KEEP}`;
  const size = resolveSize({
    resolution: args.resolution ?? preset?.width ?? CFG.comfyui.defaultResolution,
    aspect: args.aspect,
  });
  const denoise =
    args.denoise !== undefined && args.denoise !== null
      ? Number(args.denoise)
      : Number(preset?.editDenoise ?? CFG.comfyui.editDenoise ?? 1.0);
  const draft = newDraft({
    kind: "edit",
    description: instruction,
    instruction,
    positive,
    negative: prompts.negative,
    engine: prompts.engine,
    usage: prompts.usage,
    size,
    denoise,
    reference: { name: staged.name, bytes: staged.bytes, sourcePath: staged.sourcePath, referringPath: staged.referringPath },
    loras: args.loras ?? preset?.loras,
    presetKey: preset?.key ?? null,
    workspace: args?.workspace ?? args?.workspace_root ?? null,
  });
  return {
    draftId: draft.id,
    status: "awaiting_user_approval",
    drewAnything: false,
    kind: "edit",
    reference: {
      fileName: staged.name,
      bytes: staged.bytes,
      sourcePath: staged.sourcePath,
      referringPath: staged.referringPath,
    },
    instruction,
    positive: draft.positive,
    negative: draft.negative,
    editDenoise: denoise,
    referenceResolution: size.width,
    preset: preset
      ? {
          key: preset.key,
          label: preset.label ?? null,
          steps: preset.editSteps ?? preset.steps ?? null,
          cfgLow: preset.cfgLow ?? null,
          cfgHigh: preset.cfgHigh ?? null,
          loras: (preset.loras ?? []).map((l) => `${l.name}@${l.strength}`),
          notes: preset.notes ?? null,
        }
      : null,
    promptScaffold: scaffolded.prefixApplied || scaffolded.suffixApplied ? scaffolded : null,
    engine: prompts.engine,
    expiresInMs: draft.ttlMs,
    note: "改图的画布跟随参考图比例（参考图会被缩放到约 referenceResolution² 的框内）。",
    nextStep:
      "把 instruction / positive / negative 原样贴给用户过目。用户明确同意后才调 approve_and_generate(draft_id, approved=true)；" +
      "要改词就带上新的 positive/negative；想更接近原图就传 denoise（0.6~0.8）；用户放弃就传 approved=false。",
  };
}

/** 第一步：只出提示词，绝不出图。尺寸也在这里定下来，随草稿一起等用户过目。 */
async function toolPrepareImage(args) {
  // 提示词库里的模板已经是成品提示词，直接用，不再过本地 7B
  const pp = getPromptPreset(args?.prompt_preset);
  const desc = String(args?.description ?? pp?.prompt ?? "").trim();
  if (!desc) throw new Error("缺少参数 description（或用 prompt_preset 选一个提示词模板）");
  const preset = getPreset(args?.preset ?? pp?.preset);
  const prompts = pp
    ? { positive: pp.prompt, negative: "", engine: `promptLibrary:${pp.key}` }
    : await ollamaPrompts({
        description: desc,
        style: args.style,
        language: args.language || "zh",
        extraNegative: args.extra_negative,
      });
  // 预设的触发词/兜底短语在这里就贴好，让用户过目的就是最终会被送出的提示词
  const scaffold = applyPromptScaffold(
    preset,
    prompts.positive,
    args.apply_prompt_scaffold === undefined ? true : !!args.apply_prompt_scaffold,
  );
  const sizeGiven =
    args.width !== undefined || args.height !== undefined || args.aspect !== undefined || args.resolution !== undefined;
  const size = resolveSize({
    width: sizeGiven ? args.width : preset?.width,
    height: sizeGiven ? args.height : preset?.height,
    aspect: args.aspect,
    resolution: args.resolution,
  });
  const draft = newDraft({
    description: String(args.description).trim(),
    positive: scaffold.positive,
    negative: prompts.negative,
    engine: prompts.engine,
    usage: prompts.usage,
    size,
    loras: args.loras ?? preset?.loras,
    presetKey: preset?.key ?? null,
    workspace: args?.workspace ?? args?.workspace_root ?? null,
  });
  return {
    draftId: draft.id,
    status: "awaiting_user_approval",
    drewAnything: false,
    preset: preset
      ? {
          key: preset.key,
          label: preset.label ?? null,
          steps: preset.steps ?? null,
          loras: (preset.loras ?? []).map((l) => `${l.name}@${l.strength}`),
          notes: preset.notes ?? null,
        }
      : null,
    promptScaffold: scaffold.prefixApplied || scaffold.suffixApplied ? scaffold : null,
    positive: draft.positive,
    negative: draft.negative,
    size: {
      width: size.width,
      height: size.height,
      aspect: `${size.width}:${size.height}`,
      source: size.source,
    },
    engine: prompts.engine,
    expiresInMs: draft.ttlMs,
    nextStep:
      "把 positive / negative 原样贴给用户过目。用户明确同意后才调 approve_and_generate(draft_id, approved=true)；" +
      "要改词就同时带上新的 positive/negative；用户放弃就传 approved=false。",
  };
}

/** 第二步：只有拿到明确同意才出图。 */
async function toolApproveGenerate(args) {
  const id = String(args?.draft_id ?? "").trim();
  if (!id) throw new Error("缺少参数 draft_id（应由 prepare_image 返回）");

  if (args?.approved !== true) {
    const existed = DRAFTS.delete(id);
    logLine(`用户未同意，草稿作废：${id}（存在=${existed}）`);
    return {
      draftId: id,
      approved: false,
      drewAnything: false,
      note: existed
        ? "已按用户意见放弃该草稿，没有提交 ComfyUI。要新提示词请重新 prepare_image。"
        : "该草稿不存在或已过期——同样没有提交 ComfyUI。要新提示词请重新 prepare_image。",
    };
  }

  pruneDrafts();
  const draft = DRAFTS.get(id);
  if (!draft) {
    throw new Error(`草稿 ${id} 不存在、已过期或已用过。请重新 prepare_image 生成，并再次请用户过目。`);
  }
  DRAFTS.delete(id); // 一次性，防止同一草稿被反复出图
  draft.used = true;

  const edited = !!(args?.positive || args?.negative);
  const positive = args?.positive ? String(args.positive) : draft.positive;
  const negative = args?.negative ? String(args.negative) : draft.negative;
  const sizeOverridden =
    args?.width !== undefined || args?.height !== undefined || args?.aspect !== undefined || args?.resolution !== undefined;
  const isEdit = draft.kind === "edit" && draft.reference?.name;
  logLine(`用户已同意草稿 ${id}（${draft.kind}），提交出图${edited ? "（提示词有修改）" : ""}`);

  const image = await toolImage({
    positive,
    negative,
    // 草稿记住的预设（步数/LoRA/尺寸）在这里继续生效；显式参数与草稿里的值优先
    preset: draft.presetKey ?? args.preset,
    apply_prompt_scaffold: false,
    // 归档工作区沿用草稿里那个（即 prepare 时的对话工作区）
    workspace: args?.workspace ?? args?.workspace_root ?? draft.workspace ?? undefined,
    // 改图：走参考图路线，画布跟随参考图
    mode: isEdit ? "edit" : "t2i",
    reference_file: isEdit ? draft.reference.name : undefined,
    denoise: isEdit
      ? args.denoise !== undefined && args.denoise !== null
        ? Number(args.denoise)
        : (draft.denoise ?? Number(CFG.comfyui.editDenoise ?? 1.0))
      : undefined,
    // 默认沿用草稿里过目过的尺寸；这一步显式给了尺寸就覆盖它
    width: isEdit ? undefined : sizeOverridden ? args.width : draft.size?.width,
    height: isEdit ? undefined : sizeOverridden ? args.height : draft.size?.height,
    aspect: isEdit ? undefined : sizeOverridden ? args.aspect : undefined,
    resolution: isEdit
      ? (args.resolution ?? draft.size?.width ?? CFG.comfyui.defaultResolution)
      : sizeOverridden
        ? args.resolution
        : undefined,
    seed: args.seed,
    // 改图走预设的 editSteps（如 r18_quality → 25 步），生图走预设的 steps
    steps: args.steps ?? (isEdit ? getPreset(draft.presetKey)?.editSteps : undefined),
    cfg: args.cfg,
    cfg_low: args.cfg_low,
    cfg_high: args.cfg_high,
    cfg_split_step: args.cfg_split_step,
    loras: args.loras ?? (draft.loras?.length ? draft.loras : undefined),
    filename_prefix: args.filename_prefix,
  });
  return {
    draftId: id,
    kind: draft.kind,
    approved: true,
    approvedAt: new Date().toISOString(),
    editedByUser: edited,
    prompts: { positive, negative },
    instruction: draft.instruction ?? undefined,
    reference: isEdit ? draft.reference : undefined,
    sizeOverridden: isEdit ? undefined : sizeOverridden,
    ...image,
  };
}


function wfEntry(name) {
  const reg = CFG.workflows ?? {};
  const key = String(name ?? "").trim();
  const lower = key.toLowerCase();
  if (!key) throw new Error(`缺少工作流名。可用：${Object.keys(reg).join("、") || "（未配置）"}`);
  if (reg[key]) return { key, ...reg[key] };
  if (reg[lower]) return { key: lower, ...reg[lower] };
  const hit = Object.entries(reg).find(([k, v]) => k.toLowerCase() === lower || (v.alias ?? []).includes(lower));
  if (hit) return { key: hit[0], ...hit[1] };
  throw new Error(`未知工作流 "${name}"。可用：${Object.keys(reg).join("、") || "（未配置）"}`);
}

function wfSetRef(graph, ref, value) {
  if (!ref || value === undefined || value === null) return false;
  const node = graph[String(ref.node)];
  if (!node) throw new Error(`工作流缺少节点 ${ref.node}`);
  node.inputs[ref.input] = value;
  return true;
}

/**
 * 把请求的 LoRA 名解析成 ComfyUI 列表里的**规范名**。
 * 分隔符（\ 与 /）、大小写、前导 "./" 全部不敏感 —— 之前 loraCatalog 里写成双反斜杠
 * 导致视频流程整条 LoRA 链被 ComfyUI 拒绝，就是靠这个兜住的。
 */
function canonicalLoraName(names, want) {
  if (!names?.length) return null;
  const norm = (s) => String(s).replace(/[\\/]+/g, "/").replace(/^\.?\//, "").toLowerCase();
  const w = norm(want);
  return (
    names.find((x) => norm(x) === w) ??
    names.find((x) => norm(x).endsWith(`/${w}`)) ??
    names.find((x) => norm(x).split("/").pop() === w.split("/").pop()) ??
    null
  );
}

function wfApplyLoras(graph, chain, loras, knownNames = null) {
  if (!loras || !loras.length) return [];
  const diT = String(chain?.diT ?? "1");
  for (const k of Object.keys(graph)) {
    if (graph[k]?.class_type === "LoraLoaderModelOnly") delete graph[k];
  }
  let prev = [diT, 0];
  let n = 900;
  const applied = [];
  for (const l of loras) {
    const id = String(n++);
    // 有列表就用规范名，避免分隔符/大小写差异被 ComfyUI 判为 "Value not in list"
    const name = (knownNames && canonicalLoraName(knownNames, l.name)) || String(l.name);
    graph[id] = { class_type: "LoraLoaderModelOnly", inputs: { model: prev, lora_name: name, strength_model: Number(l.strength ?? 1) } };
    prev = [id, 0];
    applied.push({ name, strength: Number(l.strength ?? 1) });
  }
  for (const c of chain?.consumers ?? []) {
    const node = graph[String(c)];
    if (node) node.inputs.model = prev;
  }
  return applied;
}

function pickLoras({ catalog, family, text, presetKey, ref2v, cap = 8 }) {
  const fam = family ?? "h3";
  const entries = Object.values(catalog ?? {}).filter((e) => (e.family ?? "h3") === fam);
  let hay = String(text ?? "").toLowerCase();
  // 否定短语先摘掉，避免「不插入」「不射精」误触发
  for (const n of ["不插入", "没有插入", "无插入", "不射精", "不要射精", "不潮吹", "不自慰", "不脱", "no insert", "no penetration", "not insert", "without penetration"]) {
    hay = hay.split(n.toLowerCase()).join(" ");
  }
  const chosen = [];
  const push = (e) => { if (e && !chosen.includes(e)) chosen.push(e); };
  for (const e of entries) {
    if (e.ref2vOnly && !ref2v) continue;
    if (e.always || (e.alwaysFor ?? []).includes(presetKey)) push(e);
  }
  for (const e of entries) {
    if (e.always || e.ref2vOnly && !ref2v) continue;
    if ((e.tags ?? []).some((t) => t && hay.includes(String(t).toLowerCase()))) push(e);
  }
  // 场景件可覆盖 always 项（互斥）
  for (const e of chosen.filter((x) => !x.always)) {
    for (const ex of e.excludes ?? []) {
      const i = chosen.findIndex((c) => c.name === ex);
      if (i >= 0) chosen.splice(i, 1);
    }
  }
  // 超量时按 priority 从低到高剔除（priority 越小越重要，默认 6）
  while (chosen.length > cap) {
    let worst = 0;
    for (let i = 1; i < chosen.length; i++) {
      if ((chosen[i].priority ?? 6) >= (chosen[worst].priority ?? 6)) worst = i;
    }
    chosen.splice(worst, 1);
  }
  return chosen.map((e) => ({ name: e.name, strength: e.strength ?? 1, effect: e.effect ?? null, trigger: e.trigger ?? null }));
}

async function toolRunWorkflow(args) {
  const entry = wfEntry(args?.name);
  const defaults = entry.defaults ?? {};
  const scaffold = (text) => [entry.promptPrefix, text, entry.promptSuffix].filter(Boolean).join("");
  // 提示词库：按名字取现成模板（写法见 config.json 的 promptLibrary）
  const pp = getPromptPreset(args?.prompt_preset);
  if (entry.kind === "image") {
    const promptText = String(args?.prompt ?? args?.scene ?? pp?.prompt ?? defaults.prompt ?? "").trim();
    const presetKey = args?.preset ?? pp?.preset ?? entry.imagePreset;
    // pv 在 dry_run 与实跑两处都要用，统一在这里取一次
    const pv = presetKey ? getPreset(presetKey) : null;
    if (!promptText) throw new Error(`${entry.label ?? entry.key} 需要 prompt`);
    if (args?.dry_run) {
      return {
        workflow: entry.key, label: entry.label ?? null, kind: "image", mode: entry.mode ?? "t2i", dryRun: true, submitted: false,
        prompt: scaffold(promptText), negative: args?.negative ?? pv?.negative ?? null,
        size: { width: args?.width ?? defaults.width ?? pv?.width ?? null, height: args?.height ?? defaults.height ?? pv?.height ?? null },
        resolution: args?.resolution ?? null,
        steps:
          args?.steps ??
          (entry.mode === "edit" ? (pv?.editSteps ?? defaults.steps) : (pv?.steps ?? defaults.steps)) ??
          null,
        denoise: entry.mode === "edit" ? (args?.denoise ?? pv?.editDenoise ?? defaults.denoise ?? null) : null,
        source_image: args?.source_image ?? null, preset: pv?.key ?? null, loras: pv?.loras ?? null,
        prompt_preset: pp ? { key: pp.key, label: pp.label ?? null, target: pp.target ?? null } : null,
        note: "dry_run：没有提交 ComfyUI。把这份计划交给用户过目，确认后去掉 dry_run 再调一次。",
      };
    }
    let referenceFile;
    if (entry.mode === "edit") {
      if (!args?.source_image) throw new Error("改图预设需要 source_image（本机图片路径）");
      referenceFile = stageReferenceImage(args.source_image, args?.workspace ?? args?.workspace_root).name;
    }
    const img = await toolImage({
      positive: scaffold(promptText),
      negative: args?.negative,
      apply_prompt_scaffold: false,
      preset: presetKey,
      mode: args?.mode === "img2img" ? "img2img" : entry.mode === "edit" ? "edit" : "t2i",
      reference_file: referenceFile,
      // 预设优先于注册表的 defaults：否则选了 r18_fast 也还是跑默认步数
      denoise: args?.denoise ?? (entry.mode === "edit" ? (pv?.editDenoise ?? defaults.denoise) : defaults.denoise),
      width: args?.width ?? defaults.width,
      height: args?.height ?? defaults.height,
      resolution: args?.resolution,
      aspect: args?.aspect,
      seed: args?.seed,
      steps:
        args?.steps ??
        (entry.mode === "edit" ? (pv?.editSteps ?? defaults.steps) : (pv?.steps ?? defaults.steps)),
      filename_prefix: args?.filename_prefix,
      loras: args?.loras,
    });
    return {
      workflow: entry.key, label: entry.label ?? null, kind: "image", mode: entry.mode ?? "t2i",
      prompt_preset: pp ? { key: pp.key, label: pp.label ?? null, target: pp.target ?? null } : null,
      action_required:
        "把上面的图片贴给用户预览，并问一句能否留存；用户答复后立刻调 judge_image(path=localPath 的文件名, verdict=keep|discard)。",
      ...img,
    };
  }
  const file = resolvePath(entry.apiWorkflowFile);
  if (!fs.existsSync(file)) throw new Error(`工作流文件不存在：${file}`);
  const graph = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  const sceneArg = args?.prompt ?? args?.scene ?? pp?.prompt;
  const promptText = sceneArg ? scaffold(String(sceneArg)) : (defaults.prompt ?? null);
  if (promptText) wfSetRef(graph, entry.prompt, promptText);
  if (args?.negative) wfSetRef(graph, entry.negative, String(args.negative));
  wfSetRef(graph, entry.width, args?.width ?? defaults.width);
  wfSetRef(graph, entry.height, args?.height ?? defaults.height);
  wfSetRef(graph, entry.length, args?.length ?? defaults.length);
  wfSetRef(graph, entry.steps, args?.steps ?? defaults.steps);
  wfSetRef(graph, entry.prefix, args?.filename_prefix ?? defaults.filename_prefix);
  const seed = args?.seed !== undefined && args?.seed !== null ? Math.floor(Number(args.seed)) : Math.floor(Math.random() * 2 ** 31);
  wfSetRef(graph, entry.seed, seed);
  let lorasUsed = null;
  if (args?.loras?.length) {
    lorasUsed = wfApplyLoras(graph, entry.loraChain, normalizeLoras(args.loras));
  } else if (args?.auto_loras !== false && CFG.loraCatalog && entry.autoLoras !== false) {
    let picked = pickLoras({ catalog: CFG.loraCatalog, family: entry.family ?? "h3", text: `${promptText ?? ""} ${args?.scene ?? ""}`, presetKey: entry.key, ref2v: !!entry.imageRef });
    if (!picked.length) picked = entry.baseLoras ?? [];
    if (picked.length) lorasUsed = wfApplyLoras(graph, entry.loraChain, picked);
  } else if (entry.baseLoras?.length) {
    lorasUsed = wfApplyLoras(graph, entry.loraChain, entry.baseLoras);
  }
  let refInfo = null;
  if (entry.imageRef) {
    if (!args?.source_image) throw new Error(`${entry.label ?? entry.key} 需要 source_image（参考图路径）`);
    const staged = stageReferenceImage(args.source_image, args?.workspace ?? args?.workspace_root);
    refInfo = { fileName: staged.name, sourcePath: staged.sourcePath, referringPath: staged.referringPath };
    const lid = String(entry.imageRef.node);
    graph[lid] = { class_type: "LoadImage", inputs: { image: staged.name } };
    const consumer = graph[String(entry.imageRef.consumer)];
    if (!consumer) throw new Error(`工作流缺少节点 ${entry.imageRef.consumer}`);
    consumer.inputs[entry.imageRef.input] = [lid, 0];
  }
  if (args?.dry_run) {
    return {
      workflow: entry.key, label: entry.label ?? null, kind: entry.kind ?? "video", dryRun: true, submitted: false,
      prompt: promptText, negative: args?.negative ?? null,
      size: { width: args?.width ?? defaults.width ?? null, height: args?.height ?? defaults.height ?? null },
      length: args?.length ?? defaults.length ?? null, steps: args?.steps ?? defaults.steps ?? null,
      filename_prefix: args?.filename_prefix ?? defaults.filename_prefix ?? null,
      source_image: args?.source_image ?? null,
      reference: refInfo,
      folders: folderView(args?.workspace ?? args?.workspace_root),
      loras: lorasUsed ?? entry.baseLoras ?? null,
      note: "dry_run：没有提交 ComfyUI。把这份计划（提示词 + LoRA 清单与作用 + 参数）交给用户过目，确认后去掉 dry_run 再调一次。",
    };
  }
  const boot = await ensureComfy();
  if (lorasUsed?.length) {
    // 校验并**换成 ComfyUI 列表里的规范名**（分隔符/大小写不敏感），避免 "Value not in list"
    let names = await availableLoras();
    let resolved = lorasUsed.map((l) => canonicalLoraName(names, l.name));
    if (resolved.some((r) => !r)) {
      names = await availableLoras(true);
      resolved = lorasUsed.map((l) => canonicalLoraName(names, l.name));
    }
    const missing = lorasUsed.filter((l, i) => !resolved[i]).map((l) => l.name);
    if (missing.length) throw new Error(`LoRA 不存在：${missing.join("、")}。ComfyUI 当前可用：${names.length ? names.join(" | ") : "（读不到列表）"}`);
    const canonical = lorasUsed.map((l, i) => ({ name: resolved[i], strength: l.strength }));
    if (canonical.some((l, i) => l.name !== lorasUsed[i].name)) {
      logLine(`[run_workflow:${entry.key}] LoRA 名已规范化为：${canonical.map((l) => l.name).join(" + ")}`);
      lorasUsed = wfApplyLoras(graph, entry.loraChain, canonical, names);
    } else {
      lorasUsed = canonical;
    }
  }
  LIFE.busy = true;
  let promptId, saved, finished = false, afterRun = null;
  try {
    promptId = await comfySubmit(graph);
    logLine(`[run_workflow:${entry.key}] 已提交 ${promptId}（seed=${seed}）`);
    const { images } = await comfyWait(promptId, queueNote);
    saved = await saveImages(
      images,
      {
        mode: entry.kind === "video" ? "video" : entry.mode === "edit" ? "edit" : "t2i",
        tag: pp?.key ?? entry.key,
        presetKey: pp?.preset ?? entry.imagePreset ?? null,
        size: `${args?.width ?? defaults.width ?? "?"}x${args?.height ?? defaults.height ?? "?"}`,
        seed,
      },
      args?.workspace ?? args?.workspace_root,
    );
    finished = true;
  } finally {
    LIFE.busy = false;
    LIFE.lastUsedAt = Date.now();
    if (finished) {
      if (lifeConf().freeVramAfterGeneration !== false) await comfyFreeVram();
      afterRun = await closeAfterGeneration();
    } else {
      afterRun = { closed: false, reason: "未成功完成，保留进程以免打断可能仍在跑的任务" };
    }
    scheduleIdleShutdown();
  }
  return {
    workflow: entry.key, label: entry.label ?? null, kind: entry.kind ?? "video",
    promptId, seed, files: saved, loras: lorasUsed, boot, afterRun,
    source_image: args?.source_image ?? null,
    reference: refInfo,
    folders: folderView(args?.workspace ?? args?.workspace_root),
    action_required:
      "把产物贴给用户预览，并问一句能否留存；用户答复后调 judge_image(verdict=keep|discard, workspace=同一工作区)。",
  };
}

function renderResult(value) {
  const content = [{ type: "text", text: JSON.stringify(value, null, 2) }];
  if (CFG.returnImageBlocks) {
    for (const img of value?.images ?? []) {
      if (img.localPath && fs.existsSync(img.localPath)) {
        content.push({ type: "image", data: fs.readFileSync(img.localPath).toString("base64"), mimeType: "image/png" });
      }
    }
  }
  return content;
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function ok(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: message }], isError: true } });
}

const HANDLERS = {
  initialize(params) {
    const requested = params?.protocolVersion;
    const version = SUPPORTED_PROTOCOLS.includes(requested) ? requested : FALLBACK_PROTOCOL;
    return {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        `本地出图必须经过用户过目：文生图用 prepare_image(描述)、改图用 prepare_edit(source_image, instruction)，` +
        `两者都只生成提示词并返回 draft_id（绝不出图）；把提示词原样贴给用户看，用户明确同意后才调 ` +
        `approve_and_generate(draft_id, approved=true) 出图；用户要改词就带上新的 positive/negative；用户放弃就传 approved=false。` +
        `generate_prompts 只出文字不留草稿；generate_image 仅在提示词由用户直接给出时使用；` +
        `采样默认 25 步、两段式 cfg 1.0→3.0（前段锁构图、后段配负面词重写字）；comfyui_power 管 ComfyUI 启停；service_status 自检。` +
        `**出图归档流程**：每次出图都带上 workspace=（当前对话的工作区根目录，即你的工作目录），` +
        `图会落到 <workspace> 根目录；你必须把图贴给用户预览并询问能否留存；` +
        `用户说可以就调 judge_image(verdict="keep")，说不可以就 judge_image(verdict="discard")，` +
        `分别归档到该工作区的 output/ 与 bad_output/。judge_image **以图片所在位置判定工作区**，` +
        `所以即使忘了传 workspace 也不会把别的对话的图归档到默认工作区。` +
        `改图参考图自动存档到 <workspace>/referring/。不传 workspace 出图时会退回 config.json 默认目录（换对话可能归错地方）。` +
        `未得到答复前不要调用 judge_image。`,
    };
  },
  "tools/list": () => ({ tools: TOOLS }),
  ping: () => ({}),
};

let inFlight = 0;
let stdinEnded = false;
let exitArmed = false;

/** 只有在所有在途调用结束后才退出，避免吞吐到一半被 EOF 截断。 */
function maybeExit() {
  if (!stdinEnded || inFlight > 0 || exitArmed) return;
  exitArmed = true;
  const check = () => {
    if (inFlight > 0) return setTimeout(check, 50);
    process.exit(0);
  };
  setTimeout(check, 30);
}

async function handleToolsCall(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  const started = Date.now();
  inFlight += 1;
  try {
    let value;
    if (name === "service_status") value = await toolServiceStatus();
    else if (name === "comfyui_power") value = await toolPower(args);
    else if (name === "judge_image") value = await toolJudgeImage(args);
    else if (name === "generate_prompts") value = await toolPrompts(args);
    else if (name === "generate_image") value = await toolImage(args);
    else if (name === "prepare_image") value = await toolPrepareImage(args);
    else if (name === "prepare_edit") value = await toolPrepareEdit(args);
    else if (name === "approve_and_generate") value = await toolApproveGenerate(args);
    else if (name === "run_workflow") value = await toolRunWorkflow(args);
    else return fail(id, -32602, `未知工具：${name}`);
    logLine(`${name} 完成，用时 ${Date.now() - started}ms`);
    ok(id, { content: renderResult(value) });
  } catch (err) {
    logLine(`${name} 失败：${err?.message || err}`);
    fail(id, -32000, `${name} 失败：${err?.message || String(err)}`);
  } finally {
    inFlight -= 1;
    maybeExit();
  }
}

function handleMessage(msg) {
  const { id, method, params } = msg ?? {};
  if (method === undefined) return; // a response to something we never send
  const isNotification = id === undefined || id === null;

  if (isNotification) {
    if (method === "notifications/initialized" || method === "notifications/cancelled") return;
    return;
  }
  if (method === "tools/call") {
    handleToolsCall(id, params);
    return;
  }
  const handler = HANDLERS[method];
  if (handler) {
    try {
      ok(id, handler(params));
    } catch (err) {
      fail(id, -32000, String(err?.message || err));
    }
    return;
  }
  // Method not found: answer with a protocol-level error, not a tool result.
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      logLine(`收到无法解析的消息：${shortText(line, 200)}`);
      continue;
    }
    try {
      handleMessage(msg);
    } catch (err) {
      logLine(`处理消息出错：${err?.message || err}`);
    }
  }
});
process.stdin.on("end", () => {
  stdinEnded = true;
  maybeExit();
});
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    stdinEnded = true;
    maybeExit();
  });
}
process.on("uncaughtException", (err) => logLine(`未捕获异常：${err?.stack || err}`));
process.on("unhandledRejection", (err) => logLine(`未处理的 Promise 拒绝：${err?.stack || err}`));
// 服务退出（DSH 关闭/重启）时必须带走自启的 ComfyUI，否则会留下孤儿 python 进程
process.on("exit", shutdownOwnedComfy);

const shutdownPolicy = () => {
  const life = lifeConf();
  const idleMin = Math.round(Number(life.shutdownIdleMs ?? 0) / 60000);
  const parts = [];
  if (life.shutdownAfterGeneration !== false) parts.push("出图完成即关闭");
  if (idleMin > 0) parts.push(`闲置 ${idleMin} 分钟后关闭`);
  return parts.length ? `（${parts.join(" + ")}）` : "（不自动关闭）";
};

logLine(
  `${SERVER_NAME} ${SERVER_VERSION} 启动：ollama=${CFG.ollama.baseURL} comfyui=${CFG.comfyui.baseURL} ` +
    `lifecycle=${lifeMode()}${lifeMode() === "managed" ? shutdownPolicy() : ""}`,
);
// 强杀自愈：这次启动先把上次遗留的 ComfyUI 收掉，保证"启动时刻"它是关着的
void reapStaleComfy();
