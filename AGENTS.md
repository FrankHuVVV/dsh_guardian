# agents.md — 自研 DSH 完整插件运行环境快照与恢复器（v5）

> 适配目标：DSH 桌面客户端 **0.2.1-rc.2**（Electron 托管的 `desktop` profile）
> 运行环境：Windows / Node ≥ 22 / guardian 本身零第三方依赖
> 核心目标：**每添加一个插件都可回退**——无论通过 `plugin-add`、DSH UI、市场还是裸 pnpm；失败时恢复到添加前的完整可运行环境。
> 存储模型：内容寻址 + 硬链接去重；恢复默认 `exact`；`reproducible` 仅作可选空间模式。

v4 建立了事务与 exact 快照骨架，但覆盖率仍有三处漏洞：UI/裸 pnpm 安装不进事务、快照无去重、`~/.dsh` 下插件写入目录不在闭包内。v5 补齐这三处，并加入崩溃续跑与插件加载验证。

---

## 0. 目标、不变量与变更摘要

### 0.1 成功判定

任意一种安装方式（`plugin-add` / `plugin-link` / `plugin-insert` / DSH UI / 市场 / 裸 pnpm）之后，只要客户端出现启动失败或运行异常，都必须能恢复到该次安装之前的完整运行环境：

```text
A 安装成功
B 安装成功
C 安装（任意方式）失败或导致异常
→ 恢复后：A、B 保留；C 的 package/lockfile/node_modules/patch/源码/link/MCP 注册全部消失
→ 客户端以 C 安装前的依赖树与配置启动成功
```

### 0.2 v4 → v5

| # | v4 | v5 | 原因 |
|---|---|---|---|
| 1 | 事务只覆盖 `plugin-add` | 新增 `drift` 检测 + 自动采纳 | UI/裸 pnpm 安装无事务边界，无法回退 |
| 2 | 全量复制，64MB/次，20 次约 3.8GB | 内容寻址 + 硬链接去重 | 本机 `node_modules` 64.0MB / 8032 文件，全量不可持续 |
| 3 | runtimeClosure 仅 profileDir | 扩展 `~/.dsh/{mcp,storages,.agent-presets,settings}` | 插件安装常写这些，回滚后残留会导致二次故障 |
| 4 | 崩溃只报 WARN | 状态机续跑/回滚 | 断电停在半恢复会毁掉现场 |
| 5 | 只验证端口存活 | 追加插件加载验证 | 插件报错但服务照起，会误判 committed |
| 6 | 无 `plugin-insert` | 新增纯 patch 路径插件事务 | 本地路径插件无包安装动作 |
| 7 | client-mismatch 仅记录 | 阻断 exact restore | 客户端升级后用旧依赖树覆盖会制造更难查的故障 |

### 0.3 硬性不变量

1. **全路径可回退**：任何改变 `runtimeClosure` 的操作都必须有 before 边界；无 before 边界的变更由 drift 机制事后补边界。
2. **先停再快照**：快照/恢复前停止 Electron 并确认进程树与端口释放。
3. **快照不可变**：快照内容只读；`_store` 中的 blob 不允许原地改写。
4. **恢复先校验后替换**：manifest、哈希、链接类型任一不符即停止，不用不完整快照覆盖现场。
5. **最多两次启动**：原状态一次，回滚后一次。
6. **完整闭包**：profile 配置 + profile node_modules + 共享依赖 + file/link 目标 + `~/.dsh` 插件写入目录 + 链接类型。
7. **exact 默认**：字节级内容 + 目录清单 + symlink/junction 目标。
8. **客户端锁定**：记录 `app.asar` 哈希；不符时禁止 exact restore 覆盖。
9. **源码安全**：普通 restore 不删快照后新增源码；事务回滚只删本事务 manifest 明确新增的路径。
10. **插件语义**：`disable` 写 `disabled: true`；`revert` 删 override；两者不可互换。
11. **崩溃可续**：未完成事务下次启动必须续跑或回滚，不允许停在半状态。
12. **模型只提醒不切换**：只输出下一步模型提醒。

---

## 1. 本机环境与目录

### 1.1 本机事实

