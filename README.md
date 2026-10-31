# dsh-privacy-gateway

[English](README.en.md) | 简体中文

DeepSeek Harness 插件：在宿主进程的 undici 全局 dispatcher 上装一层脱敏网关。出站把模型请求体里的密钥换成占位符，入站把回流里的占位符换回真值。对 agent、adapter、provider 都无感，一处拦截覆盖所有走 `fetch()` 的 provider，包括插件提供的 adapter。

状态：v0.1.0，首个正式版。

## 安装

```bash
# 正式版（npm）
dsh plugin --profile web add dsh-privacy-gateway@latest

# 同一版本的 GitHub Release 附件（预发布也发在这里）
dsh plugin --profile web add https://github.com/xbzbing/dsh-privacy-gateway/releases/download/v0.1.0/dsh-privacy-gateway-0.1.0.tgz
```

预发布版本号带 `-`，只发 GitHub Release、不发 npm。仓库不提交 `lib/`，`dsh plugin add github:…` 拿到的树加载不了（[ADR-0006](docs/adr/0006-distribution-and-build-artifacts.md)）。

在默认的 web profile 里首次安装即装即用，无需重启。更新时，只改 client 的版本立即生效；含 host 改动的版本需重启 dsh。

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

脱敏过的值在请求的其它地方再出现，也按同一个占位符脱敏（finder 记为 `known`）。同一个 host 重发的历史保持原来的字节，prompt cache 照样命中。

照着试：下面每行都是**假值**，复制进会话发出去，统计卡的对应记录里就会出现替换后的占位符。记录、统计、日志和 vendorView 副本里都没有原值，只有占位符和首尾几个字符。

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

- 中文写法「密码：…」「密钥是 …」和 URL 里的密码记为 `{{PASSWORD_p7gqwtns}}`，和 `SECRET` 分开记。
- `EMAIL`、`PHONE`、`ID_CARD`、`BANK_CARD` 默认不换，打开「脱敏个人信息」才生效。
- 「自定义敏感词」里的词按词替换，记为 `TERM`；「永不脱敏的值」和 `allow` 里的原样发出。
- 私钥整段一起换：`-----BEGIN` 到 `-----END`，或只有开头一段 base64 的截断私钥。
- 文档域名（`example.com`、`.example`）不算邮箱；手机号要 11 位、身份证要过校验位、银行卡要过 Luhn，否则不换。
- 同一个值重复出现，占位符相同。

## 界面

| 插件配置 | 会话「隐私保护」 |
| :---: | :---: |
| ![插件配置：总开关、脱敏密钥与凭据、个人信息、同形假 key、工具调用外发保护，以及词表、记录、标签页与 provider](docs/assets/screenshots/1-plugin-config.png) | ![会话「隐私保护」标签页：本会话脱敏开关、今日 / 7 天 / 30 天统计、按 kind / finder / host 的分布与最近记录](docs/assets/screenshots/2-privacy-panel.png) |

## 配置

插件页面里本插件那一行的「配置」页上可以直接改日常项：`enabled`、`secrets`、`personal`、`shape`、`toolGuard`、`words`、`allow`、`record`、`keepDays`、`recordContext`、`vendorView`、`showPanel`、`excludeProviders`。改了即时保存，从下一次模型调用起生效，不用重启（[ADR-0021](docs/adr/0021-live-settings.md)）。其余项在 profile 的 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里改，写在 `id: dsh-privacy-gateway` 那一行的 `config` 下；插件包自带的 `cordis.patch.yml` 升级时会被覆盖，不要改它。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关掉后网关仍在，但所有请求原样放行，不还原、不记录 |
| `secrets` | `true` | 脱敏密钥、令牌、密码、私钥、cookie |
| `personal` | `false` | 脱敏邮箱、手机号、身份证号、银行卡号 |
| `words` | `[]` | 自己的词（项目代号、客户名），按原样换成 `TERM` 占位符 |
| `allow` | `[]` | 永不脱敏的值：整值匹配，不分大小写 |
| `actions` | `{}` | 按 kind 选动作：`mask`（默认，换成占位符）、`warn`（照发并记一条）、`block`（整个请求不发）。例：`{ PRIVATE_KEY: block, EMAIL: warn }`（[ADR-0013](docs/adr/0013-actions.md)） |
| `toolGuard` | `off` | 工具调用参数里还原出值、又指向本机以外的 host 时怎么办：`off` 只计数，`warn` 告警并记一条，`block` 这次调用的参数里不还原，工具拿到占位符（[ADR-0014](docs/adr/0014-tool-guard.md)） |
| `shape` | `false` | 密钥换成同形的假 key（前缀、长度、字符类别不变），而不是 `{{…}}` 占位符；不足 8 个字符、或含字母数字与 `-` `_` `.` 以外字符的值仍用占位符；回复里照样还原（[ADR-0015](docs/adr/0015-shape.md)） |
| `cookieNames` | `[]` | 追加要脱敏的 cookie 名 |
| `cookieKeep` | `['lang', 'locale', 'theme', 'tz']` | 永不脱敏的 cookie 名 |
| `protectEnvBlock` | `true` | `<env>` … `</env>` 块原样发出，供会校验它的 provider 使用（[ADR-0004](docs/adr/0004-protected-regions.md)） |
| `protectTools` | `true` | 请求的 `tools` 数组原样发出 |
| `excludeHosts` | `[]` | 不改写的 `host` 或 `host:port` |
| `excludeProviders` | `[]` | 不脱敏的 provider id；「配置」页里从当前注册的 provider 中勾选（[ADR-0018](docs/adr/0018-exclude-providers.md)） |
| `maxValues` | `5000` | 内存值表上限，满了淘汰最老的一半 |
| `record` | `true` | 脱敏记录写盘；关掉只在内存里统计 |
| `keepDays` | `30` | 记录保留天数 |
| `recordContext` | `true` | 记录里每个值带上它所在的位置（用户消息、工具结果等）和前后各约 80 个字符，取自发出的内容，被脱敏的值都是占位符（[ADR-0024](docs/adr/0024-record-context.md)） |
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
| `/privacy test <文本>` | 预览这段文本会怎样发出：脱敏后的文本和每个值的 kind、finder、开头、长度。不进值表，原文不写进会话日志 |

