import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import MemoryRuntime from '@deepseek-ai/dsh-memory'
import type { MemoryAddRequest, MemoryProvider, MemoryScope, MemorySearchRequest } from '@deepseek-ai/dsh-memory'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolMemory from '../src/index.ts'
import { MEMORY_SEARCH_MAX_LIMIT, applyMemoryTools } from '../src/tools.ts'
import { MEMORY_PROFILE_SECTION_NAME, applyRecall } from '../src/recall.ts'
import { formatSaveOutput, formatSearchOutput, parseMemoryScope } from '../src/format.ts'
import { projectScopeId } from '../src/scope.ts'

const testToolSignal = new AbortController().signal

/** In-memory provider recording every operation it serves. */
function stubProvider(overrides: Partial<MemoryProvider> = {}): MemoryProvider {
  return {
    id: 'memory-provider:stub',
    add: async request => ({ id: 'stub_1', content: request.content }),
    search: async () => [{ id: 'stub_h1', content: 'alpha' }],
    remove: async () => {},
    profile: async () => 'prefers pnpm; ships on Thursdays',
    ...overrides,
  }
}

/** Mount the real registries, the memory seam with one stub provider, and the plugin. */
async function mount(options: {
  config?: ToolMemory.Config
  provider?: MemoryProvider
} = {}): Promise<{
  ctx: Context
  call: (name: string, args: unknown) => ReturnType<Context['tools']['execute']>
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(MemoryRuntime)
  ctx.memory.registerMemoryProvider(options.provider ?? stubProvider())
  await ctx.plugin(ToolMemory, options.config ?? {})
  let counter = 0
  const call = (name: string, args: unknown) =>
    ctx.tools.execute({ signal: testToolSignal, callId: CallId(`call-${++counter}`), name, arguments: args })
  return { ctx, call }
}

/** Run one call and return its failure message after asserting it failed. */
async function failureMessage(
  call: (name: string, args: unknown) => ReturnType<Context['tools']['execute']>,
  name: string,
  args: unknown,
): Promise<string> {
  const result = await call(name, args)
  expect(result.isError).toBe(true)
  if (result.isError) return result.error.message
  throw new Error(`tool "${name}" was expected to fail`)
}

describe('parseMemoryScope', () => {
  it('accepts the two scope words and rejects everything else', () => {
    expect(parseMemoryScope('global')).toEqual({ kind: 'global' })
    expect(parseMemoryScope('project')).toEqual({ kind: 'project', id: '/repo' })
    expect(() => parseMemoryScope('everything')).toThrow(/scope/)
    expect(() => parseMemoryScope(42)).toThrow(/scope/)
  })

  it('attaches the caller-derived project id', () => {
    expect(parseMemoryScope('project', '/work/repo')).toEqual({ kind: 'project', id: '/work/repo' })
  })
})

