import { describe, expect, it } from 'vitest'
import type { RuntimeWorkspaceListModelResult } from '../../../src/shared/runtime-types'
import { areWorkspaceListModelResultsEqual } from './workspace-list-model-snapshot'

function model(
  overrides: Partial<RuntimeWorkspaceListModelResult> = {}
): RuntimeWorkspaceListModelResult {
  return {
    modelVersion: 1,
    generatedAt: 1_700_000_000_000,
    preferences: {
      groupBy: 'repo',
      sortBy: 'smart',
      projectOrderBy: 'manual',
      collapsedGroups: [],
      filterRepoIds: [],
      showSleepingWorkspaces: true,
      hideDefaultBranchWorkspace: false,
      hideAutomationGeneratedWorkspaces: false,
      workspaceHostScope: 'all',
      visibleWorkspaceHostIds: null,
      workspaceHostOrder: []
    },
    sortedWorktreeIds: ['a', 'b'],
    visibleWorktreeIds: ['a', 'b'],
    rows: [
      { type: 'header', key: 'all', label: 'All', count: 2 },
      {
        type: 'item',
        sectionKey: 'all',
        rowKey: 'all:a',
        depth: 0,
        lineageChildCount: 0,
        worktree: { id: 'a' }
      } as RuntimeWorkspaceListModelResult['rows'][number]
    ],
    totalRowCount: 2,
    agentsByWorktreeId: {},
    sourceCompletenessWarnings: [],
    truncated: false,
    ...overrides
  }
}

describe('areWorkspaceListModelResultsEqual', () => {
  it('treats the same reference as equal', () => {
    const value = model()
    expect(areWorkspaceListModelResultsEqual(value, value)).toBe(true)
  })

  it('treats structurally identical but distinct models as equal', () => {
    expect(areWorkspaceListModelResultsEqual(model(), model())).toBe(true)
  })

  it('ignores generatedAt so the guard survives the per-poll timestamp refresh', () => {
    // The host stamps a fresh generatedAt on every poll; identical content with a
    // newer timestamp must still compare equal, or the reference-preservation
    // guard would never fire in production.
    expect(
      areWorkspaceListModelResultsEqual(
        model({ generatedAt: 1_700_000_000_000 }),
        model({ generatedAt: 1_700_000_003_000 })
      )
    ).toBe(true)
  })

  it('is not equal when either side is null (but two nulls collapse upstream)', () => {
    expect(areWorkspaceListModelResultsEqual(model(), null)).toBe(false)
    expect(areWorkspaceListModelResultsEqual(null, model())).toBe(false)
  })

  it('detects a changed sort order', () => {
    expect(
      areWorkspaceListModelResultsEqual(model(), model({ sortedWorktreeIds: ['b', 'a'] }))
    ).toBe(false)
  })

  it('detects a changed truncation / row count', () => {
    expect(areWorkspaceListModelResultsEqual(model(), model({ truncated: true }))).toBe(false)
    expect(areWorkspaceListModelResultsEqual(model(), model({ totalRowCount: 3 }))).toBe(false)
  })

  it('detects a deep change the length pre-checks miss (agent state flip)', () => {
    // Same shape/lengths, but an agent transitioned — must not be reused, or the
    // badge/order would render stale.
    const before = model({ agentsByWorktreeId: {} })
    const after = model({
      agentsByWorktreeId: {
        a: [
          {
            paneKey: 'a:1',
            parentPaneKey: null,
            state: 'working',
            agentType: 'codex',
            prompt: 'x',
            taskTitle: null,
            displayName: null,
            lastAssistantMessage: null,
            toolName: null,
            toolInput: null,
            interrupted: false,
            stateStartedAt: 1,
            updatedAt: 1
          }
        ]
      } as RuntimeWorkspaceListModelResult['agentsByWorktreeId']
    })
    expect(areWorkspaceListModelResultsEqual(before, after)).toBe(false)
  })
})
