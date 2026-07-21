import { z } from 'zod'
import { defineMethod, InvalidArgumentError, type RpcMethod } from '../core'

const UpdaterCheckParams = z.object({
  includePrerelease: z.boolean().optional()
})

const UpdaterWaitParams = z.object({
  afterRevision: z.number().int().nonnegative(),
  timeoutMs: z.number().int().min(1).max(30_000)
})

/**
 * RPC methods that expose the desktop app's existing electron-updater flow to the
 * CLI: read the version/status, check, download, and install. Deliberately not on
 * the mobile allowlist so only the local CLI and the trusted SSH relay can install.
 */
export const UPDATER_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'updater.getVersion',
    params: null,
    handler: async () => {
      const { app } = await import('electron')
      return { version: app.getVersion() }
    }
  }),
  defineMethod({
    name: 'updater.getStatus',
    params: null,
    handler: async () => {
      const { getUpdateStatusSnapshot } = await loadUpdater()
      return getUpdateStatusSnapshot()
    }
  }),
  defineMethod({
    name: 'updater.wait',
    params: UpdaterWaitParams,
    handler: async (params, { signal }) => {
      const { waitForUpdateStatusChange } = await loadUpdater()
      return await waitForUpdateStatusChange(params.afterRevision, params.timeoutMs, signal)
    }
  }),
  defineMethod({
    name: 'updater.check',
    params: UpdaterCheckParams,
    handler: async (params) => {
      const { checkForUpdatesFromMenu, getUpdateStatusSnapshot } = await loadUpdater()
      const current = getUpdateStatusSnapshot()
      if (current.status.state === 'downloading' || current.status.state === 'downloaded') {
        // Why: starting a check replaces the authoritative download state, so callers attach instead.
        return current
      }
      checkForUpdatesFromMenu(params)
      // Why: electron-updater completes through events; callers wait on the shared status.
      return getUpdateStatusSnapshot()
    }
  }),
  defineMethod({
    name: 'updater.download',
    params: null,
    handler: async () => {
      const { downloadUpdate, getUpdateStatusSnapshot } = await loadUpdater()
      downloadUpdate()
      return getUpdateStatusSnapshot()
    }
  }),
  defineMethod({
    name: 'updater.install',
    params: null,
    handler: async () => {
      const { getUpdateStatus, quitAndInstall } = await loadUpdater()
      if (getUpdateStatus().state !== 'downloaded') {
        throw new InvalidArgumentError('The update is not downloaded and ready to install.')
      }
      quitAndInstall()
      return { ok: true }
    }
  })
]

/** Lazily imports the updater module. */
async function loadUpdater() {
  // Why: the registry is also inspected in plain Node processes where Electron's desktop exports are unavailable.
  return await import('../../../updater')
}
