import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkillManagementInventory } from '../../shared/skill-management'
import { adoptExactSkillSnapshot } from './skill-adoption'
import { emptySkillManagementLedger } from './skill-management-ledger'
import { inventoryManagedSkills } from './skill-management-inventory'

const resourceRoot = resolve('resources')
const temporaryHomes: string[] = []

async function installHistoricalOrcaCli(crlf = false): Promise<{
  home: string
  inventory: SkillManagementInventory
}> {
  const home = await mkdtemp(join(tmpdir(), 'orca-skill-adoption-'))
  temporaryHomes.push(home)
  const destination = join(home, '.agents', 'skills', 'orca-cli')
  await mkdir(destination, { recursive: true })
  const releaseMapping = JSON.parse(
    await readFile(resolve('resources/skills/release-mapping.json'), 'utf8')
  )
  const firstRelease = releaseMapping.releases.find(
    (release: { skills: Record<string, number> }) => release.skills['orca-cli'] === 1
  )
  const source = execFileSync(
    'git',
    ['show', `v${firstRelease.appVersion}:skills/orca-cli/SKILL.md`],
    { encoding: 'utf8' }
  )
  await writeFile(join(destination, 'SKILL.md'), crlf ? source.replace(/\n/g, '\r\n') : source)
  const inventory = await inventoryManagedSkills({
    ledger: emptySkillManagementLedger(),
    hostId: 'local',
    homeDir: home,
    resourceRoot
  })
  return { home, inventory }
}

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map((home) => rm(home, { recursive: true })))
})

describe('exact skill snapshot adoption', () => {
  it('adopts and foreground-updates a released stale package', async () => {
    const { home, inventory } = await installHistoricalOrcaCli()
    const installation = inventory.installations.find((entry) => entry.name === 'orca-cli')
    expect(installation?.status).toBe('known-update-available')
    expect(installation?.installedAppVersion).toBe('1.0.81')

    const record = await adoptExactSkillSnapshot({
      ledger: emptySkillManagementLedger(),
      hostId: 'local',
      homeDir: home,
      installationId: installation!.id,
      resourceRoot,
      commit: () => undefined,
      now: 42
    })

    expect(record).toMatchObject({
      installedReleaseRevision: installation!.currentReleaseRevision,
      installedPackageDigest: installation!.currentPackageDigest,
      lastOutcome: 'updated',
      adoptedAt: 42,
      updatedAt: 42
    })
    expect(await readFile(join(home, '.agents', 'skills', 'orca-cli', 'SKILL.md'), 'utf8')).toBe(
      await readFile(resolve('skills/orca-cli/SKILL.md'), 'utf8')
    )
    const managedInventory = await inventoryManagedSkills({
      ledger: {
        schemaVersion: 1,
        destinations: { [record.id]: record },
        dismissedAdoptionCandidates: []
      },
      hostId: 'local',
      homeDir: home,
      resourceRoot
    })
    expect(managedInventory.installations.find((entry) => entry.name === 'orca-cli')).toMatchObject(
      { id: record.id, status: 'managed-current', managed: true }
    )
  })

  it('preserves a Windows-shaped CRLF text installation while updating', async () => {
    const { home, inventory } = await installHistoricalOrcaCli(true)
    const installation = inventory.installations.find((entry) => entry.name === 'orca-cli')

    await adoptExactSkillSnapshot({
      ledger: emptySkillManagementLedger(),
      hostId: 'local',
      homeDir: home,
      installationId: installation!.id,
      resourceRoot,
      commit: () => undefined
    })

    const installed = await readFile(join(home, '.agents', 'skills', 'orca-cli', 'SKILL.md'))
    const current = await readFile(resolve('skills/orca-cli/SKILL.md'), 'utf8')
    expect(installed.includes(13)).toBe(true)
    expect(installed.toString('utf8').replace(/\r\n/g, '\n')).toBe(current)
  })

  it('restores the prior package when durable ledger persistence fails', async () => {
    const { home, inventory } = await installHistoricalOrcaCli()
    const installation = inventory.installations.find((entry) => entry.name === 'orca-cli')!
    const skillMarkdownPath = join(home, '.agents', 'skills', 'orca-cli', 'SKILL.md')
    const before = await readFile(skillMarkdownPath)

    await expect(
      adoptExactSkillSnapshot({
        ledger: emptySkillManagementLedger(),
        hostId: 'local',
        homeDir: home,
        installationId: installation.id,
        resourceRoot,
        commit: () => {
          throw new Error('ledger-write-failed')
        }
      })
    ).rejects.toThrow('ledger-write-failed')

    expect(await readFile(skillMarkdownPath)).toEqual(before)
  })

  it('refuses adoption after unknown content replaces the official snapshot', async () => {
    const { home, inventory } = await installHistoricalOrcaCli()
    const installation = inventory.installations.find((entry) => entry.name === 'orca-cli')
    await writeFile(join(home, '.agents', 'skills', 'orca-cli', 'SKILL.md'), 'custom')

    await expect(
      adoptExactSkillSnapshot({
        ledger: emptySkillManagementLedger(),
        hostId: 'local',
        homeDir: home,
        installationId: installation!.id,
        resourceRoot,
        commit: () => undefined
      })
    ).rejects.toThrow('skill-installation-not-adoptable')
  })

  it('revalidates exact content immediately before committing current adoption', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orca-skill-adoption-race-'))
    temporaryHomes.push(home)
    const destination = join(home, '.agents', 'skills', 'orca-cli')
    await mkdir(destination, { recursive: true })
    await writeFile(
      join(destination, 'SKILL.md'),
      await readFile(resolve('skills/orca-cli/SKILL.md'))
    )
    const inventory = await inventoryManagedSkills({
      ledger: emptySkillManagementLedger(),
      hostId: 'local',
      homeDir: home,
      resourceRoot
    })
    const installation = inventory.installations.find((entry) => entry.name === 'orca-cli')!
    let committed = false

    await expect(
      adoptExactSkillSnapshot({
        ledger: emptySkillManagementLedger(),
        hostId: 'local',
        homeDir: home,
        installationId: installation.id,
        resourceRoot,
        beforeFinalValidation: () =>
          writeFile(join(destination, 'SKILL.md'), 'post-observation independent edit'),
        commit: () => {
          committed = true
        }
      })
    ).rejects.toThrow('skill-content-changed')
    expect(committed).toBe(false)
  })
})