| 项 | 实测值 |
|---|---|
| 客户端 | DSH 0.2.1-rc.2 |
| profile | `desktop` |
| profileDir | `<YOUR_PROFILE_DIR>` |
| 启动方式 | `<YOUR_DSH_DIR>\DeepSeek Harness.exe` |
| CLI 限制 | `dsh --profile desktop` 被 Electron 管理模式拒绝 |
| 端口 | 动态；当前观测 40726 |
| HTTP 根路径 | 返回 401；任意 HTTP 响应即服务层已响应 |
| Node | v24.19.0 |
| profile `node_modules` | 64.0 MB / 8,032 文件（hoisted，`.pnpm` 近乎空） |
| `~/.dsh/mcp` | 3.03 MB / 38 文件 |
| `~/.dsh/storages` | 1.77 MB / 59 文件 |
| `~/.dsh/.agent-presets` | 0.03 MB / 3 文件 |
| 本地 file 插件 | `<YOUR_SOURCE_PLUGIN>` |
| link 插件 | `<YOUR_LINK_PLUGIN>` |

### 1.2 目录结构

```text
<GUARDIAN_ROOT>\
├── AGENTS.md
├── config.json
├── state.json                  # version/activeOperation/safe/culprit/instance/drift
├── .guardian.lock
├── bin\guardian.mjs
├── fixtures\broken-plugin\
├── transactions\
│   ├── <txid>.json
│   └── drift-<ts>.json
├── backups\
│   ├── _store\                 # 内容寻址 blob（sha256），只读
│   │   └── <sha256 前2位>\<sha256>
│   ├── <ts>-before-add-<plugin>-<txid>\meta.json
│   ├── <ts>-after-add-<plugin>-<txid>\meta.json
│   ├── <ts>-adopted-<txid>\meta.json
│   ├── disabled-entries\
│   └── last-known-good\meta.json
└── logs\
    ├── guardian-YYYYMMDD.log
    ├── intent.json
    └── repair-report-<ts>.md
```

快照目录只存 `meta.json`，不复制内容；内容在 `_store` 中按哈希共享。

### 1.3 config.json 模板

```json
{
  "dshHome": "<YOUR_DSH_HOME>",
  "profile": "desktop",
  "profileDir": "<YOUR_PROFILE_DIR>",
  "launchMode": "electron-exe",
  "launch": ["<YOUR_DSH_DIR>\\DeepSeek Harness.exe"],
  "expectedClientVersion": "0.2.1-rc.2",
  "portMode": "dynamic",
  "port": 0,
  "startTimeoutMs": 90000,
  "settleMs": 15000,
  "probeStartTimeoutMs": 45000,
  "probeSettleMs": 8000,
  "maxBisectMs": 300000,
  "singleInstance": "kill-first",
  "killGraceMs": 5000,
  "lockTimeoutMs": 600000,
  "snapshotMode": "exact",
  "snapshotStorage": "content-addressed-hardlink",
  "storeDir": "backups\\_store",
  "storeGcOnPrune": true,
  "trackedFiles": [
    "cordis.patch.yml",
    "package.json",
    "cordis.yml",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml"
  ],
  "trackedRuntimePaths": ["node_modules", ".plugin-manager", ".dsh-market"],
  "trackedSourcePaths": [
    "<YOUR_SOURCE_PLUGIN>",
    "<YOUR_LINK_PLUGIN>"
  ],
  "sourceInclude": ["**/*"],
  "sourceExclude": ["node_modules", ".git", ".cache", ".pnpm-store", "dist", "cache", "*.log"],
  "dshHomeTrackedPaths": [
    "mcp",
    "storages",
    ".agent-presets",
    "settings.yaml",
    "settings.yaml.imported"
  ],
  "dshHomeExclude": [
    "sessions",
    "cache",
    "dsh-runtimes",
    "attachments",
    "llm-deepseek",
    ".credentials.yaml"
  ],
  "sharedDependencyRoots": ["<YOUR_SHARED_DEPS>"],
  "driftPolicy": "adopt-if-healthy",
  "crashPolicy": "resume",
  "verifyPluginLoad": true,
  "blockOnClientMismatch": true,
  "keepTransactions": 20,
  "keepLkg": 3,
  "pruneKeepLabels": ["group3-base", "snap-a", "snap-b"]
}
```

`pruneKeepLabels` 是 `prune` 的额外保护名单：这些标签的快照不会被删除（`--strict` 时忽略，只用 `--keep` 显式指定）。