describe('projectScopeId', () => {
  it('walks up to the nearest .git ancestor', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-memory-scope-'))
    const nested = join(root, 'a', 'b')
    mkdirSync(nested, { recursive: true })
    mkdirSync(join(root, '.git'))
    try {
      expect(projectScopeId(join(nested, 'file.txt'))).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to the resolved cwd when no .git ancestor exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-memory-scope-'))
    try {
      expect(projectScopeId(root)).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('output formatting', () => {
  it('renders save confirmation with scope and id', () => {
    const scope: MemoryScope = { kind: 'global' }
    expect(formatSaveOutput({ id: 'doc_9', content: 'x' }, scope)).toContain('doc_9')
    expect(formatSaveOutput({ id: 'doc_9', content: 'x' }, scope)).toContain('global')
  })

  it('names the project scope id in the save confirmation', () => {
    const out = formatSaveOutput({ id: 'doc_9', content: 'x' }, { kind: 'project', id: '/work/repo' })
    expect(out).toContain('project /work/repo')
    expect(out).toContain('memory_forget')
  })

  it('renders search hits and the empty case', () => {
    expect(formatSearchOutput([{ id: 'a', content: 'alpha' }])).toContain('alpha')
    expect(formatSearchOutput([])).toContain('No memories found')
  })
})

describe('registered tools', () => {
  it('executes memory_save in both scopes and rejects blank content and bad scope words', async () => {
    const adds: MemoryAddRequest[] = []
    const provider = stubProvider({
      add: async (request) => {
        adds.push(request)
        return { id: 'stub_1', content: request.content }
      },
    })
    const { call } = await mount({ provider })

    expect(await call('memory_save', { content: 'prefers pnpm', scope: 'global' })).toMatchObject({
      isError: false,
      value: { id: 'stub_1', saved: 'Saved to global memories with id stub_1. Pass this id to memory_forget to remove it.' },
    })
    expect(await call('memory_save', { content: 'uses vitest', scope: 'project' })).toMatchObject({
      isError: false,
      value: { saved: `Saved to project ${projectScopeId(process.cwd())} memories with id stub_1. Pass this id to memory_forget to remove it.` },
    })
    expect(adds).toEqual([
      { scope: { kind: 'global' }, content: 'prefers pnpm' },
      { scope: { kind: 'project', id: projectScopeId(process.cwd()) }, content: 'uses vitest' },
    ])

    expect(await failureMessage(call, 'memory_save', { content: '  ', scope: 'global' }))
      .toContain('content must be a non-empty string')
    expect(await failureMessage(call, 'memory_save', { content: 'x', scope: 'team' })).toContain('scope')
  })

  it('executes memory_search with and without a limit and validates the limit', async () => {
    const searches: MemorySearchRequest[] = []
    const provider = stubProvider({
      search: async (request) => {
        searches.push(request)
        return [{ id: 'stub_h1', content: 'alpha' }]
      },
    })
    const { call } = await mount({ provider })

    expect(await call('memory_search', { query: 'editor', scope: 'global' })).toMatchObject({
      isError: false,
      value: { hits: [{ id: 'stub_h1', content: 'alpha' }], found: 'Found memories:\n- [stub_h1] alpha' },
    })
    expect(await call('memory_search', { query: 'editor', scope: 'project', limit: 5 })).toMatchObject({ isError: false })
    expect(searches).toEqual([
      { scope: { kind: 'global' }, query: 'editor' },
      { scope: { kind: 'project', id: projectScopeId(process.cwd()) }, query: 'editor', limit: 5 },
    ])

    expect(await failureMessage(call, 'memory_search', { query: 'q', scope: 'global', limit: 0 }))
      .toContain(`limit must be an integer between 1 and ${MEMORY_SEARCH_MAX_LIMIT}`)
    expect(await failureMessage(call, 'memory_search', { query: 'q', scope: 'global', limit: MEMORY_SEARCH_MAX_LIMIT + 1 }))
      .toContain('limit must be an integer')
    expect(await failureMessage(call, 'memory_search', { query: 'q', scope: 'global', limit: 1.5 }))
      .toContain('limit must be an integer')
    expect(await failureMessage(call, 'memory_search', { query: 'q', scope: 'everywhere' })).toContain('scope')
  })

  it('executes memory_forget and rejects an empty id', async () => {
    const removed: string[] = []
    const provider = stubProvider({
      remove: async (id) => {
        removed.push(id)
      },
    })
    const { call } = await mount({ provider })

    expect(await call('memory_forget', { id: 'stub_1' })).toMatchObject({
      isError: false,
      value: { removed: 'Removed memory stub_1.' },
    })
    expect(removed).toEqual(['stub_1'])
    expect(await failureMessage(call, 'memory_forget', { id: '' })).toContain('id must be a non-empty string')
  })

  it('classifies only memory_search as concurrency-safe', async () => {
    const { ctx } = await mount()
    const exec = (name: string, args: unknown) =>
      ctx.tools.executionMode({ signal: testToolSignal, callId: CallId(name), name, arguments: args })
    expect(exec('memory_search', { query: 'q', scope: 'global' })).toEqual({ kind: 'parallel' })
    expect(exec('memory_save', { content: 'x', scope: 'global' })).toEqual({ kind: 'exclusive' })
    expect(exec('memory_forget', { id: 'x' })).toEqual({ kind: 'exclusive' })
  })
})

describe('config enablement', () => {
  it('registers all three tools and the guidance section by default', async () => {
    const { ctx } = await mount()
    expect(ctx.tools.get('memory_save')).toBeDefined()
    expect(ctx.tools.get('memory_search')).toBeDefined()
    expect(ctx.tools.get('memory_forget')).toBeDefined()
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name)).toContain('tool:memory')
  })

  it('omits memory_save but keeps search, forget, and the guidance section when save is off', async () => {
    const { ctx } = await mount({ config: { save: false } })
    expect(ctx.tools.get('memory_save')).toBeUndefined()
    expect(ctx.tools.get('memory_search')).toBeDefined()
    expect(ctx.tools.get('memory_forget')).toBeDefined()
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name)).toContain('tool:memory')
  })

  it('omits memory_search and memory_forget but keeps memory_save when searchAndForget is off', async () => {
    const { ctx } = await mount({ config: { searchAndForget: false } })
    expect(ctx.tools.get('memory_save')).toBeDefined()
    expect(ctx.tools.get('memory_search')).toBeUndefined()
    expect(ctx.tools.get('memory_forget')).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name)).toContain('tool:memory')
  })

  it('registers nothing, guidance included, when both families are off', async () => {
    const { ctx } = await mount({ config: { save: false, searchAndForget: false } })
    expect(ctx.tools.get('memory_save')).toBeUndefined()
    expect(ctx.tools.get('memory_search')).toBeUndefined()
    expect(ctx.tools.get('memory_forget')).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name)).not.toContain('tool:memory')
  })

  it('applyMemoryTools with both flags false registers no tools and no section', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MemoryRuntime)
    applyMemoryTools(ctx, { save: false, searchAndForget: false })
    expect(ctx.tools.get('memory_save')).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name)).not.toContain('tool:memory')
  })
})

