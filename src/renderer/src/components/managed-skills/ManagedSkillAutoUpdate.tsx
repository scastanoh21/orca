import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useManagedAgentSkills } from '@/hooks/useManagedAgentSkills'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import { managedSkillDisplayName } from '@/components/settings/managed-skill-status-copy'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

export function ManagedSkillAutoUpdate(): null {
  const state = useManagedAgentSkills()
  const settings = useAppStore((store) => store.settings)
  const attemptedBundleKeys = useRef(new Set<string>())

  useEffect(() => {
    // Why: hydration must finish before honoring the default, or a disabled
    // toggle could race one batch request on every launch.
    if (!settings || settings.managedSkillAutoUpdateEnabled === false) {
      return
    }
    const pending = (state.inventory?.installations ?? []).filter(
      (installation) =>
        installation.managed &&
        installation.status === 'managed-update-available' &&
        installation.actionsSupported &&
        !attemptedBundleKeys.current.has(`${installation.id}\0${installation.currentPackageDigest}`)
    )
    if (pending.length === 0) {
      return
    }
    // Why: one attempt per destination per bundled release; outcomes stay
    // visible in settings, so focus-driven refreshes never re-run a batch.
    for (const installation of pending) {
      attemptedBundleKeys.current.add(`${installation.id}\0${installation.currentPackageDigest}`)
    }
    void window.api.skills
      .autoUpdateManaged()
      .then((result) => {
        if (result.updatedSkillNames.length === 0) {
          return
        }
        toast.success(
          result.updatedSkillNames.length === 1
            ? translate(
                'auto.components.managedSkills.autoUpdate.updated_one',
                'Updated the {{value0}} skill to the latest version.',
                { value0: managedSkillDisplayName(result.updatedSkillNames[0]!) }
              )
            : translate(
                'auto.components.managedSkills.autoUpdate.updated_other',
                'Updated {{value0}} Orca skills to their latest versions.',
                { value0: result.updatedSkillNames.length }
              )
        )
        notifyInstalledAgentSkillsChanged()
      })
      // Why: failures surface as update-failed rows in settings; repeating
      // them as toasts on every trigger would nag without adding a fix path.
      .catch(() => undefined)
  }, [settings, state.inventory])

  return null
}
