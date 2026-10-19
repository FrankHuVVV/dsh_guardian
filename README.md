# DSH Guardian v5 · 使用手册

> DSH Guardian 是 DeepSeek Harness 桌面客户端的**守护与自愈套件**：装插件前自动留快照、装完自动验证、坏了自动回滚，环境起不来时能一条命令回到最近的健康状态。

- 适配：DSH 桌面客户端 **0.2.1-rc.2**（Electron 托管的 `desktop` profile）
- 运行环境：Windows / Node ≥ 22 / guardian 本身**零第三方依赖**
- 快照模型：内容寻址 `_store` + exact 字节级恢复（默认），`reproducible` 仅作可选的省空间模式

---

## 1. 项目简介

一句话：**DSH Guardian = 让 DSH 的每一次插件变更都可回退、每一次启动失败都能自愈的守护套件。**

它把 DSH 的完整运行闭包（profile 配置、`node_modules`、共享依赖、file:/link: 目标、`~/.dsh/{mcp,storages,.agent-presets,settings}`、客户端指纹）做成内容寻址快照，任何一次改动都有 before 边界；启动后还会做插件加载验证，避免「装上了但插件没起来」被误判为成功。

---

## 2. 核心前提：必须在管理员权限下运行

> **必须使用管理员权限的终端 / 以管理员身份启动托盘**。
> 原因：`DeepSeek Harness.exe` 清单里带 **RUNASADMIN** 标志（见 `SAFE-MODE.md`），任何会拉起客户端的命令（`guard` / `restart` / `repair` / `restore`）如果不是从提权进程发起，会被 UAC 拦掉或表现为「启动超时」的假失败。

```powershell
# 正确的打开方式：开始菜单搜索 PowerShell / Windows Terminal → 右键「以管理员身份运行」
cd D:\dsh_plugin\dsh_guardian
node --version          # 需要 ≥ 22
node bin/guardian.mjs doctor
```

补充约定：

| 事项 | 要求 |
|---|---|
| 会拉起客户端的命令 | 必须管理员终端 |
| 只读命令（`status` / `list` / `doctor` / `drift` / `preflight`） | 普通权限即可（`doctor` 仍会取锁写 state） |
| 托盘 / 开机自启 | 快捷方式以管理员身份创建；自启后托盘继承权限 |
| 沙箱（3082） | 不需要管理员（假客户端是 notepad.exe） |

---

## 3. 日常启动

### 3.1 通过 UI（端口 3081，推荐）

```powershell
ui\start-ui.cmd          # 打开状态窗口；后端由托盘常驻
# 浏览器： http://127.0.0.1:3081/
```

UI 里点 **「守护启动」**（实际命令 `guard`）即可：它会依次做 recover → drift 检查 → preflight → 启动客户端 → 端口/HTTP 稳定等待 → 插件加载验证，最后更新 last-known-good。

### 3.2 通过终端（一次性、可脚本化）

```powershell
# 管理员终端
node bin/guardian.mjs guard --detach      # 启动并验证，完成后脱离
node bin/guardian.mjs status              # 看 safe / drift / 实例端口
node bin/guardian.mjs ps                  # 实例 PID 与后代进程
node bin/guardian.mjs guard --no-start    # 只体检当前实例，不启动/不停止
```

启动成功的判定是「进程树持有的 127.0.0.1 端口 + 任意 HTTP 响应（含 401）+ settleMs 内保持稳定」，而不是「进程还在」。

---

## 4. 装插件

### 4.1 通过 UI 走事务（推荐）

UI →「控制」区：

| 按钮 | 实际命令 | 适用 |
|---|---|---|
| 安装插件 | `plugin-add <spec>` | 市场包 / npm 包（如 `dsh-mindmap@0.14.1`） |
| 链接本地插件 | `plugin-link <路径>` | 本地目录，`link:` 依赖 |
| 移除插件 | `plugin-remove <依赖名>` | 从 profile 依赖中移除 |

每个操作都是**事务**：`before` 快照 → 安装 → 重新盘点闭包 → preflight → 启动验证 → 插件加载验证 → `after` 快照 → committed；任一步失败自动回滚到 before 并重启验证。

