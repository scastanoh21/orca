import type { PtyDataMeta } from './pty-dispatcher'

type PtyPrimaryHandlerAdmissionRegistry = {
  dataHandlers: Map<string, (data: string, meta?: PtyDataMeta) => void>
  replayHandlers: Map<string, (data: string) => void>
  exitHandlers: Map<string, (code: number) => void>
  teardownHandlers: Map<string, () => void>
  drainData: (ptyId: string, handler: (data: string, meta?: PtyDataMeta) => void) => void
  drainExit: (ptyId: string, handler: (code: number) => void) => boolean
}

export type PtyPrimaryHandlerAdmissionSnapshot = {
  ptyId: string
  owner?: PtyPrimaryHandlerOwner
  dataHandler?: (data: string, meta?: PtyDataMeta) => void
  replayHandler?: (data: string) => void
  exitHandler?: (code: number) => void
  teardownHandler?: () => void
}

export type PtyPrimaryHandlerOwner = {
  active: boolean
}

const primaryHandlerOwners = new Map<string, PtyPrimaryHandlerOwner>()

export function createPtyPrimaryHandlerOwner(): PtyPrimaryHandlerOwner {
  return { active: true }
}

export function publishPtyPrimaryHandlerOwner(ptyId: string, owner: PtyPrimaryHandlerOwner): void {
  const previousOwner = primaryHandlerOwners.get(ptyId)
  if (previousOwner && previousOwner !== owner) {
    previousOwner.active = false
  }
  owner.active = true
  primaryHandlerOwners.set(ptyId, owner)
}

export function revokePtyPrimaryHandlerOwner(ptyId: string, owner: PtyPrimaryHandlerOwner): void {
  owner.active = false
  if (primaryHandlerOwners.get(ptyId) === owner) {
    primaryHandlerOwners.delete(ptyId)
  }
}

export function suspendPtyPrimaryHandlersForAdmission(
  registry: PtyPrimaryHandlerAdmissionRegistry,
  ptyId: string
): PtyPrimaryHandlerAdmissionSnapshot {
  const snapshot: PtyPrimaryHandlerAdmissionSnapshot = {
    ptyId,
    owner: primaryHandlerOwners.get(ptyId),
    dataHandler: registry.dataHandlers.get(ptyId),
    replayHandler: registry.replayHandlers.get(ptyId),
    exitHandler: registry.exitHandlers.get(ptyId),
    teardownHandler: registry.teardownHandlers.get(ptyId)
  }
  registry.dataHandlers.delete(ptyId)
  registry.replayHandlers.delete(ptyId)
  registry.exitHandlers.delete(ptyId)
  registry.teardownHandlers.delete(ptyId)
  primaryHandlerOwners.delete(ptyId)
  return snapshot
}

export function restorePtyPrimaryHandlersAfterFailedAdmission(
  registry: PtyPrimaryHandlerAdmissionRegistry,
  snapshot: PtyPrimaryHandlerAdmissionSnapshot
): void {
  const currentOwner = primaryHandlerOwners.get(snapshot.ptyId)
  if (!snapshot.owner?.active || (currentOwner && currentOwner !== snapshot.owner)) {
    return
  }
  let restoredDataHandler: PtyPrimaryHandlerAdmissionSnapshot['dataHandler']
  let restoredExitHandler: PtyPrimaryHandlerAdmissionSnapshot['exitHandler']
  if (snapshot.dataHandler && !registry.dataHandlers.has(snapshot.ptyId)) {
    registry.dataHandlers.set(snapshot.ptyId, snapshot.dataHandler)
    restoredDataHandler = snapshot.dataHandler
  }
  if (snapshot.replayHandler && !registry.replayHandlers.has(snapshot.ptyId)) {
    registry.replayHandlers.set(snapshot.ptyId, snapshot.replayHandler)
  }
  if (snapshot.exitHandler && !registry.exitHandlers.has(snapshot.ptyId)) {
    registry.exitHandlers.set(snapshot.ptyId, snapshot.exitHandler)
    restoredExitHandler = snapshot.exitHandler
  }
  if (snapshot.teardownHandler && !registry.teardownHandlers.has(snapshot.ptyId)) {
    registry.teardownHandlers.set(snapshot.ptyId, snapshot.teardownHandler)
  }
  primaryHandlerOwners.set(snapshot.ptyId, snapshot.owner)
  // Why: events emitted while admission owned no primary handler still belong
  // to the restored generation when the replacement request itself failed.
  if (restoredDataHandler) {
    registry.drainData(snapshot.ptyId, restoredDataHandler)
  }
  if (restoredExitHandler) {
    registry.drainExit(snapshot.ptyId, restoredExitHandler)
  }
}
