# 组 4 checklist（并发锁提升、崩溃续跑、stopClient 替换、EACCES 修复）

> 基线：bin/guardian.mjs 2667 行（组 4 修改后）。

| # | 任务 | 依据 | 状态 | 实现摘要 |
|---|---|---|---|---|
| 1 | 旧 stopClient 替换：删除 1310 定义，1606/2374 改为 stopClientAndVerify | P0-1 | [DONE] | 删除 `stopClient`；restore 改同步调 `stopClientAndVerify(config,{state})` 并校验 stopped/released（失败 `stage=client-stop` exit 3）；restart 同 |
| 2 | 锁提升：acquireLock 提到自动 recover 之前 | P0-5 | [DONE] | 现 2591：位于只读分发之后、`state=loadState()` 与自动 recover 之前；`try...finally release()` 包住全部写命令 |
| 3 | 锁范围：只读 6 命令保留在锁外 | P0-5 | [DONE] | status/ps/runtime-inventory/preflight/list/transactions 在 2583-2588 直接返回，未取锁 |
| 4 | txid:null：2060 新增独立分支，按 phase 清理/回滚，不再 return recover() | P0-6 | [DONE] | 早期 phase：清 activeOperation+落盘，log `phase=aborted`，返回 0；后期 phase：清 state+落盘，log `phase=cleared-manual-intervention-needed`，返回 2 |
| 5 | startClient：spawn 后立刻 `.on('error')`，捕获 EACCES/ENOENT | EACCES | [DONE] | spawn try/catch + `child.on('error')` + `!child.pid` 快速失败 → `{restart:'spawn-error',code}`；轮询内检查 spawnError |
| 6 | startClient 超时先清理残留进程再返回 | EACCES | [DONE] | 超时分支先 `stopClientAndVerify({rootPid,port})` 再返回 `{restart:'timeout',cleanup}`；restore 重启失败 → `status:'restored-restart-failed'` + exit 2 |

## 实现备注

- `stopClientAndVerify` 为同步函数，签名 `(config, { state, graceMs, port, rootPid })`；未使用 `await`。
- main 结构：只读分发 → acquireLock → `state=loadState()` → 自动 recover（含 txid:null，`command!=='recover'`）→ 写意图 → 写命令分发 → `finally release()`。
- restore 的 `stop` 字段由字符串变为 stop 结果对象（`stopped/released/reason/elapsedMs`）。
- 未触碰组 3 逻辑（patch 语义、restore 集合差、source 根过滤、sharedDependencyRoots），未删改 4 个快照。
