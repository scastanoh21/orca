import { useCallback, useRef, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { EmulatorDeviceVisualOrientation } from './emulator-device-frame-layout'
import type { EmulatorGesturePoint } from './emulator-screen-gesture'

export function useEmulatorPaneControls(worktreeId: string) {
  const nextRotateOrientationRef = useRef<'landscape_left' | 'portrait'>('landscape_left')
  const [visualOrientation, setVisualOrientation] =
    useState<EmulatorDeviceVisualOrientation>('portrait')

  const sendTap = useCallback(
    async (x: number, y: number) => {
      await callRuntimeRpc({ kind: 'local' }, 'emulator.tap', { x, y, worktree: worktreeId })
    },
    [worktreeId]
  )

  const sendButton = useCallback(
    async (name: string) => {
      await callRuntimeRpc({ kind: 'local' }, 'emulator.button', { name, worktree: worktreeId })
    },
    [worktreeId]
  )

  const sendGesture = useCallback(
    async (points: EmulatorGesturePoint[]) => {
      await callRuntimeRpc({ kind: 'local' }, 'emulator.gesture', { points, worktree: worktreeId })
    },
    [worktreeId]
  )

  const sendRotate = useCallback(async () => {
    const orientation = nextRotateOrientationRef.current
    await callRuntimeRpc({ kind: 'local' }, 'emulator.rotate', {
      orientation,
      worktree: worktreeId
    })
    setVisualOrientation(orientation === 'landscape_left' ? 'landscape' : 'portrait')
    nextRotateOrientationRef.current =
      orientation === 'landscape_left' ? 'portrait' : 'landscape_left'
  }, [worktreeId])

  const resetVisualOrientation = useCallback(() => {
    nextRotateOrientationRef.current = 'landscape_left'
    setVisualOrientation('portrait')
  }, [])

  return { sendTap, sendButton, sendGesture, sendRotate, visualOrientation, resetVisualOrientation }
}
