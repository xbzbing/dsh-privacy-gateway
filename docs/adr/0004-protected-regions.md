# ADR-0004：受保护区域：`<env>` 块、工具定义与 keepIn 字段

- 状态：Accepted（2026-10-31）
- 相关：`src/protect.ts`、`src/redact/mask.ts`、配置 `protectEnvBlock` / `protectTools`

## Context

oc2dsh 的免费车道 gate 校验三样东西：payload、连接栈、session id。任何一样被破坏，请求都会收到 429，而且没有 `retry-after`。

网关是最下游：脱敏发生在 oc2dsh 的 `ensureFreeLaneShape` 之后，所以注入的 `<env>` 块和 `bash`、`read` 工具定义已经在 body 里。连接栈由 Bun relay 开出，session id 在请求头里，网关不碰这两样。会被网关改动的只有 payload。

此外，厂商按结构读取的字段被脱敏会直接 400：工具名、`call_id`、`signature`、`encrypted_content` 等。magpie 在 Codex、Ollama Cloud 上踩过这些坑。

## Decision

脱敏时跳过三类区域，其余字符串照常脱敏：

1. **`<env>` … `</env>` 块**：按字符区间跳过，不看内容（`protectEnvBlock`，默认开）。只有起始标记、没有结束标记时，保护到字符串末尾。
2. **顶层 `tools` 数组**：整个跳过（`protectTools`，默认开）。关掉时按 magpie 语义只脱敏 `description`。
3. **keepIn 字段**：magpie `json.go` 的 `kept` 表（`model`、`id`、`role`、`type`、`name`、`call_id`、`signature`、`encrypted_content`、`data` 等）与 `*_id` / `*Id`。工具调用参数里的键是工具自己的，不受这张表约束。

## Consequences

- gate 的 payload 半边保持不变，回归由单测守住：构造带 `<env>` 块与 `bash`、`read` 工具的 body，断言这两处脱敏后逐字节不变。
- `<env>` 块和工具定义里的密钥不会被脱敏。这两处是 oc2dsh 与宿主生成的内容，正常不含用户密钥。
- 要证明守卫是必要的，live probe 需要关掉 `protectEnvBlock` 做反例，确认表现为 429 且没有 `retry-after`。
