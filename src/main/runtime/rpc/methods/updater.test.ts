import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'

const updaterMocks = vi.hoisted(() => ({
  checkForUpdatesFromMenu: vi.fn(),
  downloadUpdate: vi.fn(),
  getUpdateStatus: vi.fn(),
  getUpdateStatusSnapshot: vi.fn(),
  waitForUpdateStatusChange: vi.fn(),
  quitAndInstall: vi.fn(),
  getVersion: vi.fn()
}))

vi.mock('electron', () => ({ app: { getVersion: updaterMocks.getVersion } }))
vi.mock('../../../updater', () => ({
  checkForUpdatesFromMenu: updaterMocks.checkForUpdatesFromMenu,
  downloadUpdate: updaterMocks.downloadUpdate,
  getUpdateStatus: updaterMocks.getUpdateStatus,
  getUpdateStatusSnapshot: updaterMocks.getUpdateStatusSnapshot,
  waitForUpdateStatusChange: updaterMocks.waitForUpdateStatusChange,
  quitAndInstall: updaterMocks.quitAndInstall
}))

import { UPDATER_METHODS } from './updater'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function makeDispatcher(): RpcDispatcher {
  const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: UPDATER_METHODS })
}

describe('updater RPC methods', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    updaterMocks.getVersion.mockReturnValue('1.2.3')
    updaterMocks.getUpdateStatus.mockReturnValue({ state: 'idle' })
    updaterMocks.getUpdateStatusSnapshot.mockReturnValue({
      revision: 1,
      status: { state: 'idle' }
    })
    updaterMocks.waitForUpdateStatusChange.mockResolvedValue({
      revision: 1,
      status: { state: 'idle' },
      timedOut: true
    })
  })

  it('reports the app version', async () => {
    const response = await makeDispatcher().dispatch(makeRequest('updater.getVersion'))

    expect(response).toMatchObject({ ok: true, result: { version: '1.2.3' } })
  })

  it('returns the current updater status', async () => {
    updaterMocks.getUpdateStatusSnapshot.mockReturnValue({
      revision: 2,
      status: { state: 'downloading', percent: 42, version: '2' }
    })

    const response = await makeDispatcher().dispatch(makeRequest('updater.getStatus'))

    expect(response).toMatchObject({
      ok: true,
      result: {
        revision: 2,
        status: { state: 'downloading', percent: 42, version: '2' }
      }
    })
  })

  it('waits for a status revision with the request abort signal', async () => {
    const controller = new AbortController()
    const response = await makeDispatcher().dispatch(
      makeRequest('updater.wait', { afterRevision: 1, timeoutMs: 25_000 }),
      { signal: controller.signal }
    )

    expect(updaterMocks.waitForUpdateStatusChange).toHaveBeenCalledWith(
      1,
      25_000,
      controller.signal
    )
    expect(response).toMatchObject({ ok: true, result: { timedOut: true } })
  })

  it('starts a prerelease check and returns its immediate status', async () => {
    updaterMocks.getUpdateStatusSnapshot
      .mockReturnValueOnce({ revision: 1, status: { state: 'idle' } })
      .mockReturnValueOnce({
        revision: 2,
        status: { state: 'checking', userInitiated: true }
      })

    const response = await makeDispatcher().dispatch(
      makeRequest('updater.check', { includePrerelease: true })
    )

    expect(updaterMocks.checkForUpdatesFromMenu).toHaveBeenCalledWith({
      includePrerelease: true
    })
    expect(response).toMatchObject({
      ok: true,
      result: { revision: 2, status: { state: 'checking' } }
    })
  })

  it.each(['downloading', 'downloaded'] as const)(
    'does not replace an existing %s state with a new check',
    async (state) => {
      const status =
        state === 'downloading'
          ? { state, percent: 42, version: '2.0.0' }
          : { state, version: '2.0.0' }
      updaterMocks.getUpdateStatusSnapshot.mockReturnValue({ revision: 3, status })

      const response = await makeDispatcher().dispatch(makeRequest('updater.check', {}))

      expect(updaterMocks.checkForUpdatesFromMenu).not.toHaveBeenCalled()
      expect(response).toMatchObject({ ok: true, result: { revision: 3, status } })
    }
  )

  it('accepts an omitted check options object and rejects invalid params', async () => {
    const dispatcher = makeDispatcher()

    await dispatcher.dispatch(makeRequest('updater.check'))
    const invalidResponse = await dispatcher.dispatch(
      makeRequest('updater.check', { includePrerelease: 'yes' })
    )

    expect(updaterMocks.checkForUpdatesFromMenu).toHaveBeenCalledWith({})
    expect(invalidResponse).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
  })

  it('starts a download and returns the resulting status', async () => {
    updaterMocks.getUpdateStatusSnapshot.mockReturnValue({
      revision: 2,
      status: { state: 'downloading', percent: 0, version: '2.0.0' }
    })

    const response = await makeDispatcher().dispatch(makeRequest('updater.download'))

    expect(updaterMocks.downloadUpdate).toHaveBeenCalledOnce()
    expect(response).toMatchObject({
      ok: true,
      result: { revision: 2, status: { state: 'downloading' } }
    })
  })

  it('requests installation', async () => {
    updaterMocks.getUpdateStatus.mockReturnValue({ state: 'downloaded', version: '2.0.0' })
    const response = await makeDispatcher().dispatch(makeRequest('updater.install'))

    expect(updaterMocks.quitAndInstall).toHaveBeenCalledOnce()
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })

  it('rejects installation before the update is downloaded', async () => {
    updaterMocks.getUpdateStatus.mockReturnValue({
      state: 'downloading',
      percent: 80,
      version: '2.0.0'
    })

    const response = await makeDispatcher().dispatch(makeRequest('updater.install'))

    expect(updaterMocks.quitAndInstall).not.toHaveBeenCalled()
    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  })
})
