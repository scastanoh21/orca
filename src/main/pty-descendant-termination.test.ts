import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureDescendantSnapshot,
  collectDescendantRows,
  DESCENDANT_KILL_GRACE_MS,
  killWithDescendantSweep,
  parseProcessTable,
  terminateDescendantSnapshot,
  type ProcessTableRow
} from './pty-descendant-termination'

function row(
  pid: number,
  ppid: number,
  pgid: number,
  startedAt = `Mon Jul 13 12:54:47 2026 #${pid}`
): ProcessTableRow {
  return { pid, ppid, pgid, startedAt }
}

describe('parseProcessTable', () => {
  it('parses pid/ppid/pgid and keeps the space-containing lstart verbatim', () => {
    const rows = parseProcessTable(
      [
        '  101   1  101 Mon Jul 13 12:54:47 2026',
        '42017 101 42017 Tue Jul 14 01:02:03 2026  ',
        '',
        'not a process line'
      ].join('\n')
    )
    expect(rows).toEqual([
      { pid: 101, ppid: 1, pgid: 101, startedAt: 'Mon Jul 13 12:54:47 2026' },
      { pid: 42017, ppid: 101, pgid: 42017, startedAt: 'Tue Jul 14 01:02:03 2026' }
    ])
  })
})

describe('collectDescendantRows', () => {
  it('walks multi-level descendants including detached-pgid grandchildren', () => {
    // shell(10) -> agent(20, own job pgid) -> detached tool shell(30, own
    // session-style pgid) -> git(31). 99 is unrelated.
    const table = [
      row(10, 1, 10),
      row(20, 10, 20),
      row(30, 20, 30),
      row(31, 30, 30),
      row(99, 1, 99)
    ]
    const snapshot = collectDescendantRows(10, table)
    expect(snapshot.rootPgid).toBe(10)
    expect(snapshot.descendants.map((r) => r.pid)).toEqual([20, 30, 31])
  })

  it('returns a null root pgid when the root row is already gone', () => {
    const snapshot = collectDescendantRows(10, [row(20, 10, 20)])
    expect(snapshot.rootPgid).toBeNull()
    expect(snapshot.descendants.map((r) => r.pid)).toEqual([20])
  })
})

describe('captureDescendantSnapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves the descendant tree on POSIX', async () => {
    const readTable = vi.fn().mockResolvedValue([row(10, 1, 10), row(20, 10, 20)])
    const snapshot = await captureDescendantSnapshot(10, { readTable, platform: 'darwin' })
    expect(snapshot).toEqual({ rootPgid: 10, descendants: [row(20, 10, 20)] })
  })

  it('is a null no-op on Windows', async () => {
    const readTable = vi.fn()
    expect(await captureDescendantSnapshot(10, { readTable, platform: 'win32' })).toBeNull()
    expect(readTable).not.toHaveBeenCalled()
  })

  it('degrades to null when ps fails', async () => {
    const readTable = vi.fn().mockRejectedValue(new Error('ps exploded'))
    expect(await captureDescendantSnapshot(10, { readTable, platform: 'linux' })).toBeNull()
  })

  it('degrades to null when ps hangs past the timeout instead of blocking teardown', async () => {
    const readTable = vi.fn().mockReturnValue(new Promise<ProcessTableRow[]>(() => {}))
    const pending = captureDescendantSnapshot(10, {
      readTable,
      platform: 'darwin',
      timeoutMs: 1_000
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await pending).toBeNull()
  })
})

describe('terminateDescendantSnapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('SIGTERMs the root group and every descendant immediately', () => {
    const sendSignal = vi.fn()
    terminateDescendantSnapshot(
      { rootPgid: 10, descendants: [row(20, 10, 20), row(30, 20, 30)] },
      { sendSignal, readTable: vi.fn().mockResolvedValue([]) }
    )
    expect(sendSignal.mock.calls).toEqual([
      [-10, 'SIGTERM'],
      [20, 'SIGTERM'],
      [30, 'SIGTERM']
    ])
  })

  it('SIGKILLs only identity-matched survivors after the grace window', async () => {
    const survivor = row(30, 20, 30)
    const exited = row(20, 10, 20)
    const recycled = row(40, 30, 40)
    const sendSignal = vi.fn()
    // At escalation time: 30 survives unchanged, 20 is gone, 40's pid now
    // belongs to a different (recycled) process with a different start time.
    const readTable = vi
      .fn()
      .mockResolvedValue([survivor, { ...recycled, startedAt: 'Tue Jul 14 09:00:00 2026' }])
    terminateDescendantSnapshot(
      { rootPgid: 10, descendants: [exited, survivor, recycled] },
      { sendSignal, readTable }
    )
    sendSignal.mockClear()
    await vi.advanceTimersByTimeAsync(DESCENDANT_KILL_GRACE_MS)
    expect(sendSignal.mock.calls).toEqual([[30, 'SIGKILL']])
  })

  it('never escalates when the identity re-read fails', async () => {
    const sendSignal = vi.fn()
    const readTable = vi.fn().mockRejectedValue(new Error('ps exploded'))
    terminateDescendantSnapshot(
      { rootPgid: 10, descendants: [row(20, 10, 20)] },
      { sendSignal, readTable }
    )
    sendSignal.mockClear()
    await vi.advanceTimersByTimeAsync(DESCENDANT_KILL_GRACE_MS)
    expect(sendSignal).not.toHaveBeenCalled()
  })

  it('schedules no escalation for an empty descendant set', () => {
    const sendSignal = vi.fn()
    const readTable = vi.fn()
    terminateDescendantSnapshot({ rootPgid: 10, descendants: [] }, { sendSignal, readTable })
    expect(vi.getTimerCount()).toBe(0)
    expect(sendSignal.mock.calls).toEqual([[-10, 'SIGTERM']])
  })
})

describe('killWithDescendantSweep', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('kills the root only after the snapshot resolves, then sweeps it', async () => {
    const sendSignal = vi.fn()
    const readTable = vi.fn().mockResolvedValue([row(10, 1, 10), row(20, 10, 20)])
    const killRoot = vi.fn()
    killWithDescendantSweep(10, killRoot, { readTable, sendSignal, platform: 'darwin' })
    expect(killRoot).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(killRoot).toHaveBeenCalledOnce()
    expect(sendSignal.mock.calls).toEqual([
      [-10, 'SIGTERM'],
      [20, 'SIGTERM']
    ])
  })

  it('still kills the root when the snapshot is unavailable', async () => {
    const sendSignal = vi.fn()
    const readTable = vi.fn().mockRejectedValue(new Error('ps exploded'))
    const killRoot = vi.fn()
    killWithDescendantSweep(10, killRoot, { readTable, sendSignal, platform: 'darwin' })
    await vi.advanceTimersByTimeAsync(0)
    expect(killRoot).toHaveBeenCalledOnce()
    expect(sendSignal).not.toHaveBeenCalled()
  })
})
