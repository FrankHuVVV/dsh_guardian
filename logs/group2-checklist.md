# 组 2 checklist（stopClientAndVerify 抽取与接入）

| # | 任务 | 依据 | 状态 | 实现摘要 |
|---|---|---|---|---|
| 1 | 抽 stopClientAndVerify(graceMs, port, rootPid) | 不变量2 | [DONE] | 新增 pidAlive/clientProcessIds/tcpListeners + stopClientAndVerify(config,{graceMs,port,rootPid,state}) |
| 2 | stopClientAndVerify：优雅停 → 超时杀进程树 → 端口释放确认 → 进程树确认 → 返回 {stopped, released, pids, reason} | 不变量2 | [DONE] | taskkill 无/F → graceMs 每 250ms 轮询 → /T /F → 端口 10s 轮询 → 返回 stopped/released/pids/reason/elapsedMs |
| 3 | createSnapshot 开头调用 stopClientAndVerify，失败即拒绝快照 | 不变量2 / §2.3 | [DONE] | 首行 stop；失败 log phase=snapshot-refused，返回 error → snapshotCommand exit 2，不写 meta.json |
| 4 | createSnapshot 的 health 改为实算：preflight 实测、port 实测、settledMs 实测、restart 标记为 not-implemented-in-group2 | §2.3 manifest health | [DONE] | health.preflight=preflightReport().status、port=停止后 netstat 实测、settledMs=stop.elapsedMs、restart 固定标记 |
| 5 | 事务 prepared→stopped 调用 stopClientAndVerify，失败进入 rollback-failed | §3.2 步骤2 | [DONE] | txPhase('stopped') 前先 stop；失败 rollback-failed + exit 3；成功才推进状态机 |
| 6 | 只读路径（doctor/preflight/inventory/status/list/ps）不得调用 stopClientAndVerify | 不变量2 边界 | [DONE] | 5 条既有只读路径无 stop 调用；补只读 ps（0/1）；实测 6 条 exit=0，客户端进程 6→6 |

## C3 边界复核（修改前 → 修改后）

| 符号 | 修改前行号 | 修改后行号 | 说明 |
|---|---|---|---|
| `restoreMaterialize` | 1074 / 1346 | 1119 / 1512 | 仅整体下移：+45（createSnapshot 20 行、ps 24 行）/ +166（再加 helper 121 行），函数体未改 |
| `sharedDependencyRoots` | 28 / 572 | 28 / 572 | **完全未变**（本组未触碰） |
| `acquireLock` | 60 / 2274 | 60 / 2450 | 定义行未变；调用行仅下移 +176（helper 与 ps 插入），位置未改 |
| `txid:null` / `txid === null` | 0 命中 | 0 命中 | 未变 |

## 新增符号位置（修改后）

| 符号 | 行号 |
|---|---|
| `psCommand` | 1025 |
| `pidAlive` | 1256 |
| `clientProcessIds` | 1266 |
| `tcpListeners` | 1280 |
| `stopClientAndVerify` | 1293 |
| createSnapshot 接入点 | 870 |
| 事务接入点 | 1789 |

## 说明

- `ps` 在组 2 内补齐（用户确认「补 ps」）：只读，读 `state.instance` + 实测进程/端口，返回 0（运行中）/1（未运行），不取锁、不调用 stop。
- 未触碰禁止清单：restoreMaterialize 集合差、source:/file: 删除、sharedDependencyRoots 纳入、acquireLock 位置、recover 的 txid:null、patchRemove/plugin-insert。
