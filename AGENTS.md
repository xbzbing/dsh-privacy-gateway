# AGENTS.md

dsh-privacy-gateway 是 DSH 的进程级脱敏网关（Cordis 插件，host + client 两半）。host 端把一个 undici dispatcher 挂在全局 dispatcher 前面：发往模型服务的请求里，密钥、凭据、个人信息和自定义敏感词换成占位符；回复里的占位符再换回原值。所有 provider 都经过它。ESM（`"type": "module"`）、TypeScript、Node >= 22.19、pnpm。

每个决策都有 ADR，见 [docs/adr/README.md](docs/adr/README.md)。改行为前先读相关 ADR。

## 仓库布局

```
src/
  index.ts        插件入口：读配置、装网关、注册 /privacy、挂 Remote 服务、llm/stream 监听
  config.ts       schemastery 配置；volatile 字段、LIVE_FIELDS、liveMark、resolveConfig、defaults
  dispatcher.ts   MaskingDispatcher：改写请求 body、流式还原回复；脱敏失败则不发（fail closed）
  engine.ts       PrivacyEngine：Masker/Restorer/值表/记录的组合；reconfigure 热替换规则
  providers.ts    AsyncLocalStorage 上下文：把 llm/stream 的 provider 与会话 id 带到 dispatcher
  sessions.ts     关闭了脱敏的会话名单（~/.dsh/privacy-gateway/sessions.json）
  records.ts      脱敏记录：内存环 + 按天 JSONL（~/.dsh/privacy-gateway/masking/）与统计
  views.ts        「保留发出内容」的内存副本（vendorView）
  remote.ts       typert Remote 服务 privacyGateway/*（overview、providers、reset、sessionMasking、vendorView）
  command.ts      /privacy 命令
  protect.ts      必须原样发出的区域（<env> 块、工具定义）
  paths.ts        状态目录（DSH_PRIVACY_GATEWAY_HOME 可改）
  redact/         查找、脱敏、还原：rules/checks/personal/cookie/find/mask/restore/known/shape/guard/json/key
  client/         Web 端：配置页（ConfigSection、configControls、fields）、统计卡（StatsCard、StatsParts）、
                  会话「隐私保护」标签页（sidebar）、发出内容对照（VendorView）、locales、styles、rpc
test/             node:test 单测，文件名 *.test.ts（package.json 的 test 脚本按通配符收集）
scripts/          build-client.mjs（client 打包）、assert-pack.mjs（打包检查）
docs/adr/         ADR，编号递增；docs/details/ 是插件详情页文档（随包分发）
locale/           插件管理页的标题、描述字典（zh.json / en.json）
```

## 命令

```sh
pnpm verify   # tsc（host + client 两套 tsconfig）+ 全部单测；每次改动后必跑
pnpm build    # tsdown 构建 lib/index.js，esbuild 构建 lib/client.js
```

改完的固定流程：`pnpm verify` → `pnpm build`。`lib/` 不入库（ADR-0006）。

## 本地调试

- 开发时用 `link:` 方式把插件装进 dsh profile，`pnpm build` 后实例直接读到新产物。
- 只改了 client（`src/client/`）：构建后刷新页面即可。改了 host：需要重启 dsh。不要替用户杀进程或另起实例。

## 约定

- **只用 dsh/Cordis 官方扩展点**：`ctx.effect`、`ctx.inject`、`ctx.on('llm/stream')`、`ctx.plugin`、`slots`（`plugins.row.config`、`plugins.bundle.config`、`conversation.view`）、`dsh.bundle` patch、client `inject` 声明。不碰宿主运行时内部。
- **界面用官方控件**：`@deepseek-ai/dsh-client-ui-primitives`（Switch、Menu、Button、Input、Tag、SegmentedControl、RiskConfirmation、图标），类型在 `src/client/primitives.d.ts` 里按需声明；颜色、圆角、边框用 `--dsw-*` 变量。排版照官方设置页：标题和说明在左，开关和下拉框在右。
- **安全不变量**：
  - 记录、日志、统计、Remote 返回值里永远不出现被脱敏的真值（ADR-0008）。记录里的提示只有首尾几个字符（ADR-0019）；上下文文字取自发出的内容，warn 照发的值也换成占位符（ADR-0024）。改这些路径时要有「不含真值」的断言。
  - 脱敏出错时请求不发出（ADR-0005）。
  - `protectEnvBlock`、`protectTools` 覆盖的区域必须逐字节原样发出（ADR-0004）。
  - 放行（`enabled` 关、排除的 provider、关闭了脱敏的会话）只能由明确的条件触发。空串、`undefined` 不能被当成放行：曾经因为 `provider: ''` 被当成排除，所有带会话 id 的请求都没脱敏。改 `skip` 或 `providers.ts` 时，补一条「带会话 id、未排除的请求必须脱敏」的回归测试。
  - 落盘文件权限 0600，原子写（临时文件 + rename）。
  - 会让内容原样发出或删除数据的操作，界面上要二次确认（RiskConfirmation）。
- **配置页上的字段必须是 volatile**：dsh-settings 只能写 volatile 字段。新增页面字段时同步改 `config.ts`（schema、defaults、resolveConfig，需要热重建的加进 `LIVE_FIELDS`）、`client/fields.ts`、`client/locales.ts` 的 `cfg.f.<key>` 与 `.hint`；`test/fields.test.ts` 会核对这些。并排显示的字段（`half`）在组内必须成对。
- **文案**：`locales.ts` 以 `zh` 为键的来源，`en` 必须有同样的键和同样的 `{参数}`。中文一律写「脱敏」，不写「遮蔽」。
- **代码注释**用英文，按现有风格写成完整句子，说清原因；不写过程性注释。

## 文档与提交

- README.md（中文）与 README.en.md 逐条对应，成对修改。README 不提 oc2dsh；安装命令带 `--profile web`。
- 行为或界面有决策性变化时新增 ADR（中文，编号接着最大号），并在 `docs/adr/README.md` 的表里加一行；修改已有决策时在原 ADR 里补充说明。
- 提交信息用中文 Conventional Commits（`feat:`、`fix:`、`docs:`…），只描述最终状态，不写过程。
- 只在用户要求时推送：`git push origin main`。发布流程见 ADR-0007，`package.json` 带 `"private": true` 时不会发布。
