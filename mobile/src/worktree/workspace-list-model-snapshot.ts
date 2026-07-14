import type { RuntimeWorkspaceListModelResult } from '../../../src/shared/runtime-types'

// Why: the host re-derives and re-sends the whole list model on every 3s poll,
// so the RPC result is a fresh reference each time even when nothing changed.
// Preserving the previous reference on identical content keeps the downstream
// useWorkspaceSections memo (and the native SectionList rebuild) off the poll
// path unless something actually changed — mirroring the worktree.ps snapshot
// guard (areWorktreeListsEqual) that sits right beside it.
//
// Correctness over cleverness: cheap shape checks short-circuit the common
// "something changed" case, and any survivor is compared by a full stable
// serialization. A missed field can therefore never yield a stale render — a
// difference the shape checks don't catch still changes the serialized form.
export function areWorkspaceListModelResultsEqual(
  left: RuntimeWorkspaceListModelResult | null,
  right: RuntimeWorkspaceListModelResult | null
): boolean {
  if (left === right) {
    return true
  }
  if (left == null || right == null) {
    return false
  }
  if (
    left.truncated !== right.truncated ||
    left.totalRowCount !== right.totalRowCount ||
    left.rows.length !== right.rows.length ||
    left.sortedWorktreeIds.length !== right.sortedWorktreeIds.length ||
    left.visibleWorktreeIds.length !== right.visibleWorktreeIds.length
  ) {
    return false
  }
  // Both models are produced by the same deterministic host derivation, so key
  // order is stable and JSON equality is exact content equality.
  // Why: generatedAt is a per-call wall-clock stamp the host refreshes on every
  // poll and no mobile consumer reads. Including it would make this compare fail
  // on every 3s poll, defeating the reference preservation this guard exists for.
  const { generatedAt: _leftGeneratedAt, ...leftComparable } = left
  const { generatedAt: _rightGeneratedAt, ...rightComparable } = right
  return JSON.stringify(leftComparable) === JSON.stringify(rightComparable)
}
