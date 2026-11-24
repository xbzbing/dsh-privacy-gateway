# ADR-0038：容器字段名下的 slug 值是名字，不是值

- 状态：Accepted（2026-11-24）
- 相关：`src/redact/checks.ts`、`src/redact/rules.ts`、ADR-0036、ADR-0026、issue #4

## Context

issue #4：`export const GATEWAY_CREDENTIAL_HEADER = 'x-dsh-auth-gateway-…'` 被具名赋值规则判成 SECRET——`credential` 在字段名里（`SECRET_NAMES`），值又通过 `namedValue` 的「纯字母 ≥16」（ADR-0036 放宽后的门槛）。被遮的是 HTTP 头**名**，机密的是头的取值；`shape` 打开时它被换成同形假名，评审 agent 据此得出「头名是随机不可读的」错误结论并公开发表，同一个文件用 `xxd` 读又能解出真值，两种读法不一致。

只看值形状分不开要放行的名字（`x-dsh-auth-gateway-…`）与 ADR-0036 要遮的口令（`avpirux-qtolu-…`）：都是小写、连字符、无数字。能分开它们的是**字段名**：前者的密语词 `credential` 不在名字末位——`HEADER`、`ID`、`FILE` 收尾的名字是容器，装的通常是一个标识；`DB_PASSWORD`、`api_key`、`token` 这类密语词收尾的名字，值就是密语本身。

## Decision

- 具名赋值的 `namedAt` 在 `fieldAt` 通过后加一道豁免：字段名的**末位词不在 `SECRET_WORDS` 里**、且**值是 slug**（`slugValue`：全小写、以字母开头、按 `-` `_` 分段且每段非空、小于 16 字符）时，不算值，原样发出。
- 中文与「为 / 是」路径（`keyAt`）不豁免：那些名字的词本身就是密语词，值永远是密语，ADR-0036 的门槛原样保留。
- `slugValue` 与 `notASlug` 分工：`notASlug` 是 `sk-` 规则的宽测试（单段短词也算 slug），`slugValue` 只认分段的、无数字无大写的形状；`sk-` 规则不动。

## Consequences

- 放行的类收窄为：密语词不在末位的字段名（`*_HEADER`、`*_ID`、`*_FILE`）下、小写无数字的分段值——协议型 slug 与代号，issue #4 的误伤消失；`allow` 仍是兜底。
- 仍然脱敏的：值含数字或大写、单段 ≥16 字符（ADR-0036 的 `correcthorsebatterystaple` 不受影响）、密语词收尾的字段名（`DB_PASSWORD=` 下的口令，含 ADR-0036 测试里的连字符口令，断言原样保留）、URL 口令与自由文本路径不变、中文路径不变。
- 残余漏报面是「容器字段名 + 恰好小写分段无数字的真实口令」；issue 自己的方案只看值形状，连 `DB_PASSWORD=` 下的口令也会放行，本决策比它更窄。残余误伤面是「容器字段名 + 大写或带数字的非密钥值」，用 `allow` 放行，README 能力边界已写明。
