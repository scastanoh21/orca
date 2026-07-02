import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { writeForegroundTerminalChunk } from '@/lib/pane-manager/pane-terminal-foreground-render-settle'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-diagnostics'

// Why: xterm.js auto-responds to terminal query sequences (DA1 `CSI c`,
// DECRQM `CSI ? Ps $ p`, OSC 10/11 color queries, focus events, CPR) by
// emitting the reply through its onData callback. In pty-connection.ts that
// callback is wired directly to `transport.sendInput`, which pipes the reply
// to the shell's stdin. When we restore terminal state at startup or on
// reattach we write recorded PTY bytes back into xterm — including any
// queries the previous agent CLI emitted — and the auto-replies end up as
// stray characters on the new shell's prompt (e.g. `?1;2c`, `2026;2$y`,
// OSC 10/11 color fragments).
//
// xterm does not expose a `wasUserInput` flag on its public onData, so we
// cannot distinguish replay-induced replies from real keystrokes after the
// fact. Instead, we track an in-flight replay counter per pane: callers
// replay into xterm via `replayIntoTerminal`, which increments the counter,
// writes, and decrements in xterm's write-completion callback. The onData
// handler in pty-connection.ts drops data while the counter is non-zero.
//
// The guard window is bounded by xterm's own parse completion, not a
// wall-clock timer, so only replies generated while parsing the replayed
// bytes are suppressed. User keystrokes typed after the replay completes
// are unaffected. In practice replay finishes within milliseconds — before
// the user could meaningfully type — so the few-ms window where real input
// would also be dropped is acceptable relative to correctness.

export type ReplayingPanesRef = React.RefObject<Map<number, number>>

// Why a watchdog: the decrement above only runs when xterm completes the
// write. A wedged WriteBuffer (sync throw escaping a parse handler or a
// write-completion callback — see xterm-write-buffer-stall.repro.test.ts) or
// a disposed-terminal race can drop that completion forever, leaving the
// guard latched on a live pane — which silently eats every keystroke
// (Discord #performance / issue #2836). Real replays parse in well under a
// second, so a 10s ceiling only ever fires on a genuinely lost completion.
const REPLAY_GUARD_WATCHDOG_MS = 10_000

export function isPaneReplaying(ref: ReplayingPanesRef, paneId: number): boolean {
  return (ref.current.get(paneId) ?? 0) > 0
}

/**
 * Engage the replay counter for one write and return the release function.
 * Release runs exactly once — from xterm's write completion or, failing
 * that, from the watchdog — so a lost completion cannot latch the guard.
 */
function engageReplayGuard(
  map: Map<number, number>,
  paneId: number,
  watchdogMs: number,
  onRelease?: () => void
): () => void {
  map.set(paneId, (map.get(paneId) ?? 0) + 1)
  let released = false
  let watchdog: ReturnType<typeof setTimeout> | null = null
  const release = (reason: 'parsed' | 'watchdog'): void => {
    if (released) {
      return
    }
    released = true
    if (watchdog !== null) {
      clearTimeout(watchdog)
      watchdog = null
    }
    const remaining = (map.get(paneId) ?? 1) - 1
    if (remaining <= 0) {
      map.delete(paneId)
    } else {
      map.set(paneId, remaining)
    }
    if (reason === 'watchdog') {
      console.error(
        `[terminal] replay guard force-released for pane ${paneId} — xterm never completed the replay write (wedged write pipeline?)`
      )
      recordRendererCrashBreadcrumb('terminal_replay_guard_watchdog_release', { paneId })
    }
    onRelease?.()
  }
  watchdog = setTimeout(() => release('watchdog'), watchdogMs)
  return () => release('parsed')
}

/** Writes `data` into the pane's terminal with the replay guard engaged,
 *  so xterm's auto-replies to embedded query sequences do not leak to the
 *  shell as input. The counter increments/decrements so nested replays
 *  (e.g. clear-screen preamble + snapshot body) compose correctly. */
export function replayIntoTerminal(
  pane: ManagedPane,
  replayingPanesRef: ReplayingPanesRef,
  data: string,
  watchdogMs: number = REPLAY_GUARD_WATCHDOG_MS
): void {
  if (!data) {
    return
  }
  const releaseParsed = engageReplayGuard(replayingPanesRef.current, pane.id, watchdogMs)
  // Why: hidden/snapshot replay bypasses the live foreground write path, but
  // WebGL/canvas renderers still need a post-parse repaint to drop stale cells.
  writeForegroundTerminalChunk(pane.terminal, data, {
    forceViewportRefresh: true,
    followupViewportRefresh: true,
    onParsed: releaseParsed
  })
}

export function replayIntoTerminalAsync(
  pane: ManagedPane,
  replayingPanesRef: ReplayingPanesRef,
  data: string,
  watchdogMs: number = REPLAY_GUARD_WATCHDOG_MS
): Promise<void> {
  if (!data) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    // Why resolve on either release path: callers await this to sequence
    // restore steps; a lost write completion must not hang the restore chain.
    const releaseParsed = engageReplayGuard(replayingPanesRef.current, pane.id, watchdogMs, resolve)
    writeForegroundTerminalChunk(pane.terminal, data, {
      forceViewportRefresh: true,
      followupViewportRefresh: true,
      onParsed: releaseParsed
    })
  })
}
