import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ManagedSkillDestination,
  SkillCurrentBundleEntry,
  SkillReleasedSnapshot
} from '../../shared/skill-management'
import { observeSkillPackage, persistedObservedFiles } from './skill-package-identity'
import { publishBundledSkill } from './skill-package-publish'
import { skillPhysicalIdentity } from './skill-installation-topology'

const roots: string[] = []

async function writePackage(root: string, prefix: string): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'SKILL.md'), `${prefix} entry`)
  await writeFile(join(root, 'asset.txt'), `${prefix} asset`)
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-publish-identity-'))
  roots.push(root)
  const live = join(root, 'home', '.agents', 'skills', 'orca-cli')
  const packagesRoot = join(root, 'packages')
  const currentRoot = join(packagesRoot, 'orca-cli')
  await writePackage(live, 'old')
  await writePackage(currentRoot, 'new')
  const priorObserved = await observeSkillPackage(live)
  const currentObserved = await observeSkillPackage(currentRoot)
  const prior: SkillReleasedSnapshot = {
    releaseRevision: 1,
    packageDigest: priorObserved.observedDigest,
    gitTreeSha: '',
    files: persistedObservedFiles(priorObserved)
  }
  const current: SkillCurrentBundleEntry = {
    name: 'orca-cli',
    sourcePath: 'skills/orca-cli',
    appVersion: '2.0.0',
    releaseRevision: 2,
    packageDigest: currentObserved.observedDigest,
    gitTreeSha: '',
    files: persistedObservedFiles(currentObserved)
  }
  const resolvedLive = await realpath(live)
  const record: ManagedSkillDestination = {
    id: '000000000000000000000000',
    hostId: 'local',
    homeIdentity: join(root, 'home'),
    rootId: 'home-agents',
    unresolvedPath: live,
    resolvedPath: resolvedLive,
    physicalIdentity: skillPhysicalIdentity(resolvedLive, await stat(resolvedLive)),
    entryType: 'directory',
    skillName: 'orca-cli',
    source: 'stablyai/orca',
    sourcePath: 'skills/orca-cli',
    sourceRef: null,
    installedReleaseRevision: 1,
    installedPackageDigest: prior.packageDigest,
    installedFiles: prior.files,
    lastWrittenPackageDigest: null,
    lastAttemptedBundleFingerprint: null,
    lastOutcome: 'adopted',
    lastErrorCategory: null,
    adoptedFrom: 'exact-snapshot',
    adoptedAt: 1,
    updatedAt: 1
  }
  return { root, live, packagesRoot, prior, current, record }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('skill package durable identity', () => {
  it.each(['package-swap', 'in-place'] as const)(
    'does not commit an exact-content independent replacement after %s publication',
    async (mode) => {
      const value = await fixture()
      const replacement = join(value.root, 'independent-replacement')
      await cp(join(value.packagesRoot, 'orca-cli'), replacement, { recursive: true })
      let committed = false
      let replacementInjected = false

      await expect(
        publishBundledSkill({
          record: value.record,
          current: value.current,
          releasedSnapshots: [value.prior, value.current],
          packagesRoot: value.packagesRoot,
          commit: () => {
            committed = true
          },
          publicationRenameRuntime:
            mode === 'in-place'
              ? {
                  windowsFallback: true,
                  renameEntry: async () => {
                    throw Object.assign(new Error('busy'), { code: 'EPERM' })
                  },
                  wait: async () => undefined
                }
              : undefined,
          beforeDurableCommitValidation: async () => {
            replacementInjected = true
            await rm(value.live, { recursive: true })
            await rename(replacement, value.live)
          }
        })
      ).rejects.toThrow()

      expect(replacementInjected).toBe(true)
      expect(committed).toBe(false)
      expect((await observeSkillPackage(value.live)).observedDigest).toBe(
        value.current.packageDigest
      )
    }
  )

  it.each(['before-entry', 'before-workspace'] as const)(
    'writes no workspace through a parent link swapped %s',
    async (timing) => {
      const value = await fixture()
      const agentsRoot = join(value.root, 'home', '.agents')
      const originalAgentsRoot = join(value.root, 'original-agents')
      const externalAgentsRoot = join(value.root, 'external-agents')
      const swapParent = async (): Promise<void> => {
        await rename(agentsRoot, originalAgentsRoot)
        await mkdir(join(externalAgentsRoot, 'skills'), { recursive: true })
        await cp(
          join(originalAgentsRoot, 'skills', 'orca-cli'),
          join(externalAgentsRoot, 'skills', 'orca-cli'),
          { recursive: true }
        )
        await symlink(
          externalAgentsRoot,
          agentsRoot,
          process.platform === 'win32' ? 'junction' : 'dir'
        )
      }
      if (timing === 'before-entry') {
        await swapParent()
      }

      await expect(
        publishBundledSkill({
          record: value.record,
          current: value.current,
          releasedSnapshots: [value.prior, value.current],
          packagesRoot: value.packagesRoot,
          commit: () => undefined,
          beforeWorkspaceCreationValidation: timing === 'before-workspace' ? swapParent : undefined
        })
      ).rejects.toThrow('skill-topology-changed')

      expect(
        await lstat(join(externalAgentsRoot, '.orca-skill-transactions')).catch(() => null)
      ).toBeNull()
    }
  )
})
