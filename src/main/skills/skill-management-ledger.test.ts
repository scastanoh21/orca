import { describe, expect, it } from 'vitest'
import type { ManagedSkillDestination } from '../../shared/skill-management'
import { normalizeSkillManagementLedger } from './skill-management-ledger'

function destination(): ManagedSkillDestination {
  const digest = 'a'.repeat(64)
  return {
    id: 'destination',
    hostId: 'local',
    homeIdentity: '/home/alice',
    rootId: 'home-agents',
    unresolvedPath: '/home/alice/.agents/skills/orca-cli',
    resolvedPath: '/home/alice/.agents/skills/orca-cli',
    physicalIdentity: '1:2',
    entryType: 'directory',
    skillName: 'orca-cli',
    source: 'stablyai/orca',
    sourcePath: 'skills/orca-cli',
    sourceRef: null,
    installedReleaseRevision: 1,
    installedPackageDigest: digest,
    installedFiles: [
      {
        path: 'SKILL.md',
        size: 1,
        executable: false,
        classification: 'text',
        exactSha256: digest,
        textNormalizedSha256: digest,
        identitySha256: digest
      }
    ],
    lastWrittenPackageDigest: null,
    lastAttemptedBundleFingerprint: digest,
    lastOutcome: 'adopted',
    lastErrorCategory: null,
    adoptedFrom: 'exact-snapshot',
    adoptedAt: 1,
    updatedAt: 1
  }
}

describe('skill management ledger parsing', () => {
  it('retains a completely valid destination', () => {
    const record = destination()
    expect(
      normalizeSkillManagementLedger({
        schemaVersion: 1,
        destinations: { [record.id]: record },
        dismissedAdoptionCandidates: []
      }).destinations[record.id]
    ).toEqual(record)
  })

  it('drops a destination when any write-authority identity is malformed', () => {
    const record = destination()
    const malformed = { ...record, physicalIdentity: undefined }
    expect(
      normalizeSkillManagementLedger({
        schemaVersion: 1,
        destinations: { [record.id]: malformed },
        dismissedAdoptionCandidates: []
      }).destinations
    ).toEqual({})
  })
})
