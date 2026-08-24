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
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as Required<Config>
  if (resolved.recall) applyRecall(ctx)
  if (resolved.save || resolved.searchAndForget) {
    applyMemoryTools(ctx, { save: resolved.save, searchAndForget: resolved.searchAndForget })
  }
}
