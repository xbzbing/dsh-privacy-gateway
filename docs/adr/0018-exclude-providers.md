# ADR-0018：按 provider 放行，指定的 provider 不脱敏

- 状态：Accepted（2026-10-31）
- 相关：`src/providers.ts`、`src/dispatcher.ts`、`src/index.ts`、`src/client/ConfigSection.ts`、ADR-0012、ADR-0017

## Context

有的 provider 不需要脱敏，例如本机或内网部署的模型。`excludeHosts` 能按 `host:port` 放行，但用户想的是 provider（设置里选的那一项），不知道它连哪个地址；多个 provider 也可能共用一个网关地址，按地址放行会连带放行别的 provider。

网关挂在 undici 的全局 dispatcher 上（ADR-0012），看到的是 HTTP 请求，不知道是哪个 provider 发的。provider 在上一层才知道：宿主每次调用模型都经过 `llm/stream` 瀑布，`options.provider` 就是 provider id。

## Decision

- 配置 `excludeProviders`，provider id 列表，默认空，不区分大小写。
- 插件监听 `llm/stream`。provider 在列表里时，监听器把 `next()` 返回的流放进一个 `AsyncLocalStorage` 上下文里跑，上下文记着 provider；流的创建和每一次 `next` / `return` / `throw` 都在上下文里执行。适配器的 `fetch` 在流里发起，上下文随 promise 一路传到 dispatcher。
- dispatcher 新增 `skip` 选项。请求到达时 `skip()` 为真，这个请求不算候选：body 原样发出，回复不还原，不留记录，也不进厂商视角。
- 监听器只读 `options`，不改它。LOOP 发起的请求是深冻结的，改了会抛错。
- `excludeProviders` 声明为 `.volatile()`，监听器每次调用时读当前值：改了不重新挂载网关，下一次模型调用起生效，正在进行的那一次不受影响。
- 插件详情页的配置一节里列出当前注册了适配器的 provider（`llm/listProviders`），每个一个勾选框；列表里有、但当前没有注册的 id 也列出来，标「当前未注册」，可以取消；另有一个输入框可以加任意 id（ADR-0021 去掉了这个输入框）。这一节从「面板」改名为「设置」。

## Consequences

- 放行只认经过 `llm/stream` 的调用。不经过 `llm` 服务直接发的请求（其他插件自己的 `fetch`）没有 provider 上下文，照常脱敏；要放行它们仍用 `excludeHosts`。
- 放行的请求把真值发给这个 provider，回复里如果出现别处见过的占位符，也原样留在回复里。
- 放行是无声的：记录里没有它，统计卡也不统计。有请求真的被放行时，dispatcher 写一条只含 provider id 的 warn，同一个 provider 一次（ADR-0034）。
- 在放行的流里再发起的嵌套调用会重新经过 `llm/stream`，按它自己的 provider 判定：不在列表里时，监听器让它的流退出放行上下文，照常脱敏。
- 放行要求 provider 的适配器在流里发起请求。适配器若在流之外预先发起请求（例如挂载时的模型探测），这些请求没有上下文，照常脱敏。
