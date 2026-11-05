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

## 补充（2026-11-05）：对象与按名索引的 dict 分开认

`cookie={…}` 后面那个对象既可能是「按 cookie 名索引的 dict」（`{"BDUSS": "…"}`），也可能是 cookie 对象（`{"name": "…", "value": "…", "domain": "…", "expires": "…"}`）。原来的实现一律按 dict 逐对取，于是对象的 `domain`、`expires`、`path` 被当成 cookie 值脱敏（与本节「只脱敏 `value`」相违），对象后面跟着的别的 JSON（记录文件里的一条 `{"key": …, "time": …}`）也被一起当成 cookie 对，`time`、`host`、`session` 这些字段的值因此进了知识表，之后在任何请求里以 `known` 命中。线上表现为：`127.0.0.1`（`http://127.0.0.1:61216` 这类 URL 里的地址）被学成 cookie 值，此后每个会话的地址都被换成同形假值，记录里看着像「COOKIE 却是个 IP/域名」。

- 只有带 `name` 与 `value` 两个字段的对象才算 cookie 对象，也只脱敏它的 `value`；其余 `{…}` 才按 cookie 名索引的 dict 处理。
- 对象的范围按配对的 `}` 找，引号里的 `}` 不算结束（原来取第一个 `}`，会把后面的 JSON 圈进来）。
- 值的字面量才脱敏：`"value": value`（变量）没有值可脱。
