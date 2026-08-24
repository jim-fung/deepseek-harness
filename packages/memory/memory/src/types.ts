/**
 * Shared types for the persistent-memory capability seam (`ctx.memory`): scopes, records,
 * requests, the provider interface, and the seam's error type.
 * @module @deepseek-ai/dsh-memory/types
 */

/** Error codes carried by {@link MemoryError}; consumers switch on them. */
export type MemoryErrorCode =
  | 'MEMORY_NO_PROVIDER'
  | 'MEMORY_PROVIDER_UNAVAILABLE'
  | 'MEMORY_REQUEST_INVALID'

/**
 * The memory seam's error type. `code` discriminates handling at call sites;
 * messages are diagnostic text, never parsed.
 */
export class MemoryError extends Error {
  /**
   * @param message - human-readable diagnostic; names the failing operation and cause.
   * @param code - machine-readable discriminator from {@link MemoryErrorCode}.
   */
  constructor(message: string, readonly code: MemoryErrorCode) {
    super(message)
    this.name = 'MemoryError'
  }
}

/** Which partition of stored memories an operation addresses. */
export type MemoryScope =
  | { kind: 'global' }
  | { kind: 'project'; id: string }

/** One stored memory. */
export interface MemoryHit {
  /** Provider-assigned identifier; opaque to callers, round-trips to `remove`. */
  readonly id: string
  /** The stored text. */
  readonly content: string
}

/** Request to store one memory. */
export interface MemoryAddRequest {
  /** Scope that owns the stored memory. */
  readonly scope: MemoryScope
  /** The text to store. */
  readonly content: string
}

/** Request to search one scope. */
export interface MemorySearchRequest {
  /** Scope to search; scopes never mix in one result. */
  readonly scope: MemoryScope
  /** Free-text query interpreted by the backend. */
  readonly query: string
  /** Upper bound on hits; a provider may return fewer but never more. */
  readonly limit?: number
}

/** One backend implementation of durable memory storage. */
export interface MemoryProvider {
  /** Stable registry id, namespaced as `memory-provider:<vendor>`. */
  readonly id: string
  /**
   * Store one memory in the requested scope.
   * @param request - scope and content.
   * @returns the stored record including the backend-assigned id.
   * @throws `MemoryError` code `MEMORY_PROVIDER_UNAVAILABLE` when the backend cannot serve.
   */
  add(request: MemoryAddRequest): Promise<MemoryHit>
  /**
   * Search one scope.
   * @param request - scope, query, and optional limit.
   * @returns matching hits, capped to `limit` when supplied.
   */
  search(request: MemorySearchRequest): Promise<MemoryHit[]>
  /**
   * Remove one stored memory by id.
   * @param id - a previously returned `MemoryHit.id`.
   */
  remove(id: string): Promise<void>
  /**
   * User-level profile summary injected into system prompts.
   * @returns the profile text, or `''` when nothing is stored yet.
   */
  profile(): Promise<string>
}
