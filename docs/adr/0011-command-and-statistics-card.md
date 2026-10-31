# ADR-0011：`/privacy` 命令与统计卡

- 状态：Accepted（2026-10-31）
- 相关：`src/command.ts`、`src/remote.ts`、`src/client/`、`src/index.ts`、ADR-0005、ADR-0008

## Context

记录（ADR-0008）要有地方看；遮蔽失败 fail-closed（ADR-0005）要有不依赖遮蔽器的止血办法。约束：

- 命令的输入和回答都会进会话日志（`command/run`、`command/done`）。`/privacy test` 的输入就是用户想检查的密钥。
- 统计卡在浏览器里，数据在 host 进程里，需要一条 host→client 的通道。
- 网关是安全核心，不能因为 UI 依赖缺失而装不上。
- 配置页由宿主按 schema 渲染，插件不该替换它。

## Decision

- 命令 `/privacy`：`status`（默认）、`on`、`off`、`test <文本>`。
  - `on` / `off` 只改本次运行的开关，不写配置；遮蔽器不参与判断，所以遮蔽失败时 `off` 照样可用。
  - `test` 用遮蔽器的预览：给出遮蔽后的文本和每个值的 kind、finder、head、len，不进值表、不记账。
  - 注册时设 `recordInput: false`，`test` 的原文不进会话日志。
  - 回答语言跟随 locale 设置（中文或英文）。
  - 通过 `ctx.inject(['commands'])` 注册：没有 dsh-commands 时网关照常工作。
- 统计卡：
  - host 端一个 typert Remote 服务，命名空间 `privacyGateway`，方法 `overview(request)` 返回开关状态、汇总和最近记录。Node 直接运行 TS 源码时不支持装饰器语法，`@Remote` 由代码手动套用。
  - 这个服务所在的模块用动态 `import()` 加载；`@deepseek-ai/dsh-typert-protocol` 不在时只告警，网关不受影响。typert 与 cordis 列为可选 peer 依赖。
  - client 端放在 `plugins.detail.section` 槽位，只在本插件的详情页渲染，排在页面自己的内容（包括配置表单）之后，不替换它。
  - 卡片用下划线 tab 切换今日 / 7 天 / 30 天；颜色只用 `--dsw-alias-*` 主题变量；页面可见时每 15 秒刷新。
  - client 包由 esbuild 打成 `lib/client.js`，react 与 `@deepseek-ai/*` 外置，由宿主 loader 提供。

## Consequences

- `/privacy off` 在重启后失效：要长期关闭，用配置 `enabled: false`。
- `test` 的回答（遮蔽后的文本）会进会话日志；规则没认出的部分按原文出现在里面，和直接把文本发进对话一样。
- 本地 link 安装时，插件从自己的 `node_modules` 解析 typert 和 cordis，与宿主不是同一份拷贝；typert 的标记按字符串属性读、cordis 的 `Context.is` 跨拷贝识别，所以能工作，但每次升级宿主都要实测一次。
