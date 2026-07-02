import type { Store } from '../persistence'
import type {
  ManagedAgentSkillContext,
  ManagedAgentSkillEnsureRequest,
  ManagedAgentSkillEnsureResult,
  SkillDiscoveryTarget
} from '../../shared/skills'
import { shouldEmitManagedAgentSkillFallback } from '../../shared/skills'
import { getManagedSkillUpdateCoordinator } from './managed-skill-update-coordinator-registry'
import { isManagedAgentSkillName } from './managed-skill-update-contract'

const MAX_RESTART_PROMPT_REQUESTS = 20
const MANAGED_SKILL_CONTEXTS = new Set<string>([
  'linear-worktree',
  'agent-orchestration',
  'agent-computer-use',
  'agent-orca-cli'
])

export function recordManagedSkillRestartPromptRequest(
  store: Store,
  request: ManagedAgentSkillEnsureRequest
): void {
  const normalizedRequest = normalizeManagedSkillRestartPromptRequest(request)
  if (!normalizedRequest) {
    return
  }
  const current = normalizeManagedSkillRestartPromptRequests(
    store.getSettings().managedAgentSkillRestartPromptRequests
  )
  const byKey = new Map(
    current.map((entry) => [makeManagedSkillRestartPromptRequestKey(entry), entry])
  )
  byKey.set(makeManagedSkillRestartPromptRequestKey(normalizedRequest), normalizedRequest)
  const next = Array.from(byKey.values()).slice(-MAX_RESTART_PROMPT_REQUESTS)
  if (JSON.stringify(next) === JSON.stringify(current)) {
    return
  }
  store.updateSettings({ managedAgentSkillRestartPromptRequests: next })
}

export async function flushManagedSkillRestartPromptRequests(
  store: Store
): Promise<ManagedAgentSkillEnsureResult[]> {
  const current = normalizeManagedSkillRestartPromptRequests(
    store.getSettings().managedAgentSkillRestartPromptRequests
  )
  const results: ManagedAgentSkillEnsureResult[] = []
  const retained: ManagedAgentSkillEnsureRequest[] = []
  const coordinator = getManagedSkillUpdateCoordinator(store)

  for (const request of current) {
    const result = await coordinator.ensureManagedReady({ ...request, force: true })
    results.push(result)
    if (shouldEmitManagedAgentSkillFallback(result)) {
      retained.push(request)
    }
  }

  if (JSON.stringify(retained) !== JSON.stringify(current)) {
    store.updateSettings({ managedAgentSkillRestartPromptRequests: retained })
  }
  return results
}

export function normalizeManagedSkillRestartPromptRequests(
  value: unknown
): ManagedAgentSkillEnsureRequest[] {
  if (!Array.isArray(value)) {
    return []
  }
  const byKey = new Map<string, ManagedAgentSkillEnsureRequest>()
  for (const entry of value) {
    const request = normalizeManagedSkillRestartPromptRequest(entry)
    if (!request) {
      continue
    }
    byKey.set(makeManagedSkillRestartPromptRequestKey(request), request)
  }
  return Array.from(byKey.values()).slice(-MAX_RESTART_PROMPT_REQUESTS)
}

function normalizeManagedSkillRestartPromptRequest(
  value: unknown
): ManagedAgentSkillEnsureRequest | null {
  if (
    !isRecord(value) ||
    typeof value.skillName !== 'string' ||
    !isManagedAgentSkillName(value.skillName)
  ) {
    return null
  }
  if (typeof value.context !== 'string' || !MANAGED_SKILL_CONTEXTS.has(value.context)) {
    return null
  }
  const request: ManagedAgentSkillEnsureRequest = {
    skillName: value.skillName,
    context: value.context as ManagedAgentSkillContext
  }
  if (value.remoteRuntime === true) {
    request.remoteRuntime = true
  }
  if (isRecord(value.discoveryTarget)) {
    request.discoveryTarget = value.discoveryTarget as SkillDiscoveryTarget
  }
  return request
}

function makeManagedSkillRestartPromptRequestKey(
  request: ManagedAgentSkillEnsureRequest
): string {
  return JSON.stringify({
    skillName: request.skillName,
    context: request.context,
    remoteRuntime: request.remoteRuntime === true,
    discoveryTarget: request.discoveryTarget ?? null
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
