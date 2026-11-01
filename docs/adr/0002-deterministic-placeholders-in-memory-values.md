# ADR-0002：确定性占位符，值只留内存

- 状态：Accepted（2026-10-31）
- 相关：`src/redact/key.ts`、`src/redact/known.ts`、ADR-0003

## Context

模型每一轮都看到完整历史：会话日志里是真值（ADR-0003），每次出站都要重新脱敏一遍。压缩请求、标题生成走的也是同一条链。

占位符如果每次随机生成，同一个值在不同轮次会变成不同占位符：历史逐轮不一致，厂商的 prompt cache 失效，模型也分不清两处是不是同一个值。反过来，把值落盘便于重启后还原，但磁盘上会多一份明文密钥。

## Decision

- 占位符是值的确定性函数：`{{KIND_xxxxxxxx}}`，`xxxxxxxx` 是 HMAC-SHA256(key, kind + NUL + value) 的前 8 个 base32 字符（小写）。语义照 magpie `internal/redact`。
- key 是 32 字节随机数，存在状态目录的 `redact.key`（文件 0600、目录 0700，`DSH_PRIVACY_GATEWAY_HOME` 可改；2026-11-01 起状态目录按实例隔离，见 ADR-0027）。存不下时用内存 key，并告警。
- 值表 `placeholder → value` 只在内存里，上限 `maxValues`（默认 5000），满了淘汰最老的一半。
- 已是占位符的位置不再脱敏：重复脱敏幂等。

## Consequences

- 同值同占位符，跨轮次、跨重启都稳定，prompt cache 不失效。
- 没有本机 key 就无法从占位符反推值，所以占位符本身可以写进记录和日志。
- 重启后值表清空：模型回复里出现重启前的占位符，而本次请求没再带出这个值时，还原不了。规则能命中的值会在下一次出站时重新入表。
- key 文件被删或换掉后，所有占位符都会变，厂商的 prompt cache 失效一次。
