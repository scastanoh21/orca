import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/types'

const { handleMock, discoverSkillsMock, getDefaultWslDistroMock, getWslHomeMock } = vi.hoisted(
  () => ({
    handleMock: vi.fn(),
    discoverSkillsMock: vi.fn(),
    getDefaultWslDistroMock: vi.fn(),
    getWslHomeMock: vi.fn()
  })
)

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  },
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

import { registerSkillsHandlers } from './skills'

describe('registerSkillsHandlers', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const repos = [{ id: 'repo-1', path: 'C:\\Users\\alice\\repo' }]
  let settings = getDefaultSettings('C:\\Users\\alice')
  const store = {
    getRepos: vi.fn(() => repos),
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
  }

  beforeEach(() => {
    handleMock.mockReset()
    discoverSkillsMock.mockReset()
    getDefaultWslDistroMock.mockReset()
    getWslHomeMock.mockReset()
    settings = getDefaultSettings('C:\\Users\\alice')
    store.getRepos.mockClear()
    store.getSettings.mockClear()
    store.updateSettings.mockClear()
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
    registerSkillsHandlers(store as never)
    const call = handleMock.mock.calls.find((entry: unknown[]) => entry[0] === 'skills:discover')
    if (!call) {
      throw new Error('skills:discover handler was not registered')
    }
    return call[1] as (_event: unknown, target?: unknown) => Promise<unknown>
  }

  function getEnsureHandler() {
    registerSkillsHandlers(store as never)
    const call = handleMock.mock.calls.find(
      (entry: unknown[]) => entry[0] === 'skills:ensureManagedReady'
    )
    if (!call) {
      throw new Error('skills:ensureManagedReady handler was not registered')
    }
    return call[1] as (
      event: { sender: { send: ReturnType<typeof vi.fn> } },
      request: unknown
    ) => Promise<unknown>
  }

  function getDeferHandler() {
    registerSkillsHandlers(store as never)
    const call = handleMock.mock.calls.find(
      (entry: unknown[]) => entry[0] === 'skills:deferManagedReadyPrompt'
    )
    if (!call) {
      throw new Error('skills:deferManagedReadyPrompt handler was not registered')
    }
    return call[1] as (_event: unknown, request: unknown) => Promise<unknown>
  }

  function getFlushHandler() {
    registerSkillsHandlers(store as never)
    const call = handleMock.mock.calls.find(
      (entry: unknown[]) => entry[0] === 'skills:flushRestartPrompts'
    )
    if (!call) {
      throw new Error('skills:flushRestartPrompts handler was not registered')
    }
    return call[1] as (event: { sender: { send: ReturnType<typeof vi.fn> } }) => Promise<unknown>
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

  it('registers managed ensure and emits repair-required fallback setup', async () => {
    const handler = getEnsureHandler()
    const send = vi.fn()

    const result = await handler(
      { sender: { send } },
      {
        skillName: 'orca-linear',
        context: 'linear-worktree',
        discoveryTarget: {
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
        }
      }
    )

    expect(result).toMatchObject({
      status: 'fallback',
      reason: 'repair-required-runtime',
      skillName: 'orca-linear'
    })
    expect(send).toHaveBeenCalledWith('skills:managedFallback', result)
    expect(discoverSkillsMock).not.toHaveBeenCalled()
  })

  it('defers managed setup prompts into settings without emitting immediately', async () => {
    const handler = getDeferHandler()

    await handler(null, {
      skillName: 'orca-linear',
      context: 'linear-worktree',
      discoveryTarget: { runtime: 'host', projectRootPath: '/workspace/current' }
    })

    expect(store.updateSettings).toHaveBeenCalledWith({
      managedAgentSkillRestartPromptRequests: [
        {
          skillName: 'orca-linear',
          context: 'linear-worktree',
          discoveryTarget: { runtime: 'host', projectRootPath: '/workspace/current' }
        }
      ]
    })
  })

  it('flushes restart prompts through managed ensure and emits actionable fallbacks', async () => {
    const handler = getFlushHandler()
    const send = vi.fn()
    settings = {
      ...settings,
      managedAgentSkillRestartPromptRequests: [
        {
          skillName: 'computer-use',
          context: 'agent-computer-use',
          remoteRuntime: true
        }
      ]
    }

    const results = await handler({ sender: { send } })

    expect(results).toMatchObject([
      {
        status: 'fallback',
        skillName: 'computer-use',
        context: 'agent-computer-use',
        reason: 'remote-runtime'
      }
    ])
    expect(send).toHaveBeenCalledWith(
      'skills:managedFallback',
      expect.objectContaining({
        status: 'fallback',
        skillName: 'computer-use',
        context: 'agent-computer-use',
        reason: 'remote-runtime'
      })
    )
    expect(settings.managedAgentSkillRestartPromptRequests).toEqual([
      {
        skillName: 'computer-use',
        context: 'agent-computer-use',
        remoteRuntime: true
      }
    ])
  })

  it('does not emit managed fallback events for cooldown results', async () => {
    const handler = getEnsureHandler()
    const send = vi.fn()
    const request = {
      skillName: 'orchestration',
      context: 'agent-orchestration',
      discoveryTarget: { runtime: 'host' }
    }

    await handler({ sender: { send } }, request)
    send.mockClear()
    const result = await handler({ sender: { send } }, request)

    expect(result).toMatchObject({
      status: 'fallback',
      reason: 'cooldown'
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('emits managed fallback events for remote runtime results', async () => {
    const handler = getEnsureHandler()
    const send = vi.fn()
    const result = await handler(
      { sender: { send } },
      {
        skillName: 'orchestration',
        context: 'agent-orchestration',
        remoteRuntime: true
      }
    )

    expect(result).toMatchObject({
      status: 'fallback',
      reason: 'remote-runtime'
    })
    expect(send).toHaveBeenCalledWith('skills:managedFallback', result)
  })

  it('emits managed fallback events for WSL runtime results', async () => {
    const handler = getEnsureHandler()
    const send = vi.fn()
    const result = await handler(
      { sender: { send } },
      {
        skillName: 'orca-linear',
        context: 'linear-worktree',
        discoveryTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' }
      }
    )

    expect(result).toMatchObject({
      status: 'fallback',
      reason: 'wsl-runtime'
    })
    expect(send).toHaveBeenCalledWith('skills:managedFallback', result)
  })

  it('emits managed fallback events for unsafe installs without a manual command', async () => {
    const handler = getEnsureHandler()
    const send = vi.fn()
    discoverSkillsMock.mockResolvedValue({
      skills: [
        {
          id: 'repo-orca-linear',
          name: 'orca-linear',
          description: null,
          providers: ['agent-skills'],
          sourceKind: 'repo',
          sourceLabel: 'repo',
          rootPath: '/workspace/current/.agents/skills',
          directoryPath: '/workspace/current/.agents/skills/orca-linear',
          skillFilePath: '/workspace/current/.agents/skills/orca-linear/SKILL.md',
          installed: true,
          fileCount: 1,
          updatedAt: 1
        }
      ],
      sources: [],
      scannedAt: 1
    })
    const result = await handler(
      { sender: { send } },
      {
        skillName: 'orca-linear',
        context: 'linear-worktree',
        discoveryTarget: { runtime: 'host', projectRootPath: '/workspace/current' }
      }
    )

    expect(result).toMatchObject({
      status: 'fallback',
      reason: 'project-install'
    })
    expect(send).toHaveBeenCalledWith('skills:managedFallback', result)
  })
})