公开仓库里的 `config.json` 是占位符模板；本机真实路径写在 `config.local.json`（已被 `.gitignore` 排除）。`loadConfig()` 会把两者深合并，本地键优先，因此 `git pull` 不会覆盖本机配置。

`dshHomeExclude` 中的 `.credentials.yaml` 只记录哈希，不复制内容；`sessions`、`attachments` 属用户数据，不纳入回滚。

---

## 2. runtimeClosure

`runtimeClosure` 由 `discoverRuntimeClosure()` 实算，禁止只读固定列表。

### 2.1 纳入对象

1. **profile 文件**：`trackedFiles`。
2. **profile 依赖树**：`profileDir/node_modules`（普通目录、`.bin`、`.modules.yaml`、`.pnpm-workspace-state-v1.json`、`.pnpm`）。
3. **共享依赖**：从真实路径与链接递归解析到 `sharedDependencyRoots` 的包，每条记录 `owners`（profile / 事务 / 其他 profile）；恢复只删本 profile 且 before 中不存在的条目。
4. **file: 依赖**：真实目标目录、package.json、入口、依赖闭包。
5. **link: 依赖**：目标路径、链接类型（symlink/junction）、纳入清单。
6. **patch 引用**：`insert[].name`、行 `name`、相对/绝对路径、包名。
7. **`~/.dsh` 插件写入目录**：`mcp`、`storages`、`.agent-presets`、`settings.yaml*`（凭据文件只记哈希）。
8. **插件管理状态**：`.plugin-manager`（含 `logs/operation-*` 的完成/失败标记）。
9. **市场状态**：`.dsh-market`。
10. **客户端指纹**：版本、安装路径、`app.asar` SHA-256。
11. **运行时版本**：Node、pnpm、平台、架构、启动参数。

### 2.2 只记录不复制

```text
下载缓存 / .cache / .pnpm-store（除非闭包实际依赖）
日志 / 临时文件 / session / attachments / 凭据内容
Electron 安装本体
```

闭包实际依赖缓存内容时写入 `externalDependencies`；离线恢复缺失即失败，不得报告成功。

### 2.3 manifest

```json
{
  "format": 5,
  "mode": "exact",
  "storage": "content-addressed-hardlink",
  "transactionId": "tx-...",
  "label": "before-add-dsh-mindmap-tx-...",
  "createdAt": "2026-10-18T12:00:00+08:00",
  "state": "verified",
  "profile": "desktop",
  "profileDir": "<YOUR_PROFILE_DIR>",
  "runtime": {
    "nodeVersion": "v24.19.0",
    "pnpmVersion": "...",
    "clientVersion": "0.2.1-rc.2",
    "clientAsarSha256": "...",
    "platform": "win32",
    "arch": "x64"
  },
  "digest": "sha256-of-sorted-entry-list",
  "entries": {
    "profile/package.json": { "kind": "file", "size": 698, "sha256": "..." },
    "profile/node_modules/novel-agents-md": { "kind": "junction", "target": "<YOUR_LINK_PLUGIN>" },
    "profile/node_modules/dsh-infinite-gen-2": { "kind": "directory", "listingSha256": "..." },
    "dshHome/mcp": { "kind": "directory", "listingSha256": "..." },
    "dshHome/.credentials.yaml": { "kind": "file", "sha256": "...", "redacted": true }
  },
  "externalDependencies": [],
  "health": { "preflight": "ok", "port": 40726, "httpStatus": 401, "settledMs": 15000, "safe": false, "probing": false }
}
```

`digest` 用于 drift 快速比对：对 entry 列表按路径排序后整体哈希。

### 2.4 硬链接存储模型

```text
写入：
  文件内容 → 计算 sha256 → _store/<ab>/<sha256> 不存在则复制进去（复制，不链接 live 文件）
                                  已存在则跳过
  快照只写 meta.json 的 entries

恢复：
  entry 指向 _store blob → 复制到临时文件 → rename 到目标
  绝不写 live 文件后回填快照；绝不把 live 文件直接硬链接进 _store
```

关键约束：

