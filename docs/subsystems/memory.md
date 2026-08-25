# Memory

English | [中文](memory.zh.md)

`@deepseek-ai/dsh-memory` owns the `ctx.memory` key as the Service Definition of the persistent-memory capability seam: it delegates scope-typed operations to one active provider and stores nothing itself. `registerMemoryProvider` makes the registered provider active immediately; a later registration replaces it, and the returned disposer restores the provider it displaced. Every operation with no registered provider throws `MemoryError` code `MEMORY_NO_PROVIDER`.

Source: [`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts)

## Scopes

Operations address exactly one scope: `{ kind: 'global' }` for user-level memories and `{ kind: 'project'; id: string }` for one project partition. Consumers derive project ids — the model-facing tools derive them from the process working directory — and providers partition storage behind the id they receive. A backend that cannot serve throws `MemoryError` code `MEMORY_PROVIDER_UNAVAILABLE`.

## Packages

[`@deepseek-ai/dsh-memory-supermemory`](../../packages/memory/memory-supermemory/README.md) registers the supermemory.ai provider behind the seam; [`@deepseek-ai/dsh-tool-memory`](../../packages/memory/tool-memory/README.md) contributes the `memory_save`, `memory_search`, and `memory_forget` tools plus the recall section; [`@deepseek-ai/dsh-supermemory`](../../packages/bundle/supermemory/README.md) composes them as an opt-in profile bundle.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmemory--memoryruntime"></a>

### `ctx.memory` — `MemoryRuntime`

The persistent-memory service. Registered as `ctx.memory` (one instance per context). The active provider is always the most recently registered and not-yet-disposed one.

```ts cordis-catalog
/**
 * Register a provider, replacing any currently active one. Returns a disposer that
 * removes exactly this registration; disposing makes the previously displaced
 * provider (if any) active again.
 * @param provider - the provider implementation; its `id` is diagnostic only here.
 * @returns the disposer that unregisters this provider.
 */
registerMemoryProvider(provider: MemoryProvider): () => void

/**
 * Store one memory through the active provider.
 * @param request - scope and content.
 * @returns the stored record.
 */
async add(request: MemoryAddRequest): Promise<MemoryHit>

/**
 * Search one scope through the active provider.
 * @param request - scope, query, and optional limit.
 * @returns matching hits.
 */
async search(request: MemorySearchRequest): Promise<MemoryHit[]>

/**
 * Remove one stored memory through the active provider.
 * @param id - a previously returned `MemoryHit.id`.
 */
async remove(id: string): Promise<void>

/**
 * Fetch the user-level profile summary through the active provider.
 * @returns the profile text, or `''` when nothing is stored.
 */
async profile(): Promise<string>
```

Source: [`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts)
<!-- END GENERATED cordis-surface -->
