import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'

const updaterMocks = vi.hoisted(() => ({
  checkForUpdatesFromMenu: vi.fn(),
  downloadUpdate: vi.fn(),
  getUpdateStatus: vi.fn(),
  quitAndInstall: vi.fn(),
  getVersion: vi.fn()
}))

vi.mock('electron', () => ({ app: { getVersion: updaterMocks.getVersion } }))
vi.mock('../../../updater', () => ({
  checkForUpdatesFromMenu: updaterMocks.checkForUpdatesFromMenu,
  downloadUpdate: updaterMocks.downloadUpdate,
  getUpdateStatus: updaterMocks.getUpdateStatus,
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
  })

  it('reports the app version', async () => {
    const response = await makeDispatcher().dispatch(makeRequest('updater.getVersion'))

    expect(response).toMatchObject({ ok: true, result: { version: '1.2.3' } })
  })

  it('returns the current updater status', async () => {
    updaterMocks.getUpdateStatus.mockReturnValue({
      state: 'downloading',
      percent: 42,
      version: '2'
    })

    const response = await makeDispatcher().dispatch(makeRequest('updater.getStatus'))

    expect(response).toMatchObject({
      ok: true,
      result: { state: 'downloading', percent: 42, version: '2' }
    })
  })

  it('starts a prerelease check and returns its immediate status', async () => {
    updaterMocks.getUpdateStatus.mockReturnValue({ state: 'checking', userInitiated: true })

    const response = await makeDispatcher().dispatch(
      makeRequest('updater.check', { includePrerelease: true })
    )

    expect(updaterMocks.checkForUpdatesFromMenu).toHaveBeenCalledWith({
      includePrerelease: true
    })
    expect(response).toMatchObject({ ok: true, result: { state: 'checking' } })
  })

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
    updaterMocks.getUpdateStatus.mockReturnValue({
      state: 'downloading',
      percent: 0,
      version: '2.0.0'
    })

    const response = await makeDispatcher().dispatch(makeRequest('updater.download'))

    expect(updaterMocks.downloadUpdate).toHaveBeenCalledOnce()
    expect(response).toMatchObject({ ok: true, result: { state: 'downloading' } })
  })

  it('requests installation', async () => {
    const response = await makeDispatcher().dispatch(makeRequest('updater.install'))

    expect(updaterMocks.quitAndInstall).toHaveBeenCalledOnce()
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })
})