1. **禁止硬链接 live 文件**。否则 pnpm 原地改写会同时改坏历史快照。
2. `_store` blob 生成后设为只读；校验失败即视为损坏并按缺失处理。
3. 同一内容跨事务只存一份；本机首次快照约 64MB，之后每次插件增量为新增包大小。
4. `prune` 时先删快照再 GC 无引用 blob；仍被任何保留快照引用的 blob 不删。
5. 去重靠内容寻址完成；硬链接只用于可选的 `files/` 物化验证目录（`fs.link` 从 `_store` 指向临时工作副本），不参与快照存储，也不跨盘使用。
6. 因为快照之间不共享 live inode，任意一次 pnpm 原地改写都不会污染历史快照；这是与“直接硬链接 live 文件”方案的本质区别。

---

## 3. CLI 契约

| 命令 | 作用 | 退出码 |
|---|---|---|
| `doctor` | 诊断环境、闭包、事务、drift、store | 0 / 1 WARN / 2 FAIL |
| `preflight` | 不启动客户端，验证闭包可解析性 | 0 / 2 |
| `runtime-inventory` | 输出 runtimeClosure 清单与 digest | 0 / 2 |
| `drift` | 对比当前闭包与最近 committed 快照 | 0 一致 / 1 有 drift / 2 无法比对 |
| `ps` | 实例 PID、后代 PID、端口、归属 | 0 / 1 |
| `snapshot <label>` | 手动 exact 快照（写入 `_store`） | 0 / 2 |
| `list` | 快照与事务（含 drift、LKG 标记） | 0 |
| `restore <label>` | 恢复快照，自动 pre-restore | 0 / 2 |
| `prune [--dry-run] [--strict] [--keep <label>] [--vacuum]` | 快照保留策略 + `_store` 孤儿 blob 物理回收；`--vacuum` 连空分片一起清 | 0 / 2 |
| `plugin-add <spec>` | 包安装事务 | 0 / 2 / 3 |
| `plugin-link <path>` | 本地 link 事务 | 0 / 2 / 3 |
| `plugin-insert <path\|name>` | 纯 patch 插入事务（无包安装） | 0 / 2 / 3 |
| `plugin-remove <id>` | 移除事务 | 0 / 2 / 3 |
| `plugin-restore <txid>` | 恢复指定事务的 before/after | 0 / 2 |
| `transactions` | 事务、drift、恢复结果列表 | 0 |
| `recover` | 处理未完成事务（续跑或回滚） | 0 / 2 / 3 |
| `guard [--detach]` | 启动验证 + drift 检查 + 加载验证 | 0 / 2 / 3 |
| `safe on` / `safe off` | patch 层安全模式 | 0 |
| `disable <id>` | 写 `disabled: true` | 0 |
| `revert <id>` | 删 override | 0 / 2 |
| `enable <id>` | 移除 disable 覆盖 | 0 / 2 |
| `bisect [--fast] [--ids a,b]` | 仅定位 patch 可见 id | 0 / 2 |
| `repair` | 事务优先的恢复链 | 0 / 2 / 3 |
| `restart` | kill 后 guard | 同 guard |
| `status` | state 摘要（含 drift、activeOperation） | 0 |

### 3.1 事务状态机

```text
prepared → stopped → before-snapshot-created → installing
        → closure-inventoried → preflight-passed → starting
        → load-verified → committed

失败：
  installing | closure-inventoried | preflight-passed | starting | load-verified
  → rollback-stopping → restoring-before → restore-verified
  → restarting-before → rolled-back
  → rollback-failed（保留现场，退出 3）
```

并发约束：

- 同一时刻只允许一个事务（`.guardian.lock`）。
- 事务期间 `state.activeOperation` 写 `{op, txid, phase, pid, startedAt}`，每个状态转换都落盘后再执行下一步。
- `load-verified` 阶段执行插件加载验证（§3.6），失败进入回滚而不是 committed。

### 3.2 plugin-add 行为

```text
1) 取锁，写 intent 与 activeOperation
2) 停客户端（优雅 → 超时杀进程树）
3) preflight 当前环境；不健康则拒绝叠加
4) 建 before-add exact 快照（写 _store + meta）
5) 执行安装/链接；记录 argv、cwd、退出码、stdout 摘要
6) 重新 discoverRuntimeClosure，计算 addedPaths/changedPaths
7) preflight 新环境
8) 启动 Electron，检查进程树端口、HTTP、settleMs
9) 插件加载验证（§3.6）
10) 成功：after-add 快照 → committed → 更新 LKG → 退出 0
11) 失败：停客户端 → exact 恢复 before → 重启验证
    - 恢复成功：rolled-back，退出 2
    - 恢复失败：rollback-failed，退出 3
```

