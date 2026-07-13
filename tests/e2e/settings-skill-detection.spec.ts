import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillSourceKind
} from '../../src/shared/skills'
import { ORCHESTRATION_ENABLED_STORAGE_KEY } from '../../src/renderer/src/lib/orchestration-setup-state'
import type {
  SkillManagementInstallation,
  SkillManagementInventory
} from '../../src/shared/skill-management'

type MockSkillDiscoveryGlobal = typeof globalThis & {
  __orcaSettingsSkillDiscoveryResult?: SkillDiscoveryResult
  __orcaSettingsSkillManagementInventory?: SkillManagementInventory
}

function managedInstallation(
  name: string,
  status: SkillManagementInstallation['status']
): SkillManagementInstallation {
  const managed = status.startsWith('managed-') || status === 'update-failed'
  return {
    id: name,
    hostId: 'local',
    name,
    description: null,
    rootId: 'home-agents',
    providers: ['agent-skills', 'codex'],
    unresolvedPath: `/Users/test/.agents/skills/${name}`,
    resolvedPath: `/Users/test/.agents/skills/${name}`,
    physicalIdentity: `1:${name}`,
    topology: 'canonical-copy',
    status,
    eligible: status !== 'modified',
    adoptionPromptEligible: status === 'known-current',
    lockCorroborated: true,
    actionsSupported: true,
    managed,
    installedReleaseRevision: 1,
    installedAppVersion: '1.2.3',
    currentReleaseRevision: 2,
    installedPackageDigest: 'a'.repeat(64),
    currentPackageDigest: 'b'.repeat(64),
    currentAppVersion: '2.0.0',
    errorCategory: status === 'update-failed' ? 'filesystem-ebusy' : null
  }
}

async function installMockSkillManagement(
  app: ElectronApplication,
  inventory: SkillManagementInventory
): Promise<void> {
  await app.evaluate((electron, initialInventory) => {
    ;(globalThis as MockSkillDiscoveryGlobal).__orcaSettingsSkillManagementInventory =
      initialInventory
    const current = () =>
      (globalThis as MockSkillDiscoveryGlobal).__orcaSettingsSkillManagementInventory!
    for (const channel of [
      'skills:managementInventory',
      'skills:adopt',
      'skills:updateManaged',
      'skills:dismissAdoption'
    ]) {
      electron.ipcMain.removeHandler(channel)
      electron.ipcMain.handle(channel, current)
    }
    electron.ipcMain.removeHandler('skills:previewReplacement')
    electron.ipcMain.handle(
      'skills:previewReplacement',
      (_event, args: { installationId: string }) => ({
        installationId: args.installationId,
        skillName: args.installationId,
        files: [
          { path: 'SKILL.md', change: 'modified', beforeText: 'local', afterText: 'official' }
        ]
      })
    )
    electron.ipcMain.removeHandler('skills:replace')
    electron.ipcMain.handle('skills:replace', () => {
      throw new Error('injected rollback')
    })
  }, inventory)
}

async function installMockSkillAutoUpdate(
  app: ElectronApplication,
  updatedSkillNames: string[]
): Promise<void> {
  await app.evaluate((electron, names) => {
    electron.ipcMain.removeHandler('skills:autoUpdateManaged')
    electron.ipcMain.handle('skills:autoUpdateManaged', () => {
      const current = (globalThis as MockSkillDiscoveryGlobal)
        .__orcaSettingsSkillManagementInventory!
      // The real batch leaves updated rows managed-current; mirror that so the
      // post-update refresh shows the settled state.
      ;(globalThis as MockSkillDiscoveryGlobal).__orcaSettingsSkillManagementInventory = {
        ...current,
        installations: current.installations.map((installation) =>
          names.includes(installation.name)
            ? { ...installation, status: 'managed-current' as const }
            : installation
        )
      }
      return { updatedSkillNames: names, failedSkillNames: [], inventory: null }
    })
  }, updatedSkillNames)
}

function makeSkill(sourceKind: SkillSourceKind, directoryPath: string): DiscoveredSkill {
  return {
    id: `${sourceKind}-orca-cli`,
    name: 'orchestration',
    description: null,
    providers: ['agent-skills'],
    sourceKind,
    sourceLabel: sourceKind,
    rootPath: directoryPath.replace(/[\\/]orchestration$/, ''),
    directoryPath,
    skillFilePath: `${directoryPath}/SKILL.md`,
    installed: true,
    fileCount: 1,
    updatedAt: null
  }
}

function discoveryResult(skills: DiscoveredSkill[]): SkillDiscoveryResult {
  return {
    skills,
    sources: [],
    scannedAt: Date.now()
  }
}

async function installMockSkillDiscovery(
  app: ElectronApplication,
  result: SkillDiscoveryResult
): Promise<void> {
  await app.evaluate((electron, initialResult) => {
    const global = globalThis as MockSkillDiscoveryGlobal
    global.__orcaSettingsSkillDiscoveryResult = initialResult
    electron.ipcMain.removeHandler('skills:discover')
    electron.ipcMain.handle('skills:discover', () => {
      const latest = (globalThis as MockSkillDiscoveryGlobal).__orcaSettingsSkillDiscoveryResult
      if (!latest) {
        throw new Error('Missing mocked skill discovery result')
      }
      return latest
    })
  }, result)
}

