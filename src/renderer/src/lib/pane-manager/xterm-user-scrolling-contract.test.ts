/**
 * Contract test for xterm's native user-scrolling ownership (vendored
 * 6.1.0-beta.287; @xterm/headless shares BufferService with @xterm/xterm).
 *
 * Orca's live PTY write path performs NO scroll-intent enforcement — it
 * relies on xterm core keeping a scrolled-up viewport stable and following
 * output at the bottom (BufferService.isUserScrolling, consumed atomically
 * inside scroll()). App-side enforcement is scoped to structural operations
 * (snapshot replay, remount, fit reflow) in terminal-scroll-intent.ts.
 *
 * If an xterm upgrade breaks any assertion here, the live write path loses
 * its follow/pin semantics silently — fix the write path before bumping.
 */
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'

type TerminalWithBufferService = Terminal & {
  _core?: { _bufferService?: { isUserScrolling?: boolean } }
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

async function writeLines(term: Terminal, count: number, label: string): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await write(term, `${label}${i}\r\n`)
  }
}

describe('xterm native user-scrolling contract (vendored 6.1.0-beta.287)', () => {
  it('keeps a scrolled-up viewport stable while output is written', async () => {
    const term = new Terminal({ rows: 10, cols: 40, scrollback: 1000, allowProposedApi: true })
    await writeLines(term, 30, 'line')
    const buffer = term.buffer.active
    expect(buffer.viewportY).toBe(buffer.baseY)

    term.scrollLines(-5)
    const pinnedY = buffer.viewportY
    expect(pinnedY).toBe(buffer.baseY - 5)

    await writeLines(term, 10, 'more')
    expect(buffer.viewportY).toBe(pinnedY)
    expect(buffer.baseY).toBe(pinnedY + 15)
  })

  it('follows output at the bottom and re-follows after scrolling back down', async () => {
    const term = new Terminal({ rows: 10, cols: 40, scrollback: 1000, allowProposedApi: true })
    await writeLines(term, 30, 'line')
    const buffer = term.buffer.active

    await writeLines(term, 5, 'tail')
    expect(buffer.viewportY).toBe(buffer.baseY)

    term.scrollLines(-5)
    term.scrollToBottom()
    await writeLines(term, 5, 'after')
    expect(buffer.viewportY).toBe(buffer.baseY)
  })

  it('walks a pinned viewport down content-stably when scrollback trims', async () => {
    const term = new Terminal({ rows: 5, cols: 20, scrollback: 20, allowProposedApi: true })
    await writeLines(term, 30, 'x')
    const buffer = term.buffer.active
    term.scrollLines(-10)
    const pinnedY = buffer.viewportY
    const fullBaseY = buffer.baseY

    await writeLines(term, 10, 'trim')
    // Buffer is at capacity: baseY stays put while each trimmed line shifts
    // the pinned viewport up by one so the visible content does not move.
    expect(buffer.baseY).toBe(fullBaseY)
    expect(buffer.viewportY).toBe(Math.max(0, pinnedY - 10))
  })

  it('exposes the isUserScrolling flag the structural restore paths depend on', async () => {
    const term = new Terminal({
      rows: 10,
      cols: 40,
      scrollback: 1000,
      allowProposedApi: true
    }) as TerminalWithBufferService
    await writeLines(term, 30, 'line')
    const bufferService = term._core?._bufferService
    expect(typeof bufferService?.isUserScrolling).toBe('boolean')

    // scrollLines/scrollToBottom self-manage the flag from real movement —
    // Orca's programmatic scrollToLine/scrollToBottom restores inherit this.
    expect(bufferService?.isUserScrolling).toBe(false)
    term.scrollLines(-5)
    expect(bufferService?.isUserScrolling).toBe(true)
    term.scrollToBottom()
    expect(bufferService?.isUserScrolling).toBe(false)
  })
})