`plugin-insert` 跳过步骤 5 的包安装，只写 patch 与解析路径，其余流程相同。

### 3.3 exact restore

```text
1) 取锁，写 intent 与 activeOperation.phase=restoring-before
2) 校验 meta：format/mode/digest/所有 blob 存在且哈希匹配
3) 校验客户端 asar 哈希；不符且 blockOnClientMismatch → 退出 3
4) 停客户端，确认进程树与端口释放
5) 建 pre-restore 快照（同样写 _store）
6) 计算集合差并清理：
     managedSet   = entries(before) ∪ entries(current)
     deleteSet    = entries(current) \ entries(before)
     deleteSet    = deleteSet ∩ ownedBy(thisProfile | thisTx)
     永不删除：shared / external / 其他 profile 拥有 / _store
7) 按 manifest 物化：文件复制到临时名 → rename；symlink/junction 先删再建并校验 target
8) 重新 discoverRuntimeClosure，digest 必须等于 meta.digest
9) offline preflight
10) 启动 Electron + 加载验证
11) 成功写 restore-verified；失败保留 pre-restore 并退出 3
```

### 3.4 preflight

```text
profile 文件可读
package.json / lockfile 结构可读
file:/link: 目标存在
patch insert/name 可解析
runtimeClosure 每项存在
node_modules/.modules.yaml 与 lockfile 可匹配
客户端版本 + asar 哈希符合 config（不符即 FAIL，除非 --allow-client-mismatch）
```

`@deepseek-ai/*` 解析到 `_npx` 只能 WARN，不得当作内置包真实来源。

### 3.5 启动判定

```text
spawn → 记录 rootPid
每 500ms：netstat + CIM 父子图 → rootPid 后代持有的 127.0.0.1 LISTENING 端口
GET /：任意状态码（含 401）视为服务响应
settleMs 内进程树与端口保持 → ok
```

### 3.6 插件加载验证（新增）

启动成功后、写 committed 之前执行：

```text
1) 新插件包目录存在且入口可 resolve
2) patch 中新增的 insert 项可解析
3) 读 ~/.dsh/profiles/<profile>/.plugin-manager 最近一次 operation 结果，失败即判失败
4) 扫描客户端日志尾部（最近 N 行）中匹配该插件名/包名的 error/warn；
   命中 "failed to load|Cannot find module|plugin error" → 判失败
5) 上述任一失败 → 进入回滚，不写 committed
```

该验证是本机唯一能发现“装上了但插件没起来”的手段（desktop 无 `--dump-config`）。

### 3.7 崩溃恢复（新增）

```text
任何命令启动时：
  if state.activeOperation 存在:
     pid 存活且 argv 属于 guardian → 拒绝并发，退出 2
     否则 → 自动执行 recover
```

`recover` 按 phase 处理：

| phase | 处理 |
|---|---|
| `prepared` / `stopped` | 无写入，标记 aborted |
| `before-snapshot-created` | 未开始安装，标记 aborted |
| `installing` | 安装可能半完成 → exact 恢复 before → 重启验证 |
| `closure-inventoried` / `preflight-passed` | 安装已完成 → 若可启动则 committed，否则恢复 before |
| `starting` | 检查实例；健康则 committed，否则恢复 before |
| `restoring-before` | 用 before manifest 重做恢复（幂等） |
| `restarting-before` | 重新启动验证，失败则 rollback-failed |
| `committed`（after 缺失） | 用当前状态补写 after-add |

恢复过程同样写 activeOperation，保证再次崩溃仍可续。

### 3.8 drift 检测与自动采纳（新增）

```text
drift 判定：
  digest(runtimeClosure) ≠ lastCommittedSnapshot.digest

触发点：guard 启动前、status、doctor、plugin-add 前置

发现 drift：
  1) 写 transactions/drift-<ts>.json：{digest, addedPaths, changedPaths, removedPaths}
  2) 执行 preflight + 启动验证
  3) 健康：建 adopted-<ts> verified 快照，更新 LKG，drift 关闭
  4) 不健康：保持 drift 打开；回滚目标仍为 last committed（drift 前）
          提示可执行 plugin-restore <lastCommittedTxid>
```

