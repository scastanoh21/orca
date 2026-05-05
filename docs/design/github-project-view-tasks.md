# Design: GitHub Project View Tasks

## Problem

Orca's current GitHub Tasks view lists issues/PRs per repo. Users who plan work in a GitHub ProjectV2 cannot see that plan here — their filter, grouping, and sort order live on github.com and are lost the moment they switch to Orca to start a task.

The workflow we care about is: *"open the Project view I already use, find the row I want, update its fields, and start work on it."* The Project's *configuration* (views, filter, groupBy, sortBy, field schema) is still edited on GitHub — Orca does not recreate the Projects admin UI. But a user who plans in a Project should be able to change a row's **field values** (Status, Priority, Size, Sprint, Triage Group, custom single-selects / iterations / text / number / date) without context-switching to the browser. Concretely, on `https://github.com/orgs/stablyai/projects/3` with the `Me` view selected, a user should see the same filtered row set, grouped by `Sprint`, sorted by `Priority` then `Size` using the comparators documented below, be able to flip a row from `Todo → In progress` or bump `Priority` from `P1 → P0`, and launch a worktree from a row.

The built-in `gh project` commands don't expose enough view configuration to reproduce this. `gh api graphql` does, using the user's existing `gh` token.

## Goal

Add a **Project mode** inside Tasks that renders **one** selected ProjectV2 view as a grouped row list whose **row data is editable in place**. The list uses the view's filter, first group field, and sort fields as configured on GitHub; exactness is enforced for the filtered item set and for the supported comparator semantics below, with unknown fields falling back to GitHub rank order instead of inventing a misleading sort. Existing Orca task actions (open details, open in browser, start work) continue to work from a row, and common row-level edits — project field values, the issue/PR title and body, labels/assignees, and comments — write back to GitHub through the same `gh` token.

In scope:

- One opinionated grouped-row rendering (not a full Projects table clone).
- Use the selected view's `filter`, `groupByFields[0]`, and `sortByFields` as-is.
- Project picker (pinned / recent / paste-to-add) so users can switch projects.
- Block render until the view is fully paginated; hard cap at 500 items.
- **Row-level editing** of:
  - **Status** and other ProjectV2 single-select fields (Priority, Size, Triage Group, …) — inline click-to-edit on the list cell and in the dialog — via `updateProjectV2ItemFieldValue`. Status is called out because it is the most frequently edited field and the one users expect to flip directly from the list (`Todo → In progress`) without opening a dialog.
  - Other ProjectV2 field values — iteration, text, number, date — via `updateProjectV2ItemFieldValue` / `clearProjectV2ItemFieldValue`.
  - **Assignees** on the underlying issue/PR — inline on the list (click the assignees cell to open the same user-picker popover the existing dialog uses) and in the dialog — through the existing `GitHubItemDialog` UI, backed by slug-addressed mutation helpers for Project-origin rows. Called out because "assign this row to me" is the second most common ownership action after Status.
  - **Labels** on the underlying issue/PR — in the dialog — through the existing `GitHubItemDialog` UI, backed by slug-addressed mutation helpers for Project-origin rows.
  - Issue/PR **title** and **body** via new issue/PR mutation helpers that target the resolved repo slug from the Project row (dialog only, not inline).
  - **Comments**: create, edit, delete via issue-comment REST endpoints (dialog only). Reuses the same comment-thread surface as Issues/PRs mode — no new comment UI.
  All writes use classified-error envelopes with optimistic patches and rollback, mirroring the existing labels/assignees flow.

## Non-Goals

All rejected during Phase A in favor of shipping a single focused workflow (alternative **A1: Workflow-first single view**):

- **No view tabs / multi-view switcher in v1.** Users select one view via the picker and work with it. A later pass can add view switching.
- **No View menu (Fields / Group by / Sort by / Field sum / Slice by / Show hierarchy / Show agent sessions).** The view's GitHub-owned configuration is authoritative; Orca does not let users edit it in v1.
- **No editable filter bar.** Filter is rendered as a read-only label sourced from the view.
- **No column visibility toggling.** Rendered columns are derived from the view's `fields`.
- **No board or roadmap rendering.** Non-table layouts surface an unsupported state.
- **No view-configuration editing** — no drag-to-rank, project-item creation, view creation, filter editing, field/schema editing, group/sort changes, or column visibility changes. Row field-value edits are in scope; view structure remains GitHub-owned.
- **No separate PAT.** All access is through the user's `gh` auth.
- **No "Show agent sessions" in v1.** Deferred; see Open Questions.
- **No provisional sort while loading.** Rows are not rendered until pagination completes.
- **No background auto-pagination.** Views over the cap surface an explicit oversize state.

## Prototype Result

Prototype ran against `gh 2.88.1` with `project` scope on the active token. The queries below are frozen into the design — they validated the GraphQL shape.

View configuration:

```sh
gh api graphql -F org=stablyai -F num=3 -f query='
query($org:String!, $num:Int!) {
  organization(login:$org) {
    projectV2(number:$num) {
      id
      title
      url
      views(first:20) {
        nodes {
          id
          number
          name
          layout
          filter
          # Prototype used small page sizes for inspection. Implementation
          # paginates view fields/views; see "GraphQL Pagination Requirements".
          fields(first:20) { nodes { ...FieldConfig } }
          groupByFields(first:10) { nodes { ...FieldConfig } }
          sortByFields(first:10) {
            nodes { direction field { ...FieldConfig } }
          }
        }
      }
    }
  }
}
fragment FieldConfig on ProjectV2FieldConfiguration {
  __typename
  ... on ProjectV2Field { id name dataType }
  ... on ProjectV2SingleSelectField {
    id
    name
    dataType
    options { id name color }
  }
  ... on ProjectV2IterationField {
    id
    name
    dataType
    configuration {
      iterations { id title startDate duration }
      completedIterations { id title startDate duration }
    }
  }
}
'
```

The `Me` view returned `filter: "assignee:@me is:open no:triage-group"`, `groupByFields: Sprint`, `sortByFields: Priority ASC, Size ASC`.

Item query:

```sh
gh api graphql \
  -F org=stablyai \
  -F num=3 \
  -F q='assignee:@me is:open no:triage-group' \
  -f query='
query($org:String!, $num:Int!, $q:String!) {
  organization(login:$org) {
    projectV2(number:$num) {
      # Prototype query only fetched one page. Implementation uses first:100
      # plus an after cursor; see "Pagination and Size Cap".
      items(first:20, query:$q) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          type
          updatedAt
          content {
            __typename
            ... on Issue {
              id
              number
              title
              url
              state
              stateReason
              repository { nameWithOwner }
              assignees(first:5) { nodes { login name avatarUrl } }
              labels(first:10) { nodes { name color } }
              parent { number title url }
            }
            ... on PullRequest {
              id
              number
              title
              url
              state
              isDraft
              repository { nameWithOwner }
              assignees(first:5) { nodes { login name avatarUrl } }
              labels(first:10) { nodes { name color } }
            }
            ... on DraftIssue { id title body }
          }
          fieldValues(first:30) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue { field { ...FieldConfig } name color optionId }
              ... on ProjectV2ItemFieldIterationValue    { field { ...FieldConfig } title startDate duration iterationId }
              ... on ProjectV2ItemFieldTextValue         { field { ...FieldConfig } text }
              ... on ProjectV2ItemFieldNumberValue       { field { ...FieldConfig } number }
              ... on ProjectV2ItemFieldDateValue         { field { ...FieldConfig } date }
              ... on ProjectV2ItemFieldLabelValue        { field { ...FieldConfig } labels(first:10) { nodes { name color } } }
              ... on ProjectV2ItemFieldUserValue         { field { ...FieldConfig } users(first:5) { nodes { login name avatarUrl } } }
            }
          }
        }
      }
    }
  }
}
fragment FieldConfig on ProjectV2FieldConfiguration {
  __typename
  ... on ProjectV2Field { id name dataType }
  ... on ProjectV2SingleSelectField { id name dataType }
  ... on ProjectV2IterationField { id name dataType }
}
'
```

`totalCount` already reflects the filtered count — no extra unfiltered count call is needed.

