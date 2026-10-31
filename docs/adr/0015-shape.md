# ADR-0015：shape：密钥伪装成同形假密钥

- 状态：Accepted（2026-10-31）
- 相关：`src/redact/shape.ts`、`src/redact/known.ts`、`src/redact/mask.ts`、`src/redact/restore.ts`、magpie `internal/redact/shape.go`

## Context

占位符 `{{API_KEY_xxxxxxxx}}` 一眼能看出是被遮过的。模型会就此发问（「这个 key 看起来是占位符，请提供真实值」），agent 或工具对 key 的格式校验（前缀、长度、字符集）也会失败。magpie 的 `RedactShape` 用同形的假 key 代替占位符来解决这两点。

## Decision

- 配置 `shape`，默认关。开启后，密钥类的值（不含个人信息和 `TERM`）换成同形的假 key：前缀（`sk-proj-`、`ghp_`、`AKIA` 等）和分隔符 `-` `_` `.` 原样保留，其余每一位换成同类字符（大写、小写、数字；十六进制的 key 只用十六进制字符），长度不变。
- 只有至少 8 个字符、只含字母数字和 `-` `_` `.`、换掉的位不少于 6 位的值才伪装；其余仍用占位符。这样的假 key 碰巧出现在别处的概率可以忽略，放进 JSON 也不用转义。
- 假 key 由 HMAC(本机 key, `shape` NUL kind NUL 值) 派生，同一个值每轮都是同一个假 key，厂商的 prompt 缓存照常命中。带名字的值（`OPENAI_API_KEY=sk-…`）只伪装 `=` 之后的部分。
- 值表多一个假 key 的索引（按前 8 个字符分桶，加 gram 位图过滤）。还原时在占位符之外再把文本里的假 key 换回真值；流式回复末尾若是某个假 key 的前缀，扣到下一条事件。出站时文本里已有的假 key 不再当作新 key 遮一次。
- 假 key 与另一个值的假 key 撞车时，这个值改用占位符。
- 记录里 `placeholder` 字段存假 key；它和占位符一样由 HMAC 派生，不可逆。

## Consequences

- 模型以为拿到的是真 key，可能直接拿去调接口，得到 401。这和占位符的代价相同，只是更不容易被察觉。
- 统计卡和 `/privacy test` 里看到的是假 key，不再有 `{{…}}` 标记，要靠 kind 和 finder 认出它是被替换过的值。
- 关掉 `shape` 后，已经发出过的假 key 仍在值表里，回复里出现照样还原；重启后才清空。
