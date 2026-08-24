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
 * Register the supermemory memory provider with `ctx.memory`. The API key
 * resolves at each operation (never cached across operations), so a session
 * boots without touching the network or the secret store; a failed resolution
 * surfaces as a `MemoryError` from the attempted operation.
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
    add: request => keyed().then(keyedClient => keyedClient.add(request)),
    search: request => keyed().then(keyedClient => keyedClient.search(request)),
    remove: id => keyed().then(keyedClient => keyedClient.remove(id)),
    profile: () => keyed().then(keyedClient => keyedClient.profile()),
  }

  async function keyed(): Promise<SupermemoryClient> {
    const apiKey = await resolveSupermemoryApiKey(ctx, ref)
    return new SupermemoryClient({ apiKey, baseURL, tagPrefix })
  }

  ctx.memory.registerMemoryProvider(provider)
}
