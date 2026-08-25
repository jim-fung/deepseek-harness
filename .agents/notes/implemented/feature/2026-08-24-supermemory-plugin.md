# Agent Note: Supermemory hosted memory plugin

Status: implemented

English | [中文](2026-08-24-supermemory-plugin.zh.md)

## Problem

A dsh session forgets everything between runs. The session log persists one conversation; nothing carries a user's preferences, standing decisions, or project knowledge into the next session. The user already keeps this knowledge in supermemory.ai through the Codex plugin (`~/.codex/supermemory/credentials.json`, container-tag scoping), so the data exists and is live — the harness just has no way to reach it. Adding an integration today would also mean hardwiring one vendor into tool code, because the harness has no memory capability seam for a provider to register against.

## Decision

The harness ships a `memory` capability seam as the package group `packages/memory/`, following the `web` seam's three roles, composed through the opt-in bundle `@deepseek-ai/dsh-supermemory` under `packages/bundle/supermemory/`.

### Package topology

| Package | Role | Contents |
| --- | --- | --- |
| `@deepseek-ai/dsh-memory` | Service Definition | `MemoryRuntime extends Service` under context key `memory`; `MemoryProvider` interface and scope types in `src/types.ts`; `registerMemoryProvider()` returning a disposer |
| `@deepseek-ai/dsh-memory-supermemory` | Service Provider | Function plugin injecting `['memory']`; `SupermemoryClient` speaking the supermemory.ai REST API |
| `@deepseek-ai/dsh-tool-memory` | Consumer | Injects `['tools', 'memory', 'systemPrompt']`; registers the `memory_*` tools and the recall section |

### Service contract

`ctx.memory` exposes `add`, `search`, `remove`, and `profile`, each delegating to the single active provider. `registerMemoryProvider()` stores one active provider; a later registration replaces the current one, and the disposer restores the provider it displaced. An operation with no registered provider throws `MemoryError` code `MEMORY_NO_PROVIDER`; a backend that cannot serve throws code `MEMORY_PROVIDER_UNAVAILABLE`; a scope word other than `project` or `global` throws code `MEMORY_REQUEST_INVALID`. Scopes are discriminated by kind — `{ kind: 'global' }` addresses user-level memories and `{ kind: 'project'; id: string }` addresses one project partition. Consumers derive project ids; providers never infer them: `dsh-tool-memory` derives the id at execution time from the process working directory (nearest ancestor containing `.git`, else the working directory itself).

### Supermemory provider

Config: `apiKeyEnv` (role `credential-ref`, default `SUPERMEMORY_API_KEY`), `baseURL` (default `https://api.supermemory.ai`), and `containerTagPrefix` (default `dsh`). The API key resolves at each operation and is never cached: `ctx.credentials.resolve(apiKeyEnv)` when the credentials service is mounted, else the launching environment, then a read-only read of `~/.codex/supermemory/credentials.json` — the existing Codex `supermemory-login` flow keeps working and dsh never writes that file. An exhausted chain throws `MemoryError` code `MEMORY_PROVIDER_UNAVAILABLE` naming every consulted source. Scopes map to container tags: global → `<prefix>-global`, project → `<prefix>-project-<slug of id>`, where the slug is lowercased ASCII alphanumerics joined by single hyphens. The client calls the same endpoints the local Codex scripts call (document add, search, delete, profile); response parsing stays in the provider at the wire boundary.

### Consumer tools and recall

Three tools with render intent `generic`: `memory_save(content, scope)`, `memory_search(query, scope, limit?)` with `limit` bounded to 1–25, and `memory_forget(id)`. `scope` is required on save and search, so nothing crosses scopes silently; `forget` addresses the id returned by save or search, which pins its scope. Config flags `save`, `searchAndForget`, and `recall` (all default `true`) select the tool families and the recall section; an enabled tool stays visible when its provider is unavailable and fails with a structured error at execution time. Recall runs in the `system-prompt/assemble` waterfall: the listener awaits `next()`, fetches `ctx.memory.profile()`, and appends the section `memory-profile` after all ordered sections, so it renders last in the joined prompt; an empty profile contributes no section, and any recall failure degrades to a logged warning with the section omitted — an unreachable memory service must not fail the session. Assembled sections are part of the assembly result, so injected text stays reconstructable from the session log under the model-visible ⟺ logged rule.

### Bundle composition

The installable bundle `supermemory` carries three patch rows — `memory`, `memory-provider`, `tool-memory` — that only insert after base. The base `cordis.patch.yml` is unchanged, so default profiles, prompt assemblies, and every recorded snapshot stay byte-identical until the user enables the bundle.

## Alternatives considered

**One combined package** where the tool consumer calls supermemory directly. Fewer packages and gates now, but replacing the backend later means rewriting inside the consumer, and tests would need network or ad-hoc mocks instead of a stub provider. The three-role split matches every existing capability seam.

**Compose into the base bundle.** Memory tools in every session with zero setup, but tool schemas join prompt assembly, so all existing snapshot expected outputs change in the same PR for users who never asked for memory. An opt-in bundle isolates that cost.

**Local-first storage (SQLite) instead of a hosted service.** No network dependency and no vendor, but the user's memories already live in supermemory.ai and must stay shared with the Codex plugin; local storage would fork that data and add sync code we do not want to own.

## Consequences

The opt-in bundle costs an explicit enablement step and bought memory with zero footprint for default profiles: every pre-existing snapshot stayed byte-identical. The keyless assembled-transcript snapshot (`examples/headless-agent`, replayed by `pnpm run test:snapshot -t memory`) runs against a localhost wire server and pins the real tool schemas and recall output; a real-API e2e against supermemory.ai self-skips without `SUPERMEMORY_API_KEY` and serves as the drift alarm for the unpinned external wire. An outage degrades recall to a warning by design while memory tool calls fail as ordinary tool results.

Per-operation key resolution costs one resolution per memory call and bought sessions that boot without touching the network or the secret store; a missing key surfaces at the attempted operation instead of breaking load. Reading `~/.codex/supermemory/credentials.json` couples dsh to another tool's file layout; it is a read-only fallback input that is never written, and malformed content degrades to the next source rather than failing the session. Scope identity lives entirely in container tags, so moving a repository starts a fresh project scope and distinct paths can collide by slug; container tags are cheap to re-point manually. The seam holds exactly one active provider — a later registration replaces the earlier without arbitration — and emits no event stream, so recall content is observable only through the assembled prompt. Recall renders last by construction (appended after all ordered sections), which keeps placement stable at the cost of carrying the profile fetched at assembly time, with no incremental update mid-session.
