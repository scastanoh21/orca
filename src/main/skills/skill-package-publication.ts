import { rmdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  ManagedSkillDestination,
  SkillCurrentBundleEntry,
  SkillReleasedSnapshot
} from '../../shared/skill-management'
import {
  skillInPlaceOperations,
  type SkillPublicationState
} from './skill-transaction-publication-state'
import type { SkillTransactionLiveState } from './skill-transaction-owned-state'
import { publishSkillFileThroughOwnedTemp } from './skill-owned-temp-publication'
import type { SkillOwnedTempRuntime } from './skill-owned-temp-publication'
import { retrySkillRename, type SkillRenameRuntime } from './skill-transaction-rename'

export type PublicationCallbacks = {
  journal: (state: SkillPublicationState) => Promise<void>
  assertBoundary: (
    state: SkillPublicationState,
    expectedLiveState?: SkillTransactionLiveState
  ) => Promise<void>
}

export type SkillPackageSwapOutcome =
  | { kind: 'complete' }
  | { kind: 'pre-mutation-sharing-violation'; error: unknown }

export function destinationUsesCrlf(record: ManagedSkillDestination): boolean {
  return record.installedFiles.some(
    (file) =>
      file.classification === 'text' &&
      file.textNormalizedSha256 !== null &&
      file.exactSha256 !== file.textNormalizedSha256
  )
}

export async function publishSkillPackageInPlace(args: {
  record: ManagedSkillDestination
  current: SkillCurrentBundleEntry
  prior: SkillReleasedSnapshot
  stageRoot: string
  callbacks: PublicationCallbacks
  ownedTempRuntime?: SkillOwnedTempRuntime
}): Promise<void> {
  const operations = skillInPlaceOperations(args.prior, args.current)
  const currentByPath = new Map(args.current.files.map((file) => [file.path, file]))
  await args.callbacks.journal({
    kind: 'in-place',
    direction: 'forward',
    physicalIdentity: args.record.physicalIdentity,
    temporary: null,
    operationIndex: 0,
    operationState: 'ready'
  })
  for (const [operationIndex, operation] of operations.entries()) {
    const applying = {
      kind: 'in-place',
      direction: 'forward',
      physicalIdentity: args.record.physicalIdentity,
      temporary: null,
      operationIndex,
      operationState: 'applying'
    } as const
    await args.callbacks.journal(applying)
    const livePath = join(args.record.resolvedPath, ...operation.path.split('/'))
    if (operation.kind === 'publish') {
      const file = currentByPath.get(operation.path)
      if (!file) {
        throw new Error('skill-publication-operation-invalid')
      }
      await publishSkillFileThroughOwnedTemp({
        destinationRoot: args.record.resolvedPath,
        sourcePath: join(args.stageRoot, ...file.path.split('/')),
        expectedFile: file,
        direction: 'forward',
        packagePhysicalIdentity: args.record.physicalIdentity,
        operationIndex,
        callbacks: args.callbacks,
        runtime: args.ownedTempRuntime
      })
    } else {
      await args.callbacks.assertBoundary(applying)
      await unlink(livePath)
    }
    const ready = {
      kind: 'in-place',
      direction: 'forward',
      physicalIdentity: args.record.physicalIdentity,
      temporary: null,
      operationIndex: operationIndex + 1,
      operationState: 'ready'
    } as const
    await args.callbacks.journal(ready)
    if (operation.kind === 'remove') {
      let parent = dirname(livePath)
      while (parent !== args.record.resolvedPath) {
        await args.callbacks.assertBoundary(ready)
        await rmdir(parent).catch(() => undefined)
        parent = dirname(parent)
      }
    }
  }
}