含义：**UI 或裸 pnpm 安装的插件，如果在健康状态下装完，会被自动采纳为新基线；如果装完就坏，回滚目标仍是装之前的 committed 快照。**

裸 `pnpm add` 后安装成功但未跑 guardian 的窗口期内，`last committed` 仍是旧基线；下次 guard 会先验证再决定采纳或回滚。

---

## 4. patch 语义与安全模式

| 写法 | 语义 | 用途 |
|---|---|---|
| `- id: X` + `config` | 覆盖该行配置，`config` 整体替换 | 改配置 |
| `- id: X` + `disabled: true` | 禁用该行 | 停用插件 |
| `insert: [...]` | 追加行 | 新插件 |
| 非 insert 且 id 不匹配 | 警告并跳过 | 无害但无效 |

`revert X` 删除 override；`disable X` 写 `disabled: true`；`enable X` 撤销两者。

bisect 只覆盖 patch 可见 id，bundle 内部行需 `--ids`，否则报告不可定位。

---

## 5. guard 与 repair

### 5.1 guard

```text
取锁 → recover 未完成事务（若有）
     → drift 检查（若有 drift，按 3.8 采纳或回滚）
     → preflight
         FAIL → 有未完成事务则 plugin-restore，否则恢复 last committed
         OK   → 启动 + 加载验证
                成功 → 更新 LKG（条件见 5.2）
                失败 → 恢复 verified 快照后只重试一次
```

### 5.2 LKG 条件

```text
runtimeClosure digest 已验证
safe=false
probing=false
disabled 为空
preflight 无 FAIL
插件加载验证通过
进程与端口稳定
```

事务 before-add 优先于 LKG；LKG 不替代事务快照。

### 5.3 repair

```text
1) 有未完成事务 → plugin-restore <txid>
2) 有 drift → 按 3.8 处理
3) 否则恢复最近 verified committed 快照 → 启动验证
4) 仍失败 → doctor 输出闭包差异 → 退出 3
5) 仅当 exact 环境健康且故障明确属 patch 层，才进入 safe/bisect
6) bisect 未定位 → 保持原环境或 safe，不覆盖任何 before/after
```

### 5.4 store 自动维护

```text
doctor → 输出 store: { snapshots, blobs, totalMb, referencedBlobs, orphans, orphanMb, emptyShards, gcOnPrune }

guard 成功（healthy / adopted / healthy-but-lkg-gated）
  → 若 config.storeGcOnPrune = true
      → 静默 pruneCore（保留策略 + 孤儿 blob GC），不打印、不弹输出
      → guard 输出附 prune: { deleted, blobsDeleted, emptyShardsRemoved, freedMb }
      → prune 失败只记 WARN，不改变 guard 退出码
```

prune 的 blob 引用集只由**保留下来的** `meta.json` 构成；`--strict` 忽略 `pruneKeepLabels`，未完成事务引用与 meta 不可读的快照始终保留。

---

## 6. 分步实施

### 第 1 步：骨架、配置、锁与状态机

config、state v5、`.guardian.lock`、intent、activeOperation、doctor 基础。

验收：`node --check` 通过；profile=desktop；exe 存在；config 含 1.3 全部键；并发第二个 guardian 被锁拒绝；人为写入 activeOperation 后 `recover` 能识别。

### 第 2 步：runtimeClosure inventory

解析 `trackedFiles`、`node_modules`、file/link、patch 引用、`~/.dsh/{mcp,storages,.agent-presets,settings}`、plugin-manager、market、共享依赖、客户端指纹；输出 digest。

验收：清单必须包含

```text
profile/node_modules
profile/package.json
profile/pnpm-lock.yaml
file:dsh-infinite-gen-2
link:novel-agents-md
<YOUR_LINK_PLUGIN>
dshHome/mcp
dshHome/storages
dshHome/.agent-presets
clientAsarSha256
```

### 第 3 步：内容寻址 store + exact 快照/恢复

实现 `_store` 去重、manifest、只读物化、链接重建、集合差清理、离线恢复。

验收：

1. 连续两次快照，第二次 store 新增字节数 < 5MB（无新插件时接近 0）。
2. 修改入口文件/package.json/lockfile/链接目标后 exact restore 全部还原。
3. 恢复后 `runtime-inventory` digest 等于快照 digest。
4. 恢复不联网。
5. 篡改 blob 后恢复被拒绝。
6. restore 不删除 `_store` 与共享依赖。

