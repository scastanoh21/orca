import type { Worktree } from '../../../../shared/types'

/**
 * Route branch switches observed by a worktree-listing refresh through
 * `updateWorktreeGitIdentity` before the listing is merged into the store.
 *
 * Why: a terminal branch switch is observed by two independent refresh paths —
 * the git-status identity path (which clears branch-scoped review links) and
 * the worktree-listing path (which rehydrates persisted metadata, including a
 * now-stale linked PR, alongside the new branch). If the listing merge lands
 * first, the identity path sees no branch change and never clears, leaving
 * Checks pinned to the previous branch's PR. Applying the identity update
 * first makes the link clear happen no matter which path wins the race.
 *
 * Only entries that still carry branch-scoped review context are routed: when
 * there is nothing to clear the plain merge already applies the new branch,
 * and skipping the rest preserves the stale-refetch protection where an old
 * listing row must not roll back a newer branch identity.
 */
export function routeListingBranchSwitchesThroughGitIdentity(args: {
  current: readonly Worktree[] | undefined
  incoming: readonly Pick<Worktree, 'id' | 'branch' | 'head'>[]
  hasBranchScopedReviewContext: (worktree: Worktree) => boolean
  updateWorktreeGitIdentity: (
    worktreeId: string,
    identity: { head?: string; branch?: string | null }
  ) => void
}): void {
  const { current, incoming, hasBranchScopedReviewContext, updateWorktreeGitIdentity } = args
  if (!current?.length) {
    return
  }
  const currentById = new Map(current.map((worktree) => [worktree.id, worktree]))
  for (const worktree of incoming) {
    const existing = currentById.get(worktree.id)
    if (
      !existing ||
      existing.branch === worktree.branch ||
      !hasBranchScopedReviewContext(existing)
    ) {
      continue
    }
    updateWorktreeGitIdentity(worktree.id, {
      head: worktree.head,
      // Empty branch means detached HEAD in listing results; null is the
      // explicit detached signal expected by updateWorktreeGitIdentity.
      branch: worktree.branch === '' ? null : worktree.branch
    })
  }
}
