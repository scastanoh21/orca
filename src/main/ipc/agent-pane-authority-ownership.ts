export type AgentPaneAuthorityOwnershipSources = {
  getPtyIdForPaneKey?: (paneKey: string) => string | undefined
  getRuntimeTerminalHandleForPaneKey?: (paneKey: string) => string | undefined
}

function getRemoteRuntimeHandle(ptyId: string): string | null {
  if (!ptyId.startsWith('remote:')) {
    return null
  }
  const encodedHandle = ptyId.includes('@@') ? ptyId.slice(ptyId.indexOf('@@') + 2) : ptyId.slice(7)
  try {
    return decodeURIComponent(encodedHandle)
  } catch {
    return null
  }
}

export function createAgentPaneAuthorityOwnership(
  sources: AgentPaneAuthorityOwnershipSources
): (paneKey: string, ptyId: string) => boolean {
  return (paneKey, ptyId) => {
    if (sources.getPtyIdForPaneKey?.(paneKey) === ptyId) {
      return true
    }
    const runtimeHandle = sources.getRuntimeTerminalHandleForPaneKey?.(paneKey)
    return Boolean(runtimeHandle && getRemoteRuntimeHandle(ptyId) === runtimeHandle)
  }
}
