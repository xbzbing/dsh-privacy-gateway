# 架构决策记录（ADR）

本目录记录 `dsh-privacy-gateway` 已经做出的架构决策，固定定下来的结论和理由。

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
| [ADR-0005](0005-fail-closed.md) | 脱敏失败时不发请求（fail-closed） | Accepted | 失败语义 |
| [ADR-0006](0006-distribution-and-build-artifacts.md) | 分发渠道与构建产物：`lib/` 不入库 | Accepted | 分发 |
| [ADR-0007](0007-release-process.md) | 发布流程：GitHub Actions 驱动 | Accepted | 发布 |
| [ADR-0008](0008-masking-records.md) | 脱敏记录按天 JSONL 落盘，写失败放行 | Accepted | 记录 |
| [ADR-0009](0009-value-table-and-restore-exfiltration.md) | 值表只留内存；还原外带先记账不拦截 | Accepted | 脱敏 |
| [ADR-0010](0010-cookie-recognition.md) | COOKIE 按上下文识别，一个 cookie 值是一个值 | Accepted | 脱敏 |
| [ADR-0011](0011-command-and-statistics-card.md) | `/privacy` 命令与统计卡 | Accepted | 界面 |
| [ADR-0012](0012-dispatcher-composition.md) | 网关下游按角色排序，并公开合成契约 | Accepted | 架构 |
| [ADR-0013](0013-actions.md) | 按 kind 选动作：mask、warn、block | Accepted | 脱敏 |
| [ADR-0014](0014-tool-guard.md) | 工具参数外带守卫：告警或不还原 | Accepted | 脱敏 |
| [ADR-0015](0015-shape.md) | shape：密钥伪装成同形假密钥 | Accepted | 脱敏 |
| [ADR-0016](0016-vendor-view.md) | 厂商视角对照：内存里留发出的 body，不出真值 | Accepted | 界面 |
| [ADR-0017](0017-sidebar-panel.md) | 会话顶部的「隐私保护」标签页，默认不出现 | Accepted | 界面 |
| [ADR-0018](0018-exclude-providers.md) | 按 provider 放行，指定的 provider 不脱敏 | Accepted | 架构 |
| [ADR-0019](0019-hint.md) | 记录里的提示保留首尾几个字符，人能认出被换掉的是哪个值 | Accepted | 界面 |
| [ADR-0020](0020-record-attribution.md) | 记录带上工作区与会话名称 | Accepted | 架构 |
| [ADR-0021](0021-live-settings.md) | 配置页编辑日常配置项，改了即时生效 | Accepted | 界面 |
| [ADR-0022](0022-reset.md) | 统计卡重新排版；「清空数据」二次确认后清空历史 | Accepted | 界面 |
| [ADR-0023](0023-session-switch.md) | 会话的「隐私保护」标签页可以关闭本会话的脱敏 | Accepted | 界面 |
| [ADR-0024](0024-record-context.md) | 记录里的每个值带上位置和前后文字 | Accepted | 界面 |
| [ADR-0025](0025-compression-and-upgrades.md) | 压缩的请求与回复解压后处理；WebSocket 升级不放行 | Accepted | 架构 |
| [ADR-0026](0026-file-name-values.md) | 字段值是一个文件名时不算密钥 | Accepted | 脱敏 |
| [ADR-0027](0027-per-instance-state.md) | 状态目录按实例隔离 | Accepted | 架构 |
| [ADR-0028](0028-record-every-place.md) | 记录一个值出现过的每一处，界面按消息序号标出 | Accepted | 界面 |
