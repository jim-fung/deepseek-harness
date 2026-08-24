# Agent Note: Supermemory hosted memory plugin

Status: proposed

English | [中文](2026-08-24-supermemory-plugin.zh.md)

## Problem

A dsh session forgets everything between runs. The session log persists one conversation; nothing carries a user's preferences, standing decisions, or project knowledge into the next session. The user already keeps this knowledge in supermemory.ai through the Codex plugin (`~/.codex/supermemory/credentials.json`, container-tag scoping), so the data exists and is live — the harness just has no way to reach it. Adding an integration today would also mean hardwiring one vendor into tool code, because the harness has no memory capability seam for a provider to register against.

## Proposal

Add a `memory` capability seam as a new package group `packages/memory/`, following the `web` seam template (Service Definition / Provider / Consumer), and compose it through a new opt-in bundle.

### Package topology

| Package | Role | Contents |
| --- | --- | --- |
| `@deepseek-ai/dsh-memory` | Service Definition | `MemoryRuntime extends Service` under context key `memory`; `MemoryProvider` interface and scope types; `registerMemoryProvider()` returning a disposer |
| `@deepseek-ai/dsh-memory-supermemory` | Service Provider | Function plugin injecting `['memory']`; `SupermemoryClient` speaking the supermemory.ai REST API |
| `@deepseek-ai/dsh-tool-memory` | Consumer | Injects `['tools', 'memory']`; registers the `memory_*` tools and the recall system-prompt section |

### Service contract

```ts
type MemoryScope = { kind: 'global' } | { kind: 'project'; id: string };

interface MemoryProvider {
  add(input: { scope: MemoryScope; content: string }): Promise<{ id: string }>;
  search(input: { scope: MemoryScope; query: string; limit?: number }): Promise<MemoryHit[]>;
  remove(id: string): Promise<void>;
  profile(): Promise<string>;
}
```

`registerMemoryProvider()` stores one active provider; registering a second replaces the first and the disposer restores it. Reading `ctx.memory` operations with no provider registered fails loud with `MISCONFIGURATION` at the first use — registration is itself a plugin row, so absence is not load-time detectable. Runtime invariants assert the registry's owned relationships per `packages/AGENTS.md`.

Project scope ids are derived explicitly by the consumer from the git repository root before any provider call; the provider never infers them.

### Supermemory provider

Config schema: `baseURL` (default `https://api.supermemory.ai`), `apiKeyEnv` marked `.role('credential-ref')` with default `SUPERMEMORY_API_KEY`, and `containerTagPrefix` (default `dsh`). Key resolution order: `ctx.credentials.resolve(apiKeyEnv)`, then the launch environment, then a read of `~/.codex/supermemory/credentials.json` — read-only, so the existing Codex `supermemory-login` flow keeps working and is never written by dsh. Scopes map to container tags: global → `<prefix>-global`, project → `<prefix>-project-<slug of id>`. The client uses the same endpoints the local Codex scripts call (document add, search, delete, profile); response parsing stays in the provider at the wire boundary.

### Consumer tools and recall

Three tools with render intent `generic`: `memory_save(content, scope)`, `memory_search(query, scope, limit?)`, `memory_forget(id)`. `scope` is required on save and search, so nothing crosses scopes silently; `forget` addresses the id returned by save or search, which pins its scope. At assembly time the consumer calls `profile()` once and contributes the result through `ctx.systemPrompt.section(...)`, so the injected text is logged and reconstructable under the existing model-visible ⟺ logged rule.

### Bundle composition

A new installable bundle `supermemory` under `packages/bundle/` carries the three plugin rows. The base `cordis.patch.yml` is unchanged, so default profiles, prompt assemblies, and every recorded snapshot stay byte-identical until the user enables the bundle.

### Failure modes

- No provider registered → `MISCONFIGURATION` at first `ctx.memory` use.
- Missing credential at tool execution → `MISSING_CREDENTIAL` tool failure surfaced to the model.
- Service unreachable or slow during recall → warning logged, section omitted, session continues.
- Service unreachable during a tool call → ordinary tool failure result.

## Alternatives considered

**One combined package** where the tool consumer calls supermemory directly. Fewer packages and gates now, but replacing the backend later means rewriting inside the consumer, and tests would need network or ad-hoc mocks instead of a stub provider. The three-role split matches every existing capability seam.

**Compose into the base bundle.** Memory tools in every session with zero setup, but tool schemas join prompt assembly, so all existing snapshot expected outputs change in the same PR for users who never asked for memory. An opt-in bundle isolates that cost.

**Local-first storage (SQLite) instead of a hosted service.** No network dependency and no vendor, but the user's memories already live in supermemory.ai and must stay shared with the Codex plugin; local storage would fork that data and add sync code we do not want to own.

## Acceptance criteria

- All three packages pass focused tests, `typecheck`, `lint`, `hygiene`, and `doc-sync`, with READMEs carrying the gated Model Experience and Known Limitations sections.
- With the bundle enabled, the agent saves, searches, and removes memories in both scopes; the recall section appears whenever `profile()` returns content.
- A keyless snapshot example composes `tool-memory` with a deterministic stub provider plugin and replays without network access.
- A real-API e2e case exercises `dsh-memory-supermemory` and self-skips without credentials.
- Default-profile snapshot outputs are unchanged by the change.

## Risks

- The supermemory.ai API is external and can drift; the provider owns parsing at the wire boundary and the real-API e2e is the drift alarm, but an outage degrades recall to a warning by design.
- Reading `~/.codex/supermemory/credentials.json` couples us to another tool's file layout; it is a fallback input only and never written.
- Deriving project scope from the repository root means moving a repository starts a fresh scope; acceptable because container tags are cheap to re-point manually.
