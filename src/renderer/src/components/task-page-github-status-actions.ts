import type {
  GitHubIssueCloseReason,
  GitHubIssueUpdate,
  GitHubWorkItem
} from '../../../shared/types'

export type TaskPageGitHubCloseAction = {
  stateReason: GitHubIssueCloseReason
  duplicateOf?: number
}

export type TaskPageGitHubDuplicateValidation =
  | { ok: true; duplicateOf: number }
  | {
      ok: false
      reason: 'missing' | 'not_integer' | 'not_positive' | 'same_issue'
    }

export function buildTaskPageGitHubCloseUpdate(
  action: TaskPageGitHubCloseAction
): GitHubIssueUpdate {
  return {
    state: 'closed',
    stateReason: action.stateReason,
    ...(action.duplicateOf !== undefined ? { duplicateOf: action.duplicateOf } : {})
  }
}

export function validateTaskPageGitHubDuplicateTarget(
  value: string,
  currentIssueNumber: number
): TaskPageGitHubDuplicateValidation {
  const trimmed = value.trim()
  if (!trimmed) {
    return { ok: false, reason: 'missing' }
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, reason: 'not_integer' }
  }
  const duplicateOf = Number(trimmed)
  if (!Number.isSafeInteger(duplicateOf) || duplicateOf <= 0) {
    return { ok: false, reason: 'not_positive' }
  }
  if (duplicateOf === currentIssueNumber) {
    return { ok: false, reason: 'same_issue' }
  }
  return { ok: true, duplicateOf }
}

export function getTaskPageGitHubDuplicateCandidates(
  items: GitHubWorkItem[],
  currentIssueNumber: number,
  query: string
): GitHubWorkItem[] {
  const normalizedQuery = query.trim().toLowerCase()
  return items.filter((candidate) => {
    if (candidate.type !== 'issue' || candidate.number === currentIssueNumber) {
      return false
    }
    if (!normalizedQuery) {
      return true
    }
    return (
      candidate.title.toLowerCase().includes(normalizedQuery) ||
      String(candidate.number).includes(normalizedQuery)
    )
  })
}
