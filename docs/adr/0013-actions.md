# ADR-0013：按 kind 选动作：mask、warn、block

- 状态：Accepted（2026-10-31）
- 相关：`src/config.ts`、`src/redact/mask.ts`、`src/engine.ts`、`src/dispatcher.ts`、ADR-0005、ADR-0008

## Context

P1 对找到的值只有一种处理：换成占位符。有两类需求它满足不了：

- 想知道某类值发出去了多少，但不想让模型看不到它（比如邮箱，遮了会影响写信、查账号这类任务）。
- 某类值一旦出现就宁可不发（比如私钥），而不是遮掉了照发。

## Decision

- 配置 `actions` 是 kind → 动作的表，动作取 `mask`（默认）、`warn`、`block`。kind 不分大小写；不认识的动作按 `mask`。
- `warn`：值按原文发出，不进值表；记录里这个值带 `action: 'warn'`，请求的 `warned` 记处数。统计的按 kind 分布只算真正替换的值，warn 的另计。
- `block`：整个请求不发，dispatcher 以 `PrivacyGatewayError` 失败，`code` 为 `DSH_PRIVACY_GATEWAY_BLOCKED`（遮蔽出错仍是 `DSH_PRIVACY_GATEWAY_FAIL_CLOSED`）。错误信息只列 kind、开头和长度。记录标 `blocked`，不算遮蔽失败，不计入连续失败数。
- `allow` 优先于动作：白名单里的值不论 kind 都照发，也不记。
- `/privacy test` 预览里，warn 和 block 的值仍显示为占位符，后面注明会怎样处理。预览从不回显原文。

## Consequences

- 一个请求里同时有 block 和 mask 的值时，按 block 处理，整个请求不发。
- block 是确定性的：同一段历史每轮都会命中，会话会一直发不出去，直到用户把值从上下文里去掉、改动作，或 `/privacy off`。
- warn 的值从不进值表，所以 known 索引不会在别处认出它。
