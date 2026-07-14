import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import {
  captureDescendantSnapshot,
  collectDescendantRows,
  createProcessTableSnapshotReader,
  DESCENDANT_KILL_GRACE_MS,
  DESCENDANT_SNAPSHOT_TIMEOUT_MS,
  killWithDescendantSweep,
  parseProcessTable,
  terminateDescendantSnapshot,
  type ProcessTableRow
} from './pty-descendant-termination'

const CAPTURED_AT_MS = Date.parse('Tue Jul 14 12:00:00 2026')

beforeEach(() => {
  execFileMock.mockReset()
  execFileMock.mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string) => void
    callback(null, '10 1 10 Mon Jul 13 12:54:47 2026')
  })
})

function row(
  pid: number,
  ppid: number,
  pgid: number,
  startedAt = 'Mon Jul 13 12:54:47 2026'
): ProcessTableRow {
  return { pid, ppid, pgid, startedAt }
}

function snapshot(
  descendants: ProcessTableRow[],
  rootPgid: number | null = 10,
  capturedAtMs = CAPTURED_AT_MS
) {
  return { rootPgid, descendants, capturedAtMs }
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
    const snapshot = collectDescendantRows(10, table, CAPTURED_AT_MS)
    expect(snapshot.rootPgid).toBe(10)
    expect(snapshot.descendants.map((r) => r.pid)).toEqual([20, 30, 31])
    expect(snapshot.capturedAtMs).toBe(CAPTURED_AT_MS)
  })

  it('returns a null root pgid when the root row is already gone', () => {
    const snapshot = collectDescendantRows(10, [row(20, 10, 20)], CAPTURED_AT_MS)
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
    const result = await captureDescendantSnapshot(10, {
      readTable,
      platform: 'darwin',
      now: () => CAPTURED_AT_MS
    })
    expect(result).toEqual(snapshot([row(20, 10, 20)]))
    expect(vi.getTimerCount()).toBe(0)
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

  it('degrades to null when a custom process-table reader throws synchronously', async () => {
    const readTable = vi.fn(() => {
      throw new Error('reader exploded')
    })
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

  it('gives the production ps subprocess a hard SIGKILL timeout', async () => {
    const result = await captureDescendantSnapshot(10, {
      platform: 'darwin',
      timeoutMs: 321,
      now: () => CAPTURED_AT_MS
    })
    expect(result).not.toBeNull()
    expect(execFileMock).toHaveBeenCalledWith(
      'ps',
      ['-axo', 'pid=,ppid=,pgid=,lstart='],
      expect.objectContaining({ timeout: 321, killSignal: 'SIGKILL' }),
      expect.any(Function)
    )
  })
})

describe('terminateDescendantSnapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('SIGTERMs every snapshotted descendant immediately', () => {
    const sendSignal = vi.fn()
    terminateDescendantSnapshot(snapshot([row(20, 10, 20), row(30, 20, 30)]), {
      sendSignal,
      readTable: vi.fn().mockResolvedValue([])
    })
    expect(sendSignal.mock.calls).toEqual([
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
    terminateDescendantSnapshot(snapshot([exited, survivor, recycled]), { sendSignal, readTable })
    sendSignal.mockClear()
    await vi.advanceTimersByTimeAsync(DESCENDANT_KILL_GRACE_MS)
    expect(sendSignal.mock.calls).toEqual([[30, 'SIGKILL']])
  })

  it('never escalates when the identity re-read fails', async () => {
    const sendSignal = vi.fn()
    const readTable = vi.fn().mockRejectedValue(new Error('ps exploded'))
    terminateDescendantSnapshot(snapshot([row(20, 10, 20)]), { sendSignal, readTable })
    sendSignal.mockClear()
    await vi.advanceTimersByTimeAsync(DESCENDANT_KILL_GRACE_MS)
    expect(sendSignal).not.toHaveBeenCalled()
  })

  it('schedules no escalation for an empty descendant set', () => {
    const sendSignal = vi.fn()
    const readTable = vi.fn()
    terminateDescendantSnapshot(snapshot([]), { sendSignal, readTable })
    expect(vi.getTimerCount()).toBe(0)
    expect(sendSignal).not.toHaveBeenCalled()
  })

  it('does not SIGKILL when second-resolution start identity is ambiguous', async () => {
    const sameSecond = row(20, 10, 20, 'Tue Jul 14 12:00:00 2026')
    const sendSignal = vi.fn()
    terminateDescendantSnapshot(snapshot([sameSecond]), {
      sendSignal,
      readTable: vi.fn().mockResolvedValue([sameSecond])
    })
    sendSignal.mockClear()
    await vi.advanceTimersByTimeAsync(DESCENDANT_KILL_GRACE_MS)
    expect(sendSignal).not.toHaveBeenCalled()
  })

  it('bounds a wedged escalation read and releases its deadline timer', async () => {
    const sendSignal = vi.fn()
    terminateDescendantSnapshot(snapshot([row(20, 10, 20)]), {
      sendSignal,
      readTable: vi.fn().mockReturnValue(new Promise<ProcessTableRow[]>(() => {}))
    })
    sendSignal.mockClear()
    await vi.advanceTimersByTimeAsync(DESCENDANT_KILL_GRACE_MS + DESCENDANT_SNAPSHOT_TIMEOUT_MS)
    expect(sendSignal).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('createProcessTableSnapshotReader', () => {
  it('coalesces concurrent and short sequential teardown scans', async () => {
    let now = 1_000
    const readFresh = vi.fn().mockResolvedValue([row(10, 1, 10)])
    const readTable = createProcessTableSnapshotReader(readFresh, {
      reuseMs: 50,
      now: () => now
    })

    await Promise.all(Array.from({ length: 20 }, () => readTable(1_000)))
    await readTable(1_000)
    expect(readFresh).toHaveBeenCalledOnce()

    now += 51
    await readTable(1_000)
    expect(readFresh).toHaveBeenCalledTimes(2)
  })

  it('does not cache failed process-table reads', async () => {
    const readFresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('ps failed'))
      .mockResolvedValueOnce([])
    const readTable = createProcessTableSnapshotReader(readFresh)
    await expect(readTable()).rejects.toThrow('ps failed')
    await expect(readTable()).resolves.toEqual([])
    expect(readFresh).toHaveBeenCalledTimes(2)
  })
})

describe('killWithDescendantSweep', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('signals descendants after snapshot resolution, then kills the root', async () => {
    const events: string[] = []
    const sendSignal = vi.fn(() => events.push('descendant-term'))
    const readTable = vi.fn().mockResolvedValue([row(10, 1, 10), row(20, 10, 20)])
    const killRoot = vi.fn(() => events.push('root-kill'))
    const pending = killWithDescendantSweep(10, killRoot, {
      readTable,
      sendSignal,
      platform: 'darwin',
      now: () => CAPTURED_AT_MS
    })
    expect(killRoot).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    await pending
    expect(killRoot).toHaveBeenCalledOnce()
    expect(sendSignal.mock.calls).toEqual([[20, 'SIGTERM']])
    expect(events).toEqual(['descendant-term', 'root-kill'])
  })

  it('still kills the root when the snapshot is unavailable', async () => {
    const sendSignal = vi.fn()
    const readTable = vi.fn().mockRejectedValue(new Error('ps exploded'))
    const killRoot = vi.fn()
    const pending = killWithDescendantSweep(10, killRoot, {
      readTable,
      sendSignal,
      platform: 'darwin'
    })
    await vi.advanceTimersByTimeAsync(0)
    await pending
    expect(killRoot).toHaveBeenCalledOnce()
    expect(sendSignal).not.toHaveBeenCalled()
  })
})
