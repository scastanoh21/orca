# Hide Saved Launch Receipt Dialog

## Problem

When a Source Control AI launch action already has a saved launch receipt, some entry points still open `SourceControlAgentActionDialog`. The form then renders the "Launch recipe already saved" state and save-scope controls even though the user has already opted into a receipt-backed launch.

This is visible today because:
- `SourceControlAgentActionDialogForm` computes `selectedLaunchRecipeAlreadySaved` only after the dialog is rendered.
- `useSourceControlAgentActionDialog` resets form state and detects agents on every open, but has no saved-receipt bypass.
- `runSourceControlAgentActionStart` already skips rewriting a matching saved recipe, but it is only reached after the user presses Start.
- The form test currently locks in the obsolete behavior where an already-saved recipe still shows visible dialog chrome.

## Non-goals

- Do not change how source-control recipes are saved, normalized, inherited, or migrated.
- Do not change source-control text generation dialogs.
- Do not add persisted state or telemetry.
- Do not add custom-agent launch support here. `SourceControlAgentActionDialog` starts `TuiAgent` values; saved custom-agent receipts currently arrive as `savedAgentId: null` because `readSourceControlLaunchRecipeAgentId` filters custom IDs.

## Design

1. Move saved-launch bypass detection into the dialog hook.

   Build the candidate launch recipe from the dialog's initial saved props:

   ```ts
   {
     agentId: savedAgentId,
     commandInputTemplate: savedCommandInputTemplate ?? '{basePrompt}',
     agentArgs: savedAgentArgs ?? ''
   }
   ```

   Only consider the candidate when `savedAgentId` is non-null. A default action template without a saved agent is not a launch receipt and must keep showing the dialog.

2. Match the actual saved target, not only the default UI target.

   Use `sourceControlActionRecipeMatchesTarget` against the available persisted targets and select the target that proves the receipt exists:
   - If `repoId` and `repo` are present, check `{ type: 'repo', repoId }` first.
   - Then check `{ type: 'global' }`.
   - If neither target matches, render the dialog normally.

   This fixes the important repo-override case: callers pass the resolved recipe, so a repository-specific receipt can be the active saved receipt even though the form's default save target is currently global.

3. Suppress the modal while an eligible saved receipt is being verified/launched.

   A hook-only auto-start effect is not enough: React would still render the open dialog while agent detection is pending, causing the exact modal flash this feature is meant to remove. Return a render gate such as `shouldRenderDialog` or `autoLaunchPending` from `useSourceControlAgentActionDialog`, and have `SourceControlAgentActionDialog` omit `DialogContent` while a matching saved receipt is pending detection/start.

   If the bypass later proves invalid or launch fails, clear the pending state and show the normal dialog with the existing status copy, delivery-plan panel, and toast behavior.

4. Reuse one start implementation, but avoid a second detection call.

   Today `handleStart` always calls `refreshDetectedAgents()` before building the delivery plan. For the bypass, detection has already completed, so extract an internal start helper that accepts the detected-agent list:

   - manual Start: refresh agents, then call the helper
   - saved-receipt bypass: use the just-detected agents, then call the helper

   Pass the matched save target value (`'repo'` or `'global'`) into `runSourceControlAgentActionStart`. It will still skip `onSaveAgentDefault` when the same target already matches.

5. Guard launches by open cycle and receipt key.

   The auto-launch effect must launch at most once for a single dialog-open cycle, including React StrictMode replays and stale detection promises. Key the guard by the open cycle plus the matched receipt identity: action id, target, agent id, command template, args, repo id, connection id, worktree id, and base prompt.

   Reset the guard when the dialog closes. If props change while open, do not auto-launch a second receipt in the same open cycle; show the dialog instead.

## Data flow

- Caller opens `SourceControlAgentActionDialog`.
- The hook resets form state from the saved recipe props.
- The hook computes `matchedSavedReceiptTargetValue` from current `settings`/`repo`.
- If there is no concrete matched receipt, the dialog renders as today.
- If there is a match, the component hides dialog content while the hook detects local or remote agents.
- If the saved agent is detected and enabled on the current host:
  - render the command template with `basePrompt`
  - reject empty rendered prompts
  - build the delivery plan using the already-detected agents
  - call `runSourceControlAgentActionStart` with the matched save target
  - on success, call `onLaunched` and close