### 第 4 步：plugin-add / link / insert / remove 事务

事务状态机、before/after、addedPaths/changedPaths、报告。

验收：

```text
正常插件 → committed + before + after
抛错插件 → 自动恢复 before + rolled-back
连续 A 成功、B 成功、C 失败 → 恢复后 A、B 保留，C 的 package/lock/node_modules/link/MCP 全部消失
plugin-insert 纯路径插件 → 生成 before/after，patch 可回滚
```

### 第 5 步：guard + 加载验证 + drift

动态端口、HTTP 任意响应、加载验证、drift 采纳。

验收：

1. 健康态 guard 成功且写 LKG。
2. 手工改 patch 后 guard 检出 drift 并采纳为 adopted 快照。
3. 手工装入抛错插件后 guard 检出 drift、验证失败、恢复 last committed。
4. 旧端口不能伪造成功。
5. safe/probing 不写 LKG。

### 第 6 步：patch 控制与有限 bisect

数组切分、disable/revert/enable、bisect 边界。

验收：`disable` 写 `disabled: true`；`revert` 删块；broken insert 下 disable 可启动、revert 仍失败。

### 第 7 步：recover、repair、报告与 README

崩溃续跑、repair、报告、事务列表、README。

验收：

1. 在 installing 阶段杀 guardian → 下次 `recover` 自动恢复 before 并启动成功。
2. 在 restoring-before 阶段杀 guardian → 下次 `recover` 续做恢复，digest 一致。
3. 恢复失败退出 3，不覆盖 before 快照。
4. 报告含 txid、before、after、changedPaths、restoreVerification、finalHealth。
5. README 含事务流程、drift、recover、退出码、exact/reproducible 差异。

每步完成后只输出下一步模型提醒，不执行模型切换。

---

## 7. 故障决策树

```text
插件出问题 / DSH 起不来
├─ node bin/guardian.mjs status
│  ├─ activeOperation 未完成 → node bin/guardian.mjs recover
│  └─ 正常 → 下一步
├─ node bin/guardian.mjs drift
│  ├─ 有 drift 且异常 → plugin-restore <最近 committed txid>
│  └─ 有 drift 且健康 → guard（自动采纳）
├─ node bin/guardian.mjs preflight
│  ├─ FAIL（闭包/版本/链接）→ restore 最近 verified committed
│  └─ OK → guard
├─ guard
│  ├─ 0 → 已恢复
│  └─ 2/3 → repair
└─ repair 失败 → 按报告人工处理（保留 before/pre-restore）
```

---

## 8. 日常使用

```powershell
# 安装插件（包 / 本地 link / 纯 patch 插入）
node bin/guardian.mjs plugin-add dsh-mindmap@0.14.1
node bin/guardian.mjs plugin-link D:\Github\my-plugin
node bin/guardian.mjs plugin-insert .\local-plugin

# 查看与回退
node bin/guardian.mjs transactions
node bin/guardian.mjs plugin-restore <txid>
node bin/guardian.mjs recover
node bin/guardian.mjs drift
node bin/guardian.mjs status
```

在 DSH UI 里装的插件：下次 `guard` 会自动检出 drift；装完健康则采纳，装完坏则回滚到装前 committed 快照。

---

## 9. 已知限制

1. Electron 只能通过 exe 启动，`dsh --profile desktop` 不可用。
2. 客户端升级后 asar 哈希变化：默认阻断 exact restore，需人工确认或改用 reproducible。
3. `GET /` 返回 401 视为服务响应；页面白屏需额外健康端点，当前不自动判定。
4. 首次快照需完整写入一次 `_store`（约 64MB）；之后增量为新增包大小。
5. `_store` 与快照需要同一磁盘；跨盘不做硬链接，退化为复制。
6. 未被任何保留快照引用的 blob 在 prune 时清除；手动删除 `_store` 会使全部快照失效。
7. OS 级副作用（注册表 autostart、系统计划任务）不在自动回滚范围，报告会列出需人工检查项。
8. bundle 内部、未被 patch 引用的 loader 行无法枚举；bisect 只能报告不可定位并回退 exact 快照。
9. 凭据文件只记哈希不存内容；恢复不会还原密钥。