命令的回答里不出现任何值。

## 记录与统计

只记有脱敏或还原的模型请求，一个请求一条（既没脱敏也没还原的不记）：时间、脱敏耗时、host、model、会话 id 及其工作区名与会话标题、替换处数、每个值的占位符 / kind / finder / 开头 / 长度 / 结尾、回复里还原的处数（工具调用参数里的另计），以及回复里出现、值表里却没有的占位符数。记录里不写值本身，也不记 URL 的 query（[ADR-0008](docs/adr/0008-masking-records.md)、[ADR-0020](docs/adr/0020-record-attribution.md)）。

「开头」保留的是辨识用的几个字符：有前缀的密钥留下前缀和它后面的 4 个，没有前缀的留前 4 个，长值再加末尾 2 个（`sk-proj-g6sx…3QaZ`），短值更少；个人信息和自定义词仍只留 1 个（[ADR-0019](docs/adr/0019-hint.md)）。

记录按天写在 `~/.dsh/privacy-gateway/masking/YYYY-MM-DD.jsonl`，目录 0700、文件 0600。写盘失败只告警，不影响请求。

插件详情页下方有一张统计卡：今日 / 7 天 / 30 天切换，计数、按 kind / finder / host 的分布、最近 200 条记录（每页 10 条，每条带着工作区 · 会话标题），点开一条看每个值的明细。卡片右上角的「清空数据」勾选确认后，删除所有会话的记录、统计和磁盘上的记录文件，无法恢复（[ADR-0022](docs/adr/0022-reset.md)）。打开 `showPanel` 后，同样的内容也出现在会话顶部的「隐私保护」标签页里，只统计当前会话。标签页头部的「本会话脱敏」开关可以只关掉这一个会话的脱敏，确认后生效，其他会话照常脱敏，重启后仍然保持（[ADR-0023](docs/adr/0023-session-switch.md)）。

打开 `vendorView`（配置页上叫「保留发出内容，供对照查看」）后，记录明细里多一个「查看发出内容」按钮，用来核对模型服务实际收到了什么、有没有漏脱敏：右边是模型服务收到的原文，左边是同一份内容里每个替换处换成「kind · 开头 · 长度」的标记，默认只列有替换的行。两边都不出现真值，warn 照发的值在副本里也换成了占位符。

## 须知

- 会话日志里是真值：还原发生在日志落盘之前（[ADR-0003](docs/adr/0003-restore-before-session-log.md)）。会话同步、备份、分享带走的是真值。
- 覆盖面只有走全局 `fetch()` 的流量；`node:http` 直连、worker 线程、独立进程不经过网关（[ADR-0001](docs/adr/0001-intercept-at-undici-global-dispatcher.md)）。
- 压缩的请求与回复先解压再脱敏、还原；认不出的 `content-encoding` 不发（[ADR-0025](docs/adr/0025-compression-and-upgrades.md)）。带 `upgrade` 的握手（WebSocket）也不发：Codex 第一次被拒后回落到 SSE，之后同一会话直接走 SSE；其他插件经全局 dispatcher 打开的 WebSocket 同样被拒，需要时把它的 host 加进 `excludeHosts`。
- 值表只在内存里（[ADR-0009](docs/adr/0009-value-table-and-restore-exfiltration.md)）。重启后，规则命不中、只靠记忆兜住的值第一次出站会按原文发出。
- 还原发生在回复里，包括工具调用参数：模型被诱导把占位符写进 `curl` 之类的命令时，工具执行时用的是真值。插件只记账（统计卡与 `/privacy status` 里的「工具参数」计数），不拦截（[ADR-0009](docs/adr/0009-value-table-and-restore-exfiltration.md)）。
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
- 状态目录 `~/.dsh/privacy-gateway/`，可用环境变量 `DSH_PRIVACY_GATEWAY_HOME` 改。
- 配置 schema 里不放 `.transform()` 或任何带回调的节点。
- `scripts` 里不挂安装期生命周期脚本。
- 其它 dispatcher 插件挂到网关下游时，按 [ADR-0012](docs/adr/0012-dispatcher-composition.md) 的合成契约（`chainTo`、`below`、`release`、`downstreams`）。
- 架构决策记在 [docs/adr/](docs/adr/README.md)。
- `README.en.md` 逐条跟随本文件。

## 致谢

脱敏功能的设计参考了 [magpie](https://github.com/yetone/magpie)：占位符的生成与还原、规则表、JSON 中保留不动的字段、转义 JSON 的处理都沿用它的语义，代码用 TypeScript 重写。

## 许可

[MIT](LICENSE)