- If any prerequisite fails, the hook reveals the normal dialog instead of silently swallowing the action.

## Edge cases

- No saved agent id: no bypass. This includes default templates and custom-agent receipts.
- Saved agent missing, disabled, or not detected: show the existing unavailable-agent copy.
- Remote/SSH workspace with `worktreeId` and unresolved `connectionId === undefined`: do not auto-launch; show the connection error path.
- Hosted/PR-page checks path with `onStart` and no `worktreeId`: still eligible; `onStart` is the launch implementation for that caller.
- Empty rendered command input: do not auto-launch; show the dialog disabled as today.
- Repo receipt exists and matches: bypass using the repo target, even if the form would have defaulted the save selector to global.
- Global receipt exists and matches, but repo override differs: do not treat the global receipt as matching the active resolved recipe.
- Launch returns false or throws: leave the dialog open. Existing behavior is a toast plus whatever delivery-plan state was computed; do not close silently.
- Dialog closes before detection resolves: ignore the stale result.
- Settings/repo mutate in another window while open: derive the match from subscribed `settings`/`repo` snapshots, and key the auto-launch guard so a late prop/state change cannot double-launch.
- Agent detection results change between detection and launch: the bypass uses the detected-agent list it just verified; manual starts can continue to refresh.

## Test plan

- Add `SourceControlAgentActionDialog.test.tsx` coverage:
  - matching saved global receipt hides the dialog, calls `onStart`/launch once, calls `onLaunched`, and closes
  - matching saved repo receipt bypasses using the repo target
  - mismatch renders the form and does not auto-start
  - saved agent unavailable renders the form with status copy and does not auto-start
  - `onStart` returns `false`: dialog becomes visible/remains open and `onLaunched` is not called
  - StrictMode/effect replay does not double-start
- Update `SourceControlAgentActionDialogForm.test.tsx`:
  - remove the test that treats visible "Launch recipe already saved" chrome as the desired saved-receipt path
  - keep selected-target copy coverage for manual customization/mismatch states
- Keep `source-control-action-recipe-match.test.ts` as the unit boundary for global/repo matching; add a repo-target regression if one is missing for the exact action used in the dialog tests.
- Run targeted Vitest for the right-sidebar dialog/matcher tests, then `pnpm typecheck` and `pnpm lint`.

## UI quality bar

The saved-receipt path should be visually absent: no modal flash, no "Launch recipe already saved" card, and no layout shift. The manual, mismatch, unavailable-agent, and failed-launch paths should remain visually unchanged and keep using existing shadcn primitives and tokens from `docs/STYLEGUIDE.md`.

## Review screenshots

Required before merge:
1. Saved global or repo receipt path: action starts with no customization dialog visible.
2. Mismatch/customize path: dialog still appears with prompt, agent, and save controls.
3. Unavailable-agent path: dialog appears with the existing status copy instead of auto-launching.

If a true saved-receipt Electron setup would mutate local user settings, capture the nearest safe state and document the gap in the PR notes rather than committing evidence images.

## Lightweight Eng Review

- Scope: One dialog component, its hook, and focused tests. No persistence, recipe resolver, telemetry, or layout-system changes.
- Architecture/data flow: Correct place is the hook plus a small render gate in the component. The form is too late because rendering it already violates the UX requirement.
- Failure modes: Must cover stale detection, StrictMode replay, remote connection unresolved, unavailable saved agent, empty prompt, repo/global target mismatch, custom-agent receipt exclusion, and failed launch.
- Performance/blast radius: Low, but not free if implemented naively. Avoid redetecting agents in the bypass by sharing a start helper that accepts already-detected agents.
- UI quality: The success path has no UI; all fallback paths preserve existing visuals.
- Residual risk: Multi-window settings changes can race with an already-open dialog. Using subscribed settings/repo snapshots plus an open-cycle guard keeps the behavior consistent and prevents duplicate launches, but it cannot make a launch atomic across windows.
