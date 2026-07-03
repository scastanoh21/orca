import type { Terminal } from '@xterm/xterm'

const XTERM_MOUSE_REPORTING_CLASS = 'enable-mouse-events'
const REPLAYED_WHEEL_EVENT_PROPERTY = '__orcaReplayedTerminalWheelEvent'
const DOM_DELTA_PIXEL = 0
const DOM_DELTA_LINE = 1
const DISCRETE_PIXEL_WHEEL_DELTA_MIN = 50
const LEGACY_MOUSE_WHEEL_DELTA_MIN = 100
const TUI_WHEEL_ACCELERATION_WINDOW_MS = 140
const TUI_WHEEL_REPORTS_PER_FRAME = 4

export const TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER = 1
export const TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER_MIN = 1
export const TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER_MAX = 10

type TerminalWheelTarget = Pick<Terminal, 'attachCustomWheelEventHandler' | 'element'>

type TerminalMouseWheelMultiplierOptions = {
  getTuiMouseWheelMultiplier?: () => number | undefined
  scheduleWheelReplayFrame?: (callback: () => void) => void
}

type ReplayedWheelEvent = WheelEvent & {
  [REPLAYED_WHEEL_EVENT_PROPERTY]?: boolean
}

type WheelEventWithLegacyDelta = WheelEvent & {
  wheelDelta?: number
  wheelDeltaY?: number
}

export type TerminalTuiMouseWheelAccelerationState = {
  lastDirection: -1 | 0 | 1
  lastInputAt: number | null
  streak: number
}

type TerminalTuiMouseWheelReplayState = {
  acceleration: TerminalTuiMouseWheelAccelerationState
  drainScheduled: boolean
  pendingDirection: -1 | 0 | 1
  pendingEvent: WheelEvent | null
  pendingReports: number
  pendingTarget: EventTarget | null
}

export function createTerminalTuiMouseWheelAccelerationState(): TerminalTuiMouseWheelAccelerationState {
  return {
    lastDirection: 0,
    lastInputAt: null,
    streak: 0
  }
}

function createTerminalTuiMouseWheelReplayState(): TerminalTuiMouseWheelReplayState {
  return {
    acceleration: createTerminalTuiMouseWheelAccelerationState(),
    drainScheduled: false,
    pendingDirection: 0,
    pendingEvent: null,
    pendingReports: 0,
    pendingTarget: null
  }
}

function isReplayedWheelEvent(event: WheelEvent): boolean {
  return (event as ReplayedWheelEvent)[REPLAYED_WHEEL_EVENT_PROPERTY] === true
}

function markReplayedWheelEvent(event: WheelEvent): void {
  Object.defineProperty(event, REPLAYED_WHEEL_EVENT_PROPERTY, {
    configurable: true,
    value: true
  })
}

function legacyVerticalWheelDelta(event: WheelEvent): number | null {
  const wheelEvent = event as WheelEventWithLegacyDelta
  if (typeof wheelEvent.wheelDeltaY === 'number' && Number.isFinite(wheelEvent.wheelDeltaY)) {
    return wheelEvent.wheelDeltaY
  }
  if (typeof wheelEvent.wheelDelta === 'number' && Number.isFinite(wheelEvent.wheelDelta)) {
    return wheelEvent.wheelDelta
  }
  return null
}

function isDiscreteWheelEvent(event: WheelEvent): boolean {
  if (event.deltaMode !== DOM_DELTA_PIXEL) {
    return true
  }

  if (Math.abs(event.deltaY) >= DISCRETE_PIXEL_WHEEL_DELTA_MIN) {
    return true
  }

  const legacyDelta = legacyVerticalWheelDelta(event)
  return legacyDelta !== null && Math.abs(legacyDelta) >= LEGACY_MOUSE_WHEEL_DELTA_MIN
}

function wheelDirection(event: Pick<WheelEvent, 'deltaY'>): -1 | 1 {
  return event.deltaY < 0 ? -1 : 1
}

function wheelInputTime(event: Pick<WheelEvent, 'timeStamp'>): number {
  if (typeof event.timeStamp === 'number' && Number.isFinite(event.timeStamp)) {
    return event.timeStamp
  }
  return performance.now()
}

function easeOutCubic(value: number): number {
  return 1 - Math.pow(1 - value, 3)
}

function cloneWheelReportEvent(event: WheelEvent): WheelEvent {
  const clone = new WheelEvent(event.type, {
    bubbles: event.bubbles,
    cancelable: event.cancelable,
    composed: event.composed,
    view: event.view,
    detail: event.detail,
    screenX: event.screenX,
    screenY: event.screenY,
    clientX: event.clientX,
    clientY: event.clientY,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    button: event.button,
    buttons: event.buttons,
    relatedTarget: event.relatedTarget,
    deltaX: 0,
    deltaY: event.deltaY < 0 ? -1 : 1,
    deltaZ: 0,
    deltaMode: DOM_DELTA_LINE
  })
  markReplayedWheelEvent(clone)
  return clone
}

