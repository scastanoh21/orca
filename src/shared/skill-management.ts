import type { ExecutionHostId } from './execution-host'
import type { SkillProvider } from './skills'
import type { SkillDiscoveryTarget } from './skills'

export type SkillBundleFileIdentity = {
  path: string
  size: number
  executable: boolean
  classification: 'text' | 'binary'
  exactSha256: string
  textNormalizedSha256: string | null
  identitySha256: string
}

export type SkillReleasedSnapshot = {
  releaseRevision: number
  packageDigest: string
  gitTreeSha: string
  files: SkillBundleFileIdentity[]
}

export type SkillCurrentBundleEntry = SkillReleasedSnapshot & {
  name: string
  sourcePath: string
  appVersion: string
}

export type SkillBundleManifest = {
  schemaVersion: 1
  appVersion: string
  skills: SkillCurrentBundleEntry[]
}

export type SkillSnapshotRegistry = {
  schemaVersion: 1
  skills: Record<string, SkillReleasedSnapshot[]>
}

export type SkillReleaseMapping = {
  schemaVersion: 1
  releases: { appVersion: string; skills: Record<string, number> }[]
}

export type SkillManagementStatus =
  | 'managed-current'
  | 'managed-update-available'
  | 'known-current'
  | 'known-update-available'
  | 'newer-known'
  | 'modified'
  | 'unknown'
  | 'externally-managed'
  | 'inaccessible'
  | 'update-failed'

export type SkillInstallationTopology =
  | 'canonical-copy'
  | 'provider-alias'
  | 'independent-copy'
  | 'external-link'
  | 'broken-link'
  | 'read-only'

export type ManagedSkillDestination = {
  id: string
  hostId: ExecutionHostId
  homeIdentity: string
  rootId: string
  unresolvedPath: string
  resolvedPath: string
  physicalIdentity: string
  entryType: 'directory' | 'symlink' | 'junction'
  skillName: string
  source: 'stablyai/orca'
  sourcePath: string
  sourceRef: string | null
  installedReleaseRevision: number
  installedPackageDigest: string
  installedFiles: SkillBundleFileIdentity[]
  lastWrittenPackageDigest: string | null
  lastAttemptedBundleFingerprint: string | null
  lastOutcome: 'adopted' | 'updated' | 'replaced' | 'failed'
  lastErrorCategory: string | null
  adoptedFrom: 'orca-install' | 'exact-snapshot' | 'explicit-replacement'
  adoptedAt: number
  updatedAt: number
}

export type DismissedSkillAdoptionCandidate = {
  hostId: ExecutionHostId
  physicalIdentity: string
  skillName: string
  snapshotDigest: string
  dismissedAt: number
}

export type SkillManagementLedger = {
  schemaVersion: 1
  destinations: Record<string, ManagedSkillDestination>
  dismissedAdoptionCandidates: DismissedSkillAdoptionCandidate[]
}

export type SkillManagementInstallation = {
  id: string
  hostId: ExecutionHostId
  name: string
  description: string | null
  rootId: string
  providers: SkillProvider[]
  unresolvedPath: string
  resolvedPath: string | null
  physicalIdentity: string | null
  topology: SkillInstallationTopology
  status: SkillManagementStatus
  eligible: boolean
  adoptionPromptEligible: boolean
  lockCorroborated: boolean
  actionsSupported: boolean
  managed: boolean
  installedReleaseRevision: number | null
  installedAppVersion: string | null
  currentReleaseRevision: number
  installedPackageDigest: string | null
  currentPackageDigest: string
  currentAppVersion: string
  errorCategory: string | null
}

export type SkillManagementInventory = {
  schemaVersion: 1
  hostId: ExecutionHostId
  installations: SkillManagementInstallation[]
  adoptionCandidateCount: number
  scannedAt: number
}

export type SkillManagementActionArgs = {
  installationId: string
  target?: SkillDiscoveryTarget
}

export type SkillAdoptionDismissalArgs = {
  candidate: Omit<DismissedSkillAdoptionCandidate, 'dismissedAt'>
  target?: SkillDiscoveryTarget
}

export type OrcaSkillInstallResultArgs = {
  skillNames: string[]
  startedAt: number
  target?: SkillDiscoveryTarget
}

export type SkillAutoUpdateBatchArgs = {
  target?: SkillDiscoveryTarget
}

export type SkillAutoUpdateBatchResult = {
  /** Skill names whose managed destination now matches the bundled release. */
  updatedSkillNames: string[]
  /** Skill names whose update failed; they surface in settings as update-failed. */
  failedSkillNames: string[]
  /** Post-batch inventory, or null when auto-update was disabled or unavailable. */
  inventory: SkillManagementInventory | null
}

export type SkillReplacementFilePreview = {
  path: string
  change: 'added' | 'removed' | 'modified'
  beforeText: string | null
  afterText: string | null
}

export type SkillReplacementPreview = {
  installationId: string
  skillName: string
  files: SkillReplacementFilePreview[]
}
