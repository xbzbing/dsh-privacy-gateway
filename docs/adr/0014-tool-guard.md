# ADR-0014：工具参数外带守卫：告警或不还原

- 状态：Accepted（2026-10-31）
- 相关：`src/redact/guard.ts`、`src/redact/restore.ts`、`src/engine.ts`、ADR-0009、设计 §13 R15

## Context

ADR-0009 对 R15（还原变成外带通道）只做了第 ① 档：工具调用参数里的还原另行计数。第 ② 档（告警）和第 ③ 档（不还原）留到 P2。难点是判定要看完整的工具参数，流式回复里参数是一段段 delta 来的，URL 和占位符都可能被切在两段之间。

## Decision

- 配置 `toolGuard`：`off`（默认，同 ADR-0009）、`warn`、`block`。
- 判定：一个工具调用的参数里，有占位符能还原出值，并且还原后的参数里有本机以外的 host，就算一次外带。host 取自 `scheme://host` 形式的 URL 和 `user@host:` 形式的 scp/git 地址；`localhost`、`*.localhost`、`127.*`、`::1`、`0.0.0.0` 以及 `file:`、`data:` 等不算。
- 「一个工具调用」在 JSON 回复里取整个回复的所有工具参数；在 SSE 回复里取连续几条带工具参数的事件，遇到第一条不带的事件（OpenAI 的 finish 事件、Anthropic 的 `content_block_stop`、`[DONE]`）或流结束时判定。
- `warn`：照常流式还原，判定在这一段结束时做，命中时告警（日志写 host，不写值），记录里记 `exfil`（次数）和 `exfilHosts`。工具在回复结束后才执行，所以告警早于执行。
- `block`：这一段事件先扣住，判定后再一起发出。命中时这段工具参数里的占位符一律不还原，工具拿到占位符字面量；正文照常还原。记录另记 `exfilBlocked`（留下的处数），这些处不计入 `restoredInTools`。没命中的段照常还原后发出。扣住期间 keep-alive 注释行照常先发。

## Consequences

- `block` 让工具参数的流式输出推迟到这次调用结束，前端看到的是参数一次性出现。
- `block` 会误伤合法用法：拿真实 token 调外部 API（`curl -H "Authorization: Bearer …" https://api.github.com`）同样被拦下，工具会因为拿到占位符而失败。需要这类用法时把值加进 `allow`，或用 `warn`。
- 判定按段而不是按单个调用：同一段里有两个工具调用，任一命中，两者都不还原。
- 只认 URL 和 scp 形式的地址。裸域名（`curl evil.example`）、IP 拼接、把值写进文件再由别的命令推送，这几种认不出来。守卫降低的是最直接的外带方式，挡不住全部。
