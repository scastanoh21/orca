import type { Store } from '../persistence'
import type { RuntimeManagedSkillNudgeHandler } from '../runtime/rpc/managed-skill-nudge'
import { recordManagedSkillRestartPromptRequest } from '../skills/managed-skill-restart-prompts'

export function createRuntimeManagedSkillNudge(store: Store): RuntimeManagedSkillNudgeHandler {
  return async ({ skillName, context, remoteRuntime, discoveryTarget }) => {
    recordManagedSkillRestartPromptRequest(store, {
      skillName,
      context,
      ...(remoteRuntime ? { remoteRuntime } : {}),
      ...(!remoteRuntime && discoveryTarget ? { discoveryTarget } : {})
    })
  }
}
