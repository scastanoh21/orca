import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkillReleasedSnapshot } from '../../shared/skill-management'
import { observeSkillPackage, persistedObservedFiles } from './skill-package-identity'
import {
  assertSkillTransactionPackageBuild,
  buildSkillTransactionPackage,
  type SkillTransactionPackageBuildEvidence,
  type SkillTransactionPackageBuildRuntime
} from './skill-transaction-package-build'

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-package-build-'))
  roots.push(root)
  const sourceRoot = join(root, 'source')
  const packageRoot = join(root, 'stage')
  await mkdir(join(sourceRoot, 'assets'), { recursive: true })
  await writeFile(join(sourceRoot, 'SKILL.md'), '# Test\n')
  await writeFile(join(sourceRoot, 'assets', 'run.bin'), Buffer.from([0, 1, 2, 3]))
  await chmod(join(sourceRoot, 'assets', 'run.bin'), 0o755)
  const observed = await observeSkillPackage(sourceRoot)
  const snapshot: SkillReleasedSnapshot = {
    releaseRevision: 2,
    packageDigest: observed.observedDigest,
    gitTreeSha: '',
    files: persistedObservedFiles(observed)
  }
  let lastEvidence: SkillTransactionPackageBuildEvidence | null = null
  const build = (runtime?: SkillTransactionPackageBuildRuntime) =>
    buildSkillTransactionPackage({
      root: packageRoot,
      sourceRoot,
      snapshot,
      crlf: false,
      assertSourceAuthority: async () => undefined,
      journal: async (evidence) => {
        lastEvidence = structuredClone(evidence)
      },
      assertBoundary: async (evidence) =>
        assertSkillTransactionPackageBuild({ root: packageRoot, evidence, snapshot }),
      runtime
    })
  return { root, sourceRoot, packageRoot, snapshot, build, lastEvidence: () => lastEvidence }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('skill transaction package build authority', () => {
  it('journals deterministic prefixes and a ready exact package', async () => {
    const value = await fixture()
    const ready = await value.build()
    expect(ready).toEqual({
      state: 'ready',
      physicalIdentity: expect.any(String),
      operationIndex: value.snapshot.files.length,
      pendingPath: null,
      activeFile: null
    })
    await expect(
      assertSkillTransactionPackageBuild({
        root: value.packageRoot,
        evidence: ready,
        snapshot: value.snapshot
      })
    ).resolves.toBeUndefined()
  })

  it('does not fill a replacement root introduced while the root journal is awaited', async () => {
    const value = await fixture()
    const ownedRoot = `${value.packageRoot}-owned`
    let replaced = false
    await expect(
      buildSkillTransactionPackage({
        root: value.packageRoot,
        sourceRoot: value.sourceRoot,
        snapshot: value.snapshot,
        crlf: false,
        assertSourceAuthority: async () => undefined,
        journal: async () => {
          if (!replaced) {
            replaced = true
            await rename(value.packageRoot, ownedRoot)
            await mkdir(value.packageRoot)
          }
        },
        assertBoundary: async (evidence) =>
          assertSkillTransactionPackageBuild({
            root: value.packageRoot,
            evidence,
            snapshot: value.snapshot
          })
      })
    ).rejects.toThrow('skill-transaction-package-build-changed')
    expect(await observeSkillPackage(value.packageRoot)).toMatchObject({ files: [] })
    expect(await observeSkillPackage(ownedRoot)).toMatchObject({ files: [] })
  })

  it.each(['write', 'chmod', 'sync'] as const)(
    'retains phase-valid evidence when %s mutates and throws',
    async (boundary) => {
      const value = await fixture()
      const runtime: SkillTransactionPackageBuildRuntime = {}
      if (boundary === 'write') {
        runtime.writeBytes = async (handle, bytes) => {
          await handle.writeFile(bytes.subarray(0, 1))
          throw new Error('injected-write-failure')
        }
      } else if (boundary === 'chmod') {
        runtime.chmodFile = async (handle, mode) => {
          await handle.chmod(mode)
          throw new Error('injected-chmod-failure')
        }
      } else {
        runtime.syncFile = async (handle) => {
          await handle.sync()
          throw new Error('injected-sync-failure')
        }
      }
      await expect(value.build(runtime)).rejects.toThrow(`injected-${boundary}-failure`)
      const evidence = value.lastEvidence()
      expect(evidence?.state).toBe('creating')
      await expect(
        assertSkillTransactionPackageBuild({
          root: value.packageRoot,
          evidence: evidence!,
          snapshot: value.snapshot
        })
      ).resolves.toBeUndefined()
    }
  )

  it.each(['parent', 'file'] as const)(
    'classifies a mutate-and-throw %s boundary exactly',
    async (boundary) => {
      const value = await fixture()
      const runtime: SkillTransactionPackageBuildRuntime =
        boundary === 'parent'
          ? {
              createParent: async (path) => {
                await mkdir(path, { recursive: true })
                throw new Error('injected-parent-failure')
              }
            }
          : {
              openFile: async (path, mode) => {
                const handle = await open(path, 'wx', mode)
                await handle.close()
                throw new Error('injected-file-failure')
              }
            }
      await expect(value.build(runtime)).rejects.toThrow(`injected-${boundary}-failure`)
      const evidence = value.lastEvidence()
      expect(evidence?.activeFile).toBeNull()
      const assertion = assertSkillTransactionPackageBuild({
        root: value.packageRoot,
        evidence: evidence!,
        snapshot: value.snapshot
      })
      if (boundary === 'parent') {
        expect(evidence?.pendingPath).toBe(value.snapshot.files[0]!.path)
        await expect(assertion).resolves.toBeUndefined()
      } else {
        await expect(assertion).rejects.toThrow('skill-transaction-package-build-changed')
      }
    }
  )

  it('rejects unknown directory extras even when file content is exact', async () => {
    const value = await fixture()
    const ready = await value.build()
    await mkdir(join(value.packageRoot, 'unknown'))
    await expect(
      assertSkillTransactionPackageBuild({
        root: value.packageRoot,
        evidence: ready,
        snapshot: value.snapshot
      })
    ).rejects.toThrow('skill-transaction-package-build-changed')
    expect(await readFile(join(value.packageRoot, 'SKILL.md'), 'utf8')).toBe('# Test\n')
  })
})
