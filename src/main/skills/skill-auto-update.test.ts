import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ManagedSkillDestination, SkillManagementLedger } from '../../shared/skill-management'
import { adoptExactSkillSnapshot } from './skill-adoption'
import { autoUpdateManagedSkills } from './skill-auto-update'
import { emptySkillManagementLedger } from './skill-management-ledger'
import { inventoryManagedSkills } from './skill-management-inventory'

const currentResourceRoot = resolve('resources')
const temporaryRoots: string[] = []

// Why: adopting against a bundle whose current manifest IS the first release
// records revision 1 without publishing, leaving a genuine stale-but-managed
// destination for the current bundle to update.
async function adoptedHistoricalInstall(): Promise<{
  home: string
  ledger: SkillManagementLedger
}> {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-auto-update-'))
  temporaryRoots.push(root)
  const home = join(root, 'home')
  const destination = join(home, '.agents', 'skills', 'orca-cli')
  await mkdir(destination, { recursive: true })
  const releaseMapping = JSON.parse(
    await readFile(resolve('resources/skills/release-mapping.json'), 'utf8')
  )
  const firstRelease = releaseMapping.releases.find(
    (release: { skills: Record<string, number> }) => release.skills['orca-cli'] === 1
  )
  const historicalSource = execFileSync(
    'git',
    ['show', `v${firstRelease.appVersion}:skills/orca-cli/SKILL.md`],
    { encoding: 'utf8' }
  )
  await writeFile(join(destination, 'SKILL.md'), historicalSource)

  const registry = JSON.parse(
    await readFile(resolve('resources/skills/snapshot-registry.json'), 'utf8')
  )
  const historicalSnapshot = registry.skills['orca-cli'].find(
    (snapshot: { releaseRevision: number }) => snapshot.releaseRevision === 1
  )
  const historicalResources = join(root, 'historical-resources')
  await mkdir(join(historicalResources, 'skills'), { recursive: true })
  await writeFile(
    join(historicalResources, 'skills', 'current-manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      appVersion: firstRelease.appVersion,
      skills: [
        {
          name: 'orca-cli',
          sourcePath: 'skills/orca-cli',
          appVersion: firstRelease.appVersion,
          ...historicalSnapshot
        }
      ]
    })
  )
  await writeFile(
    join(historicalResources, 'skills', 'snapshot-registry.json'),
    JSON.stringify(registry)
  )
  await writeFile(
    join(historicalResources, 'skills', 'release-mapping.json'),
    JSON.stringify(releaseMapping)
  )

  const ledger = emptySkillManagementLedger()
  const inventory = await inventoryManagedSkills({
    ledger,
    hostId: 'local',
    homeDir: home,
    resourceRoot: historicalResources
  })
  const installation = inventory.installations.find((entry) => entry.name === 'orca-cli')!
  await adoptExactSkillSnapshot({
    ledger,
    hostId: 'local',
    homeDir: home,
    installationId: installation.id,
    resourceRoot: historicalResources,
    commit: (next) => {
      ledger.destinations[next.id] = next
    },
    now: 1
  })
  return { home, ledger }
}

function batchArgs(home: string, ledger: SkillManagementLedger) {
  return {
    hostId: 'local' as const,
    homeDir: home,
    resourceRoot: currentResourceRoot,
    getLedger: () => ledger,
    commit: (next: ManagedSkillDestination) => {
      ledger.destinations[next.id] = next
    },
    recordFailure: (prior: ManagedSkillDestination, error: unknown) => {
      ledger.destinations[prior.id] = {
        ...prior,
        lastOutcome: 'failed',
        lastErrorCategory: error instanceof Error ? error.message : 'unknown-error',
        updatedAt: 2
      }
    }
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })))
})

describe('managed skill auto-update batch', () => {
  it('updates an adopted stale destination to the bundled release', async () => {
    const { home, ledger } = await adoptedHistoricalInstall()
    let beforeWritesCalls = 0

    const outcome = await autoUpdateManagedSkills({
      ...batchArgs(home, ledger),
      beforeWrites: async () => {
        beforeWritesCalls += 1
      }
    })

    expect(outcome.updatedSkillNames).toEqual(['orca-cli'])
    expect(outcome.failedSkillNames).toEqual([])
    expect(beforeWritesCalls).toBe(1)
    expect(await readFile(join(home, '.agents', 'skills', 'orca-cli', 'SKILL.md'), 'utf8')).toBe(
      await readFile(resolve('skills/orca-cli/SKILL.md'), 'utf8')
    )
    expect(
      outcome.inventory.installations.find((entry) => entry.name === 'orca-cli')
    ).toMatchObject({ status: 'managed-current', managed: true })
  })

  it('never writes a locally modified copy and performs no recovery work for it', async () => {
    const { home, ledger } = await adoptedHistoricalInstall()
    const skillFile = join(home, '.agents', 'skills', 'orca-cli', 'SKILL.md')
    const modified = `${await readFile(skillFile, 'utf8')}\nlocal note\n`
    await writeFile(skillFile, modified)
    let beforeWritesCalls = 0

    const outcome = await autoUpdateManagedSkills({
      ...batchArgs(home, ledger),
      beforeWrites: async () => {
        beforeWritesCalls += 1
      }
    })

    expect(outcome.updatedSkillNames).toEqual([])
    expect(outcome.failedSkillNames).toEqual([])
    expect(beforeWritesCalls).toBe(0)
    expect(await readFile(skillFile, 'utf8')).toBe(modified)
    expect(
      outcome.inventory.installations.find((entry) => entry.name === 'orca-cli')
    ).toMatchObject({ status: 'modified' })
  })

  it('records one failure, restores the prior package, and never re-attempts in a later batch', async () => {
    const { home, ledger } = await adoptedHistoricalInstall()
    const skillFile = join(home, '.agents', 'skills', 'orca-cli', 'SKILL.md')
    const historical = await readFile(skillFile, 'utf8')

    const failing = await autoUpdateManagedSkills({
      ...batchArgs(home, ledger),
      commit: () => {
        throw new Error('persistence-writes-frozen')
      }
    })

    expect(failing.updatedSkillNames).toEqual([])
    expect(failing.failedSkillNames).toEqual(['orca-cli'])
    expect(await readFile(skillFile, 'utf8')).toBe(historical)
    expect(
      failing.inventory.installations.find((entry) => entry.name === 'orca-cli')
    ).toMatchObject({ status: 'update-failed' })

    let beforeWritesCalls = 0
    const retry = await autoUpdateManagedSkills({
      ...batchArgs(home, ledger),
      beforeWrites: async () => {
        beforeWritesCalls += 1
      }
    })

    expect(retry.updatedSkillNames).toEqual([])
    expect(retry.failedSkillNames).toEqual([])
    expect(beforeWritesCalls).toBe(0)
    expect(await readFile(skillFile, 'utf8')).toBe(historical)
  })
})
