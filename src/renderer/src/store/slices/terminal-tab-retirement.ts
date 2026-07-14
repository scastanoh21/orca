import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { AppState } from '../types'
import {
  getRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'

export type TerminalTabCloseReason = 'user' | 'cleanup' | 'pty-exit'

type TerminalTabRetirementState = WorktreeRuntimeOwnerState &
  Pick<
    AppState,
    | 'tabsByWorktree'
    | 'unifiedTabsByWorktree'
    | 'ptyIdsByTabId'
    | 'terminalLayoutsByTabId'
    | 'lastKnownRelayPtyIdByTabId'
    | 'deferredSshSessionIdsByTabId'
    | 'pendingReconnectPtyIdByTabId'
  >

export type TerminalTabRetirementPlan = {
  tabId: string
  worktreeId: string | null
  ptyIds: string[]
  localOrSshPtyIds: string[]
  runtimeTerminals: {
    ptyId: string
    environmentId: string | null
    handle: string
  }[]
  sharedPtyIds: string[]
  unroutablePtyIds: string[]
}

function appendPtyId(ids: Set<string>, ptyId: string | null | undefined): void {
  if (ptyId) {
    ids.add(ptyId)
  }
}

function collectTerminalTabPtyIds(state: TerminalTabRetirementState, tabId: string): string[] {
  const ids = new Set<string>()
  for (const ptyId of state.ptyIdsByTabId[tabId] ?? []) {
    appendPtyId(ids, ptyId)
  }
  for (const tabs of Object.values(state.tabsByWorktree)) {
    appendPtyId(ids, tabs.find((tab) => tab.id === tabId)?.ptyId)
  }

  for (const ptyId of Object.values(state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {})) {
    appendPtyId(ids, ptyId)
  }
  appendPtyId(ids, state.lastKnownRelayPtyIdByTabId[tabId])
  appendPtyId(ids, state.deferredSshSessionIdsByTabId[tabId])
  appendPtyId(ids, state.pendingReconnectPtyIdByTabId[tabId])
  return [...ids]
}

function getPtyOwnershipIdentity(
  state: TerminalTabRetirementState,
  ptyId: string,
  worktreeId: string | null
): string {
  const remote = parseRemoteRuntimePtyId(ptyId)
  if (!remote?.handle) {
    return `pty:${ptyId}`
  }
  // Why: hydrated legacy runtime IDs omit their owner, but still refer to the
  // same provider terminal as a scoped ID in the owning worktree.
  const environmentId =
    remote.environmentId?.trim() || getRuntimeEnvironmentIdForWorktree(state, worktreeId) || ''
  return JSON.stringify(['runtime', environmentId, remote.handle])
}

function collectPtyIdsForTab(
  state: TerminalTabRetirementState,
  tabId: string,
  rowPtyId: string | null | undefined
): string[] {
  const ids = new Set<string>()
  appendPtyId(ids, rowPtyId)
  for (const ptyId of state.ptyIdsByTabId[tabId] ?? []) {
    appendPtyId(ids, ptyId)
  }
  for (const ptyId of Object.values(state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {})) {
    appendPtyId(ids, ptyId)
  }
  appendPtyId(ids, state.lastKnownRelayPtyIdByTabId[tabId])
  appendPtyId(ids, state.deferredSshSessionIdsByTabId[tabId])
  appendPtyId(ids, state.pendingReconnectPtyIdByTabId[tabId])
  return [...ids]
}

function collectOtherLivePtyOwnershipIdentities(
  state: TerminalTabRetirementState,
  closingTabId: string
): Set<string> {
  const liveTabs = new Map<string, { worktreeId: string; rowPtyId: string | null }>()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      liveTabs.set(tab.id, { worktreeId, rowPtyId: tab.ptyId })
    }
  }
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    for (const tab of tabs) {
      if (tab.contentType === 'terminal' && !liveTabs.has(tab.entityId)) {
        liveTabs.set(tab.entityId, { worktreeId, rowPtyId: null })
      }
    }
  }

  const identities = new Set<string>()
  for (const [tabId, owner] of liveTabs) {
    if (tabId === closingTabId) {
      continue
    }
    for (const ptyId of collectPtyIdsForTab(state, tabId, owner.rowPtyId)) {
      identities.add(getPtyOwnershipIdentity(state, ptyId, owner.worktreeId))
    }
  }
  return identities
}

export function isTerminalTabPresent(
  state: Pick<AppState, 'tabsByWorktree'>,
  tabId: string
): boolean {
  return Object.values(state.tabsByWorktree).some((tabs) => tabs.some((tab) => tab.id === tabId))
}

export function buildTerminalTabRetirementPlan(
  state: TerminalTabRetirementState,
  tabId: string
): TerminalTabRetirementPlan {
  const worktreeId =
    Object.entries(state.tabsByWorktree).find(([, tabs]) =>
      tabs.some((tab) => tab.id === tabId)
    )?.[0] ??
    Object.entries(state.unifiedTabsByWorktree).find(([, tabs]) =>
      tabs.some((tab) => tab.contentType === 'terminal' && tab.entityId === tabId)
    )?.[0] ??
    null
  const ptyIds = collectTerminalTabPtyIds(state, tabId)
  const sharedPtyIds: string[] = []
  const localOrSshPtyIds: string[] = []
  const runtimeTerminals: TerminalTabRetirementPlan['runtimeTerminals'] = []
  const unroutablePtyIds: string[] = []
  const scheduledPtyOwners = new Set<string>()
  const otherLivePtyOwners = collectOtherLivePtyOwnershipIdentities(state, tabId)

  for (const ptyId of ptyIds) {
    const ownerIdentity = getPtyOwnershipIdentity(state, ptyId, worktreeId)
    if (otherLivePtyOwners.has(ownerIdentity)) {
      sharedPtyIds.push(ptyId)
      continue
    }
    const remote = parseRemoteRuntimePtyId(ptyId)
    if (remote) {
      if (!remote.handle) {
        unroutablePtyIds.push(ptyId)
        continue
      }
      if (scheduledPtyOwners.has(ownerIdentity)) {
        continue
      }
      scheduledPtyOwners.add(ownerIdentity)
      runtimeTerminals.push({
        ptyId,
        environmentId: remote.environmentId?.trim() || null,
        handle: remote.handle
      })
    } else if (ptyId.startsWith('remote:')) {
      unroutablePtyIds.push(ptyId)
    } else {
      localOrSshPtyIds.push(ptyId)
    }
  }

  return {
    tabId,
    worktreeId,
    ptyIds,
    localOrSshPtyIds,
    runtimeTerminals,
    sharedPtyIds,
    unroutablePtyIds
  }
}

export function removeSleepingAgentSessionsForTab(
  records: Record<string, SleepingAgentSessionRecord>,
  tabId: string
): Record<string, SleepingAgentSessionRecord> {
  let next = records
  for (const [paneKey, record] of Object.entries(records)) {
    if (!paneKey.startsWith(`${tabId}:`) && record.tabId !== tabId) {
      continue
    }
    if (next === records) {
      next = { ...records }
    }
    delete next[paneKey]
  }
  return next
}
