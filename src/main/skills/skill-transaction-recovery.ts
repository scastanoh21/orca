import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ManagedSkillDestination } from '../../shared/skill-management'
import {
  assertManagedSkillParentTopology,
  normalizedSkillIdentityPath
} from './skill-installation-topology'
import { parseSkillTransactionMarker } from './skill-transaction-marker'
import { recoverTransactionToPrior } from './skill-transaction-restore'

export async function recoverMarkedSkillTransactions(args: {
  reservedRoot: string
  record: ManagedSkillDestination
}): Promise<void> {
  const entries = await readdir(args.reservedRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'locks') {
      continue
    }
    const transactionRoot = join(args.reservedRoot, entry.name)
    const marker = await readFile(join(transactionRoot, 'transaction.json'), 'utf8')
      .then(parseSkillTransactionMarker)
      .catch(() => null)
    const recordMatchesPrior = marker
      ? marker.priorSnapshot.packageDigest === args.record.installedPackageDigest
      : false
    const recordMatchesCurrent = marker
      ? marker.phase === 'verified' &&
        marker.currentSnapshot.packageDigest === args.record.installedPackageDigest
      : false
    if (
      !marker ||
      marker.destinationId !== args.record.id ||
      marker.hostId !== args.record.hostId ||
      marker.skillName !== args.record.skillName ||
      normalizedSkillIdentityPath(marker.destinationPath) !==
        normalizedSkillIdentityPath(args.record.resolvedPath) ||
      (!recordMatchesPrior && !recordMatchesCurrent)
    ) {
      continue
    }
    await recoverTransactionToPrior({
      transactionRoot,
      marker,
      assertParentAuthority: () => assertManagedSkillParentTopology(args.record),
      currentDisposition:
        marker.phase === 'verified' && recordMatchesCurrent ? 'committed' : 'restore'
    })
    await rm(transactionRoot, { recursive: true, force: true })
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM')
  }
}

export async function acquireSkillDestinationLock(
  lockRoot: string,
  beforeMutation: () => Promise<void> = async () => undefined
): Promise<() => Promise<void>> {
  const create = async (): Promise<void> => {
    await beforeMutation()
    await mkdir(lockRoot)
    await beforeMutation()
    await writeFile(
      join(lockRoot, 'owner.json'),
      JSON.stringify({ schemaVersion: 1, pid: process.pid, createdAt: Date.now() })
    )
  }
  try {
    await create()
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') {
      throw error
    }
    const owner = await readFile(join(lockRoot, 'owner.json'), 'utf8')
      .then((value) => JSON.parse(value) as unknown)
      .catch(() => null)
    if (
      typeof owner !== 'object' ||
      owner === null ||
      !('schemaVersion' in owner) ||
      owner.schemaVersion !== 1 ||
      !('pid' in owner) ||
      typeof owner.pid !== 'number' ||
      processIsAlive(owner.pid)
    ) {
      throw new Error('skill-update-busy')
    }
    // Why: only an Orca-marked lock whose owner is gone is safe to reclaim.
    await beforeMutation()
    await rm(lockRoot, { recursive: true })
    await create()
  }
  return () => rm(lockRoot, { recursive: true, force: true })
}
