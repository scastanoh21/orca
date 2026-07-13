import { rename } from 'node:fs/promises'

export type SkillRenameRuntime = {
  renameEntry?: typeof rename
  wait?: (milliseconds: number) => Promise<void>
  windowsFallback?: boolean
}

export async function retrySkillRename(
  source: string,
  destination: string,
  beforeAttempt: () => Promise<void>,
  renameEntry: typeof rename = rename,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds))
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    // Why: another manager can edit during a Windows sharing-violation delay.
    await beforeAttempt()
    try {
      await renameEntry(source, destination)
      return
    } catch (error) {
      const retryable =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'EPERM' || error.code === 'EBUSY')
      if (!retryable || attempt === 3) {
        throw error
      }
      await wait(25 * 2 ** attempt)
    }
  }
}
