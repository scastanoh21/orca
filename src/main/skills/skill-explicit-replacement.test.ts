import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptySkillManagementLedger } from './skill-management-ledger'
import { inventoryManagedSkills } from './skill-management-inventory'
import {
  previewExplicitSkillReplacement,
  replaceSkillWithCurrentBundle
} from './skill-explicit-replacement'

const temporaryHomes: string[] = []
const resourceRoot = resolve('resources')

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map((home) => rm(home, { recursive: true })))
})

async function customInstallation() {
  const home = await mkdtemp(join(tmpdir(), 'orca-skill-replacement-'))
  temporaryHomes.push(home)
  const destination = join(home, '.agents', 'skills', 'orca-cli')
  await mkdir(destination, { recursive: true })
  await cp(resolve('skills/orca-cli'), destination, { recursive: true })
  await writeFile(join(destination, 'SKILL.md'), 'custom instructions\n')
  await writeFile(join(destination, 'notes.txt'), 'keep me until confirmed\n')
  const inventory = await inventoryManagedSkills({
    ledger: emptySkillManagementLedger(),
    hostId: 'local',
    homeDir: home,
    resourceRoot
  })
  return {
    home,
    destination,
    installation: inventory.installations.find((entry) => entry.name === 'orca-cli')!
  }
}

describe('explicit skill replacement', () => {
  it('previews every local file that replacement changes or removes', async () => {
    const { home, installation } = await customInstallation()
    const preview = await previewExplicitSkillReplacement({
      ledger: emptySkillManagementLedger(),
      hostId: 'local',
      homeDir: home,
      installationId: installation.id,
      resourceRoot
    })

    expect(preview.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'SKILL.md', change: 'modified' }),
        expect.objectContaining({ path: 'notes.txt', change: 'removed' })
      ])
    )
  })

  it('replaces only after explicit invocation and records the verified current bundle', async () => {
    const { home, destination, installation } = await customInstallation()
    expect(await readFile(join(destination, 'notes.txt'), 'utf8')).toContain('keep me')

    const record = await replaceSkillWithCurrentBundle({
      ledger: emptySkillManagementLedger(),
      hostId: 'local',
      homeDir: home,
      installationId: installation.id,
      resourceRoot,
      commit: () => undefined,
      now: 99
    })

    expect(record).toMatchObject({
      adoptedFrom: 'explicit-replacement',
      lastOutcome: 'replaced',
      adoptedAt: 99,
      updatedAt: 99
    })
    expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe(
      await readFile(resolve('skills/orca-cli/SKILL.md'), 'utf8')
    )
    await expect(readFile(join(destination, 'notes.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
