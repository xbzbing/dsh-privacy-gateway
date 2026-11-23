# ADR-0037：占位符换成带命名空间的方括号记号

- 状态：Accepted（2026-11-23）
- 相关：`src/redact/placeholder.ts`、`src/redact/key.ts`、`src/redact/known.ts`、`src/redact/mask.ts`、`src/redact/restore.ts`、`src/redact/guard.ts`、ADR-0002、ADR-0015、ADR-0029、issue #2

## Context

占位符一直是 `{{KIND_xxxxxxxx}}`（ADR-0002），写法照 magpie `internal/redact`。这个形式和 Go template、Helm、Jinja2、Vue 的 `{{ }}` 插值完全同形，issue #2 报了两个后果：

- **agent 认不出它是占位符**。它看起来就是一个合法字符串，模型会把 `{{SECRET_kfs5x76z}}` 当口令传给 `openssl enc -d`，解密失败后得出「用户口令记错了」的结论，再花几轮排查根本不存在的全角字符问题。脱敏本身没错，错在没有任何线索告诉模型「这个值我拿不到」。
- **和被脱敏内容自身的语法撞车**。Lucky 之类工具的配置里本来就有 `{{SECRET_mpklbomv}}` 这样的模板变量；`PLACEHOLDER_RE` 把 `SECRET_mpklbomv` 认成自己的占位符，回复里再被 `STRICT` 数进 `unmapped`，统计卡长期挂一条「值表里没有的占位符（可能被模型改坏）」的假告警。

换记号的核心收益是**可识别性**，不是让 agent 拿到真值——真值本来就不该到模型那里。

### 被否掉的替代方案

- **`[REDACTED:KIND:hash]`**：可读性最好，但方括号与 Markdown 链接、JSON 数组、日志格式撞得比花括号更凶；而且 `⟧` 这类数学括号在正文里出现频率极低，边界更硬。
- **`placeholderSyntax` 配置项**：占位符是 host、值表、记录、vendorView、JSON 键、普通文本与流式还原共用的协议，做成两套意味着正则、容错、文档、测试全翻倍。安全插件应当减少分支，而不是把选择推给用户。
- **出站时在占位符旁注入「此值为脱敏占位符」的说明**：会污染 JSON、代码、工具参数与流式输出，还会进入厂商可见的请求体；命名空间本身已经承担这项职责。
- **保留旧格式双读**：两条协议并存意味着碰撞继续存在，issue #2 的第二个问题一点没解决。

## Decision

- 占位符是 `⟦DSH_REDACTED:KIND_xxxxxxxx⟧`：`⟦`/`⟧`（U+27E6/U+27E7）是严格边界，`DSH_REDACTED` 是固定命名空间，`:` 只出现一次，kind 与 hash 之间仍用 `_`。
- **kind 与 hash 之间不用冒号**。`KIND:hash` 正好是 `password=…`、`api_key: …` 的写法，SECRET 规则会命中原生占位符：实测 `⟦DSH_REDACTED:API_KEY:x⟧` 在值表为空时被换成 `⟦DSH_REDACTED:API_KEY:{{SECRET_…}}⟧`，值表里这个值的映射就丢了。`KIND_hash` 不会被任何规则命中，`test/placeholder.test.ts` 有一条断言盯着「占位符不得被自己的规则再次命中」。
- 协议集中在 `src/redact/placeholder.ts`：`format`（生成）、`kindOf`（取 kind）、`bodies`（识别）、`hasPlaceholder`、`tailLen`（流式尾部）。掩码侧、值表、还原侧、toolGuard 都从这里取，不再各写一份正则。
- **容错边界**：括号左右各允许 0 或 1 个，括号内允许空格与制表符，命名空间、kind、hash 都不区分大小写——模型把占位符写成 `⟦ dsh_redacted:api_key_xxx` 也认。**没有命名空间的一律不认**：`API_KEY_k3v9x2mq` 同时是一个名字和一个词，在那里放值只是猜；猜错会把值送到不该去的地方，而漏还原只是没还原。
- **掩码侧的「已是占位符」保护同样不区分大小写**，并且走解码后的视图：`\u27e6…\u27e7` 这种 JSON 转义形态也认（Python 的 `json.dumps(ensure_ascii=True)` 就这么写）。旧的正则在 `raw` 上找花括号，转义形态漏判时会套出嵌套占位符。
- `MAX_PLACEHOLDER` 从 37 变成 48（`⟦` + 12 + `:` + 24 + `_` + 8 + `⟧`），流式尾部上界跟着走。还原侧原有的 `includes('_')` 早退保留：占位符总含 `_`，它对占位符恒为真、对不含 `_` 的普通文本仍是一道便宜的跳过。`#placeholders` 另加了「`bodies` 找不到就是原文」的早退。
- 值表 `kindOf` 不再用 `slice(2, i)` 假设前缀恰好两个字符（`⟦` 只有一个码元），淘汰重建后 kind 仍然正确。
- 旧 `{{…}}` 不再是协议：不生成、不识别、不还原、不计 `unmapped`，按普通历史文本透传。它也不再享受「已是占位符就不重复脱敏」的保护——但它不含任何密钥形态，任何规则都不命中，所以是安全的。
- HMAC 输入与算法不变（`HMAC-SHA256(key, kind NUL value)` 的前 8 位 base32），同一个值仍是同一个 hash，只换外壳。

## Consequences

- agent 能一眼看出「这是网关取走的值」，不该拿去认证、解密或写入任何服务；issue #2 里那串错误推理的起点消失了。
- 业务模板里的 `{{…}}` 不再被误认，`unmapped` 的假告警消失。
- 升级边界：值表与已知索引只在内存（ADR-0002），升级必然重启、表必然清空，**没有需要迁移的映射**。旧会话里的 `{{…}}` 不再还原，重新出站的真值会建立新格式映射；发布说明需写明「升级后重启 DSH」。
- 磁盘上的旧记录只是字符串，界面照常展示。
- 占位符长 11 个字符（实际常见形态 20 → 31，`MAX_PLACEHOLDER` 37 → 48），token 增量可忽略。
- `shape` 的取舍更尖锐了：命名空间让占位符更显眼，模型更可能来要真值——但这是正确行为，它确实没有真值；`shape` 打开后反而看不出是假的，这一取舍保留在 ADR-0015。
- 旧 ADR（0009、0015、0029、0031）里的 `{{…}}` 是历史示例，现行格式以本 ADR 为准。
