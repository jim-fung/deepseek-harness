/**
 * supermemory.ai REST client implementing `MemoryProvider`. This module owns the
 * vendor wire shapes — requests, responses, auth header, and tolerant response
 * mapping at the wire boundary. The real-API e2e (`tests/supermemory.e2e.ts`) is
 * the drift alarm for these unpinned shapes.
 * @module @deepseek-ai/dsh-memory-supermemory/client
 */

import { MemoryError } from '@deepseek-ai/dsh-memory'
import type { MemoryAddRequest, MemoryHit, MemoryProvider, MemorySearchRequest } from '@deepseek-ai/dsh-memory'
import { containerTagFor } from './tags.ts'

/** Default supermemory.ai API endpoint. */
export const SUPERMEMORY_DEFAULT_BASE_URL = 'https://api.supermemory.ai'

/** Construction options for {@link SupermemoryClient}. */
export interface SupermemoryClientOptions {
  /** Bearer token sent as the `authorization` header; empty disables the provider. */
  apiKey: string
  /** Endpoint base; endpoint paths are appended. Defaults to the public API. */
  baseURL?: string
}

/** Wire fields a stored document may carry its id under. */
interface WireDocumentRef {
  id?: string
  documentId?: string
}

/** Wire fields a listed memory may carry its content under. */
interface WireMemoryContent {
  content?: string
  memory?: string
}

type WireDocument = WireDocumentRef & WireMemoryContent

/**
 * supermemory.ai-backed provider. One instance serves all scopes; scope identity
 * rides in container tags (`containerTagFor`). `available()` reports credential
 * presence so enablement checks stay cheap.
 */
export class SupermemoryClient implements MemoryProvider {
  readonly id = 'memory-provider:supermemory'

  private readonly apiKey: string
  private readonly baseURL: string
  private readonly tagPrefixValue: string

  /**
   * @param options - API key, optional endpoint base, and the container-tag prefix.
   */
  constructor(options: SupermemoryClientOptions & { tagPrefix: string }) {
    this.apiKey = options.apiKey
    this.baseURL = options.baseURL ?? SUPERMEMORY_DEFAULT_BASE_URL
    this.tagPrefixValue = options.tagPrefix
  }

  /**
   * Whether this provider can serve requests.
   * @returns true when an API key is present.
   */
  available(): boolean {
    return this.apiKey.length > 0
  }

  /**
   * Store one memory as a tagged document.
   * @param request - scope and content.
   * @returns the stored record with the backend-assigned id.
   */
  async add(request: MemoryAddRequest): Promise<MemoryHit> {
    const body = { content: request.content, containerTags: [containerTagFor(this.tagPrefixValue, request.scope)] }
    const payload = await this.requestJson<WireDocumentRef>('/v3/documents', 'POST', body)
    return { id: requireDocumentId(payload), content: request.content }
  }

  /**
   * Search one scope's memories.
   * @param request - scope, query, and optional limit.
   * @returns hits capped to `request.limit` when supplied.
   */
  async search(request: MemorySearchRequest): Promise<MemoryHit[]> {
    const body: Record<string, unknown> = {
      q: request.query,
      containerTags: [containerTagFor(this.tagPrefixValue, request.scope)],
    }
    if (request.limit !== undefined) body.limit = request.limit
    const payload = await this.requestJson<{ memories?: WireDocument[]; results?: WireDocument[] }>('/v4/search', 'POST', body)
    const documents = [...payload.memories ?? [], ...payload.results ?? []]
    const hits = documents.map(mapDocument).filter((hit): hit is MemoryHit => hit !== undefined)
    return request.limit === undefined ? hits : hits.slice(0, request.limit)
  }

  /**
   * Delete one document by id. A missing document resolves (already gone),
   * anything else non-2xx throws.
   * @param id - a previously returned `MemoryHit.id`.
   */
  async remove(id: string): Promise<void> {
    await this.requestRaw(`/v3/documents/${encodeURIComponent(id)}`, 'DELETE')
  }

  /**
   * Fetch the user-level profile summary.
   * @returns the profile text, or `''` when absent or empty.
   */
  async profile(): Promise<string> {
    const payload = await this.requestJson<{ profile?: string | WireDocument[] }>('/v4/profile', 'GET')
    if (typeof payload.profile === 'string') return payload.profile
    if (Array.isArray(payload.profile)) {
      return payload.profile.map(item => mapDocument(item)?.content).filter((text): text is string => text !== undefined).join('\n')
    }
    return ''
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' }
  }

  private assertAvailable(): void {
    if (!this.available()) {
      throw new MemoryError('supermemory provider has no API key configured', 'MEMORY_PROVIDER_UNAVAILABLE')
    }
  }

  private async requestJson<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
    const response = await this.requestRaw(path, method, body)
    if (response.status === 204) return {} as T
    return JSON.parse(await response.text()) as T
  }

  private async requestRaw(path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown): Promise<Response> {
    this.assertAvailable()
    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers: this.headers(),
      ...body !== undefined ? { body: JSON.stringify(body) } : {},
    })
    if (!response.ok && !(method === 'DELETE' && response.status === 404)) {
      throw new MemoryError(`supermemory ${method} ${path} failed with HTTP ${response.status}`, 'MEMORY_PROVIDER_UNAVAILABLE')
    }
    return response
  }
}

function requireDocumentId(payload: WireDocumentRef): string {
  const id = payload.documentId ?? payload.id
  if (id === undefined || id.length === 0) {
    throw new MemoryError('supermemory add response carried no document id', 'MEMORY_REQUEST_INVALID')
  }
  return id
}

/** Map one wire document to a hit; documents without both id and content are skipped. */
function mapDocument(document: WireDocument): MemoryHit | undefined {
  const id = document.documentId ?? document.id
  const content = document.content ?? document.memory
  if (id === undefined || content === undefined || content.length === 0) return undefined
  return { id, content }
}
