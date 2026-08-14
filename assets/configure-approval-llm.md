# 配置 dsh-approval-llm 评审模型

本技能引导你（AI）为 dsh-approval-llm 插件配置评审模型（provider/model）及相关策略，遵循「AI 先配置，用户确认」流程：探测 → AI 写入配置 → 用户确认。

## 0. 前置检查

确认插件已安装：`dsh plugin --profile web list` 或检查 `~/.dsh/profiles/web/package.json` 的 dependencies 里有 `dsh-approval-llm`。未安装先执行 `dsh plugin --profile web add dsh-approval-llm`。

确认插件行存在：bundle 安装后插件行由插件自带的 `cordis.patch.yml` 插入（id `approval-llm`）；用户覆盖写在 `~/.dsh/profiles/web/cordis.patch.yml`。两处都没有时，插件仍以默认配置运行（评审路由回退会话日志）。

## 1. 探测当前配置

用 read 工具读取：

1. `~/.dsh/settings.yaml`
   - `agent-default-model`：当前主模型（`provider` + `model`）
   - `llm-pi-ai.providers`：各 provider 的 `displayName`、`baseURL`、`models` 列表（模型的 `id` 与 `contextWindow`）
2. `~/.dsh/profiles/web/cordis.patch.yml`：当前是否已有 `approval-llm` 行覆盖、`provider`/`model`/`allowlist`/`denyList`/`humanOnlyList` 等是什么
3. 若想确认插件当前实际生效的评审路由：查看会话日志里最近的 `approval/request` 决策记录（`result.route` 字段显示实际使用的 provider/model），或直接问用户

注意：settings.yaml 含密钥字段（`apiKeyEnv` 只是环境变量名，安全；但若看到明文 key 不要复述）。

## 2. 决策评审模型（按此优先级）

- **显式配置优先**：`provider`/`model` 成对出现。建议与主模型**同 provider**（同一网关、同一凭据，无需额外配置 key）。
- **模型选择**：优先 `contextWindow ≥ 主模型` 的模型（评审输入含工具参数，窗口不足会截断）；同 provider 下列出 1–2 个候选。
- **不设置时行为**：省略 `provider`/`model`，插件回退到会话日志最后一次 `request/header` 的对话路由；日志中没有则 fail-to-human（转人工）。这是「跟随主对话」模式，适合想让评审模型与主模型一致的情况。

示例：主模型 `cx/deepseek-v4-flash`（网关 ai-api.libsou.com）→ 建议 `cx/deepseek-v4-flash`（同网关，评审与主模型一致）或 `cx/MiniMax-M3`（同网关、1M 窗口）。不要建议官方 `deepseek` 路由，除非确认用户配置了官方 key。

## 3. AI 先写入配置

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，添加或更新 `approval-llm` 行的覆盖。

⚠️ **patch 是整行替换语义**：覆盖时必须重述**全部字段**（`enabled`/`modePreset`/`provider`/`model`/`timeoutMs`/`maxOutputTokens`/`systemPrompt`/`allowlist`/`denyList`/`humanOnlyList`/`maxConsecutiveDenials`/`maxArgsChars`/`includeArgs`/`notifyUser`），漏掉任何字段都会被重置为默认值。默认值见插件 `src/index.ts` 的 `Config` 定义。

完整模板（把 `<...>` 替换为实际值；不需要的字段删除，但已配置的字段必须全部保留）：

```yaml
- id: approval-llm
  config:
    enabled: true
    modePreset: model-approval
    provider: <评审 provider>
    model: <评审模型 id>
    timeoutMs: 60000
    maxOutputTokens: 256
    allowlist: [read, read_image, glob, grep]
    denyList: [job_kill]
    humanOnlyList: [delete, terminal_send]
    maxConsecutiveDenials: 3
    maxArgsChars: 4000
    includeArgs: true
    notifyUser: true
```

按场景调整：

- **只显式指定评审模型**：配置 `provider` + `model`，其余字段按默认或用户既有值。
- **收紧安全策略**：把敏感工具加入 `humanOnlyList`（绝不自动评审）或 `denyList`（直接拒绝）。
- **低风险工具免评审**：加入 `allowlist`（SAFE_ALLOW，零模型调用）。
- **自定义评审策略**：提供 `systemPrompt`（覆盖内置策略；内置策略是"默认放行、关键危害才拒绝"的短规则集）。
- **关闭决策消息**：`notifyUser: false`。

写入前先在上下文里保留旧内容（用户反悔时恢复）。若原文件已有其他行的覆盖（如 `permission`、`model-failover` 行），只增改 `approval-llm` 行，不要动其他行。

## 4. 请用户确认

写入后，把以下内容展示给用户并请求确认：

- 当前主模型（会话实际使用的 provider/model）
- 建议的评审模型及理由（同网关、窗口大小、与主模型一致/独立）
- 已写入 `~/.dsh/profiles/web/cordis.patch.yml` 的完整配置（贴出来）
- 说明各列表（allowlist/denyList/humanOnlyList）当前包含的工具

用户确认后提示：

> 需要重启 `dsh web` 使新配置生效（预设表与插件配置在启动时读取）。

用户不确认/要求修改：按用户意见调整或恢复旧内容，不要强行保留。

## 5. 校验（可选）

1. 确认预设已出现：重启后权限选择器里有 `model-approval`（帮我批准）。
2. 确认评审路由：把某个不在 allowlist/denyList/humanOnlyList 的工具设为需要审批，触发一次审批，观察会话里的决策消息（`✅/❌ 模型审批…`），说明评审模型被调用。
3. 查看决策日志（插件以 `[dsh-approval-llm]` 前缀记录每次决策的 route/risk/decision）。

## 6. 已知边界（不要承诺做不到的事）

- 预设表是进程级：修改 `permission` 预设需要重启 dsh。
- 评审路由配置是启动时读取的：改 `cordis.patch.yml` 后必须重启。
- 模型决策消息（`notifyUser`）会进入会话日志，是主链路可复查的持久记录；没有专门的机器可读审计事件（见插件 README 已知限制）。
- AI 评审可被提示注入欺骗：收紧 `humanOnlyList`/`denyList`，高风险无人值守工作流不要启用。
