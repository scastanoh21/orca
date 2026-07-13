import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  SkillCurrentBundleEntry,
  SkillManagementInstallation
} from '../../shared/skill-management'
import type { SkillScanRoot } from './skill-discovery-sources'
import { skillDestinationId } from './skill-installation-topology'

export type ClassifiedSkillCandidate = {
  installation: SkillManagementInstallation
  logicalEntryType: 'directory' | 'symlink' | 'junction'
}

function errorCategory(error: unknown, fallback: string): string {
  return error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'EACCES' || error.code === 'EPERM')
    ? 'skill-candidate-access-denied'
    : fallback
}

export function createInaccessibleSkillCandidate(args: {
  root: SkillScanRoot
  name: string
  current: SkillCurrentBundleEntry
  hostId: ExecutionHostId
  unresolvedPath: string
  error: unknown
  fallbackErrorCategory?: string
}): ClassifiedSkillCandidate {
  return {
    logicalEntryType: 'directory',
    installation: {
      id: skillDestinationId(args.hostId, args.unresolvedPath, args.name),
      hostId: args.hostId,
      name: args.name,
      description: null,
      rootId: args.root.id,
      providers: args.root.providers,
      unresolvedPath: args.unresolvedPath,
      resolvedPath: null,
      physicalIdentity: null,
      topology: 'read-only',
      status: 'inaccessible',
      eligible: false,
      managed: false,
      installedReleaseRevision: null,
      installedAppVersion: null,
      installedPackageDigest: null,
      currentReleaseRevision: args.current.releaseRevision,
      currentPackageDigest: args.current.packageDigest,
      currentAppVersion: args.current.appVersion,
      errorCategory: errorCategory(
        args.error,
        args.fallbackErrorCategory ?? 'skill-candidate-lstat-failed'
      ),
      adoptionPromptEligible: false,
      lockCorroborated: false,
      actionsSupported: false
    }
  }
}
