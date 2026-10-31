# ADR-0012：网关下游按角色排序，并公开合成契约

- 状态：Accepted（2026-10-31）
- 相关：`src/dispatcher.ts`、ADR-0001；oc2dsh（`dsh-opencode2free-provider`）的出口池

## Context

ADR-0001 让网关链在全局 dispatcher 前面，被顶掉时把顶掉它的 dispatcher 收到下游。原来的下游是一个「最后挂上的生效」的栈：

- 三层时顺序由安装时机决定。网关和 oc2dsh 的路由层都在之后，`dsh-http-proxy` 再装上，代理 agent 就成了下一跳，oc2dsh 被跳过；反过来，oc2dsh 要借用当时的下游才不丢用户的代理策略。
- 已经在栈里的层不能重新提到前面，也不能移除，只能 `close()` 后被跳过。
- 自检每 60 秒一次。被一个不经过网关的 dispatcher 顶掉后，这段时间里的请求不经脱敏。
- oc2dsh 依赖 `chainTo()`、`downstream()` 和下游的 `closed` / `destroyed` 字段，但这几项没有写成契约。

在请求入口自检（oc2dsh issue 的 S1）只对「顶掉网关、但请求仍会转回网关」的层有效；替换式的 dispatcher 不再把请求交给网关，入口自检看不到它。undici 把全局槽定义成不可配置的数据属性，也没法拦截写入。

## Decision

- 下游的每一层有角色：`route`（决定请求走哪，如 oc2dsh 的出口池）在前，`proxy`（建立连接，如 `dsh-http-proxy` 的 agent、网关安装时的原 dispatcher）在后；同一角色内后挂上的在前。请求交给第一个未关闭的层。
- 公开成员（插件之间的契约，类型从包入口导出）：
  - `chainTo(d, { role? })`：新层默认 `route`；已在下游的层再挂一次会排到同角色的最前，给了 `role` 就改角色。
  - `below(d)`：`d` 之后的第一个未关闭的层。route 层每个请求用它找下一跳，不必在挂上时借用一个固定的下游。
  - `release(d)`：移除一层，最后一层不能移除。
  - `downstream()`：下一跳，语义不变。
  - `downstreams()`：按顺序列出各层的 dispatcher、角色、是否已关闭，供自检与日志。
  - 下游的 `closed === true` 或 `destroyed === true` 视为已关闭，被跳过。
- 自检发现的、顶掉网关的 dispatcher 按 `proxy` 收进下游；已在下游的层保持原位和原角色。
- 自检间隔从 60 秒改为 1 秒（每次只比较两个引用）；另外每个经过网关的请求先自检一次。
- 请求经某层转回网关时，按层的身份找下一层；之后没有未关闭的层就报 dispatcher 循环。

## Consequences

- 安装顺序不再决定谁在前：route 层总在 proxy 层之前，用户的代理策略总在最里面。
- 替换式 dispatcher 造成的未脱敏窗口最长约 1 秒，没有降到 0。
- oc2dsh 现有的用法（不带角色的 `chainTo`、挂上前后各读一次 `downstream()`）行为不变；改用 `below()` 后，在它之后装上的代理也能被用上。
- 一个替换式插件如果其实是 route 层，会被当成 `proxy` 排在已有的 route 层之后；它要排到前面需要自己调 `chainTo(d, { role: 'route' })`。