### GraphQL Pagination Requirements

The prototype queries above validate the schema shape only. The production implementation must not freeze those small connection sizes into the client:

- `project.views` must paginate until the requested view is found, or until all views have been inspected. If no requested view is supplied, paginate until the first `TABLE_LAYOUT` view is found; continue only as far as needed.
- `view.fields` must paginate all visible fields for the selected view. Rendering "the view's fields" from `first:20` would silently drop columns on larger Project views.
- `view.groupByFields` and `view.sortByFields` can stay capped at `10` because v1 consumes all returned sort fields but only the first group field; if GitHub ever returns `pageInfo.hasNextPage` for either, log a dev warning and proceed with the first page.
- `item.fieldValues` must request at least `first:100` and include `pageInfo.hasNextPage`. If any item reports additional field-value pages, classify the table as `schema_drift` rather than rendering incomplete columns. Nested per-item pagination would multiply subprocess/runtime cost and is out of v1 scope.
- Multi-value label/user field values are capped at `10` labels and `5` users per cell in v1. Overflow renders a `+N` indicator only if GitHub exposes `totalCount` in the nested connection; otherwise it truncates without claiming completeness.

The production item query uses variables `q`, `first`, and `after`, with `items(first: $first, after: $after, query: $q, orderBy: { field: POSITION, direction: ASC })`. The normalizer stamps `row.position` from the zero-based index in this fully paginated `POSITION ASC` stream, so client-side sort tie-breaks preserve GitHub's ranked row order.

`ProjectV2View.filter` is nullable in GitHub's schema. Normalize null/undefined to `''` in `selectedView.filter`. For the item query, pass the normalized string as `$q`; an empty string means "no filter" and keeps the query shape stable across filtered and unfiltered views.

**`Issue.parent` is gated.** The sub-issues relationship backing `parent` is opt-in and some tokens return `FIELD_NOT_FOUND` / `UNDEFINED_FIELD` / a `preview` header error. The module must:

- Issue the item query with `parent` included first.
- On a GraphQL error whose path ends in `parent` or whose type is `FIELD_NOT_FOUND` / `FIELD_ERRORS` / `UNDEFINED_FIELD`, retry the whole table fetch once without the `parent` selection and mark `content.parentIssue = null` on every row. Why the whole table, not just the failed page: otherwise early pages could carry parent data while later pages do not, and the UI would silently mix capability states.
- Log one warning per process lifetime so regressions are observable without spamming logs.

Minimum supported `gh` version: `2.40.0` (first stable GraphQL variable handling for ProjectV2). Required scopes for v1: `repo`, `read:org`, and `project`. `read:project` is enough to render the table but not enough to edit row fields, so the feature treats a read-only token as `scope_missing` once the user attempts a write and the recovery copy asks for `project`.

## Current Code Map

| Concern | Current location |
|---|---|
| Tasks page shell, source toggle, GitHub table | `src/renderer/src/components/TaskPage.tsx` |
| GitHub work item renderer state (cache envelope, inflight dedup, concurrency gate) | `src/renderer/src/store/slices/github.ts` |
| GitHub IPC handlers | `src/main/ipc/github.ts` |
| GitHub API client logic | `src/main/github/client.ts` |
| Shared GitHub item types (`ClassifiedError`, `ListWorkItemsResult`) | `src/shared/types.ts` |
| Preload API types | `src/preload/api-types.ts`, `src/preload/index.ts` |

`TaskPage.tsx` is already large. ProjectV2 rendering ships as its own component tree, not another inline table inside TaskPage.

## Proposed Architecture

### New main-process module: `src/main/github/project-view.ts`

Why a new module instead of piling onto `client.ts`: ProjectV2 is a distinct GraphQL shape with its own normalization layer and retry policy (the `parent`-field dance), and we want those concerns isolated from the issues/PRs client.

Responsibilities:

- Resolve an organization or user project by owner + number.
- Fetch the selected view's config and all items (paginated internally).
- Normalize GitHub GraphQL unions into a renderer-friendly shape.
- Fetch slug-addressed issue/PR conversation details for Project-origin rows that do not have a registered local repo.
- Preserve raw field ids so inline field mutations address Project fields accurately.
- Mutate ProjectV2 item field values using `updateProjectV2ItemFieldValue` and `clearProjectV2ItemFieldValue`.
- Execute `gh api graphql` through the same `execFile` helpers as the rest of the GitHub integration — no direct network calls with a separate token.

### Mutation helpers

Project rows are not guaranteed to belong to the currently selected local repo. Any issue/PR mutation launched from Project mode must target the row's `content.repository` slug (`owner/repo`) instead of deriving owner/repo from an arbitrary `repoPath` preference. The existing `updateIssue` and `addIssueComment` helpers in `src/main/github/issues.ts` intentionally resolve owner/repo from a local repo path to avoid silent source switching in Issues/PRs mode; Project mode needs slug-addressed variants so a row from `org/other-repo` cannot accidentally write to the active workspace repo.

Add slug-addressed main-process helpers for:

- `updateProjectItemFieldValue(projectId, itemId, fieldId, value)` and `clearProjectItemFieldValue(projectId, itemId, fieldId)` in `project-view.ts`.
- `getWorkItemDetailsBySlug(owner, repo, number, type)` returning the conversation payload needed by `GitHubItemDialog`: item summary, body, issue comments, labels, assignees, and participants. For PR rows, PR files/checks/review-thread data remain available only when a registered repo path is present; the slug-backed dialog hides those tabs instead of failing the conversation view.
- `updateIssueBySlug(owner, repo, number, updates)` supporting `title`, `body`, labels, and assignees. Extend `GitHubIssueUpdate` with optional `body?: string`; body writes use `gh api -X PATCH repos/{owner}/{repo}/issues/{number}` because `gh issue edit` does not consistently cover every body-edit case the dialog needs.
- `updatePullRequestBySlug(owner, repo, number, updates)` supporting `title` and `body` through `gh api -X PATCH repos/{owner}/{repo}/pulls/{number}`. Keep the existing `updatePRTitle(repoPath, prNumber, title)` for current PR flows; Project mode should not route through it.
- `addIssueCommentBySlug`, `updateIssueCommentBySlug`, and `deleteIssueCommentBySlug` using `/repos/{owner}/{repo}/issues/{issue_number}/comments` and `/repos/{owner}/{repo}/issues/comments/{comment_id}`. GitHub issue comments back both issues and PR conversation comments, so the same helpers cover Project rows whose content is an issue or PR. Review-thread comments remain out of scope for Project row editing.
- `listLabelsBySlug(owner, repo)` and `listAssignableUsersBySlug(owner, repo, seedLogins?)` for Project-origin dialog and inline assignee controls. Existing label/user lookup helpers are repoPath-addressed and honor issue-source preferences; Project rows must populate their pickers from the row's repository slug or they can show options from the wrong repo. `seedLogins` lets the dialog include currently-visible assignees even when the repo participant search is sparse.

All Project-mode slug IPC helpers return classified envelopes; none should throw expected auth, scope, validation, not-found, or rate-limit failures across IPC. The renderer applies optimistic patches only after it can identify the affected table cache entry and rolls back from the saved previous row state if a mutation envelope is `{ ok: false }`.

All slug-addressed helpers validate `owner`, `repo`, numbers, ids, and body/title lengths in the IPC handler before invoking `gh`. They must reject path separators, whitespace, and empty slugs so untrusted Project row data cannot become an arbitrary REST path. This is validation, not access control — GitHub still enforces permissions through the token.

### Owner resolution cache

v1 ships with the picker, so `ownerType` is supplied by the caller in most flows. For paste-to-add inputs where the type is ambiguous, the module tries `organization(login:)` and falls back to `user(login:)` on `NOT_FOUND`.

Resolved `(owner → ownerType)` mappings live in a **process-lifetime in-memory map inside `project-view.ts`**. It is reset on module reload (i.e., HMR in dev rebuilds the map from zero). The per-process `parent`-field retry flag lives in the same module — both are plain `let` / `Map` module locals so HMR's "reload the module" behavior naturally re-probes both. This is intentional: we want HMR to re-test capability, not carry a stale "unsupported" flag into a fresh code path.

