import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import MemoryRuntime, { MemoryError } from '@deepseek-ai/dsh-memory'
import type { MemoryScope } from '@deepseek-ai/dsh-memory'
import { containerTagFor, slugifyProjectId } from '../src/tags.ts'
import { SUPERMEMORY_DEFAULT_BASE_URL, SupermemoryClient } from '../src/client.ts'
import { parseCredentialsFile, resolveSupermemoryApiKey } from '../src/key-source.ts'
import * as supermemoryPlugin from '../src/index.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Set one environment variable for the duration of `run`, restoring the prior value after. */
async function withEnv(name: string, value: string | undefined, run: () => Promise<void>): Promise<void> {
  const prev = process.env[name]
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
  try {
    await run()
  } finally {
    if (prev === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = prev
  }
}

/** Credentials service double seeding exactly one resolvable value. */
class StubCredentials extends CredentialProvider {
  private readonly value: string | undefined

  constructor(ctx: Context, options: { value?: string } = {}) {
    super(ctx)
    this.value = options.value
  }

  override resolve(): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(this.value === undefined ? undefined : { value: this.value, source: 'stub' })
  }

  override describe(): Promise<{ configured: boolean; writable: boolean }> {
    return Promise.resolve({ configured: this.value !== undefined, writable: false })
  }

  override set(): Promise<void> {
    return Promise.resolve()
  }

  override unset(): Promise<void> {
    return Promise.resolve()
  }

  override readRecord(): Promise<CredentialRecord | undefined> {
    return Promise.resolve(undefined)
  }

  override describeRecord(): Promise<{ configured: boolean; writable: boolean }> {
    return Promise.resolve({ configured: false, writable: false })
  }

  override listRecords(): Promise<readonly never[]> {
    return Promise.resolve([])
  }

  override modifyRecord(): Promise<CredentialRecord | undefined> {
    return Promise.resolve(undefined)
  }

  override deleteRecord(): Promise<void> {
    return Promise.resolve()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('scope tagging', () => {
  it('maps the global scope to one stable tag', () => {
    expect(containerTagFor('dsh', { kind: 'global' })).toBe('dsh-global')
  })

  it('slugs project ids into the project tag', () => {
    expect(containerTagFor('dsh', { kind: 'project', id: '/Users/me/My App' })).toBe('dsh-project-users-me-my-app')
  })

  it('slugifyProjectId collapses separators and survives pathological input', () => {
    expect(slugifyProjectId('/a//b  c/')).toBe('a-b-c')
    expect(slugifyProjectId('///')).toBe('unnamed')
  })
})

describe('SupermemoryClient', () => {
  const GLOBAL: MemoryScope = { kind: 'global' }

  it('available() reflects whether an API key is configured', () => {
    expect(new SupermemoryClient({ apiKey: '', tagPrefix: 'dsh' }).available()).toBe(false)
    expect(new SupermemoryClient({ apiKey: 'k', tagPrefix: 'dsh' }).available()).toBe(true)
  })

  it('adds a document with the scope tag and returns the mapped hit', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) =>
      new Request(input, init).url.includes('/v3/documents') && !input.includes('/list')
        ? jsonResponse({ documentId: 'doc_1' })
        : jsonResponse({}, 404))
    vi.stubGlobal('fetch', fetchMock)
    const client = new SupermemoryClient({ apiKey: 'k', baseURL: 'https://api.test', tagPrefix: 'dsh' })
    await expect(client.add({ scope: GLOBAL, content: 'likes tabs' }))
      .resolves.toEqual({ id: 'doc_1', content: 'likes tabs' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ content: 'likes tabs', containerTags: ['dsh-global'] })
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer k')
  })

  it('maps an add response carrying only id, and rejects responses without a usable id', async () => {
    const client = new SupermemoryClient({ apiKey: 'k', baseURL: 'https://api.test', tagPrefix: 'dsh' })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ id: 'doc_2' })))
    await expect(client.add({ scope: GLOBAL, content: 'c' })).resolves.toEqual({ id: 'doc_2', content: 'c' })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})))
    await expect(client.add({ scope: GLOBAL, content: 'c' })).rejects.toMatchObject({ code: 'MEMORY_REQUEST_INVALID' })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ documentId: '' })))
    await expect(client.add({ scope: GLOBAL, content: 'c' })).rejects.toMatchObject({ code: 'MEMORY_REQUEST_INVALID' })
  })

  it('rejects operations when no API key is configured', async () => {
    const client = new SupermemoryClient({ apiKey: '', tagPrefix: 'dsh' })
    expect(client.available()).toBe(false)
    await expect(client.profile()).rejects.toMatchObject({ code: 'MEMORY_PROVIDER_UNAVAILABLE' })
  })

  it('searches one scope, caps results to limit, and tolerates both wire list shapes', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      memories: [{ id: 'm1', memory: 'first' }, { documentId: 'm2', content: 'second' }, { id: 'm3', memory: 'third' }],
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new SupermemoryClient({ apiKey: 'k', baseURL: SUPERMEMORY_DEFAULT_BASE_URL, tagPrefix: 'dsh' })
    await expect(client.search({ scope: GLOBAL, query: 'tabs', limit: 2 }))
      .resolves.toEqual([
        { id: 'm1', content: 'first' },
        { id: 'm2', content: 'second' },
      ])
  })

  it('returns every hit when no limit is supplied, reading the results list shape and skipping unusable entries', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      results: [
        { id: 'r1', memory: 'via results' },
        { id: 'r2' },
        { memory: 'no id' },
        { id: 'r3', content: '' },
      ],
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new SupermemoryClient({ apiKey: 'k', baseURL: 'https://api.test', tagPrefix: 'dsh' })
    await expect(client.search({ scope: GLOBAL, query: 'q' }))
      .resolves.toEqual([{ id: 'r1', content: 'via results' }])
  })

  it('sends DELETE with the document id and ignores 404 on removal', async () => {
    let seenPath = ''
    const fetchMock = vi.fn(async (input: string) => {
      seenPath = input
      return new Response(null, { status: seenPath.endsWith('gone') ? 404 : 204 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new SupermemoryClient({ apiKey: 'k', baseURL: 'https://api.test', tagPrefix: 'dsh' })
    await expect(client.remove('doc_gone')).resolves.toBeUndefined()
    expect(seenPath).toContain('/v3/documents/doc_gone')
  })

  it('resolves a successful delete', async () => {
    let seenPath = ''
    const fetchMock = vi.fn(async (input: string) => {
      seenPath = input
      return new Response(null, { status: seenPath.endsWith('gone') ? 404 : 204 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new SupermemoryClient({ apiKey: 'k', baseURL: 'https://api.test', tagPrefix: 'dsh' })
    await expect(client.remove('doc_kept')).resolves.toBeUndefined()
    expect(seenPath).toContain('/v3/documents/doc_kept')
  })

  it('reads the profile endpoint and normalizes string and item-list payloads', async () => {
    const fetchMock = vi.fn(async (input: string) =>
      input.includes('/v4/profile') ? jsonResponse({ profile: 'Prefers tabs.' }) : jsonResponse({}, 404))
    vi.stubGlobal('fetch', fetchMock)
    const client = new SupermemoryClient({ apiKey: 'k', baseURL: 'https://api.test', tagPrefix: 'dsh' })
    await expect(client.profile()).resolves.toBe('Prefers tabs.')
  })

  it('joins only the profile array items that carry content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ profile: [{ id: 'p1', content: 'line one' }, { id: 'p2' }] })))
    const client = new SupermemoryClient({ apiKey: 'k', baseURL: 'https://api.test', tagPrefix: 'dsh' })
    await expect(client.profile()).resolves.toBe('line one')
  })

  it('returns an empty profile from a 204 response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    const client = new SupermemoryClient({ apiKey: 'k', baseURL: 'https://api.test', tagPrefix: 'dsh' })
    await expect(client.profile()).resolves.toBe('')
  })

  it('returns empty-string profile and throws unavailable on non-2xx data calls', async () => {
    const fetchMock = vi.fn(async (input: string) =>
      input.includes('/v4/profile') ? jsonResponse({ profile: [] }) : jsonResponse({ message: 'nope' }, 503))
    vi.stubGlobal('fetch', fetchMock)
    const client = new SupermemoryClient({ apiKey: 'k', baseURL: 'https://api.test', tagPrefix: 'dsh' })
    await expect(client.profile()).resolves.toBe('')
    await expect(client.search({ scope: GLOBAL, query: 'q' })).rejects.toMatchObject({ code: 'MEMORY_PROVIDER_UNAVAILABLE' })
  })
})

describe('Codex credentials fallback', () => {
  it('parses the Codex credentials file for its apiKey field', () => {
    expect(parseCredentialsFile('{"apiKey":"sm-1"}')).toBe('sm-1')
    expect(parseCredentialsFile('{}')).toBeUndefined()
    expect(parseCredentialsFile('not json')).toBeUndefined()
    expect(parseCredentialsFile('{"apiKey":123}')).toBeUndefined()
    expect(parseCredentialsFile('{"apiKey":""}')).toBeUndefined()
  })
})

describe('resolveSupermemoryApiKey', () => {
  let credentialsFile: string
  let missingFile: string
  let scratch: string

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'dsh-supermemory-'))
    credentialsFile = join(scratch, 'credentials.json')
    missingFile = join(scratch, 'missing.json')
    await writeFile(credentialsFile, JSON.stringify({ apiKey: 'sm-file' }))
  })

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  it('resolves through the mounted credentials service', async () => {
    const ctx = new Context()
    await ctx.plugin(StubCredentials, { value: 'sm-service' })
    await expect(resolveSupermemoryApiKey(ctx, credentialRef('SUPERMEMORY_TEST_KEY'), missingFile))
      .resolves.toBe('sm-service')
  })

  it('falls through an empty credentials value to the file', async () => {
    const ctx = new Context()
    await ctx.plugin(StubCredentials, { value: '' })
    await expect(resolveSupermemoryApiKey(ctx, credentialRef('SUPERMEMORY_TEST_KEY'), credentialsFile))
      .resolves.toBe('sm-file')
  })

  it('falls through a credentials miss to the file', async () => {
    const ctx = new Context()
    await ctx.plugin(StubCredentials, {})
    await expect(resolveSupermemoryApiKey(ctx, credentialRef('SUPERMEMORY_TEST_KEY'), credentialsFile))
      .resolves.toBe('sm-file')
  })

  it('resolves from the launch environment without a credentials service, defaulting the file path', async () => {
    const ctx = new Context()
    await withEnv('SUPERMEMORY_TEST_KEY', 'sm-env', async () => {
      await expect(resolveSupermemoryApiKey(ctx, credentialRef('SUPERMEMORY_TEST_KEY'), missingFile))
        .resolves.toBe('sm-env')
      // The two-arg call covers the default filePath arm; the environment hit
      // returns before any file read.
      await expect(resolveSupermemoryApiKey(ctx, credentialRef('SUPERMEMORY_TEST_KEY')))
        .resolves.toBe('sm-env')
    })
  })

  it('falls from the launch environment to the file', async () => {
    const ctx = new Context()
    await withEnv('SUPERMEMORY_TEST_KEY', undefined, async () => {
      await expect(resolveSupermemoryApiKey(ctx, credentialRef('SUPERMEMORY_TEST_KEY'), credentialsFile))
        .resolves.toBe('sm-file')
    })
  })

  it('throws MEMORY_PROVIDER_UNAVAILABLE naming every consulted source when all miss', async () => {
    const ctx = new Context()
    await withEnv('SUPERMEMORY_TEST_KEY', undefined, async () => {
      const error = await resolveSupermemoryApiKey(ctx, credentialRef('SUPERMEMORY_TEST_KEY'), missingFile).then(
        () => undefined,
        (thrown: unknown) => thrown,
      )
      expect(error).toBeInstanceOf(MemoryError)
      expect((error as MemoryError).code).toBe('MEMORY_PROVIDER_UNAVAILABLE')
      expect((error as MemoryError).message).toContain('SUPERMEMORY_TEST_KEY')
      expect((error as MemoryError).message).toContain('credentials service')
      expect((error as MemoryError).message).toContain('launching environment')
      expect((error as MemoryError).message).toContain('Codex')
    })
  })
})

