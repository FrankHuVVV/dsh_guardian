#!/usr/bin/env node
/**
 * DSH Guardian UI — 后端代理服务（第 1 步）
 * ---------------------------------------------------------------
 * 原生 Node.js，零第三方依赖。
 * 职责：把前端的 HTTP 请求翻译成对 bin/guardian.mjs 的 execFile 调用。
 *
 * 路由：
 *   GET  /            读取并返回同目录 index.html（不存在 → 404）
 *   GET  /api/status  执行 `node ../bin/guardian.mjs status`，解析 stdout JSON；
 *                     再执行 `list`，合并最新 lkg 字段
 *   POST /api/exec    请求体 { cmd: string, args: string[] }，
 *                     执行 `node ../bin/guardian.mjs <cmd> ...args`（timeout 180000ms）
 *
 * 启动：node ui/server.mjs
 * 监听：http://127.0.0.1:3081
 */

import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

// ---------------------------------------------------------------- 常量与路径

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url)); // ...\ui
const ROOT_DIR = path.resolve(SERVER_DIR, '..');                 // guardian 根目录

// 启动参数 / 环境变量决定运行模式
const START_ARGS = process.argv.slice(2);
const SANDBOX_MODE = START_ARGS.includes('--sandbox') || /^true$/i.test(String(process.env.GUARDIAN_SANDBOX || ''));
const portArgIndex = START_ARGS.indexOf('--port');
const portArg = portArgIndex >= 0 ? Number(START_ARGS[portArgIndex + 1]) : NaN;

const PROJECT_ROOT = SANDBOX_MODE ? path.join(ROOT_DIR, 'sandbox') : ROOT_DIR;
const GUARDIAN_MJS = SANDBOX_MODE
  ? path.join(PROJECT_ROOT, 'bin', 'guardian.mjs')
  : path.join(ROOT_DIR, 'bin', 'guardian.mjs');
const SANDBOX_CONFIG = path.join(PROJECT_ROOT, 'config.json');
const SANDBOX_STATE = path.join(PROJECT_ROOT, 'state.json');
const INDEX_HTML = path.resolve(SERVER_DIR, 'index.html');

const HOST = '127.0.0.1';
const PORT = Number.isInteger(portArg) && portArg > 0 ? portArg : (SANDBOX_MODE ? 3082 : 3081);

const NODE_BIN = process.execPath; // 等价于 `node`，但不受 PATH 影响
const EXEC_TIMEOUT_MS = 180000;
const PLUGIN_TIMEOUT_MS = 15 * 60 * 1000; // 远程安装含下载/构建，180s 不够
const STATUS_TIMEOUT_MS = 60000;

/** 插件事务可能远超普通命令的 180 秒上限。 */
function commandTimeout(cmd) {
  return /^plugin-/.test(String(cmd || '')) ? PLUGIN_TIMEOUT_MS : EXEC_TIMEOUT_MS;
}
const MAX_BUFFER = 64 * 1024 * 1024; // list 输出可达数百 KB，放宽到 64MB
const MAX_BODY_BYTES = 1024 * 1024;

// ---------------------------------------------------------------- 小工具

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
};

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function sendJson(res, statusCode, payload) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload ?? null, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  if (res.writableEnded) return;
  const body = String(text ?? '');
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

/** 读取请求体，带大小上限；失败时返回结构化错误。 */
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let finished = false;

    const done = (result) => {
      if (finished) return;
      finished = true;
      resolve(result);
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        done({ ok: false, error: `请求体超过上限 ${limit} 字节` });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return done({ ok: true, text: '', value: null });
      try {
        done({ ok: true, text, value: JSON.parse(text) });
      } catch (err) {
        done({ ok: false, error: `JSON 解析失败: ${err.message}` });
      }
    });
    req.on('error', (err) => done({ ok: false, error: `读取请求体失败: ${err.message}` }));
  });
}

/** 宽松解析 stdout：容忍 BOM、前后杂讯，取第一个 { 到最后一个 }。 */
function parseJsonLoose(text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '').trim();
  if (!raw) return { ok: false, error: 'stdout 为空' };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return { ok: true, value: JSON.parse(raw.slice(first, last + 1)) };
      } catch {
        /* 落到下面 */
      }
    }
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------- guardian 调用

