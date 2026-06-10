# File Search Match Counts

## Problem

Issue #5072 reports that content search can find files for a query like `reportError(` while file result badges show `0`, making match navigation unreliable. The search UI currently renders each file badge from `fileResult.matches.length` in `src/renderer/src/components/right-sidebar/SearchResultItems.tsx:98`, while the shared result type has no explicit per-file total in `src/shared/types.ts:2984`.

The shared search parser already tracks global accepted matches in `totalMatches` in `src/shared/text-search.ts:25` and filters impossible empty file rows in `src/shared/text-search.ts:486`, but the file-level count contract is implicit. Local main-process search, runtime search, runtime RPC, and SSH relay search all return the same `SearchResult` shape through `src/main/ipc/filesystem.ts:647`, `src/main/runtime/orca-runtime-files.ts:642`, `src/main/runtime/rpc/methods/files.ts:253`, and `src/relay/fs-handler.ts:237`.

## Root Cause

The result contract has no explicit file count, so every consumer infers the badge from preview rows (`matches[]`). That is fragile once producers, relays, or future preview limiting can distinguish "how many accepted matches this file has" from "which rows are rendered for navigation". It also leaves no defensive place to repair legacy or malformed payloads where a file contains match rows but a count is omitted or incorrectly `0`.

## Non-goals

- Do not replace ripgrep or git-grep search.
- Do not raise global or per-file result caps.
- Do not redesign the search sidebar layout.
- Do not add provider-specific behavior for GitHub, GitLab, or any git forge.
- Do not mutate files or user search state during validation.

## Design

1. Add `matchCount?: number` to `SearchFileResult`.
   - Treat it as the authoritative per-file accepted-match count for display after normalization.
   - Keep `matches[]` as the navigable preview rows.
   - Preserve runtime/relay compatibility by allowing the field to be absent at runtime.
   - Define the count as accepted, returned matches only. Do not claim an uncapped on-disk file total: rg is invoked with `--max-count 100`, all paths stop at `maxResults`, and this change must not add another search/count pass.

2. Populate `matchCount` in the shared accumulator.
   - Create file results with `matchCount: 0`.
   - Increment `matchCount` in the same block that pushes a `SearchMatch`, for both `ingestRgJsonLine` and `ingestGitGrepLine`, so the file count and navigable rows cannot drift inside new producers.
   - Keep `totalMatches` as the sum of accepted, returned matches under the current `maxResults` cap.
   - For git-grep, track whether the JS submatch regex accepted at least one occurrence for the current git-reported line. If git reports a line but the JS regex finds no occurrence because of regex semantic differences, add one whole-line fallback match instead of dropping the line; this is new behavior, because current code only falls back when `buildSubmatchRegex` returns `null`.

3. Normalize finalized results.
   - Add a small shared normalizer for per-file counts and use it from both `finalize` and the renderer row. Keep this normalizer in a renderer-safe shared module with no Node/Electron imports (for example, not in `src/shared/text-search.ts`, which imports `path`) so the search sidebar can reuse it without pulling parser/runtime dependencies into the renderer bundle. A renderer-side use is still required because older runtimes, older SSH relays, and hand-built fixtures can bypass the updated producer.
   - Normalize each file's count to `max(valid matchCount, matches.length)`, where a valid count is a finite non-negative integer. Treat missing, negative, `NaN`, and non-numeric payloads as absent.
   - If a legacy or hand-built test fixture omits `matchCount`, use `matches.length`.
   - Drop files with no navigable match rows even if a malformed payload says `matchCount > 0`.
   - Do not include empty file rows.

4. Render file badges from the explicit count.
   - Update `FileResultRow` to display the shared normalized count, not raw `fileResult.matchCount ?? fileResult.matches.length`.
   - Keep the current badge styling and tokens.

5. Update focused tests and fixtures.
   - Shared text-search tests assert `matchCount` for rg and git-grep, multi-match lines, fallback line-level matches, zero-length regex handling, regex semantic fallback, max-results truncation, and finalize normalization.
   - Renderer component tests cover omitted counts, bogus `0` counts with match rows, and a `matchCount` greater than `matches.length`.
   - Runtime RPC, SSH provider, local git fallback, relay git fallback, and renderer client fixtures continue to accept the expanded result shape.
   - Confirm there is no result-side zod schema that rejects the added optional field; `files.search` currently validates params only.

## Data Flow

- Search panel calls `searchRuntimeFiles`.
- Local runtime or SSH relay runs rg/git-grep.
- Shared parser ingests each result line and updates:
  - `fileResult.matches[]` for navigable preview rows.
  - `fileResult.matchCount` for the file badge.
  - `acc.totalMatches` for the summary.
- `finalize` normalizes producer-owned counts and drops empty files.
- Renderer summary uses `totalMatches`; each file row badge uses the same normalized `matchCount` logic so legacy remote payloads cannot reintroduce zero-count file rows.

## Edge Cases