describe('memory-supermemory plugin registration', () => {
  const GLOBAL: MemoryScope = { kind: 'global' }

  it('registers into ctx.memory and threads full config into every operation', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes('/v4/search')) return jsonResponse({ memories: [{ id: 'm1', memory: 'hit' }] })
      if (input.includes('/v4/profile')) return jsonResponse({ profile: 'p' })
      if (input.includes('/v3/documents/')) return new Response(null, { status: 204 })
      return jsonResponse({ documentId: 'd1' })
    })
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(MemoryRuntime)
    const fiber = await ctx.plugin(supermemoryPlugin, {
      apiKeyEnv: 'SUPERMEMORY_PLUGIN_TEST_KEY',
      baseURL: 'https://api.test',
      containerTagPrefix: 'proj',
    })
    await withEnv('SUPERMEMORY_PLUGIN_TEST_KEY', 'plug-key', async () => {
      await expect(ctx.memory.add({ scope: GLOBAL, content: 'c' })).resolves.toEqual({ id: 'd1', content: 'c' })
      await expect(ctx.memory.search({ scope: GLOBAL, query: 'q' })).resolves.toEqual([{ id: 'm1', content: 'hit' }])
      await expect(ctx.memory.remove('d1')).resolves.toBeUndefined()
      await expect(ctx.memory.profile()).resolves.toBe('p')
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://api.test/v3/documents')
      expect(JSON.parse(init.body as string)).toEqual({ content: 'c', containerTags: ['proj-global'] })
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer plug-key')
    })
    await fiber.dispose()
    await expect(ctx.memory.profile()).rejects.toMatchObject({ code: 'MEMORY_NO_PROVIDER' })
  })

  it('applies the env, base URL, and tag-prefix defaults when config omits them', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ documentId: 'd2' }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    new MemoryRuntime(ctx)
    supermemoryPlugin.apply(ctx, {})
    await withEnv('SUPERMEMORY_API_KEY', 'default-key', async () => {
      await expect(ctx.memory.add({ scope: GLOBAL, content: 'c' })).resolves.toEqual({ id: 'd2', content: 'c' })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe(`${SUPERMEMORY_DEFAULT_BASE_URL}/v3/documents`)
      expect(JSON.parse(init.body as string)).toEqual({ content: 'c', containerTags: ['dsh-global'] })
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer default-key')
    })
  })
})