### New shared types

Prefer a `.ts` file (`src/shared/github-project-types.ts`) over `.d.ts` so the compiler checks references.

```ts
export type GitHubProjectViewLayout = 'TABLE_LAYOUT' | 'BOARD_LAYOUT' | 'ROADMAP_LAYOUT'
export type GitHubProjectOwnerType = 'organization' | 'user'

// Anything outside this union renders as an empty cell — never throw.
export type GitHubProjectFieldDataType =
  | 'TITLE' | 'ASSIGNEES' | 'LABELS' | 'LINKED_PULL_REQUESTS' | 'REVIEWERS'
  | 'REPOSITORY' | 'MILESTONE' | 'PARENT_ISSUE' | 'SUB_ISSUES_PROGRESS'
  | 'TRACKS' | 'TRACKED_BY' | 'ISSUE_TYPE' | 'TEXT' | 'NUMBER' | 'DATE'
  | 'SINGLE_SELECT' | 'ITERATION'

export type GitHubProjectSingleSelectOption = { id: string; name: string; color: string }

export type GitHubProjectIteration = {
  id: string
  title: string
  startDate: string // YYYY-MM-DD
  duration: number  // days
  completed: boolean
}

export type GitHubProjectField =
  | { kind: 'field';         id: string; name: string; dataType: Exclude<GitHubProjectFieldDataType, 'SINGLE_SELECT' | 'ITERATION'> | (string & {}) }
  | { kind: 'single-select'; id: string; name: string; dataType: 'SINGLE_SELECT'; options: GitHubProjectSingleSelectOption[] }
  | { kind: 'iteration';     id: string; name: string; dataType: 'ITERATION';     iterations: GitHubProjectIteration[] }

// Unknown `dataType` values are preserved verbatim for debuggability; the
// column renderer falls through to a value-kind-based generic cell per the
// column-dispatch rule.

export type GitHubProjectSortDirection = 'ASC' | 'DESC'
export type GitHubProjectSort = { direction: GitHubProjectSortDirection; field: GitHubProjectField }

export type GitHubProjectView = {
  id: string
  number: number
  name: string
  layout: GitHubProjectViewLayout
  filter: string // normalized to '' when GitHub returns null
  fields: GitHubProjectField[]
  groupByFields: GitHubProjectField[]
  sortByFields: GitHubProjectSort[]
}

export type GitHubProjectUser  = { login: string; name: string | null; avatarUrl: string | null }
export type GitHubProjectLabel = { name: string; color: string }
export type GitHubProjectParentIssue = { number: number; title: string; url: string }

export type GitHubProjectFieldValue =
  | { kind: 'single-select'; fieldId: string; optionId: string; name: string; color: string }
  | { kind: 'iteration';     fieldId: string; iterationId: string; title: string; startDate: string; duration: number }
  | { kind: 'text';          fieldId: string; text: string }
  | { kind: 'number';        fieldId: string; number: number }
  | { kind: 'date';          fieldId: string; date: string }
  | { kind: 'labels';        fieldId: string; labels: GitHubProjectLabel[] }
  | { kind: 'users';         fieldId: string; users: GitHubProjectUser[] }

export type GitHubProjectRow = {
  id: string
  itemType: 'ISSUE' | 'PULL_REQUEST' | 'DRAFT_ISSUE' | 'REDACTED'
  content: {
    number: number | null
    title: string
    body: string | null              // DraftIssue body and optional detail-cache patch target; list rows do not render issue/PR body.
    url: string | null
    state: string | null
    stateReason: string | null      // Issue stateReason; null for PR/draft. Why: closed-as-not-planned needs a different glyph.
    isDraft: boolean | null         // PullRequest.isDraft; null otherwise.
    repository: string | null       // nameWithOwner, e.g. 'stablyai/orca'
    assignees: GitHubProjectUser[]
    labels: GitHubProjectLabel[]
    parentIssue: GitHubProjectParentIssue | null
  }
  fieldValuesByFieldId: Record<string, GitHubProjectFieldValue>
  updatedAt: string
  position: number // original fetched order; final tie-break so equal sort values keep GitHub rank order
}

export type GitHubProjectTable = {
  project: {
    id: string
    owner: string
    ownerType: GitHubProjectOwnerType
    number: number
    title: string
    url: string
  }
  selectedView: GitHubProjectView
  rows: GitHubProjectRow[]
  totalCount: number            // echoes ProjectV2.items.totalCount for the view filter
  parentFieldDropped: boolean   // true when the `parent` retry fallback fired; UI can hint "sub-issues unavailable"
}

export type GitHubProjectSummary = {
  id: string
  owner: string
  ownerType: GitHubProjectOwnerType
  number: number
  title: string
  url: string
  source: 'viewer' | `org:${string}`
}

export type GitHubProjectViewSummary = {
  id: string
  number: number
  name: string
  layout: GitHubProjectViewLayout
}

export type GitHubProjectSettings = {
  pinned: Array<{ owner: string; ownerType: GitHubProjectOwnerType; number: number }>
  recent: Array<{ owner: string; ownerType: GitHubProjectOwnerType; number: number; lastOpenedAt: string }>
  lastViewByProject: Record<string, { viewId: string }>
  activeProject: { owner: string; ownerType: GitHubProjectOwnerType; number: number } | null
}
```

Note: `views: GitHubProjectView[]` is intentionally **not** part of the table envelope. v1 does not render a view switcher, so bundling every view's full config into every table fetch would be dead payload.

The new project types live in `src/shared/github-project-types.ts`. `src/preload/api-types.ts` must import them from that file directly; do not route them through `src/shared/types.ts` just to match the existing import block.

### IPC surface

Follow the same classified-error envelope as `ListWorkItemsResult<T>` in `src/shared/types.ts` — **do not throw across IPC for expected failures**. Handlers resolve with a discriminated union so the renderer can render a typed error banner.

```ts
// Classified failure modes the UI must distinguish.
export type GitHubProjectViewErrorType =
  | 'auth_required'       // gh not logged in
  | 'scope_missing'       // token lacks project, read:org, or repo access
  | 'not_found'           // project or view doesn't exist / user has no access
  | 'unsupported_layout'  // view is BOARD_LAYOUT or ROADMAP_LAYOUT
  | 'too_large'           // totalCount > 500; no rows returned
  | 'schema_drift'        // GraphQL shape we don't understand
  | 'validation_error'    // mutation input rejected by GitHub
  | 'network_error'
  | 'rate_limited'
  | 'unknown'

export type GitHubProjectViewError = {
  type: GitHubProjectViewErrorType
  message: string
  // Populated when the error is classifiable from a GraphQL response. Never
  // includes tokens or full command stdout.
  details?: { path?: Array<string | number>; code?: string }
}

export type GetProjectViewTableResult =
  | { ok: true;  data: GitHubProjectTable }
  | { ok: false; error: GitHubProjectViewError; totalCount?: number }
    // totalCount is populated for the 'too_large' case and best-effort for
    // unsupported_layout when a cheap count-only query succeeds.
```

IPC handlers (added to `src/main/ipc/github.ts`) are registered unconditionally, like the existing `gh:*` handlers. The renderer gates entry points; the main process should not conditionally register IPC from a mutable feature flag because enabling the flag at runtime would otherwise require an app restart.

```ts
gh:listAccessibleProjects(): Promise<
  | { ok: true;  projects: GitHubProjectSummary[] }
  | { ok: false; error: GitHubProjectViewError }
>

gh:resolveProjectRef(args: { input: string }): Promise<
  | { ok: true; owner: string; ownerType: GitHubProjectOwnerType; number: number; title: string }
  | { ok: false; error: GitHubProjectViewError }
>

gh:listProjectViews(args: {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
}): Promise<
  | { ok: true; views: GitHubProjectViewSummary[] }
  | { ok: false; error: GitHubProjectViewError }
>

// View selection precedence: viewId > viewNumber > viewName > first TABLE_LAYOUT view.
gh:getProjectViewTable(args: {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
  viewId?: string
  viewNumber?: number
  viewName?: string
}): Promise<GetProjectViewTableResult>

gh:projectWorkItemDetailsBySlug(args: {
  owner: string
  repo: string
  number: number
  type: 'issue' | 'pr'
}): Promise<
  | { ok: true; details: GitHubWorkItemDetails }
  | { ok: false; error: GitHubProjectViewError }
>
```

