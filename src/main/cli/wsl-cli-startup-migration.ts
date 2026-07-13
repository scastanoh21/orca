import type { CliInstallState } from '../../shared/cli-install-types'
import { listWslDistrosAsync } from '../wsl'
import { CliInstaller } from './cli-installer'
import { WslCliInstaller } from './wsl-cli-installer'

type ManagedWslCliInstaller = {
  repairManagedRegistration: () => Promise<{
    changed: boolean
    status: { state: CliInstallState }
  }>
}

type ManagedWslCliMigrationOptions = {
  platform?: NodeJS.Platform
  isPackaged: boolean
  listDistros?: () => Promise<string[]>
  createInstaller?: (distro: string) => ManagedWslCliInstaller
}

export type ManagedWslCliMigrationResult =
  | {
      distro: string
      outcome: 'repaired' | 'unchanged'
      state: CliInstallState
    }
  | {
      distro: string
      outcome: 'failed'
      error: string
    }

export async function repairManagedWslCliRegistrations(
  options: ManagedWslCliMigrationOptions
): Promise<ManagedWslCliMigrationResult[]> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32' || !options.isPackaged) {
    return []
  }

  const distros = await (options.listDistros ?? listWslDistrosAsync)()
  let createInstaller = options.createInstaller
  if (!createInstaller) {
    const hostInstaller = new CliInstaller()
    let hostStatus: ReturnType<CliInstaller['getStatus']> | null = null
    // Why: every distro must target this app install; share one Windows PATH /
    // launcher probe instead of spawning a PowerShell probe per distro.
    createInstaller = (distro: string) =>
      new WslCliInstaller({
        distro,
        hostInstaller: {
          getStatus: () => (hostStatus ??= hostInstaller.getStatus())
        }
      })
  }

  // Why: one unavailable distro must not prevent an installed registration in
  // another distro from being repaired before orchestration starts.
  return Promise.all(
    distros.map(async (distro): Promise<ManagedWslCliMigrationResult> => {
      try {
        const repair = await createInstaller(distro).repairManagedRegistration()
        return {
          distro,
          outcome: repair.changed ? 'repaired' : 'unchanged',
          state: repair.status.state
        }
      } catch (error) {
        return {
          distro,
          outcome: 'failed',
          error: error instanceof Error ? error.message : String(error)
        }
      }
    })
  )
}
