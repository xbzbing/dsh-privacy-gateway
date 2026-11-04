# ADR-0033：加密算法的名字不算值

- 状态：Accepted（2026-11-04）
- 相关：`src/redact/checks.ts`、`src/redact/find.ts`、ADR-0026、ADR-0031

## Context

用户在会话里发现工具输出的一处配置被改了：Kafka 配置 `'once_kafka_token.scram_mechanism': 'SCRAM-SHA-512'` 发出去时变成了 `PSUXH-ZRK-004`（`shape` 开着，换成了同形的假 key）。git 里的配置和渲染出来的配置都是 `SCRAM-SHA-512`，替换只发生在发送环节。

复盘替换记录：kind 是 `SECRET`、finder 是 `rule`、提示 `SCR…2`、长度 13。根因是字段名 `once_kafka_token.scram_mechanism` 含 `token`：命名规则（`rules.ts` 的 `SECRET_NAMES`）把它后面的值当成秘密，而 `SCRAM-SHA-512` 有字母也有数字，`secretValue` 放行，`fieldAt` 的各项排除（代码、路径、文件名、版本、skill 名）也都不拦。

算法的名字是规范里公开的词汇，对照一下就知道是什么；遮住它什么都没保护，只把配置改坏了——排查的人在工具输出里看到一串随机数，先怀疑配置被谁动过。

## Decision

- **加密算法的名字不是值**。与长度、占位写法同一处：`find.ts` 的 `takes()` 对秘密类规则命中的值过 `algorithmValue()`（`checks.ts`），不过就不发占位符、不记录、不进值表，所有规则、所有写法一次覆盖。
- `algorithmValue` 的判据是闭集词表：值的字符只能是名字的写法（字母、数字、空格与 `._+/-`），且拆出的每个词——数字断开、驼峰断开——都在 `ALGO_WORDS` 里（`scram`、`sha`、`aes`、`gcm`、`pbkdf`、`with`、`padding`、`tls`、`siv`、`poly`……一个家族一行）。`SCRAM-SHA-512` 拆出 `scram`、`sha`，`PBKDF2WithHmacSHA256` 拆出 `pbkdf`、`with`、`hmac`、`sha`，都放过。
- 词表与 `SECRET_WORDS` 不相交：真 key 的字符是随机的，拼不出词表里的词，所以 `api_key=justword256`、`token=ZEBRA-256` 照旧脱敏。

## Consequences

- `SCRAM-SHA-512`、`SCRAM-SHA-512`、`ECDHE-RSA-AES128-GCM-SHA256` 这类名字原样发出，不再进记录、统计和值表；字段名里有没有 `token`、`key` 都一样。
- 代价：一个真秘密若恰好整串都由算法词表的词和数字构成（拿 `aes-256-gcm` 当口令），会被放过。要求整串都是公开词汇，概率很低；取向与 ADR-0031 一致——宁可放过人人可读的写法，也不给统计一个虚高的保护数字。
- 词表没见过的算法名仍会被遮：遇到再往 `ALGO_WORDS` 补一个词，一行一个家族。
- 已知值（`known`）路径不变：修复前已经进值表的算法名在本次运行内还会按已知值匹配；值表只在内存里，重启（升级插件）后清空。
