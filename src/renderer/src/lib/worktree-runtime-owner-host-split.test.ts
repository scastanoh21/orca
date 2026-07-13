import { describe, expect, it } from 'vitest'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from './worktree-runtime-owner'

// Repro + regression guard for #8484: the same project is registered on BOTH
// local desktop and a paired runtime. Two repo records share the repoId; each
// host's worktree lives at a distinct filesystem path and (as with legacy /
// pre-project-host metadata) carries no explicit hostId. Diff routing must
// follow the worktree's owning host, not the global default runtime.
const LOCAL_WORKTREE = 'proj::/Users/me/GitHub/.orca-worktrees/proj-wt'
const RUNTIME_WORKTREE = 'proj::/home/user/orca-worktrees/proj-wt'

function buildHostSplitState(
  activeRuntimeEnvironmentId: string | null,
  repoOrder: 'local-first' | 'legacy-first'
): WorktreeRuntimeOwnerState {
  const localRepo = {
    id: 'proj',
    connectionId: null,
    executionHostId: 'local' as const,
    path: '/Users/me/GitHub/proj'
  }
  const runtimeRepo = {
    id: 'proj',
    connectionId: null,
    executionHostId: 'runtime:env-1' as const,
    path: '/home/user/proj'
  }
  const legacyRepo = { id: 'proj', connectionId: null, executionHostId: null, path: '' }
  const repos =
    repoOrder === 'local-first' ? [localRepo, runtimeRepo] : [legacyRepo, localRepo, runtimeRepo]
  return {
    settings: { activeRuntimeEnvironmentId },
    repos,
    worktreesByRepo: {
      proj: [
        { id: LOCAL_WORKTREE, repoId: 'proj' },
        { id: RUNTIME_WORKTREE, repoId: 'proj' }
      ]
    }
  }
}

describe('#8484 diff routing follows the worktree owner, not the global default', () => {
  it('routes each host-split worktree by its own path while the runtime is default', () => {
    const state = buildHostSplitState('env-1', 'local-first')
    expect(getRuntimeEnvironmentIdForWorktree(state, LOCAL_WORKTREE)).toBeNull()
    expect(getExecutionHostIdForWorktree(state, LOCAL_WORKTREE)).toBe('local')
    expect(getRuntimeEnvironmentIdForWorktree(state, RUNTIME_WORKTREE)).toBe('env-1')
    expect(getExecutionHostIdForWorktree(state, RUNTIME_WORKTREE)).toBe('runtime:env-1')
  })

  it('routes each host-split worktree by its own path while local is default', () => {
    const state = buildHostSplitState(null, 'local-first')
    expect(getRuntimeEnvironmentIdForWorktree(state, LOCAL_WORKTREE)).toBeNull()
    expect(getRuntimeEnvironmentIdForWorktree(state, RUNTIME_WORKTREE)).toBe('env-1')
  })

  it('still resolves the runtime worktree past a legacy null-host record for the same repoId', () => {
    const localDefault = buildHostSplitState(null, 'legacy-first')
    expect(getRuntimeEnvironmentIdForWorktree(localDefault, LOCAL_WORKTREE)).toBeNull()
    expect(getRuntimeEnvironmentIdForWorktree(localDefault, RUNTIME_WORKTREE)).toBe('env-1')

    const runtimeDefault = buildHostSplitState('env-1', 'legacy-first')
    // The local worktree must stay local even when the runtime is the global default.
    expect(getRuntimeEnvironmentIdForWorktree(runtimeDefault, LOCAL_WORKTREE)).toBeNull()
    expect(getExecutionHostIdForWorktree(runtimeDefault, LOCAL_WORKTREE)).toBe('local')
    expect(getRuntimeEnvironmentIdForWorktree(runtimeDefault, RUNTIME_WORKTREE)).toBe('env-1')
  })

  it('an explicit worktree hostId still wins over path inference', () => {
    const state = buildHostSplitState('env-1', 'local-first')
    const withHostId: WorktreeRuntimeOwnerState = {
      ...state,
      worktreesByRepo: {
        proj: [
          { id: LOCAL_WORKTREE, repoId: 'proj', hostId: 'runtime:env-1' },
          { id: RUNTIME_WORKTREE, repoId: 'proj', hostId: 'local' }
        ]
      }
    }
    expect(getRuntimeEnvironmentIdForWorktree(withHostId, LOCAL_WORKTREE)).toBe('env-1')
    expect(getRuntimeEnvironmentIdForWorktree(withHostId, RUNTIME_WORKTREE)).toBeNull()
  })
})
