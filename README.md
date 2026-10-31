# dsh-pollinations-free

把 **[enter.pollinations.ai](https://enter.pollinations.ai/)** 上的免费模型（官方 + 社区）装载进 DeepSeek Harness 的模型选择器。参考 `dsh-our-free-model` 的结构性适配器写法：一个 Host 半身 + 一个设置页 Client 半身，无构建步骤。

## 安装

DeepSeek Harness → 设置 → 插件 → 「添加插件」，指向本目录即可（`install_bundle` 会把包复制进 profile 的 `node_modules`，之后移动或删除本目录都不影响已装插件）。

## 设置

设置 → 侧边栏「Pollinations 免费模型」：

| 配置 | 说明 |
|---|---|
| **API Key** | 去 https://enter.pollinations.ai/keys 免费领取。留空 = 只用匿名经典通道（`openai-fast`）；填入后解锁官方 gen 通道与全部社区模型。保存后不回显，只显示「已设置」。 |
| 启用插件 | 总开关 |
| 隐藏社区分组 | 关掉 `Pollinations Community` 分组 |
| 无 key 时隐藏需 key 模型 | 默认全显示，选中时给出取 key 提示 |
| 匿名模型也走 gen 网关 | `preferGenApi` |
| referrer | 仅匿名经典通道发送，gen 网关会 400 拒绝该字段 |
| 默认输出上限 / 刷新间隔 | `defaultMaxTokens` / `refreshMinutes` |

改动**即时生效，无需重启**。所有值持久化在 `~/.dsh/pollinations-free/settings.json`（key 永远不出宿主进程：GET 只报「已设置」布尔位，POST 接受但不回显）。

## 工作原理

- **目录同步**：读取 enter.pollinations.ai 前端自己使用的 `https://gen.pollinations.ai/models?reliability=all`，合并匿名源 `https://text.pollinations.ai/models`。「免费」判定逐字照抄官方前端 `model-catalog` 的谓词（prompt/completion 任一侧都没有单价、无付费 adjustments/variants、非 agent、非 paid_only）。默认每 60 分钟刷新。
- **两个路由分组**：`Pollinations Free`（官方）、`Pollinations Community`（社区）。
- **两条通道**：
  - `text.pollinations.ai`（匿名）— OpenAI Chat 兼容，流式 + 工具调用已验证；
  - `gen.pollinations.ai` — 承载其余免费模型，需 API key。
- **设置 API**：同源 `/api/pollinations-free/settings`（GET/POST）与 `/refresh`，由宿主 `webServer` 注册，客户端半身经它读写。

## 已知边界

- 免费通道速率由 pollinations 侧决定（部分社区模型 `per_user_rpm` 只有个位数）；429/402 上报为 `RATE_LIMIT` / `QUOTA_EXHAUSTED`。
- 超出模型实际上下文（部分社区模型目录标注虚高）或请求体过大时，gen 网关返回 400；插件将其映射为 `CONTEXT_WINDOW_EXCEEDED` / `CLIENT_ERROR`，宿主不做无意义重试。
- 账号 token 额度（如 welcome tokens 用尽）以 502 透传，需要自行在 enter.pollinations.ai 上订阅或等待重置。

## License

MIT
