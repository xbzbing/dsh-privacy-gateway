# ADR-0038：容器字段名下的 slug 值是名字，不是值

- 状态：Accepted（2026-11-24）
- 相关：`src/redact/checks.ts`、`src/redact/rules.ts`、ADR-0036、ADR-0026、issue #4

## Context

issue #4：`export const GATEWAY_CREDENTIAL_HEADER = 'x-dsh-auth-gateway-…'` 被具名赋值规则判成 SECRET——`credential` 在字段名里（`SECRET_NAMES`），值又通过 `namedValue` 的「纯字母 ≥16」（ADR-0036 放宽后的门槛）。被遮的是 HTTP 头**名**，机密的是头的取值；`shape` 打开时它被换成同形假名，评审 agent 据此得出「头名是随机不可读」的错误结论并公开发表，同一个文件用 `xxd` 读又能解出真值，两种读法不一致。

只看值形状分不开要放行的名字（`x-dsh-auth-gateway-…`）与 ADR-0036 要遮的口令（`avpirux-qtolu-…`）：都是小写、连字符、无数字。能分开它们的是**字段名的末位词**：`DB_PASSWORD`、`api_key`、`token` 这类名字末位就是密语词，值是密语本身；`GATEWAY_CREDENTIAL_HEADER` 的末位是容器词 `header`——装的通常是一个标识，不是密语。

## Decision

- 具名赋值的 `namedAt` 在 `fieldAt` 通过后加一道豁免：字段名的**末位词在容器词表里**（`CONTAINER_WORDS`：`header`、`id`、`uuid`、`guid`、`file`、`path`、`name`、`url`、`uri`、`label`、`prefix`、`suffix` 及其复数，闭合词表）且**值是 slug**（`slugValue`：全小写、以字母开头、只按 `-` `_` 分段、每段短于 16 字符）时，不算值，原样发出。
- 用闭合词表而不是「末位词不是密语词」的反向判定：反向判定会把 `SECRET_V2`、`clientsecret`、`DB_PASSWORD_HASH` 这类名字也当成容器，让其下的值原样发出（PR #5 评审发现的漏遮回归）；闭合词表与文件名（ADR-0026）、算法名（ADR-0033）的既有做法一致。
- 中文与「为 / 是」路径（`keyAt`）不豁免：那些名字的词本身就是密语词，值永远是密语（ADR-0036 的门槛不变）。
- `slugValue` 与 `notASlug` 分工：`notASlug` 是 `sk-` 规则的宽测试（单段短词也算 slug），`slugValue` 只认 `-` `_` 分段、无数字无大写的形状，不动 `sk-` 规则。

## Consequences

- 放行的类收窄为：末位是容器词的字段名（`*_HEADER`、`*_ID`、`*_FILE`、`*_NAME`…）下、小写无数字的分段值——协议型 slug 与代号，issue #4 的误伤消失；`allow` 仍是兜底。
- 仍然脱敏的：值含数字或大写、单段 ≥16 字符（ADR-0036 的 `correcthorsebatterystaple` 不受影响）、容器词表之外的一切字段名（`SECRET_V2`、`token_v2`、`clientsecret`、`DB_PASSWORD_HASH`、`credential_phrase` 都仍遮，有回归断言）、密语词收尾的字段名、URL 口令与自由文本路径、中文路径——ADR-0036 的断言原样保留。
- 残余漏报面是「容器字段名 + 恰好小写分段无数字的真实口令」；issue 自己的方案只看值形状，连 `DB_PASSWORD=` 下的口令也会放行，本决策比它更窄。残余误伤面是「容器字段名 + 大写或带数字的非密钥值」，用 `allow` 放行，README 能力边界已写明。
