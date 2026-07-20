import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'

const UpdaterCheckParams = z.object({
  includePrerelease: z.boolean().optional()
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
      const { getUpdateStatus } = await loadUpdater()
      return getUpdateStatus()
    }
  }),
  defineMethod({
    name: 'updater.check',
    params: UpdaterCheckParams,
    handler: async (params) => {
      const { checkForUpdatesFromMenu, getUpdateStatus } = await loadUpdater()
      checkForUpdatesFromMenu(params)
      // Why: electron-updater completes through events; callers poll the shared status.
      return getUpdateStatus()
    }
  }),
  defineMethod({
    name: 'updater.download',
    params: null,
    handler: async () => {
      const { downloadUpdate, getUpdateStatus } = await loadUpdater()
      downloadUpdate()
      return getUpdateStatus()
    }
  }),
  defineMethod({
    name: 'updater.install',
    params: null,
    handler: async () => {
      const { quitAndInstall } = await loadUpdater()
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
