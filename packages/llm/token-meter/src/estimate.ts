/**
 * Script-aware fixed heuristic token pricing shared by the meter service and
 * the pure context-breakdown projection, so both surfaces price identical
 * content to identical numbers. All priced text walks one density function:
 * {@link estimateTextTokens}.
 *
 * @module @deepseek-ai/dsh-token-meter/estimate
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { EpochHeader } from '@deepseek-ai/dsh-session'

/**
 * Calibration constant of the fixed estimator: characters per token outside
 * the CJK ranges, fit against tokenizer output on Latin prose and JSON schema
 * text. Calibration only — the estimator exposes no configuration.
 */
const CHARS_PER_TOKEN = 4

/**
 * Calibration constant of the fixed estimator: code points per token inside
 * the CJK ranges, where ideographs, kana, Hangul syllables, and fullwidth
 * forms each tokenize to roughly one full token, so the four-characters-per-
 * token density underprices them about fourfold and fires compaction too
 * late on CJK-heavy sessions.
 */
const CJK_CODE_POINTS_PER_TOKEN = 1

/**
 * Inclusive Unicode ranges priced at the CJK density: CJK punctuation
 * (U+3000–U+303F), Hiragana and Katakana (U+3040–U+30FF), CJK Unified
 * Ideographs (U+4E00–U+9FFF), Hangul syllables (U+AC00–U+D7AF), CJK
 * Compatibility Ideographs (U+F900–U+FAFF), and fullwidth forms
 * (U+FF00–U+FFEF). Every range is on the BMP, so each covered code point is
 * exactly one UTF-16 unit.
 */
const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x3000, 0x303f],
  [0x3040, 0x30ff],
  [0x4e00, 0x9fff],
  [0xac00, 0xd7af],
  [0xf900, 0xfaff],
  [0xff00, 0xffef],
]

/** Whether one UTF-16 unit's code point falls inside a CJK-density range. */
function isCjkUnit(unit: number): boolean {
  for (const [start, end] of CJK_RANGES) {
    if (unit >= start && unit <= end) return true
  }
  return false
}

/**
 * Price text under the one shared density walk: characters inside the CJK
 * ranges price at {@link CJK_CODE_POINTS_PER_TOKEN} and every other character
 * at {@link CHARS_PER_TOKEN}. Text outside the CJK ranges therefore prices
 * exactly as `Math.ceil(text.length / CHARS_PER_TOKEN)` always has, so ASCII
 * prose, JSON schema strings, and structural framing keep their historical
 * figures while CJK text stops underpricing.
 * @param text - text to price without mutation.
 * @returns heuristic tokens for the complete string.
 */
function estimateTextTokens(text: string): number {
  let cjkUnits = 0
  let otherUnits = 0
  for (let index = 0; index < text.length; index += 1) {
    if (isCjkUnit(text.charCodeAt(index))) cjkUnits += 1
    else otherUnits += 1
  }
  return Math.ceil(cjkUnits / CJK_CODE_POINTS_PER_TOKEN + otherUnits / CHARS_PER_TOKEN)
}

/** Per-block structural overhead for JSON framing and type tags. */
const BLOCK_OVERHEAD = 4

/** Role-field framing overhead added to every priced message. */
export const ROLE_OVERHEAD = 4

/**
 * Structural JSON price of one block outside the typed pricing arms: the
 * fixed heuristic for merge-extended blocks and for image references, whose
 * request price is route-owned rather than fixed.
 * @param block - block to price without mutation.
 * @returns heuristic tokens for the block's JSON structure.
 */
export function estimateStructuralBlock(block: ContentBlock): number {
  return BLOCK_OVERHEAD + estimateTextTokens(JSON.stringify(block))
}

/**
 * Price content blocks recursively under the fixed heuristic.
 * @param blocks - content blocks to price without mutation.
 * @returns heuristic tokens including per-block structural overhead.
 */
export function estimateContent(blocks: readonly ContentBlock[]): number {
  let tokens = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += estimateTextTokens(block.text) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += estimateTextTokens(block.name)
          + estimateTextTokens(block.arguments)
          + BLOCK_OVERHEAD
        break
      case 'tool-result':
        tokens += estimateContent(block.content) + BLOCK_OVERHEAD
        break
      default:
        // ContentBlockMap is merge-extensible; unknown blocks (and image
        // references, whose request price is route-owned) retain a
        // conservative structural JSON price under the fixed heuristic.
        tokens += estimateStructuralBlock(block)
    }
  }
  return tokens
}

/**
 * Heuristically price one model-visible message.
 * @param message - message to price without mutation.
 * @returns content and role-framing tokens under the fixed heuristic.
 */
export function estimateMessage(message: Message): number {
  return estimateContent(message.content) + ROLE_OVERHEAD
}

/**
 * Price the system-prompt part of a canonical request envelope.
 * @param header - canonical envelope, or undefined before any request.
 * @returns heuristic system-prompt tokens; 0 when absent.
 */
export function estimateSystemTokens(header: EpochHeader | undefined): number {
  if (header?.system === undefined) return 0
  return estimateTextTokens(header.system) + ROLE_OVERHEAD
}

/**
 * Price the tool-schema part of a canonical request envelope.
 * @param header - canonical envelope, or undefined before any request.
 * @returns heuristic tool-schema tokens; 0 when absent or empty.
 */
export function estimateToolsTokens(header: EpochHeader | undefined): number {
  if (header?.tools === undefined || header.tools.length === 0) return 0
  return estimateTextTokens(JSON.stringify(header.tools)) + BLOCK_OVERHEAD
}

/**
 * Price the complete non-surface request envelope.
 * @param header - canonical envelope, or undefined before any request.
 * @returns heuristic system plus tool tokens.
 */
export function estimateHeader(header: EpochHeader | undefined): number {
  return estimateSystemTokens(header) + estimateToolsTokens(header)
}
