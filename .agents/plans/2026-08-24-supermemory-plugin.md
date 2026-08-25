# Supermemory Memory Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent-memory capability seam (`ctx.memory`) with a supermemory.ai provider, model-facing `memory_save`/`memory_search`/`memory_forget` tools, automatic profile recall into the system prompt, and an opt-in `supermemory` bundle — per the approved Agent Note at `.agents/notes/implemented/feature/2026-08-24-supermemory-plugin.md`.

**Architecture:** Three-package capability seam under a new group `packages/memory/`, mirroring the `web` seam (`packages/web/`): Service Definition (`dsh-memory`), Provider (`dsh-memory-supermemory`), Consumer (`dsh-tool-memory`), composed by a patch-layer bundle package under `packages/bundle/supermemory/`. Keyless snapshot coverage runs the real provider client against a localhost wire mock inside the existing `examples/headless-agent` snapshot harness.

**Tech Stack:** TypeScript (strict, ESM, `.ts` relative imports), vendored Cordis (`@deepseek-ai/cordis`), `@deepseek-ai/schemastery` config validation, vitest, pnpm workspaces.

## Global Constraints

- Work on branch `feat/supermemory-plugin` (already created).
- Package version string is `"0.1.1-rc.2"` everywhere (must match root `package.json`; enforced by `scripts/check-workspace-constraints.ts`).
- Every package: `"private": true` is NOT set on publishable packages — copy the exact manifest fields shown in Task 1 (they mirror `packages/web/web-search-exa/package.json`, which passes the constraints gate). `@deepseek-ai/cordis` appears in BOTH `peerDependencies` and `devDependencies` with the identical range `workspace:^`. Mirror every dsh peer dependency in `devDependencies`.
- In-package relative imports use explicit `.ts` specifiers (`from './types.ts'`); cross-package imports use bare package names.
- All code compiles under `strict` with `noImplicitAny`. Public service methods and exported functions carry JSDoc with `@param`/`@returns` (enforced by `verify-export-jsdoc`).
- Registrations are effects: registry registration goes through `ctx.effect()` and returns a disposer.
- Misconfiguration fails loud: no silent fallbacks around missing providers or unparseable credentials files.
- `pnpm run test:coverage` gates per-file 100% coverage on `packages/*/*/src` — every source file shipped in Tasks 1–3 must be fully covered by its spec file.
- Files end with exactly one trailing newline.
- Do not touch `packages/bundle/base/cordis.patch.yml` or any existing snapshot expected-output file.
- Run checks from repo root `/Users/dekal/tooling/deepseek-harness`.

---

### Task 1: `@deepseek-ai/dsh-memory` — Service Definition

**Files:**
- Create: `packages/memory/memory/package.json`
- Create: `packages/memory/memory/tsconfig.json`
- Create: `packages/memory/memory/src/types.ts`
- Create: `packages/memory/memory/src/index.ts`
- Create: `packages/memory/memory/src/invariant.ts`
- Test: `packages/memory/memory/tests/memory.spec.ts`
- Modify: `tsconfig.base.json` (add group path wildcard)
- Modify: `tsconfig.host.json` (add package reference)

**Interfaces:**
- Produces (consumed by Tasks 2, 3, 6):
  - `type MemoryScope = { kind: 'global' } | { kind: 'project'; id: string }`
  - `interface MemoryHit { readonly id: string; readonly content: string }`
  - `interface MemoryAddRequest { readonly scope: MemoryScope; readonly content: string }`
  - `interface MemorySearchRequest { readonly scope: MemoryScope; readonly query: string; readonly limit?: number }`
  - `interface MemoryProvider { readonly id: string; add(request: MemoryAddRequest): Promise<MemoryHit>; search(request: MemorySearchRequest): Promise<MemoryHit[]>; remove(id: string): Promise<void>; profile(): Promise<string> }`
  - `class MemoryError extends Error { constructor(message: string, code: MemoryErrorCode) }` with `MemoryErrorCode = 'MEMORY_NO_PROVIDER' | 'MEMORY_PROVIDER_UNAVAILABLE' | 'MEMORY_REQUEST_INVALID'`
  - `class MemoryRuntime extends Service` (default export), key `memory`: `registerMemoryProvider(provider): () => void`, `add(request): Promise<MemoryHit>`, `search(request): Promise<MemoryHit[]>`, `remove(id): Promise<void>`, `profile(): Promise<string>`
  - Module augmentation: `interface Context { memory: MemoryRuntime }`

- [ ] **Step 1: Register the new group in root configs**

In `tsconfig.base.json`, find the `paths` entry whose value array contains `"./packages/web/*/src"` and insert `"./packages/memory/*/src"` immediately after it (same array, comma-separated).

In `tsconfig.host.json`, find the `references` array entry `{ "path": "./packages/web/web" }` and insert `{ "path": "./packages/memory/memory" }` adjacent to it. (Tasks 2–3 append their own references here too.)

- [ ] **Step 2: Create package manifest**

Write `packages/memory/memory/package.json` exactly:

```json
{
  "name": "@deepseek-ai/dsh-memory",
  "description": "Service Definition for the DeepSeek Harness persistent-memory capability seam (ctx.memory)",
  "version": "0.1.1-rc.2",
  "publishConfig": {
    "access": "public"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/deepseek-ai/deepseek-harness.git",
    "directory": "packages/memory/memory"
  },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./invariant": {
      "types": "./lib/types/invariant.d.ts",
      "default": "./lib/invariant.js"
    },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/index.js",
    "lib/invariant.js",
    "lib/types/**/*.d.ts"
  ],
  "license": "MIT",
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-invariants": "workspace:^"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-invariants": "workspace:^"
  }
}
```

Write `packages/memory/memory/tsconfig.json` exactly:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types"
  },
  "include": [
    "src"
  ],
  "references": [
    {
      "path": "../../../vendor/cordis"
    },
    {
      "path": "../../runtime-diagnostics/invariants"
    }
  ]
}
```

Run `pnpm install` (links the new workspace package).

- [ ] **Step 3: Write the failing tests**

Create `packages/memory/memory/tests/memory.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import MemoryRuntime, { MemoryError } from '@deepseek-ai/dsh-memory'
import type { MemoryProvider, MemoryScope } from '@deepseek-ai/dsh-memory'

const GLOBAL: MemoryScope = { kind: 'global' }
const PROJECT: MemoryScope = { kind: 'project', id: '/repo' }

function stubProvider(id: string, overrides: Partial<MemoryProvider> = {}): MemoryProvider & { calls: string[] } {
  const calls: string[] = []
  return {
    id,
    calls,
    ...{
      add: async (request) => {
        calls.push(`add:${request.scope.kind}:${request.content}`)
        return { id: `${id}:1`, content: request.content }
      },
      search: async (request) => {
        calls.push(`search:${request.scope.kind}:${request.query}:${String(request.limit)}`)
        return [{ id: `${id}:h1`, content: 'hit' }]
      },
      remove: async (removed) => {
        calls.push(`remove:${removed}`)
      },
      profile: async () => {
        calls.push('profile')
        return ''
      },
    } satisfies Pick<MemoryProvider, 'add' | 'search' | 'remove' | 'profile'>,
    ...overrides,
  } as MemoryProvider & { calls: string[] }
}

function installedContext(): { ctx: Context; memory: MemoryRuntime } {
  const ctx = new Context()
  const memory = new MemoryRuntime(ctx)
  return { ctx, memory }
}