/**
 * 用 execFile 执行 `node <guardian.mjs> <cmd> ...args`。
 * 永不 reject：失败也 resolve 出带 stderr 的结果，保证服务不崩。
 *
 * @returns {Promise<{code:number, stdout:string, stderr:string, timedOut:boolean, error:string|null, durationMs:number}>}
 */
function runGuardian(cmd, args = [], { timeout = EXEC_TIMEOUT_MS } = {}) {
  const argv = [GUARDIAN_MJS, cmd, ...args.map((a) => String(a))];
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve({ durationMs: Date.now() - startedAt, ...result });
    };

    let child;
    try {
      child = execFile(
        NODE_BIN,
        argv,
        {
          cwd: PROJECT_ROOT,
          timeout,
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
          encoding: 'utf8'
        },
        (error, stdout, stderr) => {
          const timedOut = Boolean(
            error && (error.killed === true || error.code === 'ETIMEDOUT')
          );

          if (!error) {
            settle({
              code: 0,
              stdout: stdout ?? '',
              stderr: stderr ?? '',
              timedOut: false,
              error: null
            });
            return;
          }

          // 执行失败：保留已产生的 stdout/stderr，附带说明，绝不抛出。
          const notes = [];
          if (timedOut) notes.push(`执行超时（${timeout}ms），进程已被终止`);
          if (error.code === 'ENOENT') notes.push('无法启动 node 可执行文件（ENOENT）');
          // error.message 已内联 stderr，只取首行避免与上面的 stderr 重复。
          if (error.message) notes.push(String(error.message).split(/\r?\n/)[0]);

          const errText = [stderr ?? '', error.stderr ?? '']
            .filter((s) => s && String(s).trim())
            .join('\n');
          const mergedStderr = [errText, notes.length ? `[guardian-ui] ${notes.join('; ')}` : '']
            .filter((s) => s && String(s).trim())
            .join('\n');

          settle({
            code: typeof error.code === 'number' ? error.code : 1,
            stdout: stdout ?? error.stdout ?? '',
            stderr: mergedStderr,
            timedOut,
            error: error.message ?? String(error)
          });
        }
      );
    } catch (err) {
      // execFile 同步抛错（例如参数非法）也只记录，不中断服务。
      settle({
        code: 1,
        stdout: '',
        stderr: `[guardian-ui] execFile 调用失败: ${err.message}`,
        timedOut: false,
        error: err.message
      });
      return;
    }

    // 子进程自身错误（极少数平台事件）一并兜住。
    child.on('error', (err) => {
      settle({
        code: 1,
        stdout: '',
        stderr: `[guardian-ui] 子进程错误: ${err.message}`,
        timedOut: false,
        error: err.message
      });
    });
  });
}

/** 取 list 输出里 createdRecently 的最后一条快照（list 已按 createdAt 升序）。 */
function pickLatestSnapshot(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) return null;
  return snapshots.reduce((latest, item) => {
    if (!latest) return item;
    const a = String(item?.createdAt ?? '');
    const b = String(latest?.createdAt ?? '');
    return a > b ? item : latest;
  }, null);
}

// ---------------------------------------------------------------- Mock 测试通道
// 用于在不触碰真实 guardian 事务的前提下，验证前端「长任务 + 流式日志」交互链路。
// 命中 cmd === 'mock-test' 时完全不调用 execFile。

const MOCK_PHASES = [
  '1/5 正在检查环境...',
  '2/5 正在校验运行时闭包...',
  '3/5 正在读取事务状态...',
  '4/5 正在模拟快照创建...',
  '5/5 正在模拟启动验证...'
];

function sseSend(res, event, data) {
  if (!res || res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** SSE 心跳：每 intervalMs 发一次 event: ping；返回停止函数。intervalMs<=0 时不启动。 */
function startHeartbeat(res, intervalMs = 10000) {
  if (!intervalMs || intervalMs <= 0) return () => {};
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    sseSend(res, 'ping', { at: Date.now() });
  }, intervalMs);
  return () => clearInterval(timer);
}

