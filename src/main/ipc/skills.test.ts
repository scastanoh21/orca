import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'

const {
  handleMock,
  discoverSkillsMock,
  getDefaultWslDistroMock,
  getWslHomeMock,
  inventoryManagedSkillsMock,
  adoptExactSkillSnapshotMock,
  updateManagedSkillMock,
  statMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  discoverSkillsMock: vi.fn(),
  getDefaultWslDistroMock: vi.fn(),
  getWslHomeMock: vi.fn(),
  inventoryManagedSkillsMock: vi.fn(),
  adoptExactSkillSnapshotMock: vi.fn(),
  updateManagedSkillMock: vi.fn(),
  statMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('../skills/discovery', () => ({
  discoverSkills: discoverSkillsMock
}))

vi.mock('../wsl', () => ({
  getDefaultWslDistro: getDefaultWslDistroMock,
  getWslHome: getWslHomeMock
}))

vi.mock('node:fs/promises', async () => ({
  ...(await vi.importActual<typeof FsPromises>('node:fs/promises')),
  stat: statMock
}))

vi.mock('../skills/skill-management-inventory', () => ({
  inventoryManagedSkills: inventoryManagedSkillsMock
}))

vi.mock('../skills/skill-adoption', () => ({
  adoptExactSkillSnapshot: adoptExactSkillSnapshotMock,
  skillAdoptionDismissal: vi.fn()
}))

vi.mock('../skills/skill-managed-update', () => ({
  updateManagedSkill: updateManagedSkillMock
}))

vi.mock('../skills/skill-explicit-replacement', () => ({
  previewExplicitSkillReplacement: vi.fn(),
  replaceSkillWithCurrentBundle: vi.fn()
}))

import { registerSkillsHandlers } from './skills'

describe('registerSkillsHandlers', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const repos = [{ id: 'repo-1', path: 'C:\\Users\\alice\\repo' }]
  const store = {
    getRepos: vi.fn(() => repos),
    getSettings: vi.fn(),
    getSkillManagementLedger: vi.fn(),
    setManagedSkillDestination: vi.fn(),
    dismissSkillAdoptionCandidate: vi.fn()
  }

  beforeEach(() => {
    handleMock.mockReset()
    discoverSkillsMock.mockReset()
    getDefaultWslDistroMock.mockReset()
    getWslHomeMock.mockReset()
    inventoryManagedSkillsMock.mockReset()
    adoptExactSkillSnapshotMock.mockReset()
    updateManagedSkillMock.mockReset()
    statMock.mockReset()
    store.getSettings.mockReset()
    store.getSkillManagementLedger.mockReset()
    store.setManagedSkillDestination.mockReset()
    store.dismissSkillAdoptionCandidate.mockReset()
    store.getSettings.mockReturnValue({})
    store.getSkillManagementLedger.mockReturnValue({
      schemaVersion: 1,
      destinations: {},
      dismissedAdoptionCandidates: []
    })
    discoverSkillsMock.mockResolvedValue({ skills: [], sources: [], scannedAt: 1 })
    getWslHomeMock.mockReturnValue('\\\\wsl.localhost\\Ubuntu\\home\\alice')
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  function getDiscoverHandler() {
    return getHandler('skills:discover')
  }

  function getHandler(
    channel: string,
    runtimeFacts: NonNullable<Parameters<typeof registerSkillsHandlers>[1]> = {
      isPackaged: true,
      buildIdentity: 'stable',
      userDataDir: '/isolated/user-data',
      temporaryRoot: '/isolated'
    }
  ) {
    registerSkillsHandlers(store as never, runtimeFacts)
    const call = handleMock.mock.calls.find((entry: unknown[]) => entry[0] === channel)
    if (!call) {
      throw new Error(`${channel} handler was not registered`)
    }
    return call[1] as (_event: unknown, target?: unknown) => Promise<unknown>
  }

  it('uses host skill discovery when resolved project runtime overrides stale WSL target state', async () => {
    const handler = getDiscoverHandler()

    await handler(null, {
      runtime: 'wsl',
      wslDistro: 'Debian',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'windows-host',
          hostPlatform: 'win32',
          projectId: 'repo-1',
          reason: 'project-override',
          cacheKey: 'repo-1:windows-host'
        }
      }
    })

    expect(discoverSkillsMock).toHaveBeenCalledWith({ repos })
    expect(getWslHomeMock).not.toHaveBeenCalled()
  })

  it('scopes host skill discovery to the active workspace cwd when provided', async () => {
    const handler = getDiscoverHandler()

    await handler(null, { cwd: '/repo/worktree' })

    expect(discoverSkillsMock).toHaveBeenCalledWith({ repos: [], cwd: '/repo/worktree' })
  })

  it('uses the selected project WSL distro for skill discovery', async () => {
    const handler = getDiscoverHandler()

    await handler(null, {
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'repo-1',
          distro: 'Ubuntu',
          reason: 'project-override',
          cacheKey: 'repo-1:wsl:Ubuntu'
        }
      }
    })

    expect(getDefaultWslDistroMock).not.toHaveBeenCalled()
    expect(getWslHomeMock).toHaveBeenCalledWith('Ubuntu')
    expect(discoverSkillsMock).toHaveBeenCalledWith({
      repos: [],
      homeDir: '\\\\wsl.localhost\\Ubuntu\\home\\alice',
      cwd: '\\\\wsl.localhost\\Ubuntu\\home\\alice'
    })
  })

  it('blocks skill discovery when project runtime requires repair', async () => {
    const handler = getDiscoverHandler()

    await expect(
      handler(null, {
        projectRuntime: {
          status: 'repair-required',
          repair: {
            projectId: 'repo-1',
            preferredRuntime: { kind: 'wsl', distro: 'Ubuntu' },
            reason: 'wsl-distro-missing',
            source: 'project-override',
            cacheKey: 'repo-1:repair:wsl-distro-missing:Ubuntu'
          }
        }
      })
    ).rejects.toThrow('Project runtime requires repair before skill discovery')
    expect(discoverSkillsMock).not.toHaveBeenCalled()
  })

  it('rejects WSL skill mutations before touching a distro path', async () => {
    const handler = getHandler('skills:adopt')

    await expect(
      handler(null, {
        installationId: 'candidate',
        target: { runtime: 'wsl', wslDistro: 'Ubuntu' }
      })
    ).rejects.toThrow('Skill management actions are not available on this host yet')

    expect(adoptExactSkillSnapshotMock).not.toHaveBeenCalled()
  })

  it('rejects remote execution-host discovery instead of scanning local paths', async () => {
    const handler = getDiscoverHandler()

    await expect(
      handler(null, { executionHostId: 'ssh:production', cwd: '/srv/repo' })
    ).rejects.toThrow('Skill management is not available for remote execution hosts in Phase 1')

    expect(discoverSkillsMock).not.toHaveBeenCalled()
  })

  it('rejects remote execution-host mutations before inventory or filesystem work', async () => {
    const handler = getHandler('skills:adopt')

    await expect(
      handler(null, {
        installationId: 'candidate',
        target: { executionHostId: 'runtime:environment-1' }
      })
    ).rejects.toThrow('Skill management is not available for remote execution hosts in Phase 1')

    expect(inventoryManagedSkillsMock).not.toHaveBeenCalled()
    expect(adoptExactSkillSnapshotMock).not.toHaveBeenCalled()
  })

  it('rejects unpackaged mutations against the real home', async () => {
    const handler = getHandler('skills:adopt', {
      isPackaged: false,
      buildIdentity: null,
      userDataDir: '/real/user-data',
      temporaryRoot: '/tmp'
    })

    await expect(handler(null, { installationId: 'candidate' })).rejects.toThrow(
      'official stable build or isolated dev roots'
    )
    expect(inventoryManagedSkillsMock).not.toHaveBeenCalled()
    expect(adoptExactSkillSnapshotMock).not.toHaveBeenCalled()
  })

  it('persists the exact adoption tuple supplied by the displayed candidate', async () => {
    inventoryManagedSkillsMock.mockResolvedValue({
      schemaVersion: 1,
      hostId: 'local',
      installations: [],
      adoptionCandidateCount: 0,
      scannedAt: 1
    })
    const handler = getHandler('skills:dismissAdoption')
    const candidate = {
      hostId: 'local',
      physicalIdentity: '1:2',
      skillName: 'orca-cli',
      snapshotDigest: 'a'.repeat(64)
    }

    await handler(null, { candidate })

    expect(store.dismissSkillAdoptionCandidate).toHaveBeenCalledWith({
      ...candidate,
      dismissedAt: expect.any(Number)
    })
  })

  it('does not claim a canonical install that predates the terminal attempt', async () => {
    const startedAt = Date.now() - 1_000
    const inventory = {
      schemaVersion: 1,
      hostId: 'local',
      installations: [
        {
          id: 'candidate',
          name: 'orca-cli',
          rootId: 'home-agents',
          unresolvedPath: '/home/alice/.agents/skills/orca-cli',
          eligible: true,
          managed: false
        }
      ],
      adoptionCandidateCount: 1,
      scannedAt: 1
    }
    inventoryManagedSkillsMock.mockResolvedValue(inventory)
    statMock.mockResolvedValue({ mtimeMs: startedAt - 10_000 })
    const handler = getHandler('skills:recordOrcaInstall')

    await handler(null, { skillNames: ['orca-cli'], startedAt })

    expect(adoptExactSkillSnapshotMock).not.toHaveBeenCalled()
    expect(store.setManagedSkillDestination).not.toHaveBeenCalled()
  })

  it('rejects install ownership without a valid terminal start time', async () => {
    const handler = getHandler('skills:recordOrcaInstall')

    await expect(handler(null, { skillNames: ['orca-cli'], startedAt: 0 })).rejects.toThrow(
      'Invalid skill installation start time'
    )

    expect(inventoryManagedSkillsMock).not.toHaveBeenCalled()
    expect(adoptExactSkillSnapshotMock).not.toHaveBeenCalled()
  })

  it('does not claim an install whose marker mtime is implausibly in the future', async () => {
    inventoryManagedSkillsMock.mockResolvedValue({
      schemaVersion: 1,
      hostId: 'local',
      installations: [
        {
          id: 'candidate',
          name: 'orca-cli',
          rootId: 'home-agents',
          unresolvedPath: '/home/alice/.agents/skills/orca-cli',
          eligible: true,
          managed: false
        }
      ],
      adoptionCandidateCount: 1,
      scannedAt: 1
    })
    statMock.mockResolvedValue({ mtimeMs: Date.now() + 60_000 })
    const handler = getHandler('skills:recordOrcaInstall')

    await handler(null, { skillNames: ['orca-cli'], startedAt: Date.now() - 1_000 })

    expect(adoptExactSkillSnapshotMock).not.toHaveBeenCalled()
  })

  it('declines auto-update without inventory work when the setting is off', async () => {
    store.getSettings.mockReturnValue({ managedSkillAutoUpdateEnabled: false })
    const handler = getHandler('skills:autoUpdateManaged')

    await expect(handler(null, undefined)).resolves.toEqual({
      updatedSkillNames: [],
      failedSkillNames: [],
      inventory: null
    })
    expect(inventoryManagedSkillsMock).not.toHaveBeenCalled()
  })

  it('declines auto-update silently on an unauthorized build instead of throwing', async () => {
    const handler = getHandler('skills:autoUpdateManaged', {
      isPackaged: false,
      buildIdentity: null,
      userDataDir: '/real/user-data',
      temporaryRoot: '/tmp'
    })

    await expect(handler(null, undefined)).resolves.toEqual({
      updatedSkillNames: [],
      failedSkillNames: [],
      inventory: null
    })
    expect(inventoryManagedSkillsMock).not.toHaveBeenCalled()
  })

  it('coalesces overlapping auto-update triggers into one batch', async () => {
    let resolveInventory: (value: unknown) => void = () => undefined
    inventoryManagedSkillsMock.mockReturnValue(
      new Promise((resolve) => {
        resolveInventory = resolve
      })
    )
    const handler = getHandler('skills:autoUpdateManaged')

    const first = handler(null, undefined)
    const second = handler(null, undefined)
    resolveInventory({
      schemaVersion: 1,
      hostId: 'local',
      installations: [],
      adoptionCandidateCount: 0,
      scannedAt: 1
    })

    expect(await second).toBe(await first)
    expect(inventoryManagedSkillsMock).toHaveBeenCalledTimes(1)
  })

  it('auto-updates only managed candidates and records failures durably', async () => {
    const prior = { id: 'managed', hostId: 'local', lastOutcome: 'adopted' }
    store.getSkillManagementLedger.mockReturnValue({
      schemaVersion: 1,
      destinations: { managed: prior },
      dismissedAdoptionCandidates: []
    })
    inventoryManagedSkillsMock.mockResolvedValue({
      schemaVersion: 1,
      hostId: 'local',
      installations: [
        {
          id: 'managed',
          name: 'orca-cli',
          status: 'managed-update-available',
          managed: true,
          actionsSupported: true
        },
        {
          id: 'unmanaged',
          name: 'orchestration',
          status: 'known-update-available',
          managed: false,
          actionsSupported: true
        }
      ],
      adoptionCandidateCount: 0,
      scannedAt: 1
    })
    updateManagedSkillMock.mockRejectedValue(Object.assign(new Error('busy'), { code: 'EBUSY' }))
    const handler = getHandler('skills:autoUpdateManaged')

    const result = await handler(null, undefined)

    expect(result).toMatchObject({ updatedSkillNames: [], failedSkillNames: ['orca-cli'] })
    expect(updateManagedSkillMock).toHaveBeenCalledTimes(1)
    expect(updateManagedSkillMock).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 'managed' })
    )
    expect(store.setManagedSkillDestination).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'managed',
        lastOutcome: 'failed',
        lastErrorCategory: 'filesystem-ebusy'
      })
    )
  })

  it('persists a failed managed update for retry diagnostics', async () => {
    const prior = { id: 'managed', hostId: 'local', lastOutcome: 'adopted' }
    store.getSkillManagementLedger.mockReturnValue({
      schemaVersion: 1,
      destinations: { managed: prior },
      dismissedAdoptionCandidates: []
    })
    updateManagedSkillMock.mockRejectedValue(Object.assign(new Error('busy'), { code: 'EBUSY' }))
    const handler = getHandler('skills:updateManaged')

    await expect(handler(null, { installationId: 'managed' })).rejects.toThrow('busy')

    expect(store.setManagedSkillDestination).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'managed',
        lastOutcome: 'failed',
        lastErrorCategory: 'filesystem-ebusy'
      })
    )
  })
})
