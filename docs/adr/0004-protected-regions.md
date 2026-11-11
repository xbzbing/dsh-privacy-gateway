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

### 补充（2026-10-31）：只改被脱敏的字符

`<env>` 块在一个 JSON 字符串里，同一个字符串的别处有值被脱敏时，旧做法把整个字符串解码、替换后重新 `JSON.stringify`：`caf\u00e9` 变成 `café`，`\u003c` 变成 `<`，块的字节因此变了。现在脱敏结果是一组按解码后位置给出的替换，按位置拼回原来的 JSON 字面量，替换之外的字节（包括转义）一律不动。回归测试覆盖 OpenAI 的 `tools` 与 `functions`、Anthropic 的 `tools[].input_schema` 与块数组形式的 `system`、Responses 的 `instructions`，以及带转义的 `<env>` 内容，断言除了被换掉的值，输出与输入逐字节相同。

## Consequences

- gate 的 payload 半边保持不变，回归由单测守住：构造带 `<env>` 块与 `bash`、`read` 工具的 body，断言这两处脱敏后逐字节不变。
- `<env>` 块和工具定义里的密钥不会被脱敏。这两处是 oc2dsh 与宿主生成的内容，正常不含用户密钥。
- 要证明守卫是必要的，live probe 需要关掉 `protectEnvBlock` 做反例，确认表现为 429 且没有 `retry-after`。

### 补充（2026-11-11）：`<env>` 只在宿主写的文本里保护

原实现把 `envBlockRanges` 用在 walk 到的**每个**字符串上，只看内容、不看来源。用户消息、工具结果或工具参数里只要出现 `<env>`（甚至没有 `</env>`），其后的内容就会整段跳过脱敏、原样发给模型服务；`/privacy test` 的预览又用空保护区间，所以自检看不到这条旁路。

保护改为按来源判定：只有 `instructions`、`system`、`systemInstruction`，以及 `messages[i].role` / `input[i].role` 为 `system` / `developer` 的字符串才应用 `<env>` 区间。其余字符串照常脱敏。工具定义仍按 `under(path, TOOL_ROOTS)` 判定，本来就是按来源的。回归覆盖系统提示词、用户消息、`tool_result`、工具参数、无闭合标签和 Gemini 的 `systemInstruction`。

### 补充（2026-11-11）：`url` / `image_url` 只做已知值脱敏

`KEPT` 把 `url`、`image_url` 的整段字符串也挡在脱敏之外：供应商要按原样取图、取文件，改一个字符链接就失效。这个例外原本连已经脱敏过的值也一起放过：同一个密钥先在 `Authorization` 里换成占位符，下一轮出现在 `image_url.url` 的 query 里时原样发出，与 README「脱敏过的值在请求的其它地方再出现，也按同一个占位符脱敏」矛盾。

现在这两个键（工具参数和工具定义里的除外）只做已知值脱敏：查值表，把之前脱敏过的值换成同一个占位符；规则不再改写 URL，以免误伤路径、版本号或签名。带签名的 URL 整段原样发出：query 里出现 `X-Amz-Signature`、`X-Amz-Credential`、`X-Amz-Security-Token`、`X-Goog-Signature`、`X-Goog-Credential`、`Signature`、`sig`、`hmac`、`token`、`access_token` 之一即视为签名 URL。签名 URL 里出现已知值时仍会原样发出，这是有意的取舍：改了就取不到，而且签名本身通常就是那个 URL 的凭据。`data:` URL 不读。

代价：一个从未见过的密钥直接写在 URL 里仍然原样发出，这是原有行为；普通 URL 里重复出现的密钥不再泄露，签名 URL 保持可用。