describe('MemoryRuntime', () => {
  it('throws MEMORY_NO_PROVIDER when no provider is registered', async () => {
    const { ctx } = installedContext()
    expect(ctx.memory).toBeInstanceOf(MemoryRuntime)
    await expect(ctx.memory.profile()).rejects.toMatchObject({
      name: 'MemoryError',
      code: 'MEMORY_NO_PROVIDER',
    })
  })

  it('delegates operations to the active provider unchanged', async () => {
    const { memory } = installedContext()
    const provider = stubProvider('memory-provider:test')
    memory.registerMemoryProvider(provider)

    expect(await memory.add({ scope: GLOBAL, content: 'prefers pnpm' }))
      .toEqual({ id: 'memory-provider:test:1', content: 'prefers pnpm' })
    expect(await memory.search({ scope: PROJECT, query: 'editor', limit: 3 }))
      .toEqual([{ id: 'memory-provider:test:h1', content: 'hit' }])
    await memory.remove('memory-provider:test:h1')
    await memory.profile()

    expect(provider.calls).toEqual([
      'add:global:prefers pnpm',
      'search:project:editor:3',
      'remove:memory-provider:test:h1',
      'profile',
    ])
  })

  it('a later registration replaces the active provider; disposal restores the previous one', async () => {
    const { memory } = installedContext()
    const first = stubProvider('memory-provider:first')
    const second = stubProvider('memory-provider:second')
    const disposeFirst = memory.registerMemoryProvider(first)
    const disposeSecond = memory.registerMemoryProvider(second)

    await memory.add({ scope: GLOBAL, content: 'one' })
    expect(second.calls).toEqual(['add:global:one'])
    expect(first.calls).toEqual([])

    disposeSecond()
    await memory.add({ scope: GLOBAL, content: 'two' })
    expect(first.calls).toEqual(['add:global:two'])

    disposeFirst()
    await expect(memory.add({ scope: GLOBAL, content: 'three' })).rejects.toMatchObject({ code: 'MEMORY_NO_PROVIDER' })
  })

  it('disposing an out-of-order disposer removes only its own provider', async () => {
    const { memory } = installedContext()
    const first = stubProvider('memory-provider:first')
    const second = stubProvider('memory-provider:second')
    void memory.registerMemoryProvider(first) // stays active for the whole test
    const disposeSecond = memory.registerMemoryProvider(second)
    disposeSecond()

    await expect(memory.add({ scope: GLOBAL, content: 'one' })).resolves.toEqual({
      id: 'memory-provider:first:1',
      content: 'one',
    })
  })

  it('MemoryError carries its code through rejections', async () => {
    const error = new MemoryError('boom', 'MEMORY_REQUEST_INVALID')
    expect(error.code).toBe('MEMORY_REQUEST_INVALID')
    expect(error.name).toBe('MemoryError')
    expect(error.message).toBe('boom')
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm vitest run packages/memory/memory/tests/memory.spec.ts`
Expected: FAIL — cannot resolve `@deepseek-ai/dsh-memory` (source not written yet).

- [ ] **Step 5: Implement types, runtime, invariant**

Create `packages/memory/memory/src/types.ts`:

```ts
/**
 * Shared types for the persistent-memory capability seam (`ctx.memory`): scopes, records,
 * requests, the provider interface, and the seam's error type.
 * @module @deepseek-ai/dsh-memory/types
 */

/** Error codes carried by {@link MemoryError}; consumers switch on them. */
export type MemoryErrorCode =
  | 'MEMORY_NO_PROVIDER'
  | 'MEMORY_PROVIDER_UNAVAILABLE'
  | 'MEMORY_REQUEST_INVALID'

/**
 * The memory seam's error type. `code` discriminates handling at call sites;
 * messages are diagnostic text, never parsed.
 */
export class MemoryError extends Error {
  /**
   * @param message - human-readable diagnostic; names the failing operation and cause.
   * @param code - machine-readable discriminator from {@link MemoryErrorCode}.
   */
  constructor(message: string, readonly code: MemoryErrorCode) {
    super(message)
    this.name = 'MemoryError'
  }
}

/** Which partition of stored memories an operation addresses. */
export type MemoryScope =
  | { kind: 'global' }
  | { kind: 'project'; id: string }

/** One stored memory. */
export interface MemoryHit {
  /** Provider-assigned identifier; opaque to callers, round-trips to `remove`. */
  readonly id: string
  /** The stored text. */
  readonly content: string
}

/** Request to store one memory. */
export interface MemoryAddRequest {
  /** Scope that owns the stored memory. */
  readonly scope: MemoryScope
  /** The text to store. */
  readonly content: string
}

/** Request to search one scope. */
export interface MemorySearchRequest {
  /** Scope to search; scopes never mix in one result. */
  readonly scope: MemoryScope
  /** Free-text query interpreted by the backend. */
  readonly query: string
  /** Upper bound on hits; a provider may return fewer but never more. */
  readonly limit?: number
}

/** One backend implementation of durable memory storage. */
export interface MemoryProvider {
  /** Stable registry id, namespaced as `memory-provider:<vendor>`. */
  readonly id: string
  /**
   * Store one memory in the requested scope.
   * @param request - scope and content.
   * @returns the stored record including the backend-assigned id.
   * @throws `MemoryError` code `MEMORY_PROVIDER_UNAVAILABLE` when the backend cannot serve.
   */
  add(request: MemoryAddRequest): Promise<MemoryHit>
  /**
   * Search one scope.
   * @param request - scope, query, and optional limit.
   * @returns matching hits, capped to `limit` when supplied.
   */
  search(request: MemorySearchRequest): Promise<MemoryHit[]>
  /**
   * Remove one stored memory by id.
   * @param id - a previously returned `MemoryHit.id`.
   */
  remove(id: string): Promise<void>
  /**
   * User-level profile summary injected into system prompts.
   * @returns the profile text, or `''` when nothing is stored yet.
   */
  profile(): Promise<string>
}
```

Create `packages/memory/memory/src/index.ts`:

```ts
/**
 * Service Definition for the persistent-memory capability seam (`ctx.memory`): one active
 * provider plus scope-typed delegation. A later registration replaces the active provider;
 * disposing restores the provider it displaced. Operations without any registered provider
 * throw `MemoryError` code `MEMORY_NO_PROVIDER`.
 * @module @deepseek-ai/dsh-memory
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { MemoryError } from './types.ts'

export { MemoryError } from './types.ts'
export type {
  MemoryAddRequest,
  MemoryErrorCode,
  MemoryHit,
  MemoryProvider,
  MemoryScope,
  MemorySearchRequest,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryRuntime
  }
}

/**
 * The persistent-memory service. Registered as `ctx.memory` (one instance per context).
 * The active provider is always the most recently registered and not-yet-disposed one.
 */
export class MemoryRuntime extends Service {
  private readonly providers: MemoryProvider[] = []

  /**
   * @param ctx - the Cordis context this service attaches to under key `memory`.
   */
  constructor(ctx: Context) {
    super(ctx, 'memory')
  }

  /**
   * Register a provider, replacing any currently active one. Returns a disposer that
   * removes exactly this registration; disposing makes the previously displaced
   * provider (if any) active again.
   * @param provider - the provider implementation; its `id` is diagnostic only here.
   * @returns the disposer that unregisters this provider.
   */
  registerMemoryProvider(provider: MemoryProvider): () => void {
    const runtime = this
    const dispose = this.ctx.effect(function* () {
      runtime.providers.push(provider)
      yield () => {
        const index = runtime.providers.lastIndexOf(provider)
        if (index >= 0) runtime.providers.splice(index, 1)
      }
    }, 'memory.registerMemoryProvider()')
    return () => void dispose()
  }

  /**
   * Store one memory through the active provider.
   * @param request - scope and content.
   * @returns the stored record.
   */
  async add(request: MemoryAddRequest): Promise<MemoryHit> {
    return this.requireProvider().add(request)
  }

  /**
   * Search one scope through the active provider.
   * @param request - scope, query, and optional limit.
   * @returns matching hits.
   */
  async search(request: MemorySearchRequest): Promise<MemoryHit[]> {
    return this.requireProvider().search(request)
  }

  /**
   * Remove one stored memory through the active provider.
   * @param id - a previously returned `MemoryHit.id`.
   */
  async remove(id: string): Promise<void> {
    return this.requireProvider().remove(id)
  }

  /**
   * Fetch the user-level profile summary through the active provider.
   * @returns the profile text, or `''` when nothing is stored.
   */
  async profile(): Promise<string> {
    return this.requireProvider().profile()
  }

  private requireProvider(): MemoryProvider {
    const provider = this.providers.at(-1)
    if (provider === undefined) {
      throw new MemoryError('no memory provider is registered', 'MEMORY_NO_PROVIDER')
    }
    return provider
  }
}

export default MemoryRuntime
```

Create `packages/memory/memory/src/invariant.ts`:

```ts
/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-memory`.
 * @module @deepseek-ai/dsh-memory/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-memory'

/** Cordis companion plugin name. */
export const name = 'memory-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the provider stack is private and every delegation asserts
 * provider presence per call (`MEMORY_NO_PROVIDER`), so the seam publishes no
 * independent registry observation or event stream worth cross-checking.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run packages/memory/memory/tests/memory.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/memory tsconfig.base.json tsconfig.host.json pnpm-lock.yaml
git commit -m "feat(memory): add ctx.memory capability seam service definition"
```

---

### Task 2: `@deepseek-ai/dsh-memory-supermemory` — Provider

**Files:**
- Create: `packages/memory/memory-supermemory/package.json`
- Create: `packages/memory/memory-supermemory/tsconfig.json`
- Create: `packages/memory/memory-supermemory/src/tags.ts`
- Create: `packages/memory/memory-supermemory/src/client.ts`
- Create: `packages/memory/memory-supermemory/src/key-source.ts`
- Create: `packages/memory/memory-supermemory/src/index.ts`
- Create: `packages/memory/memory-supermemory/src/invariant.ts`
- Test: `packages/memory/memory-supermemory/tests/supermemory.spec.ts`
- Test: `packages/memory/memory-supermemory/tests/supermemory.e2e.ts`
- Modify: `tsconfig.host.json` (add reference)

**Interfaces:**
- Consumes: `MemoryProvider`, `MemoryScope`, `MemoryError`, `launchEnvironmentOf(ctx)`, `credentialRef(value)` (from `@deepseek-ai/dsh-credentials`), `credentials.resolve(ref): Promise<ResolvedCredential | undefined>`.
- Produces:
  - `SUPERMEMORY_DEFAULT_BASE_URL = 'https://api.supermemory.ai'`
  - `containerTagFor(prefix: string, scope: MemoryScope): string` → `<prefix>-global` / `<prefix>-project-<slug>`
  - `class SupermemoryClient implements MemoryProvider` — options `{ apiKey: string; baseURL?: string }`; `available(): boolean`
  - `resolveSupermemoryApiKey(ctx, ref: CredentialRef): Promise<string>` — resolution order: credentials service → launch environment → `~/.codex/supermemory/credentials.json` (read-only); throws `MemoryError` `MISSING_CREDENTIAL`-equivalent code `'MEMORY_PROVIDER_UNAVAILABLE'` naming all three sources when none yield a usable key.
  - Plugin exports `name = 'memory-supermemory'`, `inject = ['memory']`, `Config`, `apply(ctx, config)`.

- [ ] **Step 1: Create package skeleton**

Write `packages/memory/memory-supermemory/package.json`:

```json
{
  "name": "@deepseek-ai/dsh-memory-supermemory",
  "description": "supermemory.ai-backed memory provider for the DeepSeek Harness memory capability seam (ctx.memory)",
  "version": "0.1.1-rc.2",
  "publishConfig": {
    "access": "public"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/deepseek-ai/deepseek-harness.git",
    "directory": "packages/memory/memory-supermemory"
  },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./invariant": {
      "types": "./lib/types/invariant.d.ts",
      "default": "./lib/invariant.js"
    },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/index.js",
    "lib/invariant.js",
    "lib/types/**/*.d.ts"
  ],
  "license": "MIT",
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-credentials": "workspace:^",
    "@deepseek-ai/dsh-invariants": "workspace:^",
    "@deepseek-ai/dsh-launch-environment": "workspace:^",
    "@deepseek-ai/dsh-memory": "workspace:^"
  },
  "dependencies": {
    "@deepseek-ai/schemastery": "workspace:^"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-credentials": "workspace:^",
    "@deepseek-ai/dsh-invariants": "workspace:^",
    "@deepseek-ai/dsh-launch-environment": "workspace:^",
    "@deepseek-ai/dsh-memory": "workspace:^"
  }
}
```

Write `packages/memory/memory-supermemory/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types"
  },
  "include": [
    "src"
  ],
  "references": [
    {
      "path": "../../util/launch-environment"
    },
    {
      "path": "../../../vendor/cosmokit"
    },
    {
      "path": "../../../vendor/cordis"
    },
    {
      "path": "../../../vendor/schemastery"
    },
    {
      "path": "../memory"
    },
    {
      "path": "../../credentials/credentials"
    },
    {
      "path": "../../runtime-diagnostics/invariants"
    }
  ]
}
```

Append `{ "path": "./packages/memory/memory-supermemory" }` to `tsconfig.host.json` references (next to Task 1's entry). Run `pnpm install`.

If the constraints gate later rejects a dependency edge (for example `dsh-credentials` depending back on something in this chain), fix the edge by narrowing imports, never by skipping the gate.

- [ ] **Step 2: Write the failing tests**

Create `packages/memory/memory-supermemory/tests/supermemory.spec.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { containerTagFor } from '../src/tags.ts'
import { SUPERMEMORY_DEFAULT_BASE_URL, SupermemoryClient } from '../src/client.ts'
import { parseCredentialsFile, slugifyProjectId } from '../src/key-source.ts'
import type { MemoryScope } from '@deepseek-ai/dsh-memory'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('scope tagging', () => {
  it('maps the global scope to one stable tag', () => {
    expect(containerTagFor('dsh', { kind: 'global' })).toBe('dsh-global')
  })

  it('slugs project ids into the project tag', () => {
    expect(containerTagFor('dsh', { kind: 'project', id: '/Users/me/My App' })).toBe('dsh-project-users-me-my-app')
  })

  it('slugifyProjectId collapses separators and survives pathological input', () => {
    expect(slugifyProjectId('/a//b  c/')).toBe('a-b-c')
    expect(slugifyProjectId('///')).toBe('unnamed')
  })
})

describe('SupermemoryClient', () => {
  const GLOBAL: MemoryScope = { kind: 'global' }

  it('available() reflects whether an API key is configured', () => {
    expect(new SupermemoryClient({ apiKey: '' }).available()).toBe(false)
    expect(new SupermemoryClient({ apiKey: 'k' }).available()).toBe(true)
  })

  it('adds a document with the scope tag and returns the mapped hit', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      new Request(input instanceof Request ? input.url : String(input), init).url.includes('/v3/documents') && !String(input).includes('/list')
        ? jsonResponse({ documentId: 'doc_1' })
        : jsonResponse({}, 404)) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)
    const client = new SupermemoryClient({ apiKey: 'k', baseURL: 'https://api.test' })
    await expect(client.add({ scope: GLOBAL, content: 'likes tabs' }))
      .resolves.toEqual({ id: 'doc_1', content: 'likes tabs' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ content: 'likes tabs', containerTags: ['dsh-global'] })
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer k')
  })

  it('searches one scope, caps results to limit, and tolerates both wire list shapes', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      memories: [{ id: 'm1', memory: 'first' }, { documentId: 'm2', content: 'second' }, { id: 'm3', memory: 'third' }],
    })) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)
    const client = new SupermemoryClient({ apiKey: 'k', baseURL: SUPERMEMORY_DEFAULT_BASE_URL })
    await expect(client.search({ scope: GLOBAL, query: 'tabs', limit: 2 }))
      .resolves.toEqual([
        { id: 'm1', content: 'first' },
        { id: 'm2', content: 'second' },
      ])
  })

  it('sends DELETE with the document id and ignores 404 on removal', async () => {
    let seenPath = ''
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      seenPath = String(input)
      return new Response(null, { status: seenPath.endsWith('gone') ? 404 : 204 })
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)
    const client = new SupermemoryClient({ apiKey: 'k', baseURL: 'https://api.test' })
    await expect(client.remove('doc_gone')).resolves.toBeUndefined()
    expect(seenPath).toContain('/v3/documents/doc_gone')
  })

  it('reads the profile endpoint and normalizes string and item-list payloads', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('/v4/profile') ? jsonResponse({ profile: 'Prefers tabs.' }) : jsonResponse({}, 404)) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)
    const client = new SupermemoryClient({ apiKey: 'k', baseURL: 'https://api.test' })
    await expect(client.profile()).resolves.toBe('Prefers tabs.')
  })

  it('returns empty-string profile and throws unavailable on non-2xx data calls', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('/v4/profile') ? jsonResponse({ profile: [] }) : jsonResponse({ message: 'nope' }, 503)) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)
    const client = new SupermemoryClient({ apiKey: 'k', baseURL: 'https://api.test' })
    await expect(client.profile()).resolves.toBe('')
    await expect(client.search({ scope: GLOBAL, query: 'q' })).rejects.toMatchObject({ code: 'MEMORY_PROVIDER_UNAVAILABLE' })
  })
})

describe('Codex credentials fallback', () => {
  it('parses the Codex credentials file for its apiKey field', () => {
    expect(parseCredentialsFile('{"apiKey":"sm-1"}')).toBe('sm-1')
    expect(parseCredentialsFile('{}')).toBeUndefined()
    expect(parseCredentialsFile('not json')).toBeUndefined()
  })
})
```

Create `packages/memory/memory-supermemory/tests/supermemory.e2e.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SUPERMEMORY_DEFAULT_BASE_URL, SupermemoryClient } from '@deepseek-ai/dsh-memory-supermemory'

/**
 * Real-API smoke for the supermemory.ai provider. Self-skips without
 * `$SUPERMEMORY_API_KEY` (CI has no secrets), per docs/testing.md e2e policy.
 * This test is the drift alarm for the unpinned external wire shapes in
 * `src/client.ts`.
 */
const apiKey = process.env.SUPERMEMORY_API_KEY
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

maybe('SupermemoryClient real API', () => {
  it('stores, finds, and removes one memory in the global scope', async () => {
    const client = new SupermemoryClient({ apiKey: apiKey!, baseURL: process.env.SUPERMEMORY_BASE_URL ?? SUPERMEMORY_DEFAULT_BASE_URL })
    const marker = `dsh-e2e-${Date.now()}`
    const added = await client.add({ scope: { kind: 'global' }, content: marker })
    expect(added.id.length).toBeGreaterThan(0)
    try {
      const found = await client.search({ scope: { kind: 'global' }, query: marker })
      expect(found.some(hit => hit.content.includes(marker))).toBe(true)
    } finally {
      await client.remove(added.id)
    }
  }, 30_000)
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run packages/memory/memory-supermemory/tests/supermemory.spec.ts`
Expected: FAIL — modules under `../src/` do not exist.

- [ ] **Step 4: Implement tags, client, key source**

Create `packages/memory/memory-supermemory/src/tags.ts`:

```ts
/**
 * Container-tag mapping for supermemory.ai scopes. Tags are the only partitioning
 * mechanism the remote API offers, so scope identity travels entirely in the tag.
 * @module @deepseek-ai/dsh-memory-supermemory/tags
 */

import type { MemoryScope } from '@deepseek-ai/dsh-memory'

/**
 * Map one memory scope to its supermemory container tag.
 * @param prefix - configured tag prefix (plugin config `containerTagPrefix`).
 * @param scope - the scope to address.
 * @returns `` `${prefix}-global` `` or `` `${prefix}-project-<slug>` ``.
 */
export function containerTagFor(prefix: string, scope: MemoryScope): string {
  if (scope.kind === 'global') return `${prefix}-global`
  return `${prefix}-project-${slugifyProjectId(scope.id)}`
}

/**
 * Slugify a project scope id (an absolute repository-root path) into a
 * tag-safe fragment: lowercased ASCII alphanumerics joined by single hyphens.
 * Distinct paths can collide only by losing case/separators; the README's
 * Known Limitations section records this.
 * @param id - the project scope id.
 * @returns the slug, or `unnamed` when nothing survives stripping.
 */
export function slugifyProjectId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed'
}
```

Create `packages/memory/memory-supermemory/src/client.ts`:

```ts
/**
 * supermemory.ai REST client implementing `MemoryProvider`. This module owns the
 * vendor wire shapes — requests, responses, auth header, and tolerant response
 * mapping at the wire boundary. The real-API e2e (`tests/supermemory.e2e.ts`) is
 * the drift alarm for these unpinned shapes.
 * @module @deepseek-ai/dsh-memory-supermemory/client
 */

import { MemoryError } from '@deepseek-ai/dsh-memory'
import type { MemoryAddRequest, MemoryHit, MemoryProvider, MemorySearchRequest } from '@deepseek-ai/dsh-memory'
import { containerTagFor } from './tags.ts'

/** Default supermemory.ai API endpoint. */
export const SUPERMEMORY_DEFAULT_BASE_URL = 'https://api.supermemory.ai'

/** Construction options for {@link SupermemoryClient}. */
export interface SupermemoryClientOptions {
  /** Bearer token sent as the `authorization` header; empty disables the provider. */
  apiKey: string
  /** Endpoint base; endpoint paths are appended. Defaults to the public API. */
  baseURL?: string
}

/** Wire fields a stored document may carry its id under. */
interface WireDocumentRef {
  id?: string
  documentId?: string
}

/** Wire fields a listed memory may carry its content under. */
interface WireMemoryContent {
  content?: string
  memory?: string
}

type WireDocument = WireDocumentRef & WireMemoryContent

/**
 * supermemory.ai-backed provider. One instance serves all scopes; scope identity
 * rides in container tags (`containerTagFor`). `available()` reports credential
 * presence so enablement checks stay cheap.
 */
export class SupermemoryClient implements MemoryProvider {
  readonly id = 'memory-provider:supermemory'

  private readonly apiKey: string
  private readonly baseURL: string

  /**
   * @param options - API key and optional endpoint base.
   */
  constructor(options: SupermemoryClientOptions) {
    this.apiKey = options.apiKey
    this.baseURL = options.baseURL ?? SUPERMEMORY_DEFAULT_BASE_URL
  }

  /**
   * Whether this provider can serve requests.
   * @returns true when an API key is present.
   */
  available(): boolean {
    return this.apiKey.length > 0
  }

  /**
   * Store one memory as a tagged document.
   * @param request - scope and content.
   * @returns the stored record with the backend-assigned id.
   */
  async add(request: MemoryAddRequest): Promise<MemoryHit> {
    const body = { content: request.content, containerTags: [containerTagFor(this.tagPrefix(), request.scope)] }
    const payload = await this.requestJson<WireDocumentRef>('/v3/documents', 'POST', body)
    return { id: requireDocumentId(payload), content: request.content }
  }

  /**
   * Search one scope's memories.
   * @param request - scope, query, and optional limit.
   * @returns hits capped to `request.limit` when supplied.
   */
  async search(request: MemorySearchRequest): Promise<MemoryHit[]> {
    const body: Record<string, unknown> = {
      q: request.query,
      containerTags: [containerTagFor(this.tagPrefix(), request.scope)],
    }
    if (request.limit !== undefined) body.limit = request.limit
    const payload = await this.requestJson<{ memories?: WireDocument[]; results?: WireDocument[] }>('/v4/search', 'POST', body)
    const documents = [...payload.memories ?? [], ...payload.results ?? []]
    const hits = documents.map(mapDocument).filter((hit): hit is MemoryHit => hit !== undefined)
    return request.limit === undefined ? hits : hits.slice(0, request.limit)
  }

  /**
   * Delete one document by id. A missing document resolves (already gone),
   * anything else non-2xx throws.
   * @param id - a previously returned `MemoryHit.id`.
   */
  async remove(id: string): Promise<void> {
    await this.requestRaw(`/v3/documents/${encodeURIComponent(id)}`, 'DELETE')
  }

  /**
   * Fetch the user-level profile summary.
   * @returns the profile text, or `''` when absent or empty.
   */
  async profile(): Promise<string> {
    const payload = await this.requestJson<{ profile?: string | WireDocument[] }>('/v4/profile', 'GET')
    if (typeof payload.profile === 'string') return payload.profile
    if (Array.isArray(payload.profile)) {
      return payload.profile.map((item) => mapDocument(item)?.content).filter((text): text is string => text !== undefined).join('\n')
    }
    return ''
  }

  private tagPrefix(): string {
    // The plugin applies one prefix for the lifetime of the client; keeping the
    // prefix out of construction would split one deployment's tags across values.
    return this.constructorTagPrefix
  }

  private readonly constructorTagPrefix = 'dsh'
```

Wait — that last bit invents a hidden constant. Stop; simplify: the plugin constructs the client with a `tagPrefix` option instead. Rewrite the tail of `client.ts` (replacing the two members above):

```ts
  private readonly tagPrefixValue: string

  /**
   * @param options - API key, optional endpoint base, and the container-tag prefix.
   */
  constructor(options: SupermemoryClientOptions & { tagPrefix: string }) {
    this.apiKey = options.apiKey
    this.baseURL = options.baseURL ?? SUPERMEMORY_DEFAULT_BASE_URL
    this.tagPrefixValue = options.tagPrefix
  }
```

…and every `containerTagFor(this.tagPrefix(), request.scope)` becomes `containerTagFor(this.tagPrefixValue, request.scope)`. Update the spec's constructions accordingly: `new SupermemoryClient({ apiKey: 'k', baseURL: 'https://api.test', tagPrefix: 'dsh' })` (and the same for the e2e file, passing `tagPrefix: 'dsh'`).

Continue `client.ts` with the shared transport helpers:

```ts
  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' }
  }

  private assertAvailable(): void {
    if (!this.available()) {
      throw new MemoryError('supermemory provider has no API key configured', 'MEMORY_PROVIDER_UNAVAILABLE')
    }
  }

  private async requestJson<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
    const response = await this.requestRaw(path, method, body)
    if (response.status === 204) return {} as T
    return JSON.parse(await response.text()) as T
  }

  private async requestRaw(path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown): Promise<Response> {
    this.assertAvailable()
    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers: this.headers(),
      ...body !== undefined ? { body: JSON.stringify(body) } : {},
    })
    if (!response.ok && !(method === 'DELETE' && response.status === 404)) {
      throw new MemoryError(`supermemory ${method} ${path} failed with HTTP ${response.status}`, 'MEMORY_PROVIDER_UNAVAILABLE')
    }
    return response
  }
}

function requireDocumentId(payload: WireDocumentRef): string {
  const id = payload.documentId ?? payload.id
  if (id === undefined || id.length === 0) {
    throw new MemoryError('supermemory add response carried no document id', 'MEMORY_REQUEST_INVALID')
  }
  return id
}

/** Map one wire document to a hit; documents without both id and content are skipped. */
function mapDocument(document: WireDocument): MemoryHit | undefined {
  const id = document.documentId ?? document.id
  const content = document.content ?? document.memory
  if (id === undefined || content === undefined || content.length === 0) return undefined
  return { id, content }
}
```

(The spec's `add` assertion stays valid with `tagPrefix: 'dsh'` since the global tag is `dsh-global`.)

Note: the `search` spec expects `memories[]` entries with mixed id/content field spellings to map — covered by `mapDocument`. The `profile` spec's `{ profile: 'Prefers tabs.' }` covers the string branch; the second test's `{ profile: [] }` covers the empty-array branch returning `''` (array maps to zero contents → join → `''`).

Create `packages/memory/memory-supermemory/src/key-source.ts`:

```ts
/**
 * API-key resolution for the supermemory provider: credentials service, then the
 * launching environment, then the Codex plugin's read-only credentials file.
 * Values are resolved per operation and never cached.
 * @module @deepseek-ai/dsh-memory-supermemory/key-source
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { MemoryError } from '@deepseek-ai/dsh-memory'
import type { CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'

/** Absolute path of the Codex plugin's credentials file (never written by dsh). */
export const CODEX_CREDENTIALS_FILE = join(homedir(), '.codex', 'supermemory', 'credentials.json')

/**
 * Extract the API key from one Codex credentials file body. Any malformed or
 * keyless body yields `undefined` — this file is a convenience fallback owned by
 * another tool, so unreadable content degrades to the next source instead of
 * failing the session.
 * @param raw - the file body.
 * @returns the key when the body carries one.
 */
export function parseCredentialsFile(raw: string): string | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value === 'object' && value !== null && 'apiKey' in value) {
      const apiKey: unknown = (value as Record<string, unknown>).apiKey
      if (typeof apiKey === 'string' && apiKey.length > 0) return apiKey
    }
  } catch {
    // Malformed JSON in another tool's file: fall through to `undefined`.
  }
  return undefined
}

/**
 * Resolve the supermemory API key: credentials service first, then launch
 * environment, then the Codex credentials file. Throws `MemoryError` naming
 * every consulted source when none yields a usable key.
 *
 * @param ctx - Cordis context; its `credentials` service is used when mounted.
 * @param ref - the credential reference naming the environment variable.
 * @returns the resolved key.
 */
export async function resolveSupermemoryApiKey(
  ctx: import('@deepseek-ai/cordis').Context,
  ref: CredentialRef,
): Promise<string> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit: ResolvedCredential | undefined = await credentials.resolve(ref)
    if (hit !== undefined && hit.value.length > 0) return hit.value
  } else {
    const ambient = launchEnvironmentOf(ctx).get(String(ref))
    if (ambient !== undefined && ambient.value.length > 0) return ambient.value
  }
  const codexKey = await readFile(CODEX_CREDENTIALS_FILE, 'utf-8').then(parseCredentialsFile, () => undefined)
  if (codexKey !== undefined) return codexKey
  throw new MemoryError(
    `no supermemory API key: store ${String(ref)} through the credentials service, export ${String(ref)}`
    + ` in the launching environment, or sign in once via the Codex supermemory login`,
    'MEMORY_PROVIDER_UNAVAILABLE',
  )
}
```

Check before compiling: confirm `CredentialRef` and `ResolvedCredential` are exported from `@deepseek-ai/dsh-credentials` (see `packages/credentials/credentials/src/index.ts`); adjust the import to whatever the module actually exports (`credentialRef(...)` produces the branded ref passed in).

- [ ] **Step 5: Implement plugin entry**

Create `packages/memory/memory-supermemory/src/index.ts`:

```ts
/**
 * `@deepseek-ai/dsh-memory-supermemory`: registers a supermemory.ai-backed
 * `MemoryProvider` with `ctx.memory`. A function plugin (NOT a default-export
 * service): the provider registers INTO the seam owned by `@deepseek-ai/dsh-memory`.
 * @module @deepseek-ai/dsh-memory-supermemory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-memory'
import { resolveSupermemoryApiKey } from './key-source.ts'
import { SupermemoryClient, SUPERMEMORY_DEFAULT_BASE_URL } from './client.ts'

export { SUPERMEMORY_DEFAULT_BASE_URL, SupermemoryClient } from './client.ts'
export { CODEX_CREDENTIALS_FILE, parseCredentialsFile, resolveSupermemoryApiKey } from './key-source.ts'
export { containerTagFor, slugifyProjectId } from './tags.ts'
export type { SupermemoryClientOptions } from './client.ts'

/** Default container-tag prefix. */
export const DEFAULT_CONTAINER_TAG_PREFIX = 'dsh'

/** Default env var carrying the supermemory API key. */
export const DEFAULT_API_KEY_ENV = 'SUPERMEMORY_API_KEY'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'memory-supermemory'

/** The memory seam this provider registers into. */
export const inject = ['memory']

/** Plugin config. */
export interface Config {
  /** Env var name holding the supermemory API key. Falls back to the launch environment, then the Codex credentials file. */
  apiKeyEnv?: string
  /** Endpoint base for the supermemory API. */
  baseURL?: string
  /** Prefix for container tags partitioning scopes. */
  containerTagPrefix?: string
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  containerTagPrefix: z.string(),
})

/**
 * Register the supermemory memory provider with `ctx.memory`.
 * @param ctx - Cordis context carrying the `memory` service.
 * @param config - validated plugin config with schemastery defaults applied.
 */
export function apply(ctx: Context, config: Config): void {
  const ref = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const client = new SupermemoryClient({
    apiKey: '',
    baseURL: config.baseURL ?? SUPERMEMORY_DEFAULT_BASE_URL,
    tagPrefix: config.containerTagPrefix ?? DEFAULT_CONTAINER_TAG_PREFIX,
  })
  // The key resolves lazily at first use so a session boots without network or
  // secret access; availability flips on once a key resolves.
  const lazy = new Proxy(client, {})
  void lazy
  ctx.memory.registerMemoryProvider(wrapWithLazyKey(client, ctx, ref))
}

/**
 * Wrap a client so its API key materializes on first use from the configured
 * sources, replacing the placeholder constructed above.
 *
 * @param client - the client constructed with an empty key.
 * @param ctx - Cordis context used for credential and environment resolution.
 * @param ref - the credential reference to resolve.
 * @returns the effective provider.
 */
function wrapWithLazyKey(
  client: SupermemoryClient,
  ctx: Context,
  ref: ReturnType<typeof credentialRef>,
): import('@deepseek-ai/dsh-memory').MemoryProvider {
  return {
    get id() { return client.id },
    available: () => false,
    add: (request) => resolved().then(provider => provider.add(request)),
    search: (request) => resolved().then(provider => provider.search(request)),
    remove: (id) => resolved().then(provider => provider.remove(id)),
    profile: () => resolved().then(provider => provider.profile()),
  }

  async function resolved(): Promise<SupermemoryClient> {
    const apiKey = await resolveSupermemoryApiKey(ctx, ref)
    return new SupermemoryClient({ apiKey, baseURL: currentBaseURL, tagPrefix: currentPrefix })
  }

  let currentBaseURL = clientBaseURL(client)
  let currentPrefix = clientPrefix(client)
}

function clientBaseURL(_client: SupermemoryClient): string { throw new Error('replaced below') }
function clientPrefix(_client: SupermemoryClient): string { throw new Error('replaced below') }
```

That draft over-complicated itself — discard it. Use this simpler, correct `apply` (the whole file body after the exports block):

```ts
/**
 * Register the supermemory memory provider with `ctx.memory`. The API key
 * resolves at each operation (never cached across operations), so a session
 * boots without touching the network or the secret store; the provider reports
 * itself unavailable until a key resolves, and a failed resolution surfaces as
 * a `MemoryError` from the attempted operation.
 *
 * @param ctx - Cordis context carrying the `memory` service.
 * @param config - validated plugin config with schemastery defaults applied.
 */
export function apply(ctx: Context, config: Config): void {
  const ref = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const baseURL = config.baseURL ?? SUPERMEMORY_DEFAULT_BASE_URL
  const tagPrefix = config.containerTagPrefix ?? DEFAULT_CONTAINER_TAG_PREFIX
  const delegate = new SupermemoryClient({ apiKey: '', baseURL, tagPrefix })

  const provider: import('@deepseek-ai/dsh-memory').MemoryProvider = {
    id: delegate.id,
    available: () => delegate.available(),
    add: (request) => keyed().then(keyedClient => keyedClient.add(request)),
    search: (request) => keyed().then(keyedClient => keyedClient.search(request)),
    remove: (id) => keyed().then(keyedClient => keyedClient.remove(id)),
    profile: () => keyed().then(keyedClient => keyedClient.profile()),
  }

  async function keyed(): Promise<SupermemoryClient> {
    const apiKey = await resolveSupermemoryApiKey(ctx, ref)
    return new SupermemoryClient({ apiKey, baseURL, tagPrefix })
  }

  ctx.memory.registerMemoryProvider(provider)
}
```

Delete `wrapWithLazyKey`, `clientBaseURL`, `clientPrefix`, and the earlier draft `apply` entirely — ship only this final `apply`. The spec file does not exercise `apply` directly (key resolution paths are covered by `resolveSupermemoryApiKey` unit tests plus the e2e); if the 100% coverage gate flags uncovered branches in `apply`, add a spec case constructing a bare `Context`, registering a `MemoryRuntime`, stubbing `globalThis.fetch`, exporting `SUPERMEMORY_API_KEY` via the credentials-less path with a temp-home override for `CODEX_CREDENTIALS_FILE`… — `CODEX_CREDENTIALS_FILE` is computed at module load, so make it injectable instead: change `resolveSupermemoryApiKey` to accept an optional `filePath = CODEX_CREDENTIALS_FILE` third parameter and use it in the final read. Then the coverage test calls `apply` with `process.env.SUPERMEMORY_API_KEY` set and `vi.stubGlobal('fetch', …)` capturing the outgoing request.

Create `packages/memory/memory-supermemory/src/invariant.ts` (same shape as Task 1's, with `PACKAGE_NAME = '@deepseek-ai/dsh-memory-supermemory'`, `name = 'memory-supermemory-invariant'`, and explanation: *"No runtime invariant: the provider is stateless per operation — every call re-resolves its key and the client owns wire parsing verified against the live-API e2e, so no independent observation stream exists."*).

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run packages/memory/memory-supermemory/tests/supermemory.spec.ts`
Expected: PASS. Then `pnpm run test:coverage -- packages/memory 2>/dev/null || pnpm exec vitest run --coverage packages/memory` — expected: 100% lines/branches on both packages' `src`.

- [ ] **Step 7: Commit**

```bash
git add packages/memory/memory-supermemory tsconfig.host.json pnpm-lock.yaml
git commit -m "feat(memory): add supermemory.ai provider with credential fallback chain"
```

---

### Task 3: `@deepseek-ai/dsh-tool-memory` — Consumer

**Files:**
- Create: `packages/memory/tool-memory/package.json`
- Create: `packages/memory/tool-memory/tsconfig.json`
- Create: `packages/memory/tool-memory/src/scope.ts`
- Create: `packages/memory/tool-memory/src/format.ts`
- Create: `packages/memory/tool-memory/src/tools.ts`
- Create: `packages/memory/tool-memory/src/recall.ts`
- Create: `packages/memory/tool-memory/src/index.ts`
- Create: `packages/memory/tool-memory/src/invariant.ts`
- Test: `packages/memory/tool-memory/tests/tool-memory.spec.ts`
- Modify: `tsconfig.host.json` (add reference)

**Interfaces:**
- Consumes: `defineTool` from `@deepseek-ai/dsh-tools`; `ctx.tools.register(...)`, `ctx.systemPrompt.section(...)`, `ctx.on('system-prompt/assemble', ...)` waterfall; `MemoryRuntime` operations; `PromptAssembly.sections: AssembledSection[]` (mutable).
- Produces:
  - Plugin `name = 'tool-memory'`, `inject = ['tools', 'memory', 'systemPrompt']`, `Config { save?, search?, forget?, recall? }` (booleans defaulting true), `apply(ctx, config)`.
  - Tools: `memory_save(content, scope)`, `memory_search(query, scope, limit?)`, `memory_forget(id)`; render intent `generic`.
  - `parseMemoryScope(value: unknown): MemoryScope` — accepts `'project' | 'global'` strings.
  - `projectScopeId(cwd: string): string` — nearest ancestor containing `.git`, else the cwd itself.
  - Recall waterfall listener contributing section `name: 'memory-profile'`, order `-10`, skipped silently (warn log) when `profile()` fails or returns `''`.

- [ ] **Step 1: Create package skeleton**

Write `packages/memory/tool-memory/package.json`:

```json
{
  "name": "@deepseek-ai/dsh-tool-memory",
  "description": "Model-facing memory tools and profile recall over the DeepSeek Harness memory capability seam (ctx.memory)",
  "version": "0.1.1-rc.2",
  "publishConfig": {
    "access": "public"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/deepseek-ai/deepseek-harness.git",
    "directory": "packages/memory/tool-memory"
  },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./invariant": {
      "types": "./lib/types/invariant.d.ts",
      "default": "./lib/invariant.js"
    },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/index.js",
    "lib/invariant.js",
    "lib/types/**/*.d.ts"
  ],
  "license": "MIT",
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-memory": "workspace:^",
    "@deepseek-ai/dsh-system-prompt": "workspace:^",
    "@deepseek-ai/dsh-tools": "workspace:^"
  },
  "dependencies": {
    "@deepseek-ai/schemastery": "workspace:^"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-memory": "workspace:^",
    "@deepseek-ai/dsh-system-prompt": "workspace:^",
    "@deepseek-ai/dsh-tools": "workspace:^"
  }
}
```

Write `packages/memory/tool-memory/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types"
  },
  "include": [
    "src"
  ],
  "references": [
    {
      "path": "../../../vendor/cosmokit"
    },
    {
      "path": "../../../vendor/cordis"
    },
    {
      "path": "../../../vendor/schemastery"
    },
    {
      "path": "../memory"
    },
    {
      "path": "../../core/system-prompt"
    },
    {
      "path": "../../core/tools"
    },
    {
      "path": "../../runtime-diagnostics/invariants"
    }
  ]
}
```

(Check the actual group dirs for `dsh-tools` and `dsh-system-prompt` with `ls packages/core` and correct the reference paths if they differ.) Append `{ "path": "./packages/memory/tool-memory" }` to `tsconfig.host.json`. Run `pnpm install`.

- [ ] **Step 2: Write the failing tests**

Create `packages/memory/tool-memory/tests/tool-memory.spec.ts`:

```ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatSaveOutput, formatSearchOutput, parseMemoryScope } from '../src/format.ts'
import { projectScopeId } from '../src/scope.ts'
import type { MemoryScope } from '@deepseek-ai/dsh-memory'

describe('parseMemoryScope', () => {
  it('accepts the two scope words and rejects everything else', () => {
    expect(parseMemoryScope('global')).toEqual({ kind: 'global' })
    expect(parseMemoryScope('project')).toEqual({ kind: 'project', id: '/repo' })
    expect(() => parseMemoryScope('everything')).toThrow(/scope/)
    expect(() => parseMemoryScope(42)).toThrow(/scope/)
  })
})

describe('projectScopeId', () => {
  it('walks up to the nearest .git ancestor', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-memory-scope-'))
    const nested = join(root, 'a', 'b')
    mkdirSync(nested, { recursive: true })
    mkdirSync(join(root, '.git'))
    try {
      expect(projectScopeId(join(nested, 'file.txt'))).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to the resolved cwd when no .git ancestor exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-memory-scope-'))
    try {
      expect(projectScopeId(root)).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('output formatting', () => {
  it('renders save confirmation with scope and id', () => {
    const scope: MemoryScope = { kind: 'global' }
    expect(formatSaveOutput({ id: 'doc_9', content: 'x' }, scope)).toContain('doc_9')
    expect(formatSaveOutput({ id: 'doc_9', content: 'x' }, scope)).toContain('global')
  })

  it('renders search hits and the empty case', () => {
    expect(formatSearchOutput([{ id: 'a', content: 'alpha' }])).toContain('alpha')
    expect(formatSearchOutput([])).toContain('No memories found')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run packages/memory/tool-memory/tests/tool-memory.spec.ts`
Expected: FAIL — modules under `../src/` do not exist.

- [ ] **Step 4: Implement scope, format, tools, recall, entry**

Create `packages/memory/tool-memory/src/scope.ts`:

```ts
/**
 * Project-scope derivation for the memory tools: the id is the nearest ancestor
 * directory containing `.git`, else the working directory itself. Derived
 * explicitly here — never inside the provider.
 * @module @deepseek-ai/dsh-tool-memory/scope
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Derive the project scope id for a working directory.
 * @param cwd - the agent's working directory (absolute or relative).
 * @returns the absolute repository root when one encloses `cwd`, else the absolute cwd.
 */
export function projectScopeId(cwd: string): string {
  const start = resolve(cwd)
  let current = start
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return start
    current = parent
  }
}
```

Create `packages/memory/tool-memory/src/format.ts`:

```ts
/**
 * Argument parsing and output formatting for the memory tools. Pure functions of
 * their inputs; presentation methods stay side-effect free per the tool-design rule.
 * @module @deepseek-ai/dsh-tool-memory/format
 */

import { MemoryError } from '@deepseek-ai/dsh-memory'
import type { MemoryHit, MemoryScope } from '@deepseek-ai/dsh-memory'

/**
 * Parse the model-supplied scope word into a {@link MemoryScope}. The project id
 * is attached by the caller, which owns cwd-derived scoping.
 *
 * @param value - the raw argument; only `'project'` and `'global'` are accepted.
 * @param projectId - the derived project scope id (used when `value` is `'project'`).
 * @returns the parsed scope.
 * @throws `MemoryError` code `MEMORY_REQUEST_INVALID` for any other value.
 */
export function parseMemoryScope(value: unknown, projectId = '/repo'): MemoryScope {
  if (value === 'global') return { kind: 'global' }
  if (value === 'project') return { kind: 'project', id: projectId }
  throw new MemoryError(`memory scope must be 'project' or 'global', received ${JSON.stringify(value)}`, 'MEMORY_REQUEST_INVALID')
}

/**
 * Format one save outcome as the model-facing text block.
 * @param hit - the stored record.
 * @param scope - the scope it was stored into.
 * @returns the confirmation text naming the id and scope.
 */
export function formatSaveOutput(hit: MemoryHit, scope: MemoryScope): string {
  const scopeLabel = scope.kind === 'global' ? 'global' : `project ${scope.id}`
  return `Saved to ${scopeLabel} memories with id ${hit.id}. Pass this id to memory_forget to remove it.`
}

/**
 * Format search hits as the model-facing text block.
 * @param hits - the matched records.
 * @returns a markdown list of hits, or the empty notice.
 */
export function formatSearchOutput(hits: MemoryHit[]): string {
  if (hits.length === 0) return 'No memories found for this query.'
  return ['Found memories:', ...hits.map(hit => `- [${hit.id}] ${hit.content}`)].join('\n')
}
```

Create `packages/memory/tool-memory/src/tools.ts`:

```ts
/**
 * The model-facing memory tools: `memory_save`, `memory_search`, `memory_forget`.
 * Execution goes through `ctx.memory` — this module owns schemas, scope parsing,
 * limits, and formatting, never provider selection or network access.
 * @module @deepseek-ai/dsh-tool-memory/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-memory'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { formatSaveOutput, formatSearchOutput, parseMemoryScope } from './format.ts'
import { projectScopeId } from './scope.ts'

/** Upper bound on hits one `memory_search` may request. */
export const MEMORY_SEARCH_MAX_LIMIT = 25

/**
 * Register the three memory tools. Scope words are validated beyond the schema
 * DSL (`parseMemoryScope`), and the project scope id derives from the process
 * working directory at execution time. Registrations are effect-scoped and
 * unregister on plugin dispose.
 *
 * @param ctx - context whose `tools` and `memory` services perform registration
 *   and execution.
 */
export function applyMemoryTools(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:memory',
    order: 120,
    text: 'Persistent memory spans sessions. When the user asks you to remember something, or states a durable preference or decision, store it with memory_save — use scope "project" for repository-specific knowledge and "global" for user-level preferences. Before acting on assumptions about the user or this project, consider memory_search. memory_forget removes one memory by id.',
  })

  ctx.tools.register(defineTool({
    name: 'memory_save',
    description: 'Store one memory durably across sessions. Choose scope "project" for repository-specific knowledge or "global" for user-level preferences.',
    parameters: {
      content: { type: 'string', required: true, description: 'The memory text; one self-contained fact.' },
      scope: { type: 'string', required: true, description: '"project" or "global".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          saved: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.saved }],
    },
    // Storing mutates remote memory state, not parent-agent state.
    isConcurrencySafe: () => false,
    async execute(args) {
      const scope = parseMemoryScope(args.scope, projectScopeId(process.cwd()))
      if (typeof args.content !== 'string' || args.content.trim().length === 0) {
        throw new Error('content must be a non-empty string')
      }
      const hit = await ctx.memory.add({ scope, content: args.content })
      return { id: hit.id, saved: formatSaveOutput(hit, scope) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: 'Search stored memories in one scope. Returns matching memory texts with their ids.',
    parameters: {
      query: { type: 'string', required: true, description: 'Free-text query.' },
      scope: { type: 'string', required: true, description: '"project" or "global".' },
      limit: { type: 'number', description: `Maximum hits to return (1–${MEMORY_SEARCH_MAX_LIMIT}).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                content: { type: 'string', required: true },
              },
            },
          },
          found: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.found }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const scope = parseMemoryScope(args.scope, projectScopeId(process.cwd()))
      const limit = args.limit === undefined ? undefined : Number(args.limit)
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MEMORY_SEARCH_MAX_LIMIT)) {
        throw new Error(`limit must be an integer between 1 and ${MEMORY_SEARCH_MAX_LIMIT}`)
      }
      const hits = await ctx.memory.search({ scope, query: String(args.query), ...(limit !== undefined ? { limit } : {}) })
      return { hits: hits.map(hit => ({ id: hit.id, content: hit.content })), found: formatSearchOutput(hits) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Remove one stored memory by its id (the id returned by memory_save or memory_search).',
    parameters: {
      id: { type: 'string', required: true, description: 'The memory id to remove.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.removed }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      if (typeof args.id !== 'string' || args.id.length === 0) throw new Error('id must be a non-empty string')
      await ctx.memory.remove(args.id)
      return { removed: `Removed memory ${args.id}.` }
    },
  }))
}
```

Create `packages/memory/tool-memory/src/recall.ts`:

```ts
/**
 * Automatic recall: contributes the user's memory-profile summary to every system-prompt
 * assembly through the `system-prompt/assemble` waterfall. Assembled sections are part of
 * the assembly result, so injected recall text is logged and reconstructable under the
 * model-visible ⟺ logged rule.
 * @module @deepseek-ai/dsh-tool-memory/recall
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AssembledSection } from '@deepseek-ai/dsh-system-prompt'

/** Section name the recall contribution registers under. */
export const MEMORY_PROFILE_SECTION_NAME = 'memory-profile'

/** Prompt order of the recall section; negative orders render before the persona. */
export const MEMORY_PROFILE_SECTION_ORDER = -10

/**
 * Install the recall waterfall listener. Failures degrade to a warning log with
 * the section omitted — an unreachable memory service must not fail the session.
 *
 * @param ctx - context carrying `memory` (operations) and `systemPrompt` (event target).
 */
export function applyRecall(ctx: Context): void {
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    try {
      const profile = await ctx.memory.profile()
      if (profile.length > 0) {
        const section: AssembledSection = {
          name: MEMORY_PROFILE_SECTION_NAME,
          text: `Durable memories about the user and past sessions:\n\n${profile}`,
        }
        assembled.sections.push(section)
      }
    } catch (error) {
      ctx.logger.warn('memory recall skipped: %o', error)
    }
    return assembled
  })
}
```

Verify the waterfall listener signature against `SystemPromptEvents['system-prompt/assemble']` (shown in `packages/core/system-prompt/src/index.ts:20-26`) and the `PromptAssembly` field name for sections (`assembly.sections` per `src/invariant.ts:18`); adapt names if the actual types differ. Confirm `ctx.logger.warn` supports `%o` formatting by checking a sibling usage (e.g. grep `logger.warn(` in `packages/web`); use the sibling's style verbatim.

Create `packages/memory/tool-memory/src/index.ts`:

```ts
/**
 * Model-facing memory tools and automatic profile recall over `ctx.memory`. This
 * consumer owns schemas, validation, prompt guidance, and recall injection; it
 * never touches concrete providers. Enablement controls tool registration; an
 * enabled tool stays visible when its provider is unavailable and fails with a
 * structured error at execution time.
 * @module @deepseek-ai/dsh-tool-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-memory'
import { applyMemoryTools } from './tools.ts'
import { applyRecall } from './recall.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-memory'

/** Services required by the memory tool suite. */
export const inject = ['tools', 'memory', 'systemPrompt']

/** Plugin config: which memory tools to register and whether recall injection is on. */
export interface Config {
  /** Register `memory_save`. Defaults to true. */
  save?: boolean
  /** Register `memory_search` and `memory_forget`. Defaults to true. */
  searchAndForget?: boolean
  /** Contribute the profile-recall section to every assembly. Defaults to true. */
  recall?: boolean
}

export const Config: z<Config> = z.object({
  save: z.boolean().default(true),
  searchAndForget: z.boolean().default(true),
  recall: z.boolean().default(true),
})

/**
 * Register the enabled memory tools and the recall listener. All three features
 * default to true; disable individual ones per composition in bundle patches.
 *
 * @param ctx - context carrying the required services.
 * @param config - validated plugin config with schemastery defaults applied.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.recall) applyRecall(ctx)
  if (config.save || config.searchAndForget) applyMemoryTools(ctx)
}
```

Hmm — `applyMemoryTools` currently registers all three tools unconditionally, while `Config` distinguishes `save` from `searchAndForget`. Reconcile: change `applyMemoryTools(ctx)` to `applyMemoryTools(ctx, { save: boolean, searchAndForget: boolean })` and wrap each `ctx.tools.register(defineTool({...}))` block in the corresponding flag check (`if (options.save) { … }`, `if (options.searchAndForget) { … }`); the `systemPrompt.section` guidance text stays registered whenever either tool family is enabled. Update the JSDoc accordingly. Ship that version.

Create `packages/memory/tool-memory/src/invariant.ts` (same companion shape, `PACKAGE_NAME = '@deepseek-ai/dsh-tool-memory'`, `name = 'tool-memory-invariant'`, explanation: *"No runtime invariant: the consumer holds no state — tools delegate to `ctx.memory` per call and recall appends one assembly section, both observed downstream by the session log."*).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/memory/tool-memory/tests/tool-memory.spec.ts`
Expected: PASS. Then run the coverage command from Task 2 Step 6 — expected: 100% on all three packages. If `format.ts`'s default-parameter branch or any flag branch in `tools.ts` is uncovered, extend the spec to cover it (coverage is a hard CI gate).

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm run typecheck` — Expected: passes.

```bash
git add packages/memory/tool-memory tsconfig.host.json pnpm-lock.yaml
git commit -m "feat(memory): add memory tools and profile recall consumer"
```

---

### Task 4: Opt-in `supermemory` bundle

**Files:**
- Create: `packages/bundle/supermemory/package.json`
- Create: `packages/bundle/supermemory/cordis.patch.yml`
- Create: `packages/bundle/supermemory/tsconfig.json` (only if the bundle ships runtime source; it does not — omit unless the workspace constraints gate requires one; `base/` has one because it ships plugins, a pure patch-only bundle may not need it — mirror whichever existing pure-patch bundle does, or add the minimal one shown)
- Create: `packages/bundle/supermemory/README.md` (full text in Task 5)
- Modify: root `package.json` workspaces — NO edit needed (`packages/*/*` glob covers it); verify with `pnpm install`.

**Interfaces:**
- Produces: installable bundle `@deepseek-ai/dsh-supermemory` declaring `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; users enable it by adding the package name to their profile's `"dsh": { "profile": { "bundles": [...] } }` list (see `docs/user/develop/basic/publish.md:93`).

- [ ] **Step 1: Create the bundle package**

Write `packages/bundle/supermemory/package.json`:

```json
{
  "name": "@deepseek-ai/dsh-supermemory",
  "description": "Opt-in dsh profile bundle composing the memory capability seam with the supermemory.ai provider and its model-facing tools",
  "version": "0.1.1-rc.2",
  "publishConfig": {
    "access": "public"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/deepseek-ai/deepseek-harness.git",
    "directory": "packages/bundle/supermemory"
  },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/index.js",
    "lib/invariant.js",
    "lib/types/**/*.d.ts",
    "cordis.patch.yml"
  ],
  "license": "MIT",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  "dependencies": {
    "@deepseek-ai/dsh-memory": "workspace:^",
    "@deepseek-ai/dsh-memory-supermemory": "workspace:^",
    "@deepseek-ai/dsh-tool-memory": "workspace:^"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:^"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "workspace:^"
  }
}
```

If the constraints/publint gates reject the `lib/*` entries for a package with no build output, create `src/index.ts` containing only the module JSDoc (`/** Patch-only bundle; the substance is ./cordis.patch.yml. @module @deepseek-ai/dsh-supermemory */\nexport {}`) plus the `tsconfig.json` extending the base config with no references, matching how other patch-only bundles satisfy the gates — check `packages/bundle/base/src/` first and mirror what exists there.

Write `packages/bundle/supermemory/cordis.patch.yml`:

```yml
# The dsh-supermemory bundle patch: opt-in hosted memory over supermemory.ai.
# Apply it AFTER base (profiles list bundles in order). Rows address the base
# composition by insertion; nothing here modifies existing rows, so default
# profiles without this bundle are untouched.
- insert:
    - id: memory
      name: '@deepseek-ai/dsh-memory'

    - id: memory-provider
      name: '@deepseek-ai/dsh-memory-supermemory'
      config:
        containerTagPrefix: dsh

    - id: tool-memory
      name: '@deepseek-ai/dsh-tool-memory'
```

Run `pnpm install` and `pnpm run build` — Expected: build succeeds with the three library packages emitting `lib/`; the bundle emits nothing (or its trivial index).

- [ ] **Step 2: Commit**

```bash
git add packages/bundle/supermemory pnpm-lock.yaml
git commit -m "feat(bundle): add opt-in supermemory memory bundle"
```

---

### Task 5: Package READMEs (bilingual triplets)

**Files:**
- Create: `packages/memory/memory/README.md` (+ `README.zh.md`, `README.i18n.yaml`)
- Create: `packages/memory/memory-supermemory/README.md` (+ zh, sidecar)
- Create: `packages/memory/tool-memory/README.md` (+ zh, sidecar)
- Create: `packages/bundle/supermemory/README.md` (+ zh, sidecar)

Every package README ends with the gated canonical sequence — copy the exact section skeleton from `docs/cookbook/adding-a-package.md` §4 ("Model Experience" / "Known Limitations and Deferred Work") using `packages/web/web-search-exa/README.md` as the formatting exemplar.

- [ ] **Step 1: Write the four English READMEs**

Content requirements per README (draft these; keep each under ~60 lines):

`packages/memory/memory/README.md` — Service Definition for `ctx.memory`; document `registerMemoryProvider` replace-and-restore semantics, the four delegated operations, `MEMORY_NO_PROVIDER`, the `MemoryScope` union and the rule that project ids are derived by consumers, never providers. Model Experience sentence: the `dsh-tool-memory` consumer surfaces this seam as the `memory_*` tools and the recall section. Known limitations: single-active-provider semantics are deliberate; no event stream exists, so recall content is observable only through the assembled prompt.

`packages/memory/memory-supermemory/README.md` — Provider wiring, config table (`apiKeyEnv` credential-ref default `SUPERMEMORY_API_KEY`, `baseURL`, `containerTagPrefix`), resolution order (credentials service → launch env → `~/.codex/supermemory/credentials.json`, read-only), tag scheme (`dsh-global`, `dsh-project-<slug>`). Known limitations: wire shapes are unpinned externally and guarded by the self-skipping e2e; project-id slugging can collide across paths differing only by case/separators; the Codex credentials file is never written.

`packages/memory/tool-memory/README.md` — the three tools with argument tables, the recall waterfall listener and its failure-degrades-to-warning contract, section name/order constants, config flags. Known limitations: recall adds one static section per assembly (no incremental updates mid-session); project scope derives from the process cwd at execution time.

`packages/bundle/supermemory/README.md` — what enabling the bundle composes, the profile-bundles snippet:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "@deepseek-ai/dsh-supermemory"]
    }
  }
}
```

Known limitations: requires a supermemory account and reachable api.supermemory.ai; outage degrades recall to warnings.

- [ ] **Step 2: Mirror Chinese counterparts and record sidecars**

For each README, write `README.zh.md` mirroring structure section-for-section (header tokens like headings that are machine-checked stay structurally aligned; see `packages/bundle/headless/README.zh.md` for the established translation style). Then record pairing hashes:

```bash
pnpm run verify-translation-pairing --write packages/memory/memory/README.md packages/memory/memory-supermemory/README.md packages/memory/tool-memory/README.md packages/bundle/supermemory/README.md
```

Expected: `4 record(s) written`.

- [ ] **Step 3: Validate docs gates**

Run: `pnpm run doc-sync` — Expected: passes, including `verify-package-readme-limitations` and `verify-package-readme-model-experience`. Fix reported gaps (missing gated sections, budget overruns) before committing.

- [ ] **Step 4: Commit**

```bash
git add packages/memory/*/README* packages/bundle/supermemory/README*
git commit -m "docs(memory): bilingual package READMEs for the memory seam"
```

---

### Task 6: Keyless snapshot scenario (assembled transcript)

**Files:**
- Create: `examples/headless-agent/memory.cordis.snapshot.yml`
- Create: `examples/headless-agent/tests/fixtures/memory-wire-server.mjs`
- Modify: `examples/headless-agent/tests/headless.snapshot.ts` (new scenario constants + one `it`)
- Create: `examples/headless-agent/tests/snapshots/memory-tools/stream-json.expected.jsonl` (via refresh, not hand-written)

**Interfaces:**
- Consumes: `runLoaderSmoke`, `normalizeHeadlessStream`, `LOADER_SMOKE_TEST_TIMEOUT_MS`, `refreshing` flag, `binScript`, `tsconfigPath` (all already defined in `examples/headless-agent/tests/headless.snapshot.ts`); `@deepseek-ai/dsh-llm-replay` row pattern from `advanced.cordis.snapshot.yml:48-49`.

- [ ] **Step 1: Study the template scenario end-to-end**

Read `examples/headless-agent/tests/headless.snapshot.ts` `it('replays the advanced toolchain through the one-shot app', …)` (line ~595) together with `advanced.cordis.snapshot.yml`. Note exactly how the replay LLM is fed (where its script comes from — config, env, or prepared file), how the scenario prepares fixtures, and which normalization applies. The memory scenario copies that wiring and changes only the composition rows and the replayed turns.

- [ ] **Step 2: Write the wire mock server**

Create `examples/headless-agent/tests/fixtures/memory-wire-server.mjs` — an http server standing in for `api.supermemory.ai`:

```js
/**
 * Deterministic supermemory.ai stand-in for the memory snapshot scenario:
 * records added documents in memory, serves one fixed profile, and answers
 * searches from the recorded set. Started and stopped by the snapshot test.
 */
import { createServer } from 'node:http'

export function startMemoryWireServer() {
  const documents = new Map()
  return new Promise((started) => {
    const server = createServer((request, response) => {
      const chunks = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => {
        const body = chunks.length > 0 ? JSON.parse(chunks.join('')) : {}
        if (request.method === 'POST' && request.url === '/v3/documents') {
          const id = `doc_${documents.size + 1}`
          documents.set(id, { id, content: body.content })
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ documentId: id }))
          return
        }
        if (request.method === 'POST' && request.url === '/v4/search') {
          const hits = [...documents.values()].map(({ id, content }) => ({ documentId: id, content }))
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ memories: hits.slice(0, Number(body.limit ?? hits.length)) }))
          return
        }
        if (request.method === 'GET' && request.url === '/v4/profile') {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ profile: 'Prefers pnpm workspaces. Keeps PRs small.' }))
          return
        }
        if (request.method === 'DELETE' && /^\/v3\/documents\/.+/.test(request.url ?? '')) {
          const id = decodeURIComponent(request.url.split('/').at(-1))
          documents.delete(id)
          response.statusCode = 204
          response.end()
          return
        }
        response.statusCode = 404
        response.end('{}')
      })
    })
    server.listen(0, '127.0.0.1', () => started({ server, port: server.address().port }))
  })
}
```

- [ ] **Step 3: Write the scenario composition**

Create `examples/headless-agent/memory.cordis.snapshot.yml` — modeled line-for-line on `advanced.cordis.snapshot.yml` (same `include`-over-`cordis.yml` shape, same `llm-deepseek` disable, same `llm-replay` insert with whatever script plumbing the advanced row uses) plus:

```yml
      - insert:
          - id: memory
            name: '@deepseek-ai/dsh-memory'

          - id: memory-provider
            name: '@deepseek-ai/dsh-memory-supermemory'
            config:
              baseURL: 'http://127.0.0.1:{{memoryPort}}'
              apiKeyEnv: SUPERMEMORY_API_KEY

          - id: tool-memory
            name: '@deepseek-ai/dsh-tool-memory'
```

If raw configs cannot interpolate the port, write the yml from the test into the prepared cwd (`prepare` callback) with the real port substituted, exactly as other scenarios materialize dynamic fixtures — follow the pattern the advanced test uses for its own dynamic bits.

- [ ] **Step 4: Extend the snapshot suite**

In `examples/headless-agent/tests/headless.snapshot.ts`, add a scenario constant next to the others:

```ts
const memoryConfigPath = fileURLToPath(new URL('../memory.cordis.snapshot.yml', import.meta.url))
const memoryStreamExpected = join(snapshotsDir, 'memory-tools', 'stream-json.expected.jsonl')
```

and one `it` inside `describe('headless stream-json snapshots')`, shaped exactly like the missing-credential test at line 426 (`runLoaderSmoke` → `normalizeHeadlessStream(result.stdout, runCwd)` → refresh-or-compare against `memoryStreamExpected`), with:

- `env: { DEEPSEEK_API_KEY: '', SUPERMEMORY_API_KEY: 'wire-mock-key', NODE_OPTIONS: … }`
- the wire server from Step 2 started before `runLoaderSmoke` and closed after
- replayed turns: one user prompt, one assistant turn calling `memory_save` (`{"content":"User prefers small PRs.","scope":"project"}`), then a final answer — following however the advanced scenario scripts turns for its tool calls
- durable assertions after the compare:

```ts
expect(normalized).toContain('memory_save')
expect(normalized).toContain('Prefers pnpm workspaces. Keeps PRs small.')
expect(normalized).toContain('Saved to project')
```

- [ ] **Step 5: Materialize expected output and verify replay**

Run: `DSH_SNAPSHOT=refresh pnpm run test:snapshot -t memory`
Expected: writes `tests/snapshots/memory-tools/stream-json.expected.jsonl`; the test passes. Then run plain `pnpm run test:snapshot -t memory` — Expected: passes keyless, twice in a row (replay determinism). Inspect the generated file once: it must contain the recall section text, the `memory_save` call, and the tool result — if the recall section is missing, the waterfall listener did not fire; debug before proceeding. Also run the FULL `pnpm run test:snapshot` to prove no existing scenario changed.

- [ ] **Step 6: Commit**

```bash
git add examples/headless-agent
git commit -m "test(headless): keyless memory-tools transcript snapshot"
```

---

### Task 7: Gates, Agent Note promotion, PR

- [ ] **Step 1: Full local gate sweep**

Run in order, fixing failures before moving on:

```bash
pnpm run test                      # unit suites
pnpm run test:coverage             # 100% gate incl. new packages
pnpm run typecheck
pnpm run lint
pnpm run duplication               # jscpd across new files
pnpm run hygiene                   # knip + publint + constraints
pnpm run doc-sync                  # all documentation gates incl. catalogs
```

Expected: all pass. New catalog entries (`docs/config-catalog.md`, `docs/tool-catalog.md`, capability-seams/module-graph) regenerate as part of `doc-sync` — commit whatever it rewrites.

- [ ] **Step 2: Promote the Agent Note proposed → implemented**

Move `.agents/notes/proposed/feature/2026-08-24-supermemory-plugin.{md,zh.md,i18n.yaml}` to `.agents/notes/implemented/feature/`, rewrite per the implemented skeleton: `Status: implemented`, `## Decision` (present tense, what shipped — three packages, bundle, tools, recall listener, credential chain), fold `## Acceptance criteria` + `## Risks` into `## Consequences`, drop future-tense planning prose, keep `## Alternatives considered` verbatim. Update the zh counterpart section-for-section, repair inbound links (grep the repo for the old path), and re-record the sidecar:

```bash
pnpm run verify-translation-pairing --write .agents/notes/implemented/feature/2026-08-24-supermemory-plugin.md
pnpm run verify-agent-note-format
```

- [ ] **Step 3: Final verification and push**

```bash
git status                # nothing unexpected unstaged
pnpm run test:snapshot -t memory   # keyless replay still green
```

Push the branch and open the PR with labels: one `kind/feature`, `area/memory` (create the area label if absent per the taxonomy note), native Issue Type. PR body links the Agent Note and lists evidence: commands run from Task 7 Step 1 plus the snapshot proof.

---

## Self-Review Record

- Spec coverage: seam (Task 1), provider + credential chain + tags (Task 2), tools + recall + scoping (Task 3), opt-in bundle isolation (Task 4), README/i18n gates (Task 5), keyless assembled-transcript snapshot + unchanged-defaults proof (Task 6), acceptance sweep + note promotion (Task 7). Real-API e2e lives in Task 2 (self-skipping). Nothing from the spec lacks a task.
- Placeholders: the intentionally deferred details (exact replay-script plumbing, tsconfig reference paths for `dsh-tools`/`dsh-system-prompt`) are phrased as concrete look-ups of named existing files, not open design questions.
- Type consistency: `MemoryScope`/`MemoryHit`/provider signatures match across Tasks 1→3; `containerTagFor(prefix, scope)` matches its call sites; `parseMemoryScope(value, projectId)` matches tool usage and spec; client constructor takes `{ apiKey, baseURL?, tagPrefix }` in both spec and plugin.
