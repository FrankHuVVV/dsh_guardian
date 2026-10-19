**[English](README_EN.md) | 简体中文**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white)](#)

# DSH Guardian v5 · 使用手册

> DSH Guardian 是 DeepSeek Harness 桌面客户端的**守护与自愈套件**：装插件前自动留快照、装完自动验证、坏了自动回滚，环境起不来时能一条命令回到最近的健康状态。

- 适配：DSH 桌面客户端 **0.2.1-rc.2**（Electron 托管的 `desktop` profile）
- 运行环境：Windows / Node ≥ 22 / guardian 本身**零第三方依赖**
- 快照模型：内容寻址 `_store` + exact 字节级恢复（默认），`reproducible` 仅作可选的省空间模式
- 许可：[MIT License](LICENSE) © 2026 FrankHuVVV

---

## 0. 克隆后第一步：填本机配置

仓库里的 `config.json` 是**带占位符的模板**（不含任何个人路径），可以安全公开。真实路径写进 `config.local.json`——它被 `.gitignore` 排除，guardian 启动时会把两个文件**深合并、本地键优先**。这样 `git pull` 永远不会和你的本机配置冲突。

```powershell
git clone https://github.com/FrankHuVVV/dsh_guardian.git
cd dsh_guardian

# 方式 A（推荐）：只写本机覆盖，不动入库的模板
'{"dshHome":"<YOUR_DSH_HOME>","profileDir":"<YOUR_PROFILE_DIR>","launch":["<YOUR_DSH_EXE>"]}' | Set-Content config.local.json -Encoding UTF8

# 方式 B：直接改 config.json（注意 git pull 可能与你冲突）
notepad config.json
```

| 占位符 | 含义 | 本机示例形态 |
|---|---|---|
| `<YOUR_DSH_HOME>` | DSH 数据根目录 | `C:\Users\<you>\.dsh` |
| `<YOUR_PROFILE_DIR>` | profile 目录 | `<YOUR_DSH_HOME>\profiles\desktop` |
| `<YOUR_DSH_DIR>` | 客户端安装目录 | `...\Programs\DeepSeek Harness` |
| `<YOUR_DSH_EXE>` | 客户端可执行文件 | `<YOUR_DSH_DIR>\DeepSeek Harness.exe` |
| `<YOUR_CLIENT_VERSION>` | 客户端版本 | `0.2.1-rc.2` |
| `<YOUR_SOURCE_PLUGIN>` | 本地 file: 插件源码目录 | 你的插件仓库路径 |
| `<YOUR_LINK_PLUGIN>` | link: 插件源码目录 | 你的插件仓库路径 |
| `<YOUR_SHARED_DEPS>` | 共享依赖根 | `<YOUR_DSH_HOME>\profiles\node_modules` |

> `config.local.json` 只需要写你要覆盖的键；其余沿用模板。填完跑 `node bin/guardian.mjs doctor`，它会逐项告诉你还缺什么。

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
cd <GUARDIAN_ROOT>
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

### 7.1 自动：每天首次开机后、无任务运行时静默清理（补跑模式）

托盘（`ui\guardian-tray.ps1`）的 5 秒看护循环里带一个调度门控，**不绑定钟点**，只看「今天是否已经成功清理过」：

```text
每 5 秒：
  logs\.prune-last 缺失 / 日期早于今天（或内容损坏）→ 今天还没清理
    → 检查是否与用户操作冲突（.guardian.lock / state.activeOperation / 其它会改环境的 guardian 进程）
        → 冲突：只记一条 DEFER 日志（最多 5 分钟一条），下一轮继续试
        → 空闲：执行 node bin\guardian.mjs prune --vacuum
    → 成功：写 logs\.prune-last = 今天日期，当天不再执行
    → 失败：记 ERROR，30 分钟后重试（不会每 5 秒刷屏）
```

因为按「今天是否清理过」判断而不是按钟点，**不管几点开机都能补上**：早上 10:00 开机、托盘拉起的第一个空闲轮次就会在后台悄悄清理一次，清理完当天不再执行。
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

### 7.5 改完脚本之后（编码 + 重启托盘）

所有 `.ps1` 必须保存为 **UTF-8 with BOM**：托盘由 `ui\guardian-tray.vbs` 用 `powershell.exe`（5.1）启动，它会把无 BOM 的 UTF-8 按 ANSI 解码——中文变乱码、某些字节还会吃掉引号，导致整脚本语法错误（表现为托盘静默不启动）。任何编辑器/批量改写都可能把 BOM 写丢，所以改完跑一次：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-ps-encoding.ps1       # 只检查
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-ps-encoding.ps1 -Fix  # 补 BOM
```

托盘脚本改动后需要重启托盘才生效（后端不受影响）：

```powershell
Get-Process -Id (Get-Content logs\tray.pid -Raw).Trim() | Stop-Process -Force
wscript ui\guardian-tray.vbs
```

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
<GUARDIAN_ROOT>\
├── bin\guardian.mjs            # 全部 CLI（doctor/preflight/snapshot/restore/prune/guard/...）
├── config.json                 # 配置模板（占位符，入库）
├── config.local.json           # 本机真实配置覆盖（.gitignore 排除，不入库）
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

---

## License

[MIT](LICENSE) © 2026 **FrankHuVVV**

任何人都可以自由使用、修改、分发本软件（含商业用途），只需保留版权声明与许可声明。本软件按「现状」提供，不附带任何明示或暗示的担保；用它做环境回滚前，请先确认你已理解快照与恢复的语义（见 §8 三大纪律）。

