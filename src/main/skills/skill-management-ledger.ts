import type {
  DismissedSkillAdoptionCandidate,
  ManagedSkillDestination,
  SkillManagementLedger
} from '../../shared/skill-management'
import { normalizeExecutionHostId } from '../../shared/execution-host'

const SHA256 = /^[a-f0-9]{64}$/

export function emptySkillManagementLedger(): SkillManagementLedger {
  return { schemaVersion: 1, destinations: {}, dismissedAdoptionCandidates: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isFileIdentity(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    !value.path.startsWith('/') &&
    !value.path.includes('\\') &&
    !value.path.split('/').includes('..') &&
    Number.isSafeInteger(value.size) &&
    (value.size as number) >= 0 &&
    typeof value.executable === 'boolean' &&
    (value.classification === 'text' || value.classification === 'binary') &&
    typeof value.exactSha256 === 'string' &&
    SHA256.test(value.exactSha256) &&
    (value.textNormalizedSha256 === null ||
      (typeof value.textNormalizedSha256 === 'string' &&
        SHA256.test(value.textNormalizedSha256))) &&
    typeof value.identitySha256 === 'string' &&
    SHA256.test(value.identitySha256)
  )
}

function isManagedDestination(key: string, value: unknown): value is ManagedSkillDestination {
  if (!isRecord(value)) {
    return false
  }
  return (
    value.id === key &&
    typeof value.hostId === 'string' &&
    normalizeExecutionHostId(value.hostId) === value.hostId &&
    typeof value.homeIdentity === 'string' &&
    typeof value.rootId === 'string' &&
    typeof value.unresolvedPath === 'string' &&
    typeof value.resolvedPath === 'string' &&
    typeof value.physicalIdentity === 'string' &&
    (value.entryType === 'directory' ||
      value.entryType === 'symlink' ||
      value.entryType === 'junction') &&
    typeof value.skillName === 'string' &&
    value.source === 'stablyai/orca' &&
    typeof value.sourcePath === 'string' &&
    isNullableString(value.sourceRef) &&
    Number.isSafeInteger(value.installedReleaseRevision) &&
    (value.installedReleaseRevision as number) >= 0 &&
    typeof value.installedPackageDigest === 'string' &&
    SHA256.test(value.installedPackageDigest) &&
    Array.isArray(value.installedFiles) &&
    value.installedFiles.every(isFileIdentity) &&
    isNullableString(value.lastWrittenPackageDigest) &&
    (value.lastWrittenPackageDigest === null || SHA256.test(value.lastWrittenPackageDigest)) &&
    isNullableString(value.lastAttemptedBundleFingerprint) &&
    (value.lastAttemptedBundleFingerprint === null ||
      SHA256.test(value.lastAttemptedBundleFingerprint)) &&
    (value.lastOutcome === 'adopted' ||
      value.lastOutcome === 'updated' ||
      value.lastOutcome === 'replaced' ||
      value.lastOutcome === 'failed') &&
    isNullableString(value.lastErrorCategory) &&
    (value.adoptedFrom === 'orca-install' ||
      value.adoptedFrom === 'exact-snapshot' ||
      value.adoptedFrom === 'explicit-replacement') &&
    typeof value.adoptedAt === 'number' &&
    Number.isFinite(value.adoptedAt) &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt)
  )
}

export function normalizeSkillManagementLedger(value: unknown): SkillManagementLedger {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.destinations)) {
    return emptySkillManagementLedger()
  }

  const destinations = Object.fromEntries(
    Object.entries(value.destinations).filter((entry): entry is [string, ManagedSkillDestination] =>
      isManagedDestination(entry[0], entry[1])
    )
  )
  const dismissedAdoptionCandidates = Array.isArray(value.dismissedAdoptionCandidates)
    ? value.dismissedAdoptionCandidates.filter(
        (candidate): candidate is DismissedSkillAdoptionCandidate =>
          isRecord(candidate) &&
          typeof candidate.hostId === 'string' &&
          typeof candidate.physicalIdentity === 'string' &&
          typeof candidate.skillName === 'string' &&
          typeof candidate.snapshotDigest === 'string' &&
          typeof candidate.dismissedAt === 'number'
      )
    : []

  return { schemaVersion: 1, destinations, dismissedAdoptionCandidates }
}

export function skillAdoptionDismissalKey(
  candidate: Pick<
    DismissedSkillAdoptionCandidate,
    'hostId' | 'physicalIdentity' | 'skillName' | 'snapshotDigest'
  >
): string {
  return [
    candidate.hostId,
    candidate.physicalIdentity,
    candidate.skillName,
    candidate.snapshotDigest
  ].join('\0')
}