### 4.2 通过命令行

```powershell
node bin/guardian.mjs plugin-add dsh-mindmap@0.14.1
node bin/guardian.mjs plugin-link  D:\Github\my-plugin
node bin/guardian.mjs plugin-insert .\local-plugin        # 纯 patch 插入，不装包
node bin/guardian.mjs plugin-remove dsh-mindmap

node bin/guardian.mjs transactions                        # 事务列表（含 drift）
node bin/guardian.mjs plugin-restore <txid>               # 回到该事务之前/之后
```

> ⚠️ **在 DSH UI 里装插件、或直接 `pnpm add`，不会经过事务**。
> 这类变更由 `drift` 兜底：下次 `guard` 检出闭包变化——健康就采纳成 `adopted-*` 新基线，坏了就回滚到装之前的 committed 快照。所以「在别处装完插件，记得跑一次 `guard`」。

---

## 5. 发生故障怎么办（决策树）

固定顺序：**doctor → preflight → recover → restore last-known-good**。

```text
DSH 起不来 / 插件报错 / 页面白屏
│
├─ 1) node bin/guardian.mjs doctor
│     退出 0 = 健康；1 = WARN；2 = FAIL（闭包/版本/配置键缺失）
│     同时输出 store 审计：{ blobs, totalMb, orphans, emptyShards, gcOnPrune }
│
├─ 2) node bin/guardian.mjs preflight
│     不启动客户端，只验证闭包可解析（file:/link: 目标、patch 引用、版本/asar）
│     0 = OK；2 = FAIL
│
├─ 3) node bin/guardian.mjs status
│     activeOperation 未完成 → node bin/guardian.mjs recover
│     （崩溃续跑：按 phase 续做或回滚，不会停在半状态）
│
├─ 4) node bin/guardian.mjs drift
│     0 = clean；1 = 有 drift（附 added/changed/removedPaths）；2 = 无法比对
│
└─ 5) node bin/guardian.mjs restore last-known-good
      停客户端 → 校验 manifest/全部 blob → 建 pre-restore 快照 → exact 物化 → 重算 digest → 启动验证
      退出 0 成功；3 失败（保留现场与 pre-restore，不覆盖 before）
```

救不回来时：

```powershell
node bin/guardian.mjs repair      # 事务优先 → drift → 最近 verified 快照，最后写 repair-report
```

| 退出码 | 含义 |
|---:|---|
| 0 | 成功 / 环境健康 |
| 1 | `drift` 检出漂移 |
| 2 | 可恢复失败（回滚完成、事务未提交、健康检查未过） |
| 3 | exact 恢复或回滚校验失败，现场已保留，需要人工介入 |

---

## 6. 沙箱演练

```powershell
.\start-ui-sandbox.bat
# 浏览器： http://127.0.0.1:3082/
```

用途与边界：

- **3082 是沙箱 UI**，与 3081 的生产 UI 互不影响；沙箱是 `sandbox\config.json`，`launch` 指向 `notepad.exe`，`dshHome`/`profileDir` 都在 `sandbox\` 内，**完全不碰 `~/.dsh`**。
- 随便造：装假插件、改 patch、`snapshot` / `restore` / `prune` / `guard` 都可以跑，崩了重来即可。
- 每次启动前 `ui\sandbox-init.mjs` 会把沙箱**重置为干净基线**（清 `backups`、`transactions`、`state.json`，同步最新 `bin\guardian.mjs`）；`--reset` 可从零重建。
- 想验证 prune 不会误删 blob：`pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\sandbox-prune-regression.ps1`（自动造快照、删快照、GC、再 restore 校验 digest）。
- 需要更真实的夹具：`node ui\sandbox-init.mjs --fixture-home=copy`（从 live `~/.dsh` 复制 mcp/storages/plugins）。

---

## 7. 维护

### 7.1 自动：每天 03:00 静默清理

托盘（`ui\guardian-tray.ps1`）的 5 秒看护循环里带一个调度门控：

```text
每天 03:00–03:10 窗口内，且今天还没跑过
  → 检查是否与用户操作冲突（.guardian.lock / state.activeOperation / 其它会改环境的 guardian 进程）
      → 冲突：只写日志并跳过，5 秒后下一轮重试
      → 空闲：执行 node bin\guardian.mjs prune --vacuum
  → 结果只写 logs\prune-task.log（不弹窗）；成功才写 logs\.prune-last 标记今天已跑
