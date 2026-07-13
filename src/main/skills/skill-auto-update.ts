import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  ManagedSkillDestination,
  SkillManagementInventory,
  SkillManagementLedger
} from '../../shared/skill-management'
import { inventoryManagedSkills } from './skill-management-inventory'
import { updateManagedSkill } from './skill-managed-update'

export type SkillAutoUpdateOutcome = {
  updatedSkillNames: string[]
  failedSkillNames: string[]
  inventory: SkillManagementInventory
}

export async function autoUpdateManagedSkills(args: {
  hostId: ExecutionHostId
  homeDir: string
  resourceRoot?: string
  now?: number
  getLedger: () => SkillManagementLedger
  commit: (destination: ManagedSkillDestination) => void | Promise<void>
  recordFailure: (prior: ManagedSkillDestination, error: unknown) => void | Promise<void>
  beforeWrites?: () => Promise<void>
}): Promise<SkillAutoUpdateOutcome> {
  const inventory = await inventoryManagedSkills({
    ledger: args.getLedger(),
    hostId: args.hostId,
    homeDir: args.homeDir,
    resourceRoot: args.resourceRoot
  })
  // Why: auto-update may touch only destinations the user already manages;
  // a failed destination stays update-failed until an explicit retry, so a
  // background batch can never loop on the same broken package.
  const candidates = inventory.installations.filter(
    (installation) =>
      installation.managed &&
      installation.status === 'managed-update-available' &&
      installation.actionsSupported
  )
  if (candidates.length === 0) {
    return { updatedSkillNames: [], failedSkillNames: [], inventory }
  }
  await args.beforeWrites?.()
  const updatedSkillNames: string[] = []
  const failedSkillNames: string[] = []
  // Why: destinations publish serially so one stalled filesystem cannot fan
  // out concurrent transactions across every managed skill.
  for (const candidate of candidates) {
    try {
      await updateManagedSkill({
        ledger: args.getLedger(),
        hostId: args.hostId,
        homeDir: args.homeDir,
        installationId: candidate.id,
        resourceRoot: args.resourceRoot,
        now: args.now,
        commit: args.commit
      })
      updatedSkillNames.push(candidate.name)
    } catch (error) {
      failedSkillNames.push(candidate.name)
      const prior = args.getLedger().destinations[candidate.id]
      if (prior) {
        await args.recordFailure(prior, error)
      }
    }
  }
  return {
    updatedSkillNames,
    failedSkillNames,
    inventory: await inventoryManagedSkills({
      ledger: args.getLedger(),
      hostId: args.hostId,
      homeDir: args.homeDir,
      resourceRoot: args.resourceRoot
    })
  }
}
