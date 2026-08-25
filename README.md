# dsh-approval-llm

[![release](https://img.shields.io/npm/v/dsh-approval-llm?style=flat&label=release&color=blue)](https://www.npmjs.com/package/dsh-approval-llm)
[![downloads](https://img.shields.io/npm/dt/dsh-approval-llm?style=flat&label=downloads&color=blue)](https://www.npmjs.com/package/dsh-approval-llm)
[![stars](https://img.shields.io/github/stars/Letter2025/dsh-approval-llm?style=flat&label=stars&color=blue)](https://github.com/Letter2025/dsh-approval-llm)
[![license](https://img.shields.io/github/license/Letter2025/dsh-approval-llm?style=flat&label=license&color=blue)](LICENSE)
[![docs](https://img.shields.io/badge/docs-English%20%7C%20%E4%B8%AD%E6%96%87-0075cc?style=flat&labelColor=555555)](https://github.com/Letter2025/dsh-approval-llm/blob/main/README.zh.md)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

**Model-based permission approval (approve-for-me) for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

A community plugin that adds a **"model approval" permission mode** (approve-for-me) to DeepSeek Harness: in that mode, `approval/request` asks are answered by a **separate reviewer model** instead of a human — the reviewer decides `ALLOW / DENY / ESCALATE`, and the request only reaches a human when the reviewer cannot decide or fails. In every other permission mode the plugin stays silent, so human approval is never front-run by the model.

It is the dsh equivalent of Codex's `approvals_reviewer=auto_review` (`--approve-for-me`), and it follows the review design of AGENTSCOPE-PLAN-058 / 062 / 063 (orthogonal reviewer dimension, three-way decision, routing policy, prompt isolation, fail-to-human, circuit breaker).

> **Warning**: an AI reviewer is a policy choice, not a security guarantee. It can be fooled by prompt injection from tool output or the agent's own reason. Prefer it for low-risk workflows; keep `humanOnlyList`, the `denyList`, and the circuit breaker tight.

## Design

| Concept (this plugin) | Codex | AGENTSCOPE-PLAN-058 |
| --- | --- | --- |
| A dedicated permission mode activates the reviewer | `approvals_reviewer: auto_review` + `--approve-for-me` | UI preset `帮我批准` = `DEFAULT` + `ApprovalReviewer=MODEL` |
| Outside that mode the plugin delegates everything | human approval unchanged | `请求批准` = `DEFAULT` + `HUMAN` |
| Answer the `approval/request` waterfall | `approvals_reviewer: auto_review` | `ApprovalReviewer = MODEL` (orthogonal to the permission mode) |
| Deterministic routing before any model call | "deterministic sandbox/network allowlist runs before the guardian" | `SAFE_ALLOW / DENY / HUMAN_ONLY` routing policy |
| Reviewer model decides `ALLOW / DENY / ESCALATE` | Guardian subagent (`Approved / Denied / TimedOut / Abort`) | `ALLOW / DENY / ESCALATE` |
| Reviewer holds an isolated security policy | Guardian prompt isolated from the main agent | §4.5 prompt isolation |
| Tool description injected at review time | — | §4.5 dynamic tool-description injection |
| Tool arguments recovered from the session log | trust layering (arguments reviewed, not just the name) | §4.4 argument-level risk |
| Model failure → hand to human, not counted in the breaker | fail-closed guardian | §4.8 fail-to-human vs policy decision |
| Consecutive DENY threshold → hand off to a human | circuit breaker (3 consecutive) | §4.14 circuit breaker |
| Explicit `provider`/`model`, else the logged conversation route | — | PLAN-062 per-agent model config + fallback |
| Decision appended to the session as a user-visible message | guardian badge in the UI | DENY event pushed to the frontend (§4.17.5) |

## How it works

```
approval/request (waterfall)
   │
   ├─ enabled? no ────────────────────────────────► next() (unchanged)
   │
   ├─ mode gate: session preset ≠ modePreset ─────► next() (human approval unchanged)
   │    (default modePreset = model-approval)
   │
   ├─ RoutingPolicy (deterministic, no model call)
   │    ├─ denyList hit ──────────────────────────► 'rejected'
   │    ├─ allowlist hit ─────────────────────────► 'allowed-once'
   │    ├─ humanOnlyList hit ─────────────────────► next() (human decides)
   │    └─ else: REVIEW
   │
   ├─ circuit breaker: consecutive DENY ≥ max ────► next() (human takes over)
   │
   ├─ Reviewer model (isolated security-policy prompt)
   │    input: tool name + description (ctx.tools)
   │          + reason + tool arguments (from the session log `tool/call`)
   │    decision: ALLOW ──────────────────────────► 'allowed-once' (counter resets)
   │              DENY ───────────────────────────► 'rejected' (counter +1)
   │              ESCALATE ───────────────────────► next()
   │              timeout / parse error / provider error ─► next() (fail-to-human)
   │
   └─ ALLOW / DENY also append a user-visible decision message to the session,
      so the main chain records why the call was approved or denied.
```

- **ALLOW / DENY / ESCALATE map 1:1 onto the dsh outcome vocabulary** (`allowed-once` / `rejected` / delegate). ESCALATE and model failures never fabricate a rejection — they hand the request to the next answerer (the human UI), and a deployment with no human answerer fails closed (`unavailable`), exactly like Codex's fail-closed guardian.
- **The mode gate makes the modes exclusive.** In the `帮我批准` preset the reviewer answers; in `请求批准` (and every other preset) the plugin delegates, so human approval behaves exactly as before. The two presets share sandbox/approval knobs; the recorded `permission/preset` selection tells them apart.
- **One terminal answerer per deployment.** The dsh approval chain is not a priority list of competing judges — compose one answerer. To keep human override, put a human UI answerer behind this plugin (the waterfall `next()` reaches it).
- **Arguments are read from the session log**, not from the approval request (the request deliberately carries no arguments to avoid a second rendering that could drift).

## Configuration

All fields are validated by the Loader schema; defaults apply when omitted.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; when `false` every request is delegated unchanged. |
| `modePreset` | `model-approval` | The permission preset that activates the reviewer. When set, the plugin only answers asks from sessions whose effective preset equals this name; every other session delegates to the human channel. Set to `''` to review every ask. |
| `provider` / `model` | unset | Explicit reviewer route. Must be set together; when unset the plugin reuses the conversation route from the last `request/header` in the session log, and fails to human when the log has none. |
| `timeoutMs` | `60000` | End-to-end reviewer deadline; on expiry the request is handed to a human (TIMEOUT, not counted in the breaker). |
| `maxOutputTokens` | `256` | Reviewer output cap. |
| `systemPrompt` | built-in policy | Custom security policy for the reviewer. The built-in policy is a short allow-by-default, deny-on-critical-harm rule set; see `src/reviewer.ts`. |
| `allowlist` | `[]` | Tool names auto-approved without a model call (SAFE_ALLOW). |
| `denyList` | `[]` | Tool names rejected outright without a model call. Wins over the allowlist. |
| `humanOnlyList` | `[]` | Tool names that must be decided by a human; never auto-reviewed. |
| `maxConsecutiveDenials` | `3` | Consecutive DENY threshold per session before the reviewer hands off to a human; `0` disables the breaker. ALLOW resets the counter. |
| `maxArgsChars` | `4000` | Cap on tool-argument JSON rendered to the reviewer. |
| `includeArgs` | `true` | Recover tool arguments from the session log for the review. |
| `notifyUser` | `true` | Append a user-visible decision message (`✅ 模型审批通过/❌ 模型审批拒绝` with the risk and reason) to the session after every model ALLOW/DENY, so the main chain records why. |

Example overlay (`cordis.patch.yml` of your profile):

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

## Install

> **Copy-paste for an AI agent** — hand this one sentence to any AI coding agent to have it install the plugin for you: "Read https://github.com/Letter2025/dsh-approval-llm/blob/main/README.md and follow its `## Install` section to install the `dsh-approval-llm` bundle into the DeepSeek Harness web profile, restart the `dsh web` server, and verify that the permission selector shows the `model-approval` (帮我批准) preset with its shield-sparkle icon."

### As an installable bundle (recommended)

This package declares `dsh.bundle.patch` in its `package.json`, so installing it activates a configuration layer that inserts the plugin row **and** adds the `model-approval` ("帮我批准") preset to the `permission` table — no manual preset config needed:

```sh
dsh plugin --profile web add dsh-approval-llm   # installs the published npm package
```

Restart `dsh web`, then pick **帮我批准** in the permission selector (the Access chip in the input bar, which carries a shield-sparkle glyph) to switch that session's reviewer to the model. The preset table is process-level, so changing presets requires a dsh restart.

In-box bundle rows resolve from the dsh installation itself; the `@deepseek-ai/*` imports are `peerDependencies` provided by the host dsh, so pin your dsh version (the project is in developer preview with breaking changes). Installing from a local checkout instead: `pnpm run build`, then `dsh plugin --profile web add ./dsh-approval-llm` from the parent directory.

### Bundled skill: configure the reviewer

The package ships one bundled skill (`configure-approval-llm`, source `bundled`), so installing the plugin also puts a configuration guide in the skill catalog. Ask any agent to "configure the approval reviewer", or load the skill directly — it walks an **AI-proposes / user-confirms** flow: probe the current model and provider settings, write the `approval-llm` overlay into `~/.dsh/profiles/web/cordis.patch.yml`, then present the full config for your confirmation before a restart takes effect. The guide covers choosing a reviewer model (same provider preferred, `contextWindow` ≥ the main model), and tightening `allowlist` / `denyList` / `humanOnlyList` / `maxConsecutiveDenials` for your deployment.

### As a source overlay (dev)

```yaml
- insert:
    - id: approval-llm
      name: './src/index.ts'        # path to this package's entry, or an absolute path
      config:
        provider: deepseek-official
        model: deepseek-v4-flash
```

Run dsh with the overlay (`dsh web --patch ./cordis.patch.yml`), or merge the row into your profile's `cordis.patch.yml`. The source overlay inserts only the plugin row, not the preset — either also install the bundle layer above, or add the `model-approval` preset to the `permission` row yourself (a patch replaces the whole row config, so restate every preset):

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

## Build & test

The plugin lives inside the DeepSeek Harness checkout at `custom_plugin/dsh-approval-llm`; `@deepseek-ai/*` resolves against the checkout's own `node_modules` (built `lib` declarations + `@types`), so keep the harness built (`pnpm run build` at the repo root). The `node_modules` junction into the harness is provided by the checkout.

```sh
pnpm run typecheck   # tsc --noEmit (strict)
pnpm run test        # vitest: 39 unit tests, no network
pnpm run build       # tsc emit to lib/ (ESM, relative imports rewritten)
```

## Roadmap

- **Client-side badge & toggle**: a browser half (`dsh.client` in this package) can render a shield icon on tool cards whose ask the reviewer decided, and a settings row that writes the plugin's `enabled`/`modePreset` to a hot-reloaded settings namespace. The host loader already discovers `dsh.client` packages from the same row, so the install path is unchanged.
- **Batch review** (PLAN-063): one reviewer call for several pending tools needs a batch entry point in the approval service.
- **Wildcard / argument-pattern routing** in the deterministic policy.

## Security model

- **Mode gating keeps human approval unchanged**: outside the configured preset the plugin delegates every request, so `请求批准` behaves exactly as before the plugin existed.
- **Prompt isolation**: the reviewer prompt is assembled by this plugin from its own config; the main agent never sees the security policy, so it cannot tailor asks to pass review. Tool descriptions come from the live registry (`ctx.tools.schemas()`), arguments from the durable log — the reviewer judges the real call, not the agent's claim.
- **Fail-to-human**: `TIMEOUT`, `PARSE_ERROR`, and provider errors produce ESCALATE (delegate), never a fabricated denial, and are not counted in the circuit breaker (PLAN-058 §4.8 separation of model failure from policy decision).
- **Fail-closed by composition**: a deployment with no human answerer resolves `unavailable`, which callers treat as denial.
- **Circuit breaker**: `maxConsecutiveDenials` consecutive DENY on one session hands the rest of the session's asks to a human — the reviewer stops being the judge when it keeps saying no.
- **Sensitive data**: review input (tool arguments, reason) is used only for the reviewer request and structured logs; it is not stored beyond the ordinary session log and console output. Turn `includeArgs` off if arguments are sensitive.

## Known limitations

- **No dedicated log-only audit event.** Model decisions are visible in the main chain as `user/message` notices (durable and replayable), and the built-in `approval/asked` + `approval/decided` pair records the ask/outcome. A dedicated machine-readable audit event (like a `session/approval-llm-request` with the full review context) is still blocked by the harness persistence policy for out-of-repo event types; when the harness ships a registration surface, this plugin should add one.
- **No client-side badge (yet).** The decision notice appears as a transcript message; a Codex-style shield icon anchored to the tool card needs a client plugin (the package ships no browser half yet). See the roadmap below.
- **One request per model call.** PLAN-063's batch review (one call for several pending tools) needs a batch entry point in the approval service; the dsh seam processes one request at a time. Per-request latency is bounded by `timeoutMs` and the reviewer model choice.
- **AI-reviewer trust is a deployment decision.** The reviewer can be prompt-injected through tool output. Keep `humanOnlyList`, `denyList`, and the breaker configured; do not enable this for high-risk, unattended workflows.
- **Exact-name routing only.** Lists match whole tool names; there is no wildcard or argument-pattern matching. Add patterns as a follow-up if needed.

## License

MIT
