import type { UpdateStatus } from '../shared/types'

export type UpdateCommandResult = {
  operation: 'check' | 'update'
  status: UpdateStatus
  installRequested: boolean
  timedOut?: boolean
}

export function formatAppVersion(result: { version: string }): string {
  return result.version
}

export function formatUpdateResult(result: UpdateCommandResult): string {
  const { status } = result
  if (result.timedOut) {
    if (status.state === 'downloading') {
      return `Timed out waiting for Orca ${status.version} to download (${formatPercent(status.percent)}).`
    }
    return 'Timed out waiting for Orca to finish checking for updates.'
  }

  switch (status.state) {
    case 'available':
      return `Update available: Orca ${status.version}.`
    case 'not-available':
      return 'Orca is up to date.'
    case 'error':
      return `${result.operation === 'check' ? 'Update check' : 'Update'} failed: ${status.message}`
    case 'downloaded':
      return result.installRequested
        ? `Installing Orca ${status.version}. Orca will quit and restart to finish the update.`
        : `Orca ${status.version} is downloaded and ready to install.`
    case 'downloading':
      return `Downloading Orca ${status.version}: ${formatPercent(status.percent)}`
    case 'checking':
      return 'Checking for Orca updates...'
    case 'idle':
      return 'The Orca updater is idle.'
  }
}

export function formatUpdateProgress(status: UpdateStatus): string | null {
  switch (status.state) {
    case 'checking':
      return 'Checking for Orca updates...'
    case 'available':
      return `Update available: Orca ${status.version}. Downloading...`
    case 'downloading':
      return `Downloading Orca ${status.version}… ${formatPercent(status.percent)}`
    case 'downloaded':
      return `Orca ${status.version} downloaded. Requesting installation...`
    case 'idle':
    case 'not-available':
    case 'error':
      return null
  }
}

function formatPercent(percent: number): string {
  return `${Math.max(0, Math.min(100, percent)).toFixed(0)}%`
}