function parseMockOptions(argv) {
  const args = (argv || []).map((v) => String(v));
  const has = (name) => args.includes(name);
  // --hang 优先级最高；--fail / --fail-at / --fail-code 任一出现都进入失败模式
  const mode = has('--hang')
    ? 'hang'
    : (has('--timeout') ? 'timeout' : ((has('--fail') || has('--fail-at') || has('--fail-code')) ? 'fail' : 'normal'));
  const readNum = (name, allowZero = false) => {
    const i = args.indexOf(name);
    if (i < 0 || i + 1 >= args.length) return null;
    const n = Number(args[i + 1]);
    if (!Number.isFinite(n) || n < 0 || (!allowZero && n <= 0)) return null;
    return Math.round(n);
  };
  return {
    mode,
    seconds: readNum('--seconds'),
    failAt: readNum('--fail-at'),
    failCode: readNum('--fail-code'),
    pingMs: readNum('--ping-ms', true),
    hang: has('--hang')
  };
}

/**
 * mock-test 专用执行器（不调用 execFile）：
 *   normal           : 每 2 秒一条 stdout 日志，默认 10 秒后退出码 0
 *   --fail           : 默认 3 秒推 stderr，5 秒退出码 2
 *   --timeout        : 默认 20 秒退出码 124（timedOut=true）
 *   --seconds N      : 自定义总时长
 *   --fail-at N      : 自定义第几秒触发 stderr
 *   --fail-code N    : 自定义失败退出码（默认 2）
 *   --hang           : 模拟卡死，最长 60 秒后强制结束（退出码 124）
 *   --ping-ms N      : SSE 心跳间隔（默认 10000ms；0 表示关闭，仅测试用）
 * 客户端带 Accept: text/event-stream 时 SSE 逐步推送，否则结束时一次性 JSON。
 */
