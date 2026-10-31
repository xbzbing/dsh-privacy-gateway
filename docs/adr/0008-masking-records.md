# ADR-0008：脱敏记录按天 JSONL 落盘，写失败放行

- 状态：Accepted（2026-10-31）
- 相关：`src/records.ts`、`src/engine.ts`、ADR-0003、ADR-0005

## Context

ADR-0003 让会话日志里留真值，于是「哪些值被遮过、遮了几处、发给了谁」在会话日志里查不到，需要一份独立的账。约束：

- 账本身不能变成泄密点：落盘的内容不能还原出值。
- 记账不能拖慢或打断请求。
- 命令和配置页要即时读，不能每次扫盘。

备选：只留内存（重启即丢，看不了 7 天、30 天）；写 SQLite（多一个原生依赖，与 magpie 的 JSONL 不一致）；每请求同步写（阻塞请求路径）。

## Decision

- 一次模型请求至多一条记录，在回复结束（或出错）时记下：时间、遮蔽耗时、用途（按路径分 chat / embeddings / count / search）、host（回环地址另标 relay）、model、会话 id（读 `x-opencode-session` 等 header）、替换处数、每个值一条（placeholder、kind、finder、head、len、n）、回复里还原的处数、值表里没有的占位符数。遮蔽失败的请求也记一条，标 `failed`。
- 记录里不写值本身。placeholder 是 HMAC 的截断，没有本机 key 不可逆；head 只留首字符、key 前缀或 cookie 名（2026-10-31 修订：长于 20 位的 `sk-` key 另留前缀后的 4 个字符，如 `sk-ab12`、`sk-proj-ab12`，用来区分不同的 key）；路径只记 pathname，不记 query（Gemini 的 `?key=` 不进账）。
- 落在 `~/.dsh/privacy-gateway/masking/YYYY-MM-DD.jsonl`（本地日期），目录 0700、文件 0600。超过 `keepDays` 天的删掉；总量超过 `keepMegabytes` 时从最老的一天删起，当天的文件不删。每小时最多清理一次。
- 内存留最近 `keepRecords` 条和 30 天内每天的汇总；启动时异步读回盘上的天数。
- 写盘异步、攒批（200 ms），失败只告警（10 分钟最多一次），请求照常返回。`record: false` 时只在内存里统计。

## Consequences

- 遮蔽失败 fail-closed（ADR-0005），记录失败 fail-open，两条线分开。
- 一条记录在回复结束时才落盘：进程在回复中途退出，这条记录会丢。
- 未经遮蔽的请求（不是模型请求、`/privacy off` 期间）不记账。
- 2026-10-31 修订：既没有替换、回复里也没有还原和未知占位符的请求不记账，记录只留脱敏与还原。统计里的「请求」因此是「记录的请求」，不再是全部模型请求数。
- 启动时读回 30 天的文件，最坏是 `keepMegabytes` 的量；读回在后台进行，不阻塞插件启用。
