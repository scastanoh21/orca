import type { ReactNode } from 'react'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { StepBadge } from './BrowserUseStepBadge'
import { translate } from '@/i18n/i18n'
import { ORCA_CLI_SKILL_NAME } from '@/lib/agent-feature-install-commands'
import type { SkillDiscoveryTarget } from '../../../../shared/skills'

type Props = {
  command: string
  installedCommand: string
  skillDetected: boolean
  skillLoading: boolean
  skillError: string | null
  disabled?: boolean
  terminalShellOverride?: string
  preInstallNotice?: ReactNode
  getPrerequisiteStatus?: () => Promise<Awaited<ReturnType<typeof window.api.cli.getInstallStatus>>>
  onBeforeOpenTerminal?: () => void | Promise<void>
  managementTarget?: SkillDiscoveryTarget
  onRecheck: () => void | Promise<unknown>
}

export function BrowserUseSkillStep({
  command,
  installedCommand,
  skillDetected,
  skillLoading,
  skillError,
  disabled = false,
  terminalShellOverride,
  preInstallNotice,
  getPrerequisiteStatus,
  onBeforeOpenTerminal,
  managementTarget,
  onRecheck
}: Props): React.JSX.Element {
  return (
    <AgentSkillSetupPanel
      managedSkillNames={[ORCA_CLI_SKILL_NAME]}
      managementTarget={managementTarget}
      variant="inline"
      title={translate(
        'auto.components.settings.BrowserUseSkillStep.459e24eebc',
        'Browser Use skill'
      )}
      description={translate(
        'auto.components.settings.BrowserUseSkillStep.0871b6998d',
        "Enables agents to navigate and verify pages in Orca's browser."
      )}
      command={command}
      installedCommand={installedCommand}
      terminalTitle="Browser Use setup"
      terminalAriaLabel="Browser Use skill install terminal"
      terminalWorktreeId="settings-browser-use-skill-terminal"
      terminalShellOverride={terminalShellOverride}
      installed={skillDetected}
      loading={skillLoading}
      error={skillError}
      installDisabled={disabled}
      leading={<StepBadge index={2} state={skillDetected ? 'done' : 'pending'} />}
      preInstallNotice={preInstallNotice}
      getPrerequisiteStatus={getPrerequisiteStatus}
      onBeforeOpenTerminal={onBeforeOpenTerminal}
      onRecheck={onRecheck}
    />
  )
}
