import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function copySessionFileWithoutOverwrite(
  sourcePath: string,
  targetPath: string
): Promise<void> {
  const temporaryPath = join(dirname(targetPath), `.orca-backfill-${randomUUID()}.tmp`)
  // Why: stage cross-volume copies away from the rollout filename so a failed
  // copy cannot strand a truncated session that a later retry would skip.
  await writeFile(temporaryPath, '', { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
  try {
    await copyFile(sourcePath, temporaryPath)
    try {
      // Why: this same-volume hardlink atomically installs the staged copy
      // without risking a collision overwrite after an EXDEV fallback.
      await link(temporaryPath, targetPath)
    } catch (installLinkError) {
      if (isExistsError(installLinkError)) {
        throw installLinkError
      }
      // Some target filesystems do not support hardlinks at all. COPYFILE_EXCL
      // preserves the collision contract while retaining the staged snapshot.
      await copyFile(temporaryPath, targetPath, constants.COPYFILE_EXCL)
    }
  } finally {
    try {
      await rm(temporaryPath, { force: true })
    } catch (error) {
      // Why: cleanup trouble must not misreport a successfully installed
      // rollout as a copy failure; the .tmp file is ignored by Codex.
      console.warn('[codex-session-backfill] Failed to remove staged copy:', temporaryPath, error)
    }
  }
}

function isExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}
