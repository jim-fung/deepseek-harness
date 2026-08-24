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
      // Sibling style (settings): a namespaced message, then the error alone so
      // the logger renders its stack instead of `%o`'s `{}`.
      ctx.logger.warn('memory: profile recall skipped')
      ctx.logger.warn(error)
    }
    return assembled
  })
}
