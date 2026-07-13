import { lstat, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { matchingReleasedSnapshot, observeSkillPackage } from './skill-package-identity'
import { skillPhysicalIdentity } from './skill-installation-topology'
import type { SkillTransactionMarker } from './skill-transaction-marker'
import { assertSkillTransactionPackageBuild } from './skill-transaction-package-build'
import {
  matchesInPlacePublicationState,
  skillInPlaceOperations
} from './skill-transaction-publication-state'

export type SkillTransactionLiveState = 'prior' | 'partial' | 'current' | 'swap-absent'

async function isAbsent(path: string): Promise<boolean> {
  return lstat(path)
    .then(() => false)
    .catch((error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return true
      }
      throw error
    })
}

async function matchesOwnedPackage(args: {
  path: string
  physicalIdentity: string
  snapshot: SkillTransactionMarker['priorSnapshot']
}): Promise<boolean> {
  try {
    const entry = await lstat(args.path)
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      return false
    }
    const pathStat = await stat(args.path)
    if (skillPhysicalIdentity(args.path, pathStat) !== args.physicalIdentity) {
      return false
    }
    return Boolean(matchingReleasedSnapshot(await observeSkillPackage(args.path), [args.snapshot]))
  } catch {
    return false
  }
}

async function assertStageCurrent(
  transactionRoot: string,
  marker: SkillTransactionMarker
): Promise<void> {
  if (
    !marker.stageBuild ||
    marker.stageBuild.state !== 'ready' ||
    marker.stageBuild.physicalIdentity !== marker.stagePhysicalIdentity
  ) {
    throw new Error('skill-transaction-recovery-required')
  }
  await assertSkillTransactionPackageBuild({
    root: join(transactionRoot, 'stage'),
    evidence: marker.stageBuild,
    snapshot: marker.currentSnapshot
  }).catch(() => {
    throw new Error('skill-transaction-recovery-required')
  })
}

async function assertOldLivePrior(
  transactionRoot: string,
  marker: SkillTransactionMarker
): Promise<void> {
  if (
    !(await matchesOwnedPackage({
      path: join(transactionRoot, 'old-live'),
      physicalIdentity: marker.physicalIdentity,
      snapshot: marker.priorSnapshot
    }))
  ) {
    throw new Error('skill-transaction-recovery-required')
  }
}

async function assertBackupPrior(
  transactionRoot: string,
  marker: SkillTransactionMarker
): Promise<void> {
  if (
    !marker.backupBuild ||
    marker.backupBuild.state !== 'ready' ||
    marker.backupBuild.physicalIdentity !== marker.backupPhysicalIdentity
  ) {
    throw new Error('skill-transaction-recovery-required')
  }
  await assertSkillTransactionPackageBuild({
    root: join(transactionRoot, 'backup'),
    evidence: marker.backupBuild,
    snapshot: marker.priorSnapshot
  }).catch(() => {
    throw new Error('skill-transaction-recovery-required')
  })
}

async function liveOwnedSnapshot(
  marker: SkillTransactionMarker,
  snapshot: SkillTransactionMarker['priorSnapshot'],
  physicalIdentity: string
): Promise<boolean> {
  return matchesOwnedPackage({ path: marker.destinationPath, physicalIdentity, snapshot })
}

async function assertInPlaceState(args: {
  transactionRoot: string
  marker: SkillTransactionMarker
  allowAppliedOperation: boolean
}): Promise<SkillTransactionLiveState> {
  const publication = args.marker.publication
  if (!publication || publication.kind !== 'in-place' || !args.marker.stagePhysicalIdentity) {
    throw new Error('skill-transaction-recovery-required')
  }
  if (publication.direction === 'forward') {
    await assertStageCurrent(args.transactionRoot, args.marker)
  }
  const liveStat = await stat(args.marker.destinationPath).catch(() => null)
  if (
    !liveStat ||
    skillPhysicalIdentity(args.marker.destinationPath, liveStat) !== publication.physicalIdentity
  ) {
    throw new Error('skill-transaction-recovery-required')
  }
  if (publication.temporary) {
    const temporaryPath = join(
      args.marker.destinationPath,
      ...publication.temporary.path.split('/')
    )
    const temporaryEntry = await lstat(temporaryPath).catch(() => null)
    if (
      temporaryEntry &&
      (!temporaryEntry.isFile() ||
        temporaryEntry.isSymbolicLink() ||
        skillPhysicalIdentity(temporaryPath, await stat(temporaryPath)) !==
          publication.temporary.physicalIdentity)
    ) {
      throw new Error('skill-transaction-recovery-required')
    }
    if (!temporaryEntry) {
      const operations = skillInPlaceOperations(
        args.marker.priorSnapshot,
        args.marker.currentSnapshot
      )
      const operation =
        operations[
          publication.direction === 'forward'
            ? publication.operationIndex
            : publication.operationIndex - 1
        ]
      const targetPath = operation
        ? join(args.marker.destinationPath, ...operation.path.split('/'))
        : null
      const targetEntry = targetPath ? await lstat(targetPath).catch(() => null) : null
      // Why: a missing ready temp proves a completed rename only when its inode
      // is now the exact operation target; equal bytes from another writer do not.
      if (
        publication.temporary.state === 'creating' ||
        publication.temporary.state === 'written' ||
        !targetPath ||
        !targetEntry?.isFile() ||
        targetEntry.isSymbolicLink() ||
        skillPhysicalIdentity(targetPath, await stat(targetPath)) !==
          publication.temporary.physicalIdentity
      ) {
        throw new Error('skill-transaction-recovery-required')
      }
    } else if (publication.temporary.state === 'applied') {
      throw new Error('skill-transaction-recovery-required')
    }
  }
  const observed = await observeSkillPackage(args.marker.destinationPath).catch(() => null)
  if (
    !observed ||
    !matchesInPlacePublicationState({
      observed,
      prior: args.marker.priorSnapshot,
      current: args.marker.currentSnapshot,
      publication,
      allowAppliedOperation: args.allowAppliedOperation
    })
  ) {
    throw new Error('skill-transaction-recovery-required')
  }
  if (matchingReleasedSnapshot(observed, [args.marker.priorSnapshot])) {
    return 'prior'
  }
  if (matchingReleasedSnapshot(observed, [args.marker.currentSnapshot])) {
    return 'current'
  }
  return 'partial'
}

