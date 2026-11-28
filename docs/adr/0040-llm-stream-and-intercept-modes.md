# ADR-0040：llm/stream 结构化脱敏与 intercept 双模式互斥

- 状态：Accepted（2026-11-27）。原编号 0039，因上游 v0.4.1 先行占用（0039-record-traceability）重编为 0040。
- 相关：`src/stream.ts`、`src/engine.ts`、`src/index.ts`、`src/config.ts`、`src/redact/restore.ts`、`src/redact/mask.ts`、`src/remote.ts`、`src/client/ConfigSection.ts`、`src/client/fields.ts`、ADR-0001、ADR-0003、ADR-0004、ADR-0005、ADR-0008、ADR-0014、ADR-0016、ADR-0021、ADR-0029、ADR-0034、ADR-0037、ADR-0039

## Context

dispatcher 在 adapter 序列化之后处理 HTTP body，覆盖面广，但需要处理 JSON 转义、内容编码、传输升级和 AsyncLocalStorage 传递 provider（ADR-0001、ADR-0025）。`llm/stream` 则在序列化之前给出结构化请求与回复块，可以直接覆盖当前消息、历史、system、工具参数和辅助调用，不必猜 body 的形状，也没有升级连接可拒（ADR-0025 的升级拒绝只在 dispatcher 模式成立，见该 ADR 的 2026-11-28 更新）——但它只覆盖经过水瀑的模型调用，绕过它的插件 fetch、`node:http` 直连不在这层的覆盖范围内。

两套机制同时处理一个请求会重复计数、重复记录，并让回复经过两套还原器；模式切换若只在 `apply()` 时读一次配置，volatile 修改后可能留下旧的 dispatcher，或两个半都没有有效工作。

## Decision

新增 stream 脱敏半（`src/stream.ts`），由 volatile `intercept: 'stream' | 'dispatcher'` 选择，**默认保持 `dispatcher`**：不改 ADR-0001 的既定拦截点，已有安装的配置与行为原样不变。

- **互斥装配**：一个稳定的 `llm/stream` 多路复用监听在每次调用读取当前配置。dispatcher 由 `ensureMode` 按需安装，切到 stream 时调用其 disposer，双向切换都使旧路径退出；插件卸载时统一释放并关闭记录存储。两模式共享同一个引擎、值表和记录存储，切换不清空值表。
- **出站**（stream 半）：遍历 `messages` 的 text/reasoning、递归 tool-result（数组形式的内容递归处理，字符串形式的内容按整段文本脱敏）、tool-call 的 escaped arguments、`system`（字符串，或 ADR-0004 列为已覆盖形状的块数组）、`tools[].description`、`toolHistory` 里同一份工具定义，以及 `protectTools` 关闭时 `tools[].parameters` / `toolHistory[].parameters` 的字符串。只浅拷贝发生变化的子树，原请求与未变子树保持原样和引用；仅用进程内 WeakSet 识别重入，不接受请求对象上可伪造的标记属性。改写过的请求经宿主 `llm.stream()` 重新派发并标记，排除条件之外失败时不发请求（fail closed），空 provider 不会命中排除项。缺 `llm` 服务时同样不发请求。
- **认不出的形状不发**：`system` 既不是字符串也不是块数组、`messages[].content` / `tool-result.content` 既不是字符串也不是数组、text/reasoning 块的载荷不是字符串、`messages` / `tools` / `toolHistory` 不是数组，都在脱敏前抛 `UnhandledShape`，请求不发出（ADR-0005）。静默放行等于把这些字段里的值原样交给厂商。
- **入站**（stream 半）：每个请求快照 `restoreLog`，并以值表非空为前提（与 dispatcher 的 `restoring()` 一致）。关闭（默认）或值表为空时回复块严格原样通过；打开时才按 block 增量扣尾还原 text/reasoning（复用 ADR-0037 的 `tailLen` 与值表 `shapeTail`），block-end 权威还原，并在工具执行前经 `restoreTool` 处理 arguments。扣留的文本在 usage/finish 之前或正常 EOF 时释放；取消与异常路径不从清理块产出 chunk，而是在一次 `return()`/异常中立即完成记录。工具参数复用 `toolGuard`：`off` 只还原，`warn` 还原并记录，`block` 对外带参数保留占位符。
- **计数不翻倍**：text/reasoning 的 delta 与 block-end 是同一份内容的两种宿主表达，宿主 `BlockAssembler` 收到 block-end 后以 block 为准，所以只有 block-end（权威）把还原处数并入请求的 tally；delta 用按 index 的临时 tally，只用于展示。没有等到 block-end 的 index（delta-only 流）在 usage/finish/EOF 或结束时把自己的计数并入，不漏计也不重计。
- **delta-only 的工具调用**：按 index 累积 `argumentsDelta`，在 usage/finish/正常 EOF 时仍未闭合的调用合成一条 `block-end`（还原并经 `toolGuard` 判定）再结束，否则宿主会从占位符自行组装参数、把占位符交给工具；连名字都没有的调用无法合成，直接不发（fail closed）。
- **审计边界**（ADR-0008 在 v0.4.0 的加强同样适用）：结构化请求的记录经同一套 audit 投影清洗——host、session、title、workspace、model、kind 的 head/tail、上下文与外带 host 全部投影；`FirstSending` 的 get/note 分离语义照搬（block 只能引用更早的发送，不能凭空制造）。
- **能力门控**：`protectEnvBlock` 只保护宿主 system/developer 文本；`protectTools` 开启时工具定义完全不进入脱敏；`maskKeys` 与 `vendorView` 只在 dispatcher 模式存在——stream 半看不到 wire JSON 的键，也看不到 adapter 最终序列化的 body。Overview 增加 `intercept`，旧 host 缺少该字段时客户端规范化为 `dispatcher`；stream 下 Overview 与 vendorView RPC 都不提供发出内容副本，并清除已保留的 body。
- **配置页模式感知**：`FieldSpec.modes` 声明字段适用的模式，`maskKeys` 与 `vendorView` 只在 dispatcher 显示，折叠摘要也排除它们。`intercept` 本身是配置页「脱敏」组的第一项（选择器：dispatcher / stream），模式直接读表单里这一字段的值，保存后立即一致，不再额外读宿主；切到 stream 会缩小覆盖，按 ADR-0021 的约定先经 RiskConfirmation 确认。字段的中英描述、README 与 docs/details 都写明它是实验能力、会重新派发、`maskKeys` 与 `vendorView` 不生效；stream 生效时日志再打一条一次性的实验提示。