function handleMockExec(req, res, argv) {
  const opts = parseMockOptions(argv);
  const mode = opts.mode;
  const startedAt = Date.now();
  const wantStream = /text\/event-stream/i.test(String(req.headers.accept || ''));

  const HANG_CAP_SECONDS = 60;
  const rawFailAt = Math.max(opts.failAt ?? 3, 1);
  const defaultSeconds = mode === 'hang' ? HANG_CAP_SECONDS : (mode === 'timeout' ? 20 : (mode === 'fail' ? rawFailAt + 2 : 10));
  const seconds = mode === 'hang' ? HANG_CAP_SECONDS : Math.min(Math.max(opts.seconds ?? defaultSeconds, 1), 600);
  const failAt = mode === 'fail' ? Math.min(rawFailAt, seconds) : null;
  const failCode = mode === 'fail' ? Math.min(Math.max(opts.failCode ?? 2, 1), 255) : null;
  const pingMs = opts.pingMs === null ? 10000 : opts.pingMs;
  let stopPing = () => {};

  const stdoutLines = [];
  const stderrLines = [];
  const timers = [];
  let finished = false;

  const plan = [];
  if (mode === 'normal') {
    for (let t = 2; t <= seconds; t += 2) {
      const phase = MOCK_PHASES[Math.min(plan.length, MOCK_PHASES.length - 1)];
      plan.push({ at: t * 1000, stream: 'stdout', line: `[Mock] ${phase}` });
    }
  } else if (mode === 'fail') {
    if (failAt > 2) plan.push({ at: 2000, stream: 'stdout', line: '[Mock] 1/5 正在检查环境...' });
    plan.push({ at: failAt * 1000, stream: 'stderr', line: '[Mock] 模拟错误发生...' });
  } else if (mode === 'timeout') {
    if (seconds > 2) plan.push({ at: 2000, stream: 'stdout', line: '[Mock] 命令已发出，等待响应...' });
  }
  // mode === 'hang'：不产生业务日志，只由心跳维持连接

  const finishAt = seconds * 1000;
  const exitCode = mode === 'normal' ? 0 : (mode === 'fail' ? failCode : 124);

  const buildResult = () => {
    const durationMs = Date.now() - startedAt;
    if (mode === 'normal') {
      return {
        ok: true,
        output: '退出码: 0\n[Mock] 执行完毕',
        code: 0,
        stdout: '[Mock] 执行完毕',
        stderr: '',
        timedOut: false,
        error: null,
        cmd: 'mock-test',
        args: [...argv],
        durationMs,
        mock: true,
        mode
      };
    }
    const stdout = stdoutLines.join('\n');
    const stderr = stderrLines.join('\n');
    return {
      ok: false,
      output: '退出码: ' + exitCode + '\n' + stdout + '\n' + stderr,
      code: exitCode,
      stdout,
      stderr,
      timedOut: mode === 'timeout' || mode === 'hang',
      error: mode === 'hang' ? 'mock hang' : (mode === 'timeout' ? 'mock timeout' : 'mock failure'),
      cmd: 'mock-test',
      args: [...argv],
      durationMs,
      mock: true,
      mode,
      seconds,
      failAt,
      failCode
    };
  };

  if (wantStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    stopPing = startHeartbeat(res, pingMs);
    sseSend(res, 'start', {
      mock: true,
      mode,
      seconds,
      finishAtMs: finishAt,
      failAtMs: failAt ? failAt * 1000 : null,
      failCode,
      steps: plan.length,
      pingMs,
      hangCapMs: mode === 'hang' ? HANG_CAP_SECONDS * 1000 : null
    });
    if (mode === 'hang') log(`[Mock] --hang 开始：仅心跳（${pingMs}ms），最长 ${HANG_CAP_SECONDS} 秒`);
  } else {
    log(`[Mock] 非流式模式：mode=${mode} seconds=${seconds}，将在 ${seconds} 秒后一次性返回`);
  }

  for (const ev of plan) {
    timers.push(setTimeout(() => {
      if (finished) return;
      if (ev.stream === 'stderr') stderrLines.push(ev.line);
      else stdoutLines.push(ev.line);
      log(ev.line);
      if (wantStream) {
        sseSend(res, 'log', { line: ev.line, stream: ev.stream, elapsedMs: Date.now() - startedAt });
      }
    }, ev.at));
  }

  timers.push(setTimeout(() => {
    if (finished) return;
    finished = true;
    if (mode === 'fail') {
      stderrLines.push(`[Mock] 执行失败（模拟），退出码 ${failCode}`);
    }
    if (mode === 'timeout') {
      stderrLines.push(`[Mock] 模拟超时：${seconds} 秒内未返回（退出码 124）`);
    }
    if (mode === 'hang') {
      stderrLines.push('[Mock] 挂起超过 60 秒，强制结束（退出码 124）');
    }

    stopPing();
    const payload = buildResult();
    log(`[Mock] 结束：mode=${mode} code=${payload.code} timedOut=${payload.timedOut}（${payload.durationMs}ms）`);

    if (wantStream) {
      sseSend(res, 'result', payload);
      sseSend(res, 'done', { ok: payload.ok, code: payload.code, durationMs: payload.durationMs });
      res.end();
    } else {
      sendJson(res, 200, payload);
    }
  }, finishAt));

  // 只监听响应侧关闭（客户端中断）；不要监听 req close，避免请求体读完就被当成断连
  res.on('close', () => {
    finished = true;
    stopPing();
    for (const t of timers) clearTimeout(t);
    log('[Mock] 客户端断开：已清理计时器与心跳');
  });
}

// ---------------------------------------------------------------- 真实命令流式通道
// 真实命令（非 mock）在客户端请求 SSE 时，用 spawn 边执行边按行推送 stdout/stderr，
// 结束后再发 result/done；未请求 SSE 时仍走原 execFile 路径，行为不变。

function runGuardianStreaming(cmd, args, { timeout = EXEC_TIMEOUT_MS, onLine, onSpawn } = {}) {
  const argv = [GUARDIAN_MJS, cmd, ...args.map((a) => String(a))];
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const makeSink = (stream) => {
      let buf = '';
      return {
        push(chunk) {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (onLine) onLine(stream, line);
          }
        },
        flush() {
          if (buf.length && onLine) onLine(stream, buf);
          buf = '';
        }
      };
    };
    const outSink = makeSink('stdout');
    const errSink = makeSink('stderr');

    let child;
    try {
      child = spawn(NODE_BIN, argv, {
        cwd: PROJECT_ROOT,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      resolve({
        code: 1,
        stdout: '',
        stderr: `[guardian-ui] spawn 失败: ${err.message}`,
        timedOut: false,
        error: err.message,
        durationMs: Date.now() - startedAt
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { }
    }, timeout);

    if (typeof onSpawn === 'function') {
      try { onSpawn(child); } catch { }
    }

    const finish = (code, errorMessage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outSink.flush();
      errSink.flush();
      resolve({
        code: timedOut ? 124 : (typeof code === 'number' ? code : 1),
        stdout,
        stderr,
        timedOut,
        error: errorMessage ?? null,
        durationMs: Date.now() - startedAt
      });
    };

    child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      stdout += s;
      outSink.push(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      stderr += s;
      errSink.push(s);
    });
    child.on('error', (err) => {
      stderr += `[guardian-ui] 子进程错误: ${err.message}\n`;
      finish(1, err.message);
    });
    child.on('close', (code) => finish(code));
  });
}

