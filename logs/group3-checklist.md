# 组 3 checklist（集合差过滤 + 共享依赖纳入）

> 环境事实（已核实）：共享根 `~/.dsh/profiles/node_modules` 196 顶层条目 = 26 scope 目录 + 170 junction（指向 npx cache），inventory 记录 489 个 `shared/*` 元数据条目。desktop 直接依赖 7 个；web(7)/web.bak2(0) 只声明 file:/link:。source/file 根仅 2 个。

| # | 任务 | 依据 | 状态 | 实现摘要 |
|---|---|---|---|---|
| 1 | restoreMaterialize 增加 ownedBy 过滤 | §3.3 步骤6 | [DONE] | 新增 rootMayDelete + sharedOwnedSolelyByThisProfile，deleteSet=(current\target)∩ownedBy(thisProfile) |
| 2 | source:/file: 根非删除式还原 | 不变量9 | [DONE] | canDelete=false 时多余文件/链接/空目录 skippedKeep，仅物化 target 内条目 |
| 3 | sharedDependencyRoots 纳入 buildRoots | §2.1(3) | [DONE] | buildRoots 末尾遍历 sharedDependencyRoots，addRoot('shared')，快照 489 链接+26 目录 |
| 4 | shared restore 只删本 profile 新增 | §3.3 步骤6 | [DONE] | shared 根按 owners∩其他profile=∅ 判定，其他 profile 认领/外部永不删 |
| 5 | 删除调用映射表 2 + unowned 日志 | 反捷径2 + Q2 | [DONE] | restore 7 个删除点映射 A1-A5/B1-B4；unowned 删除前 logSharedDelete 记路径/大小/sha256/依据 |
| 6 | resolveSharedOwners 传递依赖归属 | Q2补充2 | [DONE] | 增加 exists(P/node_modules/<name>)；zod、schemastery owners=desktop（原 unowned） |
| 7 | restoreCommand 分根 digest 校验 | Q3补充1/2 | [DONE] | verifyRestoreClosure：managed entryLine 严格相等，source/file 超集校验；digest 仍写 meta.json 不作通过条件 |

## C 阶段结果（已通过）

- C1 `node --check` = 0。
- C2 删除调用审计：restore 内 7 个删除点（1201/1231/1240/1247/1257/1279/1293）全部映射表 2；非 restore 删除（acquireLock 77/83、copyDirectoryForPlugin 1746、linkPlugin 1817、removePlugin 1974）未触碰。
- C3 边界：`acquireLock` 定义 60 未变、调用 2450→2559（仅下移）；`txid:null` 0 命中；`patchRemove` 1785/1977 未改（仅因上方插入 helpers/verify 下移）。
- C4 源码根无删除：source/file 根 `canDelete=false`，A 类删除被跳过（skippedKeep）；B 类（物化替换）只作用于 target 内路径，不删快照外源码。
- Q2 验证：`shared/zod`、`shared/@deepseek-ai/schemastery` owners=`desktop`（传递依赖，改前为 unowned）；`@agentclientprotocol/sdk` owners=unowned（desktop 树无此包，正确）；无任何 shared 包被 web/web.bak2 认领。

## Q1/Q2/Q3 补充（已确认，已按补充实现）

- group3-base 在 D 脚本第一步建（外部、客户端停止）；manual-baseline 降级；group3-base 不被清理。
- 动态 b 输出 restore 前后 `profiles\node_modules` 条目集合并 diff。
- C4 已对每个删除点输出上下文（见本组 C2 审计输出）。

## 禁止触碰（未动）

acquireLock、recover txid:null、旧 stopClient、patchRemove/plugin-insert、prune/GC。
