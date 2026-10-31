# ADR-0010：COOKIE 按上下文识别，一个 cookie 值是一个值

- 状态：Accepted（2026-10-31）
- 相关：`src/redact/cookie.ts`、`src/redact/mask.ts`、设计稿 §5.5

## Context

magpie 没有 cookie 规则。会话 cookie 是登录凭据，常出现在 agent 读到的命令、抓包和浏览器导出里，但它的值没有固定形状：可能是随机串，可能本身是 JWT，可能里面带 `token=`。只按值的形状找，会漏掉随机串，也会把一个 cookie 拆成好几个占位符；`Set-Cookie` 的 `Path`、`Expires` 这类属性也会被误脱敏。

## Decision

- 按上下文找，不按值的形状找：
  - 键名含 cookie 的字段或头（`Cookie:`、`"cookie": "…"`）；`Set-Cookie` 只取第一对 `名=值`，属性不动；
  - `curl -b` / `--cookie` 的参数；参数里没有 `=` 时是文件名，不脱敏；
  - Netscape cookies.txt 的第 7 列；
  - Playwright storageState 与 HAR 里的 cookie 对象，只脱敏 `value`，`domain`、`path`、`expires` 不动；
  - 名单 cookie（`BDUSS`、`JSESSIONID` 等，加 `cookieNames`，以及 `__Secure-` / `__Host-` 前缀）在任何地方写成 `名=值` 时都脱敏，包括 URL 查询串。
- 值不足 8 个字符的不脱敏；`cookieKeep` 里的名字不脱敏（默认 `lang`、`locale`、`theme`、`tz`）。
- 一个 cookie 值是一个值：COOKIE 的发现与其它规则的发现重叠时，COOKIE 胜出，值里的 JWT 或 `token=` 不再单独出占位符。用户词（`words`）不受此限。
- 记录里 COOKIE 的 head 是 cookie 名，不是值的首字符：名字不是秘密，可以按名字统计。
- COOKIE 归 `secrets` 开关管，不另设开关。

## Consequences

- 一串 cookie 逐值占位、名字保留，还原后 `curl -b '…'` 与原文逐字节相同。
- 上下文之外、不在名单里的 cookie 值认不出来；要覆盖就把名字加进 `cookieNames`。
- 名单 cookie 的 `名=值` 在正文里出现也会被脱敏，代价是偶尔换掉文档里的示例值。
