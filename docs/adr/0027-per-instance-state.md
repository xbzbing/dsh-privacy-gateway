# ADR-0027：状态目录按实例隔离

- 状态：Accepted（2026-11-01）
- 相关：`src/paths.ts`、`src/index.ts`、ADR-0002、ADR-0008、ADR-0023

## Context

插件把状态放在 `~/.dsh/privacy-gateway/`：HMAC key（`redact.key`）、脱敏记录（`masking/`）和关闭了脱敏的会话名单（`sessions.json`）。这个路径由插件自己拼出来，和跑的是哪个实例无关。

一台机器上常常同时有几个实例：`web` profile 的网页端、`desktop` profile、`open-design` 之类的其它 profile，或者 SDK 起的进程。它们共用同一份状态：

- 统计卡里混着别的实例的请求，`/privacy` 的统计也混；
- `sessions.json` 被多个进程读改写，一个实例关掉脱敏的会话，在另一个实例的名字空间里没有意义，却能对上；
- key 共用，占位符在实例之间也是同一套（这一点不算坏，但没有必要，也不该由巧合决定）。

DSH 已经把「当前实例」交给插件：`dsh-app-boot` 在启动 profile 时 `provide('profileContext', …)`，里面有 `name`、`dir`、`home` 等；`dir` 就是 `$DSH_HOME/profiles/<name>`（打包应用另有路径）。插件已经只用官方扩展点，这里也用它，不再自己拼 `~/.dsh`。

## Decision

- `stateDir()` 的优先级从高到低：
  1. `DSH_PRIVACY_GATEWAY_HOME`（测试与用户的逃生口，仍然最高）；
  2. 当前实例的目录：`ctx.profileContext.dir` + `plugin-data/dsh-privacy-gateway`；
  3. 没有 profile 时（SDK、测试、profile 目录读不到）退回 `~/.dsh/privacy-gateway`。
- `index.ts` 只解析一次，key、记录目录、会话名单都用它，并在启动时打一行 info 说明状态在哪。
- 目录放在实例自己的 profile 目录下，形状是 `~/.dsh/profiles/<name>/plugin-data/dsh-privacy-gateway/`，和其它插件在 `$DSH_HOME/plugin-data/<包名>/` 下的习惯一致，只是再按 profile 分开。DSH 自己的 plugin-manager 也在 profile 目录里放 `.dsh-market/`，所以数据放这里不算越界。
- 目录权限、文件权限（0700 / 0600）、原子写（ADR-0008、ADR-0023）不变。

## Consequences

- 升级后旧的 `~/.dsh/privacy-gateway/` 不再被读：新目录里没有 key，占位符会重新生成；旧的记录不出现在统计卡里；旧 `sessions.json` 里关掉脱敏的会话恢复成脱敏（安全的方向）。要保留就手动把 `redact.key`、`masking/`、`sessions.json` 拷到新目录。
- 同一个 profile 起两个进程（比如两个端口的 `dsh web`）仍然共用一个目录：`sessions.json` 的读改写还是按 ADR-0023 的多进程做法处理，记录按天追加。真正的按进程隔离需要实例 id，DSH 现在没有给插件这样一个稳定的 id。
- 每个实例一份 key：不同实例的同一段文本（含同一个密钥）拿到的占位符不同，各自的厂商缓存互不影响。
- 卸载 profile 时状态随 profile 目录一起被删，不会在 `$DSH_HOME` 下留一份孤儿数据。
