# ADR-0020：记录带上工作区与会话名称

- 状态：Accepted（2026-10-31）
- 相关：`src/providers.ts`、`src/dispatcher.ts`、`src/engine.ts`、`src/client/StatsCard.ts`、ADR-0008、ADR-0018

## Context

记录只说请求去了哪个 host、哪个模型，看不出是哪一次会话、哪个工作区。排障时最常问的就是「这条是谁发的」。会话 id 目前只在 oc2dsh 这类客户端自带的 header 里（`x-opencode-session`），dsh 自己的模型调用不带。

## Decision

- 被排除 provider 的会话上下文（ADR-0018 的 `AsyncLocalStorage`）顺带记下 `sessionId`：`llm/stream` 的 `options.sessionId` 就是这一层唯一拿得到的会话身份。每个流都在自己的上下文里跑，没有放行 provider 时上下文仍带着会话。
- dispatcher 取会话的顺序：先看请求头，没有就用上下文里的（dsh 自己的调用走这条）。
- 引擎在写记录时按会话 id 查两个名字：标题来自 `sessions.get(id)` + `sessionTitle.get(session)`，工作区名来自 `workspaceRegistry.list()` 里 `sessionIds` 含它的那个。两个服务都可选，取不到就只留 id。
- 名字在写记录的那一刻取，不是展示时补：记录是当时的样子，改名之后旧记录仍是旧名字。名字截到 200 字符。
- 记录新增 `title`、`workspace` 两个字段；统计卡每条记录多一列「来源」，显示 `工作区 · 会话标题`，没有标题时显示 id。

## Consequences

- 嵌套调用按自己的会话记（内层 `llm/stream` 有自己的 `sessionId`）。
- 会话标题由另一次模型调用生成，第一次请求时可能还没有标题，那一条记录就只有 id。
- 不经过 `llm/stream` 的请求（其他插件自己发的）没有会话，记录与以前一样。
