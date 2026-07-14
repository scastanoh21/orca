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

type TerminalWithCoreUserInput = {
  _core?: {
    coreService?: {
      onUserInput?: (listener: () => void) => { dispose?: unknown } | undefined
    }
  }
}

// Why: typing scrolls the terminal to the bottom (xterm scrollOnUserInput)
// without going through any wheel/pointer path this module tracks. Without a
// resync, a stored pin goes stale and a later workspace-switch restore yanks
// the user back to the old reading position. Core onUserInput fires only for
// real input, never for parser auto-replies (see terminal-user-input-signal).
function subscribeScrollIntentUserInputResync(
  terminal: TerminalScrollIntentTarget
): { dispose: () => void } | null {
  const coreService = (terminal as TerminalWithCoreUserInput)._core?.coreService
  if (typeof coreService?.onUserInput !== 'function') {
    return null
  }
  try {
    const subscription = coreService.onUserInput(() => {
      syncTerminalScrollIntentSoon(terminal)
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
