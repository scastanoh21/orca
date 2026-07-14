import { execFile } from 'node:child_process'

export const DESCENDANT_KILL_GRACE_MS = 2_000
export const DESCENDANT_SNAPSHOT_TIMEOUT_MS = 1_000
export const PROCESS_TABLE_REUSE_MS = 50
// Why: a full process table on a busy host can exceed execFile's 1MB default;
// truncation would silently drop descendants from the snapshot.
const PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024

export type ProcessTableRow = {
  pid: number
  ppid: number
  pgid: number
  /** ps lstart text, kept verbatim. Delayed SIGKILL additionally requires an
   * unambiguous capture-second boundary and matching pgid. */
  startedAt: string
}

export type DescendantSnapshot = {
  rootPgid: number | null
  descendants: ProcessTableRow[]
  /** Wall-clock boundary for deciding whether ps's second-resolution lstart
   *  can safely distinguish this process from a later PID reuse. */
  capturedAtMs: number
}

export type ProcessTableReader = (timeoutMs?: number) => Promise<ProcessTableRow[]>
export type SignalSender = (pid: number, signal: NodeJS.Signals) => void

export function parseProcessTable(psOutput: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = []
  for (const line of psOutput.split('\n')) {
    // lstart itself contains spaces ("Mon Jul 13 12:54:47 2026"), so only the
    // three leading numeric columns are positional.
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/)
    if (!match) {
      continue
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      startedAt: match[4]
    })
  }
  return rows
}

function readFreshProcessTable(
  timeoutMs = DESCENDANT_SNAPSHOT_TIMEOUT_MS
): Promise<ProcessTableRow[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,pgid=,lstart='],
      {
        maxBuffer: PS_MAX_BUFFER_BYTES,
        timeout: timeoutMs,
        killSignal: 'SIGKILL'
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(parseProcessTable(stdout))
      }
    )
  })
}

/** Coalesces teardown bursts onto one process-table subprocess and briefly
 * reuses the completed table so sequential worktree cleanup stays O(1) scans. */
export function createProcessTableSnapshotReader(
  readFresh: ProcessTableReader,
  deps: { reuseMs?: number; now?: () => number } = {}
): ProcessTableReader {
  const reuseMs = deps.reuseMs ?? PROCESS_TABLE_REUSE_MS
  const now = deps.now ?? Date.now
  let inFlight: Promise<ProcessTableRow[]> | null = null
  let cached: { rows: ProcessTableRow[]; expiresAt: number } | null = null

  return (timeoutMs) => {
    if (cached && now() <= cached.expiresAt) {
      return Promise.resolve(cached.rows)
    }
    if (inFlight) {
      return inFlight
    }

    const request = readFresh(timeoutMs).then((rows) => {
      cached = { rows, expiresAt: now() + reuseMs }
      return rows
    })
    inFlight = request
    void request.then(
      () => {
        if (inFlight === request) {
          inFlight = null
        }
      },
      () => {
        if (inFlight === request) {
          inFlight = null
        }
      }
    )
    return request
  }
}

const readProcessTable = createProcessTableSnapshotReader(readFreshProcessTable)

function readProcessTableBeforeDeadline(
  readTable: ProcessTableReader,
  timeoutMs: number
): Promise<ProcessTableRow[] | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (rows: ProcessTableRow[] | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(rows)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref?.()
    try {
      void readTable(timeoutMs).then(
        (rows) => finish(rows),
        () => finish(null)
      )
    } catch {
      finish(null)
    }
  })
}

export function collectDescendantRows(
  rootPid: number,
  table: ProcessTableRow[],
  capturedAtMs = Date.now()
): DescendantSnapshot {
  const childrenByPpid = new Map<number, ProcessTableRow[]>()
  let rootRow: ProcessTableRow | null = null
  for (const row of table) {
    if (row.pid === rootPid) {
      rootRow = row
      continue
    }
    const siblings = childrenByPpid.get(row.ppid)
    if (siblings) {
      siblings.push(row)
    } else {
      childrenByPpid.set(row.ppid, [row])
    }
  }
  const descendants: ProcessTableRow[] = []
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.shift()!
    for (const child of childrenByPpid.get(pid) ?? []) {
      descendants.push(child)
      queue.push(child.pid)
    }
  }
  return { rootPgid: rootRow?.pgid ?? null, descendants, capturedAtMs }
}

