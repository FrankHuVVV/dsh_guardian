# 组 3 ownedBy 判定表

> 生成时间：2026-10-18T15:35+08:00；仅基于只读分析，未改动任何代码。
> 实机事实：profiles = desktop / web / web.bak2（web、web.bak2 只声明 file:/link: 依赖，不认领任何共享根包）；`~/.dsh/profiles/node_modules`（共享根）当前为空（files=0）。
> 本 profile（desktop）仅有两个 file:/link: 依赖：`dsh-infinite-gen-2`（file:）与 `novel-agents-md`（link:）。

## 表 1：source: / file: 根的所有者判定

| 根路径 | 来源（patch/file:/link:） | 所有者 | 判定依据 | restore 时是否允许删除 |
|---|---|---|---|---|
| D:\Github\novel_assistance | link: novel-agents-md（`link:D:/Github/novel_assistance`） | 外部（开发者工作区） | §2.1(5) link 依赖目标；§0.3 不变量9「普通 restore 不删快照后新增源码」；profile 仅以 junction 引用，非 profile 自有状态 | **否** |
| C:\Users\28256\.dsh\plugins\dsh-infinite-gen-2 | file: dsh-infinite-gen-2（`file:../../plugins/dsh-infinite-gen-2`） | 外部（本机插件源，`~/.dsh/plugins` 下独立源码） | §2.1(4) file 依赖真实目标目录；§0.3 不变量9；不在 profileDir 内，profile 以 file: 引用 | **否** |
| （其余） | — | — | 已核实 desktop 的 package.json 无其它 file:/link: 依赖，无其它 source:/file: 根 | — |

## 表 2：拟删除条目清单（restoreMaterialize 全部删除调用点）

> 分两类：A「额外状态删除」= 删除 `current \ target` 中快照后新增的条目；B「物化替换」= 清空被快照 target 条目占用的节点后再写入。B 类只作用于 target 中已存在的路径，不删除快照之外的新增源码。

| 条目路径（运行时） | 来自 managedSet 还是 current | ownedBy 判定 | 删除理由 | 对应 AGENTS.md 条款 |
|---|---|---|---|---|
| A1 `profile/**` 中 current\target 的多余文件 | current | thisProfile（profileDir 自有状态） | 本 profile 快照后新增的包/配置需回滚清除 | §3.3 步骤6 |
| A2 `profile/**` 中 current\target 的多余链接/junction | current | thisProfile | 同上 | §3.3 步骤6 |
| A3 `profile/**` 中 current\target 的多余空目录 | current | thisProfile | 快照不含的空目录清理 | §3.3 步骤6 |
| A4 `dshHome/{mcp,storages,.agent-presets,settings.yaml*}` 中 current\target 的多余文件/链接/空目录 | current | thisProfile（本 profile 的 ~/.dsh 插件写入目录） | 插件写入目录回滚 | §3.3 步骤6 + §2.1(7) |
| A5 `shared/**` 中 current\target 且 `owners ∩ (profiles\{desktop}) = ∅` 的多余文件/链接/空目录 | current | thisProfile（owners 不含其它 profile；含 `unowned`） | 本 profile 新增共享包回滚，其它 profile 认领的永不删 | §3.3 步骤6 + §2.1(3) |
| B1 文件根物化：`root.kind==='file'` 且当前是目录（line 1145） | target | thisProfile（快照指定单文件条目） | 目录占位被快照单文件替换 | §2.4 物化 |
| B2 目录占位替换（line 1183，当前是文件/链接、target 是目录） | target | thisProfile（快照指定条目） | 覆盖写入前置清空 | §2.4 物化 |
| B3 文件占位替换（line 1193，当前是目录/链接、target 是文件） | target | thisProfile（快照指定条目） | 覆盖写入前置清空 | §2.4 物化 |
| B4 链接占位替换（line 1215，target 是链接、当前存在他物） | target | thisProfile（快照指定条目） | 链接重建前置清空 | §2.4 物化 |

