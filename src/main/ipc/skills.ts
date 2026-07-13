import { ipcMain } from 'electron'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Store } from '../persistence'
import { discoverSkills } from '../skills/discovery'
import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../../shared/skills'
import type {
  OrcaSkillInstallResultArgs,
  SkillAdoptionDismissalArgs,
  SkillAutoUpdateBatchArgs,
  SkillAutoUpdateBatchResult,
  SkillManagementActionArgs,
  SkillManagementInventory,
  SkillReplacementPreview
} from '../../shared/skill-management'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  getSkillDiscoveryRuntimeTarget,
  getSkillManagementHostContext
} from './skill-management-host-context'
import {
  productionSkillHandlerRuntimeFacts,
  recoverSkillTransactionsBeforeWrites,
  requireSkillMutation,
  skillFailureCategory,
  type SkillHandlerRuntimeFacts
} from './skill-write-authorization'
import { inventoryManagedSkills } from '../skills/skill-management-inventory'
import { adoptExactSkillSnapshot } from '../skills/skill-adoption'
import {
  previewExplicitSkillReplacement,
  replaceSkillWithCurrentBundle
} from '../skills/skill-explicit-replacement'
import { updateManagedSkill } from '../skills/skill-managed-update'
import { autoUpdateManagedSkills } from '../skills/skill-auto-update'
import { createSkillAdoptionDismissal } from '../skills/skill-adoption-dismissal'
import { canMutateManagedSkills } from '../skills/skill-mutation-authority'

const MAX_ORCA_SKILL_INSTALL_ATTEMPT_MS = 15 * 60 * 1_000

