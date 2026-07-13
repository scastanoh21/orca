import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canMutateManagedSkills, type SkillMutationRuntimeFacts } from './skill-mutation-authority'

const temporaryRoot = join(process.cwd(), '.tmp-authority')

function facts(overrides: Partial<SkillMutationRuntimeFacts> = {}): SkillMutationRuntimeFacts {
  return {
    isPackaged: true,
    buildIdentity: 'stable',
    homeDir: '/real/home',
    userDataDir: '/real/user-data',
    temporaryRoot,
    ...overrides
  }
}

describe('skill mutation authority', () => {
  it('allows only the packaged stable build channel by default', () => {
    expect(canMutateManagedSkills(facts())).toBe(true)
    expect(canMutateManagedSkills(facts({ buildIdentity: 'rc' }))).toBe(false)
    expect(canMutateManagedSkills(facts({ buildIdentity: null }))).toBe(false)
  })

  it('rejects unpackaged access to a real home', () => {
    expect(canMutateManagedSkills(facts({ isPackaged: false, buildIdentity: null }))).toBe(false)
  })

  it('allows unpackaged tests only when both actual roots match isolated temporary roots', () => {
    const homeDir = join(temporaryRoot, 'home')
    const userDataDir = join(temporaryRoot, 'user-data')
    expect(
      canMutateManagedSkills(
        facts({
          isPackaged: false,
          buildIdentity: null,
          homeDir,
          userDataDir,
          isolatedDevHomeDir: homeDir,
          isolatedDevUserDataDir: userDataDir
        })
      )
    ).toBe(true)
  })

  it('rejects channel and root-isolation mismatches', () => {
    const homeDir = join(temporaryRoot, 'home')
    const userDataDir = join(temporaryRoot, 'user-data')
    expect(
      canMutateManagedSkills(
        facts({
          isPackaged: false,
          buildIdentity: 'rc',
          homeDir,
          userDataDir,
          isolatedDevHomeDir: '/real/home',
          isolatedDevUserDataDir: userDataDir
        })
      )
    ).toBe(false)
    expect(
      canMutateManagedSkills(
        facts({
          isPackaged: false,
          buildIdentity: null,
          homeDir,
          userDataDir: homeDir,
          isolatedDevHomeDir: homeDir,
          isolatedDevUserDataDir: homeDir
        })
      )
    ).toBe(false)
  })
})