> source:/file: 根（表 1 两行）只允许 B 类（物化替换），不允许 A 类（额外状态删除）。

### 附录：非 restore 删除调用（本组不触碰，行为不变）

| 行号 | 位置 | 说明 |
|---|---|---|
| 77 / 83 | acquireLock 锁文件清理 | 禁止清单（acquireLock），不动 |
| 1637 | installPlugin/copyDirectoryForPlugin 覆盖 node_modules 目标 | 事务安装，非 restore，不动 |
| 1708 | linkPlugin 覆盖 node_modules 目标 | 事务安装，非 restore，不动 |
| 1865 | removePluginCommand 删除插件目录 | 事务移除，非 restore，不动 |

## 表 3：sharedDependencyRoots 纳入方案

| 项 | 内容 |
|---|---|
| 共享依赖根路径 | `C:\Users\28256\.dsh\profiles\node_modules`（当前为空） |
| 如何纳入 buildRoots | 在 `buildRoots()`（现 814 行）file:/link: 循环之后、`return roots` 之前，遍历 `config.sharedDependencyRoots`，对存在的根执行 `addRoot('shared', rootPath)`（多根时 `shared:<idx>`）；函数名 `buildRoots`，不改签名 |
| 如何记录 owners | 复用 `discoverRuntimeClosure` 现有 `resolveSharedOwners(sharedProfilesRoot, name, sharedCache)`（现 364 行）与 `shared/<scope>/<name>` entry 的 owners 数组。owners 取值：声明该直接依赖的 profile 名数组；无人声明 → `['unowned']`。restore 阶段从 `meta.entries` 读 `shared/<scope>/<name>.owners`，按文件 rel 的前缀（`@scope/name` 或 `name`）映射回 owners |
| restore 时如何只删「本 profile 且 before 中不存在」的条目 | `deleteShared = { p ∈ files(current, root='shared') \ files(target, root='shared') : owners(scopeName(p)) ∩ (profiles \ {desktop}) = ∅ }`。即：仅在快照后新增、且未被任何其它 profile 认领的共享条目才删除；已被其它 profile 认领、或 before 中已存在的条目永不删除。`unowned` 按「非其它 profile 所有」处理为可删（否则传递依赖永远无法回滚） |

## 待你裁决的三个问题（不确认不得进入 B）

- Q1（D1 目标对象）：`manual-baseline-20261018-152408` 是组 1 用 `robocopy` 做的**原始目录副本**，不是 guardian 快照（无 `backups/*/meta.json`、无 `_store`、无 `entries/files` 清单）。`restore <该目录>` 会走 `resolveSnapshot` → 找不到 → exit 2，等于什么都没发生。提议：D1 改为在 B 之后、客户端停止状态下先 `snapshot group3-base`，再对 `group3-base` 跑两条 restore 测试。
- Q2（unowned 处理）：`guardian-shared-test` 不会被任何 profile 的 package.json 直接声明，`resolveSharedOwners` 会给它 `owners=['unowned']`。按「只删本 profile」字面义，它不会被删 → 测试 b 必 FAIL。提议采用表 3 的谓词：`owners ∩ 其他profile = ∅` 即可删（含 unowned）。
- Q3（源码保留 vs digest 校验冲突）：source/file 根已计入闭包 digest。restore 若保留快照后新增源码，则 `discoverRuntimeClosure` 重算的 `after.digest` 必然 ≠ `meta.digest`，现有 `restoreCommand`（1353-1366）会 exit 3。要「restore 成功且保留源码」，必须把 restore 校验改为：managed 根（profile/dshHome/shared）严格相等，source/file 根只校验「target 内文件全部存在且哈希一致」（允许新增超集）。这属于 P0-3 的必要部分，但会改 `restoreCommand` 的校验逻辑（不在禁止清单内）。
