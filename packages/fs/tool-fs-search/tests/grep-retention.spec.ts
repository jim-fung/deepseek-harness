/**
 * Focus test for the grep retention memo: one capped `grep` result computes
 * `retainGrepMatches` exactly once, although three consumers project it — the
 * registry's twin `output.render` / `output.presentationMeta` calls over the
 * same frozen value and the `tools/post-execute` listener's content
 * re-projection over `result.value`. The count is observed by partially mocking
 * `search-core` around `retainGrepMatches` (everything else stays real) because
 * the memo and its WeakMap never leave `grep.ts`; the text and `meta`
 * assertions pin the projected output as byte-identical to the single-pass
 * formats the other suites expect.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutputRead, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import { retainGrepMatches } from '../src/search-core.ts'

vi.mock('../src/search-core.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/search-core.ts')>()
  return { ...actual, retainGrepMatches: vi.fn(actual.retainGrepMatches) }
})

/** One rg --json match record line. */
function matchLine(path: string, lineNumber: number, lineText: string): string {
  return JSON.stringify({ type: 'match', data: { path: { text: path }, lines: { text: lineText }, line_number: lineNumber, absolute_offset: 0, submatches: [] } })
}

/** A fixed collect stream: complete text, never lossy, never spilled. */
class FixedReader implements SubprocessOutputReader {
  constructor(private readonly read: SubprocessOutputRead) {}
  readFrom(_fromByte: number): SubprocessOutputRead {
    return this.read
  }
}

/** A settled successful-run handle over the scripted stdout (exit 0, no signal). */
class FixedHandle implements SubprocessHandle {
  readonly pid = 4242
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly collected: { stdout: FixedReader; stderr: FixedReader }
  readonly done = Promise.resolve({ exitCode: 0, signal: null } as const)
  constructor(stdout: string) {
    this.collected = {
      stdout: new FixedReader({ text: stdout, nextOffset: 0, lossy: false }),
      stderr: new FixedReader({ text: '', nextOffset: 0, lossy: false }),
    }
  }
  terminate(): void {}
  waitForExit(_signal?: AbortSignal): Promise<boolean> {
    return Promise.resolve(true)
  }
}

/** A subprocess service whose every spawn settles as the one scripted successful run. */
class FixedSubprocess extends SubprocessRuntime {
  /** The complete `rg --json` stdout every spawn reports; armed before the call under test. */
  scriptedStdout = ''
  override async resolveExecutable(command: string): Promise<string> { return command }
  override spawn(_spec: SubprocessSpawnSpec): SubprocessHandle { return new FixedHandle(this.scriptedStdout) }
  override spawnTerminal(): Promise<never> { throw new Error('grep spawns pipes, never terminals') }
}

const testToolSignal = new AbortController().signal

/** A stand-in agent whose session header carries a stable id and cwd. */
const AGENT = { session: { header: { id: 'session-1', cwd: '/w' } } }

const UNSAVED_FOOTER = '(The complete result could not be saved; narrow pattern, path, or include to see more.)'

describe('grep retention memo', () => {
  it('computes match retention once per result across render, presentationMeta, and the post-execute projection', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(FixedSubprocess)
    await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true, grepMaxMatches: 2 })
    const subprocess = ctx.subprocess as FixedSubprocess

    subprocess.scriptedStdout = [
      matchLine('a.ts', 1, 'one'),
      matchLine('a.ts', 2, 'two'),
      matchLine('b.ts', 3, 'three'),
      '',
    ].join('\n')
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('call-retain-1'),
      name: 'grep',
      arguments: { pattern: 'e' },
      agent: AGENT as never,
    })

    expect(result.isError).toBe(false)
    // Three consumers — render, presentationMeta, and the capped post-execute
    // content projection — shared ONE retention pass over the frozen value.
    expect(vi.mocked(retainGrepMatches)).toHaveBeenCalledTimes(1)
    expect(result.content).toEqual([{ type: 'text', text: `Found 2 of 3 matches\n\na.ts\nLine 1: one\nLine 2: two\n\n${UNSAVED_FOOTER}` }])
    expect(result.meta).toEqual({
      shape: 'matches',
      files: [{ path: 'a.ts', matches: [{ lineNumber: 1, line: 'one' }, { lineNumber: 2, line: 'two' }] }],
      truncated: true,
      total: 3,
    })

    // A different result value computes its own single pass — the memo never
    // shares retention across results.
    subprocess.scriptedStdout = [
      matchLine('c.ts', 1, 'alpha'),
      matchLine('c.ts', 2, 'beta'),
      matchLine('c.ts', 3, 'gamma'),
      '',
    ].join('\n')
    const second = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('call-retain-2'),
      name: 'grep',
      arguments: { pattern: 'a' },
      agent: AGENT as never,
    })

    expect(second.isError).toBe(false)
    expect(vi.mocked(retainGrepMatches)).toHaveBeenCalledTimes(2)
    expect(second.content).toEqual([{ type: 'text', text: `Found 2 of 3 matches\n\nc.ts\nLine 1: alpha\nLine 2: beta\n\n${UNSAVED_FOOTER}` }])
  })
})
