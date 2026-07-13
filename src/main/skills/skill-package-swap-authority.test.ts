import { cp, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ManagedSkillDestination, SkillReleasedSnapshot } from '../../shared/skill-management'
import { observeSkillPackage, persistedObservedFiles } from './skill-package-identity'
import { replaceSkillPackage, rollbackSkillPackageSwap } from './skill-package-publication'
import { skillPhysicalIdentity } from './skill-installation-topology'
import type { SkillTransactionMarker } from './skill-transaction-marker'
import { assertTransactionOwnedState } from './skill-transaction-owned-state'
import type { SkillPublicationState } from './skill-transaction-publication-state'

const roots: string[] = []

async function createPackage(root: string, values: Record<string, string>): Promise<void> {
  await mkdir(root, { recursive: true })
  for (const [path, contents] of Object.entries(values)) {
    await writeFile(join(root, path), contents)
  }
}

async function snapshot(root: string, releaseRevision: number): Promise<SkillReleasedSnapshot> {
  const observed = await observeSkillPackage(root)
  return {
    releaseRevision,
    packageDigest: observed.observedDigest,
    gitTreeSha: '',
    files: persistedObservedFiles(observed)
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-swap-authority-'))
  roots.push(root)
  const live = join(root, 'skills', 'orca-cli')
  const transactionRoot = join(root, 'transaction')
  const stageRoot = join(transactionRoot, 'stage')
  const backupRoot = join(transactionRoot, 'backup')
  await createPackage(live, { 'SKILL.md': 'old entry', 'asset.txt': 'old asset' })
  await createPackage(stageRoot, { 'SKILL.md': 'new entry', 'asset.txt': 'new asset' })
  await cp(live, backupRoot, { recursive: true })
  const prior = await snapshot(live, 1)
  const current = await snapshot(stageRoot, 2)
  const record = {
    resolvedPath: live,
    physicalIdentity: skillPhysicalIdentity(live, await stat(live))
  } as ManagedSkillDestination
  let marker: SkillTransactionMarker = {
    schemaVersion: 1,
    transactionId: 'test',
    createdAt: 1,
    destinationId: '000000000000000000000000',
    destinationPath: live,
    physicalIdentity: record.physicalIdentity,
    hostId: 'local',
    skillName: 'orca-cli',
    phase: 'publishing',
    stagePhysicalIdentity: skillPhysicalIdentity(stageRoot, await stat(stageRoot)),
    backupPhysicalIdentity: skillPhysicalIdentity(backupRoot, await stat(backupRoot)),
    stageBuild: {
      state: 'ready',
      physicalIdentity: skillPhysicalIdentity(stageRoot, await stat(stageRoot)),
      operationIndex: current.files.length,
      pendingPath: null,
      activeFile: null
    },
    backupBuild: {
      state: 'ready',
      physicalIdentity: skillPhysicalIdentity(backupRoot, await stat(backupRoot)),
      operationIndex: prior.files.length,
      pendingPath: null,
      activeFile: null
    },
    publication: null,
    priorSnapshot: prior,
    currentSnapshot: current
  }
  const history: SkillPublicationState[] = []
  const journal = async (publication: SkillPublicationState): Promise<void> => {
    marker = { ...marker, publication }
    history.push(publication)
  }
  const assertBoundary = async (
    publication: SkillPublicationState,
    expectedLiveState?: Awaited<ReturnType<typeof assertTransactionOwnedState>>
  ): Promise<void> => {
    const liveState = await assertTransactionOwnedState({
      transactionRoot,
      marker: { ...marker, publication },
      assertParent: async () => undefined,
      allowAppliedOperation: false
    })
    if (expectedLiveState && liveState !== expectedLiveState) {
      throw new Error('skill-transaction-recovery-required')
    }
  }
  return {
    live,
    transactionRoot,
    stageRoot,
    oldLiveRoot: join(transactionRoot, 'old-live'),
    record,
    prior,
    current: { ...current, name: 'orca-cli', sourcePath: '', appVersion: '1.0.0' },
    callbacks: { journal, assertBoundary },
    history,
    marker: () => marker
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('skill package swap authority', () => {
  it('falls back in place only when the first live rename never mutated', async () => {
    const value = await fixture()
    await replaceSkillPackage({
      ...value,
      callbacks: value.callbacks,
      renameRuntime: {
        windowsFallback: true,
        renameEntry: async () => {
          throw Object.assign(new Error('busy'), { code: 'EPERM' })
        },
        wait: async () => undefined
      }
    })
    expect((await observeSkillPackage(value.live)).observedDigest).toBe(value.current.packageDigest)
    expect(value.history.some((state) => state.kind === 'in-place')).toBe(true)
  })

  it('never falls back after live moved and the stage rename exhausted retries', async () => {
    const value = await fixture()
    const renameEntry: typeof rename = async (source, destination) => {
      if (source.toString() === value.stageRoot) {
        throw Object.assign(new Error('busy'), { code: 'EPERM' })
      }
      await rename(source, destination)
    }
    await expect(
      replaceSkillPackage({
        ...value,
        callbacks: value.callbacks,
        renameRuntime: { windowsFallback: true, renameEntry, wait: async () => undefined }
      })
    ).rejects.toMatchObject({ code: 'EPERM' })
    expect(value.marker().publication).toEqual({ kind: 'package-swap', step: 'moving-live' })
    expect(value.history.some((state) => state.kind === 'in-place')).toBe(false)
  })

  it('rejects fallback when a failing first rename nevertheless moved live', async () => {
    const value = await fixture()
    let firstAttempt = true
    const renameEntry: typeof rename = async (source, destination) => {
      if (firstAttempt) {
        firstAttempt = false
        await rename(source, destination)
        throw Object.assign(new Error('ambiguous busy result'), { code: 'EPERM' })
      }
      await rename(source, destination)
    }
    await expect(
      replaceSkillPackage({
        ...value,
        callbacks: value.callbacks,
        renameRuntime: { windowsFallback: true, renameEntry, wait: async () => undefined }
      })
    ).rejects.toThrow('skill-transaction-recovery-required')
    expect(value.history.some((state) => state.kind === 'in-place')).toBe(false)
    expect(await stat(value.oldLiveRoot)).toBeTruthy()
    await expect(stat(value.live)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains swap authority when stage publication and old-live restore are busy', async () => {
    const value = await fixture()
    let firstRename = true
    const renameEntry: typeof rename = async (source, destination) => {
      if (firstRename) {
        firstRename = false
        await rename(source, destination)
        return
      }
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    }
    await expect(
      replaceSkillPackage({
        ...value,
        callbacks: value.callbacks,
        renameRuntime: { windowsFallback: true, renameEntry, wait: async () => undefined }
      })
    ).rejects.toMatchObject({ code: 'EBUSY' })
    expect(value.marker().publication).toEqual({ kind: 'package-swap', step: 'moving-stage' })
    expect(value.history.some((state) => state.kind === 'in-place')).toBe(false)
    expect(await stat(value.oldLiveRoot)).toBeTruthy()
    await expect(stat(value.live)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['current', 'old-live'] as const)(
    'retains the package-swap rollback journal when %s rename stays busy',
    async (failure) => {
      const value = await fixture()
      await rename(value.live, value.oldLiveRoot)
      await rename(value.stageRoot, value.live)
      await value.callbacks.journal({ kind: 'package-swap', step: 'complete' })
      const renameEntry: typeof rename = async (source, destination) => {
        const shouldFail =
          (failure === 'current' && source.toString() === value.live) ||
          (failure === 'old-live' && source.toString() === value.oldLiveRoot)
        if (shouldFail) {
          throw Object.assign(new Error('busy'), { code: 'EPERM' })
        }
        await rename(source, destination)
      }
      await expect(
        rollbackSkillPackageSwap({
          record: value.record,
          transactionRoot: value.transactionRoot,
          callbacks: value.callbacks,
          renameRuntime: { windowsFallback: true, renameEntry, wait: async () => undefined }
        })
      ).rejects.toMatchObject({ code: 'EPERM' })
      expect(value.marker().publication).toEqual({
        kind: 'package-swap',
        step: failure === 'current' ? 'rollback-moving-current' : 'rollback-moving-old-live'
      })
    }
  )
})
