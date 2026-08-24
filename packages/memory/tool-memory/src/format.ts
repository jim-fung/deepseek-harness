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