export function registerSkillsHandlers(
  store: Store,
  runtimeFacts: SkillHandlerRuntimeFacts = productionSkillHandlerRuntimeFacts()
): void {
  ipcMain.handle(
    'skills:discover',
    async (_event, target?: SkillDiscoveryTarget): Promise<SkillDiscoveryResult> => {
      const runtimeTarget = getSkillDiscoveryRuntimeTarget(target)
      if (runtimeTarget.runtime === 'wsl') {
        const { homeDir } = getSkillManagementHostContext(target)
        return discoverSkills({ repos: [], homeDir, cwd: homeDir })
      }

      const cwd = target?.cwd?.trim() || undefined
      return cwd ? discoverSkills({ repos: [], cwd }) : discoverSkills({ repos: store.getRepos() })
    }
  )

  ipcMain.handle(
    'skills:managementInventory',
    async (_event, target?: SkillDiscoveryTarget): Promise<SkillManagementInventory> => {
      const context = getSkillManagementHostContext(target)
      return inventoryManagedSkills({
        ...context,
        ledger: store.getSkillManagementLedger(),
        actionsSupported: canMutateManagedSkills({ ...runtimeFacts, homeDir: context.homeDir })
      })
    }
  )

  ipcMain.handle(
    'skills:adopt',
    async (_event, args: SkillManagementActionArgs): Promise<SkillManagementInventory> => {
      const context = getSkillManagementHostContext(args.target)
      await recoverSkillTransactionsBeforeWrites(context, store, runtimeFacts)
      await adoptExactSkillSnapshot({
        ...context,
        ledger: store.getSkillManagementLedger(),
        installationId: args.installationId,
        commit: (next) => store.setManagedSkillDestination(next)
      })
      return inventoryManagedSkills({ ...context, ledger: store.getSkillManagementLedger() })
    }
  )

  ipcMain.handle(
    'skills:dismissAdoption',
    async (_event, args: SkillAdoptionDismissalArgs): Promise<SkillManagementInventory> => {
      const context = getSkillManagementHostContext(args.target)
      requireSkillMutation(context, runtimeFacts)
      store.dismissSkillAdoptionCandidate(
        createSkillAdoptionDismissal(args?.candidate, context.hostId)
      )
      return inventoryManagedSkills({ ...context, ledger: store.getSkillManagementLedger() })
    }
  )

  ipcMain.handle(
    'skills:previewReplacement',
    async (_event, args: SkillManagementActionArgs): Promise<SkillReplacementPreview> => {
      const context = getSkillManagementHostContext(args.target)
      return previewExplicitSkillReplacement({
        ...context,
        ledger: store.getSkillManagementLedger(),
        installationId: args.installationId
      })
    }
  )

  ipcMain.handle(
    'skills:replace',
    async (_event, args: SkillManagementActionArgs): Promise<SkillManagementInventory> => {
      const context = getSkillManagementHostContext(args.target)
      await recoverSkillTransactionsBeforeWrites(context, store, runtimeFacts)
      await replaceSkillWithCurrentBundle({
        ...context,
        ledger: store.getSkillManagementLedger(),
        installationId: args.installationId,
        commit: (next) => store.setManagedSkillDestination(next)
      })
      return inventoryManagedSkills({ ...context, ledger: store.getSkillManagementLedger() })
    }
  )

  ipcMain.handle(
    'skills:updateManaged',
    async (_event, args: SkillManagementActionArgs): Promise<SkillManagementInventory> => {
      const context = getSkillManagementHostContext(args.target)
      await recoverSkillTransactionsBeforeWrites(context, store, runtimeFacts)
      const ledger = store.getSkillManagementLedger()
      try {
        await updateManagedSkill({
          ...context,
          ledger,
          installationId: args.installationId,
          commit: (next) => store.setManagedSkillDestination(next)
        })
      } catch (error) {
        const prior = ledger.destinations[args.installationId]
        if (prior) {
          store.setManagedSkillDestination({
            ...prior,
            lastOutcome: 'failed',
            lastErrorCategory: skillFailureCategory(error),
            updatedAt: Date.now()
          })
        }
        throw error
      }
      return inventoryManagedSkills({ ...context, ledger: store.getSkillManagementLedger() })
    }
  )

  let autoUpdateBatch: Promise<SkillAutoUpdateBatchResult> | null = null
  ipcMain.handle(
    'skills:autoUpdateManaged',
    async (_event, args?: SkillAutoUpdateBatchArgs): Promise<SkillAutoUpdateBatchResult> => {
      const context = getSkillManagementHostContext(args?.target)
      if (
        context.hostId !== LOCAL_EXECUTION_HOST_ID ||
        store.getSettings().managedSkillAutoUpdateEnabled === false ||
        !canMutateManagedSkills({ ...runtimeFacts, homeDir: context.homeDir })
      ) {
        // Why: a background batch declines silently; only explicit user
        // actions surface host or build-authority errors.
        return { updatedSkillNames: [], failedSkillNames: [], inventory: null }
      }
      // Why: launch, focus, and post-install triggers coalesce into one batch
      // so duplicate signals cannot start overlapping transactions.
      autoUpdateBatch ??= autoUpdateManagedSkills({
        ...context,
        getLedger: () => store.getSkillManagementLedger(),
        commit: (next) => store.setManagedSkillDestination(next),
        recordFailure: (prior, error) =>
          store.setManagedSkillDestination({
            ...prior,
            lastOutcome: 'failed',
            lastErrorCategory: skillFailureCategory(error),
            updatedAt: Date.now()
          }),
        beforeWrites: () => recoverSkillTransactionsBeforeWrites(context, store, runtimeFacts)
      }).finally(() => {
        autoUpdateBatch = null
      })
      return autoUpdateBatch
    }
  )

  ipcMain.handle(
    'skills:recordOrcaInstall',
    async (_event, args: OrcaSkillInstallResultArgs): Promise<SkillManagementInventory> => {
      const context = getSkillManagementHostContext(args.target)
      const completedAt = Date.now()
      if (
        !Number.isFinite(args.startedAt) ||
        args.startedAt <= 0 ||
        args.startedAt > completedAt ||
        completedAt - args.startedAt > MAX_ORCA_SKILL_INSTALL_ATTEMPT_MS
      ) {
        throw new Error('Invalid skill installation start time.')
      }
      await recoverSkillTransactionsBeforeWrites(context, store, runtimeFacts)
      let inventory = await inventoryManagedSkills({
        ...context,
        ledger: store.getSkillManagementLedger()
      })
      for (const skillName of new Set(args.skillNames)) {
        // Why: the global skills CLI owns the canonical .agents placement;
        // provider-specific copies discovered beside it were not necessarily
        // created by this terminal run and must retain separate consent.
        const installation = inventory.installations.find(
          (entry) =>
            entry.name === skillName &&
            entry.rootId === 'home-agents' &&
            entry.eligible &&
            !entry.managed
        )
        if (!installation) {
          continue
        }
        const modifiedAt = await stat(join(installation.unresolvedPath, 'SKILL.md'))
          .then((file) => file.mtimeMs)
          .catch(() => 0)
        // Why: exact content proves provenance, but only an mtime from this
        // terminal window attributes ownership to Orca's install attempt.
        if (modifiedAt + 2_000 < args.startedAt || modifiedAt > completedAt + 2_000) {
          continue
        }
        await adoptExactSkillSnapshot({
          ...context,
          ledger: store.getSkillManagementLedger(),
          installationId: installation.id,
          commit: (next) =>
            store.setManagedSkillDestination({ ...next, adoptedFrom: 'orca-install' })
        })
        inventory = await inventoryManagedSkills({
          ...context,
          ledger: store.getSkillManagementLedger()
        })
      }
      return inventory
    }
  )
}
