import { app } from 'electron'
import { tmpdir } from 'node:os'
import type { Store } from '../persistence'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { buildSkillDiscoverySources } from '../skills/skill-discovery-sources'
import { sweepOrphanedSkillTransactions } from '../skills/skill-orphan-transaction-sweep'
import { resolveDiagnosticBuildIdentity } from '../observability/diagnostic-upload-endpoint'
import {
  canMutateManagedSkills,
  type SkillMutationRuntimeFacts
} from '../skills/skill-mutation-authority'

export type SkillHandlerRuntimeFacts = Omit<SkillMutationRuntimeFacts, 'homeDir'>

export function productionSkillHandlerRuntimeFacts(): SkillHandlerRuntimeFacts {
  return {
    isPackaged: app.isPackaged,
    buildIdentity: resolveDiagnosticBuildIdentity(),
    userDataDir: app.getPath('userData'),
    isolatedDevHomeDir: process.env.ORCA_E2E_SKILL_HOME_DIR,
    isolatedDevUserDataDir: process.env.ORCA_E2E_USER_DATA_DIR,
    temporaryRoot: tmpdir()
  }
}

export function requireSkillMutation(
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

export async function recoverSkillTransactionsBeforeWrites(
  context: { hostId: string; homeDir: string },
  store: Store,
  runtimeFacts: SkillHandlerRuntimeFacts
): Promise<void> {
  requireSkillMutation(context, runtimeFacts)
  const roots = buildSkillDiscoverySources({
    homeDir: context.homeDir,
    cwd: context.homeDir
  }).filter((root) => root.sourceKind === 'home')
  // Why: orphan recovery can write, so it runs only inside a write-authorized
  // path — an explicit management action or an enabled auto-update batch with
  // pending work — never plain inventory or the App-mounted nudge.
  await Promise.all(
    roots.map((root) => sweepOrphanedSkillTransactions(root.path, store.getSkillManagementLedger()))
  )
}

export function skillFailureCategory(error: unknown): string {
  if (error instanceof Error && /^skill-[a-z-]+$/.test(error.message)) {
    return error.message
  }
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return `filesystem-${error.code.toLowerCase()}`
  }
  return 'unknown-error'
}
