import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { SkillManagementLedger } from '../../shared/skill-management'
import { normalizedSkillIdentityPath } from './skill-installation-topology'
import {
  parseSkillTransactionMarker,
  type SkillTransactionMarker
} from './skill-transaction-marker'
import { RESERVED_SKILL_TRANSACTION_DIRECTORY } from './skill-transaction-paths'
import { acquireSkillDestinationLock } from './skill-transaction-recovery'
import { recoverTransactionToPrior } from './skill-transaction-restore'

async function assertApprovedDestinationParent(
  marker: SkillTransactionMarker,
  rootIdentity: string
): Promise<void> {
  if (normalizedSkillIdentityPath(dirname(resolve(marker.destinationPath))) !== rootIdentity) {
    throw new Error('skill-transaction-destination-outside-root')
  }
  const [parentStat, parentIdentity] = await Promise.all([
    lstat(dirname(marker.destinationPath)),
    realpath(dirname(marker.destinationPath)).then(normalizedSkillIdentityPath)
  ])
  if (parentStat.isSymbolicLink() || parentIdentity !== rootIdentity) {
    throw new Error('skill-transaction-destination-outside-root')
  }
}

export async function sweepOrphanedSkillTransactions(
  approvedSkillsRoot: string,
  ledger: SkillManagementLedger
): Promise<void> {
  const linkedRoot = await Promise.all([
    lstat(approvedSkillsRoot),
    lstat(dirname(approvedSkillsRoot))
  ])
    .then((entries) => entries.some((entry) => entry.isSymbolicLink()))
    .catch(() => true)
  if (linkedRoot) {
    return
  }
  const rootIdentity = normalizedSkillIdentityPath(await realpath(approvedSkillsRoot))
  const reservedRoots = [
    join(dirname(approvedSkillsRoot), RESERVED_SKILL_TRANSACTION_DIRECTORY),
    join(approvedSkillsRoot, RESERVED_SKILL_TRANSACTION_DIRECTORY)
  ]
  for (const reservedRoot of reservedRoots) {
    const reservedRootSafe = await lstat(reservedRoot)
      .then((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .catch(() => false)
    if (!reservedRootSafe) {
      continue
    }
    const entries = await readdir(reservedRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'locks') {
        continue
      }
      const transactionRoot = join(reservedRoot, entry.name)
      const marker = await readFile(join(transactionRoot, 'transaction.json'), 'utf8')
        .then(parseSkillTransactionMarker)
        .catch(() => null)
      if (!marker || marker.hostId !== 'local') {
        continue
      }
      try {
        await assertApprovedDestinationParent(marker, rootIdentity)
      } catch {
        continue
      }
      const locksRoot = join(reservedRoot, 'locks')
      await mkdir(locksRoot, { recursive: true })
      const locksRootSafe = await lstat(locksRoot).then(
        (lockStat) => lockStat.isDirectory() && !lockStat.isSymbolicLink()
      )
      if (!locksRootSafe) {
        continue
      }
      let release: (() => Promise<void>) | null = null
      try {
        release = await acquireSkillDestinationLock(join(locksRoot, marker.destinationId))
        const record = ledger.destinations[marker.destinationId]
        const committed = Boolean(
          marker.phase === 'verified' &&
          record?.hostId === marker.hostId &&
          normalizedSkillIdentityPath(record.resolvedPath) ===
            normalizedSkillIdentityPath(marker.destinationPath) &&
          record.installedPackageDigest === marker.currentSnapshot.packageDigest
        )
        await recoverTransactionToPrior({
          transactionRoot,
          marker,
          assertParentAuthority: () => assertApprovedDestinationParent(marker, rootIdentity),
          currentDisposition: committed ? 'committed' : 'restore'
        })
        await rm(transactionRoot, { recursive: true, force: true })
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'skill-update-busy') {
          throw error
        }
      } finally {
        await release?.()
      }
    }
  }
}
