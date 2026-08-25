/** Persistent PTY session with bounded output, readiness, and terminal-protocol replies. */

import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import type { IDisposable, Terminal as HeadlessTerminalType } from '@xterm/headless'
import type {
  SubprocessOutcome,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
} from '@deepseek-ai/dsh-subprocess'
import { TerminalError } from '@deepseek-ai/dsh-terminal'
import type {
  TerminalBackendSession,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalSendOperation,
  TerminalSendRead,
  TerminalSendRequest,
  TerminalSendResult,
  TerminalSessionStatus,
  TerminalSignal,
  TerminalSignalResult,
  TerminalWaitReason,
} from '@deepseek-ai/dsh-terminal'
import type { ResolvedConfig } from './config.ts'
import { CONTROLLED_PROMPT, TerminalSanitizer } from './sanitize.ts'

// Node exposes this package's CommonJS main as default-only, so load its named export through require.
const { Terminal: HeadlessTerminal } = createRequire(import.meta.url)('@xterm/headless') as typeof import('@xterm/headless')

function utf8Tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  const chars = Array.from(text)
  let bytes = 0
  let start = chars.length
  while (start > 0) {
    const next = Buffer.byteLength(chars[start - 1] as string)
    if (bytes + next > maxBytes) break
    bytes += next
    start -= 1
  }
  return { text: chars.slice(start).join(''), truncated: true }
}

/**
 * UTF-8 encoded size of one code point. Unpaired surrogates encode as U+FFFD,
 * matching `Buffer.byteLength` for any string scanned code point by code point.
 * @param point - a full Unicode code point.
 * @returns its UTF-8 byte length, 1 through 4.
 */
function codePointBytes(point: number): number {
  if (point < 0x80) return 1
  if (point < 0x800) return 2
  if (point < 0x10000) return 3
  return 4
}

/** One retained append with its precomputed UTF-8 byte length and newline char offsets. */
interface TextChunk {
  readonly text: string
  readonly bytes: number
  /** Ascending char offsets of every '\n' in `text`. */
  readonly newlines: readonly number[]
}

/**
 * Bounded retained-text window over an append-only stream. Text is kept as
 * chunks with per-chunk UTF-8 byte and newline accounting, so eviction drops
 * whole leading chunks in O(1) or cuts a code-point-aligned prefix of the head
 * chunk: a steady-state append at the cap costs O(append), not one pass over
 * the whole retained text. The two caps compose in a fixed order per append —
 * whole leading lines first, then the longest code-point-aligned suffix that
 * fits `maxBytes` — and a byte cut may start mid-line, with the surviving
 * fragment counting as a line for later evictions.
 *
 * Chunks must carry complete code point sequences (the session's streaming
 * decoder guarantees this): per-chunk byte sums equal the joined text's byte
 * length only when no surrogate pair is split across an append boundary.
 */
class BoundedTextBuffer {
  private chunks: TextChunk[] = []
  /** Prefix of `chunks[0]` already dropped, in chars, bytes, and newline entries. */
  private headChar = 0
  private headBytes = 0
  private headNewlines = 0
  private chars = 0
  private bytes = 0
  private newlines = 0
  private dropped = false
  private joined: string | undefined

  constructor(
    private readonly maxBytes: number,
    private readonly maxLines?: number,
  ) {}

  /** True once any append evicted or truncated retained text since the last `consume()`. */
  get truncated(): boolean {
    return this.dropped
  }

  /** True while no text is retained. */
  get isEmpty(): boolean {
    return this.chars === 0
  }

  /**
   * @returns the retained line count: 0 when nothing is retained, otherwise one per '\n' plus the trailing (possibly partial) line.
   */
  lineCount(): number {
    return this.chars === 0 ? 0 : this.newlines + 1
  }