```

只读命令（`status`/`list`/`drift`/`preflight`/…）**不算冲突**，所以 UI 页面开着也不会把清理饿死。

### 7.2 手动：UI 按钮 / 托盘菜单 / 命令行

- UI →「快照」区 → **🧹 清理无用快照 (prune)**（SSE 流式输出释放空间）
- 托盘右键 →「清理无用快照（prune --vacuum）」
- 终端：

```powershell
node bin/guardian.mjs prune --dry-run              # 只看计划，不动磁盘
node bin/guardian.mjs prune --vacuum               # 真删 + 清空分片目录
node bin/guardian.mjs prune --strict               # 忽略 config.pruneKeepLabels
node bin/guardian.mjs prune --keep snap-a          # 额外保护某个标签
```

### 7.3 保留策略

```text
永不删 : last-known-good、manual-baseline-*、meta 不可读的快照
保留最新: config.keepLkg 个 adopted-*          （默认 3）
保留最新: config.keepTransactions 个 before/after-add-*（默认 20）
永不删 : 未完成事务 before/after 引用的快照
永不删 : config.pruneKeepLabels / --keep 指定的标签
其余   : 删除目录 → 回收不再被任何保留 meta 引用的 blob → 清空分片
```

### 7.4 体检

```powershell
node bin/guardian.mjs doctor      # store: { blobs, totalMb, orphans, orphanMb, emptyShards, gcOnPrune }
node bin/guardian.mjs list        # 快照 / 事务 / LKG / store 体积
```

`guard` 成功提交后，若 `config.storeGcOnPrune = true`，也会自动做一次同样的保留+回收（失败只记 WARN，不影响 guard 结果）。

---

## 8. 三大纪律

1. **不要在 DSH 里跑 restore。**
   `restore` 会先停客户端再重建闭包——在 DSH 自己的会话里执行，等于把正在运行的环境连人带椅子端掉。永远在**独立的管理员终端**或 **Guardian UI（3081）** 里操作。

2. **不要手动删 `backups\_store`。**
   所有快照都只存 `meta.json`，内容全在 `_store` 的内容寻址 blob 里；删掉即全部快照失效，且无法重建。要清理就走 `prune`（它会先删快照、再只回收没人引用的 blob）。

3. **restore 前先看 `config.json`。**
   确认 `profileDir` / `dshHome` / `launch` / `expectedClientVersion` / `blockOnClientMismatch`：恢复用的是**快照那一刻的**依赖树与配置，历史快照可能带着旧模型设置或旧插件，覆盖前先想清楚会不会把你刚改的东西退回去。

---

## 附录：目录与关键文件

```text
D:\dsh_plugin\dsh_guardian\
├── bin\guardian.mjs            # 全部 CLI（doctor/preflight/snapshot/restore/prune/guard/...）
├── config.json                 # 环境与策略（profileDir、launch、keepLkg、keepTransactions…）
├── state.json                  # activeOperation / safe / drift / instance
├── backups\
│   ├── _store\<ab>\<sha256>    # 内容寻址 blob（只读，勿手删）
│   ├── last-known-good\        # 最近良好快照
│   └── <label>\meta.json       # 各快照清单
├── transactions\               # 事务与 drift 记录
├── logs\                       # guardian 日志 / prune-task.log / 报告
├── ui\                         # 3081 生产 UI、托盘、lib、沙箱初始化
├── sandbox\                    # 3082 沙箱（假客户端，可随便造）
├── fixtures\sandbox\root\      # KB 级可重建夹具（--root 用）
└── scripts\                    # 验收脚本 / 沙箱 prune 回归 / 夹具重建
```

快照/事务状态机（简版）：

```text
prepared → stopped → before-snapshot-created → installing → closure-inventoried
        → preflight-passed → starting → load-verified → committed
失败 → rollback-stopping → restoring-before → restore-verified → restarting-before → rolled-back
     （恢复失败停在 rollback-failed，退出 3，保留现场）
```
