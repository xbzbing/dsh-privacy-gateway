# ADR-0001：拦截点：undici 全局 dispatcher

- 状态：Accepted（2026-10-31）
- 相关：`src/dispatcher.ts`、`src/index.ts`、ADR-0003、ADR-0004

## Context

目标是两件事同时成立：厂商看不到密钥明文；agent 无感，模型回复里的占位符在到达 agent 前换回真值。还要覆盖所有 provider，包括 oc2dsh 这类插件 adapter。

宿主的 agent 事件层给不出这两件事：

- `agent/pre-step` 能改写输入，但只拿到本步从 inbox 领取的新消息，历史回放、system prompt 都不经过它。
- 回复方向没有改写缝：`agent/assistant-stream` 是只读发布；`tools/pre-execute` 禁止改参数；`llm/stream` 能包输出，但 `next()` 不带参数、loop 发起的请求是 deep-frozen 的，出站改不了。

宿主自己的 `@deepseek-ai/dsh-http-proxy` 把代理策略装成 undici 的全局 dispatcher，并说明 LLM adapter、web search、HTTP MCP 都因此被覆盖。Node 内置 `fetch` 读的就是这个全局 dispatcher：pi-ai 与 openai SDK 回落到 `globalThis.fetch`，oc2dsh 发往本机 relay 的请求也由宿主进程发出。

备选：

- 只用 agent 事件层（dsh-mask、dsh-privacy-protector 的做法）：只能单向，或只覆盖新消息。
- 独立进程的 base-URL 网关（PasteGuard、dsh-veil 等）：接不进 oc2dsh。放在 relay 后面会丢掉 Bun 连接栈，放在前面要改 relay 的端口、token 与 Host 校验。

## Decision

在宿主进程的 undici 全局 dispatcher 上**链式**装一层 `MaskingDispatcher`：

- 以当前全局 dispatcher 为下游，不替换它，用户的 `HTTP_PROXY` 策略照常生效。
- 只改写 POST、body 是 UTF-8 JSON、且顶层有 `messages` 或 `input` 数组（Gemini、Vertex 是 `contents` 数组）的请求；按 body 形状判定，不按 host 白名单。会话标题生成、压缩请求因此自动被覆盖。带 `content-encoding` 的 body 先解码再判定（ADR-0025）。
- loopback 不豁免：oc2dsh 的 relay 就在 `127.0.0.1`。另设 `excludeHosts` 显式排除。
- 除 ADR-0025 的三处外不改请求头：按新 body 重算 `content-length`；明文发出解码过的 body 时去掉 `content-encoding`；脱敏过的请求把 `accept-encoding` 设成 `identity`。
- 定时自检：全局 dispatcher 被别人顶掉时，以当时的全局 dispatcher 为下游重新装上。下游的顺序与合成契约见 ADR-0012。
- 卸载（插件重载、卸载、退出）后网关一律放行：仍持有它的层发来的请求原样透传。网关在顶上时，全局 dispatcher 交还给第一个 `proxy` 层（最后一个在顶上被收编的，否则是安装时的那个），不交给 `route` 层。新装的网关遇到已卸载的网关时装在它交还的 dispatcher 上，重载不会层层叠加。
- 依赖锁 `undici@8.12.4`；宿主 `dsh-http-proxy` 当前是 `8.11.2`，8.x 内共用 `globalDispatcher.2` / `.1` 的契约不变，宿主升级时重新复验。undici 8 的 `setGlobalDispatcher` 同时写 `undici.globalDispatcher.2`（原对象）与 `.1`（`Dispatcher1Wrapper` 包装，Node 内置 fetch 读它），所以插件自带一份 undici 也与宿主共用同一个全局 dispatcher。

## Consequences

- 一处拦截覆盖所有走 `fetch()` 的流量，新增 provider 不需要改插件。
- 盲区：`node:http` 直连、axios 默认 adapter、OTLP 的 node-http transport、worker 线程、独立进程都不经过它。README 需要写明。
- WebSocket 握手经过它，握手之后的消息不经过。所以除明确放行外，网关拒绝升级与 `CONNECT` 隧道（ADR-0025）；Codex 因此回落到 SSE。
- 宿主升级改 undici 版本或 dispatcher 契约时，要重新跑端到端测试复验。
- 安装顺序有风险：`dsh-http-proxy` 若晚于本插件安装，会把本插件顶掉；靠自检修复（每秒一次，经过网关的请求也会先自检，ADR-0012），自检间隔内的请求不受保护。

### 补充（2026-11-11）：字符串 `input` 与 `prompt` 也算模型请求

形状白名单原先只认数组：`messages`（Chat Completions）、`input`（Responses）、`contents`（Gemini / Vertex）。embeddings 的字符串 `input` 与 completions 的字符串 `prompt` 不匹配，`maskJSON` 返回 null，dispatcher 把 body 原样发出：没有脱敏，也没有记录或提示。这是形状判定的盲区，不是有意的放行。

现在字符串 `input` 与字符串 `prompt` 也按模型请求处理：其中的字符串走与其它字符串相同的查找器、动作和已知值逻辑。其余 JSON body 仍然不算模型请求，原样发出；非 JSON content-type 也不读。不认识的形状仍静默放行——判断 host 是否模型服务没有可靠依据，加告警会把普通 API 请求写成脱敏记录。README 写明覆盖范围。