  /**
   * Retain one more piece of output, then enforce the caps in order.
   * @param text - decoded output text; must not split a surrogate pair across appends.
   */
  append(text: string): void {
    if (text.length === 0) return
    const newlines: number[] = []
    for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) newlines.push(at)
    const bytes = Buffer.byteLength(text)
    this.chunks.push({ text, bytes, newlines })
    this.chars += text.length
    this.bytes += bytes
    this.newlines += newlines.length
    this.joined = undefined
    this.evictLines()
    this.evictBytes()
  }

  consume(): TerminalSendRead {
    const delta = this.retainedText()
    const truncated = this.dropped
    this.chunks = []
    this.headChar = 0
    this.headBytes = 0
    this.headNewlines = 0
    this.chars = 0
    this.bytes = 0
    this.newlines = 0
    this.dropped = false
    this.joined = undefined
    return { delta, truncated }
  }

  snapshot(): { text: string; truncated: boolean } {
    return { text: this.retainedText(), truncated: this.dropped }
  }

  /**
   * Extract the retained text spanning whole lines `[startLine, endLine)`.
   * @param startLine - first line index, 0-based from the front of the retained text.
   * @param endLine - exclusive upper line index, at most `lineCount()`; greater than `startLine`.
   * @returns the selected lines joined by their separating newlines.
   */
  linesText(startLine: number, endLine: number): string {
    const start = startLine === 0 ? 0 : this.newlinePosition(startLine - 1) + 1
    const end = endLine - 1 >= this.newlines ? this.chars : this.newlinePosition(endLine - 1)
    return this.substring(start, end)
  }

  /** Concatenate the retained fragments; cached until the next mutation. */
  private retainedText(): string {
    this.joined ??= (() => {
      const parts: string[] = []
      for (let index = 0; index < this.chunks.length; index += 1) {
        const chunk = this.chunks[index] as TextChunk
        parts.push(index === 0 ? chunk.text.slice(this.headChar) : chunk.text)
      }
      return parts.join('')
    })()
    return this.joined
  }

  /**
   * Drop while more than `maxLines` lines are retained, always through the oldest newline.
   */
  private evictLines(): void {
    if (this.maxLines === undefined) return
    while (this.newlines + 1 > this.maxLines) {
      const head = this.chunks[0] as TextChunk
      if (this.headNewlines === head.newlines.length) {
        this.dropHeadChunk()
        continue
      }
      this.dropHeadPrefix((head.newlines[this.headNewlines] as number) + 1)
    }
  }

  /**
   * Drop the smallest code-point-aligned prefix whose byte count covers the bytes over cap.
   */
  private evictBytes(): void {
    let excess = this.bytes - this.maxBytes
    while (excess > 0) {
      const head = this.chunks[0] as TextChunk
      if (head.bytes - this.headBytes <= excess) {
        excess -= head.bytes - this.headBytes
        this.dropHeadChunk()
        continue
      }
      let cutLocal = this.headChar
      let covered = 0
      while (covered < excess) {
        const point = head.text.codePointAt(cutLocal) as number
        covered += codePointBytes(point)
        cutLocal += point > 0xffff ? 2 : 1
      }
      this.dropHeadPrefix(cutLocal)
      return
    }
  }

  private dropHeadChunk(): void {
    const head = this.chunks.shift() as TextChunk
    this.chars -= head.text.length - this.headChar
    this.bytes -= head.bytes - this.headBytes
    this.newlines -= head.newlines.length - this.headNewlines
    this.headChar = 0
    this.headBytes = 0
    this.headNewlines = 0
    this.dropped = true
    this.joined = undefined
  }

  /**
   * Drop the head chunk's chars below `cutLocal`.
   * @param cutLocal - exclusive char boundary inside the head chunk's text, at a code point boundary.
   */
  private dropHeadPrefix(cutLocal: number): void {
    const head = this.chunks[0] as TextChunk
    let removedBytes = 0
    for (let index = this.headChar; index < cutLocal; ) {
      const point = head.text.codePointAt(index) as number
      removedBytes += codePointBytes(point)
      index += point > 0xffff ? 2 : 1
    }
    let droppedNewlines = 0
    while (this.headNewlines + droppedNewlines < head.newlines.length
      && (head.newlines[this.headNewlines + droppedNewlines] as number) < cutLocal) {
      droppedNewlines += 1
    }
    this.chars -= cutLocal - this.headChar
    this.bytes -= removedBytes
    this.newlines -= droppedNewlines
    this.headChar = cutLocal
    this.headBytes += removedBytes
    this.headNewlines += droppedNewlines
    this.dropped = true
    this.joined = undefined
  }

  /**
   * Locate one retained newline.
   * @param m - retained-newline ordinal; below `newlines`.
   * @returns its char offset within the retained text.
   */
  private newlinePosition(m: number): number {
    let base = 0
    for (let index = 0; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index] as TextChunk
      const head = index === 0
      const firstNewline = head ? this.headNewlines : 0
      const available = chunk.newlines.length - firstNewline
      if (m < available) return base + (chunk.newlines[firstNewline + m] as number) - (head ? this.headChar : 0)
      base += chunk.text.length - (head ? this.headChar : 0)
      m -= available
    }
    /* v8 ignore next -- callers pass m below the retained newline count, which some chunk holds. */
    throw new Error('terminal-bash: newline index outside the retained scrollback')
  }

  /**
   * Slice the retained text by char offsets without joining it.
   * @param from - inclusive start char offset.
   * @param to - exclusive end char offset, at most `chars`.
   * @returns the selected substring.
   */
  private substring(from: number, to: number): string {
    const parts: string[] = []
    let base = 0
    for (let index = 0; index < this.chunks.length && base < to; index += 1) {
      const chunk = this.chunks[index] as TextChunk
      const chunkStart = index === 0 ? this.headChar : 0
      const length = chunk.text.length - chunkStart
      if (base + length > from) {
        parts.push(chunk.text.slice(
          chunkStart + Math.max(0, from - base),
          chunkStart + Math.min(to - base, length),
        ))
      }
      base += length
    }
    return parts.join('')
  }
}

