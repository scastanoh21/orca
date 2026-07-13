import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { PersistedState } from '../shared/types'

const nonEmptyString = z.string().min(1)
const timestamp = z.number().finite().nonnegative()
const terminalTeardownIntentSnapshotSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    pendingLocalPtyShutdowns: z.array(
      z
        .object({
          ptyId: nonEmptyString,
          expectedPaneKey: nonEmptyString.optional(),
          expectedTabId: nonEmptyString.optional(),
          requestedAt: timestamp
        })
        .strict()
    ),
    pendingRuntimeTerminalCloses: z.array(
      z
        .object({
          environmentId: nonEmptyString,
          handle: nonEmptyString,
          runtimeId: nonEmptyString.optional(),
          requestedAt: timestamp
        })
        .strict()
    ),
    pendingSshPtyShutdowns: z.array(
      z
        .object({
          targetId: nonEmptyString,
          ptyId: nonEmptyString,
          relayInstanceId: nonEmptyString.optional(),
          shutdownRequestedAt: timestamp
        })
        .strict()
    )
  })
  .strict()

type TerminalTeardownIntentSnapshot = z.infer<typeof terminalTeardownIntentSnapshotSchema>

function getSnapshotFile(dataFile: string): string {
  return join(dirname(dataFile), 'orca-terminal-teardown-intents.json')
}

function readSnapshot(dataFile: string): TerminalTeardownIntentSnapshot | null {
  const snapshotFile = getSnapshotFile(dataFile)
  if (!existsSync(snapshotFile)) {
    return null
  }
  try {
    return terminalTeardownIntentSnapshotSchema.parse(
      JSON.parse(readFileSync(snapshotFile, 'utf-8'))
    )
  } catch (error) {
    console.warn('[persistence] Ignoring invalid terminal teardown intent snapshot:', error)
    return null
  }
}

export function applyTerminalTeardownIntentSnapshot(state: PersistedState, dataFile: string): void {
  const snapshot = readSnapshot(dataFile)
  if (!snapshot) {
    return
  }
  // Why: a failed sidecar replacement falls back to a synchronous full-store
  // write. An older valid sidecar must not override that newer durable state.
  if (snapshot.revision < (state.terminalTeardownIntentRevision ?? 0)) {
    return
  }
  state.terminalTeardownIntentRevision = snapshot.revision
  state.pendingLocalPtyShutdowns = snapshot.pendingLocalPtyShutdowns
  state.pendingRuntimeTerminalCloses = snapshot.pendingRuntimeTerminalCloses
  for (const lease of state.sshRemotePtyLeases ?? []) {
    delete lease.shutdownRequestedAt
  }
  for (const pending of snapshot.pendingSshPtyShutdowns) {
    const lease = state.sshRemotePtyLeases?.find(
      (candidate) =>
        candidate.targetId === pending.targetId &&
        candidate.ptyId === pending.ptyId &&
        candidate.relayInstanceId === pending.relayInstanceId
    )
    if (lease) {
      lease.shutdownRequestedAt = pending.shutdownRequestedAt
      lease.updatedAt = Math.max(lease.updatedAt, pending.shutdownRequestedAt)
    }
  }
}

export function writeTerminalTeardownIntentSnapshot(state: PersistedState, dataFile: string): void {
  const snapshot: TerminalTeardownIntentSnapshot = {
    version: 1,
    revision: state.terminalTeardownIntentRevision ?? 0,
    pendingLocalPtyShutdowns: state.pendingLocalPtyShutdowns ?? [],
    pendingRuntimeTerminalCloses: state.pendingRuntimeTerminalCloses ?? [],
    pendingSshPtyShutdowns: (state.sshRemotePtyLeases ?? []).flatMap((lease) =>
      lease.shutdownRequestedAt === undefined
        ? []
        : [
            {
              targetId: lease.targetId,
              ptyId: lease.ptyId,
              ...(lease.relayInstanceId ? { relayInstanceId: lease.relayInstanceId } : {}),
              shutdownRequestedAt: lease.shutdownRequestedAt
            }
          ]
    )
  }
  const snapshotFile = getSnapshotFile(dataFile)
  const tmpFile = `${snapshotFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  mkdirSync(dirname(snapshotFile), { recursive: true })
  let renamed = false
  try {
    writeFileSync(tmpFile, JSON.stringify(snapshot), 'utf-8')
    renameSync(tmpFile, snapshotFile)
    renamed = true
  } finally {
    if (!renamed) {
      try {
        unlinkSync(tmpFile)
      } catch {
        // The primary write error is more useful than best-effort tmp cleanup.
      }
    }
  }
}