async function setMockSkillDiscovery(
  app: ElectronApplication,
  result: SkillDiscoveryResult
): Promise<void> {
  await app.evaluate((_, nextResult) => {
    ;(globalThis as MockSkillDiscoveryGlobal).__orcaSettingsSkillDiscoveryResult = nextResult
  }, result)
}

async function openOrchestrationSettings(page: Page): Promise<void> {
  await page.evaluate(
    ({ enabledKey }) => {
      localStorage.removeItem(enabledKey)
      const state = window.__store!.getState()
      state.setSettingsSearchQuery('orchestration')
      state.openSettingsPage()
    },
    {
      enabledKey: ORCHESTRATION_ENABLED_STORAGE_KEY
    }
  )
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: /^Orchestration\b/ }).click()
  await expect(
    page
      .locator('[data-settings-section="orchestration"]')
      .getByRole('heading', { name: 'Orchestration', exact: true })
  ).toBeInViewport({ timeout: 10_000 })
}

test.describe('Settings skill detection', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('shows installed only for global orchestration skill installs', async ({
    electronApp,
    orcaPage
  }) => {
    await installMockSkillDiscovery(
      electronApp,
      discoveryResult([
        makeSkill('repo', '/workspace/.agents/skills/orchestration'),
        makeSkill('plugin', '/Users/test/.codex/plugins/cache/vendor/orchestration')
      ])
    )
    // Why: the setup panel's action label reads the management inventory, so
    // pin it too — the developer's real global skill homes must not steer
    // this assertion.
    await installMockSkillManagement(electronApp, {
      schemaVersion: 1,
      hostId: 'local',
      installations: [managedInstallation('orchestration', 'known-update-available')],
      adoptionCandidateCount: 0,
      scannedAt: Date.now()
    })
    await orcaPage.evaluate(() => {
      window.dispatchEvent(new Event('orca:installed-agent-skills-changed'))
    })

    await openOrchestrationSettings(orcaPage)
    const section = orcaPage.locator('[data-settings-section="orchestration"]')
    await section.getByRole('button', { name: 'Re-check' }).click()

    await expect(section.getByText('Not installed', { exact: true })).toBeVisible()
    await expect(
      section.getByText('Enables agents to hand off context and coordinate work through Orca.')
    ).toBeVisible()

    await setMockSkillDiscovery(
      electronApp,
      discoveryResult([makeSkill('home', '/Users/test/.agents/skills/orchestration')])
    )
    await section.getByRole('button', { name: 'Re-check' }).click()

    await expect(section.getByText('Track & update', { exact: true }).first()).toBeVisible()
    await expect(
      section.getByText('Enables agents to hand off context and coordinate work through Orca.')
    ).toBeVisible()
  })

  test('shows managed adoption, update, conflict, retry, nudge, and retained failure review', async ({
    electronApp,
    orcaPage
  }) => {
    const installations = [
      managedInstallation('orca-cli', 'known-current'),
      managedInstallation('orchestration', 'managed-update-available'),
      managedInstallation('computer-use', 'modified'),
      managedInstallation('orca-linear', 'update-failed')
    ]
    await installMockSkillManagement(electronApp, {
      schemaVersion: 1,
      hostId: 'local',
      installations,
      adoptionCandidateCount: 1,
      scannedAt: Date.now()
    })
    await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      state.openSettingsTarget({ pane: 'agents', repoId: null })
      state.openSettingsPage()
      window.dispatchEvent(new Event('orca:installed-agent-skills-changed'))
    })

    await expect(orcaPage.getByText('Orca skill updates', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('Update automatically', { exact: true })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'Track updates', exact: true })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'Update', exact: true })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    await expect(orcaPage.getByText('Track updates for an installed Orca skill?')).toBeVisible()
    await orcaPage
      .locator('#agents')
      .getByRole('button', { name: 'Review changes', exact: true })
      .click()
    await expect(
      orcaPage.getByRole('heading', { name: 'Review local changes to Computer Use' })
    ).toBeVisible()
    await orcaPage.getByRole('button', { name: 'Use official version' }).click()
    await expect(
      orcaPage.getByRole('heading', { name: 'Review local changes to Computer Use' })
    ).toBeVisible()
    await expect(orcaPage.locator('#agents').getByText('injected rollback')).toBeVisible()
  })

  test('auto-updates a managed skill in the background and reports one toast', async ({
    electronApp,
    orcaPage
  }) => {
    const stale = managedInstallation('orchestration', 'managed-update-available')
    // A digest the always-mounted runner has not attempted in this session.
    stale.currentPackageDigest = 'e'.repeat(64)
    await installMockSkillManagement(electronApp, {
      schemaVersion: 1,
      hostId: 'local',
      installations: [stale],
      adoptionCandidateCount: 0,
      scannedAt: Date.now()
    })
    await installMockSkillAutoUpdate(electronApp, ['orchestration'])
    await orcaPage.evaluate(() => {
      window.dispatchEvent(new Event('orca:installed-agent-skills-changed'))
    })

    await expect(
      orcaPage.getByText('Updated the Orchestration skill to the latest version.')
    ).toBeVisible()

    await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      state.openSettingsTarget({ pane: 'agents', repoId: null })
      state.openSettingsPage()
    })
    await expect(orcaPage.getByText('Up to date', { exact: true })).toBeVisible()
    await expect(
      orcaPage.getByText('Orca keeps this skill up to date automatically.')
    ).toBeVisible()
  })
})
