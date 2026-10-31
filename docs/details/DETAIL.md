# 隐私网关

在 dsh 的进程里装一层脱敏网关：发给模型的请求里出现密钥、令牌、cookie 等敏感值时，先换成占位符再发出；模型回复里的占位符，在交给 agent 之前换回真值。拦截点在 undici 的全局 dispatcher，所有走 `fetch()` 的 provider 都经过它，包括插件提供的 adapter，agent 和 provider 都不用改。

## 功能

- **脱敏**：API key（OpenAI、Anthropic、GitHub、AWS、阿里云、腾讯云等前缀）、JWT、PEM 私钥、URL 和字段里的密码、cookie；可选脱敏邮箱、手机号、身份证号、银行卡号，以及自己配置的词。
- **还原**：JSON 回复整包还原，SSE 流式回复逐条事件还原，占位符被切在两条事件之间也能拼回。
- **保持缓存**：同一个值每轮都是同一个占位符，prompt cache 照常命中。
- **按 kind 选动作**：脱敏、照发并记录（warn），或整个请求不发（block）。
- **外带守卫**：工具调用参数里还原出真值、又指向本机以外的 host 时，告警，或者不还原。
- **同形伪装**：可选把密钥换成前缀、长度、字符类别都相同的假 key，模型看不出被脱敏过。
- **记录与统计**：只记脱敏和还原过的请求，记录里不写值本身；`/privacy` 命令查看状态和预览，插件详情页有统计卡，也可以打开会话右侧栏的「隐私保护」标签页。
- **失败不放行**：脱敏出错时请求不发出；`/privacy off` 可以临时关掉。

## 仓库

[github.com/xbzbing/dsh-privacy-gateway](https://github.com/xbzbing/dsh-privacy-gateway)：配置项、设计决策（ADR）和完整说明见仓库 README。
