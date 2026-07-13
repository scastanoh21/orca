import type { ExecutionHostId } from '../../shared/execution-host'
import type { ManagedSkillDestination, SkillManagementLedger } from '../../shared/skill-management'
import { loadSkillBundleArtifacts } from './skill-bundle-artifacts'
import { publishBundledSkill } from './skill-package-publish'
import { inventoryManagedSkills } from './skill-management-inventory'

export async function updateManagedSkill(args: {
  ledger: SkillManagementLedger
  hostId: ExecutionHostId
  homeDir: string
  installationId: string
  resourceRoot?: string
  now?: number
  commit: (destination: ManagedSkillDestination) => void | Promise<void>
}): Promise<ManagedSkillDestination> {
  const record = args.ledger.destinations[args.installationId]
  if (!record || record.hostId !== args.hostId) {
    throw new Error('managed-skill-not-found')
  }
  const artifacts = await loadSkillBundleArtifacts(args.resourceRoot)
  const inventory = await inventoryManagedSkills(args)
  const installation = inventory.installations.find((entry) => entry.id === record.id)
  if (
    !installation?.managed ||
    installation.hostId !== record.hostId ||
    installation.physicalIdentity !== record.physicalIdentity ||
    installation.resolvedPath !== record.resolvedPath
  ) {
    throw new Error('managed-skill-identity-changed')
  }
  const current = artifacts.manifest.skills.find((entry) => entry.name === record.skillName)
  if (!current) {
    throw new Error('skill-bundle-entry-missing')
  }
  return publishBundledSkill({
    record,
    current,
    releasedSnapshots: artifacts.releasedSnapshots[record.skillName] ?? [],
    packagesRoot: artifacts.packagesRoot,
    commit: args.commit,
    now: args.now
  })
}
