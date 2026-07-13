import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readOfficialSkillsCliLockEntries, skillsCliLockPath } from './skills-cli-lock-provenance'

const temporaryRoots: string[] = []

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-skills-lock-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })))
})

describe('skills CLI lock provenance', () => {
  it('uses XDG_STATE_HOME instead of the default lock location', async () => {
    const homeDir = await createRoot()
    const xdgStateHome = join(homeDir, 'state')
    expect(skillsCliLockPath({ homeDir, xdgStateHome })).toBe(
      join(xdgStateHome, 'skills', '.skill-lock.json')
    )
  })

  it('accepts only official Orca source entries from supported schemas', async () => {
    const homeDir = await createRoot()
    const lockPath = skillsCliLockPath({ homeDir })
    await mkdir(dirname(lockPath), { recursive: true })
    await writeFile(
      lockPath,
      JSON.stringify({
        version: 3,
        skills: {
          'orca-cli': { source: 'stablyai/orca' },
          orchestration: { sourceUrl: 'https://github.com/stablyai/orca.git' },
          spoofed: { source: 'someone/orca' }
        }
      })
    )

    expect(await readOfficialSkillsCliLockEntries({ homeDir })).toEqual(
      new Set(['orca-cli', 'orchestration'])
    )
  })

  it('fails closed for missing, corrupt, and unsupported locks', async () => {
    const homeDir = await createRoot()
    expect(await readOfficialSkillsCliLockEntries({ homeDir })).toEqual(new Set())
    const lockPath = skillsCliLockPath({ homeDir })
    await mkdir(dirname(lockPath), { recursive: true })
    await writeFile(lockPath, '{')
    expect(await readOfficialSkillsCliLockEntries({ homeDir })).toEqual(new Set())
    await writeFile(lockPath, JSON.stringify({ version: 99, skills: { 'orca-cli': {} } }))
    expect(await readOfficialSkillsCliLockEntries({ homeDir })).toEqual(new Set())
  })
})
