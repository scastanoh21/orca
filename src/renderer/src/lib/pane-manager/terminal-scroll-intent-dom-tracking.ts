import type { IDisposable } from '@xterm/xterm'
import {
  bindTerminalScrollIntentKey,
  markTerminalPinnedViewport,
  syncTerminalScrollIntentFromViewport,
  syncTerminalScrollIntentSoon
} from './terminal-scroll-intent'
import type { TerminalScrollIntentKey, TerminalScrollIntentTarget } from './terminal-scroll-intent'

const XTERM_SCROLL_INTENT_POINTER_TARGET_CLASSES = [
  'xterm-viewport',
  'xterm-scrollbar',
  'xterm-slider'
] as const
const XTERM_SCROLL_INTENT_POINTER_TARGET_SELECTOR = XTERM_SCROLL_INTENT_POINTER_TARGET_CLASSES.map(
  (className) => `.${className}`
).join(',')

function isTerminalScrollIntentPointerTarget(target: EventTarget | null): target is Element {
  if (typeof Element === 'undefined' || !(target instanceof Element)) {
    return false
  }
  // xterm's custom scrollbar uses separate thumb/track nodes from the viewport.
  return target.closest(XTERM_SCROLL_INTENT_POINTER_TARGET_SELECTOR) !== null
}

type TerminalWithOnData = {
  onData?: (listener: (data: string) => void) => { dispose?: unknown } | undefined
}

// Mouse reports (SGR "\x1b[<b;x;yM" and X10 "\x1b[M...") stream at pointer
// frequency and are the one input kind whose native scroll-to-bottom must NOT
// reclassify a pin: converting it would permanently drop a reading position
// on a mere mouse-move over a mouse-tracking app.
function isMouseReportInput(data: string): boolean {
  return (
    data.charCodeAt(0) === 0x1b &&
    data.charAt(1) === '[' &&
    (data.charAt(2) === '<' || data.charAt(2) === 'M')
  )
}

// Why: typing/pasting scrolls the terminal to the bottom (xterm
// scrollOnUserInput) without going through any wheel/pointer path this module
// tracks. Without a resync, a stored pin goes stale and a later
// workspace-switch restore yanks the user back to the old reading position.
// onData also carries parser auto-replies (DSR/CPR, focus reports); those
// never move the viewport, so their resync settles as a no-op.
function subscribeScrollIntentUserInputResync(
  terminal: TerminalScrollIntentTarget
): { dispose: () => void } | null {
  const onData = (terminal as TerminalWithOnData).onData
  if (typeof onData !== 'function') {
    return null
  }
  try {
    const subscription = onData((data: string) => {
      if (!isMouseReportInput(data)) {
        syncTerminalScrollIntentSoon(terminal)
      }
    })
    if (subscription && typeof subscription.dispose === 'function') {
      return subscription as { dispose: () => void }
    }
    return null
  } catch {
    return null
  }
}

/** Wires the user-driven scroll signals (wheel, scrollbar pointer drags) that
 *  are allowed to change a terminal's scroll intent. Output-driven scroll
 *  events deliberately do not update intent (see terminal-scroll-intent.ts). */
export function attachTerminalScrollIntentTracking(
  terminal: TerminalScrollIntentTarget,
  host: HTMLElement,
  intentKey?: TerminalScrollIntentKey
): IDisposable {
  if (!bindTerminalScrollIntentKey(terminal, intentKey)) {
    syncTerminalScrollIntentFromViewport(terminal)
  }
  const userInputResync = subscribeScrollIntentUserInputResync(terminal)
  let pointerScrollActive = false

  const onWheel = (event: WheelEvent): void => {
    if (event.deltaY < 0) {
      markTerminalPinnedViewport(terminal)
      syncTerminalScrollIntentSoon(terminal, { preservePinnedAtBottom: true })
      return
    }
    syncTerminalScrollIntentSoon(terminal)
  }

  const onPointerDown = (event: PointerEvent): void => {
    pointerScrollActive = isTerminalScrollIntentPointerTarget(event.target)
  }

  const onPointerDone = (): void => {
    if (!pointerScrollActive) {
      return
    }
    pointerScrollActive = false
    syncTerminalScrollIntentFromViewport(terminal)
  }

  const onScroll = (): void => {
    if (pointerScrollActive) {
      syncTerminalScrollIntentFromViewport(terminal)
    }
  }

  host.addEventListener('wheel', onWheel, { capture: true, passive: true })
  host.addEventListener('pointerdown', onPointerDown, true)
  host.addEventListener('scroll', onScroll, true)
  globalThis.addEventListener?.('pointerup', onPointerDone, true)
  globalThis.addEventListener?.('pointercancel', onPointerDone, true)
  return {
    dispose: () => {
      userInputResync?.dispose()
      host.removeEventListener('wheel', onWheel, true)
      host.removeEventListener('pointerdown', onPointerDown, true)
      host.removeEventListener('scroll', onScroll, true)
      globalThis.removeEventListener?.('pointerup', onPointerDone, true)
      globalThis.removeEventListener?.('pointercancel', onPointerDone, true)
    }
  }
}
