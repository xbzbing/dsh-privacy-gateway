# ADR-0032：升级连接只在模型调用里拒绝；其余放行、不脱敏

- 状态：Accepted（2026-11-03）
- 相关：`src/providers.ts`、`src/dispatcher.ts`、ADR-0018、ADR-0020、ADR-0025

## Context

ADR-0025 决定：带 `upgrade` 的请求（WebSocket 握手、undici 的 `upgrade()`）和 `CONNECT` 隧道一律不发，回 `DSH_PRIVACY_GATEWAY_UPGRADE_REFUSED`。理由是升级之后的字节流直接走 socket，不再经过 dispatcher，无法脱敏。当时针对的是 pi-ai 的 `openai-codex-responses` 用 `globalThis.WebSocket` 作默认传输，拒绝后它回落到 SSE。

「一律」把别的插件也误伤了。dsh-im-infoflow 的入站连接（如流开放网关推送：`/status`、卡片提交、单聊/群聊消息）是插件自己在模型调用之外用 Node 内置 WebSocket 建的 `wss://`：握手经全局 dispatcher，被网关拒绝后连接永远建不起来，入站全丢；它的出站（发消息、发卡）走普通 HTTPS 不受影响，所以卡片照常收到，故障面只在内网可见。

约束：宿主不可改，判定只能发生在 dispatcher 这一层。dispatcher 看到的是一条 HTTP 请求，不知道它是不是模型流量；`llm/stream` 瀑布知道，而且 `routeStream` 已经把适配器跑在同一个异步上下文里（ADR-0020 已靠它把会话 id 带到 dispatcher）。于是一条升级连接是不是「模型调用的传输」，在 `dispatch` 时是能问出来的。

**必须说清：改动前「没有上下文 ⇒ 拒绝」，改动后「没有上下文 ⇒ 放行、不脱敏」，是一次 fail-closed 到 fail-open 的反转。** 本仓自己记过「没有上下文不等于不是模型流量」：ADR-0018 写明「适配器若在流之外预先发起请求（例如挂载时的模型探测），这些请求没有上下文，照常脱敏」——HTTP 方向至今如此（`#candidate` 与 `skip` 都不依赖上下文）。本次在升级方向把同一类流量反了过来，代价是保护范围从「所有升级」缩到「经过 `llm/stream` 的升级」。这不是疏漏，是取舍；不取舍，infoflow 这类插件的入站就永远建不起来。

### 被否的备选

- **继续一律拒，让用户把 infoflow 的 host 加进 `excludeHosts`。** 否：`excludeHosts` 是按 host 的全量放行，会把同 host 上的模型请求也一起放开；还要求每个用户手工配置，默认开箱即坏。它为「一条插件自己的连接」付出的代价比本次取舍大。
- **不加标记，用「上下文是否存在」判定。** 否：Codex 的调用不命名会话，加上原来的短路，无会话调用根本没有上下文，模型调用的 WebSocket 会被放行——正好是本 ADR 要避免的那种泄漏。所以要一个显式标记，且必须删掉那条短路。
- **对「最近承载过脱敏模型流量」的 host 的调用外升级继续拒绝。** 暂不做：dispatcher 有 host 可见性，加一个最近 host 集合即可，但入站 host 与模型 host 相同的情形会被误拦。留作后续硬化，不在本次取舍里。

## Decision

- `CallContext` 改成可判别联合，两种上下文互斥：`{ kind: 'excluded'; provider; session? }`（排除的 provider 的流，放行）与 `{ kind: 'masked'; session? }`（模型调用）。`provider?: string` 加一个布尔标记的写法允许「既是排除、又是调用」这种自相矛盾的状态，而 AGENTS 里记着 `provider: ''` 曾被当成排除的历史坑。
- `routeStream` 对未排除提供方的调用**总是**跑在 `kind: 'masked'` 里，即使宿主没有命名会话。原「既无外层上下文、主机又没有命名会话就不设上下文」的短路删掉；`asModelCall`（原 `unbypassing`）除「离开排除的 provider」外，还负责打上这个标记。
- 网关拒绝升级的条件从「放行条件之外一律拒」改为「放行条件之外、**且当前上下文是模型调用**」。判定顺序是规则而非优化：**先问放行**（`#passes`：`enabled` 关、`/privacy off`、排除的 provider、关闭了脱敏的会话、`excludeHosts`），**再问调用**。颠倒过来会让「会话关闭脱敏」时模型调用的隧道仍被拒。
- 模型调用之外的升级（含 `CONNECT` 隧道）照常连接，打一条只含协议名与 host 的 warn：这条连接的消息不脱敏。同一 host 只 warn 一次，避免入站重连刷屏。
- 明确放行的情况不变。

## Consequences

- **保护范围收窄，方向是 fail-open**：升级连接只在「本该脱敏 + 模型调用里」时被拒；不在 `llm/stream` 上下文里建连的传输不再受保护。已知的例子：dsh-im-infoflow 的入站；`dsh-client-connection` 在 Node 侧开的出站 WebSocket（承载协议流量，其中的会话文本不再脱敏）；工具执行、插件初始化、socket 事件回调里开的连接——`within` 只把流迭代器自身的 `next/return/throw` 包进上下文，工具是在流结束之后才执行的，所以工具里开的 WebSocket 属于「调用外」，放行。
- dsh-im-infoflow 的入站不再被拦；连接后消息不脱敏，warn 会说明。
- Codex 的行为不变：模型调用里的 WebSocket 仍被拒，第一次后同一会话直接走 SSE。前提是握手确实发生；pi-ai 有按 session+account 的 socket 复用缓存，若某条 socket 是在脱敏关闭期间建好并被复用的，就没有握手可判——这是改动前已存在的行为，本次未改变。
- 模型调用之内、但不是提供方传输的升级（落在标记内的 `llm/stream` 中间件里自建的连接）仍被拒；需要放行就把 host 加进 `excludeHosts`。
- 无会话的调用现在也包一层 `AsyncLocalStorage.run`（每 chunk 一次，微秒级），换来的是升级判定不再依赖「宿主是否命名了会话」。
- 这些「放行且不脱敏」的连接目前只有日志可见。统计卡与 `/privacy status` 里加一个计数（「未脱敏的升级连接 N」）是后续界面项：按 AGENTS 要同步 fields、locales 与测试，另起 ADR。