class LocalSendOperation implements TerminalSendOperation {
  private readonly output: BoundedTextBuffer
  private readonly promise: PromiseWithResolvers<TerminalSendResult>
  private finished = false
  private cancellationRequested = false
  private initialForegroundLeftWait: boolean
  private initialForegroundPgid: number | undefined

  constructor(
    maxBytes: number,
    readonly startedAt: number,
    private readonly onCancel: () => void,
  ) {
    this.output = new BoundedTextBuffer(maxBytes)
    this.promise = Promise.withResolvers<TerminalSendResult>()
    this.initialForegroundLeftWait = true
  }

  get done(): Promise<TerminalSendResult> {
    return this.promise.promise
  }

  get settled(): boolean {
    return this.finished
  }

  get cancelRequested(): boolean {
    return this.cancellationRequested
  }

  append(text: string): void {
    if (!this.finished) this.output.append(text)
  }

  settle(waitReason: TerminalWaitReason, sessionStatus: TerminalSessionStatus, inheritedTruncation: boolean): void {
    if (this.finished) return
    this.finished = true
    const read = this.output.snapshot()
    this.promise.resolve({
      viewport: read.text,
      waitReason,
      sessionStatus,
      truncated: read.truncated || inheritedTruncation,
    })
  }

  fail(error: unknown): void {
    if (this.finished) return
    this.finished = true
    this.promise.reject(error)
  }

  readOutput(): TerminalSendRead {
    return this.output.consume()
  }

  setInitialForeground(foreground: SubprocessTerminalForeground | undefined): void {
    this.initialForegroundPgid = foreground?.processGroupId
    this.initialForegroundLeftWait = foreground?.inputWaiting !== true
  }

  acceptsStdinWait(pgid: number, waiting: boolean): boolean {
    // The same group may still expose the wait that existed before terminal.write.
    // Observe every poll so a departure before the exact-settlement threshold
    // still makes a later return to that wait post-write evidence.
    if (pgid !== this.initialForegroundPgid) return waiting
    if (!waiting) this.initialForegroundLeftWait = true
    return waiting && this.initialForegroundLeftWait
  }

  cancel(): boolean {
    if (this.finished) return false
    this.cancellationRequested = true
    this.onCancel()
    return true
  }
}

