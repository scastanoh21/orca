import { useMemo, useRef } from 'react'
import { toast } from 'sonner'
import type { SkillDiscoveryTarget } from '../../../../shared/skills'
import { useManagedAgentSkills } from '@/hooks/useManagedAgentSkills'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { managedSkillStatusCopy } from './managed-skill-status-copy'
import { isSuccessfulSkillInstallExit } from './skill-install-terminal-exit'

export function useAgentSkillManagementActions(args: {
  installed: boolean
  skillNames: readonly string[]
  target?: SkillDiscoveryTarget
}) {
  const state = useManagedAgentSkills(args.target)
  const installAttemptStartedAtRef = useRef<number | null>(null)
  const openSettingsPage = useAppStore((store) => store.openSettingsPage)
  const openSettingsTarget = useAppStore((store) => store.openSettingsTarget)
  const skillNamesKey = args.skillNames.join('\0')
  const installation = useMemo(() => {
    const names = new Set(skillNamesKey.split('\0').filter(Boolean))
    return state.inventory?.installations.find((entry) => names.has(entry.name))
  }, [skillNamesKey, state.inventory])

  const openSettings = (): void => {
    openSettingsTarget({ pane: 'agents', repoId: null })
    openSettingsPage()
  }
  const actionLabel = (() => {
    if (installation && !installation.actionsSupported) {
      return translate('auto.components.settings.AgentSkillSetupPanel.review', 'Review')
    }
    switch (installation?.status) {
      case 'known-current':
        return translate('auto.components.settings.AgentSkillSetupPanel.manage', 'Track updates')
      case 'known-update-available':
        return translate(
          'auto.components.settings.AgentSkillSetupPanel.manageUpdate',
          'Track & update'
        )
      case 'managed-update-available':
        return translate('auto.components.settings.AgentSkillSetupPanel.update', 'Update')
      case 'update-failed':
        return translate(
          'auto.components.settings.AgentSkillSetupPanel.retryUpdate',
          'Retry update'
        )
      case 'managed-current':
        return null
      case 'newer-known':
      case 'modified':
      case 'unknown':
      case 'externally-managed':
      case 'inaccessible':
      case undefined:
        return translate('auto.components.settings.AgentSkillSetupPanel.review', 'Review')
    }
  })()

  const run = async (): Promise<void> => {
    if (!installation || !installation.actionsSupported) {
      openSettings()
      return
    }
    try {
      if (
        installation.status === 'known-current' ||
        installation.status === 'known-update-available'
      ) {
        await state.manage(installation.id)
      } else if (
        installation.status === 'managed-update-available' ||
        installation.status === 'update-failed'
      ) {
        await state.update(installation.id)
      } else {
        openSettings()
        return
      }
      toast.success(
        translate(
          'auto.components.settings.AgentSkillSetupPanel.managedCurrent',
          'Orca is tracking this skill and it’s up to date.'
        )
      )
      notifyInstalledAgentSkillsChanged()
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.settings.AgentSkillSetupPanel.actionFailed',
              'Skill action failed.'
            )
      )
    }
  }

  const recordTerminalInstall = (result: { code: number | null }): void => {
    notifyInstalledAgentSkillsChanged()
    const startedAt = installAttemptStartedAtRef.current
    if (
      !isSuccessfulSkillInstallExit(result, startedAt) ||
      args.installed ||
      args.skillNames.length === 0
    ) {
      return
    }
    void window.api.skills
      .recordOrcaInstall({
        skillNames: [...args.skillNames],
        startedAt,
        target: args.target
      })
      .then(notifyInstalledAgentSkillsChanged)
      .catch(() => undefined)
  }

  return {
    applicable: args.installed && args.skillNames.length > 0,
    actionLabel,
    busy: state.loading || state.busyInstallationId !== null,
    actionBusy: state.loading || state.busyInstallationId === installation?.id,
    installation,
    statusLabel: installation ? managedSkillStatusCopy(installation.status) : null,
    run,
    recordTerminalInstall,
    beginInstallAttempt: () => {
      installAttemptStartedAtRef.current = Date.now()
    }
  }
}
