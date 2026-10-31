# ADR-0021：配置页编辑日常配置项，改了即时生效

- 状态：Accepted（2026-10-31）
- 相关：`src/config.ts`、`src/index.ts`、`src/engine.ts`、`src/records.ts`、`src/client/fields.ts`、`src/client/ConfigSection.ts`、`src/client/configControls.ts`、ADR-0017、ADR-0018

## Context

配置页原先只有 `showPanel` 和 `excludeProviders` 两项，其余都要改 `cordis.patch.yml`。这两项能在页面上改，是因为它们声明了 `.volatile()`：dsh-settings 的插件条目表单只投影 volatile 字段，写非 volatile 字段直接报错（`Config field "…" is not volatile`）。要把别的配置项放上页面，它们也得是 volatile。

volatile 字段改了，cordis 不重新挂载插件，只把新值放进同一个活引用里。插件必须自己读到新值并生效。

## Decision

- 页面上放日常要改的项，按组排列：
  - 脱敏：`enabled`、`secrets`、`personal`、`shape`、`toolGuard`
  - 词表：`words`、`allow`
  - 记录：`record`、`keepDays`、`vendorView`
  - 标签页与 provider：`showPanel`、`excludeProviders`
- 每组是一个可折叠的区块。折叠时标题行右侧用一行字概括该组状态（如「写盘，保留 30 天」「敏感词 2 个 · 放行 1 个」），关闭类的状态用警示色；组内有错误提示时显示「有提示，展开查看」。第一次打开只展开「脱敏」，之后展开了哪些组记在浏览器的 localStorage 里。
- 开关、单选、天数的控件放在标题和说明右边，和设置页一致；词表和 provider 选择放在说明下方。页面宽度够时，短的项两两并排（`fields.ts` 里标 `half`），窄于 600px 时改为单列，按容器宽度判断，不按窗口宽度。
- 这些字段在 schema 里都声明 `.volatile()`。`resolveConfig` 逐个字段读活引用的当前值。
- 插件保存一个指纹（`liveMark`，即 `LIVE_FIELDS` 的 JSON）。每个请求进入 dispatcher 时、`/privacy` 和统计卡读状态时，重新解析配置；指纹变了才重建：
  - `PrivacyEngine.reconfigure`：按新配置重建 Masker 和 Restorer，值表保留。已经发出的请求，回复照样还原，用的是发出时的 Restorer；新 Masker 的「已发送」缓存从空开始，因为旧缓存是按旧规则算的。
  - `RecordStore.configure`：`record` 打开时开始写盘，第一次打开时把盘上已有的天数读进统计，只读一次；关掉时队列里还没写的也不写。`keepDays` 变小时，下次写盘就清理。
  - `vendorView`：`ViewStore` 一直创建，开着才存 body；关掉时清空已存的。
- `enabled` 关掉时网关仍然安装，dispatcher 对每个请求都放行（不读 body、不还原、不记录），统计卡显示「已关闭」。以前关掉时插件直接不安装网关；现在关掉后再打开，下一次请求起就恢复，不用重启。要彻底卸下网关，在插件页停用本插件。
- 页面控件用 Web 壳自己的组件：开关用 `Switch`，单选和 provider 多选用 `Menu` 加设置页同款选择按钮（填充底色、36px 高、带下拉箭头），词表用 `Input`、`Button` 和带移除按钮的 `Tag`，天数用 `Input` 在失焦或回车时保存。provider 选择去掉了手填 id 的输入框：列表里有但当前没注册的 id 仍然列出，可以取消勾选。
- 留在 `cordis.patch.yml` 的项：`actions`、`cookieNames`、`cookieKeep`、`protectEnvBlock`、`protectTools`、`excludeHosts`、`maxValues`、`keepMegabytes`、`keepRecords`。它们是接入网关时配置的，改了照旧重新挂载插件。
- `src/client/fields.ts` 列出页面上的字段、默认值和所属组。客户端不引用 host 的 schema（会把 schemastery 打进页面），由 `test/fields.test.ts` 核对：默认值与 `config.ts` 的 `defaults` 一致，每个字段在 schema 里是 volatile，`LIVE_FIELDS` 与页面字段一致，每个字段在中英文里都有文案。

## Consequences

- 改动从下一次模型调用起生效；正在进行的调用按发出时的配置跑完。
- 每个请求多一次配置解析和一次 JSON 序列化，规模是十几个字段，开销可以忽略；重建只在指纹变化时发生。
- 关掉 `secrets` 或 `personal` 后，之前换掉的值仍在值表里，回复里出现它们的占位符时照样还原。
- 新加一个页面字段需要同时改三处：schema 标 volatile、`LIVE_FIELDS`（如果插件要据此重建）、`fields.ts`；测试会指出漏掉的那一处。
