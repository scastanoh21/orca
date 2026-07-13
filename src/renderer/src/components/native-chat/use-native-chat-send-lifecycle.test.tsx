// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useNativeChatSendLifecycle } from './use-native-chat-send-lifecycle'

function handle(settleAfterMs = 500) {
  return { cancel: vi.fn<() => void>(), settleAfterMs }
}

describe('useNativeChatSendLifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('cancels owned writes when the PTY target changes and when the composer unmounts', () => {
    vi.useFakeTimers()
    const first = handle()
    const second = handle()
    const { result, rerender, unmount } = renderHook(
      ({ targetPtyId }) => useNativeChatSendLifecycle('tab-1', targetPtyId),
      { initialProps: { targetPtyId: 'pty-1' as string | null } }
    )

    act(() => result.current.trackPendingSend(first))
    rerender({ targetPtyId: 'pty-2' })
    expect(first.cancel).toHaveBeenCalledOnce()

    act(() => result.current.trackPendingSend(second))
    unmount()
    expect(second.cancel).toHaveBeenCalledOnce()
  })

  it('cancels pending writes immediately on interrupt without double-cancelling', () => {
    vi.useFakeTimers()
    const pending = handle()
    const { result, unmount } = renderHook(() => useNativeChatSendLifecycle('tab-1', 'pty-1'))

    act(() => result.current.trackPendingSend(pending))
    act(() => result.current.cancelPendingSends())
    expect(pending.cancel).toHaveBeenCalledOnce()

    unmount()
    expect(pending.cancel).toHaveBeenCalledOnce()
  })

  it('drops settled handles so a later interrupt does not revisit completed sends', () => {
    vi.useFakeTimers()
    const settled = handle(800)
    const { result } = renderHook(() => useNativeChatSendLifecycle('tab-1', 'pty-1'))

    act(() => result.current.trackPendingSend(settled))
    act(() => vi.advanceTimersByTime(settled.settleAfterMs))
    act(() => result.current.cancelPendingSends())

    expect(settled.cancel).not.toHaveBeenCalled()
  })
})
