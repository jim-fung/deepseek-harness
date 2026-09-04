/**
 * Single replay-aware token-meter service for request and surface pressure.
 *
 * @module @deepseek-ai/dsh-token-meter
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, expandAssistantStream } from '@deepseek-ai/dsh-llm'
import type { LlmImageRequestPricing, LlmRuntime, Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type {
  EpochHeader,
  Session,
  SessionEvent,
  SessionLogOffset as SessionLogOffsetType,
} from '@deepseek-ai/dsh-session'
import {
  canonicalHeader,
  headerEquals,
  isSurfaceEvent,
  SessionLogOffset,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
// Type-only: activates the `ctx.sessionProjections` Context declaration.
import type {} from '@deepseek-ai/dsh-session-projection'
import type {
  TokenMeasurement,
  TokenMeasurementBaseline,
  TokenMeterConfig,
  TokenPressure,
} from './types.ts'
import { contextBreakdownProjectionDefinition } from './breakdown-projection.ts'
import { contextPressureProjectionDefinition, tokenUsageProjectionDefinition } from './usage-projection.ts'
import { estimateContent, estimateHeader, estimateMessage, ROLE_OVERHEAD } from './estimate.ts'
import { commitSurfaceTokens, planSurfaceTokens } from './surface-fold.ts'
import type { MeterSurfaceNode } from './surface-fold.ts'
import { priceSurface, priceSurfaceTotal } from './route-pricing.ts'

export type * from './types.ts'
// Module-edge re-export: forces the emitted index.d.ts to import the
// projection-unit modules, so their SessionProjectionStateMap augmentations load
// in aggregate programs that only import the package root.
export type * from './usage-projection.ts'
export type * from './breakdown-projection.ts'

/**
 * Raw anchor facts captured at the latest successful call; the baseline is
 * derived per measurement so the anchored surface reprices under the same
 * route pricing as the current surface it is compared with.
 */
interface MeasurementAnchor {
  readonly header: EpochHeader | undefined
  /** Surface snapshot the anchored request was derived from. */
  readonly nodes: readonly MeterSurfaceNode[]
  /** Fixed-heuristic price of the call's provider output. */
  readonly assistantTokens: number
  /** Provider usage of the call, when it reported one under a known header. */
  readonly usage: TokenUsage | undefined
}

interface ReplayState {
  /**
   * Log position this fold has reached. Reads advance the cursor lazily at
   * read time — there is no per-append work — so catch-up costs O(events
   * appended since the previous read) amortized, which alone bounds ordinary
   * read latency, and appends never rescan or copy the log for the meter.
   */
  consumedEvents: SessionLogOffsetType
  header: EpochHeader | undefined
  surface: MeterSurfaceNode[]
  stepStart: { turn: number; step: number; nodes: readonly MeterSurfaceNode[] } | undefined
  anchor: MeasurementAnchor | undefined
}

/** Sum disjoint provider usage buckets without double-counting reasoning output. */
function usageTokens(usage: TokenUsage): number {
  return usage.inputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
    + usage.outputTokens
}

/** Compare optional envelopes so a headerless estimate can track later surface deltas. */
function optionalHeaderEquals(
  left: EpochHeader | undefined,
  right: EpochHeader | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return headerEquals(left, right)
}

/** Reject stale or misspelled keys before defaults can hide them. */
function validateConfigKeys(config: TokenMeterConfig): void {
  for (const key of Object.keys(config)) {
    throw new Error(`TokenMeterConfig: unknown key "${key}" (no settings are supported)`)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tokenMeter: TokenMeter
  }
}

/** Replay owner for one service-wide estimator and isolated per-session folds. */
export class TokenMeter extends Service {
  // Schemastery preserves untrusted loader keys on an empty object schema;
  // the public type excludes settings while validateConfigKeys rejects them.
  static Config: z<TokenMeterConfig> = z.object({}) as unknown as z<TokenMeterConfig>

  static inject = ['sessionProjections']

  private readonly states = new WeakMap<Session, ReplayState>()

  constructor(ctx: Context, config: TokenMeterConfig = {}) {
    super(ctx, 'tokenMeter')
    validateConfigKeys(config)

    ctx.sessionProjections.register(tokenUsageProjectionDefinition)
    ctx.sessionProjections.register(contextPressureProjectionDefinition)
    ctx.sessionProjections.register(contextBreakdownProjectionDefinition)
  }