async function publishPackageSwap(args: {
  record: ManagedSkillDestination
  stageRoot: string
  transactionRoot: string
  callbacks: PublicationCallbacks
  renameRuntime?: SkillRenameRuntime
}): Promise<SkillPackageSwapOutcome> {
  const oldLiveRoot = join(args.transactionRoot, 'old-live')
  const movingLive = { kind: 'package-swap', step: 'moving-live' } as const
  await args.callbacks.journal(movingLive)
  try {
    await retrySkillRename(
      args.record.resolvedPath,
      oldLiveRoot,
      () => args.callbacks.assertBoundary(movingLive, 'prior'),
      args.renameRuntime?.renameEntry,
      args.renameRuntime?.wait
    )
  } catch (error) {
    if (
      isSharingViolation(error, args.renameRuntime?.windowsFallback ?? process.platform === 'win32')
    ) {
      return { kind: 'pre-mutation-sharing-violation', error }
    }
    throw error
  }
  await args.callbacks.journal({ kind: 'package-swap', step: 'live-moved' })
  const movingStage = { kind: 'package-swap', step: 'moving-stage' } as const
  await args.callbacks.journal(movingStage)
  try {
    await retrySkillRename(
      args.stageRoot,
      args.record.resolvedPath,
      () => args.callbacks.assertBoundary(movingStage, 'swap-absent'),
      args.renameRuntime?.renameEntry,
      args.renameRuntime?.wait
    )
  } catch (error) {
    // Why: only the marker-owned old-live directory may fill the verified gap.
    await retrySkillRename(
      oldLiveRoot,
      args.record.resolvedPath,
      () => args.callbacks.assertBoundary(movingStage, 'swap-absent'),
      args.renameRuntime?.renameEntry,
      args.renameRuntime?.wait
    )
    await args.callbacks.journal(movingLive)
    throw error
  }
  await args.callbacks.journal({ kind: 'package-swap', step: 'stage-moved' })
  // Why: old-live retains the original directory identity until the ledger commit.
  await args.callbacks.journal({ kind: 'package-swap', step: 'complete' })
  return { kind: 'complete' }
}

function isSharingViolation(error: unknown, enabled: boolean): boolean {
  return Boolean(
    enabled &&
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'EPERM' || error.code === 'EBUSY')
  )
}

export async function rollbackSkillPackageSwap(args: {
  record: ManagedSkillDestination
  transactionRoot: string
  callbacks: PublicationCallbacks
  renameRuntime?: SkillRenameRuntime
}): Promise<void> {
  const stageRoot = join(args.transactionRoot, 'stage')
  const oldLiveRoot = join(args.transactionRoot, 'old-live')
  const movingCurrent = { kind: 'package-swap', step: 'rollback-moving-current' } as const
  await args.callbacks.journal(movingCurrent)
  await retrySkillRename(
    args.record.resolvedPath,
    stageRoot,
    () => args.callbacks.assertBoundary(movingCurrent, 'current'),
    args.renameRuntime?.renameEntry,
    args.renameRuntime?.wait
  )
  await args.callbacks.journal({ kind: 'package-swap', step: 'rollback-current-moved' })
  const movingOldLive = { kind: 'package-swap', step: 'rollback-moving-old-live' } as const
  await args.callbacks.journal(movingOldLive)
  await retrySkillRename(
    oldLiveRoot,
    args.record.resolvedPath,
    () => args.callbacks.assertBoundary(movingOldLive, 'swap-absent'),
    args.renameRuntime?.renameEntry,
    args.renameRuntime?.wait
  )
  await args.callbacks.journal({ kind: 'package-swap', step: 'moving-live' })
}

export async function replaceSkillPackage(args: {
  record: ManagedSkillDestination
  current: SkillCurrentBundleEntry
  prior: SkillReleasedSnapshot
  stageRoot: string
  transactionRoot: string
  callbacks: PublicationCallbacks
  renameRuntime?: SkillRenameRuntime
}): Promise<void> {
  const outcome = await publishPackageSwap(args)
  if (outcome.kind === 'pre-mutation-sharing-violation') {
    // Why: the in-place journal may replace swap state only while live is untouched.
    await args.callbacks.assertBoundary({ kind: 'package-swap', step: 'moving-live' }, 'prior')
    await publishSkillPackageInPlace(args)
  }
}
