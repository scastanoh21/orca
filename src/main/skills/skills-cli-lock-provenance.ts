import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_LOCK_BYTES = 1024 * 1024
const SUPPORTED_LOCK_VERSIONS = new Set([1, 2, 3])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function officialOrcaSource(entry: Record<string, unknown>): boolean {
  const source = typeof entry.source === 'string' ? entry.source : ''
  const sourceUrl = typeof entry.sourceUrl === 'string' ? entry.sourceUrl : ''
  return (
    source === 'stablyai/orca' ||
    source === 'https://github.com/stablyai/orca' ||
    /^https:\/\/github\.com\/stablyai\/orca(?:\.git)?\/?$/.test(sourceUrl)
  )
}

export function skillsCliLockPath(args: { homeDir: string; xdgStateHome?: string | null }): string {
  return args.xdgStateHome
    ? join(args.xdgStateHome, 'skills', '.skill-lock.json')
    : join(args.homeDir, '.agents', '.skill-lock.json')
}

export async function readOfficialSkillsCliLockEntries(args: {
  homeDir: string
  xdgStateHome?: string | null
}): Promise<Set<string>> {
  const lockPath = skillsCliLockPath(args)
  try {
    if ((await stat(lockPath)).size > MAX_LOCK_BYTES) {
      return new Set()
    }
    const parsed: unknown = JSON.parse(await readFile(lockPath, 'utf8'))
    if (
      !isRecord(parsed) ||
      !SUPPORTED_LOCK_VERSIONS.has(Number(parsed.version)) ||
      !isRecord(parsed.skills)
    ) {
      return new Set()
    }
    return new Set(
      Object.entries(parsed.skills)
        .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
        .filter(([, entry]) => officialOrcaSource(entry))
        .map(([name]) => name)
    )
  } catch {
    return new Set()
  }
}
