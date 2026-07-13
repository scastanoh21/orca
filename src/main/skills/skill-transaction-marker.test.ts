import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkillReleasedSnapshot } from '../../shared/skill-management'
import {
  observeSkillPackage,
  persistedObservedFiles,
  skillPackageDigest
} from './skill-package-identity'
import {
  parseSkillTransactionMarker,
  type SkillTransactionMarker
} from './skill-transaction-marker'
import { skillInPlaceOperations } from './skill-transaction-publication-state'

const roots: string[] = []

async function snapshot(contents: string, revision: number): Promise<SkillReleasedSnapshot> {
  const root = await mkdtemp(join(tmpdir(), 'orca-marker-snapshot-'))
  roots.push(root)
  await writeFile(join(root, 'SKILL.md'), contents)
  await writeFile(join(root, 'asset.txt'), `${contents} asset`)
  const observed = await observeSkillPackage(root)
  return {
    releaseRevision: revision,
    packageDigest: observed.observedDigest,
    gitTreeSha: '',
    files: persistedObservedFiles(observed)
  }
}

async function fixture(): Promise<SkillTransactionMarker> {
  const root = await mkdtemp(join(tmpdir(), 'orca-marker-'))
  roots.push(root)
  const destinationPath = join(root, 'skills', 'orca-cli')
  await mkdir(destinationPath, { recursive: true })
  const priorSnapshot = await snapshot('old', 1)
  const currentSnapshot = await snapshot('new', 2)
  return {
    schemaVersion: 1,
    transactionId: 'transaction',
    createdAt: 1,
    destinationId: '000000000000000000000000',
    destinationPath,
    physicalIdentity: 'live-identity',
    hostId: 'local',
    skillName: 'orca-cli',
    phase: 'verified',
    stagePhysicalIdentity: 'stage-identity',
    backupPhysicalIdentity: 'backup-identity',
    stageBuild: {
      state: 'ready',
      physicalIdentity: 'stage-identity',
      operationIndex: currentSnapshot.files.length,
      pendingPath: null,
      activeFile: null
    },
    backupBuild: {
      state: 'ready',
      physicalIdentity: 'backup-identity',
      operationIndex: priorSnapshot.files.length,
      pendingPath: null,
      activeFile: null
    },
    publication: { kind: 'package-swap', step: 'complete' },
    priorSnapshot,
    currentSnapshot
  }
}

function parse(marker: unknown): SkillTransactionMarker | null {
  return parseSkillTransactionMarker(JSON.stringify(marker))
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('skill transaction marker semantics', () => {
  it('requires phase-valid package build evidence', async () => {
    const marker = await fixture()
    expect(parse({ ...marker, stageBuild: null })).toBeNull()
    expect(
      parse({
        ...marker,
        phase: 'staging',
        publication: null,
        stageBuild: { ...marker.stageBuild, state: 'creating' }
      })
    ).toBeNull()
    expect(
      parse({
        ...marker,
        phase: 'staging',
        publication: null,
        backupBuild: { ...marker.backupBuild, state: 'creating' },
        stageBuild: { ...marker.stageBuild, state: 'creating' }
      })
    ).toBeNull()
    expect(
      parse({
        ...marker,
        phase: 'staging',
        publication: null,
        stageBuild: {
          state: 'creating',
          physicalIdentity: marker.stagePhysicalIdentity,
          operationIndex: 0,
          pendingPath: null,
          activeFile: {
            path: marker.currentSnapshot.files[0]!.path,
            physicalIdentity: 'active',
            contentState: 'invalid'
          }
        },
        backupBuild: null,
        backupPhysicalIdentity: null
      })
    ).toBeNull()
  })

  it('accepts only terminal verified publication states', async () => {
    const marker = await fixture()
    expect(parse(marker)).not.toBeNull()
    expect(
      parse({ ...marker, publication: { kind: 'package-swap', step: 'moving-stage' } })
    ).toBeNull()
    const finalIndex = skillInPlaceOperations(marker.priorSnapshot, marker.currentSnapshot).length
    const inPlace = {
      kind: 'in-place',
      direction: 'forward',
      physicalIdentity: marker.physicalIdentity,
      temporary: null,
      operationIndex: finalIndex,
      operationState: 'ready'
    } as const
    expect(parse({ ...marker, publication: inPlace })).not.toBeNull()
    expect(
      parse({ ...marker, publication: { ...inPlace, operationIndex: finalIndex - 1 } })
    ).toBeNull()
    expect(parse({ ...marker, publication: { ...inPlace, direction: 'rollback' } })).toBeNull()
    expect(parse({ ...marker, publication: { ...inPlace, operationState: 'applying' } })).toBeNull()
  })

  it.each(['digest', 'order', 'duplicate', 'unsafe'])(
    'rejects a snapshot with corrupted %s semantics',
    async (corruption) => {
      const marker = await fixture()
      const files = marker.currentSnapshot.files.map((file) => ({ ...file }))
      if (corruption === 'order') {
        files.reverse()
      }
      if (corruption === 'duplicate') {
        files[1] = { ...files[0]! }
      }
      if (corruption === 'unsafe') {
        files[0] = { ...files[0]!, path: '../escape' }
      }
      const currentSnapshot = {
        ...marker.currentSnapshot,
        files,
        packageDigest: corruption === 'digest' ? '0'.repeat(64) : skillPackageDigest(files)
      }
      expect(parse({ ...marker, currentSnapshot })).toBeNull()
    }
  )

  it('rejects inconsistent revisions and malformed temp authority', async () => {
    const marker = await fixture()
    expect(
      parse({
        ...marker,
        currentSnapshot: {
          ...marker.currentSnapshot,
          releaseRevision: marker.priorSnapshot.releaseRevision
        }
      })
    ).toBeNull()
    const operation = skillInPlaceOperations(marker.priorSnapshot, marker.currentSnapshot)[0]!
    const expectedFile = marker.currentSnapshot.files.find((file) => file.path === operation.path)!
    const publication = {
      kind: 'in-place',
      direction: 'forward',
      physicalIdentity: marker.physicalIdentity,
      temporary: {
        path: 'asset.txt.orca-test.tmp',
        physicalIdentity: '',
        expectedFile,
        state: 'ready'
      },
      operationIndex: 0,
      operationState: 'applying'
    } as const
    expect(parse({ ...marker, phase: 'publishing', publication })).toBeNull()
    const validPublication = {
      ...publication,
      temporary: { ...publication.temporary, physicalIdentity: 'temp-identity' }
    }
    expect(parse({ ...marker, phase: 'publishing', publication: validPublication })).not.toBeNull()
    expect(
      parse({
        ...marker,
        phase: 'publishing',
        publication: {
          ...validPublication,
          temporary: { ...validPublication.temporary, state: 'unknown' }
        }
      })
    ).toBeNull()
    expect(
      parse({
        ...marker,
        phase: 'publishing',
        publication: {
          ...validPublication,
          temporary: { ...validPublication.temporary, path: 'other.orca-test.tmp' }
        }
      })
    ).toBeNull()
    expect(
      parse({
        ...marker,
        phase: 'publishing',
        publication: {
          ...validPublication,
          temporary: {
            ...validPublication.temporary,
            expectedFile: marker.priorSnapshot.files.find((file) => file.path === operation.path)!
          }
        }
      })
    ).toBeNull()
  })
})
