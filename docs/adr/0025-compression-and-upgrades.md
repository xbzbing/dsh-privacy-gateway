# ADR-0025：压缩的请求与回复解压后处理；WebSocket 升级不放行

- 状态：Accepted（2026-10-31）
- 相关：`src/dispatcher.ts`、ADR-0001、ADR-0003、ADR-0005

## Context

网关原先只读 UTF-8 明文 body，读不了的当作「不是模型请求」原样发出。代码审查发现两条绕过路径，都来自 pi-ai 的 `openai-codex-responses`：

- SSE 传输把请求 body 用 zstd 压缩，带 `content-encoding: zstd` 发出。压缩后的字节解不成 UTF-8，网关就把整段对话原样发给了厂商。
- 默认传输 `auto` 先试 `globalThis.WebSocket`。Node 内置的 WebSocket 由 Node 自带的 undici 实现，握手是一个 `upgrade: 'websocket'` 的 GET，经过全局 dispatcher（`undici.globalDispatcher.1`，即网关的 `Dispatcher1Wrapper`）；握手之后的消息直接写 socket，不再经过 dispatcher，网关看不到也改不了。连接失败时（socket 触发 `error`，得到的是普通 Error，不是 `CodexApiError`），pi-ai 回落到 SSE，并记下这个会话以后直接走 SSE。

回复方向也有同类问题：`fetch` 默认带 `accept-encoding`，厂商可能回压缩的回复。要还原时（ADR-0003 的开关打开）网关必须先解码才还原得了；不还原时（默认）压缩的回复原样穿过网关即可。

## Decision

### 请求

- 候选请求（POST、body 可读、`content-type` 是 JSON 或没有）带 `content-encoding` 时，按头里的顺序逆序解码：`gzip`、`x-gzip`、`deflate`（zlib 包装，失败再按 raw deflate）、`br`、`zstd`（`node:zlib` 有 zstd 时）。`identity` 忽略。
- 候选 JSON body 支持 string、Blob、ArrayBuffer、ArrayBuffer view（按 byteOffset/byteLength）、同步及异步 iterable，统一完整读取再脱敏，不因 body 的表示改变保护条件。读取前建立可取消 controller，取消时结束调用并尝试终止 producer，不等待其不可取消的内部 Promise，只通知一次失败，不把已读片段发出；multipart/FormData 的明示豁免不变。FormData 仅在稳定 data descriptors 与原生内部 brand 验证均通过时按 multipart 放行，不能靠 tag、原型伪造、getter 或 Proxy 取得豁免。
- 提前开始通知只发一次，并交出稳定可变 context 对象；下游真正开始时合并其 object context，保留重定向 history 的引用。controller 的只读 `context` 给出下游原始 context，包括 null/基本类型；提前回调第二参数不再与这些晚到值严格相等。这是在立即可取消和保持旧 literal context identity 无法同时满足时的显式兼容取舍。
- 解码后照常脱敏。内容有改动时以明文发出：去掉 `content-encoding`，按新 body 重算 `content-length`。没有改动时原样发出压缩字节和原来的头。
- 未知的编码、或 body 与它声明的编码不符：不发，返回 `PrivacyGatewayError`（`DSH_PRIVACY_GATEWAY_FAIL_CLOSED`）。
- `content-type` 是 JSON 但 body（解码后）不是 UTF-8：不发。JSON 必须是 UTF-8（RFC 8259），读不了就不能确认里面没有密钥。没有 `content-type` 的非 UTF-8 body 仍当作不是模型请求，原样发出。

### 回复

- 要还原的请求（有 exchange，`restoreLog` 打开且值表里有值）把 `accept-encoding` 设成 `identity`，请求头是哪种形式都一样处理；不还原时（默认）不改这个头，回复可以照常压缩。
- 还原打开时厂商仍回压缩的回复，`RestoringHandler` 用 `node:zlib` 流式解码（gzip、deflate、br、zstd），还原后以不压缩的形式交给调用方：去掉 `content-encoding` 与 `content-length`。解码出错时中止上游，并向调用方报错。没有解码器的编码照原样交出，打一条 warn。还原关闭时压缩的回复原样交给调用方，网关不解码、不改头，由适配器自己解压。
- `application/x-ndjson`（以及 jsonl、json-seq）按行流式还原，每行是一个 JSON 文档；不再整段缓存到结束。
- 解压与还原层使用同一个稳定的 controller 传播背压和取消：pause 后不再交付解码输出或成功结束，resume 后继续；abort 销毁解码链、清理待交付内容且只失败一次。原始 HTTP 已结束但解码/还原仍有输出时，这些约束仍有效；不会通过丢掉暂停期间的数据实现背压。

### WebSocket 与其他升级

- 带 `upgrade` 的请求（WebSocket 握手、undici 的 `upgrade()`）和 `CONNECT` 隧道不发，返回 `PrivacyGatewayError`（`DSH_PRIVACY_GATEWAY_UPGRADE_REFUSED`），打一条只含协议名与 host 的 warn。
- 明确放行的情况照常连接：`enabled` 关、`/privacy off`、排除的 provider、关闭了脱敏的会话、`excludeHosts` 里的 host。

## Consequences

- Codex 在本插件开启时总是走 SSE：第一次 WebSocket 失败后回落，之后同一会话直接用 SSE。SSE 请求以明文发出，比压缩的多一些字节。
- 别的插件经全局 dispatcher 打开的 WebSocket 也会被拒；需要的话把它的 host 加进 `excludeHosts`。（已被 [ADR-0032](0032-upgrade-scoped-to-masked-calls.md) 收窄：调用外的升级放行，见文末更新。）
- 还原打开时回复以不压缩的形式传输，流量略大；关闭时（默认）回复照常压缩。
- 一个 bug 或少见的编码会让请求失败而不是外泄，止血路径与 ADR-0005 相同。

## 更新（2026-11-03）

「带 `upgrade` 的请求一律不发」被 [ADR-0032](0032-upgrade-scoped-to-masked-calls.md) 收窄为「只在模型调用里不发」：模型调用之外的升级（别的插件自建的连接，如 dsh-im-infoflow 的入站）与 `CONNECT` 隧道放行，消息不脱敏，同一 host 打一条 warn。这是一次 fail-closed 到 fail-open 的取舍，代价见 ADR-0032。明确放行的情况（`enabled` 关、`/privacy off`、排除的 provider、关闭了脱敏的会话、`excludeHosts`）不变。

## 更新（2026-11-28）

本 ADR 的「WebSocket 升级与 `CONNECT` 隧道不发」只在 `dispatcher` 模式下成立。切到 `stream`（[ADR-0040](0040-llm-stream-and-intercept-modes.md)）后不再安装 dispatcher，模型调用的升级握手也不经过网关，这一拒绝随之失效：结构化层在 adapter 序列化**之前**改写请求、回复在交给宿主之前还原，握手与它后面的帧不在这一层的视野内，也不靠拒绝它们来保证安全。默认仍是 `dispatcher`，此更新不改变默认行为。

## 更新（2026-11-20）

回复方向的两条随 [ADR-0003](0003-restore-before-session-log.md) 改为开关、默认不还原而收窄：`accept-encoding` 只在要还原时设成 `identity`，压缩回复的解码与 warn 只发生在还原打开时；还原关闭时压缩的回复原样穿过网关。请求方向不变。
