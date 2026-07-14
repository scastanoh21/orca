import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/types'
import { routeListingBranchSwitchesThroughGitIdentity } from './worktree-listing-branch-switch'

function makeWorktree(overrides: Partial<Worktree> & { id: string }): Worktree {
  return {
    repoId: 'repo1',
    path: '/path/wt',
    head: 'abc123',
    branch: 'refs/heads/feature-one',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature-one',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

const hasLinkedPR = (worktree: Worktree): boolean => worktree.linkedPR != null

describe('routeListingBranchSwitchesThroughGitIdentity', () => {
  it('routes a listing-observed branch switch through updateWorktreeGitIdentity', () => {
    const updateWorktreeGitIdentity = vi.fn()

    routeListingBranchSwitchesThroughGitIdentity({
      current: [makeWorktree({ id: 'repo1::/path/wt1', linkedPR: 101 })],
      incoming: [{ id: 'repo1::/path/wt1', branch: 'refs/heads/feature-two', head: 'def456' }],
      hasBranchScopedReviewContext: hasLinkedPR,
      updateWorktreeGitIdentity
    })

    expect(updateWorktreeGitIdentity).toHaveBeenCalledTimes(1)
    expect(updateWorktreeGitIdentity).toHaveBeenCalledWith('repo1::/path/wt1', {
      head: 'def456',
      branch: 'refs/heads/feature-two'
    })
  })

  it('does nothing when the branch is unchanged', () => {
    const updateWorktreeGitIdentity = vi.fn()

    routeListingBranchSwitchesThroughGitIdentity({
      current: [makeWorktree({ id: 'repo1::/path/wt1', linkedPR: 101 })],
      incoming: [{ id: 'repo1::/path/wt1', branch: 'refs/heads/feature-one', head: 'def456' }],
      hasBranchScopedReviewContext: hasLinkedPR,
      updateWorktreeGitIdentity
    })

    expect(updateWorktreeGitIdentity).not.toHaveBeenCalled()
  })

  it('skips entries without branch-scoped review context (stale-refetch protection)', () => {
    const updateWorktreeGitIdentity = vi.fn()

    routeListingBranchSwitchesThroughGitIdentity({
      current: [makeWorktree({ id: 'repo1::/path/wt1', linkedPR: null })],
      incoming: [{ id: 'repo1::/path/wt1', branch: 'refs/heads/feature-two', head: 'def456' }],
      hasBranchScopedReviewContext: hasLinkedPR,
      updateWorktreeGitIdentity
    })

    expect(updateWorktreeGitIdentity).not.toHaveBeenCalled()
  })

  it('skips incoming worktrees with no current entry (cold hydration)', () => {
    const updateWorktreeGitIdentity = vi.fn()

    routeListingBranchSwitchesThroughGitIdentity({
      current: [makeWorktree({ id: 'repo1::/path/other', linkedPR: 101 })],
      incoming: [{ id: 'repo1::/path/wt1', branch: 'refs/heads/feature-two', head: 'def456' }],
      hasBranchScopedReviewContext: hasLinkedPR,
      updateWorktreeGitIdentity
    })

    expect(updateWorktreeGitIdentity).not.toHaveBeenCalled()
  })

  it('does nothing when there is no current list', () => {
    const updateWorktreeGitIdentity = vi.fn()

    routeListingBranchSwitchesThroughGitIdentity({
      current: undefined,
      incoming: [{ id: 'repo1::/path/wt1', branch: 'refs/heads/feature-two', head: 'def456' }],
      hasBranchScopedReviewContext: hasLinkedPR,
      updateWorktreeGitIdentity
    })

    expect(updateWorktreeGitIdentity).not.toHaveBeenCalled()
  })

  it('maps an empty listing branch to the explicit detached-HEAD signal', () => {
    const updateWorktreeGitIdentity = vi.fn()

    routeListingBranchSwitchesThroughGitIdentity({
      current: [makeWorktree({ id: 'repo1::/path/wt1', linkedPR: 101 })],
      incoming: [{ id: 'repo1::/path/wt1', branch: '', head: 'def456' }],
      hasBranchScopedReviewContext: hasLinkedPR,
      updateWorktreeGitIdentity
    })

    expect(updateWorktreeGitIdentity).toHaveBeenCalledWith('repo1::/path/wt1', {
      head: 'def456',
      branch: null
    })
  })
})
