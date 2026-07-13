import type { ExecutionHostId } from '../../shared/execution-host'
import type { DismissedSkillAdoptionCandidate } from '../../shared/skill-management'

export function createSkillAdoptionDismissal(
  value: unknown,
  hostId: ExecutionHostId,
  dismissedAt = Date.now()
): DismissedSkillAdoptionCandidate {
  if (typeof value !== 'object' || value === null) {
    throw new Error('skill-adoption-candidate-invalid')
  }
  const candidate = value as Partial<DismissedSkillAdoptionCandidate>
  if (
    candidate.hostId !== hostId ||
    typeof candidate.physicalIdentity !== 'string' ||
    candidate.physicalIdentity.length === 0 ||
    typeof candidate.skillName !== 'string' ||
    candidate.skillName.length === 0 ||
    typeof candidate.snapshotDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidate.snapshotDigest)
  ) {
    throw new Error('skill-adoption-candidate-invalid')
  }
  return {
    hostId,
    physicalIdentity: candidate.physicalIdentity,
    skillName: candidate.skillName,
    snapshotDigest: candidate.snapshotDigest,
    dismissedAt
  }
}