  /**
   * Measure current request pressure and surface through the durable tail.
   *
   * The effective envelope's routed provider/model selects the request-image
   * pricing every node is priced under: a route whose adapter declares image
   * pricing charges each retained image its visual tokens plus its
   * model-visible text, while other routes keep the fixed heuristic. Provider
   * usage is reused only when the latest successful call's canonical request
   * envelope matches `requestHeader` and its total is no lower than that
   * call's full route-priced anchor; otherwise the complete envelope and
   * surface are repriced.
   *
   * `requestHeader` replaces the latest logged envelope for pressure and node
   * pricing; the node set always describes the current session surface. Every
   * call clones those positional nodes, so measurement is O(surface).
   *
   * @param session - session to replay through its current durable tail.
   * @param requestHeader - optional effective request envelope replacing the latest logged header.
   * @returns a detached deeply immutable pressure and surface measurement.
   */
  measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement {
    const state = this._sync(session)
    const header = requestHeader === undefined
      ? state.header
      : canonicalHeader(requestHeader)
    const pricing = this._routeImagePricing(header)
    const fileText = this._fileRequestText()
    const surface = priceSurface(state.surface, pricing, fileText)
    const { baseline, surfaceDeltaTokens } = this._baselinePressure(
      header,
      state.anchor,
      surface.surfaceTokens,
      () => priceSurfaceTotal(state.anchor?.nodes ?? [], pricing, fileText),
    )

    return deepFreeze(structuredClone({
      logRevision: state.consumedEvents,
      baseline,
      surfaceDeltaTokens,
      totalTokens: Math.max(0, baseline.tokens + surfaceDeltaTokens),
      surfaceTokens: surface.surfaceTokens,
      nodes: surface.nodes,
    }))
  }

  /**
   * Current request-and-response pressure through the same replay fold and
   * route pricing as {@link measure} — for below-threshold gates that never
   * select a surface range. Totals only: unlike {@link measure} this
   * materializes no surface nodes, so a gate pays no O(surface) clone.
   * @param session - session to replay through its current durable tail.
   * @returns non-negative pressure priced exactly as {@link measure}'s `totalTokens`.
   */
  pressureOf(session: Session): TokenPressure {
    const state = this._sync(session)
    const pricing = this._routeImagePricing(state.header)
    const fileText = this._fileRequestText()
    const surfaceTokens = priceSurfaceTotal(state.surface, pricing, fileText)
    const { baseline, surfaceDeltaTokens } = this._baselinePressure(
      state.header,
      state.anchor,
      surfaceTokens,
      () => priceSurfaceTotal(state.anchor?.nodes ?? [], pricing, fileText),
    )
    return deepFreeze({ totalTokens: Math.max(0, baseline.tokens + surfaceDeltaTokens) })
  }

  /**
   * Baseline pressure and signed surface delta shared by {@link measure} and
   * {@link pressureOf} — one baseline implementation for both readers. The
   * anchored branch re-guts the anchored snapshot through
   * {@link repriceAnchorSurface} only when its header matches, so a mismatched
   * header pays no anchor walk.
   * @param header - effective envelope for this reading.
   * @param anchor - the latest successful call's anchor, when one exists.
   * @param surfaceTokens - current surface's route-priced total.
   * @param repriceAnchorSurface - totals-only reprice of the anchor's node set under the same pricing.
   * @returns the baseline and the signed current-surface delta.
   */
  private _baselinePressure(
    header: EpochHeader | undefined,
    anchor: MeasurementAnchor | undefined,
    surfaceTokens: number,
    repriceAnchorSurface: () => number,
  ): { baseline: TokenMeasurementBaseline; surfaceDeltaTokens: number } {
    if (anchor !== undefined && optionalHeaderEquals(anchor.header, header)) {
      // Matching headers share one route, so the anchored snapshot reprices
      // under the same pricing as the current surface and the signed delta
      // compares like with like.
      const anchorSurfaceTokens = repriceAnchorSurface() + anchor.assistantTokens
      const estimatedAnchorTokens = estimateHeader(header) + anchorSurfaceTokens
      const usage = anchor.usage
      // Signed heuristic deltas remain conservative only from an anchor
      // that is at least as large as the matching full heuristic price.
      const baseline = usage !== undefined && usageTokens(usage) >= estimatedAnchorTokens
        ? { kind: 'usage' as const, tokens: usageTokens(usage), usage }
        : { kind: 'estimated' as const, tokens: estimatedAnchorTokens }
      return { baseline, surfaceDeltaTokens: surfaceTokens - anchorSurfaceTokens }
    }
    if (header === undefined && surfaceTokens === 0) {
      return { baseline: { kind: 'none', tokens: 0 }, surfaceDeltaTokens: 0 }
    }
    return {
      baseline: { kind: 'estimated', tokens: estimateHeader(header) + surfaceTokens },
      surfaceDeltaTokens: 0,
    }
  }