Mutation IPC uses the same envelope style:

```ts
export type GitHubProjectMutationResult =
  | { ok: true }
  | { ok: false; error: GitHubProjectViewError }

export type GitHubProjectCommentMutationResult =
  | { ok: true; comment: PRComment }
  | { ok: false; error: GitHubProjectViewError }

export type GitHubProjectFieldMutationValue =
  | { kind: 'single-select'; optionId: string }
  | { kind: 'iteration'; iterationId: string }
  | { kind: 'text'; text: string }
  | { kind: 'number'; number: number }
  | { kind: 'date'; date: string } // YYYY-MM-DD

gh:updateProjectItemField(args: {
  projectId: string
  itemId: string
  fieldId: string
  value: GitHubProjectFieldMutationValue
}): Promise<GitHubProjectMutationResult>

gh:clearProjectItemField(args: {
  projectId: string
  itemId: string
  fieldId: string
}): Promise<GitHubProjectMutationResult>

gh:updateIssueBySlug(args: {
  owner: string
  repo: string
  number: number
  updates: GitHubIssueUpdate
}): Promise<GitHubProjectMutationResult>

gh:updatePullRequestBySlug(args: {
  owner: string
  repo: string
  number: number
  updates: { title?: string; body?: string }
}): Promise<GitHubProjectMutationResult>

gh:addIssueCommentBySlug(args: {
  owner: string
  repo: string
  number: number
  body: string
}): Promise<GitHubProjectCommentMutationResult>

gh:updateIssueCommentBySlug(args: {
  owner: string
  repo: string
  commentId: number
  body: string
}): Promise<GitHubProjectMutationResult>

gh:deleteIssueCommentBySlug(args: {
  owner: string
  repo: string
  commentId: number
}): Promise<GitHubProjectMutationResult>

gh:listLabelsBySlug(args: {
  owner: string
  repo: string
}): Promise<
  | { ok: true; labels: string[] }
  | { ok: false; error: GitHubProjectViewError }
>

gh:listAssignableUsersBySlug(args: {
  owner: string
  repo: string
  seedLogins?: string[]
}): Promise<
  | { ok: true; users: GitHubAssignableUser[] }
  | { ok: false; error: GitHubProjectViewError }
>
```

Exposed through `src/preload/index.ts` and `src/preload/api-types.ts`.

`gh:getProjectViewTable` fetches view config **and** all item pages in one call (see "Pagination and Size Cap"). It validates unsupported layouts before row pagination, then performs a cheap count-only item query only when needed to populate `totalCount` for `unsupported_layout`; that count is best-effort because unsupported views should still render a useful recovery state if the count query fails. There is no split config/rows IPC — the cap + block-until-done policy makes splitting unnecessary and the single envelope keeps the renderer state trivial.

### Renderer state

Extend the GitHub store slice (`src/renderer/src/store/slices/github.ts`) with a **parallel, separately-declared** `ProjectViewCacheEntry<T>` that mirrors the work-items `CacheEntry<T>` pattern but not its type. Identical field names — `data`, `fetchedAt`, `error?: GitHubProjectViewError` — and nothing else: `sources` and `issueSourceFellBack` don't apply (project-view has a single GraphQL source, no issue/PR-source fallback). Why not generify `CacheEntry<T, E>`: the ceremony pays off only if both slices share error-handling code, and they don't (different error union, different classifier, different UI banners). Keep the shapes structurally similar, not identically typed.

```ts
type ProjectRowContentUpdate = {
  title?: string
  body?: string
  addLabels?: string[]
  removeLabels?: string[]
  addAssignees?: string[]
  removeAssignees?: string[]
}

projectViewCache: Record<string, ProjectViewCacheEntry<GitHubProjectTable>>
fetchProjectViewTable: (args: FetchProjectViewTableArgs, options?: FetchOptions) => Promise<GetProjectViewTableResult>
updateProjectFieldValue: (cacheKey: string, rowId: string, fieldId: string, value: GitHubProjectFieldMutationValue) => Promise<GitHubProjectMutationResult>
clearProjectFieldValue: (cacheKey: string, rowId: string, fieldId: string) => Promise<GitHubProjectMutationResult>
patchProjectIssueOrPr: (cacheKey: string, rowId: string, updates: ProjectRowContentUpdate) => Promise<GitHubProjectMutationResult>
```

Cache key — resolved view id only, no filter hash (v1 does not allow filter overrides):

```ts
`github-project:${ownerType}:${owner}:${projectNumber}:${resolvedViewId}`
```

The renderer cannot know `resolvedViewId` until the first successful IPC response when callers pass `viewNumber`, `viewName`, or no view selector. For those calls, use a request key based on the input args for in-flight dedup, then write the returned table under the resolved-view cache key. Subsequent refreshes should use `selectedView.id`.

**Inflight dedup + concurrency gate must mirror the work-items slice.** Add at module scope:

```ts
const inflightProjectViewRequests = new Map<string, { promise: Promise<GetProjectViewTableResult>; force: boolean }>()
// Reuse acquireWorkItemSlot / releaseWorkItemSlot / WORK_ITEM_FETCH_CONCURRENCY
// from the same module — the gate is about gh-subprocess pressure, and a
// ProjectV2 fetch is just as fan-outable as a work-item list.
```

Why reuse the gate instead of adding a parallel one: the concurrency limit exists to bound `gh` subprocess pressure at the renderer boundary. Two independent gates would let concurrent project-view fetches blow past the intended cap when a user also hover-prefetches work items on the same page.

Dedup semantics must match the work-items slice exactly: non-forcing callers collapse onto any in-flight request; a user-initiated `force: true` refresh waits for an in-flight non-forcing request to settle, then issues a new forced fetch. See `fetchWorkItems` for the reference implementation.

Mutation actions patch `projectViewCache[cacheKey]` optimistically and never render directly from the mutation return value. They must capture the previous row before patching, call the relevant IPC helper, and restore that row if the mutation fails. If the cache entry has moved or no longer contains the row by the time the response returns, skip rollback rather than resurrecting stale data into a newly selected project.

**Concurrency tuning (post-launch).** `WORK_ITEM_FETCH_CONCURRENCY` is now shared across work-items and project-view traffic. A project-view fetch is a multi-page fan-out of `gh` subprocesses, and under the same user-visible gate it can starve an opportunistic work-items prefetch (or vice versa). This is acceptable for v1 — correctness of the subprocess cap outweighs throughput — but revisit the split if users report Project mode stalling Issues/PRs refresh.

**Argument types.** `FetchProjectViewTableArgs` matches the `gh:getProjectViewTable` IPC args type exactly: `{ owner; ownerType; projectNumber; viewId?; viewNumber?; viewName? }`. `FetchOptions` is the existing type declared at module scope in `src/renderer/src/store/slices/github.ts` (used by `fetchWorkItems`); the project-view action reuses it verbatim — do not fork.

## UI Design

### Placement

Inside the existing GitHub source, add a mode toggle: `Issues/PRs` (default) · `Project`.

**Gate the toggle's visibility.** Do not render the `Project` toggle at all unless:

- `settings.githubProjects.activeProject` is non-null (user has opened a project at least once), **or**
- `settings.experimentalGithubProjectView` is on.

Why: without a picked project, the Project tab is a dead-end empty state. Hiding the toggle until the user has committed to a project keeps the Issues/PRs flow uncluttered for users who never touch Projects.

### Header

Project mode header, from left to right:

1. **Project picker button** — `stablyai / Stably Product Board ▾`. Clicking opens the picker popover (see Project Selection).
2. **Selected view label** — a plain read-only chip: `View: Me`. Not a tab strip, not a dropdown. v1 does not switch views; to change view the user re-picks from the picker.
3. **Filter label** — read-only display of the view's `filter` string, e.g. `assignee:@me is:open no:triage-group`. Small muted text, truncated with tooltip on overflow. No input, no editing, no token chips.
4. **Count pill** — `totalCount` from the fully paginated result.
5. **Open in GitHub** — external-link icon button to the selected view URL.