- rg emits a match line with no submatches: keep the existing line-level fallback and count it once.
- git-grep regex is accepted by git but cannot be constructed as a JavaScript `RegExp`: keep the existing whole-line fallback and count it once.
- git-grep regex is valid JavaScript but has different semantics from git grep and finds no JS-side submatch on a git-reported line: add a new whole-line fallback and count it once.
- Multiple matches on one line: count and render each accepted match.
- Zero-length regex matches: keep the existing last-index guard and count only accepted rows until `maxResults`.
- `maxResults` stops in the middle of a file: badge reflects accepted navigable matches, and `truncated` remains true.
- rg's `--max-count 100` can cap matching lines per file before Orca sees them; a matched line can still contribute multiple accepted submatches. This feature reports returned matches, not an uncapped per-file total.
- Legacy SSH relay or older runtime result omits `matchCount`: renderer falls back to `matches.length`.
- Malformed payload has `matchCount: 0`, negative, non-finite, or otherwise invalid with non-empty `matches`: normalize to at least `matches.length` so the exact reported bug cannot persist.
- Windows/WSL paths: keep existing `normalizeRelativePath`, WSL path translation, and `path.join` behavior.
- Rapid query changes: local rg `fs:search` cancels by sender/root and local runtime rg search cancels by runtime/root. Git-grep fallback paths and SSH relay searches can still overlap; stale renderer results are ignored only by `latestSearchIdRef`.
- Multi-window searches: local IPC rg searches are isolated by `event.sender.id`; runtime rg searches sharing a runtime/root can cancel each other today, and this design does not change that behavior.
- External file mutations during or after search: counts are a point-in-time process result and are not invalidated by file watchers; rerun search for fresh counts.
- SSH latency or relay timeout: no extra IPC/RPC/relay round trips. The relay search code can return partial, truncated results on its own timeout; renderer/runtime transport timeouts can still surface an error path before a partial result arrives, which is unchanged by this count field.
- Non-ASCII column accuracy is not fixed here; current rg offsets are still consumed by the existing parser/navigation path.

## Test Plan

- Unit: `src/shared/text-search.test.ts` and the shared renderer-safe normalizer tests
  - rg parser sets file `matchCount`.
  - git-grep parser sets file `matchCount`.
  - multi-match single lines increment count per occurrence.
  - fallback line-level matches increment count.
  - JS/git regex semantic mismatch where `buildSubmatchRegex` returns `null` falls back to one whole-line match.
  - JS/git regex semantic mismatch where the JS regex is valid but finds zero occurrences on a git-reported line falls back to one whole-line match.
  - `finalize` fills missing count, repairs too-low counts, and filters empty files.
- Unit: `src/main/ipc/filesystem-search-git.test.ts`
  - git-grep fallback result includes accurate per-file count.
- Unit: `src/relay/fs-handler-git-search.test.ts`
  - relay git fallback preserves count on timeout/partial output.
- Unit/component: `src/renderer/src/components/right-sidebar/SearchResultItems.tsx`
  - file badge renders normalized count for omitted, too-low, and greater-than-preview counts.
- Unit: `src/renderer/src/components/right-sidebar/search-rows.test.ts`
  - row flattening continues to preserve the file result object and does not filter match rows based on count.
  - If the normalization function lives near row construction instead of inside the component, cover invalid, omitted, and greater-than-preview counts here.
- Existing pass-through fixtures:
  - update `src/main/providers/ssh-filesystem-provider.test.ts`, `src/main/runtime/rpc/methods/files.test.ts`, and renderer runtime-file-client tests only where their exact typed fixtures or snapshots need the new field.
- Validation: Electron search panel searches `reportError(` in the current worktree and shows nonzero per-file badges with expandable/navigable matches; save evidence images outside git and attach them to the review/PR conversation rather than committing them.

## UI Quality Bar

The search sidebar should look unchanged except the badge number is accurate. The badge must remain compact, right-aligned, token-based, readable in light/dark themes, and stable when file names or parent paths truncate. A file row with a nonzero badge must still expose at least one navigable match row when expanded.

## Review Screenshots

1. Search sidebar with `reportError(` results expanded, showing nonzero file badges and match rows.
2. Same search with one result group collapsed, showing the count still nonzero.
3. Search sidebar empty/no-match state after a query with no results.

## Rollout

1. Extend the shared search result type and accumulator.
2. Update rg and git-grep ingestion to maintain per-file counts.
3. Update finalization compatibility and tests.
4. Update the search file badge display.
5. Run focused tests, typecheck, lint, then Electron validation screenshots.

## Lightweight Eng Review

- Scope: Kept small; add one explicit accepted-count field and render it, without changing search execution, caps, or sidebar layout.
- Architecture/data flow: Count is produced in `src/shared/text-search.ts`, shared by local main-process search, runtime file search, and SSH relay search; renderer remains a consumer of the result contract.
- Failure modes covered:
  - Legacy result without `matchCount` falls back to preview length.
  - Too-low or bogus counts are normalized to at least the number of navigable rows.
  - Partial/truncated searches preserve the current accepted-match semantics.
  - rg/git-grep fallback lines without exact submatch ranges still produce a count and navigable row.
  - git-grep semantic regex mismatches do not silently drop git-reported lines, including the valid-JS-regex-but-zero-JS-hits case that current code does not handle.
  - Empty file rows are filtered before reaching the UI.
  - WSL/Windows and SSH paths stay in existing parser and provider boundaries.
- Test coverage required:
  - Shared parser unit coverage in `src/shared/text-search.test.ts`.
  - Git fallback unit coverage in `src/main/ipc/filesystem-search-git.test.ts` and relay fallback coverage.
  - Renderer component coverage for omitted counts, bogus zero counts, and `matchCount > matches.length`.
  - Electron validation for the visible search panel.
- Performance/blast radius: Low only because this reports accepted matches from the existing stream. Full uncapped per-file totals would require changing caps or adding another search/count pass and are out of scope.
- UI quality bar: Badge remains visually identical but uses the authoritative count; screenshots must show nonzero badges and usable match rows.
- Required review screenshots:
  1. Expanded `reportError(` search results.
  2. Collapsed result group preserving the count.
  3. No-results state.
- Residual risks: Existing caps still limit accepted results, git-grep fallback and SSH searches can overlap because they have no active-search cancellation map, runtime multi-window rg searches can cancel by runtime/root, renderer/runtime transport timeouts can beat relay partial results, and external mutations can stale existing results until the user reruns search.
