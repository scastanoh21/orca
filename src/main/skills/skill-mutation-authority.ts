import { isAbsolute, relative, resolve, sep } from 'node:path'

export type SkillMutationRuntimeFacts = {
  isPackaged: boolean
  buildIdentity: 'stable' | 'rc' | null
  homeDir: string
  userDataDir: string
  isolatedDevHomeDir?: string | null
  isolatedDevUserDataDir?: string | null
  temporaryRoot: string
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    process.platform === 'win32' ? resolve(value).toLocaleLowerCase('en-US') : resolve(value)
  return normalize(left) === normalize(right)
}

function isStrictChild(path: string, root: string): boolean {
  const candidate = relative(resolve(root), resolve(path))
  return (
    candidate.length > 0 &&
    candidate !== '..' &&
    !candidate.startsWith(`..${sep}`) &&
    !isAbsolute(candidate)
  )
}

export function canMutateManagedSkills(facts: SkillMutationRuntimeFacts): boolean {
  if (facts.isPackaged) {
    // Why: the build identity is CI-pinned for official artifacts; runtime or
    // renderer flags cannot promote an RC/custom package into a stable writer.
    return facts.buildIdentity === 'stable'
  }
  if (!facts.isolatedDevHomeDir || !facts.isolatedDevUserDataDir) {
    return false
  }
  return (
    samePath(facts.homeDir, facts.isolatedDevHomeDir) &&
    samePath(facts.userDataDir, facts.isolatedDevUserDataDir) &&
    !samePath(facts.homeDir, facts.userDataDir) &&
    isStrictChild(facts.homeDir, facts.temporaryRoot) &&
    isStrictChild(facts.userDataDir, facts.temporaryRoot) &&
    !isStrictChild(facts.homeDir, facts.userDataDir) &&
    !isStrictChild(facts.userDataDir, facts.homeDir)
  )
}
