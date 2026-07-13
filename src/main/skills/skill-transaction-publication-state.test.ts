import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkillReleasedSnapshot } from '../../shared/skill-management'
import { observeSkillPackage, persistedObservedFiles } from './skill-package-identity'
import {
  matchesInPlacePublicationState,
  skillInPlaceOperations
} from './skill-transaction-publication-state'

const roots: string[] = []

async function packageRoot(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-publication-state-'))
  roots.push(root)
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(root, ...path.split('/'))
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, contents)
  }
  return root
}

async function snapshot(root: string, revision: number): Promise<SkillReleasedSnapshot> {
  const observed = await observeSkillPackage(root)
  return {
    releaseRevision: revision,
    packageDigest: observed.observedDigest,
    gitTreeSha: '',
    files: persistedObservedFiles(observed)
  }
}

async function fixture() {
  const priorRoot = await packageRoot({
    'SKILL.md': 'old entry',
    'asset-a.txt': 'old a',
    'obsolete-a.txt': 'old obsolete a',
    'obsolete-b.txt': 'old obsolete b'
  })
  const currentRoot = await packageRoot({
    'SKILL.md': 'new entry',
    'asset-a.txt': 'new a',
    'asset-b.txt': 'new b'
  })
  return {
    priorRoot,
    currentRoot,
    prior: await snapshot(priorRoot, 1),
    current: await snapshot(currentRoot, 2)
  }
}

async function stateRoot(currentRoot: string, completed: number): Promise<string> {
  const root = await packageRoot({
    'SKILL.md': 'old entry',
    'asset-a.txt': 'old a',
    'obsolete-a.txt': 'old obsolete a',
    'obsolete-b.txt': 'old obsolete b'
  })
  const operations = [
    ['publish', 'asset-a.txt'],
    ['publish', 'asset-b.txt'],
    ['publish', 'SKILL.md'],
    ['remove', 'obsolete-a.txt'],
    ['remove', 'obsolete-b.txt']
  ] as const
  for (const [kind, path] of operations.slice(0, completed)) {
    await (kind === 'remove'
      ? unlink(join(root, path))
      : writeFile(join(root, path), await readFile(join(currentRoot, path))))
  }
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('skill transaction publication state', () => {
  it('accepts every exact publication prefix in asset, semantic-commit, removal order', async () => {
    const { currentRoot, prior, current } = await fixture()
    expect(skillInPlaceOperations(prior, current)).toEqual([
      { kind: 'publish', path: 'asset-a.txt' },
      { kind: 'publish', path: 'asset-b.txt' },
      { kind: 'publish', path: 'SKILL.md' },
      { kind: 'remove', path: 'obsolete-a.txt' },
      { kind: 'remove', path: 'obsolete-b.txt' }
    ])
    for (let operationIndex = 0; operationIndex <= 5; operationIndex += 1) {
      const observed = await observeSkillPackage(await stateRoot(currentRoot, operationIndex))
      expect(
        matchesInPlacePublicationState({
          observed,
          prior,
          current,
          publication: {
            kind: 'in-place',
            direction: 'forward',
            physicalIdentity: 'test-identity',
            temporary: null,
            operationIndex,
            operationState: 'ready'
          },
          allowAppliedOperation: false
        })
      ).toBe(true)
    }
  })

  it.each([
    ['semantic commit before assets', { 'SKILL.md': 'new entry' }],
    ['later asset before earlier asset', { 'asset-b.txt': 'new b' }],
    ['obsolete removal before commit', { 'obsolete-a.txt': null }],
    ['unknown extra', { 'unknown.txt': 'unknown' }]
  ])('rejects impossible state: %s', async (_name, edits) => {
    const { priorRoot, prior, current } = await fixture()
    const root = await stateRoot(priorRoot, 0)
    for (const [path, contents] of Object.entries(edits)) {
      await (contents === null ? unlink(join(root, path)) : writeFile(join(root, path), contents))
    }
    expect(
      matchesInPlacePublicationState({
        observed: await observeSkillPackage(root),
        prior,
        current,
        publication: {
          kind: 'in-place',
          direction: 'forward',
          physicalIdentity: 'test-identity',
          temporary: null,
          operationIndex: 0,
          operationState: 'applying'
        },
        allowAppliedOperation: true
      })
    ).toBe(false)
  })

  it('rejects a mode-only same-content edit', async () => {
    if (process.platform === 'win32') {
      return
    }
    const { priorRoot, prior, current } = await fixture()
    const root = await stateRoot(priorRoot, 0)
    await chmod(join(root, 'asset-a.txt'), 0o755)
    expect(
      matchesInPlacePublicationState({
        observed: await observeSkillPackage(root),
        prior,
        current,
        publication: {
          kind: 'in-place',
          direction: 'forward',
          physicalIdentity: 'test-identity',
          temporary: null,
          operationIndex: 0,
          operationState: 'ready'
        },
        allowAppliedOperation: false
      })
    ).toBe(false)
  })

  it('rejects same-inode independent edits at every publication prefix', async () => {
    const { currentRoot, prior, current } = await fixture()
    for (let operationIndex = 0; operationIndex <= 5; operationIndex += 1) {
      const root = await stateRoot(currentRoot, operationIndex)
      await writeFile(join(root, 'SKILL.md'), `independent edit at ${operationIndex}`)
      expect(
        matchesInPlacePublicationState({
          observed: await observeSkillPackage(root),
          prior,
          current,
          publication: {
            kind: 'in-place',
            direction: 'forward',
            physicalIdentity: 'same-inode',
            temporary: null,
            operationIndex,
            operationState: 'ready'
          },
          allowAppliedOperation: false
        })
      ).toBe(false)
    }
  })

  it('rejects a binary byte mismatch outside both exact snapshots', async () => {
    const priorRoot = await packageRoot({
      'SKILL.md': 'old entry',
      'payload.bin': Buffer.from([0, 1])
    })
    const currentRoot = await packageRoot({
      'SKILL.md': 'new entry',
      'payload.bin': Buffer.from([0, 2])
    })
    const observedRoot = await packageRoot({
      'SKILL.md': 'old entry',
      'payload.bin': Buffer.from([0, 3])
    })
    expect(
      matchesInPlacePublicationState({
        observed: await observeSkillPackage(observedRoot),
        prior: await snapshot(priorRoot, 1),
        current: await snapshot(currentRoot, 2),
        publication: {
          kind: 'in-place',
          direction: 'forward',
          physicalIdentity: 'same-inode',
          temporary: null,
          operationIndex: 0,
          operationState: 'applying'
        },
        allowAppliedOperation: true
      })
    ).toBe(false)
  })
})
