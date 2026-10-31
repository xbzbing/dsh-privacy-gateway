# 架构决策记录（ADR）

本目录记录 `dsh-privacy-gateway` 已经做出的架构决策。设计稿在 `docs/local/`（被 `.gitignore` 忽略，不入库），这里只固定定下来的结论和理由。

## 约定

- 一个 ADR 只记一个决策；文件名 `NNNN-短横线标题.md`，编号单调递增、不复用。
- 状态取值：`Proposed`（待拍板）、`Accepted`（生效中）、`Superseded by ADR-XXXX`（被取代，正文保留）、`Deprecated`（不再适用）。
- 决策被推翻时不改写历史：新写一份 ADR，把旧的标为 Superseded 并互相链接。
- 结构固定为 Context（约束与备选）→ Decision（做什么）→ Consequences（代价与后续）。

## 索引

| 编号 | 决策 | 状态 | 领域 |
| --- | --- | --- | --- |
| [ADR-0001](0001-intercept-at-undici-global-dispatcher.md) | 拦截点：undici 全局 dispatcher | Accepted | 架构 |
| [ADR-0002](0002-deterministic-placeholders-in-memory-values.md) | 确定性占位符，值只留内存 | Accepted | 脱敏 |
| [ADR-0003](0003-restore-before-session-log.md) | 还原发生在会话日志之前，日志含真值 | Accepted | 脱敏 |
| [ADR-0004](0004-protected-regions.md) | 受保护区域：`<env>` 块、工具定义与 keepIn 字段 | Accepted | 兼容 |
| [ADR-0005](0005-fail-closed.md) | 遮蔽失败时不发请求（fail-closed） | Accepted | 失败语义 |
| [ADR-0006](0006-distribution-and-build-artifacts.md) | 分发渠道与构建产物：`lib/` 不入库 | Accepted | 分发 |
| [ADR-0007](0007-release-process.md) | 发布流程：GitHub Actions 驱动 | Accepted | 发布 |
| [ADR-0008](0008-masking-records.md) | 脱敏记录按天 JSONL 落盘，写失败放行 | Accepted | 记录 |
| [ADR-0009](0009-value-table-and-restore-exfiltration.md) | 值表只留内存；还原外带先记账不拦截 | Accepted | 脱敏 |
| [ADR-0010](0010-cookie-recognition.md) | COOKIE 按上下文识别，一个 cookie 值是一个值 | Accepted | 脱敏 |
| [ADR-0011](0011-command-and-statistics-card.md) | `/privacy` 命令与统计卡 | Accepted | 界面 |
