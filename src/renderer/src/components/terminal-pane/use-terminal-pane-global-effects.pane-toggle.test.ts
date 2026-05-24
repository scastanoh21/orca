import type * as ReactModule from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import { useTerminalPaneGlobalEffects } from './use-terminal-pane-global-effects'
import { requestRegisteredTerminalPaneExpandToggle } from './terminal-pane-expand-toggle-registry'

const mocks = vi.hoisted(() => ({
  captureScrollState: vi.fn(),
  fitAndFocusPanes: vi.fn(),
  fitPanes: vi.fn(),
  flushTerminalOutput: vi.fn(),
  getTerminalOutputEpoch: vi.fn(() => 0),
  handleTerminalFileDrop: vi.fn(),
  restoreScrollState: vi.fn(),
  restoreScrollStateAfterLayout: vi.fn()
}))

const reactRefState = vi.hoisted(() => ({
  slots: [] as { current: unknown }[],
  index: 0
}))

function beginHookRender(): void {
  reactRefState.index = 0
}

function resetHookRefs(): void {
  reactRefState.slots = []
  reactRefState.index = 0
}

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    useEffect: (effect: () => void | (() => void)) => {
      effect()
    },
    useRef: <T>(value: T) => {
      const index = reactRefState.index
      reactRefState.index += 1
      if (!reactRefState.slots[index]) {
        reactRefState.slots[index] = { current: value }
      }
      return reactRefState.slots[index] as { current: T }
    }
  }
})

vi.mock('./pane-helpers', () => ({
  fitAndFocusPanes: mocks.fitAndFocusPanes,
  fitPanes: mocks.fitPanes
}))

vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  flushTerminalOutput: mocks.flushTerminalOutput
}))

vi.mock('@/lib/pane-manager/pane-scroll', () => ({
  captureScrollState: mocks.captureScrollState,
  getTerminalOutputEpoch: mocks.getTerminalOutputEpoch,
  restoreScrollState: mocks.restoreScrollState,
  restoreScrollStateAfterLayout: mocks.restoreScrollStateAfterLayout
}))

vi.mock('./terminal-drop-handler', () => ({
  handleTerminalFileDrop: mocks.handleTerminalFileDrop
}))

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
}

describe('useTerminalPaneGlobalEffects pane expand events', () => {
  beforeEach(() => {
    resetHookRefs()
    vi.clearAllMocks()
    ;(globalThis as unknown as { window: unknown }).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      api: {
        ui: {
          onFileDrop: vi.fn(() => vi.fn())
        }
      }
    }
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
    delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver
  })

  it('collapses the currently expanded pane for chrome-originated toggle events', () => {
    const toggleExpandPane = vi.fn()
    const manager = {
      getPanes: vi.fn(() => [
        { id: 1, terminal: { name: 'terminal-a' } },
        { id: 2, terminal: { name: 'terminal-b' } }
      ]),
      resumeRendering: vi.fn(),
      suspendRendering: vi.fn(),
      getActivePane: vi.fn(() => ({ id: 1, terminal: { name: 'terminal-a' } }))
    }

    beginHookRender()
    useTerminalPaneGlobalEffects({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: true,
      isVisible: true,
      paneCount: 2,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      expandedPaneIdRef: { current: 2 },
      toggleExpandPane
    })

    const listenerEntry = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([eventName]) => eventName === TOGGLE_TERMINAL_PANE_EXPAND_EVENT)
    if (!listenerEntry || typeof listenerEntry[1] !== 'function') {
      throw new Error('toggle expand listener not registered')
    }
    listenerEntry[1](
      new CustomEvent(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, { detail: { tabId: 'tab-1' } })
    )

    expect(toggleExpandPane).toHaveBeenCalledWith(2)
  })

  it('handles registered chrome toggle requests without waiting for the window event path', () => {
    const toggleExpandPane = vi.fn()
    const manager = {
      getPanes: vi.fn(() => [
        { id: 1, terminal: { name: 'terminal-a' } },
        { id: 2, terminal: { name: 'terminal-b' } }
      ]),
      resumeRendering: vi.fn(),
      suspendRendering: vi.fn(),
      getActivePane: vi.fn(() => ({ id: 1, terminal: { name: 'terminal-a' } }))
    }

    beginHookRender()
    useTerminalPaneGlobalEffects({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: true,
      isVisible: true,
      paneCount: 2,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      expandedPaneIdRef: { current: 2 },
      toggleExpandPane
    })

    expect(requestRegisteredTerminalPaneExpandToggle('tab-1')).toBe(true)
    expect(toggleExpandPane).toHaveBeenCalledWith(2)
  })
})