GitHub's `ProjectV2View` schema does not expose a view URL directly. Build it as `${project.url}/views/${selectedView.number}` everywhere the UI needs to open or recover to the selected view. Use `project.url` only as a fallback if `selectedView.number` is missing due to schema drift handling. Why: opening the project default view would break the core "open the Project view I already use" workflow whenever the selected view is not the default.

No View menu. No column visibility control. No `Fields` / `Group by` / `Sort by` / `Field sum` / `Slice by` / `Show hierarchy` / `Show agent sessions` controls. Those were considered in Phase A and cut as part of direction **A1** — the view's GitHub-owned configuration is authoritative.

### Grouped row list

Components live under `src/renderer/src/components/github-project/`:

```text
ProjectViewList.tsx       // grouped row container, header, empty/error states
ProjectGroupHeader.tsx    // expand/collapse, label, count, iteration date range
ProjectRow.tsx            // single item row, primary/secondary actions
ProjectCell.tsx           // one cell per visible column, dataType-driven
```

Only `TABLE_LAYOUT` views render as rows. `BOARD_LAYOUT` / `ROADMAP_LAYOUT` surface `unsupported_layout` (see Interaction States).

Visible columns are derived from `selectedView.fields`:

| Data type | Cell source |
|---|---|
| `TITLE` | `row.content.title` + number + state glyph (issue: `state` + `stateReason` for closed-as-not-planned; PR: `state` + `isDraft`) |
| `ASSIGNEES` (built-in) | `row.content.assignees` — editable users pill list for issue/PR rows |
| `LABELS` (built-in) | `row.content.labels` — labels pill list; edited in the dialog |
| Custom user field (value arrives as `ProjectV2ItemFieldUserValue`) | `fieldValuesByFieldId[field.id]` as `kind: 'users'` — render as users pill list. Why: the ProjectV2 GraphQL `dataType` enum does not expose a distinct custom-user-field member, so the column renderer dispatches on the *value* `kind`, not `field.dataType`. |
| Custom label field (value arrives as `ProjectV2ItemFieldLabelValue`) | `fieldValuesByFieldId[field.id]` as `kind: 'labels'` — render as labels pill list. Same reason as above. |
| `REPOSITORY` | `row.content.repository` |
| `PARENT_ISSUE` | `row.content.parentIssue`; empty when `parentFieldDropped` |
| `SINGLE_SELECT` | `fieldValuesByFieldId[field.id]` |
| `ITERATION` | `fieldValuesByFieldId[field.id]` |
| `TEXT` / `NUMBER` / `DATE` | corresponding field value |
| `LINKED_PULL_REQUESTS`, `REVIEWERS`, `MILESTONE`, `ISSUE_TYPE`, `SUB_ISSUES_PROGRESS`, `TRACKS`, `TRACKED_BY` | Empty cell in v1 |
| Unknown dataType | If `fieldValuesByFieldId[field.id]` is present, fall through to a kind-based generic renderer (labels / users / text / number / date / single-select / iteration) so a fetched value is never silently dropped. Otherwise empty cell — the normalizer **must never throw** on unknown `__typename`. |

`ASSIGNEES` and `LABELS` are the **only** built-in multi-value dataTypes v1 recognizes. Custom multi-value fields render strictly through the value-kind fallback above — the column renderer dispatches on `field.dataType` first, then on `fieldValuesByFieldId[field.id].kind` as a safety net so the renderer never silently drops a fetched value.

`REDACTED` Project items render as disabled rows when GitHub returns `type: REDACTED` or `content: null` because the token cannot see the underlying issue/PR. Use title copy `Restricted item`, leave repo/number/url/actions empty, keep field values if GitHub returned any, and include the row in group counts. Why: dropping redacted rows would make Orca's rendered count disagree with GitHub's view and make the grouped plan look incomplete without explanation.

#### Inline field editing

Only editable ProjectV2 field-value columns enter edit mode inline: `SINGLE_SELECT`, `ITERATION`, `TEXT`, `NUMBER`, and `DATE`. Built-in `ASSIGNEES` is also editable inline for issue/PR rows because ownership changes are a core planning action, but it must route through issue/PR assignee APIs, not `updateProjectV2ItemFieldValue`. Built-in title, repository, labels, parent issue, linked PRs, reviewers, milestone, issue type, sub-issues progress, tracks, and tracked-by cells are read-only in the list. Title/body/labels/assignees/comment editing also happens in `GitHubItemDialog`, where the existing full-detail context already exists.

Inline editors:

- Single-select: popover list in field option order, plus `Clear`.
- Iteration: popover grouped as completed/current/future in field configuration order, plus `Clear`.
- Text: compact input committed on Enter/blur and canceled on Escape.
- Number: numeric input; invalid or empty input shows local validation. Empty maps to `clearProjectV2ItemFieldValue`, not `number: 0`.
- Date: native date input where available; empty maps to clear.

Optimistic updates must preserve the current group/sort semantics. After a successful or optimistic field change, the row is re-grouped and re-sorted from the cached table data, so changing `Sprint`, `Priority`, or `Size` immediately moves the row to the same location GitHub would show after refresh. If the write fails, rollback restores the previous row and the previous sorted/grouped position.

#### Grouping

