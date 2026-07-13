// @vitest-environment happy-dom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { DiscoveredSkill } from '../../../../shared/skills'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../ui/tooltip'
import { LinearAgentSkillInstallCta } from './linear-agent-skill-install-cta'

const mocks = vi.hoisted(() => ({
  skillState: {
    installed: false,
    loading: false,
    error: null as string | null,
    skills: [] as DiscoveredSkill[],
    refresh: vi.fn(async () => true)
  },
  useInstalledAgentSkillNames: vi.fn(),
  managementRun: vi.fn(async () => {}),
  useAgentSkillManagementActions: vi.fn(),
  clipboardWrite: vi.fn(async () => {}),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/hooks/useInstalledAgentSkills', async (importOriginal) => ({
  ...(await importOriginal()),
  useInstalledAgentSkillNames: mocks.useInstalledAgentSkillNames
}))

vi.mock('./CliSkillRuntimeSetup', () => ({
  buildSkillCommandForRuntime: (command: string) => command
}))

vi.mock('./use-agent-skill-management-actions', () => ({
  useAgentSkillManagementActions: mocks.useAgentSkillManagementActions
}))

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError }
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

function discoveredSkill(overrides: Partial<DiscoveredSkill>): DiscoveredSkill {
  return {
    id: 'skill-1',
    name: 'orca-linear',
    description: null,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    rootPath: '/Users/test/.agents/skills',
    directoryPath: '/Users/test/.agents/skills/orca-linear',
    skillFilePath: '/Users/test/.agents/skills/orca-linear/SKILL.md',
    installed: true,
    fileCount: 1,
    updatedAt: null,
    ...overrides
  }
}

async function renderCta(
  props: Partial<ComponentProps<typeof LinearAgentSkillInstallCta>> = {}
): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <TooltipProvider>
        <LinearAgentSkillInstallCta
          settings={{ activeRuntimeEnvironmentId: null, terminalWindowsShell: '' }}
          {...props}
        />
      </TooltipProvider>
    )
  })
  if (!container) {
    throw new Error('Container was not created')
  }
  return container
}

describe('LinearAgentSkillInstallCta', () => {
  beforeEach(() => {
    mocks.skillState.installed = false
    mocks.skillState.loading = false
    mocks.skillState.error = null
    mocks.skillState.skills = []
    mocks.skillState.refresh.mockClear()
    mocks.useInstalledAgentSkillNames.mockReset()
    mocks.useInstalledAgentSkillNames.mockReturnValue(mocks.skillState)
    mocks.managementRun.mockClear()
    mocks.useAgentSkillManagementActions.mockReset()
    mocks.useAgentSkillManagementActions.mockReturnValue({
      installation: null,
      actionLabel: null,
      statusLabel: null,
      busy: false,
      run: mocks.managementRun
    })
    mocks.clipboardWrite.mockClear()
    mocks.toastSuccess.mockClear()
    mocks.toastError.mockClear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { writeClipboardText: mocks.clipboardWrite } }
    })
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    root = null
    container?.remove()
    container = null
    Reflect.deleteProperty(window, 'api')
  })

  it('shows the install command and explanation when the skill is missing', async () => {
    const rendered = await renderCta()

    expect(rendered.textContent).toContain('Agent skill:')
    expect(rendered.textContent).toContain('orca-linear')
    expect(rendered.textContent).toContain('Not installed')
    expect(rendered.textContent).toContain('Let your agents read and edit Linear tasks.')
    expect(rendered.textContent).toContain(
      'npx skills add https://github.com/stablyai/orca --skill orca-linear --global'
    )
  })

  it('copies the install command to the clipboard', async () => {
    const rendered = await renderCta()

    await act(async () => {
      rendered
        .querySelector<HTMLButtonElement>('button[aria-label="Copy command"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.clipboardWrite).toHaveBeenCalledWith(
      'npx skills add https://github.com/stablyai/orca --skill orca-linear --global'
    )
    expect(mocks.toastSuccess).toHaveBeenCalled()
  })

  it('shows the ledger-backed status and action without a raw update command', async () => {
    mocks.skillState.installed = true
    mocks.skillState.skills = [discoveredSkill({ name: 'orca-linear' })]
    mocks.useAgentSkillManagementActions.mockReturnValue({
      installation: { managed: true },
      actionLabel: 'Update',
      statusLabel: 'Update available',
      busy: false,
      run: mocks.managementRun
    })

    const rendered = await renderCta()

    expect(rendered.textContent).toContain('Update available')
    expect(rendered.textContent).toContain('Update')
    expect(rendered.textContent).not.toContain('npx skills update')
    expect(rendered.textContent).not.toContain('Not installed')

    await act(async () => {
      Array.from(rendered.querySelectorAll('button'))
        .find((button) => button.textContent === 'Update')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mocks.managementRun).toHaveBeenCalledTimes(1)
  })

  it('does not expose a legacy raw updater when only linear-tickets is installed', async () => {
    mocks.skillState.installed = true
    mocks.skillState.skills = [
      discoveredSkill({
        name: 'linear-tickets',
        directoryPath: '/Users/test/.agents/skills/linear-tickets',
        skillFilePath: '/Users/test/.agents/skills/linear-tickets/SKILL.md'
      })
    ]

    const rendered = await renderCta()

    expect(rendered.textContent).toContain('Installed')
    expect(rendered.textContent).not.toContain('npx skills update')
  })

  it('notes that remote agent environments need their own setup', async () => {
    const rendered = await renderCta({
      settings: { activeRuntimeEnvironmentId: 'runtime-1', terminalWindowsShell: '' }
    })

    expect(rendered.textContent).toContain(
      'This installs host setup; remote agent environments may need separate setup.'
    )
  })

  it('re-checks the skill scan on demand', async () => {
    const rendered = await renderCta()

    await act(async () => {
      Array.from(rendered.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Re-check'))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.skillState.refresh).toHaveBeenCalledTimes(1)
  })
})