/** Backend session wrapping one provider-owned terminal process. */
export class LocalPtySession implements TerminalBackendSession {
  motd = ''
  readonly pid: number
  private readonly decoder = new TextDecoder()
  /** Protocol state only; the sanitizer and bounded buffers own returned text. */
  private readonly emulator: HeadlessTerminalType
  private readonly emulatorData: IDisposable
  private readonly sanitizer: TerminalSanitizer
  private readonly scrollback: BoundedTextBuffer
  private readonly outputEnded = Promise.withResolvers<void>()
  private readonly completion: Promise<void>
  private statusValue: TerminalSessionStatus = { kind: 'running' }
  // TODO(pty-send-state-consolidation): Fold the per-send fields below
  // (active/activeTimer/activeDeadlineTimer/activeAbort/interrupting/
  // activeWrite/pollingReady/polling and terminal-protocol work) into one send-lifecycle
  // owner; the cancellation/readiness interplay has enough pinned tests to carry that refactor safely.
  private active: LocalSendOperation | undefined
  private activeTimer: NodeJS.Timeout | undefined
  private activeDeadlineTimer: NodeJS.Timeout | undefined
  private activeAbort: (() => void) | undefined
  private interrupting: LocalSendOperation | undefined
  private activeWrite: Promise<boolean> | undefined
  private pollingReady: LocalSendOperation | undefined
  private polling = false
  private promptSeen = false
  private promptTextSeen = false
  private promptTail = ''
  private shellPgid: number | undefined
  private initializing = false
  private lastOutputAt = Date.now()
  private closing = false
  private closePromise: Promise<void> | undefined
  private transportFailure: Error | undefined
  private emulatorWrites = Promise.resolve()
  private emulatorWriteDone: (() => void) | undefined
  private emulatorBuffer = ''
  private emulatorWriting = false
  private responseWrites = Promise.resolve()
  private pendingResponseWrites = 0
  private emulatorClosed = false

  constructor(
    private readonly terminal: SubprocessTerminalHandle,
    private readonly config: ResolvedConfig,
  ) {
    this.pid = terminal.pid
    this.emulator = new HeadlessTerminal({ cols: config.cols, rows: config.rows, scrollback: 0 })
    this.emulatorData = this.emulator.onData((data) => {
      this.pendingResponseWrites += 1
      const response = this.responseWrites.then(async () => { await this.terminal.write(data) })
      this.responseWrites = response.then(
        () => { this.finishResponseWrite() },
        (error: unknown) => {
          this.finishResponseWrite()
          if (!this.emulatorClosed && !this.closing) this.onTransportFailure(error)
        },
      )
    })
    this.sanitizer = new TerminalSanitizer(config.maxReadBytes)
    this.scrollback = new BoundedTextBuffer(config.scrollbackMaxBytes, config.scrollbackLines)
    terminal.output.on('data', this.onTerminalData)
    terminal.output.once('end', this.onTerminalEnd)
    terminal.output.once('error', this.onTerminalError)
    this.completion = terminal.done.then(
      outcome => this.onExit(outcome),
      (error: unknown) => { this.onTransportFailure(error) },
    )
  }

  /**
   * Capture startup output through the same readiness contract as later sends.
   * @param signal - optional cancellation while the shell reaches its first prompt.
   * @returns Resolves after startup readiness; rejects on exit or readiness timeout.
   */
  async initialize(signal?: AbortSignal): Promise<void> {
    this.initializing = true
    try {
      const operation = this.startSend({ text: '', submit: false, ...signal !== undefined ? { signal } : {} })
      const result = await operation.done
      if (result.waitReason === 'session_exit') throw new Error('PTY shell exited during startup')
      if (result.waitReason === 'timeout') throw new Error('PTY shell did not reach readiness before startup timeout')
      this.motd = result.viewport
    } catch (error: unknown) {
      signal?.throwIfAborted()
      throw error
    } finally {
      this.initializing = false
    }
  }

