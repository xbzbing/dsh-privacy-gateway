# ADR-0005：遮蔽失败时不发请求（fail-closed）

- 状态：Accepted（2026-10-31）
- 相关：`src/dispatcher.ts`

## Context

遮蔽器抛异常时只有两种选择：照原样发出（fail-open），或不发（fail-closed）。fail-open 等于静默把密钥发给厂商，与本插件的首要目标冲突。fail-closed 的代价是：插件的 bug 会让全部 LLM 流量中断。

## Decision

- 遮蔽器抛异常：不发这个请求，向调用方抛出带明确文案的错误（`dsh-privacy-gateway: masking failed, request not sent`）。pi-ai 会把它归一化成 provider 错误，agent 能看到。
- body 不可解析、不是 JSON、或不是模型请求：不是失败，原样透传。
- 读取请求 body 失败（调用方中途取消等）：把读取错误交还调用方，不发请求。
- 连续失败也不自动降级为放行；止血靠配置开关 `enabled: false`（P1 加 `/privacy off`）。

## Consequences

- 密钥不会因为插件 bug 静默外泄。
- 插件 bug 会表现为所有模型请求失败；止血路径必须在遮蔽失败时仍然可用。
- 备选「fail-open + 大声告警」已否决：它让插件 bug 直接变成密钥外泄。
