# ADR-0017：会话右侧栏的「隐私保护」标签页，默认不出现

- 状态：Accepted（2026-10-31）
- 相关：`src/client/sidebar.ts`、`src/client/panelConfig.ts`、`src/client/index.ts`、ADR-0011

## Context

统计卡（ADR-0011）只在插件详情页，查看要离开会话、进设置、找到插件。用户希望在工作区里随手看，但不是每个人都要，常驻一个标签页会占右侧栏的位置。

## Decision

- 配置 `showPanel`，默认 `false`。打开后，会话右侧栏的标签类型里多一个「隐私保护」（英文 Privacy），右侧栏引导页也多一个入口；内容与详情页的统计卡相同，只是去掉卡片边框和标题。
- 注册照 dsh-git-panel 的三步：标签类型（`sidebarRightTabs.register`）、`sidebar.right.pane.tab` 的主体、`sidebar.right.pane.tab.title` 的标题，三者一起注册、一起撤销。
- 右侧栏的注册表服务是可选的：用延迟注入等它，不写进插件自己的 `inject`，宿主没有右侧栏时插件照常加载。`package.json` 的 `dsh.client.inject` 加上 `@deepseek-ai/dsh-client-ui-sidebar-right`。
- `showPanel` 的值从设置镜像（`configForms`）读，并跟随它的变化，改完配置不用刷新页面。镜像里认自己的命名空间靠 schema 同时有 `protectEnvBlock`、`cookieKeep`、`showPanel` 三个字段。没有镜像，或镜像里找不到时，退回读 host 半 `overview` 里的 `showPanel`，每分钟问一次。

## Consequences

- 从开到关，标签类型被撤销；已经打开的这个标签会显示右侧栏的「没有可用的视图」提示，关掉即可。
- 卡片和标签页各自每 15 秒拉一次 `overview`，同时打开时请求翻倍；只在页面可见时拉。
