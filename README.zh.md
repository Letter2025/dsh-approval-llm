# dsh-approval-llm

[![release](https://img.shields.io/npm/v/dsh-approval-llm?style=flat&label=release&color=blue)](https://www.npmjs.com/package/dsh-approval-llm)
[![downloads](https://img.shields.io/npm/dt/dsh-approval-llm?style=flat&label=downloads&color=blue)](https://www.npmjs.com/package/dsh-approval-llm)
[![stars](https://img.shields.io/github/stars/Letter2025/dsh-approval-llm?style=flat&label=stars&color=blue)](https://github.com/Letter2025/dsh-approval-llm)
[![license](https://img.shields.io/github/license/Letter2025/dsh-approval-llm?style=flat&label=license&color=blue)](LICENSE)
[![docs](https://img.shields.io/badge/docs-English%20%7C%20%E4%B8%AD%E6%96%87-0075cc?style=flat&labelColor=555555)](https://github.com/Letter2025/dsh-approval-llm/blob/main/README.md)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[English](https://github.com/Letter2025/dsh-approval-llm/blob/main/README.md) | 中文

**面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的模型审批插件（approve-for-me）。**

[English](README.md) | 中文

一个社区插件：为 DeepSeek Harness 增加一个**"帮我批准"权限模式**。在该模式下，`approval/request` 的审批请求由**独立的评审模型**代替人工判定——评审模型给出 `ALLOW / DENY / ESCALATE`，只有拿不准或模型故障时才转人工。在其他任何权限模式下插件保持沉默，**模型审批永远不会抢在人工审批前面**。

它对应 Codex 的 `approvals_reviewer=auto_review`（`--approve-for-me`），并遵循 AGENTSCOPE-PLAN-058 / 062 / 063 的评审设计（正交的 reviewer 维度、三值决策、路由策略、Prompt 隔离、fail-to-human、熔断）。

> **警告**：AI 评审是一种策略选择，不是安全保证。它可能被工具输出或 agent 自身理由中的提示注入欺骗。建议用于低风险工作流；务必收紧 `humanOnlyList`、`denyList` 和熔断参数。

## 设计对照

| 本插件概念 | Codex | AGENTSCOPE-PLAN-058 |
| --- | --- | --- |
| 专门的权限模式激活评审模型 | `approvals_reviewer: auto_review` + `--approve-for-me` | UI 档位 `帮我批准` = `DEFAULT` + `ApprovalReviewer=MODEL` |
| 该模式之外全部委托 | 人工审批不变 | `请求批准` = `DEFAULT` + `HUMAN` |
| 应答 `approval/request` 瀑布 | `approvals_reviewer: auto_review` | `ApprovalReviewer = MODEL`（与权限模式正交） |
| 模型调用前的确定性路由 | "确定性沙箱/网络 allowlist 在 guardian 评审之前执行" | `SAFE_ALLOW / DENY / HUMAN_ONLY` 路由策略 |
| 评审模型判定 `ALLOW / DENY / ESCALATE` | Guardian 子代理（`Approved / Denied / TimedOut / Abort`） | `ALLOW / DENY / ESCALATE` |
| 评审模型持有隔离的安全策略 | Guardian prompt 与主 agent 隔离 | §4.5 Prompt 隔离 |
| 评审时动态注入工具描述 | — | §4.5 工具描述动态注入 |
| 从会话日志取回工具参数 | 信任分层（评审参数而非只看工具名） | §4.4 参数级风险 |
| 模型故障 → 转人工，不计熔断 | fail-closed guardian | §4.8 fail-to-human 与策略拒绝分离 |
| 连续 DENY 达阈值 → 转人工 | 熔断（连续 3 次） | §4.14 熔断 |
| 显式 `provider`/`model`，否则回退会话路由 | — | PLAN-062 每 agent 配置 + 回退 |
| 决策以用户可见消息写入会话 | UI 上的 guardian 徽标 | DENY 事件推送到前端（§4.17.5） |

## 工作方式

```
approval/request（瀑布）
   │
   ├─ enabled=false？ ────────────────────────────► next()（原样委托）
   │
   ├─ 模式门：会话 preset ≠ modePreset ───────────► next()（人工审批不变）
   │    （默认 modePreset = model-approval）
   │
   ├─ RoutingPolicy（确定性，无模型调用）
   │    ├─ 命中 denyList ─────────────────────────► 'rejected'
   │    ├─ 命中 allowlist ────────────────────────► 'allowed-once'
   │    ├─ 命中 humanOnlyList ────────────────────► next()（人工决定）
   │    └─ 其余：REVIEW
   │
   ├─ 熔断：连续 DENY ≥ max ──────────────────────► next()（人工接管）
   │
   ├─ 评审模型（隔离的安全策略 prompt）
   │    输入：工具名 + 描述（ctx.tools）
   │         + reason + 工具参数（来自会话日志 tool/call）
   │    判定：ALLOW ──────────────────────────────► 'allowed-once'（计数归零）
   │           DENY ──────────────────────────────► 'rejected'（计数 +1）
   │           ESCALATE ──────────────────────────► next()
   │           超时 / 解析失败 / 模型故障 ─────────► next()（fail-to-human）
   │
   └─ ALLOW / DENY 还会往会话追加一条用户可见的决策消息，
      主链路因此记录"为什么通过/拒绝"。
```

- **ALLOW / DENY / ESCALATE 与 dsh 结果词汇一一对应**（`allowed-once` / `rejected` / 委托）。ESCALATE 和模型故障永远不会伪造拒绝——它们把请求交给下一个 answerer（人工 UI）；没有人工 answerer 的部署按 fail-closed 解析为 `unavailable`，调用方视为拒绝，与 Codex 的 fail-closed guardian 一致。
- **模式门保证各模式互斥**。在 `帮我批准` 预设下评审模型应答；在 `请求批准`（及其他预设）下插件全部委托，人工审批行为与装插件前完全一致。两个预设共享 sandbox/approval 旋钮，靠记录的 `permission/preset` 选择区分。
- **一个部署一个 terminal answerer**。dsh 审批链不是多个裁判的优先级列表——只组合一个 answerer。要保留人工兜底，就把人工 UI answerer 放在本插件之后（瀑布的 `next()` 会到达它）。
- **参数从会话日志读取**，而非审批请求本身（审批请求刻意不带参数，避免渲染出第二份可能漂移的副本）。

## 配置

所有字段都由 Loader schema 校验，省略时取默认值。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 时所有请求原样委托。 |
| `modePreset` | `model-approval` | 激活评审模型的权限预设名。设置后，只有当会话的有效预设等于该值时插件才应答；其他会话全部委托给人工通道。设为 `''` 则审查所有请求。 |
| `provider` / `model` | 未设置 | 显式评审路由。必须成对出现；未设置时复用会话日志中最后一次 `request/header` 的对话路由，日志中没有则 fail-to-human。 |
| `timeoutMs` | `60000` | 评审请求端到端超时；超时后转人工（TIMEOUT，不计熔断）。 |
| `maxOutputTokens` | `256` | 评审输出上限。 |
| `systemPrompt` | 内置策略 | 评审模型的自定义安全策略。内置策略是"默认放行、关键危害才拒绝"的短规则集，见 `src/reviewer.ts`。 |
| `allowlist` | `[]` | 免模型调用直接放行的工具名（SAFE_ALLOW）。 |
| `denyList` | `[]` | 免模型调用直接拒绝的工具名。优先于 allowlist。 |
| `humanOnlyList` | `[]` | 必须人工决定的工具名；绝不自动评审。 |
| `maxConsecutiveDenials` | `3` | 每会话连续 DENY 阈值，达到后评审模型转人工；`0` 关闭熔断。ALLOW 会重置计数。 |
| `maxArgsChars` | `4000` | 渲染给评审模型的工具参数 JSON 上限。 |
| `includeArgs` | `true` | 是否从会话日志取回工具参数参与评审。 |
| `notifyUser` | `true` | 每次模型 ALLOW/DENY 后往会话追加一条用户可见的决策消息（`✅ 模型审批通过 / ❌ 模型审批拒绝`，含风险与理由），主链路可复查。 |

示例覆盖层（profile 的 `cordis.patch.yml`）：

```yaml
- id: approval-llm
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
    allowlist: [read, read_image, glob, grep]
    humanOnlyList: [delete, terminal_send]
    denyList: [job_kill]
    maxConsecutiveDenials: 3
```

## 安装

> **复制给 AI 的一句话**——把这一句话交给任意 AI 编程 agent，让它帮你完成安装："请阅读 https://github.com/Letter2025/dsh-approval-llm/blob/main/README.md 并遵循其『## 安装』章节，把 `dsh-approval-llm` bundle 安装进 DeepSeek Harness 的 web profile，然后重启 `dsh web` 服务，并确认权限选择器里出现带盾牌+星芒图标的 `model-approval`（帮我批准）预设。"

### 作为可安装 bundle（推荐）

本包在 `package.json` 中声明了 `dsh.bundle.patch`，安装后会激活一个配置层：既插入插件行，也往 `permission` 权限表添加 `model-approval`（"帮我批准"）预设——无需再手动配置预设：

```sh
dsh plugin --profile web add dsh-approval-llm   # 从 npm 安装已发布的包
```

重启 `dsh web`，然后在权限选择器（输入栏的 Access chip，带盾牌+星芒图标）里选 **帮我批准**，即可把该会话的审批人切换为模型。预设表是进程级的，修改预设需要重启 dsh。

In-box bundle 的行名从 dsh 安装本身解析；`@deepseek-ai/*` 导入是 `peerDependencies`，由宿主 dsh 提供，所以请锁定 dsh 版本（项目处于开发者预览，有破坏性变更）。想从本地检出安装：先 `pnpm run build`，再在父目录执行 `dsh plugin --profile web add ./dsh-approval-llm`。

### 随包技能：引导配置评审模型

本包随附一个 bundled 技能（`configure-approval-llm`，source `bundled`），安装插件后技能自动进入目录。让任意 agent「配置审批评审模型」，或直接加载该技能——它遵循 **AI 先配置、用户确认** 的流程：先探测当前模型与 provider 设置，把 `approval-llm` 覆盖行写入 `~/.dsh/profiles/web/cordis.patch.yml`，再贴出完整配置等你确认后才重启生效。指南覆盖评审模型选型（同 provider 优先、`contextWindow ≥ 主模型`），以及按部署收紧 `allowlist` / `denyList` / `humanOnlyList` / `maxConsecutiveDenials`。

### 源码覆盖层（开发用）

```yaml
- insert:
    - id: approval-llm
      name: './src/index.ts'        # 本包入口的路径，或绝对路径
      config:
        provider: deepseek-official
        model: deepseek-v4-flash
```

用 `dsh web --patch ./cordis.patch.yml` 运行，或把该行并入 profile 的 `cordis.patch.yml`。源码覆盖层只插入插件行，不含预设——要么同时安装上面的 bundle 层，要么自己往 `permission` 行里加 `model-approval` 预设（patch 会替换整行 config，所以要写全所有预设）：

```yaml
- id: permission
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
        name: 只读
      workspace-write:
        sandbox: workspace-write
        approval: ask
        name: 请求批准
      model-approval:
        sandbox: workspace-write
        approval: ask
        name: 帮我批准
        description: 审批由独立的评审模型决定；拿不准或模型故障时转人工。
      danger-full-access:
        sandbox: danger-full-access
        approval: never
        name: 完全放开
```

## 构建与测试

插件位于 DeepSeek Harness 检出内部的 `custom_plugin/dsh-approval-llm`；`@deepseek-ai/*` 解析到该检出自己的 `node_modules`（构建产物 `lib` 声明 + `@types`），因此请在仓库根目录保持 harness 已构建（`pnpm run build`）。指向 harness `node_modules` 的 junction 由检出提供。

```sh
pnpm run typecheck   # tsc --noEmit（严格模式）
pnpm run test        # vitest：39 个单元测试，无网络
pnpm run build       # tsc 产出 lib/（ESM，相对导入重写）
```

## 路线图

- **客户端徽标与开关**：给本包加浏览器半（`dsh.client`），可以在工具卡片上渲染评审模型的决策徽标（盾牌图标），并提供写回 `enabled`/`modePreset` 的设置行（写入热重载的设置命名空间）。宿主 loader 已经从同一行发现 `dsh.client` 包，安装路径不变。
- **批量评审**（PLAN-063）：一次评审多个待审批工具，需要 approval 服务先支持批量入口。
- **通配符 / 参数模式路由**：确定性策略支持按工具名/参数模式匹配。

## 安全模型

- **模式门保证人工审批不变**：在配置的预设之外插件全部委托，`请求批准` 的行为与装插件前完全一致。
- **Prompt 隔离**：评审 prompt 由本插件依据自身配置组装，主 agent 永远看不到安全策略，无法针对评审定制请求。工具描述取自实时注册表（`ctx.tools.schemas()`），参数取自持久化日志——评审模型评判的是真实调用，而不是 agent 的自述。
- **fail-to-human**：`TIMEOUT`、`PARSE_ERROR` 和 provider 错误产生 ESCALATE（委托），绝不伪造拒绝，且不计入熔断（PLAN-058 §4.8 模型故障与策略拒绝分离）。
- **组合即 fail-closed**：没有人工 answerer 的部署解析为 `unavailable`，调用方按拒绝处理。
- **熔断**：单会话连续 DENY 达到 `maxConsecutiveDenials` 后，该会话后续请求转人工——评审模型持续拒绝时就不再当裁判。
- **敏感数据**：评审输入（工具参数、reason）仅用于评审请求和结构化日志，除常规会话日志与控制台输出外不额外落盘。参数敏感时可关闭 `includeArgs`。

## 已知限制

- **没有专门的机器可读审计事件**。模型决策以 `user/message` 通知的形式出现在主链路（可持久化、可重放），内置的 `approval/asked` + `approval/decided` 审计对记录请求与结果。专门的机器可读审计事件（如携带完整评审上下文的 `session/approval-llm-request`）仍受 harness 对仓库外事件类型的持久化策略限制；等 harness 开放注册通道后应补充。
- **暂无客户端徽标**。决策通知以对话消息呈现；Codex 式锚定在工具卡片上的盾牌图标需要客户端插件（本包暂未提供浏览器半）。见路线图。
- **一次请求一次模型调用**。PLAN-063 的批量评审需要 approval 服务先支持批量入口；单请求延迟受 `timeoutMs` 和评审模型选择约束。
- **AI 评审的信任是部署决策**。评审模型可能被工具输出提示注入。请配置好 `humanOnlyList`、`denyList` 和熔断；不要在高风险无人值守工作流中启用。
- **仅精确名称路由**。列表匹配完整工具名，不支持通配符或参数模式匹配。

## 许可证

MIT
