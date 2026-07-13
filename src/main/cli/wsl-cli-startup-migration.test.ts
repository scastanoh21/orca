import { describe, expect, it, vi } from 'vitest'
import { repairManagedWslCliRegistrations } from './wsl-cli-startup-migration'

describe('repairManagedWslCliRegistrations', () => {
  it('repairs managed registrations independently across every WSL distro', async () => {
    const repairByDistro = new Map([
      ['Ubuntu', vi.fn(async () => ({ changed: true, status: { state: 'installed' as const } }))],
      ['Debian', vi.fn(async () => ({ changed: false, status: { state: 'installed' as const } }))]
    ])

    const results = await repairManagedWslCliRegistrations({
      platform: 'win32',
      isPackaged: true,
      listDistros: async () => ['Ubuntu', 'Debian'],
      createInstaller: (distro) => {
        const repairManagedRegistration = repairByDistro.get(distro)
        if (!repairManagedRegistration) {
          throw new Error(`Unexpected distro: ${distro}`)
        }
        return { repairManagedRegistration }
      }
    })

    expect(results).toEqual([
      { distro: 'Ubuntu', outcome: 'repaired', state: 'installed' },
      { distro: 'Debian', outcome: 'unchanged', state: 'installed' }
    ])
    expect(repairByDistro.get('Ubuntu')).toHaveBeenCalledOnce()
    expect(repairByDistro.get('Debian')).toHaveBeenCalledOnce()
  })

  it('isolates WSL interop failures so one distro cannot block another', async () => {
    const results = await repairManagedWslCliRegistrations({
      platform: 'win32',
      isPackaged: true,
      listDistros: async () => ['Broken Distro', 'Ubuntu'],
      createInstaller: (distro) => ({
        repairManagedRegistration: async () => {
          if (distro === 'Broken Distro') {
            throw new Error('WSL interop failed')
          }
          return { changed: true, status: { state: 'installed' as const } }
        }
      })
    })

    expect(results).toEqual([
      {
        distro: 'Broken Distro',
        outcome: 'failed',
        error: 'WSL interop failed'
      },
      { distro: 'Ubuntu', outcome: 'repaired', state: 'installed' }
    ])
  })

  it.each([
    { platform: 'darwin' as const, isPackaged: true },
    { platform: 'linux' as const, isPackaged: true },
    { platform: 'win32' as const, isPackaged: false }
  ])('does not scan local/SSH or development hosts for $platform', async (host) => {
    const listDistros = vi.fn(async () => ['Ubuntu'])
    const createInstaller = vi.fn()

    await expect(
      repairManagedWslCliRegistrations({ ...host, listDistros, createInstaller })
    ).resolves.toEqual([])
    expect(listDistros).not.toHaveBeenCalled()
    expect(createInstaller).not.toHaveBeenCalled()
  })
})
