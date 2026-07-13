export type SkillInstallTerminalExit = { code: number | null }

export function isSuccessfulSkillInstallExit(
  result: SkillInstallTerminalExit,
  startedAt: number | null
): startedAt is number {
  return result.code === 0 && startedAt !== null
}
