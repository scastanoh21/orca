import { lstat, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ManagedSkillDestination } from '../../shared/skill-management'
import {
  assertManagedSkillParentTopology,
  normalizedSkillIdentityPath,
  skillPhysicalIdentity
} from './skill-installation-topology'
import { RESERVED_SKILL_TRANSACTION_DIRECTORY } from './skill-transaction-paths'

export type SkillTransactionWorkspace = {
  skillsRoot: string
  skillsRootIdentity: string
  skillsRootDevice: number
  parentRoot: string
  parentRootIdentity: string
  parentRootDevice: number
  reservedRoot: string
}

export function skillTransactionReservedRoot(args: {
  skillsRoot: string
  skillsRootDevice: number
  parentRoot: string
  parentRootDevice: number
}): string {
  // Why: an adjacent workspace is atomic only on the destination mount;
  // a mount boundary requires the reserved child of the skills root.
  return args.skillsRootDevice === args.parentRootDevice
    ? join(args.parentRoot, RESERVED_SKILL_TRANSACTION_DIRECTORY)
    : join(args.skillsRoot, RESERVED_SKILL_TRANSACTION_DIRECTORY)
}

async function inspectWorkspaceRoots(record: ManagedSkillDestination) {
  await assertManagedSkillParentTopology(record)
  const skillsRoot = dirname(record.resolvedPath)
  const parentRoot = dirname(skillsRoot)
  const [skillsRootEntry, parentRootEntry, resolvedSkillsRoot, resolvedParentRoot] =
    await Promise.all([
      lstat(skillsRoot),
      lstat(parentRoot),
      realpath(skillsRoot),
      realpath(parentRoot)
    ])
  if (
    !skillsRootEntry.isDirectory() ||
    skillsRootEntry.isSymbolicLink() ||
    !parentRootEntry.isDirectory() ||
    parentRootEntry.isSymbolicLink() ||
    normalizedSkillIdentityPath(resolvedSkillsRoot) !== normalizedSkillIdentityPath(skillsRoot) ||
    normalizedSkillIdentityPath(resolvedParentRoot) !== normalizedSkillIdentityPath(parentRoot)
  ) {
    throw new Error('skill-topology-changed')
  }
  return {
    skillsRoot,
    skillsRootIdentity: skillPhysicalIdentity(skillsRoot, skillsRootEntry),
    skillsRootDevice: skillsRootEntry.dev,
    parentRoot,
    parentRootIdentity: skillPhysicalIdentity(parentRoot, parentRootEntry),
    parentRootDevice: parentRootEntry.dev
  }
}

export async function resolveSkillTransactionWorkspace(
  record: ManagedSkillDestination
): Promise<SkillTransactionWorkspace> {
  const roots = await inspectWorkspaceRoots(record)
  return {
    ...roots,
    reservedRoot: skillTransactionReservedRoot(roots)
  }
}

export async function assertSkillTransactionWorkspace(
  record: ManagedSkillDestination,
  expected: SkillTransactionWorkspace
): Promise<void> {
  const actual = await inspectWorkspaceRoots(record)
  if (
    actual.skillsRoot !== expected.skillsRoot ||
    actual.skillsRootIdentity !== expected.skillsRootIdentity ||
    actual.skillsRootDevice !== expected.skillsRootDevice ||
    actual.parentRoot !== expected.parentRoot ||
    actual.parentRootIdentity !== expected.parentRootIdentity ||
    actual.parentRootDevice !== expected.parentRootDevice
  ) {
    throw new Error('skill-topology-changed')
  }
}
