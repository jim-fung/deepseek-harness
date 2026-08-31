/** Current-surface projection and byte-bounded rendering. */

import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import type { SessionSurfaceSnapshot } from '@deepseek-ai/dsh-session-query'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { stringifyTagSafeJson } from './serialization.ts'
import type { ReferencedConversationItem } from './types.ts'

interface ProjectedItem extends ReferencedConversationItem {
  checkpoint: boolean
  originalText: string
  omittedBytes: number
  /** Serialized JSON-object bytes this entry contributes inside `conversation`. */
  entryBytes: number
}

/** Snapshot data serialized inside the untrusted prompt. */
export interface ReferencedSessionData {
  sessionId: string
  label: string
  cwd: string | null
  capturedThroughSeq: number | null
  conversation: ReferencedConversationItem[]
}

/** Retention facts stored beside the durable context. */
export interface ReferenceRetentionStats {
  compacted: boolean
  originalMessages: number
  retainedMessages: number
  omittedMessages: number
  omittedBytes: number
  truncated: boolean
}

/** Project current user/assistant conversation while excluding tools, reasoning, and injected context. */
function projectSessionConversation(snapshot: SessionSurfaceSnapshot): ProjectedItem[] {
  const conversation: ProjectedItem[] = []
  for (const event of snapshot.events) {
    switch (event.type) {
      case 'user/message': {
        const checkpoint = isCompactCheckpointSource(event.data.source)
        if (!checkpoint && event.data.source.kind !== 'user') break
        const text = textContent(event.data.content)
        if (text !== '') conversation.push(entry('user', text, checkpoint))
        break
      }
      case 'assistant/message': {
        const text = textContent(event.data.message.content)
        if (text !== '') conversation.push(entry('assistant', text, false))
        break
      }
      case 'tool/result':
        break
      /* v8 ignore next 2 -- SurfaceEventType is closed and every variant is handled above. */
      default:
        assertNever(event, 'session-reference surface event')
    }
  }
  return conversation
}

/** One projected entry with its serialized byte cost computed once. */
function entry(role: 'user' | 'assistant', text: string, checkpoint: boolean): ProjectedItem {
  return {
    role,
    text,
    checkpoint,
    originalText: text,
    omittedBytes: 0,
    entryBytes: conversationItemBytes(role, text),
  }
}

/**
 * Serialized UTF-8 bytes of one conversation entry inside the rendered array.
 * @param role - the entry's serialized `role` value.
 * @param text - the entry's serialized `text` value.
 * @returns the byte length of this entry's tag-safe JSON object serialization.
 */
function conversationItemBytes(role: 'user' | 'assistant', text: string): number {
  return Buffer.byteLength(stringifyTagSafeJson({ role, text }), 'utf8')
}

/**
 * Fit one projected snapshot into an exact rendered JSON-object byte cap.
 *
 * Each conversation entry serializes independently, and the tag-safe `<`
 * replacement is character-local, so the rendered size is exactly the
 * empty-conversation envelope plus one comma and one entry payload per
 * retained message. Entry costs are therefore measured once and the budget is
 * applied arithmetically; the result is serialized once at the end to prove
 * the cap instead of re-serializing the whole conversation per dropped message.
 * @param snapshot - current-surface source observation.
 * @param label - host-provided display label serialized with the source.
 * @param maxBytes - maximum UTF-8 bytes for the serialized data object.
 * @returns retained data and stats, or `undefined` when fixed data cannot fit.
 */
