# dsh-privacy-gateway

DeepSeek Harness 插件：在宿主进程的 undici 全局 dispatcher 上装一层脱敏网关。出站把模型请求体里的密钥、个人信息换成占位符，入站把回流里的占位符换回真值。对 agent、adapter、provider 都无感，一处拦截覆盖所有走 `fetch()` 的 provider。

状态：骨架阶段，脱敏尚未实现。

## 开发

```sh
pnpm install
pnpm verify   # typecheck + test
pnpm build    # 产出 lib/，lib/ 入库
```

`lib/` 需要随源码一起提交：`dsh plugin add file:<repo>` 与 `github:<owner>/<repo>` 安装时不跑任何构建脚本。

## 约定

- 包名、cordis 行名、loader id、设置命名空间都是 `dsh-privacy-gateway`（行名必须等于包名）。
- 状态目录 `~/.dsh/privacy-gateway/`，可用环境变量 `DSH_PRIVACY_GATEWAY_HOME` 改。
- 命令 `/privacy`（未实现）。
- 配置 schema 里不放 `.transform()` 或任何带回调的节点。

## 许可

MIT
