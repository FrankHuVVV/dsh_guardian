# 当前真机使用限制（P0 全部修复）

## 允许
- **前提约束**：DeepSeek Harness.exe 带有 RUNASADMIN 标志，所有会拉起客户端的命令（guard / restart / repair）必须在**管理员权限**的终端下运行，否则会因 EACCES 失败。
- 所有 guardian 命令（doctor / preflight / snapshot / restore / guard / repair / plugin-*）
- 日常操作走 plugin-add 等事务路径，或手动 snapshot + UI 安装
- restore 会覆盖 patch config，使用前注意对比（此警告永久保留）

## 恢复点
- post-group3-config-20261018-162012：历史基线
- 其他按需 snapshot

## 后续
- P1 级别缺陷（如远程 spec 安装、prune 等）待后续版本修复
