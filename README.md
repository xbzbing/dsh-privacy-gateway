# dsh-privacy-gateway

中文 | [English](README.en.md)

DeepSeek Harness 插件：在宿主进程的 undici 全局 dispatcher 上装一层脱敏网关。出站把模型请求体里的密钥换成占位符，入站把回流里的占位符换回真值。对 agent、adapter、provider 都无感，一处拦截覆盖所有走 `fetch()` 的 provider，包括插件提供的 adapter。

状态：P1 已实现，尚未发布。

## 遮什么

| kind | 内容 | 开关 |
| --- | --- | --- |
| `API_KEY` | OpenAI / Anthropic `sk-…`、GitHub / GitLab 令牌、Google `AIza…`、Slack `xox…`、Stripe、AWS `AKIA…`、阿里云 `LTAI…`、腾讯云 `AKID…`、Hugging Face、Groq、xAI、npm、PyPI、DigitalOcean、SendGrid 等前缀 | `secrets` |
| `TOKEN` | JWT | `secrets` |
| `PRIVATE_KEY` | PEM 私钥块 | `secrets` |
| `PASSWORD` / `SECRET` | URL 里的密码、名为 password / secret / token 的字段、中文「密码为…」「密钥是…」 | `secrets` |
| `COOKIE` | `Cookie` / `Set-Cookie` 头、`curl -b`、cookies.txt、Playwright storageState、HAR、常见会话 cookie 名（`BDUSS`、`JSESSIONID` 等） | `secrets` |
| `EMAIL` / `PHONE` / `ID_CARD` / `BANK_CARD` | 邮箱、大陆手机号、身份证号（校验位）、银行卡号（Luhn） | `personal` |
| `TERM` | 配置里 `words` 列出的词 | 有词就遮 |

遮过的值在请求的其它地方再出现，也按同一个占位符遮（finder 记为 `known`）。同一个 host 重发的历史保持原来的字节，prompt cache 照样命中。

## 安装

正式版发布后：

```bash
dsh plugin --profile web add dsh-privacy-gateway@latest
```

每个版本的 GitHub Release 也附带同一个 tgz，可以用附件 URL 安装。仓库源码不含构建产物 `lib/`，不带 ref 的 `github:` 安装加载不了（[ADR-0006](docs/adr/0006-distribution-and-build-artifacts.md)）。

在默认的 web profile 里，首次安装即装即用，无需重启。插件有 host 半，升级已安装的版本后需要重启 dsh 才会加载新代码。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关掉后网关不安装 |
| `secrets` | `true` | 遮蔽密钥、令牌、密码、私钥、cookie |
| `personal` | `false` | 遮蔽邮箱、手机号、身份证号、银行卡号 |
| `words` | `[]` | 自己的词（项目代号、客户名），按原样遮成 `TERM` |
| `allow` | `[]` | 永不遮的值：整值匹配，不分大小写 |
| `cookieNames` | `[]` | 追加要遮的 cookie 名 |
| `cookieKeep` | `['lang', 'locale', 'theme', 'tz']` | 永不遮的 cookie 名 |
| `protectEnvBlock` | `true` | `<env>` … `</env>` 块原样发出，供会校验它的 provider 使用（[ADR-0004](docs/adr/0004-protected-regions.md)） |
| `protectTools` | `true` | 请求的 `tools` 数组原样发出 |
| `excludeHosts` | `[]` | 不改写的 `host` 或 `host:port` |
| `maxValues` | `5000` | 内存值表上限，满了淘汰最老的一半 |
| `record` | `true` | 脱敏记录写盘；关掉只在内存里统计 |
| `keepDays` | `30` | 记录保留天数 |
| `keepMegabytes` | `100` | 记录总量上限（MB），超了从最老的一天删 |
| `keepRecords` | `500` | 内存里保留的最近记录条数 |

## `/privacy` 命令

| 用法 | 作用 |
| --- | --- |
| `/privacy` 或 `/privacy status` | 开关状态、值表大小、今日 / 7 天 / 30 天的请求与替换计数、按 kind 和 finder 的分布、异常信号 |
| `/privacy off` | 本次运行内停止遮蔽，请求按原文发出；不改配置，重启后恢复 |
| `/privacy on` | 恢复遮蔽 |
| `/privacy test <文本>` | 预览这段文本会怎样发出：遮蔽后的文本和每个值的 kind、finder、开头、长度。不进值表，原文不写进会话日志 |

命令的回答里不出现任何值。

## 记录与统计

只记有脱敏或还原的模型请求，一个请求一条（既没遮也没还原的不记）：时间、遮蔽耗时、host、model、会话 id、替换处数、每个值的占位符 / kind / finder / 开头 / 长度、回复里还原的处数（工具调用参数里的另计），以及回复里出现、值表里却没有的占位符数。记录里不写值本身，也不记 URL 的 query（[ADR-0008](docs/adr/0008-masking-records.md)）。

记录按天写在 `~/.dsh/privacy-gateway/masking/YYYY-MM-DD.jsonl`，目录 0700、文件 0600。写盘失败只告警，不影响请求。

插件详情页下方有一张统计卡：今日 / 7 天 / 30 天切换，计数、按 kind / finder / host 的分布、最近 50 条记录，点开一条看每个值的明细。

## 须知

- 会话日志里是真值：还原发生在日志落盘之前（[ADR-0003](docs/adr/0003-restore-before-session-log.md)）。会话同步、备份、分享带走的是真值。
- 覆盖面只有走全局 `fetch()` 的流量；`node:http` 直连、worker 线程、独立进程不经过网关（[ADR-0001](docs/adr/0001-intercept-at-undici-global-dispatcher.md)）。
- 值表只在内存里（[ADR-0009](docs/adr/0009-value-table-and-restore-exfiltration.md)）。重启后，规则命不中、只靠记忆兜住的值第一次出站会按原文发出。
- 还原发生在回复里，包括工具调用参数：模型被诱导把占位符写进 `curl` 之类的命令时，工具执行时用的是真值。插件只记账（统计卡与 `/privacy status` 里的「工具参数」计数），不拦截（[ADR-0009](docs/adr/0009-value-table-and-restore-exfiltration.md)）。
- 遮蔽出错时请求不会发出，报错 `dsh-privacy-gateway: masking failed, request not sent`（[ADR-0005](docs/adr/0005-fail-closed.md)）。止血办法是 `/privacy off`，或在插件页停用本插件、把配置 `enabled` 设为 `false`。

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