async function streamRealExec(req, res, cmd, argv) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  sseSend(res, 'start', { mock: false, mode: 'real', cmd, args: argv });
  const startedAt = Date.now();
  const stopPing = startHeartbeat(res, 10000);

  let activeChild = null;
  let completed = false;

  // 客户端断开/页签关闭：终止真实 guardian 子进程，避免孤儿进程
  res.on('close', () => {
    stopPing();
    if (!completed && activeChild) {
      const pid = activeChild.pid;
      try {
        activeChild.kill('SIGTERM');
        log(`[exec] 客户端断开：已终止子进程 PID ${pid}（${cmd}）`);
      } catch (err) {
        log(`[exec] 客户端断开：终止子进程 PID ${pid} 失败：${err.message}`);
      }
    }
  });

  let run;
  try {
    run = await runGuardianStreaming(cmd, argv, {
      timeout: commandTimeout(cmd),
      onLine: (stream, line) => {
        sseSend(res, 'log', { line, stream, elapsedMs: Date.now() - startedAt });
      },
      onSpawn: (child) => { activeChild = child; }
    });
  } catch (err) {
    run = {
      code: 1,
      stdout: '',
      stderr: `[guardian-ui] 未捕获异常: ${err?.message ?? String(err)}`,
      timedOut: false,
      error: err?.message ?? String(err),
      durationMs: Date.now() - startedAt
    };
  }

  completed = true;
  activeChild = null;
  stopPing();

  const output = '退出码: ' + run.code + '\n' + run.stdout + '\n' + run.stderr;
  const payload = {
    ok: run.code === 0,
    output,
    code: run.code,
    stdout: run.stdout,
    stderr: run.stderr,
    timedOut: run.timedOut,
    error: run.error,
    cmd,
    args: argv,
    durationMs: run.durationMs,
    mode: 'real'
  };

  sseSend(res, 'result', payload);
  sseSend(res, 'done', { ok: payload.ok, code: payload.code, durationMs: payload.durationMs });
  if (!res.writableEnded) res.end();
}

// ---------------------------------------------------------------- 路由处理

async function handleStatus(req, res) {
  const [statusRun, listRun] = await Promise.all([
    runGuardian('status', [], { timeout: STATUS_TIMEOUT_MS }),
    runGuardian('list', [], { timeout: STATUS_TIMEOUT_MS })
  ]);

  const statusParsed = parseJsonLoose(statusRun.stdout);
  const listParsed = parseJsonLoose(listRun.stdout);

  const errors = [];
  if (!statusParsed.ok) {
    errors.push({ source: 'status', code: statusRun.code, message: statusParsed.error, stderr: statusRun.stderr });
  } else if (statusRun.code !== 0) {
    errors.push({ source: 'status', code: statusRun.code, message: 'status 退出码非 0', stderr: statusRun.stderr });
  }
  if (!listParsed.ok) {
    errors.push({ source: 'list', code: listRun.code, message: listParsed.error, stderr: listRun.stderr });
  } else if (listRun.code !== 0) {
    errors.push({ source: 'list', code: listRun.code, message: 'list 退出码非 0', stderr: listRun.stderr });
  }

  const listValue = listParsed.ok ? listParsed.value : null;
  const latestSnapshot = pickLatestSnapshot(listValue?.snapshots);

  const payload = {
    ok: statusParsed.ok,
    generatedAt: new Date().toISOString(),
    // status 主体：state 摘要（version/activeOperation/safe/culprit/instance/drift）
    status: statusParsed.ok ? statusParsed.value : null,
    // list 提取的 lkg：{ label, digest } 或 null
    lkg: listValue?.lkg ?? null,
    latestSnapshot,
    store: listValue?.store ?? null,
    transactions: listValue?.transactions ?? [],
    profile: listValue?.profile ?? null,
    errors,
    // 便于前端/排障排查解析失败原因
    raw: {
      statusStdout: statusParsed.ok ? undefined : statusRun.stdout,
      listStdout: listParsed.ok ? undefined : listRun.stdout,
      statusStderr: statusRun.stderr || undefined,
      listStderr: listRun.stderr || undefined
    }
  };

  sendJson(res, statusParsed.ok ? 200 : 502, payload);
}

