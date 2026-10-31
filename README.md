# dsh-privacy-gateway

中文 | [English](README.en.md)

DeepSeek Harness 插件：在宿主进程的 undici 全局 dispatcher 上装一层脱敏网关。出站把模型请求体里的密钥换成占位符，入站把回流里的占位符换回真值。对 agent、adapter、provider 都无感，一处拦截覆盖所有走 `fetch()` 的 provider，包括插件提供的 adapter。

状态：P0（拦截点验证）已实现，尚未发布。目前只认三种密钥：`sk-…`、GitHub / GitLab 令牌（`ghp_…`、`github_pat_…`、`glpat-…`）、AWS `AKIA…` / `ASIA…`。

## 安装

正式版发布后：

```bash
dsh plugin --profile web add dsh-privacy-gateway@latest
```

每个版本的 GitHub Release 也附带同一个 tgz，可以用附件 URL 安装。仓库源码不含构建产物 `lib/`，不带 ref 的 `github:` 安装加载不了（[ADR-0006](docs/adr/0006-distribution-and-build-artifacts.md)）。

在默认的 web profile 里，首次安装即装即用，无需重启。本插件只有 host 半，升级已安装的版本后需要重启 dsh 才会加载新代码。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关掉后网关不安装 |
| `secrets` | `true` | 遮蔽密钥 |
| `protectEnvBlock` | `true` | `<env>` … `</env>` 块原样发出，供会校验它的 provider 使用（[ADR-0004](docs/adr/0004-protected-regions.md)） |
| `protectTools` | `true` | 请求的 `tools` 数组原样发出 |
| `excludeHosts` | `[]` | 不改写的 `host` 或 `host:port` |
| `maxValues` | `5000` | 内存值表上限，满了淘汰最老的一半 |

## 须知

- 会话日志里是真值：还原发生在日志落盘之前（[ADR-0003](docs/adr/0003-restore-before-session-log.md)）。会话同步、备份、分享带走的是真值。
- 覆盖面只有走全局 `fetch()` 的流量；`node:http` 直连、worker 线程、独立进程不经过网关（[ADR-0001](docs/adr/0001-intercept-at-undici-global-dispatcher.md)）。
- 遮蔽出错时请求不会发出，报错 `dsh-privacy-gateway: masking failed, request not sent`（[ADR-0005](docs/adr/0005-fail-closed.md)）。止血办法是在插件页停用本插件，或把配置 `enabled` 设为 `false`。

## 开发

```sh
pnpm install
pnpm verify   # typecheck + test
pnpm build    # 产出 lib/（不入库）
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
- 架构决策记在 [docs/adr/](docs/adr/README.md)。
- `README.en.md` 逐条跟随本文件。

## 致谢

脱敏功能的设计参考了 [magpie](https://github.com/yetone/magpie)：占位符的生成与还原、规则表、JSON 中保留不动的字段、转义 JSON 的处理都沿用它的语义，代码用 TypeScript 重写。

## 许可

[MIT](LICENSE)
