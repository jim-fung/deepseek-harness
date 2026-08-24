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
 * @param filePath - the Codex credentials file to read as the final fallback;
 *   injectable so tests stay independent of the real home directory.
 * @returns the resolved key.
 */
export async function resolveSupermemoryApiKey(
  ctx: import('@deepseek-ai/cordis').Context,
  ref: CredentialRef,
  filePath: string = CODEX_CREDENTIALS_FILE,
): Promise<string> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit: ResolvedCredential | undefined = await credentials.resolve(ref)
    if (hit !== undefined && hit.value.length > 0) return hit.value
  } else {
    const ambient = launchEnvironmentOf(ctx).get(String(ref))
    if (ambient !== undefined && ambient.value.length > 0) return ambient.value
  }
  const codexKey = await readFile(filePath, 'utf-8').then(parseCredentialsFile, () => undefined)
  if (codexKey !== undefined) return codexKey
  throw new MemoryError(
    `no supermemory API key: store ${String(ref)} through the credentials service, export ${String(ref)}`
    + ' in the launching environment, or sign in once via the Codex supermemory login',
    'MEMORY_PROVIDER_UNAVAILABLE',
  )
}
