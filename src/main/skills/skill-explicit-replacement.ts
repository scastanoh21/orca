import { readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  ManagedSkillDestination,
  SkillManagementLedger,
  SkillReplacementFilePreview,
  SkillReplacementPreview,
  SkillReleasedSnapshot
} from '../../shared/skill-management'
import { loadSkillBundleArtifacts } from './skill-bundle-artifacts'
import { normalizedSkillIdentityPath } from './skill-installation-topology'
import { inventoryManagedSkills } from './skill-management-inventory'
import {
  observeSkillPackage,
  persistedObservedFiles,
  type ObservedSkillPackage
} from './skill-package-identity'
import { publishBundledSkill } from './skill-package-publish'

function decodedText(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

async function replacementFiles(
  observed: ObservedSkillPackage,
  packageRoot: string,
  currentPaths: readonly string[]
): Promise<SkillReplacementFilePreview[]> {
  const observedByPath = new Map(observed.files.map((file) => [file.path, file]))
  const paths = [...new Set([...observedByPath.keys(), ...currentPaths])].sort()
  const previews = await Promise.all(
    paths.map(async (path): Promise<SkillReplacementFilePreview | null> => {
      const before = observedByPath.get(path)
      const afterBytes = currentPaths.includes(path)
        ? await readFile(join(packageRoot, ...path.split('/')))
        : null
      if (before && afterBytes && before.bytes.equals(afterBytes)) {
        return null
      }
      return {
        path,
        change: before ? (afterBytes ? 'modified' : 'removed') : 'added',
        beforeText: before ? decodedText(before.bytes) : null,
        afterText: afterBytes ? decodedText(afterBytes) : null
      }
    })
  )
  return previews.filter((preview): preview is SkillReplacementFilePreview => preview !== null)
}

async function replacementContext(args: {
  ledger: SkillManagementLedger
  hostId: ExecutionHostId
  homeDir: string
  installationId: string
  resourceRoot?: string
}) {
  const inventory = await inventoryManagedSkills(args)
  const installation = inventory.installations.find((entry) => entry.id === args.installationId)
  if (
    !installation ||
    (installation.status !== 'modified' && installation.status !== 'unknown') ||
    !installation.resolvedPath ||
    !installation.physicalIdentity ||
    (installation.topology !== 'canonical-copy' && installation.topology !== 'independent-copy')
  ) {
    throw new Error('skill-installation-not-replaceable')
  }
  const artifacts = await loadSkillBundleArtifacts(args.resourceRoot)
  const current = artifacts.manifest.skills.find((entry) => entry.name === installation.name)
  if (!current) {
    throw new Error('skill-bundle-entry-missing')
  }
  const observed = await observeSkillPackage(installation.resolvedPath)
  return { installation, artifacts, current, observed }
}

export async function previewExplicitSkillReplacement(args: {
  ledger: SkillManagementLedger
  hostId: ExecutionHostId
  homeDir: string
  installationId: string
  resourceRoot?: string
}): Promise<SkillReplacementPreview> {
  const { installation, artifacts, current, observed } = await replacementContext(args)
  return {
    installationId: installation.id,
    skillName: installation.name,
    files: await replacementFiles(
      observed,
      join(artifacts.packagesRoot, installation.name),
      current.files.map((file) => file.path)
    )
  }
}

export async function replaceSkillWithCurrentBundle(args: {
  ledger: SkillManagementLedger
  hostId: ExecutionHostId
  homeDir: string
  installationId: string
  resourceRoot?: string
  now?: number
  commit: (destination: ManagedSkillDestination) => void | Promise<void>
}): Promise<ManagedSkillDestination> {
  const { installation, artifacts, current, observed } = await replacementContext(args)
  const now = args.now ?? Date.now()
  const installedFiles = persistedObservedFiles(observed)
  const observedSnapshot: SkillReleasedSnapshot = {
    releaseRevision: 0,
    packageDigest: observed.observedDigest,
    gitTreeSha: '',
    files: installedFiles
  }
  const homeIdentity = normalizedSkillIdentityPath(
    await realpath(args.homeDir).catch(() => resolve(args.homeDir))
  )
  const record: ManagedSkillDestination = {
    id: installation.id,
    hostId: args.hostId,
    homeIdentity,
    rootId: installation.rootId,
    unresolvedPath: installation.unresolvedPath,
    resolvedPath: installation.resolvedPath!,
    physicalIdentity: installation.physicalIdentity!,
    entryType: 'directory',
    skillName: installation.name,
    source: 'stablyai/orca',
    sourcePath: current.sourcePath,
    sourceRef: null,
    installedReleaseRevision: 0,
    installedPackageDigest: observed.observedDigest,
    installedFiles,
    lastWrittenPackageDigest: null,
    lastAttemptedBundleFingerprint: current.packageDigest,
    lastOutcome: 'replaced',
    lastErrorCategory: null,
    adoptedFrom: 'explicit-replacement',
    adoptedAt: now,
    updatedAt: now
  }
  const published = await publishBundledSkill({
    record,
    current,
    releasedSnapshots: [observedSnapshot],
    packagesRoot: artifacts.packagesRoot,
    commit: (destination) =>
      args.commit({
        ...destination,
        lastOutcome: 'replaced',
        adoptedFrom: 'explicit-replacement'
      }),
    now
  })
  return { ...published, lastOutcome: 'replaced', adoptedFrom: 'explicit-replacement' }
}
