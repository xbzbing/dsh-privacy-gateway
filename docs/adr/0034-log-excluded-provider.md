# ADR-0034：放行的 provider 有请求发出时，日志提示一次

- 状态：Accepted（2026-11-07）
- 相关：`src/providers.ts`、`src/dispatcher.ts`、ADR-0018、ADR-0032

## Context

ADR-0018 决定：`excludeProviders` 里的 provider 发出的模型请求原样送出，回复不还原，不留记录，也不进厂商视角。这是用户主动配置的放行，代价是这些请求里的真值直接到厂商。

问题在「事后看不见」：配置页只在这一项被勾选时静态写着「不脱敏」，但某个 provider 到底有没有请求走过这条路、什么时候走的，没有任何痕迹——记录里没有它（放行请求没有可记的值），统计卡与 `/privacy status` 也不统计。真值泄漏时，用户只能凭勾选状态猜。

其它几条放行路径都有声音：`enabled` 关掉有 `disabled by config`，`/privacy off` 有 `masking turned off by /privacy`，会话关闭脱敏有 `masking turned off for session …` 并且在「隐私保护」标签页里有提示，模型调用之外的升级连接是每个 host 一条 warn（ADR-0032）。只有按 provider 放行是全静默的。

约束：日志里不能出现被脱敏的真值（ADR-0008）；这是提示，不是策略——放行行为一点都不能改。

### 被否的备选

- **记一条脱敏记录。** 否：记录的含义是「这个请求脱敏了什么」，放行请求没有任何值可记；为它加一种没有 `values` 的记录，要动记录格式、统计口径和明细界面，还会把放行请求混进脱敏统计。
- **每个请求一条日志。** 否：模型调用一轮一次，长会话会把它刷满；升级连接用的是「同一个 host 一次」，这里同理。
- **统计卡上加「未脱敏的 provider 请求 N」。** 本次不做：这是界面项，按 AGENTS 要同步 `fields`、`locales`、Remote 返回值与测试，和 ADR-0032 记的「未脱敏的升级连接 N」是同一类后续工作。
- **在配置页提示。** 已有静态说明（`cfg.f.excludeProviders.hint`），它说的是「勾了就会这样」，回答不了「现在有没有真的这样」。

## Decision

- dispatcher 在「这条请求本来是候选（POST、JSON body、不是升级），但因为 `excludeProviders` 放行而不处理」时，通过 `providers.ts` 的 `bypassedProvider()` 取到它所属的 provider，写一条 warn：`requests of provider "…" go out unmasked (excludeProviders); this is said once for that provider`。
- 同一个 provider 本次运行只写一次：按 id 比较，不区分大小写（与排除匹配本身的规则一致，`DeepSeek` 与 `deepseek` 算同一个）；集合超过 32 个后清空，与升级连接按 host 记一次的写法同构。
- provider id 用 `JSON.stringify` 包一层再进日志：id 来自配置，里面有换行就能伪造日志行。
- 只提示，不改行为：请求照样原样发出，回复里不还原，不留记录，也不进厂商视角。
- 其它放行路径不在这条 warn 里：它们在开关处已经有日志（`enabled`、`/privacy off`、会话开关），`excludeHosts` 是按地址而不是按 provider 放行，没有 provider 可命名。

## Consequences

- 用户能从日志里看到「这个 provider 的请求确实原样发出去了」，而不是只看到勾选状态。
- 「一次」是进程级的：几个会话共用一个网关，日志里也只有这一条；把一个 provider 从列表里去掉再加回来，本次运行内不会再提示（名字记着），重启后重新提示。
- 日志里只有 provider id，没有值；这条 warn 不写记录，因此统计卡、`/privacy status` 与 Remote 返回值仍然看不到放行的请求（与 ADR-0032 记录的现状一致）。
- 放行判定本身没变：`#candidate` 拆成 `#maskable` + `#passes` 只是为了让「本该脱敏、但被放行」可判定，带会话 id、未排除的请求必须脱敏的回归测试仍然通过。
