# ADR-0025：压缩的请求与回复解压后处理；WebSocket 升级不放行

- 状态：Accepted（2026-10-31）
- 相关：`src/dispatcher.ts`、ADR-0001、ADR-0003、ADR-0005

## Context

网关原先只读 UTF-8 明文 body，读不了的当作「不是模型请求」原样发出。代码审查发现两条绕过路径，都来自 pi-ai 的 `openai-codex-responses`：

- SSE 传输把请求 body 用 zstd 压缩，带 `content-encoding: zstd` 发出。压缩后的字节解不成 UTF-8，网关就把整段对话原样发给了厂商。
- 默认传输 `auto` 先试 `globalThis.WebSocket`。Node 内置的 WebSocket 由 Node 自带的 undici 实现，握手是一个 `upgrade: 'websocket'` 的 GET，经过全局 dispatcher（`undici.globalDispatcher.1`，即网关的 `Dispatcher1Wrapper`）；握手之后的消息直接写 socket，不再经过 dispatcher，网关看不到也改不了。连接失败时（socket 触发 `error`，得到的是普通 Error，不是 `CodexApiError`），pi-ai 回落到 SSE，并记下这个会话以后直接走 SSE。

回复方向也有同类问题：`fetch` 默认带 `accept-encoding`，厂商回压缩的回复时网关不还原，占位符进了会话日志（ADR-0003 的前提是回复被还原）。

## Decision

### 请求

- 候选请求（POST、body 可读、`content-type` 是 JSON 或没有）带 `content-encoding` 时，按头里的顺序逆序解码：`gzip`、`x-gzip`、`deflate`（zlib 包装，失败再按 raw deflate）、`br`、`zstd`（`node:zlib` 有 zstd 时）。`identity` 忽略。
- 解码后照常脱敏。内容有改动时以明文发出：去掉 `content-encoding`，按新 body 重算 `content-length`。没有改动时原样发出压缩字节和原来的头。
- 未知的编码、或 body 与它声明的编码不符：不发，返回 `PrivacyGatewayError`（`DSH_PRIVACY_GATEWAY_FAIL_CLOSED`）。
- `content-type` 是 JSON 但 body（解码后）不是 UTF-8：不发。JSON 必须是 UTF-8（RFC 8259），读不了就不能确认里面没有密钥。没有 `content-type` 的非 UTF-8 body 仍当作不是模型请求，原样发出。

### 回复

- 脱敏过的请求（有 exchange）一律把 `accept-encoding` 设成 `identity`，请求头是哪种形式都一样处理。
- 厂商仍回压缩的回复时，`RestoringHandler` 用 `node:zlib` 流式解码（gzip、deflate、br、zstd），还原后以不压缩的形式交给调用方：去掉 `content-encoding` 与 `content-length`。解码出错时中止上游，并向调用方报错。没有解码器的编码照原样交出，打一条 warn。
- `application/x-ndjson`（以及 jsonl、json-seq）按行流式还原，每行是一个 JSON 文档；不再整段缓存到结束。

### WebSocket 与其他升级

- 带 `upgrade` 的请求（WebSocket 握手、undici 的 `upgrade()`）和 `CONNECT` 隧道不发，返回 `PrivacyGatewayError`（`DSH_PRIVACY_GATEWAY_UPGRADE_REFUSED`），打一条只含协议名与 host 的 warn。
- 明确放行的情况照常连接：`enabled` 关、`/privacy off`、排除的 provider、关闭了脱敏的会话、`excludeHosts` 里的 host。

## Consequences

- Codex 在本插件开启时总是走 SSE：第一次 WebSocket 失败后回落，之后同一会话直接用 SSE。SSE 请求以明文发出，比压缩的多一些字节。
- 别的插件经全局 dispatcher 打开的 WebSocket 也会被拒；需要的话把它的 host 加进 `excludeHosts`。
- 回复以不压缩的形式传输，流量略大。
- 一个 bug 或少见的编码会让请求失败而不是外泄，止血路径与 ADR-0005 相同。
