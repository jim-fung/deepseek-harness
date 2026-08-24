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
 * Register the enabled memory tools. Scope words are validated beyond the schema
 * DSL (`parseMemoryScope`), and the project scope id derives from the process
 * working directory at execution time. Registrations are effect-scoped and
 * unregister on plugin dispose.
 *
 * @param ctx - context whose `tools` and `memory` services perform registration
 *   and execution.
 * @param options - which tool families to register: `save` mounts `memory_save`,
 *   `searchAndForget` mounts `memory_search` and `memory_forget`. The guidance
 *   section registers whenever either family is enabled.
 */
export function applyMemoryTools(ctx: Context, options: { save: boolean; searchAndForget: boolean }): void {
  if (options.save || options.searchAndForget) {
    ctx.systemPrompt.section({
      name: 'tool:memory',
      order: 120,
      text: 'Persistent memory spans sessions. When the user asks you to remember something, or states a durable preference or decision, store it with memory_save — use scope "project" for repository-specific knowledge and "global" for user-level preferences. Before acting on assumptions about the user or this project, consider memory_search. memory_forget removes one memory by id.',
    })
  }

  if (options.save) {
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
  }

  if (options.searchAndForget) {
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
        const limit = args.limit
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MEMORY_SEARCH_MAX_LIMIT)) {
          throw new Error(`limit must be an integer between 1 and ${MEMORY_SEARCH_MAX_LIMIT}`)
        }
        const hits = await ctx.memory.search({ scope, query: args.query, ...(limit !== undefined ? { limit } : {}) })
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
}
