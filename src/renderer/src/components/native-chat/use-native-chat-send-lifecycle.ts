import { useCallback, useEffect, useRef } from 'react'
import type { NativeChatSendHandle } from './native-chat-runtime-send'

export type NativeChatSendLifecycle = {
  cancelPendingSends: () => void
  trackPendingSend: (handle: NativeChatSendHandle) => void
}

export function useNativeChatSendLifecycle(
  terminalTabId: string,
  targetPtyId: string | null
): NativeChatSendLifecycle {
  const pendingSendHandlesRef = useRef(
    new Map<NativeChatSendHandle, ReturnType<typeof setTimeout>>()
  )
  const cancelPendingSends = useCallback(() => {
    for (const [handle, cleanupTimer] of pendingSendHandlesRef.current) {
      clearTimeout(cleanupTimer)
      handle.cancel()
    }
    pendingSendHandlesRef.current.clear()
  }, [])
  const trackPendingSend = useCallback((handle: NativeChatSendHandle) => {
    const cleanupTimer = setTimeout(() => {
      pendingSendHandlesRef.current.delete(handle)
    }, handle.settleAfterMs)
    pendingSendHandlesRef.current.set(handle, cleanupTimer)
  }, [])

  // Why: delayed Enter/image writes belong to the exact PTY target. A pane
  // swap or unmount must cancel them before that PTY can close or be reused.
  useEffect(() => cancelPendingSends, [cancelPendingSends, targetPtyId, terminalTabId])

  return { cancelPendingSends, trackPendingSend }
}
