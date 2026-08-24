import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import MemoryRuntime, { MemoryError } from '@deepseek-ai/dsh-memory'
import type { MemoryProvider, MemoryScope } from '@deepseek-ai/dsh-memory'

const GLOBAL: MemoryScope = { kind: 'global' }
const PROJECT: MemoryScope = { kind: 'project', id: '/repo' }

function stubProvider(id: string, overrides: Partial<MemoryProvider> = {}): MemoryProvider & { calls: string[] } {
  const calls: string[] = []
  return {
    id,
    calls,
    ...{
      add: async (request) => {
        calls.push(`add:${request.scope.kind}:${request.content}`)
        return { id: `${id}:1`, content: request.content }
      },
      search: async (request) => {
        calls.push(`search:${request.scope.kind}:${request.query}:${String(request.limit)}`)
        return [{ id: `${id}:h1`, content: 'hit' }]
      },
      remove: async (removed) => {
        calls.push(`remove:${removed}`)
      },
      profile: async () => {
        calls.push('profile')
        return ''
      },
    } satisfies Pick<MemoryProvider, 'add' | 'search' | 'remove' | 'profile'>,
    ...overrides,
  } as MemoryProvider & { calls: string[] }
}

function installedContext(): { ctx: Context; memory: MemoryRuntime } {
  const ctx = new Context()
  const memory = new MemoryRuntime(ctx)
  return { ctx, memory }
}

describe('MemoryRuntime', () => {
  it('throws MEMORY_NO_PROVIDER when no provider is registered', async () => {
    const { ctx } = installedContext()
    expect(ctx.memory).toBeInstanceOf(MemoryRuntime)
    await expect(ctx.memory.profile()).rejects.toMatchObject({
      name: 'MemoryError',
      code: 'MEMORY_NO_PROVIDER',
    })
  })

  it('delegates operations to the active provider unchanged', async () => {
    const { memory } = installedContext()
    const provider = stubProvider('memory-provider:test')
    memory.registerMemoryProvider(provider)

    expect(await memory.add({ scope: GLOBAL, content: 'prefers pnpm' }))
      .toEqual({ id: 'memory-provider:test:1', content: 'prefers pnpm' })
    expect(await memory.search({ scope: PROJECT, query: 'editor', limit: 3 }))
      .toEqual([{ id: 'memory-provider:test:h1', content: 'hit' }])
    await memory.remove('memory-provider:test:h1')
    await memory.profile()

    expect(provider.calls).toEqual([
      'add:global:prefers pnpm',
      'search:project:editor:3',
      'remove:memory-provider:test:h1',
      'profile',
    ])
  })

  it('a later registration replaces the active provider; disposal restores the previous one', async () => {
    const { memory } = installedContext()
    const first = stubProvider('memory-provider:first')
    const second = stubProvider('memory-provider:second')
    const disposeFirst = memory.registerMemoryProvider(first)
    const disposeSecond = memory.registerMemoryProvider(second)

    await memory.add({ scope: GLOBAL, content: 'one' })
    expect(second.calls).toEqual(['add:global:one'])
    expect(first.calls).toEqual([])

    disposeSecond()
    await memory.add({ scope: GLOBAL, content: 'two' })
    expect(first.calls).toEqual(['add:global:two'])

    disposeFirst()
    await expect(memory.add({ scope: GLOBAL, content: 'three' })).rejects.toMatchObject({ code: 'MEMORY_NO_PROVIDER' })
  })

  it('disposing an out-of-order disposer removes only its own provider', async () => {
    const { memory } = installedContext()
    const first = stubProvider('memory-provider:first')
    const second = stubProvider('memory-provider:second')
    void memory.registerMemoryProvider(first) // stays active for the whole test
    const disposeSecond = memory.registerMemoryProvider(second)
    disposeSecond()
    disposeSecond()

    await expect(memory.add({ scope: GLOBAL, content: 'one' })).resolves.toEqual({
      id: 'memory-provider:first:1',
      content: 'one',
    })
  })

  it('MemoryError carries its code through rejections', async () => {
    const error = new MemoryError('boom', 'MEMORY_REQUEST_INVALID')
    expect(error.code).toBe('MEMORY_REQUEST_INVALID')
    expect(error.name).toBe('MemoryError')
    expect(error.message).toBe('boom')
  })
})