Use `selectedView.groupByFields[0]` (first entry only; GitHub UI treats subsequent groupByFields as tie-break, which isn't needed for rendering). The `Me` view groups by `Sprint`.

Group header order:

1. Iteration field: use `configuration` order — completed oldest-to-newest, then current, then future iterations (matches GitHub's natural ordering).
2. Single-select field: use option order as declared on the field.
3. Otherwise: alphabetical by label.
4. Empty groups always last (`No Sprint`, `No Priority`, etc.).

Header shows: expand/collapse chevron · label · count pill. For iterations, also: date range and a `Current` pill when today falls inside `[startDate, startDate + duration)`.

#### Sorting

Apply `selectedView.sortByFields` client-side. GitHub's `ProjectV2.items(orderBy:)` only supports `POSITION`, so field sorting has to happen in the renderer. Because v1 blocks rendering until all pages are loaded (see Pagination), sort results are globally correct — no "provisional sort while loading" UX is needed.

Semantics:

- Single-select: option order.
- Iteration: iteration order.
- Number / text / date: numeric / string / chronological comparison.
- `ASSIGNEES` / custom user field: sort by the first user's `login` alphabetically. Empty → sort last. Why: GitHub's own Project view effectively uses "first user" ordering; matching it avoids surprising reshuffles.
- `LABELS` / custom label field: sort by the first label's `name` alphabetically. Empty → sort last. Same rationale.
- Missing values sort last.
- Stable final tie-break by `row.position`, the original order returned by GitHub before client-side sort. Why: GitHub uses project rank/position to order rows with equal sort-field values; falling back to issue number/title would reshuffle ties and break exact view mirroring. Only use item number then title if a test fixture or malformed row lacks `position`.
- Any sort-field `kind` not in this table → ignore that sort field, continue to the next configured sort field, and emit a one-time `console.warn` gated on `process.env.NODE_ENV !== 'production'`. If every configured sort field is unknown, preserve `row.position`. Never surface to the user. Why: unknown kinds mean a renderer/comparator drift, not a user-visible defect — we want a dev-time signal without reshuffling away from GitHub rank order.

The comparator is a contract and must be covered by fixtures captured from `stablyai/3` before the feature flag flips on by default. If GitHub's UI orders a supported data type differently from the rules above, update the comparator and the documented rule together; do not special-case the `Me` view by field name.

#### Row actions

- **Primary (click row title)**: open Orca's existing GitHub work-item details dialog for issue/PR rows. If `row.content.repository` matches a registered repo slug, the dialog may fetch details through the matched `repo.path` so existing PR files/checks surfaces keep working. If the repo is not registered, the dialog uses `gh:projectWorkItemDetailsBySlug` and renders the conversation/details surface only; Files/checks/review-thread tabs are hidden because they still depend on local repo context in v1. In both paths, the dialog receives row-origin metadata so writes use slug-addressed mutations. For `DRAFT_ISSUE` rows (no repo, no number) the title is non-interactive and shows `row.content.body` in a hover card.
- **Secondary — open in browser**: icon action on hover; opens `row.content.url`.
- **Secondary — start work**: icon action on hover; creates a worktree linked to this issue/PR (same flow as the existing `Use` action in Issues/PRs mode).
- **Fallback — repo not added to Orca**: if `row.content.repository` is not in `state.repos`, the dialog's Start work CTA and the hover Start work action open a lightweight prompt: *"`owner/repo` isn't added to Orca. Add it to start work, or open in GitHub."* with `Add repo` and `Open in GitHub` buttons. Why not auto-add: adding a repo is a clone + worktree decision the user owns; silently cloning from a row click is surprising.

`state.repos` does not persist `owner/repo`, so Project rows need a small renderer-side repo slug index before repo-context actions can work. Build it from existing registered repos using `window.api.gh.repoSlug({ repoPath })`, cache it by `repo.id`, and match `row.content.repository` against `${owner}/${repo}`. If slug resolution fails for a repo, exclude that repo from the index and keep the unknown-repo fallback. When a match exists, the resolved `repo.id` is stamped onto a `GitHubWorkItem`-compatible object before opening `GitHubItemDialog` or calling `launchWorkItemDirect`. When no match exists, the dialog still opens from slug-backed details but Start work stays blocked behind the add-repo prompt. Do **not** fabricate a `repoId` for unknown-repo rows; extend `GitHubItemDialog` to accept a Project-origin item shape where `repoId`/`repoPath` are optional and `owner`/`repo` are required. Project field edits and inline built-in assignee edits do **not** require the repo to be registered because they address GitHub by `projectId`/`itemId` or row slug.

Draft issues and redacted items never start work directly in v1 because they have no repo/number. Draft titles are non-interactive and show the draft body in a hover card; redacted rows show no local action.

#### Dialog editing from Project rows

Project mode opens the existing `GitHubItemDialog`, but it supplies a row-origin context: `owner`, `repo`, `number`, `itemType`, `projectId`, `projectItemId`, the active table `cacheKey`, and the optional matched `repoPath`/`repoId`. That context lets the dialog choose slug-addressed read/write IPC when it has no local repo path, and slug-addressed mutation IPC even when a repo path exists. Without it, a Project row from a repo that is not the active local workspace could edit the wrong issue number.

Dialog-only edits:

- Issue title/body: `gh:updateIssueBySlug`.
- PR title/body: `gh:updatePullRequestBySlug`.
- Labels/assignees: slug-addressed issue mutation for issues; PR label/assignee edits also use issue endpoints because GitHub PRs are issues for labels/assignees.
- Label and assignee pickers: `gh:listLabelsBySlug` / `gh:listAssignableUsersBySlug`, not the repoPath-based picker loaders. Reads may use local repo context for PR files/checks when a match exists, but picker option sources must stay slug-addressed for consistency with the write target.
- Comments: create/edit/delete via issue-comment endpoints. Existing PR review-thread reply controls remain available only on PR details loaded through the current PR comment surface; editing/deleting review comments is out of Project mode scope.

The dialog patches both its local detail state and the Project table cache when a row-origin context is present. A successful title edit updates `row.content.title`; successful labels/assignees update both `row.content.*` and matching built-in field cells if those columns are visible. Issue/PR body and comment edits do not change list rows unless a future row column depends on them; draft issue bodies live in `row.content.body` only for the draft hover card and are read-only in v1.

## Project Selection

The picker is **in v1**, not a follow-up. It is the only way to switch projects, so it has to land alongside Project mode.

### Picker UX

Clicking the project picker button opens a popover:

- Search input (filters by title, owner, or number substring).
- **Pinned projects** — user-favorited, local, persisted.
- **Recent projects** — last 10 opened, MRU order.
- **Browse all** — lazily loads projects owned by the viewer and projects owned by their orgs (paginated, cached 5 minutes).
- **Add by URL or `owner/number`** — text input at the bottom.

Selecting a project row does not immediately lock the view unless Orca already has `lastViewByProject[key].viewId`. If no last view exists, the picker opens a second lightweight step listing that project's `TABLE_LAYOUT` views by name, plus disabled rows for unsupported Board/Roadmap views. Choosing a view closes the picker and fetches that table. This is still not a header view switcher: the choice lives in the picker because v1 needs exactly one selected view, but the user must be able to choose `Me` without depending on GitHub's first-view order.

Dedup rules across sections (a project must appear in at most one list):

- Pinned renders first, as-is.
- Recent filters out anything already in Pinned.
- Browse-all filters out anything in Pinned or Recent.

Why: a project showing up twice in the picker is confusing and makes pin/unpin state ambiguous.

**Pin-before-open.** Pins are only creatable from a project that has been successfully opened at least once (i.e., has an entry in `lastViewByProject`); paste-to-add attempts that fail classification or unused browse rows cannot create a pin.

**Zombie pins.** A pinned project key may fail to appear in `listAccessibleProjects` (lost access, project archived/deleted, transient auth) or resolve `not_found` when clicked. Pins are **not auto-removed** — silently dropping a pin loses user intent. Instead, render the pin row with a warning icon and an inline `Remove pin` affordance; clicking it is the only path that mutates `settings.githubProjects.pinned`.

**Auth/scope errors in the picker.** When `gh:listAccessibleProjects` resolves `{ ok: false, error: { type: 'auth_required' | 'scope_missing' | ... } }`, the picker renders an inline banner with the same copy and `Copy command` affordance as the table-level `error-auth` / `error-scope` states. Pinned projects still render (they come from settings, not the network) so the user can retry a known-good pin once auth is fixed.

Selecting a project:

1. Resolves owner + ownerType + number (via `gh:resolveProjectRef` for paste inputs, direct for list clicks).
2. Resolves the selected view (URL `viewNumber`, existing `lastViewByProject[key].viewId`, or explicit choice from the picker view step).
3. Renders the table (or an Interaction State — see next section).
4. Adds the project to MRU, updates `activeProject`, and writes `lastViewByProject[key].viewId`.

### Discovery query

The query shape is:

```graphql
query {
  viewer {
    login
    projectsV2(first: 50) { nodes { id number title url owner { ... on Organization { login } ... on User { login } } } }
    organizations(first: 30) {
      nodes {
        login
        projectsV2(first: 50) { nodes { id number title url } }
      }
    }
  }
}
```

Production discovery paginates `viewer.projectsV2`, `viewer.organizations`, and each organization's `projectsV2`. Cap at 50 orgs and 100 projects per owner for v1; if the org cap is hit, render a small "Some organizations are not shown" footer in Browse all rather than claiming exhaustive results.

### Paste-to-add parser

Accepts:

- `https://github.com/orgs/{owner}/projects/{n}`
- `https://github.com/users/{owner}/projects/{n}`
- `https://github.com/orgs/{owner}/projects/{n}/views/{viewNumber}`
- `https://github.com/users/{owner}/projects/{n}/views/{viewNumber}`
- `owner/number` shorthand (e.g. `stablyai/3`)

Parsed locally, then confirmed with a project fetch. URLs with `/views/{viewNumber}` seed `viewNumber` directly; bare project URLs and `owner/number` use `lastViewByProject[key].viewId` if present, otherwise open the view-pick step. Failure surfaces the standard `not_found` Interaction State.

### Persistence

Stored through the existing settings IPC:

```ts
settings.githubProjects = {
  pinned: Array<{ owner: string; ownerType: GitHubProjectOwnerType; number: number }>            // cap 20
  recent: Array<{ owner: string; ownerType: GitHubProjectOwnerType; number: number; lastOpenedAt: string }> // cap 10, MRU
  lastViewByProject: Record<string, { viewId: string }>   // keyed by `${ownerType}:${owner}:${number}`
  activeProject: { owner: string; ownerType: GitHubProjectOwnerType; number: number } | null
}
```

Dedup key: `${ownerType}:${owner}:${number}`.

`settings.githubProjects` must be written as a complete object unless this feature also adds an explicit deep-merge path for that field in both `Store.updateSettings()` and the renderer settings slice. The existing settings update path deep-merges only `notifications` and `telemetry`; partial writes such as `{ githubProjects: { pinned } }` would otherwise clobber `recent`, `lastViewByProject`, and `activeProject`. Picker code should therefore read the current `settings.githubProjects`, apply the local mutation, enforce caps/dedup, and call `updateSettings({ githubProjects: nextGithubProjects })`.

### Settings defaults and migration

Defaults for upgraded installs (the key is absent on any profile created before this feature):

- `settings.githubProjects` defaults to `{ pinned: [], recent: [], lastViewByProject: {}, activeProject: null }`.
- `settings.experimentalGithubProjectView` defaults to `false`.

Defaults are applied by the existing `{ ...defaults.settings, ...parsed.settings }` merge in `src/main/persistence.ts`. Add the `githubProjects` default to `getDefaultSettings()` so upgraded installs hydrate it automatically. No one-shot `_githubProjectsInitialized` flag is needed unless a later migration mutates non-empty user data; this rollout only supplies a missing default.

Toggle-gating in the renderer reads:

```ts
settings?.githubProjects?.activeProject != null ||
  settings?.experimentalGithubProjectView === true
```

Use the repo's existing flat experimental settings pattern. Add `experimentalGithubProjectView: boolean` to `GlobalSettings` and `getDefaultSettings()`, not a nested `settings.experimental` object.

Optional-chaining is required on both `settings` and `githubProjects`: renderer state initializes `settings` as `null`, and tests/upgraded sessions can briefly observe missing nested settings before hydration. Reading `.activeProject` off `undefined` would throw and blank the Tasks page.

### First-run

When `activeProject` is null, Project mode renders a "Choose a project" CTA that opens the picker — no auto-selection. Fresh installs should not surface unrelated project content. (And per the toggle-gating rule above, the user won't even see the Project mode toggle until they've picked at least once or flipped the experimental flag.)

## Interaction States

One consolidated table. All states render inside the Project mode body; placement and recovery below.

| State | Trigger | Copy | Placement | Recovery |
|---|---|---|---|---|
| `loading` | Fetch in flight | Skeleton rows + "Loading project view…" | Replace list | — |
| `empty` | Fetch OK, 0 rows | "No items match this view's filter." | Replace list | `Open in GitHub` link |
| `error-auth` (`auth_required`) | `gh` not logged in | "Sign in to GitHub to load project tasks. Run `gh auth login`." | Banner above list | `Copy command` button |
| `error-scope` (`scope_missing`) | Token lacks `project`, `read:org`, or `repo` for private repo-backed items | "GitHub project access needs additional scopes. Run `gh auth refresh -s project -s read:org -s repo`." | Banner above list | `Copy command` button |
| `error-notfound` (`not_found`) | Project or view missing | "Could not find `{owner}/{number}`." or "Could not find the selected view." | Replace list | `Choose another project` (opens picker) |
| `error-drift` (`schema_drift`) | Required envelope field missing/null on success (see Error Handling), **including** null/undefined `items.totalCount` | "Could not read this project view." | Replace list | `Open in GitHub`, `Copy error details` |
| `too-large-for-v1` (`too_large`) | `totalCount > 500` | "This view has {N} items — too large to render in Orca. Narrow the view's filter on GitHub." | Replace list | `Open in GitHub` (links to selected view URL) |
| `unsupported-layout` | `view.layout !== 'TABLE_LAYOUT'` | "Orca only renders table views yet. This is a {Board/Roadmap} view." | Replace list | `Open in GitHub` |
| `repo-not-in-orca` | User tries to start work from a row whose repo isn't registered | "`{repo}` isn't added to Orca. Add it to start work, or open in GitHub." | Modal prompt | `Add repo`, `Open in GitHub`, `Cancel` |
| `parent-dropped` | `parentFieldDropped === true` after retry fallback | "Sub-issue data is unavailable for your token." | Dismissable toast, once per session | — |
| `mutation-failed` | Field, title/body, labels/assignees, or comment write returns `{ ok: false }` | Error-specific message from the classified envelope | Toast near the edited surface | Roll back optimistic patch; keep editor open when possible |

**"Banner above list" vs "Replace list"**: auth/scope errors keep any previously cached rows visible so a transient auth hiccup doesn't blank the screen. Structural errors (not-found, drift, oversize, unsupported-layout) replace the list — rendering stale rows under a new picked project would lie about what the user is looking at.

## Pagination and Size Cap

**v1 blocks render until the view is fully paginated.** No progressive/provisional row display.

Why: GitHub's `ProjectV2.items(orderBy:)` only supports `POSITION`, so client-side sort and grouping are only globally correct once every page is loaded. Phase A considered the "provisional sort while loading" alternative and rejected it — group headers jumping and rows reshuffling mid-scroll is worse than a loading skeleton.

Policy:

1. First page request returns `totalCount`.
2. **If `totalCount > 500`**: abort pagination, do not return rows, resolve IPC as `{ ok: false, error: { type: 'too_large' }, totalCount }`. Renderer shows the `too-large-for-v1` state. Copy tells the user to narrow the view's filter on GitHub. Why 500: well above typical personal views (the `Me` prototype view has 300 items) and comfortably under a threshold where a single synchronous render would stall the UI thread.
3. **If `totalCount <= 500`**: paginate sequentially (`first: 100`, follow `pageInfo.endCursor`) until `hasNextPage === false`, then resolve with the full table.
4. **No background auto-pagination** after an initial partial render — the initial render doesn't happen until pagination is complete.

Page size is a main-process implementation detail (`100`), not exposed across IPC. Cache entries hold the complete row set. Grouping and sorting are deterministic renderer/shared logic derived from `selectedView`; they should not depend on fetch completion order.

## Error Handling

Every failure classifies into `GitHubProjectViewErrorType` and resolves through `GetProjectViewTableResult`. The main process **does not throw across IPC** for expected failures — matches the `ListWorkItemsResult` convention so renderer error handling stays uniform.

**`schema_drift` trigger rule.** `schema_drift` fires **only** when a successful GraphQL response is missing/null on a required envelope field. The explicit list: `items.totalCount`, `items.pageInfo.hasNextPage`, `items.nodes`, `view.id`, `view.layout`, and `items.pageInfo.endCursor` only when `hasNextPage === true`. `endCursor` may legitimately be null on empty or final pages, so treating it as always-required would turn valid empty views into drift errors. Unknown `__typename` on a `fieldValues` node, unknown `dataType` on a field, and redacted Project items are **not** drift — those render through the fallback/disabled-row rules above. Why: we reserve `schema_drift` for cases where the response is structurally unusable; gracefully ignoring unknown union members is a forward-compat feature, not an error.

Special case: if `items.totalCount` is null/undefined on an otherwise-successful response, classify as `schema_drift` — not `too_large`, not `empty`. Why: `too_large` needs a real count to show ("N items — too large"), and `empty` would lie about what happened.

On GraphQL drift, the main process logs `path`, `type`, and `extensions.code` to the main log. It **never** logs the token, and never logs raw command stdout that might embed one. The `error-drift` state surfaces a `Copy error details` affordance populated from the structured `details` field so users can paste into a bug report.

## SSH and Cross-Platform Notes

- Continue invoking `gh` from the main process with a repo-aware `cwd` when a repo context exists. Org-level ProjectV2 calls don't need a local repo path, but subprocess invocation must still work when the active workspace is SSH-backed.
- Build `gh` argv as arrays; pass the GraphQL query as an argument. Match existing `execFile` patterns — no shell-specific quoting.
- Use `path` utilities for any local files introduced for query fixtures or tests.
- Platform shortcut labels follow existing rules if shortcuts are added later.

## Testing Plan

### Unit tests — `src/main/github/project-view.test.ts`

- View config normalization for `ProjectV2Field`, `ProjectV2SingleSelectField`, `ProjectV2IterationField`.
- Item normalization for issues, PRs, draft issues, and redacted/null-content items.
- Field values keyed by `field.id`.
- `parent`-field retry — three explicit cases, each must trigger the retry-without-`parent` path and set `parentFieldDropped: true` on the result:
  (a) GraphQL error `type: FIELD_NOT_FOUND` on path ending in `parent`.
  (b) GraphQL error `type: UNDEFINED_FIELD` on path ending in `parent`.
  (c) `preview` header error from the `gh` subprocess stderr (Issue.parent behind a preview gate).
- `parent` fallback retries the whole table, not only the failing page, so no result mixes parent data with dropped-parent rows.
- Oversize guard: mocked `totalCount: 501` returns `too_large` without fetching pages.
- Error classification: auth, scope, not-found, drift, rate-limited.
- Null `view.filter` normalizes to `''` and still fetches unfiltered items.
- Null `items.pageInfo.endCursor` is accepted when `hasNextPage === false` and classified as `schema_drift` only when `hasNextPage === true`.
- View/field pagination does not silently truncate `views` or `fields`.
- `item.fieldValues.pageInfo.hasNextPage === true` returns `schema_drift`.
- `updateProjectItemFieldValue` sends the correct GraphQL value shape for single-select, iteration, text, number, and date, and `clearProjectItemFieldValue` clears the same field ids.
- Slug-addressed issue/PR mutations use the row's `owner/repo` and never call `getIssueOwnerRepo(repoPath)`.
- Slug-addressed details fetch returns body/comments/labels/assignees/participants for issue and PR rows without requiring a registered local repo, and omits PR files/checks/review-thread data in that mode.
- Issue/PR body edits use REST PATCH endpoints and classify validation/scope/not-found failures.
- Issue comment create/edit/delete helpers work for both issue rows and PR rows because both use GitHub issue comments.
- Slug-addressed label and assignable-user lookups use `repos/{owner}/{repo}` APIs and never call repoPath-based issue-source resolution.
- Draft issues normalize `body` into `row.content.body`; issue/PR rows set it to `null` unless populated by a later detail patch.

### Renderer/shared tests — `src/renderer/src/components/github-project/*.test.tsx` or a focused shared helper test

- Group key generation for iteration, single-select, assignees, text, empty.
- Sort comparator using single-select option order and iteration order.
- Equal sort-field values preserve `row.position`; malformed rows without `position` fall back to item number then title.
- Repo slug index maps `row.content.repository` to the correct registered `repo.id`; unresolved repos take the `repo-not-in-orca` path only when Start work is invoked.
- Unknown-repo title clicks still open `GitHubItemDialog` with slug-backed conversation details; only Start work is blocked by `repo-not-in-orca`.
- Unknown-repo dialog context does not fabricate `GitHubWorkItem.repoId`; components branch on Project-origin context for slug-backed reads and disabled Start work.
- Inline field editors call update vs clear correctly and re-run grouping/sorting after optimistic patches.
- Inline assignee edits call slug-addressed issue mutation APIs and patch `row.content.assignees`.
- Dialog edits from Project rows call slug-addressed mutation APIs and patch the Project table cache when title, labels, or assignees change.
- Dialog label/assignee pickers call slug-addressed lookup APIs when row-origin context is present.

### Store tests — `src/renderer/src/store/slices/github.test.ts`

- `projectViewCache` writes use `ProjectViewCacheEntry<T>` (same field names as `CacheEntry<T>`, distinct type, `error` typed as `GitHubProjectViewError`).
- Inflight dedup via `inflightProjectViewRequests`: concurrent non-forcing calls share a promise; a forcing call waits for an in-flight non-forcing call to settle, then issues a new fetch.
- Concurrency gate: a project-view fetch and a work-items fetch both consume slots from the shared gate.
- A failed fetch stores a typed `error` without breaking existing work-item cache entries.
- A failed mutation rolls back only the affected cached row and does not resurrect stale rows after a rapid project switch.
- `githubProjects` settings updates write the full nested object, or the settings layer deep-merges it, so updating pins cannot clobber recent/activeProject/lastViewByProject.
- **Render-from-cache invariant**: renderer components must read rows reactively from `projectViewCache[key]`, never from the awaited return value of `fetchProjectViewTable`. Add a test: a rapid project switch (A → B) while the A fetch is still in flight must not render A's rows after B's cache entry is populated. Why: awaiting the returned promise and rendering its payload directly would race — the in-flight A resolves after B and paints stale rows.

### E2E — `tests/e2e/tasks-page.spec.ts` (or a focused `project-view.spec.ts`)

- Open Tasks → GitHub source → Project mode gated off for fresh install.
- Enable experimental flag → Project mode visible → picker opens → paste `stablyai/3` → choose `Me` in the picker view step → view renders with `Sprint` groups.
- Oversize state renders with `Open in GitHub` when `totalCount > 500`.
- Click row title with known repo → work-item dialog opens with repo-backed details. Click row title with unknown repo → work-item dialog opens with slug-backed conversation details; clicking Start work shows the `repo-not-in-orca` prompt.
- Edit a single-select field inline → row optimistically moves according to the configured group/sort, mocked mutation succeeds, and cache keeps the new value.
- Edit assignees inline → mocked slug-addressed issue mutation succeeds and the row's assignee cell updates.
- Edit a field with a mocked mutation failure → toast renders and the row returns to its original value and position.
- From a Project row dialog, edit title/body and add/edit/delete an issue comment through slug-addressed mocks.

Mock `gh api graphql` in E2E. The live `stablyai/3` project is a manual smoke, not a CI dependency.

## Rollout Plan

Fewer steps than the original plan — dropping view tabs, filter editing, column management, and the View menu collapses most of the former middle phases.

1. Land `project-view.ts` with normalization, view/field pagination, `parent`-field retry, oversize guard, ProjectV2 field mutation helpers, and unit tests. Add slug-addressed issue/PR/comment mutation helpers plus label/assignable-user lookups. Wire IPC + preload unconditionally; gate only the renderer entry point behind `settings.experimentalGithubProjectView` (default `false`) or an existing `activeProject`.
2. Add renderer slice (`projectViewCache`, `fetchProjectViewTable`, mutation actions, inflight dedup) with store tests. Add the Project mode toggle, gated on the flag or `activeProject`.
3. Build the picker (pinned / recent / browse / paste-to-add) + persistence.
4. Build `ProjectViewList` / `ProjectGroupHeader` / `ProjectRow` / `ProjectCell` + interaction-state rendering, including inline editors for editable Project fields.
5. Wire row actions into existing work-item dialog and worktree-start flow. Add row-origin context to the dialog so unknown-repo rows can read conversation details by slug, and title/body, labels/assignees, and comments use slug-addressed mutations and patch the Project table cache.
6. Manual QA against `stablyai/3` `Me` view. Flip the experimental flag on by default.

## Open Questions

1. **Should header-level view switching land in v2?** v1 can choose a view from the picker, but there is no persistent tab strip or header dropdown for rapid view changes. Deferred because always-visible switching doubles the state space (active project × active view) and complicates "block until fully paginated" when users rapidly switch. Revisit after usage data shows how often users want to swap views without swapping projects.
2. **Should filter editing land in v2?** Currently the view's GitHub filter is authoritative. Adding a local filter override re-introduces the "viewFilter / draftFilter / appliedFilter" tri-state the original design considered and the stale-filter surprise ("Orca looks like Me but is actually using my old local query") that motivated dropping it. If we do add it, the local override must be ephemeral (not persisted) and visibly distinct from the view's filter.
3. **How does "Show agent sessions" interact with project rows when implemented?** Leaning toward: a per-row indicator sourced from Orca's local session store, keyed on repo + issue number, rendered as a leading badge on the title cell. Does not touch the GraphQL query. Needs its own design pass.
4. **Board-layout vertical grouping.** If/when a Board-layout renderer is added, restore `verticalGroupByFields` to the query and type.
5. **Should v2 support Project item creation and rank/position editing?** v1 edits existing row values but does not create Project items, reorder rows, or change view configuration. Those require different UX and mutation semantics from field-value edits because they can change the underlying plan shape for everyone using the GitHub Project.
6. **Does 500 hold up?** The `Me` view returns 300. If multi-repo engineering views regularly exceed 500, we need either a higher cap with a deferred-sort path or a follow-up "first N then paginate on demand" mode. Instrument the `too_large` state frequency before tuning.
