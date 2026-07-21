import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from './client'

describe('RuntimeClient updater methods', () => {
  const client = new RuntimeClient('/tmp/orca-updater-client-test', 100, null, null)
  const call = vi.spyOn(client, 'call')

  beforeEach(() => {
    call.mockReset().mockResolvedValue({
      id: 'req-1',
      ok: true,
      result: { state: 'idle' },
      _meta: { runtimeId: 'runtime-1' }
    })
  })

  it('maps the version and status methods', async () => {
    await client.getAppVersion()
    await client.getUpdateStatus()
    await client.waitForUpdateStatus(4, 25_000)

    expect(call).toHaveBeenNthCalledWith(1, 'updater.getVersion')
    expect(call).toHaveBeenNthCalledWith(2, 'updater.getStatus')
    expect(call).toHaveBeenNthCalledWith(3, 'updater.wait', {
      afterRevision: 4,
      timeoutMs: 25_000
    })
  })

  it('maps check options and update actions', async () => {
    await client.checkForUpdate(true)
    await client.downloadUpdate()
    await client.installUpdate()

    expect(call).toHaveBeenNthCalledWith(1, 'updater.check', { includePrerelease: true })
    expect(call).toHaveBeenNthCalledWith(2, 'updater.download')
    expect(call).toHaveBeenNthCalledWith(3, 'updater.install')
  })
})
