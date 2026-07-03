import {
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison
} from '../../../src/shared/cross-platform-path'
import type { Worktree } from '../worktree/workspace-list-types'
import type { AiVaultScope } from '../../../src/shared/ai-vault-types'

// Why: the aiVault.listSessions RPC rejects (does not truncate) scopePaths past
// AI_VAULT_SCOPE_PATHS_MAX_COUNT, so a repo with many sibling worktrees must cap
// here or the whole project-scope load hard-fails. scopePaths only widen
// discovery, so a truncated list omits some siblings instead of erroring.
const MOBILE_AI_VAULT_SCOPE_PATHS_MAX = 64

// Why: the renderer's deriveAiVault* helpers are renderer-located and
// Metro-unresolvable, so mobile does its own minimal derivation seeded by the
// active worktree's path plus same-repo sibling worktrees (mobile already loads
// the full worktree list via worktree.ps). scopePaths only widen the host scan's
// discovery breadth; they are host-local match prefixes, never device paths.
export function deriveMobileAiVaultScopePaths(
  scope: AiVaultScope,
  activeWorktree: Pick<Worktree, 'worktreeId' | 'path' | 'repoId'> | null,
  liveWorktrees: readonly Pick<Worktree, 'worktreeId' | 'path' | 'repoId'>[]
): string[] {
  // 'all' scope scans without scope hints — the host returns the global recency
  // list, so no scopePaths are needed (and would only narrow discovery).
  if (scope === 'all' || !activeWorktree) {
    return []
  }

  const paths: string[] = []
  addScopePath(paths, activeWorktree.path)

  // Workspace scope = the active worktree only. Project scope additionally
  // covers same-repo sibling worktrees so the project view stays complete.
  if (scope === 'project') {
    for (const worktree of liveWorktrees) {
      if (paths.length >= MOBILE_AI_VAULT_SCOPE_PATHS_MAX) {
        break
      }
      if (worktree.repoId === activeWorktree.repoId) {
        addScopePath(paths, worktree.path)
      }
    }
  }

  return paths
}

function addScopePath(paths: string[], pathValue: string | undefined): void {
  const trimmedPath = pathValue?.trim()
  if (!trimmedPath || !isRuntimePathAbsolute(trimmedPath)) {
    return
  }
  const comparisonPath = normalizeRuntimePathForComparison(trimmedPath)
  if (
    paths.some((existingPath) => normalizeRuntimePathForComparison(existingPath) === comparisonPath)
  ) {
    return
  }
  paths.push(trimmedPath)
}
