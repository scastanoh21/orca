// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManagedSkillAutoUpdate } from './ManagedSkillAutoUpdate'

const mocks = vi.hoisted(() => {
  const baselineInventory = () => ({
    schemaVersion: 1,
    hostId: 'local',
    installations: [
      {
        id: 'managed-a',
        name: 'orca-cli',
        status: 'managed-update-available',
        managed: true,
        actionsSupported: true,
        currentPackageDigest: 'a'.repeat(64)
      },
      {
        id: 'unmanaged-b',
        name: 'orchestration',
        status: 'known-update-available',
        managed: false,
        actionsSupported: true,
        currentPackageDigest: 'b'.repeat(64)
      }
    ],
    adoptionCandidateCount: 0,
    scannedAt: 1
  })
  return {
    autoUpdate: vi.fn(async () => ({
      updatedSkillNames: [] as string[],
      failedSkillNames: [] as string[],
      inventory: null
    })),
    success: vi.fn(),
    notify: vi.fn(),
    settings: { managedSkillAutoUpdateEnabled: true } as {
      managedSkillAutoUpdateEnabled: boolean
    } | null,
    baselineInventory,
    inventory: baselineInventory()
  }
})

vi.mock('sonner', () => ({ toast: { success: mocks.success } }))
vi.mock('@/hooks/useManagedAgentSkills', () => ({
  useManagedAgentSkills: () => ({ inventory: mocks.inventory })
}))
vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  notifyInstalledAgentSkillsChanged: mocks.notify
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ settings: mocks.settings })
}))

async function mount() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(<ManagedSkillAutoUpdate />))
  return root
}

describe('ManagedSkillAutoUpdate', () => {
  beforeEach(() => {
    mocks.autoUpdate.mockReset()
    mocks.autoUpdate.mockResolvedValue({
      updatedSkillNames: [],
      failedSkillNames: [],
      inventory: null
    })
    mocks.success.mockClear()
    mocks.notify.mockClear()
    mocks.settings = { managedSkillAutoUpdateEnabled: true }
    mocks.inventory = mocks.baselineInventory()
    Object.assign(window, { api: { skills: { autoUpdateManaged: mocks.autoUpdate } } })
  })

  afterEach(() => {
    document.body.replaceChildren()
  })

  it('runs one batch per bundled release and shows one aggregated toast', async () => {
    mocks.autoUpdate.mockResolvedValue({
      updatedSkillNames: ['orca-cli'],
      failedSkillNames: [],
      inventory: null
    })
    const root = await mount()

    await vi.waitFor(() => expect(mocks.autoUpdate).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(mocks.success).toHaveBeenCalledTimes(1))
    expect(mocks.success).toHaveBeenCalledWith('Updated the Orca CLI skill to the latest version.')
    expect(mocks.notify).toHaveBeenCalledTimes(1)

    // A focus-driven re-scan of the same bundle must not start a second batch.
    mocks.inventory = { ...mocks.inventory, scannedAt: Date.now() + 1 }
    await act(async () => root.render(<ManagedSkillAutoUpdate />))
    expect(mocks.autoUpdate).toHaveBeenCalledTimes(1)
    root.unmount()
  })

  it('does not request a batch when auto-update is turned off', async () => {
    mocks.settings = { managedSkillAutoUpdateEnabled: false }
    const root = await mount()

    expect(mocks.autoUpdate).not.toHaveBeenCalled()
    root.unmount()
  })

  it('ignores unmanaged, failed, and action-unsupported rows', async () => {
    mocks.inventory = {
      ...mocks.inventory,
      installations: [
        { ...mocks.inventory.installations[1]! },
        {
          id: 'failed-c',
          name: 'computer-use',
          status: 'update-failed',
          managed: true,
          actionsSupported: true,
          currentPackageDigest: 'c'.repeat(64)
        },
        {
          id: 'remote-d',
          name: 'orca-linear',
          status: 'managed-update-available',
          managed: true,
          actionsSupported: false,
          currentPackageDigest: 'd'.repeat(64)
        }
      ]
    }
    const root = await mount()

    expect(mocks.autoUpdate).not.toHaveBeenCalled()
    root.unmount()
  })

  it('stays quiet when the batch reports only failures', async () => {
    mocks.autoUpdate.mockResolvedValue({
      updatedSkillNames: [],
      failedSkillNames: ['orca-cli'],
      inventory: null
    })
    const root = await mount()

    await vi.waitFor(() => expect(mocks.autoUpdate).toHaveBeenCalledTimes(1))
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.notify).not.toHaveBeenCalled()
    root.unmount()
  })
})
