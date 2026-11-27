# dsh-privacy-gateway

[English](README.en.md) | 简体中文

![模型只看见 ⟦DSH_REDACTED:…⟧：密钥、凭据、个人信息发出前换成占位符，回复里的占位符可换回原值（默认不换），一处拦截，每个走全局 fetch 的模型请求都经过它](docs/assets/screenshots/0-banner.png)

在宿主进程的 undici 全局 dispatcher 上装一层脱敏网关。出站把模型请求体里的密钥换成占位符；入站默认让回流里的占位符原样进会话日志，不会将回复里的占位符还原成真值，打开 `restoreLog` 才换回真值。对 adapter、provider 无感；agent 在默认关闭时拿到的是占位符，打开 `restoreLog` 后与以前一样拿到真值。一处拦截覆盖所有走 `fetch()` 的 provider，包括插件提供的 adapter。

如果你在用**中转站**或者在处理**敏感信息**、**线上数据**，请务必注意保护信息安全。

**[能力边界](#能力边界)**：

- 这是一个轻量级实现，只对请求体与回复里的文本做脱敏。对话附件里的文件（Word、Excel、PPT 这类文档）、图片、压缩包等都不解析、不脱敏，原样发出。
- 如果模型被诱导写出把数据外发的脚本，插件不拦：`restoreLog` 打开时 `toolGuard`（默认 `off`）也只覆盖「还原值 + 非本机 host」这一种外带，裸域名、先写文件再推送这些都拦不住。

## 安装

```bash
# 正式版（npm）
dsh plugin --profile web add dsh-privacy-gateway@latest

# 同一版本的 GitHub Release 附件（预发布也发在这里）
dsh plugin --profile web add https://github.com/xbzbing/dsh-privacy-gateway/releases/download/v0.4.0/dsh-privacy-gateway-0.4.0.tgz
```

预发布版本号带 `-`，只发 GitHub Release、不发 npm。仓库不提交 `lib/`，`dsh plugin add github:…` 拿到的树加载不了（[ADR-0006](docs/adr/0006-distribution-and-build-artifacts.md)）。

在默认的 web profile 里首次安装即装即用，无需重启 dsh 实例。通过 dsh web profile 的插件更新功能更新插件时，无需重启 dsh 实例。手动更新时建议先卸载旧版本再安装新版本，这样也不需要重启。

## 功能

- **脱敏范围**：密钥、token、密码、私钥、cookie、邮箱、手机号、身份证、银行卡、自定义敏感词，各有开关。
- **动作可选**：按 kind 选 `mask` / `warn` / `block`，密钥可换成同形的假 key（`shape`）。
- **回复不写回真值**：默认不还原，回复里的占位符原样进会话日志，不会将回复里的占位符还原成真值；打开 `restoreLog` 才把真值写回，agent 同时拿到真值。
- **记录与统计**：按天落盘的脱敏记录、统计卡、会话「隐私保护」标签页；记录里只有占位符，没有真值。
- **`/privacy` 命令**：查状态、临时开关、`test` 预览一段文本会怎样发出。
- **配置热更新**：日常项在插件页上改，下一次调用即生效；脱敏出错时请求不发出。

## 原理

网关只有这一个拦截点，出站与入站都在 HTTP 层完成：

```mermaid
flowchart LR
  A["agent / adapter<br/>（走全局 fetch）"] -->|"① 模型请求"| G["隐私网关<br/>undici dispatcher"]
  G -->|"② 密钥、凭据、个人信息、<br/>自定义词换成占位符"| M["模型服务"]
  M -->|"③ 回复（含占位符）"| G
  G -->|"④ 默认：占位符原样"| L["agent 与会话日志"]
  G -->|"④ 打开 restoreLog：换回真值"| L
  G -.->|"只记元信息，不含真值"| R["脱敏记录 / 统计"]
  G -.->|"占位符 ↔ 真值"| T["值表（只在内存）"]
```

- **出站（①②）**：请求体里命中规则且未被豁免的值换成占位符，映射只留在内存的值表里，同一个值每轮都是同一个占位符。受保护区域、`allow`、关闭的类别与未命中内容仍按原文发出。
- **入站（③④）**：`restoreLog` 关闭（默认）时占位符原样交给 agent、原样写进会话日志；打开后在日志落盘前换回真值，agent 与日志都拿到真值——回复方向只有这一个还原点，两边必然一致。
- **旁路**：记录、统计与 `overview` 返回安全投影，不写已脱敏值的完整原值；上下文和 host、model 等展示字段也单独清洗。`vendorView` 返回的是发出内容副本，受保护区域、`allow` 与未命中内容仍可能含敏感原文，不能按「无秘密」的数据处理。

## 脱敏范围

| kind | 内容 | 开关 |
| --- | --- | --- |
| `API_KEY` | OpenAI / Anthropic `sk-…`、GitHub / GitLab 令牌、Google `AIza…`、Slack `xox…`、Stripe、AWS `AKIA…`、阿里云 `LTAI…`、腾讯云 `AKID…`、Hugging Face、Groq、xAI、npm、PyPI、DigitalOcean、SendGrid 等前缀 | `secrets` |
| `TOKEN` | JWT | `secrets` |
| `PRIVATE_KEY` | PEM 私钥块 | `secrets` |
| `PASSWORD` / `SECRET` | URL 里的密码、名为 password / secret / token 的字段、中文「密码为…」「密钥是…」 | `secrets` |
| `COOKIE` | `Cookie` / `Set-Cookie` 头、`curl -b`、cookies.txt、Playwright storageState、HAR、常见会话 cookie 名（`BDUSS`、`JSESSIONID` 等） | `secrets` |
| `EMAIL` / `PHONE` / `ID_CARD` / `BANK_CARD` | 邮箱、大陆手机号、身份证号（校验位）、银行卡号（Luhn） | `personal` |
| `TERM` | 配置里 `words` 列出的词 | 有词就脱敏 |

脱敏过的值在请求的其它地方再出现，也按同一个占位符脱敏（finder 记为 `known`），`url` / `image_url` 里的也算；带签名的 URL（S3 预签名等）原样发出，改了会失效（[ADR-0004](docs/adr/0004-protected-regions.md)）。同一个 host 重发的历史保持原来的字节，prompt cache 照样命中。

照着试：下面每行都是**假值**，复制进会话发出去，统计卡的对应记录里就会出现替换后的占位符。记录与统计不写已脱敏值的完整原值；vendorView 的非豁免命中值和 warn 值也会清洗，但受保护区域、`allow` 与未命中内容可能仍含原文。默认不还原只约束模型回复里的占位符：你粘贴的原文已在出站前写进会话日志，不会因开启本插件而消失（[ADR-0003](docs/adr/0003-restore-before-session-log.md)）。

```text
sk-proj-Zq7Lr2Vt9mK1Px3aB5cD8eF0gH4jN6wY                             → API_KEY
ghp_Zq7Lr2Vt9mK1Px3aB5cD8eF0gH4jN6wYQ7RT2W                           → API_KEY
AKIAQ7RT2W9KLM4NP8XZ                                                 → API_KEY
Authorization: Bearer Zq7Lr2Vt9mK1Px3aB5cD8eF0gH4jN6wY9f2kLm4pQr7sT  → TOKEN
DB_PASSWORD=Zq7Lr2Vt9mK1Px3aB5cD8eF0gH4jN6wY9                        → SECRET
postgres://app:Zq7Lr2Vt9mK1Px3aB5cD8eF0gH4jN6wY9@db.internal/x       → PASSWORD
Cookie: BDUSS=Zq7Lr2Vt9mK1Px3aB5cD8eF0gH4jN6wY                       → COOKIE
someone@gmail.com                                                    → EMAIL
13800138000                                                          → PHONE
11010519491231002X                                                   → ID_CARD
```

- 中文写法「密码：…」「密钥是 …」和 URL 里的密码记为 `⟦DSH_REDACTED:PASSWORD_p7gqwtns⟧`，和 `SECRET` 分开记。
- `EMAIL`、`PHONE`、`ID_CARD`、`BANK_CARD` 默认不换，打开「脱敏个人信息」才生效。
- 「自定义敏感词」里的词按词替换，记为 `TERM`；「永不脱敏的值」和 `allow` 里的原样发出。
- 私钥整段一起换：`-----BEGIN` 到 `-----END`，或只有开头一段 base64 的截断私钥。
- 文档域名（`example.com`、`.example`）不算邮箱；手机号要 11 位、身份证要过校验位、银行卡要过 Luhn，否则不换。
- 字段的值是一个文件名时不是密钥：只由文件名的字符组成、且扩展名是已知的文件类型（模型权重 `safetensors`/`gguf`/`ckpt` 等、压缩包、图片音视频、文档数据），原样发出（[ADR-0026](docs/adr/0026-file-name-values.md)）。
- 具名 YAML `|` / `>` 块和完整 TOML 三引号字符串中，简单 ASCII 字段名总长不超过 256、每个非空行都是不超过 1024 字符的连续 token 时，按行沿用具名规则脱敏；块头、引号、缩进、换行及后续字段不动，finder 仍为 `rule`。不拼接分段值，不处理多词口令或 TOML 内部转义/续行重组（[ADR-0036](docs/adr/0036-named-field-values.md)）。
- 同一个值重复出现，占位符相同。
- 短于 8 个字符的秘密（`abc123`、`666666`、`888888` 这类口令）不算值：照原样发出，也不进记录。它们随时能被爆破，遮住只是给人一种并不存在的保护；值表本来也不把这么短的值当作已知值（[ADR-0031](docs/adr/0031-no-short-or-template-values.md)）。
- 明显是占位写法的值不算值：8 个以上相同字符连排（`sk-proj-xxxx…`、`AKIA0000…`），或自带「这是占位」说明（`your_api_key`、`example`、`changeme`、`placeholder`、`dummy`、`***`）。随机 key 出现 8 连排的概率低于十亿分之一，`sk_test_…` 这种真测试 key 照旧脱敏（[ADR-0031](docs/adr/0031-no-short-or-template-values.md)）。
- 加密算法的名字不算值：`SCRAM-SHA-512`、`PBKDF2WithHmacSHA256` 这类名字写在规范里、人人可读，遮住什么都不保护，原样发出（[ADR-0033](docs/adr/0033-algorithm-names.md)）。
- 键名和值一样脱敏：`{"metadata": {"sk-…": …}}` 里的键名也换成占位符，`restoreLog` 打开时回复里再换回来；协议自身的键（`model`、`role`、`type`、`name`、`id` 等）、工具定义和工具调用的参数名不动（[ADR-0029](docs/adr/0029-mask-json-keys.md)）。

## 能力边界

网关只在一个位置动手：**模型请求出站的那一刻**。它不判断语义、不改宿主行为、不改已经落盘的内容。下面是它覆盖的与不覆盖的。

### 能做的

| 通道 | 现在 |
| --- | --- |
| 模型请求体 | 走全局 `fetch()` 的 POST JSON 请求（数组 `messages`、数组或字符串 `input`、`contents`、字符串 `prompt`）：命中规则的值换成占位符，压缩的先解压（[ADR-0001](docs/adr/0001-intercept-at-undici-global-dispatcher.md)、[ADR-0025](docs/adr/0025-compression-and-upgrades.md)） |
| 模型回复 | 同一条连接的响应：SSE 流与整段 JSON，跨分片、压缩、`\u27e6` 转义都能还原；`restoreLog` 打开时才写回日志 |
| 覆盖的 provider | 所有走 `fetch()` 的 adapter，包括插件提供的；`excludeHosts` / `excludeProviders` 可以放行 |
| 出错时 | 脱敏出错、认不出的 `content-encoding`、模型调用上的 `upgrade` / `CONNECT` 一律不发（[ADR-0005](docs/adr/0005-fail-closed.md)） |
| 旁路 | 记录、统计和 `overview` 不写已脱敏值的完整原值；`vendorView` 的发出内容副本仍可能含豁免或未命中的敏感原文（[ADR-0008](docs/adr/0008-masking-records.md)、[ADR-0016](docs/adr/0016-vendor-view.md)） |

### 做不到的

按最容易被误以为做了的顺序排：

| 场景 | 现在 | 后果 |
| --- | --- | --- |
| 你自己发的话 | 发送时就落盘，早于网关 | **会话日志里是你输入的原文**；只有出站那一刻才换成占位符（[ADR-0003](docs/adr/0003-restore-before-session-log.md)） |
| 工具结果 | 工具返回后落盘 | **会话日志里是工具输出的原文**；下一次出站才脱敏 |
| 图片、文件、base64 附件 | 没有规则认它，原样发出 | 截图、扫描件、附件内容会到模型服务；`multipart`、表单、非 JSON body 更是一律原样发出，也不留记录 |
| `node:http` 直连、worker 线程、独立进程 | 不经过网关 | 这些路径上的请求没有占位符，也没有记录（[ADR-0001](docs/adr/0001-intercept-at-undici-global-dispatcher.md)） |
| 请求头、URL、方法 | 只改 body，以及随之变化的长度与编码头 | `Authorization` 这类头里是 provider 自己的凭据，改了会认证失败；query 参数同样不动 |
| 别的出站通道 | 不管 | 别的插件自己发消息、写文件、连自己的服务，都不经过它；走 `fetch()` 但不是模型请求的，原样放行 |
| 已经落盘的历史 | 不改 | 升级前写进日志的内容保持原样 |

### 认得出来的形态有限

- 规则没命中的密钥不脱敏：自定义格式的令牌、加密或编码后的密文、拆成多段的片段。
- 故意不脱敏的：短于 8 个字符的值、占位写法（`sk-…xxxx`、`changeme`）、算法名（`SCRAM-SHA-512`）、像文件名的值（[ADR-0031](docs/adr/0031-no-short-or-template-values.md)、[ADR-0033](docs/adr/0033-algorithm-names.md)、[ADR-0026](docs/adr/0026-file-name-values.md)）。
- 没有语义判断：只有规则和词表。客户名、项目代号、内部术语要自己加进 `words`；漏检和误伤都可能存在。
- 字段名里带 secret 词的源码常量可能被具名规则当成值脱敏（值其实是名字）：末位是容器词（`header`、`id`、`file`、`name`…）的字段名下、小写且以 `-`/`_` 分段每段短于 16 字符的协议型 slug 已不再误判（[ADR-0038](docs/adr/0038-container-field-slug-values.md)），其余的确认后放进 `allow`。
- 脱敏按连续字符串匹配：hex 转储、编码或拆分后才拼出的值不重组；具名 YAML/TOML 块里的连续 token 可逐行匹配，但不等于解码或还原整块的语义值——同一份文件经文本工具和 hex 工具读到的内容仍可能不一致。
- 图片不做 OCR，二进制内容原样发出。

### 不负责的事

- 不拦截工具拿到真值之后的动作（`restoreLog` 打开时）：模型被诱导把占位符写进 `curl` 之类的命令，工具执行时用的就是真值；插件只记账，`toolGuard` 可选告警或拦那一次调用（[ADR-0014](docs/adr/0014-tool-guard.md)、[ADR-0009](docs/adr/0009-value-table-and-restore-exfiltration.md)）。
- 不跨进程共享值表：每个进程自己的值表，重启清空；重启后规则命不中、只靠记忆兜住的值第一次出站按原文发出（[ADR-0009](docs/adr/0009-value-table-and-restore-exfiltration.md)）。
- 不做合规认证、不做出口审计：记录只能说明「发生过替换」，不能说明「没有遗漏」。
- 不做静态数据保护：它保护的是发往模型的那一份，不是磁盘上的会话日志、备份或导出的文件。

## 界面

| 插件配置 | 会话「隐私保护」 |
| :---: | :---: |
| ![插件配置：总开关、脱敏密钥与凭据、个人信息、同形假 key、工具调用外发保护，以及词表、记录、标签页与 provider](docs/assets/screenshots/1-plugin-config.png) | ![会话「隐私保护」标签页：本会话脱敏开关、今日 / 7 天 / 30 天统计、按 kind / finder / host 的分布与最近记录](docs/assets/screenshots/2-privacy-panel.png) |

## 配置

插件页面里本插件那一行的「配置」页上可以直接改日常项：`enabled`、`secrets`、`personal`、`shape`、`toolGuard`、`restoreLog`、`maskKeys`、`words`、`allow`、`record`、`keepDays`、`recordContext`、`vendorView`、`showPanel`、`excludeProviders`。改了即时保存，从下一次模型调用起生效，不用重启（[ADR-0021](docs/adr/0021-live-settings.md)）。其余项在 profile 的 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里改，写在 `id: dsh-privacy-gateway` 那一行的 `config` 下；插件包自带的 `cordis.patch.yml` 升级时会被覆盖，不要改它。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关掉后网关仍在，但所有请求原样放行，不还原、不记录 |
| `secrets` | `true` | 脱敏密钥、令牌、密码、私钥、cookie |
| `personal` | `false` | 脱敏邮箱、手机号、身份证号、银行卡号 |
| `words` | `[]` | 自己的词（项目代号、客户名），按原样换成 `TERM` 占位符 |
| `allow` | `[]` | 永不脱敏的值：整值匹配，不分大小写 |
| `actions` | `{}` | 按 kind 选动作：`mask`（默认，换成占位符）、`warn`（照发并记一条）、`block`（整个请求不发）。例：`{ PRIVATE_KEY: block, EMAIL: warn }`（[ADR-0013](docs/adr/0013-actions.md)） |
| `maskKeys` | `true` | 读起来像密钥或个人信息的 **JSON 键名**也换成占位符（`{"sk-…": …}`）；协议自身的键（`model`、`role`、`type`、`name`、`id` 等）、工具定义和工具调用的参数名永不动，否则供应商读不懂请求。关闭后这类键名原样发出（[ADR-0029](docs/adr/0029-mask-json-keys.md)） |
| `toolGuard` | `off` | 工具调用参数里还原出值、又指向本机以外的 host 时怎么办：`off` 只计数，`warn` 告警并记一条，`block` 这次调用的参数里不还原，工具拿到占位符。只有 `restoreLog` 打开时回复里才会有还原值，关闭时这一项不会生效（[ADR-0014](docs/adr/0014-tool-guard.md)） |
| `restoreLog` | `false` | 回复里的占位符在写入会话日志前是否换回真值。默认关闭：占位符原样进日志，明文不进日志，agent 拿到的也是占位符；打开后日志与 agent 都拿到真值，会话同步、备份、分享、导出带走的也是真值（[ADR-0003](docs/adr/0003-restore-before-session-log.md)） |
| `shape` | `false` | 密钥换成同形的假 key（前缀、长度、字符类别不变），而不是 `⟦DSH_REDACTED:…⟧` 占位符；不足 8 个字符、或含字母数字与 `-` `_` `.` 以外字符的值仍用占位符；`restoreLog` 打开时回复里照样还原（[ADR-0015](docs/adr/0015-shape.md)） |
| `cookieNames` | `[]` | 追加要脱敏的 cookie 名 |
| `cookieKeep` | `['lang', 'locale', 'theme', 'tz']` | 永不脱敏的 cookie 名 |
| `protectEnvBlock` | `true` | `<env>` … `</env>` 块原样发出，供会校验它的 provider 使用；只保护宿主生成的文本（系统提示词、`system`、`instructions`、`systemInstruction`），用户消息和工具结果里的 `<env>` 不算（[ADR-0004](docs/adr/0004-protected-regions.md) 补充） |
| `protectTools` | `true` | 请求的 `tools` 数组原样发出 |
| `excludeHosts` | `[]` | 不改写的 `host` 或 `host:port` |
| `excludeProviders` | `[]` | 不脱敏的 provider id；「配置」页里从当前注册的 provider 中勾选。放行的请求原样发出、回复不还原、不留记录，有请求发出时日志里每个 provider 提示一次（[ADR-0018](docs/adr/0018-exclude-providers.md)、[ADR-0034](docs/adr/0034-log-excluded-provider.md)） |
| `maxValues` | `5000` | 内存值表上限，满了淘汰最老的一半 |
| `record` | `true` | 脱敏记录写盘；关掉只在内存里统计 |
| `keepDays` | `30` | 记录保留天数 |
| `recordContext` | `true` | 记录里每个值带上它出现过的每一处（用户消息、工具结果等，每值最多 8 处）和第一处前后各约 80 个字符，取自发出的内容，被脱敏的值都是占位符（[ADR-0024](docs/adr/0024-record-context.md)、[ADR-0028](docs/adr/0028-record-every-place.md)） |
| `keepMegabytes` | `100` | 记录总量上限（MB），超了从最老的一天删 |
| `keepRecords` | `500` | 内存里保留的最近记录条数 |
| `vendorView` | `false` | 在内存里留最近记录的请求实际发出的 body，统计卡里可以左右对照；最多 100 份、共 64 MiB，不落盘（[ADR-0016](docs/adr/0016-vendor-view.md)） |
| `showPanel` | `false` | 在会话顶部提供「隐私保护」标签页（对话 / 轨迹 / Git 之后），内容是本会话的记录与统计（[ADR-0017](docs/adr/0017-sidebar-panel.md)） |

## `/privacy` 命令

| 用法 | 作用 |
| --- | --- |
| `/privacy` 或 `/privacy status` | 开关状态、值表大小、今日 / 7 天 / 30 天的请求与替换计数、按 kind 和 finder 的分布、异常信号 |
| `/privacy off` | 本次运行内停止脱敏，请求按原文发出；不改配置，重启后恢复 |
| `/privacy on` | 恢复脱敏 |
| `/privacy test <文本>` | 按当前配置预览这段文本会怎样发出：脱敏后的文本和每个值的 kind、finder、开头、长度。不进值表，输入不写进会话日志；回答会进日志，未识别部分仍按原文显示 |

命令不会回显预览已识别的完整秘密；未命中规则或被 allow 放行的内容仍可能出现在回答和会话日志里。

## 记录与统计

只记有脱敏或还原的模型请求（`restoreLog` 关闭时没有还原，只记有脱敏的），一条请求一条：时间与耗时、host、model、会话及其工作区与标题、替换处数、每个值的占位符 / kind / finder / 开头 / 长度 / 出现过的每一处（每值最多 8 处，其余只计数）、请求所在的轮次与步数、值首次被发出的轮次与步数、回复里还原的处数（工具参数里的另计，`restoreLog` 关闭时恒为 0），以及值表里没有的占位符数。记录里不写值本身，也不记 URL 的 query（[ADR-0008](docs/adr/0008-masking-records.md)、[ADR-0020](docs/adr/0020-record-attribution.md)）。

「开头」只留辨识用的几个字符：有前缀的留下前缀和其后 4 个，没有的留前 4 个，长值再加末尾 2 个（`sk-proj-g6sx…3QaZ`），短值更少；个人信息和自定义词只留 1 个（[ADR-0019](docs/adr/0019-hint.md)）。

记录按天写入 `masking/YYYY-MM-DD.jsonl`，目录 0700、文件 0600；状态在当前实例自己的目录（`~/.dsh/profiles/<profile>/plugin-data/dsh-privacy-gateway/`），多实例互不影响（[ADR-0027](docs/adr/0027-per-instance-state.md)）。写盘失败只告警，不影响请求。

插件详情页下方有统计卡：今日 / 7 天 / 30 天，计数、按 kind / finder / host 的分布（每栏最多 6 条，其余合并成「其余 kind / finder / host」；悬停标题和名字有说明）和最近 200 条记录（每页 10 条）。点开一条看每个值：占位符、kind / finder、开头、长度、次数，以及它在哪条消息（`messages.3`）和前后文字，同一个值在别处也出现的会一并列出。每条记录标出这次请求在第几轮第几步发出（`42·3`，与「轨迹」一致，指**发出**的那一步），每个值还标出本次运行首次发出的位置。kind / finder 列头可筛选，只影响显示（[ADR-0035](docs/adr/0035-kind-finder-hints-and-filters.md)）。右上角「清空数据」确认后删除全部记录与统计，无法恢复（[ADR-0022](docs/adr/0022-reset.md)）。打开 `showPanel` 后同样的内容出现在会话顶部的「隐私保护」标签页，只统计当前会话；页头的开关可以只关这个会话的脱敏（[ADR-0023](docs/adr/0023-session-switch.md)）。

卡片下方的「记录查询」按范围（今日 / 7 天 / 30 天）与类型（全部 / 异常 / 未知占位符 / 外带风险 / 脱敏失败）读取保留期内的记录，不再受最近 200 条限制：一次查询分片读取按日文件，扫描未完时可以先看已确认的部分，再「继续扫描」，已发布的页不会随后续扫描改变。点开一条会重新从盘上读取并核对该行，文件被改写或清理后显示记录已不可用。查询只统计它真正读到的记录，与上方运行累计分开显示；未开启回复检测、记录只在内存、写入有缺口时都会写明，不把「没有记录」当成「没有风险」（[ADR-0039](docs/adr/0039-record-traceability.md)）。

打开 `vendorView`（配置页叫「保留发出内容，供对照查看」）后，记录明细多一个「查看发出内容」：左列标注替换处（kind · 开头 · 长度），右列显示发出的副本，warn 值也换成占位符。**受保护区域、`allow` 与未命中内容仍可能包含敏感原文，两列都不是无秘密的数据。** 副本与会话日志同等敏感，只留内存、不落盘（[ADR-0016](docs/adr/0016-vendor-view.md)）。

## 须知

- 从 0.1.x 升级上来：默认不再还原，agent 拿到的是占位符。需要旧行为（agent 与日志都拿到真值）时，在配置页打开 `restoreLog`（「会话日志写入真值」）。
- 会话日志默认是占位符：`restoreLog` 关闭（默认）时，回复里的占位符原样进日志，不会将回复里的占位符还原成真值，agent 拿到的也是占位符；打开后还原发生在日志落盘之前，日志与 agent 都是真值，会话同步、备份、分享、导出带走的也是真值（[ADR-0003](docs/adr/0003-restore-before-session-log.md)）。
- 压缩的请求先解压再脱敏；`restoreLog` 打开时压缩的回复也先解码再还原，关闭时压缩的回复原样穿过网关、由适配器按 `content-encoding` 自己解压（用 `undici.request` 直连的 adapter 要自己解压，`fetch` 会自动解）。请求里认不出的 `content-encoding` 不发（[ADR-0025](docs/adr/0025-compression-and-upgrades.md)）。模型调用里的 `upgrade` 握手（WebSocket）与 `CONNECT` 隧道也不发：Codex 第一次被拒后回落到 SSE，之后同一会话直接走 SSE；模型调用之外的升级与隧道（别的组件自己的连接）放行，消息不脱敏，每个 host 提示一次（[ADR-0032](docs/adr/0032-upgrade-scoped-to-masked-calls.md)）——这是 fail-closed 往 fail-open 的取舍，代价见 ADR；需要整条链路放行的 host 仍可加进 `excludeHosts`。
- 脱敏出错时请求不会发出，报错 `dsh-privacy-gateway: masking failed, request not sent`（[ADR-0005](docs/adr/0005-fail-closed.md)）。止血办法是 `/privacy off`，或在插件页停用本插件、把配置 `enabled` 设为 `false`。

## 开发

```sh
pnpm install
pnpm verify   # typecheck + test
pnpm build    # 产出 lib/：host 半 index.js 与 client 半 client.js（不入库）
```

从本地目录安装前先 `pnpm build`：

```sh
dsh plugin --profile web add file:/path/to/dsh-privacy-gateway
```

CI 与发布见 [ADR-0007](docs/adr/0007-release-process.md) 和 [.github/RELEASE_TEMPLATE.md](.github/RELEASE_TEMPLATE.md)。

## 约定

- 包名、cordis 行名、loader id、设置命名空间都是 `dsh-privacy-gateway`（行名必须等于包名）。
- 状态目录是当前实例自己的目录（`ctx.profileContext.dir` 下 `plugin-data/dsh-privacy-gateway/`），没有 profile 时退回 `~/.dsh/privacy-gateway/`；环境变量 `DSH_PRIVACY_GATEWAY_HOME` 优先于两者（[ADR-0027](docs/adr/0027-per-instance-state.md)）。
- 配置 schema 里不放 `.transform()` 或任何带回调的节点。
- `scripts` 里不挂安装期生命周期脚本。
- 其它 dispatcher 插件挂到网关下游时，按 [ADR-0012](docs/adr/0012-dispatcher-composition.md) 的合成契约（`chainTo`、`below`、`release`、`downstreams`）。
- 架构决策记在 [docs/adr/](docs/adr/README.md)。
- `README.en.md` 逐条跟随本文件。

## 致谢

脱敏功能的设计参考了 [magpie](https://github.com/yetone/magpie)：占位符的生成与还原、规则表、JSON 中保留不动的字段、转义 JSON 的处理都沿用它的语义，代码用 TypeScript 重写。

## 许可

[MIT](LICENSE)