export function resolveTerminalTuiMouseWheelReportCount(
  event: Pick<WheelEvent, 'deltaY' | 'timeStamp'>,
  maxReports: number,
  state: TerminalTuiMouseWheelAccelerationState
): number {
  const normalizedMaxReports = normalizeTerminalTuiMouseWheelMultiplier(maxReports)
  const direction = wheelDirection(event)
  const currentInputAt = wheelInputTime(event)
  const elapsedMs = state.lastInputAt === null ? null : currentInputAt - state.lastInputAt
  const isAccelerating =
    state.lastDirection === direction &&
    elapsedMs !== null &&
    elapsedMs >= 0 &&
    elapsedMs <= TUI_WHEEL_ACCELERATION_WINDOW_MS

  state.streak = isAccelerating ? state.streak + 1 : 0
  state.lastDirection = direction
  state.lastInputAt = currentInputAt

  if (!isAccelerating || normalizedMaxReports <= 1 || elapsedMs === null) {
    return 1
  }

  const cadence = 1 - elapsedMs / TUI_WHEEL_ACCELERATION_WINDOW_MS
  const acceleratedReports = 1 + Math.round((normalizedMaxReports - 1) * easeOutCubic(cadence))
  return Math.min(normalizedMaxReports, Math.max(1, acceleratedReports))
}

export function shouldMultiplyTerminalMouseWheel(
  event: WheelEvent,
  terminalElement: HTMLElement | null | undefined
): boolean {
  if (
    isReplayedWheelEvent(event) ||
    !terminalElement?.classList.contains(XTERM_MOUSE_REPORTING_CLASS) ||
    event.deltaY === 0 ||
    event.shiftKey ||
    !isDiscreteWheelEvent(event)
  ) {
    return false
  }

  return true
}

export function normalizeTerminalTuiMouseWheelMultiplier(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER
  }
  return Math.round(
    Math.min(
      TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER_MAX,
      Math.max(TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER_MIN, value)
    )
  )
}

function defaultScheduleWheelReplayFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => callback())
    return
  }
  setTimeout(callback, 0)
}

function drainTerminalTuiWheelReports(
  state: TerminalTuiMouseWheelReplayState,
  scheduleWheelReplayFrame: (callback: () => void) => void,
  reportsThisFrame: number
): void {
  const target = state.pendingTarget
  const event = state.pendingEvent
  if (!target || !event || state.pendingReports <= 0) {
    state.drainScheduled = false
    return
  }

  const reportsToDispatch = Math.min(reportsThisFrame, state.pendingReports)
  for (let i = 0; i < reportsToDispatch; i++) {
    target.dispatchEvent(cloneWheelReportEvent(event))
  }
  state.pendingReports -= reportsToDispatch

  if (state.pendingReports <= 0) {
    state.drainScheduled = false
    state.pendingDirection = 0
    state.pendingEvent = null
    state.pendingTarget = null
    return
  }

  scheduleWheelReplayFrame(() => {
    drainTerminalTuiWheelReports(state, scheduleWheelReplayFrame, TUI_WHEEL_REPORTS_PER_FRAME)
  })
}

function queueTerminalTuiWheelReports(
  state: TerminalTuiMouseWheelReplayState,
  target: EventTarget,
  event: WheelEvent,
  reportCount: number,
  scheduleWheelReplayFrame: (callback: () => void) => void
): void {
  const direction = wheelDirection(event)
  if (state.pendingDirection !== 0 && state.pendingDirection !== direction) {
    state.pendingReports = 0
  }

  state.pendingDirection = direction
  state.pendingEvent = event
  state.pendingTarget = target
  state.pendingReports += reportCount

  if (state.drainScheduled) {
    return
  }

  state.drainScheduled = true
  // Why: the first report should land immediately, while larger accelerated
  // batches are paced across frames so fast scrolling does not feel bursty.
  queueMicrotask(() => {
    drainTerminalTuiWheelReports(state, scheduleWheelReplayFrame, 1)
  })
}

export function attachTerminalMouseWheelMultiplier(
  terminal: TerminalWheelTarget,
  options: TerminalMouseWheelMultiplierOptions = {}
): void {
  const replayState = createTerminalTuiMouseWheelReplayState()
  terminal.attachCustomWheelEventHandler((event) => {
    if (!shouldMultiplyTerminalMouseWheel(event, terminal.element)) {
      return true
    }

    const target =
      event.currentTarget instanceof EventTarget ? event.currentTarget : terminal.element
    if (!target) {
      return true
    }

    // Why: xterm dampens small pixel deltas before emitting mouse reports;
    // line-mode replays make each notched wheel tick produce immediate reports.
    const reportCount = resolveTerminalTuiMouseWheelReportCount(
      event,
      normalizeTerminalTuiMouseWheelMultiplier(options.getTuiMouseWheelMultiplier?.()),
      replayState.acceleration
    )
    queueTerminalTuiWheelReports(
      replayState,
      target,
      event,
      reportCount,
      options.scheduleWheelReplayFrame ?? defaultScheduleWheelReplayFrame
    )

    return false
  })
}