  startSend(request: TerminalSendRequest): TerminalSendOperation {
    if (this.closing) throw new Error('PTY session is closing')
    if (this.statusValue.kind === 'exited') throw new Error('PTY session has exited')
    if (this.active !== undefined) {
      const draining = this.activeWrite !== undefined
        ? ' or draining provider write'
        : this.interrupting !== undefined
          ? ' or draining foreground interrupt'
          : ''
      throw new TerminalError(`PTY session already has an active send${draining}`, 'SEND_ACTIVE')
    }
    if (request.signal?.aborted === true) throw new Error('PTY send aborted before write')

    const operation = new LocalSendOperation(
      this.config.maxReadBytes,
      Date.now(),
      () => { this.interrupt(operation) },
    )
    this.active = operation
    this.resetReadinessEvidence()

    if (request.signal !== undefined) {
      const onAbort = (): void => { operation.cancel() }
      request.signal.addEventListener('abort', onAbort, { once: true })
      this.activeAbort = () => request.signal?.removeEventListener('abort', onAbort)
    }
    this.activeDeadlineTimer = setTimeout(() => {
      if (this.active === operation) {
        this.settleActive('timeout', this.activeWrite !== undefined
          || this.interrupting === operation
          || this.protocolWorkPending())
      }
    }, this.config.timeoutMs)
    void this.beginSend(operation, request)
    return operation
  }

  private async beginSend(operation: LocalSendOperation, request: TerminalSendRequest): Promise<void> {
    let foreground: SubprocessTerminalForeground | undefined
    try {
      if (this.protocolWorkPending()) await this.drainTerminalProtocol()
      const emulatorWrites = this.emulatorWrites
      const responseWrites = this.responseWrites
      foreground = await this.terminal.inspectForeground()
      if (this.protocolStateChanged(emulatorWrites, responseWrites)) {
        foreground = await this.inspectForegroundAfterProtocol()
      }
    } catch (error: unknown) {
      if (this.protocolWorkPending()) await this.drainTerminalProtocol()
      // A pre-write inspection failure while cancellation owns the slot must not
      // release it: interruptOnce's in-flight foreground signal could land on a
      // successor's foreground group. The interrupt path's post-signal tail
      // resumes polling, whose guarded catch propagates a persistent failure.
      // A retained settled operation implies that same in-flight interrupt, so
      // this guard admits only an unsettled active send.
      if (this.active === operation && !this.closing && this.interrupting !== operation) {
        this.failActive(error)
      }
      return
    }
    try {
      if (this.active !== operation || this.closing || this.interrupting === operation) return
      operation.setInitialForeground(foreground)
      const input = `${request.text}${request.submit ? '\r' : ''}`
      if (input.length > 0 && !operation.cancelRequested) {
        this.resetReadinessEvidence()
        const write = this.terminal.write(input)
        this.activeWrite = write.then(() => true, () => false)
        try {
          await write
        } finally {
          this.activeWrite = undefined
        }
      }
      // Cancellation owns post-write signalling and reservation release.
      if (operation.cancelRequested) return
      if (this.active === operation && operation.settled) {
        this.releaseSettledActive()
        return
      }
      // Closing can race the awaited provider write even though static analysis sees only local assignments.
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- awaited provider writes can close the session.
      if (this.active === operation && !this.closing) {
        this.pollingReady = operation
        this.schedulePoll(operation)
      }
    } catch (error: unknown) {
      if (this.active === operation && !this.closing) {
        if (operation.settled) this.releaseSettledActive()
        else this.failActive(error)
      }
    }
  }

  private resetReadinessEvidence(): void {
    this.lastOutputAt = Date.now()
    this.promptSeen = false
    this.promptTextSeen = false
    this.promptTail = ''
  }

  read(request: TerminalReadRequest): TerminalReadResult {
    const totalLines = this.scrollback.lineCount()
    const offset = request.offset ?? 0
    const count = request.count ?? 500
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('PTY read offset must be a non-negative safe integer')
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('PTY read count must be a positive safe integer')
    if (offset >= totalLines) {
      return { text: '', totalLines, lineBegin: offset, lineEnd: offset, truncated: this.scrollback.truncated }
    }
    const end = totalLines - offset
    const start = Math.max(0, end - count)
    const requested = this.scrollback.linesText(start, end)
    const bounded = utf8Tail(requested, this.config.maxReadBytes)
    const returnedLines = bounded.text.length === 0 ? 0 : bounded.text.split('\n').length
    return {
      text: bounded.text,
      totalLines,
      lineBegin: offset,
      lineEnd: offset + returnedLines,
      truncated: this.scrollback.truncated || bounded.truncated,
    }
  }

