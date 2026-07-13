import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useManagedAgentSkills } from '@/hooks/useManagedAgentSkills'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

export function ManagedSkillAdoptionNudge(): null {
  const state = useManagedAgentSkills()
  const shownKeys = useRef(new Set<string>())
  const persistedKeys = useRef(new Set<string>())
  const openSettingsPage = useAppStore((store) => store.openSettingsPage)
  const openSettingsTarget = useAppStore((store) => store.openSettingsTarget)

  useEffect(() => {
    const candidates =
      state.inventory?.installations.filter(
        (installation) => installation.adoptionPromptEligible
      ) ?? []
    const candidateKey = (candidate: (typeof candidates)[number]): string =>
      [
        candidate.hostId,
        candidate.physicalIdentity,
        candidate.name,
        candidate.installedPackageDigest
      ].join('\0')
    const unseen = candidates.filter((candidate) => !shownKeys.current.has(candidateKey(candidate)))
    if (unseen.length === 0) {
      return
    }
    for (const candidate of unseen) {
      shownKeys.current.add(candidateKey(candidate))
    }
    const persistDismissal = (): void => {
      const pending = unseen.filter((candidate) => {
        const key = candidateKey(candidate)
        if (persistedKeys.current.has(key)) {
          return false
        }
        persistedKeys.current.add(key)
        return true
      })
      // Why: Sonner may report action, dismiss, and auto-close for one toast;
      // each exact tuple must reach the durable ledger only once.
      void pending.reduce(
        (settled, candidate) => settled.then(() => state.dismiss(candidate)),
        Promise.resolve()
      )
    }
    const count = unseen.length
    toast.info(
      translate(
        'auto.components.managedSkills.adoptionNudge.title',
        '{{value0}} installed Orca skills can be kept up to date',
        { value0: count }
      ),
      {
        description: translate(
          'auto.components.managedSkills.adoptionNudge.description',
          'Review exact official copies before Orca manages them.'
        ),
        duration: 12_000,
        onDismiss: persistDismissal,
        onAutoClose: persistDismissal,
        action: {
          label: translate('auto.components.managedSkills.adoptionNudge.review', 'Review'),
          onClick: () => {
            openSettingsTarget({ pane: 'agents', repoId: null })
            openSettingsPage()
            persistDismissal()
          }
        }
      }
    )
  }, [openSettingsPage, openSettingsTarget, state])

  return null
}
