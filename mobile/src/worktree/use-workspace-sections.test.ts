import { describe, expect, it } from 'vitest'
import { getVisibleRepoIdsByName, type RepoSectionSummary } from './use-workspace-sections'

const repos: RepoSectionSummary[] = [
  { id: 'local-repo', displayName: 'local' },
  { id: 'ssh-repo', displayName: 'ssh', connectionId: 'builder' },
  { id: 'runtime-repo', displayName: 'runtime', executionHostId: 'runtime:devbox' }
]

describe('getVisibleRepoIdsByName', () => {
  it('keeps every repo when desktop is showing all hosts', () => {
    expect([...getVisibleRepoIdsByName({ repos }).entries()]).toEqual([
      ['local', 'local-repo'],
      ['ssh', 'ssh-repo'],
      ['runtime', 'runtime-repo']
    ])
  })

  it('filters repos to the desktop visible workspace hosts', () => {
    expect([
      ...getVisibleRepoIdsByName({
        repos,
        workspaceHostScope: 'all',
        visibleWorkspaceHostIds: ['runtime:devbox']
      }).entries()
    ]).toEqual([['runtime', 'runtime-repo']])
  })
})
