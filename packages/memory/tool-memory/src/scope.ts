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
