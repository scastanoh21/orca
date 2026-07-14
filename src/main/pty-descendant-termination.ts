import { execFile } from 'node:child_process'

export const DESCENDANT_KILL_GRACE_MS = 2_000
export const DESCENDANT_SNAPSHOT_TIMEOUT_MS = 1_000
// Why: a full process table on a busy host can exceed execFile's 1MB default;
// truncation would silently drop descendants from the snapshot.
const PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024

export type ProcessTableRow = {
  pid: number
  ppid: number
  pgid: number
  /** ps lstart text, kept verbatim. (pid, startedAt) is the identity token that
   *  gates the delayed SIGKILL so it can never land on a recycled pid. */
  startedAt: string
}

export type DescendantSnapshot = {
  rootPgid: number | null
  descendants: ProcessTableRow[]
}

export type ProcessTableReader = () => Promise<ProcessTableRow[]>
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

function readProcessTable(): Promise<ProcessTableRow[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,pgid=,lstart='],
      { maxBuffer: PS_MAX_BUFFER_BYTES },
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

export function collectDescendantRows(
  rootPid: number,
  table: ProcessTableRow[]
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
  return { rootPgid: rootRow?.pgid ?? null, descendants }
}

type SnapshotDeps = {
  readTable?: ProcessTableReader
  platform?: NodeJS.Platform
  timeoutMs?: number
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
  try {
    // Why the timeout: the snapshot sits in front of the actual kill; a wedged
    // ps must degrade to shell-only kill, not block session teardown.
    const table = await Promise.race([
      readTable(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs).unref?.())
    ])
    if (!table) {
      return null
    }
    return collectDescendantRows(rootPid, table)
  } catch {
    return null
  }
}

/**
 * Standard agent-session kill sequencing: snapshot the descendant tree, only
 * then run the caller's root kill, then sweep the snapshot. Callers must not
 * signal the root before this runs — a dead root's descendants reparent to
 * pid 1 and become unfindable. Snapshot failure degrades to killRoot alone.
 */
export function killWithDescendantSweep(
  rootPid: number,
  killRoot: () => void,
  deps: SnapshotDeps & TerminateDeps = {}
): void {
  void captureDescendantSnapshot(rootPid, deps).then((snapshot) => {
    killRoot()
    if (snapshot) {
      terminateDescendantSnapshot(snapshot, deps)
    }
  })
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
}

/**
 * Terminates a snapshotted descendant tree: SIGTERM now (root process group +
 * every descendant, reaching detached-pgid children the PTY's SIGHUP cannot),
 * then after a grace window SIGKILL whatever from the snapshot is still alive.
 * The SIGKILL wave re-reads the process table and only signals pids whose
 * start time still matches the snapshot, so a recycled pid is never killed.
 */
export function terminateDescendantSnapshot(
  snapshot: DescendantSnapshot,
  deps: TerminateDeps = {}
): void {
  const sendSignal = deps.sendSignal ?? defaultSendSignal
  const readTable = deps.readTable ?? readProcessTable
  if (snapshot.rootPgid !== null && snapshot.rootPgid > 0) {
    sendSignal(-snapshot.rootPgid, 'SIGTERM')
  }
  for (const row of snapshot.descendants) {
    sendSignal(row.pid, 'SIGTERM')
  }
  if (snapshot.descendants.length === 0) {
    return
  }
  const timer = setTimeout(() => {
    void readTable().then(
      (table) => {
        const liveByPid = new Map(table.map((row) => [row.pid, row]))
        for (const row of snapshot.descendants) {
          if (liveByPid.get(row.pid)?.startedAt === row.startedAt) {
            sendSignal(row.pid, 'SIGKILL')
          }
        }
      },
      () => {
        /* table read failed — leave survivors rather than risk recycled pids */
      }
    )
  }, deps.graceMs ?? DESCENDANT_KILL_GRACE_MS)
  timer.unref?.()
}
