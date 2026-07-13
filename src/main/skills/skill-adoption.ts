import { lstat, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  DismissedSkillAdoptionCandidate,
  ManagedSkillDestination,
  SkillManagementLedger
} from '../../shared/skill-management'
import { loadSkillBundleArtifacts } from './skill-bundle-artifacts'
import {
  matchingReleasedSnapshot,
  observeSkillPackage,
  persistedObservedFiles
} from './skill-package-identity'
import { inventoryManagedSkills } from './skill-management-inventory'
import { normalizedSkillIdentityPath } from './skill-installation-topology'
import { publishBundledSkill } from './skill-package-publish'

export async function adoptExactSkillSnapshot(args: {
  ledger: SkillManagementLedger
  hostId: ExecutionHostId
  homeDir: string
  installationId: string
  resourceRoot?: string
  now?: number
  // Why: deterministic fault injection must land after advisory observation
  // but before the same final validation used by production commits.
  beforeFinalValidation?: () => void | Promise<void>
  commit: (destination: ManagedSkillDestination) => void | Promise<void>
}): Promise<ManagedSkillDestination> {
  const inventory = await inventoryManagedSkills(args)
  const installation = inventory.installations.find((entry) => entry.id === args.installationId)
  if (
    !installation?.eligible ||
    installation.managed ||
    !installation.resolvedPath ||
    !installation.physicalIdentity ||
    installation.installedReleaseRevision === null ||
    !installation.installedPackageDigest
  ) {
    throw new Error('skill-installation-not-adoptable')
  }

  const artifacts = await loadSkillBundleArtifacts(args.resourceRoot)
  const current = artifacts.manifest.skills.find((entry) => entry.name === installation.name)
  const observed = await observeSkillPackage(installation.resolvedPath)
  const snapshot = matchingReleasedSnapshot(
    observed,
    artifacts.releasedSnapshots[installation.name] ?? []
  )
  // Why: inventory is only advisory; consent records ownership only after a
  // fresh exact-content check closes the user/CLI mutation race.
  if (
    !current ||
    !snapshot ||
    snapshot.packageDigest !== installation.installedPackageDigest ||
    normalizedSkillIdentityPath(await realpath(installation.resolvedPath)) !==
      normalizedSkillIdentityPath(installation.resolvedPath)
  ) {
    throw new Error('skill-installation-changed-before-adoption')
  }

  const logicalStat = await lstat(installation.unresolvedPath)
  const now = args.now ?? Date.now()
  const record: ManagedSkillDestination = {
    id: installation.id,
    hostId: args.hostId,
    homeIdentity: normalizedSkillIdentityPath(
      await realpath(args.homeDir).catch(() => resolve(args.homeDir))
    ),
    rootId: installation.rootId,
    unresolvedPath: installation.unresolvedPath,
    resolvedPath: installation.resolvedPath,
    physicalIdentity: installation.physicalIdentity,
    entryType: logicalStat.isSymbolicLink()
      ? process.platform === 'win32'
        ? 'junction'
        : 'symlink'
      : 'directory',
    skillName: installation.name,
    source: 'stablyai/orca',
    sourcePath: current.sourcePath,
    sourceRef: snapshot.gitTreeSha,
    installedReleaseRevision: snapshot.releaseRevision,
    installedPackageDigest: snapshot.packageDigest,
    installedFiles: persistedObservedFiles(observed),
    lastWrittenPackageDigest: null,
    lastAttemptedBundleFingerprint: current.packageDigest,
    lastOutcome: 'adopted',
    lastErrorCategory: null,
    adoptedFrom: 'exact-snapshot',
    adoptedAt: now,
    updatedAt: now
  }
  await args.beforeFinalValidation?.()
  return publishBundledSkill({
    record,
    current,
    releasedSnapshots: artifacts.releasedSnapshots[installation.name] ?? [],
    packagesRoot: artifacts.packagesRoot,
    commit: args.commit,
    now
  })
}

export async function skillAdoptionDismissal(args: {
  ledger: SkillManagementLedger
  hostId: ExecutionHostId
  homeDir: string
  installationId: string
  resourceRoot?: string
  now?: number
}): Promise<DismissedSkillAdoptionCandidate> {
  const inventory = await inventoryManagedSkills(args)
  const installation = inventory.installations.find((entry) => entry.id === args.installationId)
  if (
    !installation?.eligible ||
    !installation.physicalIdentity ||
    !installation.installedPackageDigest
  ) {
    throw new Error('skill-adoption-candidate-not-found')
  }
  return {
    hostId: args.hostId,
    physicalIdentity: installation.physicalIdentity,
    skillName: installation.name,
    snapshotDigest: installation.installedPackageDigest,
    dismissedAt: args.now ?? Date.now()
  }
}