async function assertSwapState(args: {
  transactionRoot: string
  marker: SkillTransactionMarker
}): Promise<SkillTransactionLiveState> {
  const publication = args.marker.publication
  if (!publication || publication.kind !== 'package-swap' || !args.marker.stagePhysicalIdentity) {
    throw new Error('skill-transaction-recovery-required')
  }
  const stageRoot = join(args.transactionRoot, 'stage')
  const oldLiveRoot = join(args.transactionRoot, 'old-live')
  if (publication.step === 'moving-live') {
    const livePrior = await liveOwnedSnapshot(
      args.marker,
      args.marker.priorSnapshot,
      args.marker.physicalIdentity
    )
    if (livePrior && (await isAbsent(oldLiveRoot))) {
      await assertStageCurrent(args.transactionRoot, args.marker)
      return 'prior'
    }
  }
  if (publication.step === 'moving-stage') {
    const liveCurrent = await liveOwnedSnapshot(
      args.marker,
      args.marker.currentSnapshot,
      args.marker.stagePhysicalIdentity
    )
    if (liveCurrent && (await isAbsent(stageRoot))) {
      await assertOldLivePrior(args.transactionRoot, args.marker)
      return 'current'
    }
  }
  if (
    publication.step === 'moving-live' ||
    publication.step === 'live-moved' ||
    publication.step === 'moving-stage'
  ) {
    if (!(await isAbsent(args.marker.destinationPath))) {
      throw new Error('skill-transaction-recovery-required')
    }
    await Promise.all([
      assertOldLivePrior(args.transactionRoot, args.marker),
      assertStageCurrent(args.transactionRoot, args.marker)
    ])
    return 'swap-absent'
  }
  if (publication.step === 'rollback-moving-old-live') {
    const livePrior = await liveOwnedSnapshot(
      args.marker,
      args.marker.priorSnapshot,
      args.marker.physicalIdentity
    )
    if (livePrior && (await isAbsent(oldLiveRoot))) {
      await assertStageCurrent(args.transactionRoot, args.marker)
      return 'prior'
    }
  }
  if (
    publication.step === 'rollback-moving-current' ||
    publication.step === 'rollback-current-moved' ||
    publication.step === 'rollback-moving-old-live'
  ) {
    if (publication.step === 'rollback-moving-current') {
      const liveCurrent = await liveOwnedSnapshot(
        args.marker,
        args.marker.currentSnapshot,
        args.marker.stagePhysicalIdentity
      )
      if (liveCurrent && (await isAbsent(stageRoot))) {
        await assertOldLivePrior(args.transactionRoot, args.marker)
        return 'current'
      }
    }
    if (!(await isAbsent(args.marker.destinationPath))) {
      throw new Error('skill-transaction-recovery-required')
    }
    await Promise.all([
      assertOldLivePrior(args.transactionRoot, args.marker),
      assertStageCurrent(args.transactionRoot, args.marker)
    ])
    return 'swap-absent'
  }
  const liveCurrent = await liveOwnedSnapshot(
    args.marker,
    args.marker.currentSnapshot,
    args.marker.stagePhysicalIdentity
  )
  if (!liveCurrent || !(await isAbsent(stageRoot))) {
    throw new Error('skill-transaction-recovery-required')
  }
  await assertOldLivePrior(args.transactionRoot, args.marker)
  return 'current'
}

export async function assertTransactionOwnedState(args: {
  transactionRoot: string
  marker: SkillTransactionMarker
  assertParent: () => Promise<void>
  allowAppliedOperation: boolean
}): Promise<SkillTransactionLiveState> {
  await args.assertParent()
  if (args.marker.phase === 'staging' || !args.marker.publication) {
    throw new Error('skill-transaction-recovery-required')
  }
  await assertBackupPrior(args.transactionRoot, args.marker)
  if (args.marker.publication.kind === 'in-place') {
    return assertInPlaceState(args)
  }
  return assertSwapState(args)
}
