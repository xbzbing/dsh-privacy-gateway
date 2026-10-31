# ADR-0017：会话顶部的「隐私保护」标签页，默认不出现

- 状态：Accepted（2026-10-31）
- 相关：`src/client/sidebar.ts`、`src/client/panelConfig.ts`、`src/client/index.ts`、ADR-0011

## Context

统计卡（ADR-0011）只在插件详情页，查看要离开会话、进设置、找到插件。用户希望在工作区里随手看，但不是每个人都要，常驻一个标签页会占掉一行 tab 的位置。

## Decision

- 配置 `showPanel`，默认 `false`。打开后，会话顶部的视图标签里多一个「隐私保护」（英文 Privacy），排在「对话」「轨迹」「Git」之后（`conversation.view`，order 40）；内容与详情页的统计卡相同，只是去掉卡片边框和标题，并只统计本会话。
- 注册照 dsh-git-panel 的三步：标签类型（`sidebarRightTabs.register`）、`sidebar.right.pane.tab` 的主体、`sidebar.right.pane.tab.title` 的标题，三者一起注册、一起撤销。
- 视图走 `conversation.view` 这个槽，和 Git 面板同一个座位；槽由会话视图条提供，不存在「宿主没有」的版本，所以不需要延迟注入或额外 service。
- 配置画在两处，共用同一个组件：bundle 详情页内联的一节（`plugins.bundle.config`，键为包名），以及插件管理器行页（`plugins.row.config`，键为 `包名#行 id`）。前者在视野里，后者是官方给行的入口——只放在行页时，配置入口只是行标题旁的一个箭头，不明显。
- 行页那一份由插件管理器把该 entry 的表单作为 `form`（`{state, mutate}`）交过来；bundle 页那一份没有 `form`，从设置镜像里用 `schemaFields` 认领命名空间后取同一份表单。两处写入都走带 revision 的 `mutate`。
- 控件全用 shell 的 `@deepseek-ai/dsh-client-ui-primitives`：开关用 `Switch`，provider 多选用 `Menu`（`selectedIds` + 选中不关闭，与插件市场的筛选菜单同一种用法），按钮用 `Button`。这份包是平台 seed，写在 `dsh.client.inject` 里，用 `import` 直接引用（类型由 `src/client/primitives.d.ts` 补声明）。
- provider 列表由本插件自己的 Remote（`privacyGateway/providers`）从宿主 `llm.listProviders()` 取：浏览器侧的 `llm` remote 与本插件无关，不必依赖它。
- `showPanel` 声明为 `.volatile()`：设置服务（`configForms`）只把 volatile 字段放进可在线编辑的表单，改了不重新挂载插件，网关不会因此重装。host 半拿到的是一个活引用，`overview` 每次读它的当前值。
- 开关和标签页都从设置镜像读写 `showPanel`，并跟随它的变化，改完不用刷新页面。镜像里只有各插件的 volatile 字段，认自己的命名空间靠「有 `showPanel`，且命名空间名含 `privacy-gateway` 或 `showPanel` 的描述是本插件那一句」。没有镜像，或镜像里找不到时，标签页退回读 host 半 `overview` 里的 `showPanel`，每分钟问一次。
- 其余配置项不是 volatile，改了要重新挂载网关，仍在 `cordis.patch.yml` 里改；「设置」一节里有一句提示。
- 设置镜像里一个命名空间的 `schema` 是 schemastery 的 `toJSON()`：一张引用表 `{uid, refs}`，根节点在 `refs[uid]`，字段名在根节点的 `dict` 里，值是别的节点的编号。不要假设嵌套的 `dict`——按嵌套读的话字段名永远是空的（标签页的 `showPanel` 仍靠这条镜像跟随，见 `schemaFields`）。

## Consequences

- 从开到关，视图被撤销；已经切到这个视图的会话会落回「没有可用的视图」，点回「对话」即可。
- 卡片和标签页各自每 15 秒拉一次 `overview`，同时打开时请求翻倍；只在页面可见时拉。

## 补充（2026-10-31）：标签页怎么判定，以及它看的是哪个会话

- 标签页是否出现，以**宿主**的答案为准（`overview.showPanel`，就是网关真正在用的那个值），设置镜像只用来加快「开」——镜像还没跟上时不能把标签页挡住。两者都说「关」才真正撤销。宿主每 60 秒复核一次，在别处改了配置也能跟上。
- 面板内容是**当前会话**的：视图主体拿到 `sessionId`，`overview({ session })` 只回这个会话的记录与合计。按天的合计是落盘的、不分会话，所以会话视图以内存里保留的记录为界（默认最近 500 条）。
- 配置页在开关下面直接说明视图注册失败的原因（注册抛错或没拿到 disposer），而不是让人去猜。
