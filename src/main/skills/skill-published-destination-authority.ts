import type { ManagedSkillDestination } from '../../shared/skill-management'
import {
  assertManagedSkillParentTopology,
  assertManagedSkillTopology
} from './skill-installation-topology'
import { matchingReleasedSnapshot, observeSkillPackage } from './skill-package-identity'
import type { SkillTransactionMarker } from './skill-transaction-marker'
import { assertTransactionOwnedState } from './skill-transaction-owned-state'

export async function assertManagedDestinationUnchanged(
  record: ManagedSkillDestination,
  snapshots: Parameters<typeof matchingReleasedSnapshot>[1]
): Promise<void> {
  const resolved = await assertManagedSkillTopology(record)
  const observed = await observeSkillPackage(resolved)
  const snapshot = matchingReleasedSnapshot(observed, snapshots)
  if (!snapshot || snapshot.packageDigest !== record.installedPackageDigest) {
    throw new Error('skill-content-changed')
  }
}

export async function assertPublishedDestinationOwned(args: {
  record: ManagedSkillDestination
  transactionRoot: string
  marker: SkillTransactionMarker
}): Promise<string> {
  const publication = args.marker.publication
  if (!publication) {
    throw new Error('skill-transaction-recovery-required')
  }
  const expectedPhysicalIdentity =
    publication.kind === 'package-swap'
      ? args.marker.stagePhysicalIdentity
      : args.record.physicalIdentity
  if (!expectedPhysicalIdentity) {
    throw new Error('skill-transaction-recovery-required')
  }
  const state = await assertTransactionOwnedState({
    transactionRoot: args.transactionRoot,
    marker: args.marker,
    assertParent: () => assertManagedSkillParentTopology(args.record),
    allowAppliedOperation: false
  })
  if (state !== 'current') {
    throw new Error('skill-transaction-recovery-required')
  }
  // Why: exact bytes do not authorize claiming a directory replaced after publish.
  return assertManagedSkillTopology({
    ...args.record,
    physicalIdentity: expectedPhysicalIdentity
  })
}