## Consequences

- 默认安装的行为与此前逐字节一致：仍装在 undici 全局 dispatcher 前面，配置页、命令与记录不因升级而变。切到 stream 是显式选择，从下一次调用生效，无需重启。
- stream 模式不再依赖 HTTP body 形状、压缩编码或 AsyncLocalStorage 传递 provider，也没有升级连接可拒；代价是绕过 `llm/stream` 的流量不经过这一层。
- 记录仍在回复结束时才完整可见；正常结束、异常与一次取消 `return()` 都会完成记录，调用方不能丢弃迭代器而不关闭。stream 的逐请求日志不带原始 session id。
- text delta 与 block-end 是同一份模型内容的两种宿主表达，二者都要还原；计数只取权威的那一处（block-end），delta-only 的 index 在结束时补计，一条含一个占位符的回复恒记 `restored: 1`。
- 模式切换以一次新调用为边界，不强行中断在途回复；在途回复保留各自请求时的 restorer 与配置快照。
- **宿主兼容限制**：当前 DSH 的 waterfall `next()` 不接收替换后的 options，因此重跑 `llm.stream()` 会重放排在本插件之前的 listener；浅拷贝也不会继承宿主按对象身份保存的 agent-loop 标记，prepared call 会重新解析 adapter/model。真实 `@deepseek-ai/dsh-llm` 集成验证中，一次 prepared call 表现为两次 waterfall 访问、两次 resolve，第二次 LOOP 身份丢失。默认 dispatcher 不受影响；在宿主提供可替换 options 的官方 transform/next 语义前，stream 只能作为受限的实验能力，不能宣称与宿主中间件语义完全等价。因此 `intercept` 的字段描述、配置页确认文案与随包文档都标「实验」，并写明只覆盖 `llm/stream`、会二次派发、`maskKeys` 与 `vendorView` 不生效；切回 `dispatcher` 即可回退，无需重启。
- **真实链路验证**：本 PR 只在单测里覆盖了结构化半与两种模式的切换，尚未在真实 dsh 实例上跑过 stream 模式；已验证的宿主版本与调用组合待补，不把 `llm/stream` 接口存在当作兼容的证明。
