# Review Context

## Branch Info
- Base: origin/main (merge-base: 201685b2)
- Current: github-ui

## Changed Files Summary
Modified:
- M src/main/git/runner.ts
- M src/main/ipc/github.ts
- M src/preload/api-types.ts
- M src/preload/index.ts
- M src/renderer/src/components/GitHubItemDialog.tsx
- M src/renderer/src/components/TaskPage.tsx
- M src/renderer/src/store/slices/github.ts
- M src/shared/constants.ts
- M src/shared/types.ts

Added:
- A src/main/git/runner.test.ts
- A src/main/github/project-view.ts
- A src/main/github/project-view.test.ts
- A src/main/github/rate-limit.ts
- A src/renderer/src/components/github-project/group-sort.ts
- A src/renderer/src/components/github-project/group-sort.test.ts
- A src/renderer/src/components/github-project/ProjectCell.tsx
- A src/renderer/src/components/github-project/ProjectGroupHeader.tsx
- A src/renderer/src/components/github-project/ProjectItemSlugDialog.tsx
- A src/renderer/src/components/github-project/ProjectPicker.tsx
- A src/renderer/src/components/github-project/ProjectRow.tsx
- A src/renderer/src/components/github-project/ProjectViewList.tsx
- A src/renderer/src/components/github-project/ProjectViewWrapper.tsx
- A src/renderer/src/components/github/GitHubRateLimitPill.tsx
- A src/renderer/src/hooks/useGitHubSlugMetadata.ts
- A src/renderer/src/lib/repo-slug-index.ts
- A src/shared/github-project-types.ts

## Changed Line Ranges (PR Scope)
For added files, all lines are in scope. For modified files, see git diff hunks. Authoritative source: `git diff $(git merge-base origin/main HEAD) <file>`.

## Review Standards Reference
- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

### Backend/API (priority 4)
- src/main/git/runner.ts
- src/main/git/runner.test.ts
- src/main/ipc/github.ts
- src/main/github/project-view.ts
- src/main/github/project-view.test.ts
- src/main/github/rate-limit.ts
- src/preload/api-types.ts
- src/preload/index.ts

### Frontend/UI (priority 5)
- src/renderer/src/components/GitHubItemDialog.tsx
- src/renderer/src/components/TaskPage.tsx
- src/renderer/src/components/github/GitHubRateLimitPill.tsx
- src/renderer/src/components/github-project/ProjectCell.tsx
- src/renderer/src/components/github-project/ProjectGroupHeader.tsx
- src/renderer/src/components/github-project/ProjectItemSlugDialog.tsx
- src/renderer/src/components/github-project/ProjectPicker.tsx
- src/renderer/src/components/github-project/ProjectRow.tsx
- src/renderer/src/components/github-project/ProjectViewList.tsx
- src/renderer/src/components/github-project/ProjectViewWrapper.tsx
- src/renderer/src/components/github-project/group-sort.ts
- src/renderer/src/components/github-project/group-sort.test.ts
- src/renderer/src/store/slices/github.ts
- src/renderer/src/hooks/useGitHubSlugMetadata.ts
- src/renderer/src/lib/repo-slug-index.ts

### Utility/Common (priority 7)
- src/shared/constants.ts
- src/shared/types.ts
- src/shared/github-project-types.ts

## Skipped Issues (Do Not Re-validate)
<!-- Format: [file:line-range] | [severity] | [reason skipped] | [issue summary] -->

(none yet)

## Iteration State
Current iteration: 1
Last completed phase: Setup
Files fixed this iteration: []