describe('profile recall', () => {
  it('contributes the profile as a memory-profile assembly section', async () => {
    expect(MEMORY_PROFILE_SECTION_NAME).toBe('memory-profile')
    const { ctx } = await mount()
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find(candidate => candidate.name === MEMORY_PROFILE_SECTION_NAME)
    expect(section?.text).toContain('prefers pnpm; ships on Thursdays')
  })

  it('places the recall section after every ordered section', async () => {
    const { ctx } = await mount()
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.at(-1)?.name).toBe(MEMORY_PROFILE_SECTION_NAME)
  })

  it('skips the section silently when the profile is empty', async () => {
    const { ctx } = await mount({ provider: stubProvider({ profile: async () => '' }) })
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name))
      .not.toContain(MEMORY_PROFILE_SECTION_NAME)
  })

  it('skips the section with a warning when the provider fails', async () => {
    const { ctx } = await mount({
      provider: stubProvider({ profile: async () => { throw new Error('backend down') } }),
    })
    const warnings: unknown[] = []
    ctx.logger.warn = ((message: unknown) => void warnings.push(message)) as typeof ctx.logger.warn
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.map(section => section.name)).not.toContain(MEMORY_PROFILE_SECTION_NAME)
    expect(assembly.sections.length).toBeGreaterThan(0)
    expect(warnings).toContain('memory: profile recall skipped')
  })

  it('registers no listener when recall is disabled', async () => {
    const { ctx } = await mount({ config: { recall: false }, provider: stubProvider() })
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name))
      .not.toContain(MEMORY_PROFILE_SECTION_NAME)
  })

  it('installs through applyRecall on a bare context', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(MemoryRuntime)
    ctx.memory.registerMemoryProvider(stubProvider())
    applyRecall(ctx)
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name))
      .toContain(MEMORY_PROFILE_SECTION_NAME)
  })
})