type SnapshotDeps = {
  readTable?: ProcessTableReader
  platform?: NodeJS.Platform
  timeoutMs?: number
  now?: () => number
}

/**
 * Snapshots a PTY root's live descendant tree. Must run BEFORE the root is
 * signalled: once the root dies, surviving descendants reparent to pid 1 and
 * can no longer be found by a ppid walk. Resolves null (never rejects) on
 * Windows, ps failure, or timeout — callers then degrade to today's
 * shell-only kill.
 */
export async function captureDescendantSnapshot(
  rootPid: number,
  deps: SnapshotDeps = {}
): Promise<DescendantSnapshot | null> {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32' || !Number.isInteger(rootPid) || rootPid <= 0) {
    return null
  }
  const readTable = deps.readTable ?? readProcessTable
  const timeoutMs = deps.timeoutMs ?? DESCENDANT_SNAPSHOT_TIMEOUT_MS
  // Why both layers: the deadline keeps injected/custom readers bounded while
  // the production execFile timeout actually kills a wedged ps subprocess.
  const capturedAtMs = (deps.now ?? Date.now)()
  const table = await readProcessTableBeforeDeadline(readTable, timeoutMs)
  if (!table) {
    return null
  }
  return collectDescendantRows(rootPid, table, capturedAtMs)
}

/**
 * Standard agent-session kill sequencing: snapshot the descendant tree,
 * signal its members, then run the caller's root kill. Callers must not signal
 * the root before this runs — a dead root's descendants reparent to pid 1 and
 * become unfindable. Snapshot failure degrades to killRoot alone.
 */
export async function killWithDescendantSweep(
  rootPid: number,
  killRoot: () => void,
  deps: SnapshotDeps & TerminateDeps = {}
): Promise<void> {
  const snapshot = await captureDescendantSnapshot(rootPid, deps)
  try {
    // Signal the captured descendants while their parent links still exist;
    // killing the root first creates a reparent/PID-reuse window.
    if (snapshot) {
      terminateDescendantSnapshot(snapshot, deps)
    }
  } finally {
    killRoot()
  }
}

function defaultSendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    /* already gone */
  }
}

type TerminateDeps = {
  readTable?: ProcessTableReader
  sendSignal?: SignalSender
  graceMs?: number
  timeoutMs?: number
}

function hasUnambiguousStartIdentity(row: ProcessTableRow, capturedAtMs: number): boolean {
  const startedAtMs = Date.parse(row.startedAt)
  if (!Number.isFinite(startedAtMs)) {
    return false
  }
  // ps lstart is second-resolution. A process born in the capture second can
  // be replaced by a different process with the same displayed timestamp.
  return startedAtMs < Math.floor(capturedAtMs / 1_000) * 1_000
}

/**
 * Terminates a snapshotted descendant tree: SIGTERM every descendant now,
 * reaching detached-pgid children the PTY's SIGHUP cannot, then after a grace
 * window SIGKILL identity-safe survivors. Processes born in the capture second
 * are not escalated because ps cannot distinguish same-second PID reuse.
 */
export function terminateDescendantSnapshot(
  snapshot: DescendantSnapshot,
  deps: TerminateDeps = {}
): void {
  const sendSignal = deps.sendSignal ?? defaultSendSignal
  const readTable = deps.readTable ?? readProcessTable
  for (const row of snapshot.descendants) {
    sendSignal(row.pid, 'SIGTERM')
  }
  if (snapshot.descendants.length === 0) {
    return
  }
  const timer = setTimeout(() => {
    void readProcessTableBeforeDeadline(
      readTable,
      deps.timeoutMs ?? DESCENDANT_SNAPSHOT_TIMEOUT_MS
    ).then((table) => {
      if (!table) {
        return
      }
      const liveByPid = new Map(table.map((row) => [row.pid, row]))
      for (const row of snapshot.descendants) {
        const live = liveByPid.get(row.pid)
        if (
          hasUnambiguousStartIdentity(row, snapshot.capturedAtMs) &&
          live?.startedAt === row.startedAt &&
          live.pgid === row.pgid
        ) {
          sendSignal(row.pid, 'SIGKILL')
        }
      }
    })
  }, deps.graceMs ?? DESCENDANT_KILL_GRACE_MS)
  timer.unref?.()
}
