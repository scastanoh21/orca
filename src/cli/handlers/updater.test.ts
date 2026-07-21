import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus, UpdateStatusSnapshot, UpdateStatusWaitResult } from '../../shared/types'
import type { HandlerContext } from '../dispatch'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'
import type { RuntimeClient } from '../runtime-client'
import { UPDATER_HANDLERS } from './updater'

function success<T>(result: T): RuntimeRpcSuccess<T> {
  return {
    id: 'req-1',
    ok: true,
    result,
    _meta: { runtimeId: 'runtime-1' }
  }
}

function snapshot(status: UpdateStatus, revision = 1): RuntimeRpcSuccess<UpdateStatusSnapshot> {
  return success({ revision, status })
}

function changedStatus(
  status: UpdateStatus,
  revision = 2
): RuntimeRpcSuccess<UpdateStatusWaitResult> {
  return success({ revision, status, timedOut: false })
}

describe('updater CLI handlers', () => {
  const getAppVersion = vi.fn()
  const checkForUpdate = vi.fn()
  const downloadUpdate = vi.fn()
  const waitForUpdateStatus = vi.fn()
  const installUpdate = vi.fn()
  const client = {
    getAppVersion,
    checkForUpdate,
    downloadUpdate,
    waitForUpdateStatus,
    installUpdate
  } as unknown as RuntimeClient
  let log: ReturnType<typeof vi.spyOn>
  let previousExitCode: typeof process.exitCode
  let stdoutIsTtyDescriptor: PropertyDescriptor | undefined

  function invokeUpdate(flags = new Map<string, string | boolean>(), json = true): Promise<void> {
    const context: HandlerContext = {
      client,
      flags,
      cwd: '/tmp/repo',
      json
    }
    return UPDATER_HANDLERS.update(context)
  }

  beforeEach(() => {
    vi.resetAllMocks()
    previousExitCode = process.exitCode
    stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    process.exitCode = undefined
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    getAppVersion.mockResolvedValue(success({ version: '1.4.0' }))
    installUpdate.mockResolvedValue(success({ ok: true }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (stdoutIsTtyDescriptor) {
      Object.defineProperty(process.stdout, 'isTTY', stdoutIsTtyDescriptor)
    } else {
      Reflect.deleteProperty(process.stdout, 'isTTY')
    }
    process.exitCode = previousExitCode
  })

  it('reports the app version as plain text', async () => {
    await UPDATER_HANDLERS.version({
      client,
      flags: new Map(),
      cwd: '/tmp/repo',
      json: false
    })

    expect(getAppVersion).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('1.4.0')
  })

  it('downloads and installs an available update', async () => {
    checkForUpdate.mockResolvedValue(
      snapshot({ state: 'available', version: '1.5.0', changelog: null })
    )
    downloadUpdate.mockResolvedValue(snapshot({ state: 'downloaded', version: '1.5.0' }))

    await invokeUpdate()

    expect(checkForUpdate).toHaveBeenCalledWith(false)
    expect(downloadUpdate).toHaveBeenCalledOnce()
    expect(installUpdate).toHaveBeenCalledOnce()
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).result).toMatchObject({
      operation: 'update',
      status: { state: 'downloaded', version: '1.5.0' },
      installRequested: true
    })
  })

  it('reports an available update without downloading for --check', async () => {
    checkForUpdate.mockResolvedValue(
      snapshot({ state: 'available', version: '1.5.0', changelog: null })
    )

    await invokeUpdate(new Map([['check', true]]))

    expect(downloadUpdate).not.toHaveBeenCalled()
    expect(installUpdate).not.toHaveBeenCalled()
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).result).toMatchObject({
      operation: 'check',
      status: { state: 'available' },
      installRequested: false
    })
  })

  it('waits for an event-driven check until availability is known', async () => {
    checkForUpdate.mockResolvedValue(snapshot({ state: 'checking' }))
    waitForUpdateStatus.mockResolvedValue(
      changedStatus({ state: 'available', version: '1.5.0', changelog: null })
    )

    await invokeUpdate(new Map([['check', true]]))

    expect(waitForUpdateStatus).toHaveBeenCalledWith(1, 25_000)
    expect(downloadUpdate).not.toHaveBeenCalled()
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).result.status.state).toBe('available')
  })

  it('attaches to an in-progress download instead of starting a new one', async () => {
    checkForUpdate.mockResolvedValue(
      snapshot({ state: 'downloading', version: '1.5.0', percent: 30 })
    )
    waitForUpdateStatus.mockResolvedValue(changedStatus({ state: 'downloaded', version: '1.5.0' }))

    await invokeUpdate()

    expect(downloadUpdate).not.toHaveBeenCalled()
    expect(installUpdate).toHaveBeenCalledOnce()
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).result).toMatchObject({
      operation: 'update',
      status: { state: 'downloaded', version: '1.5.0' },
      installRequested: true
    })
  })

  it('installs an already-downloaded update without re-downloading', async () => {
    checkForUpdate.mockResolvedValue(snapshot({ state: 'downloaded', version: '1.5.0' }))

    await invokeUpdate()

    expect(downloadUpdate).not.toHaveBeenCalled()
    expect(installUpdate).toHaveBeenCalledOnce()
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).result).toMatchObject({
      operation: 'update',
      status: { state: 'downloaded', version: '1.5.0' },
      installRequested: true
    })
  })

  it('reports an in-progress download for --check without installing', async () => {
    checkForUpdate.mockResolvedValue(
      snapshot({ state: 'downloading', version: '1.5.0', percent: 30 })
    )

    await invokeUpdate(new Map([['check', true]]))

    expect(downloadUpdate).not.toHaveBeenCalled()
    expect(installUpdate).not.toHaveBeenCalled()
    expect(waitForUpdateStatus).not.toHaveBeenCalled()
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).result).toMatchObject({
      operation: 'check',
      status: { state: 'downloading', version: '1.5.0', percent: 30 },
      installRequested: false
    })
  })

  it('reports that Orca is up to date', async () => {
    checkForUpdate.mockResolvedValue(snapshot({ state: 'not-available' }))

    await invokeUpdate()

    expect(downloadUpdate).not.toHaveBeenCalled()
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).result.status).toEqual({
      state: 'not-available'
    })
    expect(process.exitCode).toBeUndefined()
  })

  it('reports updater errors and sets a failing exit code', async () => {
    checkForUpdate.mockResolvedValue(snapshot({ state: 'error', message: 'feed unavailable' }))

    await invokeUpdate(new Map([['check', true]]))

    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).result.status).toEqual({
      state: 'error',
      message: 'feed unavailable'
    })
    expect(process.exitCode).toBe(1)
  })

  it('adds actionable recovery when the app is unreachable', async () => {
    checkForUpdate.mockRejectedValue(
      new RuntimeClientError('runtime_unavailable', 'Could not connect to Orca.')
    )

    await expect(invokeUpdate()).rejects.toMatchObject({
      code: 'runtime_unavailable',
      message: "Could not reach Orca's desktop updater.",
      data: {
        nextSteps: expect.arrayContaining([
          'Open Orca, then retry the command.',
          'Download the latest Orca release from https://onorca.dev/download.'
        ])
      }
    })
  })

  it('forwards the prerelease choice', async () => {
    checkForUpdate.mockResolvedValue(snapshot({ state: 'not-available' }))

    await invokeUpdate(new Map([['prerelease', true]]))

    expect(checkForUpdate).toHaveBeenCalledWith(true)
  })

  it('updates download progress in place on a TTY and closes the line', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    checkForUpdate.mockResolvedValue(
      snapshot({ state: 'available', version: '1.5.0', changelog: null })
    )
    downloadUpdate.mockResolvedValue(
      snapshot({ state: 'downloading', version: '1.5.0', percent: 1 }, 2)
    )
    waitForUpdateStatus
      .mockResolvedValueOnce(
        changedStatus({ state: 'downloading', version: '1.5.0', percent: 42 }, 3)
      )
      .mockResolvedValueOnce(changedStatus({ state: 'downloaded', version: '1.5.0' }, 4))

    await invokeUpdate(new Map(), false)

    expect(write.mock.calls.map(([chunk]) => chunk)).toEqual([
      '\rDownloading Orca 1.5.0… 1%',
      '\rDownloading Orca 1.5.0… 42%',
      '\n'
    ])
  })

  it('never emits carriage returns for non-TTY download progress', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    checkForUpdate.mockResolvedValue(
      snapshot({ state: 'available', version: '1.5.0', changelog: null })
    )
    downloadUpdate.mockResolvedValue(
      snapshot({ state: 'downloading', version: '1.5.0', percent: 1 }, 2)
    )
    waitForUpdateStatus.mockResolvedValue(
      changedStatus({ state: 'downloaded', version: '1.5.0' }, 3)
    )

    await invokeUpdate(new Map(), false)

    expect(write).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('Downloading Orca 1.5.0… 1%')
  })

  it('keeps JSON output unchanged even when stdout is a TTY', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    checkForUpdate.mockResolvedValue(
      snapshot({ state: 'available', version: '1.5.0', changelog: null })
    )
    downloadUpdate.mockResolvedValue(
      snapshot({ state: 'downloading', version: '1.5.0', percent: 1 }, 2)
    )
    waitForUpdateStatus.mockResolvedValue(
      changedStatus({ state: 'downloaded', version: '1.5.0' }, 3)
    )

    await invokeUpdate()

    expect(write).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledOnce()
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).result).toMatchObject({
      status: { state: 'downloaded', version: '1.5.0' },
      installRequested: true
    })
  })
})
