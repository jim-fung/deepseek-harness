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
    const client = new SupermemoryClient({ apiKey: apiKey!, baseURL: process.env.SUPERMEMORY_BASE_URL ?? SUPERMEMORY_DEFAULT_BASE_URL, tagPrefix: 'dsh' })
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
