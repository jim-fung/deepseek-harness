# 记忆

[English](memory.md) | 中文

`@deepseek-ai/dsh-memory` 以 `ctx.memory` 键持有持久记忆能力 seam 的 Service Definition：它把带 scope 的操作委托给唯一活跃提供方，自身不存储任何内容。`registerMemoryProvider` 使新注册的提供方立即生效；后注册者替换当前提供方，返回的清理器会恢复被替换的提供方。没有任何已注册提供方时，每个操作都会抛出 code 为 `MEMORY_NO_PROVIDER` 的 `MemoryError`。

来源：[`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts)

## Scope

每个操作只寻址一个 scope：`{ kind: 'global' }` 面向用户级记忆，`{ kind: 'project'; id: string }` 面向一个项目分区。项目 id 由消费方派生（面向模型的工具从进程工作目录派生），提供方只在收到的 id 之后分区存储。后端无法服务时抛出 code 为 `MEMORY_PROVIDER_UNAVAILABLE` 的 `MemoryError`。

## 包

[`@deepseek-ai/dsh-memory-supermemory`](../../packages/memory/memory-supermemory/README.zh.md) 在 seam 之后注册 supermemory.ai 提供方；[`@deepseek-ai/dsh-tool-memory`](../../packages/memory/tool-memory/README.zh.md) 提供 `memory_save`、`memory_search`、`memory_forget` 工具与召回节；[`@deepseek-ai/dsh-supermemory`](../../packages/bundle/supermemory/README.zh.md) 将三者组合为可选的 profile bundle。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
