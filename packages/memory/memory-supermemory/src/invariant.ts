/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-memory-supermemory`.
 * @module @deepseek-ai/dsh-memory-supermemory/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-memory-supermemory'

/** Cordis companion plugin name. */
export const name = 'memory-supermemory-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the provider is stateless per operation — every call
 * re-resolves its key and the client owns wire parsing verified against the
 * live-API e2e, so no independent observation stream exists.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