  async signal(signal: TerminalSignal): Promise<TerminalSignalResult> {
    if (this.closing) throw new Error('PTY session is closing')
    const targetPgid = await this.terminal.signalForeground(signal)
    return { delivered: true, targetPgid }
  }

  status(): TerminalSessionStatus {
    return this.statusValue
  }

  close(reason: string): Promise<void> {
    this.closing = true
    if (this.closePromise !== undefined) return this.closePromise
    const closing = this.closeOnce(reason).catch((error: unknown) => {
      this.closePromise = undefined
      this.failActive(error)
      throw error
    })
    this.closePromise = closing
    return closing
  }

  private readonly onTerminalData = (chunk: Buffer | Uint8Array | string): void => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    const data = this.decoder.decode(bytes, { stream: true })
    this.queueEmulatorData(data)
    this.onData(data)
  }

  private readonly onTerminalEnd = (): void => {
    this.onData(this.decoder.decode())
    this.appendOutput(this.sanitizer.flush())
    this.closeEmulator()
    this.outputEnded.resolve()
  }

  private readonly onTerminalError = (error: Error): void => {
    this.closeEmulator()
    this.onTransportFailure(error)
    this.outputEnded.resolve()
  }

  private onData(data: string): void {
    const sanitized = this.sanitizer.push(data)
    this.appendOutput(sanitized.text)
    if (sanitized.prompt) {
      // TODO(pty-delayed-signal-prompt): With a reproducer, define a marker-generation boundary
      // before attributing a signal-delayed prompt to a later send.
      // Bash can print PROMPT_COMMAND before the kernel publishes its return
      // to the foreground process group. Retain the marker; polling below is
      // the authority that accepts it only after bash owns the foreground.
      this.promptSeen = true
      this.promptTail = ''
      this.lastOutputAt = Date.now()
    }
    if (this.promptSeen && sanitized.promptTail !== undefined) {
      const remaining = Math.max(0, CONTROLLED_PROMPT.length + 1 - this.promptTail.length)
      this.promptTail += sanitized.promptTail.slice(0, remaining)
      if (sanitized.promptTail.length > remaining) this.promptTail = `${CONTROLLED_PROMPT}\0`
      this.promptTextSeen = this.promptTail === CONTROLLED_PROMPT
    }
  }

  private async onExit(outcome: SubprocessOutcome): Promise<void> {
    await this.outputEnded.promise
    if (this.transportFailure !== undefined) return
    this.statusValue = { kind: 'exited', exitCode: outcome.exitCode, signal: outcome.signal }
    this.settleActive('session_exit')
  }

  private onTransportFailure(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error))
    this.transportFailure ??= failure
    this.statusValue = { kind: 'exited', exitCode: null, signal: null }
    this.closeEmulator()
    this.failActive(failure)
    void this.terminal.terminate().catch(() => {})
  }

  private appendOutput(text: string): void {
    if (text.length === 0) return
    this.lastOutputAt = Date.now()
    this.scrollback.append(text)
    this.active?.append(text)
  }

  private schedulePoll(operation: LocalSendOperation, delayMs = this.config.pollIntervalMs): void {
    if (this.active !== operation || this.interrupting === operation || this.polling) return
    if (this.activeTimer !== undefined) clearTimeout(this.activeTimer)
    this.activeTimer = setTimeout(() => {
      this.activeTimer = undefined
      void this.pollReadiness(operation)
    }, delayMs)
  }

  private async pollReadiness(operation: LocalSendOperation): Promise<void> {
    if (this.active !== operation || this.polling) return
    this.polling = true
    try {
      if (this.statusValue.kind === 'exited') {
        this.settleActive('session_exit')
        return
      }
      if (this.protocolWorkPending()) await this.drainTerminalProtocol()
      const emulatorWrites = this.emulatorWrites
      const responseWrites = this.responseWrites
      let foreground = await this.terminal.inspectForeground()
      if (this.protocolStateChanged(emulatorWrites, responseWrites)) {
        foreground = await this.inspectForegroundAfterProtocol()
      }
      if (this.active !== operation || this.closing || this.interrupting === operation) return
      const idleFor = Date.now() - this.lastOutputAt
      if (this.promptSeen && foreground !== undefined && this.shellPgid === undefined) {
        this.shellPgid = foreground.processGroupId
      }
      if (this.promptSeen && this.promptTextSeen && idleFor >= this.config.pollIntervalMs
        && foreground?.processGroupId === this.shellPgid) {
        this.settleActive('stdin_read')
        return
      }
      const elapsed = Date.now() - operation.startedAt
      const startupHasOutput = !this.initializing || !this.scrollback.isEmpty
      const acceptsStdinWait = startupHasOutput && foreground !== undefined
        && operation.acceptsStdinWait(foreground.processGroupId, foreground.inputWaiting)
      if (elapsed >= this.config.exactProbeAfterMs && acceptsStdinWait) {
        this.settleActive('stdin_read')
        return
      }
      // A prompt candidate can race bash's foreground handoff, but an interactive
      // child also inherits PROMPT_COMMAND. Silence therefore remains the bound
      // on waiting for shell ownership instead of letting a child marker suppress
      // readiness until the absolute timeout.
      const handoffGrace = this.promptSeen ? this.config.handoffGraceMs : 0
      if (startupHasOutput && idleFor >= this.config.idleSilenceMs + handoffGrace) {
        this.settleActive('inferred_idle')
      }
    } catch (error: unknown) {
      if (this.protocolWorkPending()) await this.drainTerminalProtocol()
      if (this.active === operation && !this.closing && this.interrupting !== operation) this.failActive(error)
    } finally {
      this.polling = false
      const active = this.active
      // Awaited provider inspection can clear or replace the active send despite static analysis.
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- awaited inspection can replace the active send.
      if (active !== undefined && this.pollingReady === active) this.schedulePoll(active)
    }
  }

  /** Wait until generated replies reach the provider before another send can publish. */
  private async drainTerminalProtocol(): Promise<void> {
    for (;;) {
      const emulatorWrites = this.emulatorWrites
      await emulatorWrites
      const responseWrites = this.responseWrites
      await responseWrites
      if (emulatorWrites === this.emulatorWrites && responseWrites === this.responseWrites
        && !this.protocolWorkPending()) return
    }
  }

  /** Sample foreground state only after protocol replies are quiet for the entire inspection. */
  private async inspectForegroundAfterProtocol(): Promise<SubprocessTerminalForeground | undefined> {
    for (;;) {
      if (this.protocolWorkPending()) await this.drainTerminalProtocol()
      const emulatorWrites = this.emulatorWrites
      const responseWrites = this.responseWrites
      const foreground = await this.terminal.inspectForeground()
      if (!this.protocolStateChanged(emulatorWrites, responseWrites)) return foreground
    }
  }

  private protocolStateChanged(emulatorWrites: Promise<void>, responseWrites: Promise<void>): boolean {
    return emulatorWrites !== this.emulatorWrites || responseWrites !== this.responseWrites
      || this.protocolWorkPending()
  }

  private protocolWorkPending(): boolean {
    return this.emulatorWriteDone !== undefined || this.pendingResponseWrites > 0
  }

  private queueEmulatorData(data: string): void {
    if (this.emulatorClosed) return
    this.emulatorBuffer += data
    if (this.emulatorWriteDone === undefined) {
      const idle = Promise.withResolvers<undefined>()
      this.emulatorWrites = idle.promise
      this.emulatorWriteDone = () => { idle.resolve(undefined) }
    }
    this.pumpEmulator()
  }

  private pumpEmulator(): void {
    if (this.emulatorWriting || this.emulatorClosed) return
    if (this.emulatorBuffer.length === 0) {
      const done = this.emulatorWriteDone
      this.emulatorWriteDone = undefined
      done?.()
      this.releaseSettledActive()
      return
    }
    const data = this.emulatorBuffer
    this.emulatorBuffer = ''
    this.emulatorWriting = true
    try {
      this.emulator.write(data, () => {
        this.emulatorWriting = false
        this.pumpEmulator()
      })
    } catch (error: unknown) {
      this.emulatorWriting = false
      this.emulatorBuffer = ''
      const done = this.emulatorWriteDone
      this.emulatorWriteDone = undefined
      done?.()
      this.releaseSettledActive()
      if (!this.closing) this.onTransportFailure(error)
    }
  }

  private finishResponseWrite(): void {
    this.pendingResponseWrites -= 1
    this.releaseSettledActive()
  }

  private releaseSettledActive(): void {
    const operation = this.active
    if (operation === undefined || !operation.settled || this.activeWrite !== undefined
      || this.interrupting === operation || this.protocolWorkPending()) return
    this.clearActive()
  }

  private closeEmulator(): void {
    if (this.emulatorClosed) return
    this.emulatorClosed = true
    this.emulatorBuffer = ''
    this.emulatorWriting = false
    const done = this.emulatorWriteDone
    this.emulatorWriteDone = undefined
    done?.()
    this.emulatorData.dispose()
    this.emulator.dispose()
  }

  private settleActive(waitReason: TerminalWaitReason, retainOwnership = false): void {
    const operation = this.active
    if (operation === undefined) return
    const scrollbackTruncated = this.scrollback.truncated
    if (retainOwnership) {
      this.stopPolling()
      this.activeAbort?.()
      this.activeAbort = undefined
    } else {
      this.clearActive()
    }
    operation.settle(waitReason, this.statusValue, scrollbackTruncated)
    if (waitReason !== 'session_exit') {
      // The settled send is the provider's adoption point for members its
      // command spawned; after the shell exits, a teardown scan can no longer
      // see members that already left the process tree. Session exit needs no
      // adoption — the shell is gone and teardown re-scans.
      void this.terminal.noteSendSettled().catch((_adoptionScanFailed: unknown) => {
        // The send is already settled; teardown re-scans and reports survivors.
      })
    }
  }

  private stopPolling(): void {
    this.stopReadinessPolling()
    if (this.activeDeadlineTimer !== undefined) clearTimeout(this.activeDeadlineTimer)
    this.activeDeadlineTimer = undefined
  }

  private stopReadinessPolling(): void {
    if (this.activeTimer !== undefined) clearTimeout(this.activeTimer)
    this.activeTimer = undefined
    this.pollingReady = undefined
  }

  private clearActive(): void {
    const operation = this.active
    this.stopPolling()
    this.activeAbort?.()
    this.activeAbort = undefined
    if (this.interrupting === operation) this.interrupting = undefined
    this.pollingReady = undefined
    this.active = undefined
  }

  private failActive(error: unknown): void {
    const operation = this.active
    if (operation === undefined) return
    this.clearActive()
    operation.fail(error)
  }

  private interrupt(operation: LocalSendOperation): void {
    if (this.active !== operation) return
    this.interrupting = operation
    this.stopReadinessPolling()
    void this.interruptOnce(operation)
  }

  private async interruptOnce(operation: LocalSendOperation): Promise<void> {
    try {
      const activeWrite = this.activeWrite
      if (activeWrite !== undefined && !await activeWrite) return
      await this.terminal.signalForeground('SIGINT')
    } catch (error: unknown) {
      if (this.active === operation && !this.closing) this.onTransportFailure(error)
      return
    } finally {
      if (this.interrupting === operation) this.interrupting = undefined
    }
    if (this.active === operation && operation.settled) {
      this.releaseSettledActive()
    } else if (this.active === operation && !this.closing) {
      this.pollingReady = operation
      this.schedulePoll(operation, 0)
    }
  }

  private async closeOnce(reason: string): Promise<void> {
    // Stop readiness polling but retain the active operation: teardown settles
    // it as session_exit below, so an in-flight send is never mis-settled as
    // stdin_read/inferred_idle/timeout during the grace period.
    this.stopPolling()
    this.closeEmulator()
    try {
      await this.terminal.terminate()
    } catch (error: unknown) {
      throw new Error(`PTY cleanup failed (${reason})`, { cause: error })
    }
    // Quiescence is the active send's terminal outcome.
    this.settleActive('session_exit')
    await this.completion
    this.terminal.output.off('data', this.onTerminalData)
    this.terminal.output.off('end', this.onTerminalEnd)
    this.terminal.output.off('error', this.onTerminalError)
    if (this.transportFailure !== undefined) throw this.transportFailure
  }
}
