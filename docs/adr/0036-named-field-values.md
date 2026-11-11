# ADR-0036：具名赋值里的纯字母与纯数字值

- 状态：Accepted（2026-11-11）
- 相关：`src/redact/checks.ts`、`src/redact/rules.ts`、ADR-0031、ADR-0033

## Context

`SECRET` 的具名赋值规则（`DB_PASSWORD=…`、`{"api_key": …}`、`token = …`）用 `secretValue` 判定值，要求同时含字母和数字。这个门槛对自由文本是合理的（避免把长单词当密钥），但字段名已经写明它是密码或密钥时就没有道理：`DB_PASSWORD=correcthorsebatterystaple`、`password=8291374651` 都不脱敏。中文「密码：…」路径用的 `keyValue` 反而更宽（纯字母 ≥16 即可），两条路径不一致。

## Decision

- 具名赋值规则改用 `namedValue`：`keyValue` 的语义（字母 + 数字，或纯字母 ≥16），再加纯数字 ≥10。
- 规则的位置判定改用 `namedAt`：`fieldAt` 之外，允许「纯数字 ≥10 且不在文件上下文里」的值。纯数字在别处会读成行号（`token.go:L643`），但在 `password=` 后面它是密码。
- 自由文本的密钥规则继续用 `secretValue` 与 `fieldAt`，不因此放宽。

## Consequences

- 长口令与纯数字口令不再漏；`token=1234567890` 这类 10 位数字会被脱敏，是接受的误报面。
- 短于 8 个字符仍然不算值（ADR-0031），算法名仍不算值（ADR-0033）。
- 少数字段（如 `max_tokens=4096`）不会被误伤：位数不够，且字段名不在密钥名单里。