async function handleExec(req, res) {
  const body = await readBody(req);
  if (!body.ok) {
    sendJson(res, 400, { ok: false, error: body.error, output: `[guardian-ui] ${body.error}` });
    return;
  }

  const payload = body.value;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象 { cmd, args }' });
    return;
  }

  const rawCmd = payload.cmd;
  if (typeof rawCmd !== 'string' || !rawCmd.trim()) {
    sendJson(res, 400, { ok: false, error: 'cmd 必须是非空字符串' });
    return;
  }

  let args;
  if (payload.args === undefined || payload.args === null) {
    args = [];
  } else if (Array.isArray(payload.args)) {
    if (payload.args.some((a) => a !== null && typeof a === 'object')) {
      sendJson(res, 400, { ok: false, error: 'args 只允许字符串/数字/布尔等标量' });
      return;
    }
    args = payload.args.map((a) => String(a));
  } else {
    sendJson(res, 400, { ok: false, error: 'args 必须是字符串数组' });
    return;
  }

  // 允许 "safe on" 这种把子命令写在 cmd 里的写法。
  const cmdTokens = rawCmd.trim().split(/\s+/);
  const cmd = cmdTokens[0];
  const argv = [...cmdTokens.slice(1), ...args];

  // Mock 通道：命中后直接返回模拟结果，绝不执行 execFile。
  if (cmd === 'mock-test') {
    const mockArgs = argv.length ? ' ' + argv.join(' ') : '';
    log(`exec: mock-test${mockArgs}（Mock 通道，不执行 guardian）`);
    handleMockExec(req, res, argv);
    return;
  }

  // 真实命令的流式通道：请求头带 Accept: text/event-stream 时逐行推送 stdout/stderr。
  const wantStream = /text\/event-stream/i.test(String(req.headers.accept || ''));
  if (wantStream) {
    log(`exec(stream): ${cmd} ${argv.join(' ')}`);
    streamRealExec(req, res, cmd, argv);
    return;
  }

  log(`exec: ${cmd} ${argv.join(' ')}`);

  // 失败也正常返回（ok:false + output 含 stderr），不让异常冒泡。
  let run;
  try {
    run = await runGuardian(cmd, argv, { timeout: commandTimeout(cmd) });
  } catch (err) {
    run = {
      code: 1,
      stdout: '',
      stderr: `[guardian-ui] 未捕获异常: ${err?.message ?? String(err)}`,
      timedOut: false,
      error: err?.message ?? String(err),
      durationMs: 0
    };
  }

  const output = '退出码: ' + run.code + '\n' + run.stdout + '\n' + run.stderr;

  sendJson(res, 200, {
    ok: run.code === 0,
    output,
    code: run.code,
    timedOut: run.timedOut,
    stdout: run.stdout,
    stderr: run.stderr,
    error: run.error,
    cmd,
    args: argv,
    durationMs: run.durationMs
  });
}

/** GET / → 返回 ui/index.html；不存在则 404。 */
async function handleIndex(req, res) {
  let content;
  try {
    content = await fsp.readFile(INDEX_HTML);
  } catch (err) {
    if (err.code === 'ENOENT') {
      sendText(res, 404, `404 Not Found — 未找到 ${INDEX_HTML}\n（第 2 步将生成前端 index.html）\n`,
        'text/plain; charset=utf-8');
      return;
    }
    sendText(res, 500, `500 Internal Server Error — 读取 index.html 失败: ${err.message}\n`);
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': content.length,
    'Cache-Control': 'no-store'
  });
  if (req.method === 'HEAD') res.end();
  else res.end(content);
}

