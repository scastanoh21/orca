import { ipcMain } from 'electron'
import { agentHookServer, isValidPaneKey } from '../agent-hooks/server'
import { clearMigrationUnsupportedPtysForPaneKey } from '../agent-hooks/migration-unsupported-pty-state'

export function registerAgentPaneAuthorityIpcHandlers(): void {
  ipcMain.removeAllListeners('agentStatus:retirePaneAuthority')
  ipcMain.removeAllListeners('agentStatus:transferPaneAuthority')
  ipcMain.on('agentStatus:retirePaneAuthority', (_event, paneKey: unknown) => {
    if (typeof paneKey !== 'string' || !isValidPaneKey(paneKey)) {
      return
    }
    try {
      agentHookServer.retirePaneAuthority(paneKey)
      clearMigrationUnsupportedPtysForPaneKey(paneKey)
    } catch (err) {
      console.warn('[agent-hooks] retirePaneAuthority failed:', err)
    }
  })
  ipcMain.on('agentStatus:transferPaneAuthority', (_event, value: unknown) => {
    if (!value || typeof value !== 'object') {
      return
    }
    const args = value as Record<string, unknown>
    if (
      typeof args.fromPaneKey !== 'string' ||
      typeof args.toPaneKey !== 'string' ||
      !isValidPaneKey(args.fromPaneKey) ||
      !isValidPaneKey(args.toPaneKey) ||
      (args.ptyId !== undefined &&
        (typeof args.ptyId !== 'string' || args.ptyId.trim().length === 0))
    ) {
      return
    }
    try {
      agentHookServer.transferPaneAuthority(
        args.fromPaneKey,
        args.toPaneKey,
        typeof args.ptyId === 'string' ? args.ptyId : undefined
      )
    } catch (err) {
      console.warn('[agent-hooks] transferPaneAuthority failed:', err)
    }
  })
}
