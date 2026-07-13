import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SkillDiscoveryTarget } from '../../../shared/skills'
import type {
  SkillManagementInstallation,
  SkillManagementInventory,
  SkillReplacementPreview
} from '../../../shared/skill-management'
import { useMountedRef } from './useMountedRef'

const INSTALLED_SKILLS_CHANGED_EVENT = 'orca:installed-agent-skills-changed'
const cachedInventory = new Map<string, SkillManagementInventory>()
const pendingInventory = new Map<string, Promise<SkillManagementInventory>>()

function targetKey(target: SkillDiscoveryTarget | undefined): string {
  if (target?.projectRuntime) {
    return target.projectRuntime.status === 'resolved'
      ? target.projectRuntime.runtime.cacheKey
      : target.projectRuntime.repair.cacheKey
  }
  return target?.runtime === 'wsl' ? `wsl:${target.wslDistro ?? ''}` : 'host'
}

async function loadInventory(
  target: SkillDiscoveryTarget | undefined,
  force: boolean
): Promise<SkillManagementInventory> {
  const key = targetKey(target)
  if (!force && cachedInventory.has(key)) {
    return cachedInventory.get(key)!
  }
  const pending = pendingInventory.get(key)
  if (pending) {
    return pending
  }
  const request = window.api.skills
    .managementInventory(target)
    .then((inventory) => {
      cachedInventory.set(key, inventory)
      return inventory
    })
    .finally(() => pendingInventory.delete(key))
  pendingInventory.set(key, request)
  return request
}

export type ManagedAgentSkillsState = {
  inventory: SkillManagementInventory | null
  loading: boolean
  busyInstallationId: string | null
  error: string | null
  refresh: () => Promise<void>
  manage: (installationId: string) => Promise<void>
  update: (installationId: string) => Promise<void>
  dismiss: (installation: SkillManagementInstallation) => Promise<void>
  previewReplacement: (installationId: string) => Promise<SkillReplacementPreview>
  replace: (installationId: string) => Promise<void>
}

export function useManagedAgentSkills(target?: SkillDiscoveryTarget): ManagedAgentSkillsState {
  const key = targetKey(target)
  const [inventory, setInventory] = useState<SkillManagementInventory | null>(
    cachedInventory.get(key) ?? null
  )
  const [loading, setLoading] = useState(!cachedInventory.has(key))
  const [busyInstallationId, setBusyInstallationId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useMountedRef()
  const currentKeyRef = useRef(key)
  currentKeyRef.current = key

  const accept = useCallback(
    (requestKey: string, next: SkillManagementInventory): void => {
      cachedInventory.set(requestKey, next)
      if (mountedRef.current && currentKeyRef.current === requestKey) {
        setInventory(next)
        setError(null)
      }
    },
    [mountedRef]
  )

  const refresh = useCallback(async (): Promise<void> => {
    const requestKey = key
    setLoading(true)
    try {
      accept(requestKey, await loadInventory(target, true))
    } catch (cause) {
      if (mountedRef.current && currentKeyRef.current === requestKey) {
        setError(cause instanceof Error ? cause.message : 'Failed to inspect agent skills.')
      }
    } finally {
      if (mountedRef.current && currentKeyRef.current === requestKey) {
        setLoading(false)
      }
    }
  }, [accept, key, mountedRef, target])

  useEffect(() => {
    const requestKey = key
    setInventory(cachedInventory.get(requestKey) ?? null)
    setLoading(true)
    void loadInventory(target, false)
      .then((next) => accept(requestKey, next))
      .catch((cause) => {
        if (mountedRef.current && currentKeyRef.current === requestKey) {
          setError(cause instanceof Error ? cause.message : 'Failed to inspect agent skills.')
        }
      })
      .finally(() => {
        if (mountedRef.current && currentKeyRef.current === requestKey) {
          setLoading(false)
        }
      })
  }, [accept, key, mountedRef, target])

  useEffect(() => {
    const invalidate = (): void => {
      cachedInventory.delete(key)
      void refresh()
    }
    window.addEventListener(INSTALLED_SKILLS_CHANGED_EVENT, invalidate)
    window.addEventListener('focus', invalidate)
    return () => {
      window.removeEventListener(INSTALLED_SKILLS_CHANGED_EVENT, invalidate)
      window.removeEventListener('focus', invalidate)
    }
  }, [key, refresh])

  const runAction = useCallback(
    async (
      installationId: string,
      action: () => Promise<SkillManagementInventory>
    ): Promise<void> => {
      setBusyInstallationId(installationId)
      try {
        accept(key, await action())
      } catch (cause) {
        if (mountedRef.current) {
          setError(cause instanceof Error ? cause.message : 'Agent skill action failed.')
        }
        throw cause
      } finally {
        if (mountedRef.current) {
          setBusyInstallationId(null)
        }
      }
    },
    [accept, key, mountedRef]
  )

  return useMemo(
    () => ({
      inventory,
      loading,
      busyInstallationId,
      error,
      refresh,
      manage: (installationId: string) =>
        runAction(installationId, () => window.api.skills.adopt({ installationId, target })),
      update: (installationId: string) =>
        runAction(installationId, () =>
          window.api.skills.updateManaged({ installationId, target })
        ),
      dismiss: (installation: SkillManagementInstallation) => {
        const physicalIdentity = installation.physicalIdentity
        const snapshotDigest = installation.installedPackageDigest
        if (!physicalIdentity || !snapshotDigest) {
          return Promise.reject(new Error('skill-adoption-candidate-incomplete'))
        }
        return runAction(installation.id, () =>
          window.api.skills.dismissAdoption({
            candidate: {
              hostId: installation.hostId,
              physicalIdentity,
              skillName: installation.name,
              snapshotDigest
            },
            target
          })
        )
      },
      previewReplacement: (installationId: string) =>
        window.api.skills.previewReplacement({ installationId, target }),
      replace: (installationId: string) =>
        runAction(installationId, () => window.api.skills.replace({ installationId, target }))
    }),
    [busyInstallationId, error, inventory, loading, refresh, runAction, target]
  )
}