/** /api/env → 当前运行模式与后端目标路径 */
function handleEnv(req, res) {
  sendJson(res, 200, {
    mode: SANDBOX_MODE ? 'sandbox' : 'production',
    sandbox: SANDBOX_MODE,
    port: PORT,
    host: HOST,
    guardian: GUARDIAN_MJS,
    cwd: PROJECT_ROOT,
    config: SANDBOX_MODE ? SANDBOX_CONFIG : path.join(ROOT_DIR, 'config.json'),
    state: SANDBOX_MODE ? SANDBOX_STATE : path.join(ROOT_DIR, 'state.json'),
    serverPid: process.pid
  });
}

/** /api/ 下的未知路由 → JSON 404。 */
function handleApiNotFound(res, pathname) {
  sendJson(res, 404, { ok: false, error: `未知 API 路由: ${pathname}` });
}

// ---------------------------------------------------------------- HTTP 服务

const server = http.createServer(async (req, res) => {
  let pathname = '/';
  try {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
    pathname = url.pathname;
  } catch {
    pathname = '/';
  }

  // 允许前端跨端口调试（例如 5500 预览）。
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname === '/' || pathname === '/index.html') {
        await handleIndex(req, res);
        return;
      }
      if (pathname === '/api/status') {
        await handleStatus(req, res);
        return;
      }
      if (pathname === '/api/env') {
        handleEnv(req, res);
        return;
      }
      if (pathname.startsWith('/api/')) {
        handleApiNotFound(res, pathname);
        return;
      }
      // 其余静态资源按 index.html 同目录解析（路径穿越防护）。
      const rel = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
      const target = path.resolve(SERVER_DIR, rel);
      if (!target.startsWith(SERVER_DIR + path.sep)) {
        sendText(res, 403, '403 Forbidden\n');
        return;
      }
      try {
        const data = await fsp.readFile(target);
        const ext = path.extname(target).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] ?? 'application/octet-stream',
          'Content-Length': data.length,
          'Cache-Control': 'no-store'
        });
        res.end(data);
      } catch (err) {
        if (err.code === 'ENOENT') sendText(res, 404, '404 Not Found\n');
        else sendText(res, 500, `500 Internal Server Error: ${err.message}\n`);
      }
      return;
    }

    if (req.method === 'POST') {
      if (pathname === '/api/exec') {
        await handleExec(req, res);
        return;
      }
      if (pathname === '/api/status') {
        // 允许前端用 POST 触发一次状态刷新，行为与 GET 相同。
        await handleStatus(req, res);
        return;
      }
      if (pathname.startsWith('/api/')) {
        handleApiNotFound(res, pathname);
        return;
      }
      sendText(res, 405, '405 Method Not Allowed\n');
      return;
    }

    sendText(res, 405, '405 Method Not Allowed\n');
  } catch (err) {
    // 顶层兜底：任何未预期异常都只回 500，不终止进程。
    log('ERROR', '未处理异常:', err?.stack ?? err);
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: `服务内部错误: ${err?.message ?? String(err)}` });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

// 子进程/服务级异常兜底，避免宿主终端里直接崩掉。
process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] uncaughtException:`, err?.stack ?? err);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[${new Date().toISOString()}] unhandledRejection:`, reason);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[guardian-ui] 端口 ${PORT} 已被占用，请先关闭占用进程（或改 PORT 常量）。`);
  } else {
    console.error('[guardian-ui] 服务启动失败:', err?.message ?? err);
  }
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  log(`DSH Guardian UI 后端已启动: http://${HOST}:${PORT}`);
  log(`模式:     ${SANDBOX_MODE ? '沙箱 sandbox（不会影响真实 DSH）' : '生产 production'}`);
  log(`node:     ${NODE_BIN}`);
  log(`guardian: ${GUARDIAN_MJS} (${fs.existsSync(GUARDIAN_MJS) ? '存在' : '缺失!'})`);
  log(`cwd:      ${PROJECT_ROOT}`);
  log(`index:    ${INDEX_HTML} (${fs.existsSync(INDEX_HTML) ? '存在' : '缺失 → GET / 将返回 404'})`);
  log(`路由: GET / | GET /api/env | GET /api/status | POST /api/exec`);
  if (SANDBOX_MODE && (!fs.existsSync(GUARDIAN_MJS) || !fs.existsSync(SANDBOX_CONFIG))) {
    log('WARN', '沙箱尚未初始化：请先运行 `node ui/sandbox-init.mjs` 或使用 start-ui-sandbox.bat。');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`收到 ${sig}，正在关闭服务...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
