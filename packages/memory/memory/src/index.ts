/**
 * Service Definition for the persistent-memory capability seam (`ctx.memory`): one active
 * provider plus scope-typed delegation. A later registration replaces the active provider;
 * disposing restores the provider it displaced. Operations without any registered provider
 * throw `MemoryError` code `MEMORY_NO_PROVIDER`.
 * @module @deepseek-ai/dsh-memory
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  MemoryAddRequest,
  MemoryHit,
  MemoryProvider,
  MemorySearchRequest,
} from './types.ts'
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
    const providers = this.providers
    const dispose = this.ctx.effect(function* () {
      providers.push(provider)
      yield () => {
        const index = providers.lastIndexOf(provider)
        /* v8 ignore next -- single-shot disposers and 1:1 pushes keep this cleanup's entry present. */
        if (index >= 0) providers.splice(index, 1)
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