  /** Resolve the routed model's image pricing, when the llm service and route declare one. */
  private _routeImagePricing(header: EpochHeader | undefined): LlmImageRequestPricing | undefined {
    const config = header?.config
    if (config === undefined) return undefined
    return this.ctx.get('llm')?.imageRequestPricing(config.provider, config.model)
  }

  /** Resolve request-time file projection when an LLM service is mounted. */
  private _fileRequestText(): (
    (ref: Parameters<LlmRuntime['fileRequestText']>[0]) => string
  ) | undefined {
    const llm = this.ctx.get('llm')
    return llm === undefined ? undefined : ref => llm.fileRequestText(ref)
  }

  /**
   * Heuristically price one model-visible message (instance face of the pure
   * `estimateMessage` export from `estimate.ts`).
   * @param message - message to price without mutation.
   * @returns content and role-framing tokens under the fixed service heuristic.
   */
  estimateMessage(message: Message): number {
    return estimateMessage(message)
  }

  /**
   * Catch one session's fold up to the current durable tail. Driven only by
   * reads; the incremental cursor keeps each call proportional to the events
   * appended since the session's previous read.
   */
  private _sync(session: Session): ReplayState {
    let state = this.states.get(session)
    if (state === undefined) {
      state = {
        consumedEvents: SessionLogOffset(0),
        header: undefined,
        surface: [],
        stepStart: undefined,
        anchor: undefined,
      }
      this.states.set(session, state)
    }

    while (state.consumedEvents < session.seq) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- contiguous session seqs index the durable log
      const event = session.eventAt(SessionSeq(state.consumedEvents))!
      this._foldEvent(state, event)
      state.consumedEvents = SessionLogOffset(state.consumedEvents + 1)
    }
    return state
  }

  /**
   * Run every fallible step — surface plan and anchor validation — before
   * mutating replay state, so a malformed event remains unread on every
   * retry instead of half-applying.
   */
  private _foldEvent(state: ReplayState, event: SessionEvent): void {
    let nextHeader = state.header
    let nextStepStart = state.stepStart
    let nextAnchor = state.anchor

    switch (event.type) {
      case 'request/header':
        nextHeader = canonicalHeader(event.data.header)
        break
      case 'step/start':
        if (state.stepStart !== undefined) {
          throw new Error(
            `token meter: step/start at seq ${event.seq} arrived before turn ${state.stepStart.turn}/step ${state.stepStart.step} ended`,
          )
        }
        nextStepStart = { ...event.data, nodes: [...state.surface] }
        break
      case 'step/end':
        if (state.stepStart === undefined
          || state.stepStart.turn !== event.data.turn
          || state.stepStart.step !== event.data.step) {
          throw new Error(`token meter: step/end at seq ${event.seq} has no matching step/start event`)
        }
        nextStepStart = undefined
        break
      default:
        break
    }

    const plan = isSurfaceEvent(event)
      ? planSurfaceTokens(state.surface, event)
      : undefined

    if (event.type === 'assistant/message') {
      const stepStart = state.stepStart
      if (stepStart === undefined
        || stepStart.turn !== event.data.turn
        || stepStart.step !== event.data.step) {
        throw new Error(`token meter: assistant/message at seq ${event.seq} has no matching step/start event`)
      }

      // assistant/message is surface-mandatory at every append/seed boundary.
      // oxlint-disable-next-line typescript/no-non-null-assertion
      const eventTokens = plan!.tokens
      if (event.data.usage !== undefined && nextHeader !== undefined) {
        nextAnchor = {
          header: nextHeader,
          nodes: stepStart.nodes,
          assistantTokens: this._estimateProviderAssistant(event),
          usage: event.data.usage,
        }
      } else {
        nextAnchor = {
          header: nextHeader,
          nodes: stepStart.nodes,
          assistantTokens: eventTokens,
          usage: undefined,
        }
      }
    }

    state.header = nextHeader
    state.stepStart = nextStepStart
    if (plan !== undefined) {
      commitSurfaceTokens(state.surface, plan)
    }
    state.anchor = nextAnchor
  }

  /**
   * Reassemble provider output from the message's exact embedded stream.
   */
  private _estimateProviderAssistant(
    event: SessionEvent<'assistant/message'>,
  ): number {
    const assembler = new BlockAssembler()
    for (const member of expandAssistantStream(event.data.stream)) assembler.push(member.chunk)
    const providerContent = assembler.blocks()
    return providerContent.length === 0 ? 0 : estimateContent(providerContent) + ROLE_OVERHEAD
  }
}

export default TokenMeter
