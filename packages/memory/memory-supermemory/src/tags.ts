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
