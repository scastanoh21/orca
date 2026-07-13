import { homedir } from 'node:os'
import type { SkillDiscoveryTarget } from '../../shared/skills'
import { getDefaultWslDistro, getWslHome } from '../wsl'
import { LOCAL_EXECUTION_HOST_ID, toWslExecutionHostId } from '../../shared/execution-host'

export type SkillDiscoveryRuntimeTarget =
  | { runtime: 'host' }
  | { runtime: 'wsl'; wslDistro: string | null | undefined }

export function getSkillDiscoveryRuntimeTarget(
  target: SkillDiscoveryTarget | undefined
): SkillDiscoveryRuntimeTarget {
  if (target?.executionHostId && target.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
    throw new Error('Skill management is not available for remote execution hosts in Phase 1.')
  }
  const projectRuntime = target?.projectRuntime
  if (!projectRuntime) {
    return target?.runtime === 'wsl'
      ? { runtime: 'wsl', wslDistro: target.wslDistro }
      : { runtime: 'host' }
  }

  if (projectRuntime.status === 'repair-required') {
    throw new Error(
      `Project runtime requires repair before skill discovery: ${projectRuntime.repair.reason}`
    )
  }

  if (projectRuntime.runtime.kind === 'wsl') {
    return { runtime: 'wsl', wslDistro: projectRuntime.runtime.distro }
  }

  return { runtime: 'host' }
}

export function getSkillManagementHostContext(target: SkillDiscoveryTarget | undefined): {
  hostId: ReturnType<typeof toWslExecutionHostId> | typeof LOCAL_EXECUTION_HOST_ID
  homeDir: string
} {
  const runtimeTarget = getSkillDiscoveryRuntimeTarget(target)
  if (runtimeTarget.runtime === 'host') {
    return { hostId: LOCAL_EXECUTION_HOST_ID, homeDir: homedir() }
  }
  if (process.platform !== 'win32') {
    throw new Error('WSL skill management is only available on Windows.')
  }
  const distro = runtimeTarget.wslDistro?.trim() || getDefaultWslDistro()
  if (!distro) {
    throw new Error('No WSL distribution is available for skill management.')
  }
  const homeDir = getWslHome(distro)
  if (!homeDir) {
    throw new Error(`Could not resolve the WSL home directory for ${distro}.`)
  }
  return { hostId: toWslExecutionHostId(distro), homeDir }
}
