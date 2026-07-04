/**
 * Pins the shutdownWorktreeTerminals → disposeParkedTerminalWatchersForPtyIds
 * wiring (hidden-view parking). Live transports are silenced via
 * unregisterPtyDataHandlers, but parked byte watchers ride the dispatcher
 * sidecar channel — if shutdown stops disposing them, the teardown flush of a
 * just-slept/deleted worktree marks unread and arms notification timers (the
 * "phantom alerts" failure class that reverted the first parking attempt).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parkedWatchersByTabId,
  pruneParkedTerminalWatchers
} from '../../components/terminal-pane/terminal-parked-watcher-registry'
import type { AppState } from '../types'
import { createTestStore, makeTab } from './store-test-helpers'

const originalWindow = (globalThis as { window?: unknown }).window

beforeEach(() => {
  // Why: shutdown's final pty.kill fan-out runs in this node-env suite; only
  // the kill surface is needed for the wiring under test.
  ;(globalThis as { window?: unknown }).window = {
    api: { pty: { kill: vi.fn(async () => {}) } }
  }
})

afterEach(() => {
  ;(globalThis as { window?: unknown }).window = originalWindow
  pruneParkedTerminalWatchers(new Set())
})

function seedParkedWatcher(
  worktreeId: string,
  tabId: string,
  ptyId: string
): ReturnType<typeof vi.fn> {
  const dispose = vi.fn()
  parkedWatchersByTabId.set(tabId, {
    worktreeId,
    tabPtyId: ptyId,
    paneIdByPtyId: new Map([[ptyId, 1]]),
    disposersByPtyId: new Map([[ptyId, dispose]])
  })
  return dispose
}

describe('shutdownWorktreeTerminals parked watcher disposal', () => {
  it('synchronously disposes parked watchers for the shutdown PTYs', async () => {
    const store = createTestStore()
    const tab = makeTab({ id: 'tab-parked', worktreeId: 'wt-parked' })
    store.setState({
      tabsByWorktree: { 'wt-parked': [tab] },
      ptyIdsByTabId: { 'tab-parked': ['wt-parked@@session-1'] }
    } as Partial<AppState>)
    const dispose = seedParkedWatcher('wt-parked', 'tab-parked', 'wt-parked@@session-1')
    const untouched = seedParkedWatcher('wt-other', 'tab-other', 'wt-other@@session-9')

    await store.getState().shutdownWorktreeTerminals('wt-parked', { keepIdentifiers: true })

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(untouched).not.toHaveBeenCalled()
    // Why: the tab entry is deliberately kept (minus the disposed PTY) so a
    // sleeping parked tab cannot restart watchers against stale PTY ids.
    expect(parkedWatchersByTabId.get('tab-parked')?.disposersByPtyId.size).toBe(0)
  })
})
