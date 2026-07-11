// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsagePercentageDisplayChangeNotice } from './UsagePercentageDisplayChangeNotice'
import { USAGE_PERCENTAGE_DISPLAY_SETTING_ID } from '../settings/appearance-usage-percentage-search'

const storeState = {
  persistedUIReady: true,
  usagePercentageDisplayChangeNoticeDismissed: false,
  dismissUsagePercentageDisplayChangeNotice: vi.fn(),
  statusBarVisible: true,
  activeModal: 'none' as string,
  openSettingsTarget: vi.fn(),
  openSettingsPage: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    {
      getState: () => storeState
    }
  )
}))

describe('UsagePercentageDisplayChangeNotice', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    storeState.persistedUIReady = true
    storeState.usagePercentageDisplayChangeNoticeDismissed = false
    storeState.statusBarVisible = true
    storeState.activeModal = 'none'
    storeState.dismissUsagePercentageDisplayChangeNotice = vi.fn()
    storeState.openSettingsPage = vi.fn()
    storeState.openSettingsTarget = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.useRealTimers()
  })

  it('shows the callout above usage meters after a short delay when eligible', () => {
    act(() => {
      root.render(
        <UsagePercentageDisplayChangeNotice hasVisibleUsageMeters>
          <span>usage-meters</span>
        </UsagePercentageDisplayChangeNotice>
      )
    })

    expect(container.querySelector('.status-bar-change-notice-card')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(1_800)
    })
    expect(container.querySelector('.status-bar-change-notice-card')).not.toBeNull()
    expect(container.textContent).toContain('usage-meters')
    expect(container.textContent).toContain('Usage now shows % used')
    expect(container.textContent).toContain('Prefer remaining? Change it in Settings.')
  })

  it('does not open when no usage meters are visible', () => {
    act(() => {
      root.render(
        <UsagePercentageDisplayChangeNotice hasVisibleUsageMeters={false}>
          <span>usage-meters</span>
        </UsagePercentageDisplayChangeNotice>
      )
    })
    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(container.querySelector('.status-bar-change-notice-card')).toBeNull()
  })

  it('does not open when the notice was already dismissed', () => {
    storeState.usagePercentageDisplayChangeNoticeDismissed = true
    act(() => {
      root.render(
        <UsagePercentageDisplayChangeNotice hasVisibleUsageMeters>
          <span>usage-meters</span>
        </UsagePercentageDisplayChangeNotice>
      )
    })
    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(container.querySelector('.status-bar-change-notice-card')).toBeNull()
  })

  it('does not open while another modal is open', () => {
    storeState.activeModal = 'feature-tips'
    act(() => {
      root.render(
        <UsagePercentageDisplayChangeNotice hasVisibleUsageMeters>
          <span>usage-meters</span>
        </UsagePercentageDisplayChangeNotice>
      )
    })
    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(container.querySelector('.status-bar-change-notice-card')).toBeNull()
  })

  it('deep-links to the Usage percentages setting without a search filter', () => {
    const callOrder: string[] = []
    storeState.openSettingsPage = vi.fn(() => {
      callOrder.push('openSettingsPage')
    })
    storeState.openSettingsTarget = vi.fn(() => {
      callOrder.push('openSettingsTarget')
    })
    storeState.dismissUsagePercentageDisplayChangeNotice = vi.fn()

    act(() => {
      root.render(
        <UsagePercentageDisplayChangeNotice hasVisibleUsageMeters>
          <span>usage-meters</span>
        </UsagePercentageDisplayChangeNotice>
      )
    })
    act(() => {
      vi.advanceTimersByTime(1_800)
    })

    const openSettingsButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Open Settings'
    )
    expect(openSettingsButton).toBeTruthy()
    act(() => {
      openSettingsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(callOrder).toEqual(['openSettingsPage', 'openSettingsTarget'])
    expect(storeState.openSettingsTarget).toHaveBeenCalledWith({
      pane: 'appearance',
      repoId: null,
      sectionId: USAGE_PERCENTAGE_DISPLAY_SETTING_ID
    })
    expect(storeState.dismissUsagePercentageDisplayChangeNotice).toHaveBeenCalled()
  })
})
