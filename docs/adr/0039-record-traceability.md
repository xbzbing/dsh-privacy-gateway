# ADR-0039：历史记录查询、匿名未知证据与会话导航

- 状态：Accepted（2026-11-27）
- 相关：`src/query.ts`、`src/records.ts`、`src/engine.ts`、`src/redact/restore.ts`、`src/redact/kinds.ts`、`src/remote.ts`、`src/index.ts`、`src/client/QuerySection.ts`、ADR-0008、ADR-0011、ADR-0014、ADR-0030

## Context

统计卡上的「未知占位符 2 个」「外带工具调用 1 次」覆盖磁盘上每一天，但卡片下方的列表只读内存里最近 `keepRecords` 条（默认 500），前端每页 10 条，切「7 天 / 30 天」只换汇总、不换列表。本机实测一天约 1700 条请求，三条异常都还在盘上，却都排在最近 200 条之外：汇总看得到，明细找不到。

三条约束：

- 账本身不能变成泄密点（ADR-0008）。模型写的文本不是安全常量：一个语法合法的未知标记，它的 kind/hash 可能就是被脱敏的真值，而现有审计把协议原子当不透明（ADR-0037），不会替换里面的内容。
- 「开关打开」不等于「检测跑过」：值表为空、回复没到、guard 关闭时，还原链根本不会执行，计数 0 是「没检测」，不是「很干净」。
- 查询不能拖慢请求，也不能因为一次查询把宿主卡住。

## Decision

### 历史查询

- 新增 `privacyGateway/records` 与 `privacyGateway/record`（typert Remote，沿用 `/api`），`overview` 增加 `capabilities` 与 `timeZone`。`overview` 的语义不变，仍是运行汇总与最近记录。
- 查询按 `mode` 判别：`start`（范围、事件、可选会话、页大小）、`poll`、`resume`、`partial`、`page`、`cancel`。范围用本地日期 `[from, to)`，页大小 1–200（默认 50），不再有「历史上限」。
- 权威数据仍是按日 JSONL（ADR-0008）。查询在 Host 内分片读取，**每个时间片结束后保留位置、跨段去重状态和累计**，`paused` 可 `resume`；时间片耗尽与硬上限不同，后者说明不可续扫并要求缩小范围。
- **构建任务与结果快照分开**：快照一旦发布就不再改，`resume` 产出新的 `snapshotId`，旧游标永不追加新行。游标是不透明句柄，绑定快照与筛选条件。
- 排序：有 key 的记录按 key 倒序，无 key 的旧记录按文件日期与行偏移排在后面，两者不混成一条「时间序」。去重沿用加载规则（实时优先、日期新到旧、文件内上到下第一条合法行胜出），并且**先定胜者再套筛选**，较新的同 key 行不会因为不满足筛选而让旧副本冒出来。
- 详情按快照里的 `文件 + 行偏移 + 行指纹` 重新读取：文件被改写、截断、替换或清理后返回 `SNAPSHOT_INVALIDATED` / `RECORD_UNAVAILABLE`，不会拿另一行充数。内存里的记录直接回答，不假装从盘上读。
- 覆盖状态分三个维度：`storage`（disk / mixed / memory-only）、`scan`（building / paused / ready / partial）、`detection`（on / off / unknown），并列出原因（`write-gaps`、`too-many-matches`、`key-space`、`unreadable` 等）。查询汇总只统计它真正看到的记录，与 `overview` 的运行累计分开显示，不互相改写。

### 匿名未知证据

- 记录新增可选 `unknown[]`：只存**本次请求内的匿名编号**、`KNOWN_KINDS` 白名单里的 kind（其余固定为 `custom`）、出现次数、是否在工具参数中。**不存模型写的标记、kind 或 hash**，也不存周边原文；标记原文只活在原有回复处理作用域里，`finish` 后丢弃。
- 采集只在既有 `unmapped` 判定点发生，`unmapped` 的计数、还原字节与 `toolGuard` 处置完全不变（fail closed 不变）。上限 16 条，超出只加计数。
- 记录新增可选 `detection`：`settings` 是请求开始时的 `restoreLog` / `toolGuard`，`activity` 分未知映射与外带两条路径，各记 `executed` / `skipped` / `partial` / `unknown` 与原因（`restore-disabled`、`guard-off`、`no-value-table`、`no-reply`、`incomplete-reply`）。状态在既有判定点更新，**不新增检测链**，也不让原来不读回复的请求开始读。
- 外带仍按现有语义计数：它是「工具参数里同时出现可还原的值和外部 host」的命中数，不是已执行的工具数，更不是已发生的网络发送；界面写「外带风险命中」，范围写 `tool-argument-group`。

### 会话导航

- 只使用官方 `uiWorkspace.openSession(SessionId | SubagentAddress)`，它**没有轮步参数**：第一版只承诺「打开会话 + 复制定位信息（时间、轮步、记录 key）」。
- 会话标识被安全投影过的记录（不是宿主会生成的 id）第一版**禁用导航**，只复制安全定位；不保存额外的 canonicalId，也不提供没有官方消费入口的导航句柄。
- 归档、需迁移、已删除、无权限、未挂载导航服务时按钮不可用并说明原因，不自动创建、解归档或迁移会话。

### 实现边界

- 分片读取在 Host 内协作让出（时间片 + `setImmediate` 语义），**不引入 worker 与新的打包面**；单条读取与解析有上限，超限行保留在 JSONL 并标 `partial`，不改原日志。
- 资源预算（页大小、索引内存、快照数量、TTL、时间片）是待实测的初始提案，不是已达成的性能结论；默认验收规模必须完整可查，超出预算的自定义规模允许要求缩小范围。

## Consequences

- 汇总与明细对得上：早期异常只要记录还在、文件还读得到，就能按范围与类型查到，并打开对应会话。
- 未知证据不再把模型写的标记当安全文本，记录、索引、Remote 与错误里都不会出现它夹带的值。
- 「没检测」与「检测干净」在界面上分开，零计数不再被当成无风险。
- 旧记录没有 `unknown` / `detection` 字段时显示「未保存」或 `unknown`，不补猜、不回填。
- 查询是只读旁路：它失败、被取消或索引损坏，都不影响请求是否发出与回复还原。
- 已知代价：无 key 的旧记录与内存副本不按内容猜测关联；敏感身份的导航缺失；精确跳到日志事件仍未承诺。