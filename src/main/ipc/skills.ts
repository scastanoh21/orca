import { app, ipcMain } from 'electron'
import { homedir, tmpdir } from 'node:os'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Store } from '../persistence'
import { discoverSkills } from '../skills/discovery'
import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../../shared/skills'
import type {
  OrcaSkillInstallResultArgs,
  SkillAdoptionDismissalArgs,
  SkillManagementActionArgs,
  SkillManagementInventory,
  SkillReplacementPreview
} from '../../shared/skill-management'
import { getDefaultWslDistro, getWslHome } from '../wsl'
import { LOCAL_EXECUTION_HOST_ID, toWslExecutionHostId } from '../../shared/execution-host'
import { inventoryManagedSkills } from '../skills/skill-management-inventory'
import { adoptExactSkillSnapshot } from '../skills/skill-adoption'
import {
  previewExplicitSkillReplacement,
  replaceSkillWithCurrentBundle
} from '../skills/skill-explicit-replacement'
import { updateManagedSkill } from '../skills/skill-managed-update'
import { createSkillAdoptionDismissal } from '../skills/skill-adoption-dismissal'
import { buildSkillDiscoverySources } from '../skills/skill-discovery-sources'
import { sweepOrphanedSkillTransactions } from '../skills/skill-orphan-transaction-sweep'
import { resolveDiagnosticBuildIdentity } from '../observability/diagnostic-upload-endpoint'
import {
  canMutateManagedSkills,
  type SkillMutationRuntimeFacts
} from '../skills/skill-mutation-authority'

type SkillDiscoveryRuntimeTarget =
  | { runtime: 'host' }
  | { runtime: 'wsl'; wslDistro: string | null | undefined }

const MAX_ORCA_SKILL_INSTALL_ATTEMPT_MS = 15 * 60 * 1_000

type SkillHandlerRuntimeFacts = Omit<SkillMutationRuntimeFacts, 'homeDir'>

function productionSkillHandlerRuntimeFacts(): SkillHandlerRuntimeFacts {
  return {
    isPackaged: app.isPackaged,
    buildIdentity: resolveDiagnosticBuildIdentity(),
    userDataDir: app.getPath('userData'),
    isolatedDevHomeDir: process.env.ORCA_E2E_SKILL_HOME_DIR,
    isolatedDevUserDataDir: process.env.ORCA_E2E_USER_DATA_DIR,
    temporaryRoot: tmpdir()
  }
}

function getSkillDiscoveryRuntimeTarget(
  target: SkillDiscoveryTarget | undefined
): SkillDiscoveryRuntimeTarget {
  if (target?.executionHostId && target.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
    throw new Error('Skill management is not available for remote execution hosts in Phase 1.')
  }
  const projectRuntime = target?.projectRuntime
  if (!projectRuntime) {
    return target?.runtime === 'wsl'
      ? { runtime: 'wsl', wslDistro: target.wslDistro }
      : { runtime: 'host' }
  }

  if (projectRuntime.status === 'repair-required') {
    throw new Error(
      `Project runtime requires repair before skill discovery: ${projectRuntime.repair.reason}`
    )
  }

  if (projectRuntime.runtime.kind === 'wsl') {
    return { runtime: 'wsl', wslDistro: projectRuntime.runtime.distro }
  }

  return { runtime: 'host' }
}

function getSkillManagementHostContext(target: SkillDiscoveryTarget | undefined): {
  hostId: ReturnType<typeof toWslExecutionHostId> | typeof LOCAL_EXECUTION_HOST_ID
  homeDir: string
} {
  const runtimeTarget = getSkillDiscoveryRuntimeTarget(target)
  if (runtimeTarget.runtime === 'host') {
    return { hostId: LOCAL_EXECUTION_HOST_ID, homeDir: homedir() }
  }
  if (process.platform !== 'win32') {
    throw new Error('WSL skill management is only available on Windows.')
  }
  const distro = runtimeTarget.wslDistro?.trim() || getDefaultWslDistro()
  if (!distro) {
    throw new Error('No WSL distribution is available for skill management.')
  }
  const homeDir = getWslHome(distro)
  if (!homeDir) {
    throw new Error(`Could not resolve the WSL home directory for ${distro}.`)
  }
  return { hostId: toWslExecutionHostId(distro), homeDir }
}

function requireSkillMutation(
  context: { hostId: string; homeDir: string },
  runtimeFacts: SkillHandlerRuntimeFacts
): void {
  if (context.hostId !== LOCAL_EXECUTION_HOST_ID) {
    // Why: WSL publication belongs inside the distro runtime; UNC mutation
    // would apply Windows lock and mode semantics to Linux-owned files.
    throw new Error('Skill management actions are not available on this host yet.')
  }
  if (!canMutateManagedSkills({ ...runtimeFacts, homeDir: context.homeDir })) {
    throw new Error(
      'Skill management actions require an official stable build or isolated dev roots.'
    )
  }
}

async function recoverSkillTransactionsForExplicitAction(
  context: { hostId: string; homeDir: string },
  store: Store,
  runtimeFacts: SkillHandlerRuntimeFacts
): Promise<void> {
  requireSkillMutation(context, runtimeFacts)
  const roots = buildSkillDiscoverySources({
    homeDir: context.homeDir,
    cwd: context.homeDir
  }).filter((root) => root.sourceKind === 'home')
  // Why: orphan recovery can write, so it runs only inside an explicit
  // foreground management action, never inventory or the App-mounted nudge.
  await Promise.all(
    roots.map((root) => sweepOrphanedSkillTransactions(root.path, store.getSkillManagementLedger()))
  )
}

function skillFailureCategory(error: unknown): string {
  if (error instanceof Error && /^skill-[a-z-]+$/.test(error.message)) {
    return error.message
  }
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return `filesystem-${error.code.toLowerCase()}`
  }
  return 'unknown-error'
}

export function registerSkillsHandlers(
  store: Store,
  runtimeFacts: SkillHandlerRuntimeFacts = productionSkillHandlerRuntimeFacts()
): void {
  ipcMain.handle(
    'skills:discover',
    async (_event, target?: SkillDiscoveryTarget): Promise<SkillDiscoveryResult> => {
      const runtimeTarget = getSkillDiscoveryRuntimeTarget(target)
      if (runtimeTarget.runtime === 'wsl') {
        if (process.platform !== 'win32') {
          throw new Error('WSL skill discovery is only available on Windows.')
        }
        const distro = runtimeTarget.wslDistro?.trim() || getDefaultWslDistro()
        if (!distro) {
          throw new Error('No WSL distribution is available for skill discovery.')
        }
        const homeDir = getWslHome(distro)
        if (!homeDir) {
          throw new Error(`Could not resolve the WSL home directory for ${distro}.`)
        }
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
      await recoverSkillTransactionsForExplicitAction(context, store, runtimeFacts)
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
      await recoverSkillTransactionsForExplicitAction(context, store, runtimeFacts)
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
      await recoverSkillTransactionsForExplicitAction(context, store, runtimeFacts)
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
      await recoverSkillTransactionsForExplicitAction(context, store, runtimeFacts)
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