export function retainReferencedSession(
  snapshot: SessionSurfaceSnapshot,
  label: string,
  maxBytes: number,
): { data: ReferencedSessionData; stats: ReferenceRetentionStats } | undefined {
  const original = projectSessionConversation(snapshot)
  const newestIndex = original.length - 1
  const fixed: ReferencedSessionData = {
    sessionId: snapshot.session.id,
    label,
    cwd: snapshot.session.cwd ?? null,
    capturedThroughSeq: snapshot.capturedThroughSeq,
    conversation: [],
  }
  const fixedBytes = Buffer.byteLength(stringifyTagSafeJson(fixed), 'utf8')
  const data = (retained: readonly ProjectedItem[]): ReferencedSessionData => ({
    ...fixed,
    conversation: retained.map(({ role, text }) => ({ role, text })),
  })

  // Drop-from-front pass: while the running total over every undropped message
  // exceeds the budget, drop the earliest droppable message. A message is
  // droppable when it is neither a checkpoint nor the newest message; each drop
  // removes its payload bytes and one comma.
  const retained: ProjectedItem[] = []
  let omittedMessages = 0
  let droppedOmittedBytes = 0
  let totalBytes = fixedBytes + Math.max(0, original.length - 1)
    + original.reduce((sum, item) => sum + item.entryBytes, 0)
  for (const [index, item] of original.entries()) {
    if (totalBytes > maxBytes && !item.checkpoint && index !== newestIndex) {
      totalBytes -= item.entryBytes + 1
      omittedMessages += 1
      droppedOmittedBytes += Buffer.byteLength(item.originalText, 'utf8')
      continue
    }
    retained.push(item)
  }

  // Longest-message truncation pass for whatever checkpoints and newest
  // messages the drop pass had to keep.
  while (totalBytes > maxBytes) {
    let longestIndex = -1
    let longestBytes = 0
    for (const [index, item] of retained.entries()) {
      const bytes = Buffer.byteLength(item.text, 'utf8')
      if (bytes > longestBytes) {
        longestBytes = bytes
        longestIndex = index
      }
    }
    if (longestIndex < 0 || longestBytes === 0) return undefined
    const overflow = totalBytes - maxBytes
    const target = Math.max(0, longestBytes - overflow)
    const item = retained[longestIndex]
    /* v8 ignore next 3 -- longestIndex was selected from this exact array's entries. */
    if (item === undefined) {
      throw new Error('session-reference retention selected a missing longest message')
    }
    const shortened = truncateWithNotice(item.originalText, target)
    /* v8 ignore next -- strictly lowering the byte target must change a complete-string retention result. */
    if (shortened.text === retained[longestIndex]?.text) return undefined
    const shortenedBytes = conversationItemBytes(item.role, shortened.text)
    totalBytes += shortenedBytes - item.entryBytes
    retained[longestIndex] = { ...item, text: shortened.text, omittedBytes: shortened.omittedBytes, entryBytes: shortenedBytes }
  }

  const rendered = data(retained)
  // Entry costs are exact for compositional JSON serialization, so the tracked
  // total equals the serialized size and this cannot overshoot; one drop-and-
  // re-verify round per remaining message bounds the guard without ever
  // re-serializing per selection step.
  /* v8 ignore start -- unreachable: the tracked total equals the serialized byte length. */
  while (Buffer.byteLength(stringifyTagSafeJson(rendered), 'utf8') > maxBytes) {
    const dropIndex = retained.findIndex((item, index) => !item.checkpoint && index !== retained.length - 1)
    if (dropIndex < 0) return undefined
    const removed = retained.splice(dropIndex, 1)[0]
    if (removed === undefined) {
      throw new Error('session-reference retention selected a missing message')
    }
    omittedMessages += 1
    droppedOmittedBytes += Buffer.byteLength(removed.originalText, 'utf8')
    rendered.conversation = retained.map(({ role, text }) => ({ role, text }))
  }
  /* v8 ignore stop */

  const compacted = original.some(item => item.checkpoint)
  const retainedOmittedBytes = retained.reduce((sum, item) => sum + item.omittedBytes, 0)
  const omittedBytes = retainedOmittedBytes + droppedOmittedBytes
  return {
    data: rendered,
    stats: {
      compacted,
      originalMessages: original.length,
      retainedMessages: retained.length,
      omittedMessages,
      omittedBytes,
      truncated: omittedMessages > 0 || omittedBytes > 0,
    },
  }
}

function textContent(content: readonly { type: string; text?: string }[]): string {
  return content.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n')
}

function truncateWithNotice(text: string, maxOutputBytes: number): { text: string; omittedBytes: number } {
  /* v8 ignore next -- callers invoke this only with a target smaller than the selected original text. */
  if (Buffer.byteLength(text, 'utf8') <= maxOutputBytes) return { text, omittedBytes: 0 }
  let low = 0
  let high = maxOutputBytes
  let best = { text: '', omittedBytes: Buffer.byteLength(text, 'utf8') }
  while (low <= high) {
    const retainedBytes = Math.floor((low + high) / 2)
    const headBytes = Math.ceil(retainedBytes / 2)
    const tailBytes = Math.floor(retainedBytes / 2)
    const retainer = new TextRetainer({ kind: 'headTail', headBytes, tailBytes })
    retainer.push(text)
    const result = retainer.finish()
    // The complete source string was pushed before `finish()`, so omission is exact.
    /* v8 ignore next 3 -- complete-string TextRetainer input cannot report a lower bound. */
    if (result.omittedBytes.kind !== 'exact') {
      throw new Error('session-reference retention did not report exact omitted bytes')
    }
    const omitted = result.omittedBytes.count
    const candidate = `${result.text}\n[… omitted ${omitted} UTF-8 bytes …]`
    if (Buffer.byteLength(candidate, 'utf8') <= maxOutputBytes) {
      best = { text: candidate, omittedBytes: omitted }
      low = retainedBytes + 1
    } else {
      high = retainedBytes - 1
    }
  }
  return best
}
