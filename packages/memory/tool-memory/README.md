# @deepseek-ai/dsh-tool-memory

English | [中文](README.zh.md)

Model-facing consumer for the [memory capability seam](../memory/README.md): it registers the `memory_save`, `memory_search`, and `memory_forget` tools, a guidance system-prompt section, and the recall section that injects the user's memory profile into every assembled prompt. Execution goes through `ctx.memory`; this package owns schemas, validation, guidance, and recall, never provider selection or network access.

## Tools

| Tool | Arguments | Notes |
|---|---|---|
| `memory_save` | `content` (non-empty text), `scope` (`project` or `global`) | Stores one memory; the output names the id and scope. |
| `memory_search` | `query`, `scope`, optional `limit` (integer 1–25) | `limit` is capped by `MEMORY_SEARCH_MAX_LIMIT = 25`; the output lists `[id] content` hits or the empty notice. |
| `memory_forget` | `id` (non-empty) | Removes one stored memory by id. |

Config flags `save`, `searchAndForget`, and `recall` (all default `true`) select the tool families and the recall section; the guidance section `tool:memory` (order 120) registers whenever either tool family is enabled. The project scope id is derived at execution time from the process working directory (nearest ancestor containing `.git`, else the working directory itself); a scope word other than `project` or `global` throws `MemoryError` code `MEMORY_REQUEST_INVALID`. An enabled tool stays visible when its provider is unavailable and fails with a structured error at execution time.

## Recall

The `system-prompt/assemble` waterfall listener awaits `next()`, fetches `ctx.memory.profile()`, and appends the section `memory-profile` (`MEMORY_PROFILE_SECTION_NAME`) after all ordered sections, so it renders last in the joined prompt. An empty profile contributes no section; any recall failure degrades to a logged warning with the section omitted — an unreachable memory service must not fail the session. Assembled sections are part of the assembly result, so injected text stays reconstructable from the session log.

## Model Experience

### Guidance system prompt

#### What the model sees

Section `tool:memory` (order 120) in every assembled prompt while either tool family is enabled; the exact text follows.

##### Guidance section text

```markdown
Persistent memory spans sessions. When the user asks you to remember something, or states a durable preference or decision, store it with memory_save — use scope "project" for repository-specific knowledge and "global" for user-level preferences. Before acting on assumptions about the user or this project, consider memory_search. memory_forget removes one memory by id.
```

#### Token effect

Fixed per assembly while enabled; zero when both `save` and `searchAndForget` are disabled.

#### KV Cache effect

Stable repeated prefix across requests in one session; disabling either tool family or editing this text invalidates reuse from the next assembly.

### Tool schemas

#### What the model sees

The model sees the generated [`memory_save`, `memory_search`, and `memory_forget` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-memory), summarized in the table above: `memory_save(content, scope)`, `memory_search(query, scope, limit?)` with `limit` bounded to 1–25, and `memory_forget(id)`.

#### Token effect

Conditional: the three tool definitions accompany every request while their config flags are on; each disabled family removes its definitions.

#### KV Cache effect

Config-flag changes replace request tokens by adding or removing tool definitions; execution results enter only tool-result turns.

### Recall section

#### What the model sees

Section `memory-profile` appended after all ordered sections, so it renders last: the fixed lead line `Durable memories about the user and past sessions:` followed by the provider's profile summary.

#### Token effect

Conditional: zero while the profile is empty or `recall` is off; otherwise profile-length text per assembly.

#### KV Cache effect

The section is part of the request prefix, so a profile that changes between assemblies invalidates reuse from the next request; an unchanged profile is a stable repeated prefix.

## Known Limitations and Deferred Work

- **Recall adds one static section per assembly** — the section reflects the profile fetched at assembly time; there is no incremental update mid-session.
- **Project scope derives from the process cwd at execution time** — a session that changes working directory between calls addresses different project partitions.
