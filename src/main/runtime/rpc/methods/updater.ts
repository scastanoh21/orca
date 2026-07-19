import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'

const UpdaterCheckParams = z.object({
  includePrerelease: z.boolean().optional()
})

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

async function loadUpdater() {
  // Why: the registry is also inspected in plain Node processes where Electron's desktop exports are unavailable.
  return await import('../../../updater')
}
