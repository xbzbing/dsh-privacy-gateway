# ADR-0017：会话右侧栏的「隐私保护」标签页，默认不出现

- 状态：Accepted（2026-10-31）
- 相关：`src/client/sidebar.ts`、`src/client/panelConfig.ts`、`src/client/index.ts`、ADR-0011

## Context

统计卡（ADR-0011）只在插件详情页，查看要离开会话、进设置、找到插件。用户希望在工作区里随手看，但不是每个人都要，常驻一个标签页会占右侧栏的位置。

## Decision

- 配置 `showPanel`，默认 `false`。打开后，会话右侧栏的标签类型里多一个「隐私保护」（英文 Privacy），右侧栏引导页也多一个入口；内容与详情页的统计卡相同，只是去掉卡片边框和标题。
- 注册照 dsh-git-panel 的三步：标签类型（`sidebarRightTabs.register`）、`sidebar.right.pane.tab` 的主体、`sidebar.right.pane.tab.title` 的标题，三者一起注册、一起撤销。
- 右侧栏的注册表服务是可选的：用延迟注入等它，不写进插件自己的 `inject`，宿主没有右侧栏时插件照常加载。`package.json` 的 `dsh.client.inject` 加上 `@deepseek-ai/dsh-client-ui-sidebar-right`。
- 插件详情页不会为 bundle 自动生成配置表单，只渲染登记在 `plugins.bundle.config`、键为包名的条目。所以开关由本插件自己画：详情页上多一节「面板」，里面一个「在会话右侧栏显示「隐私保护」面板」的开关。
- `showPanel` 声明为 `.volatile()`：设置服务（`configForms`）只把 volatile 字段放进可在线编辑的表单，改了不重新挂载插件，网关不会因此重装。host 半拿到的是一个活引用，`overview` 每次读它的当前值。
- 开关和标签页都从设置镜像读写 `showPanel`，并跟随它的变化，改完不用刷新页面。镜像里只有各插件的 volatile 字段，认自己的命名空间靠「有 `showPanel`，且命名空间名含 `privacy-gateway` 或 `showPanel` 的描述是本插件那一句」。没有镜像，或镜像里找不到时，标签页退回读 host 半 `overview` 里的 `showPanel`，每分钟问一次。
- 其余配置项不是 volatile，改了要重新挂载网关，仍在 `cordis.patch.yml` 里改；「面板」一节里有一句提示。

## Consequences

- 从开到关，标签类型被撤销；已经打开的这个标签会显示右侧栏的「没有可用的视图」提示，关掉即可。
- 卡片和标签页各自每 15 秒拉一次 `overview`，同时打开时请求翻倍；只在页面可见时拉。
