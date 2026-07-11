import { useEffect, useState, type ReactNode } from 'react'
import { BarChart3, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { shouldShowUsagePercentageDisplayChangeNotice } from '../../../../shared/usage-percentage-display-change-notice'
import { USAGE_PERCENTAGE_DISPLAY_SETTING_ID } from '../settings/appearance-usage-percentage-search'

// Why: let startup modals settle before the status-bar callout competes for focus.
const SHOW_DELAY_MS = 1_800

function openUsagePercentageSettings(): void {
  const store = useAppStore.getState()
  // Why: openSettingsPage wipes any leftover search; do not re-apply a search
  // filter — deep-link to the stable row id and let Appearance expand Window.
  store.openSettingsPage()
  store.openSettingsTarget({
    pane: 'appearance',
    repoId: null,
    sectionId: USAGE_PERCENTAGE_DISPLAY_SETTING_ID
  })
}

/**
 * One-time elevated callout anchored above the status-bar usage meters after
 * the default flipped from remaining → used. Permanent dismiss only.
 */
export function UsagePercentageDisplayChangeNotice({
  children,
  hasVisibleUsageMeters
}: {
  children: ReactNode
  // Why: StatusBar owns which meter children actually render (status-bar items,
  // CLI detection, MiniMax/Grok durability). Don't re-derive empty-state here.
  hasVisibleUsageMeters: boolean
}): React.JSX.Element {
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const dismissed = useAppStore((s) => s.usagePercentageDisplayChangeNoticeDismissed)
  const dismiss = useAppStore((s) => s.dismissUsagePercentageDisplayChangeNotice)
  const statusBarVisible = useAppStore((s) => s.statusBarVisible)
  const activeModal = useAppStore((s) => s.activeModal)
  const [delayElapsed, setDelayElapsed] = useState(false)

  const eligible = shouldShowUsagePercentageDisplayChangeNotice({
    persistedUIReady,
    usagePercentageDisplayChangeNoticeDismissed: dismissed,
    statusBarVisible,
    hasVisibleUsageMeters,
    activeModal
  })

  useEffect(() => {
    if (!eligible) {
      setDelayElapsed(false)
      return
    }
    const timer = window.setTimeout(() => {
      setDelayElapsed(true)
    }, SHOW_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [eligible])

  const open = eligible && delayElapsed

  useEffect(() => {
    if (!open) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        dismiss()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [dismiss, open])

  const openSettings = (): void => {
    dismiss()
    openUsagePercentageSettings()
  }

  return (
    <div className="relative flex items-center gap-3">
      {children}
      {open ? (
        <div
          role="status"
          className="status-bar-change-notice-card absolute bottom-full left-0 z-50 mb-2.5 w-[320px] max-w-[calc(100vw-24px)] rounded-lg p-3.5"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1.5">
              <div className="flex items-center gap-2">
                <span
                  className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-foreground"
                  aria-hidden="true"
                >
                  <BarChart3 className="size-3.5" />
                </span>
                <div className="text-sm font-semibold leading-snug">
                  {translate(
                    'auto.components.status.bar.UsagePercentageDisplayChangeNotice.title',
                    'Usage now shows % used'
                  )}
                </div>
              </div>
              <p className="text-sm leading-5 text-muted-foreground">
                {translate(
                  'auto.components.status.bar.UsagePercentageDisplayChangeNotice.body',
                  'Prefer remaining? Change it in Settings.'
                )}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={dismiss}
              aria-label={translate(
                'auto.components.status.bar.UsagePercentageDisplayChangeNotice.dismiss',
                'Dismiss'
              )}
            >
              <X className="size-3.5" />
            </Button>
          </div>
          <div className="mt-3 flex gap-2">
            <Button variant="default" size="sm" className="min-w-0 flex-1" onClick={openSettings}>
              {translate(
                'auto.components.status.bar.UsagePercentageDisplayChangeNotice.openSettings',
                'Open Settings'
              )}
            </Button>
            <Button variant="secondary" size="sm" className="w-[84px]" onClick={dismiss}>
              {translate(
                'auto.components.status.bar.UsagePercentageDisplayChangeNotice.gotIt',
                'Got it'
              )}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
