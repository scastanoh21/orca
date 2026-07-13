import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, realpath, stat } from 'node:fs/promises'
import { dirname, normalize, resolve } from 'node:path'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { SkillInstallationTopology } from '../../shared/skill-management'
import type { ManagedSkillDestination } from '../../shared/skill-management'
import type { SkillScanRoot } from './skill-discovery-sources'

export type ClassifiedSkillTopology = {
  topology: SkillInstallationTopology
  resolvedPath: string | null
  identity: string | null
  entryType: 'directory' | 'symlink' | 'junction'
  errorCategory: string | null
}

export function skillDestinationId(
  hostId: ExecutionHostId,
  unresolvedPath: string,
  name: string
): string {
  return createHash('sha256')
    .update(hostId)
    .update('\0')
    .update(normalizedSkillIdentityPath(unresolvedPath))
    .update('\0')
    .update(name)
    .digest('hex')
    .slice(0, 24)
}

export function normalizedSkillIdentityPath(value: string): string {
  const normalized = normalize(value)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

export function skillPhysicalIdentity(
  resolvedPath: string,
  fileStat: Awaited<ReturnType<typeof stat>>
): string {
  const inodeIdentity = fileStat.dev || fileStat.ino ? `${fileStat.dev}:${fileStat.ino}` : null
  return inodeIdentity ?? normalizedSkillIdentityPath(resolvedPath)
}

export function skillTopologyPriority(topology: SkillInstallationTopology): number {
  switch (topology) {
    case 'canonical-copy':
      return 3
    case 'independent-copy':
      return 2
    case 'provider-alias':
      return 1
    case 'external-link':
    case 'broken-link':
    case 'read-only':
      return 0
  }
}

async function writableDestination(path: string): Promise<boolean> {
  try {
    await Promise.all([
      access(path, constants.R_OK | constants.W_OK),
      access(dirname(path), constants.W_OK)
    ])
    return true
  } catch {
    return false
  }
}

async function hasSymlinkedAncestor(path: string, boundary: string): Promise<boolean> {
  let current = resolve(path)
  const stop = resolve(boundary)
  for (;;) {
    const entry = await lstat(current).catch(() => null)
    if (!entry || entry.isSymbolicLink()) {
      return true
    }
    const parent = dirname(current)
    if (current === stop) {
      return false
    }
    if (parent === current) {
      return true
    }
    current = parent
  }
}

export async function assertManagedSkillTopology(record: ManagedSkillDestination): Promise<string> {
  const logical = await lstat(record.unresolvedPath)
  const actualEntryType = logical.isSymbolicLink()
    ? process.platform === 'win32'
      ? 'junction'
      : 'symlink'
    : logical.isDirectory()
      ? 'directory'
      : null
  const homeBoundary = dirname(dirname(dirname(record.unresolvedPath)))
  if (
    actualEntryType !== record.entryType ||
    (await hasSymlinkedAncestor(dirname(record.unresolvedPath), homeBoundary))
  ) {
    throw new Error('skill-topology-changed')
  }
  const [resolved, resolvedParent] = await Promise.all([
    realpath(record.unresolvedPath),
    realpath(dirname(record.unresolvedPath))
  ])
  const resolvedStat = await stat(resolved)
  if (
    !resolvedStat.isDirectory() ||
    normalizedSkillIdentityPath(resolved) !== normalizedSkillIdentityPath(record.resolvedPath) ||
    normalizedSkillIdentityPath(resolvedParent) !==
      normalizedSkillIdentityPath(dirname(record.resolvedPath)) ||
    skillPhysicalIdentity(resolved, resolvedStat) !== record.physicalIdentity
  ) {
    throw new Error('skill-topology-changed')
  }
  return resolved
}

export async function assertManagedSkillParentTopology(
  record: ManagedSkillDestination
): Promise<void> {
  const homeBoundary = dirname(dirname(dirname(record.unresolvedPath)))
  if (await hasSymlinkedAncestor(dirname(record.unresolvedPath), homeBoundary)) {
    throw new Error('skill-topology-changed')
  }
  const resolvedParent = await realpath(dirname(record.unresolvedPath))
  if (
    normalizedSkillIdentityPath(resolvedParent) !==
    normalizedSkillIdentityPath(dirname(record.resolvedPath))
  ) {
    throw new Error('skill-topology-changed')
  }
}

export async function classifySkillInstallationTopology(
  root: SkillScanRoot,
  unresolvedPath: string,
  canonicalRootPath: string
): Promise<ClassifiedSkillTopology> {
  let logicalStat: Awaited<ReturnType<typeof lstat>>
  try {
    logicalStat = await lstat(unresolvedPath)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {
        topology: 'broken-link',
        resolvedPath: null,
        identity: null,
        entryType: 'symlink',
        errorCategory: 'missing'
      }
    }
    throw error
  }
  const linked = logicalStat.isSymbolicLink()
  const entryType =
    linked && process.platform === 'win32' ? 'junction' : linked ? 'symlink' : 'directory'
  let resolvedPath: string
  let resolvedStat: Awaited<ReturnType<typeof stat>>
  try {
    resolvedPath = await realpath(unresolvedPath)
    resolvedStat = await stat(resolvedPath)
  } catch {
    return {
      topology: 'broken-link',
      resolvedPath: null,
      identity: null,
      entryType,
      errorCategory: 'dangling-link'
    }
  }
  if (!resolvedStat.isDirectory()) {
    return {
      topology: 'broken-link',
      resolvedPath,
      identity: null,
      entryType,
      errorCategory: 'not-directory'
    }
  }

  const identity = skillPhysicalIdentity(resolvedPath, resolvedStat)
  const canonicalRoot = await realpath(canonicalRootPath).catch(() => resolve(canonicalRootPath))
  const homeBoundary = dirname(dirname(canonicalRootPath))
  const rootOrProviderParentLinked = await hasSymlinkedAncestor(root.path, homeBoundary)
  const isCanonicalTarget =
    normalizedSkillIdentityPath(dirname(resolvedPath)) ===
    normalizedSkillIdentityPath(canonicalRoot)
  let topology: SkillInstallationTopology
  if (linked) {
    topology = isCanonicalTarget ? 'provider-alias' : 'external-link'
  } else if (rootOrProviderParentLinked) {
    topology = 'external-link'
  } else {
    topology = root.id === 'home-agents' ? 'canonical-copy' : 'independent-copy'
  }
  if (topology !== 'external-link' && !(await writableDestination(resolvedPath))) {
    topology = 'read-only'
  }
  return { topology, resolvedPath, identity, entryType, errorCategory: null }
}
