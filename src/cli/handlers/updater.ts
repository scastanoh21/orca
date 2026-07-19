import type { UpdateStatus } from '../../shared/types'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'
import type { RuntimeClient } from '../runtime-client'
import {
  formatAppVersion,
  formatUpdateProgress,
  formatUpdateResult,
  type UpdateCommandResult
} from '../update-format'

const POLL_INTERVAL_MS = 500
const CHECK_POLL_ATTEMPTS = 60
const DOWNLOAD_POLL_ATTEMPTS = 1_200

type PollResult = {
  response: RuntimeRpcSuccess<UpdateStatus>
  timedOut: boolean
}

export const UPDATER_HANDLERS: Record<string, CommandHandler> = {
  version: async ({ client, json }) => {
    const response = await withUpdaterRecovery(() => client.getAppVersion())
    printResult(response, json, formatAppVersion)
  },
  update: async ({ client, flags, json }) => {
    const checkOnly = flags.get('check') === true
    if (!json) {
      console.log('Checking for Orca updates...')
    }

    const initialCheck = await withUpdaterRecovery(() =>
      client.checkForUpdate(flags.get('prerelease') === true)
    )
    const check = await pollForStatus(
      client,
      initialCheck,
      (status) =>
        status.state === 'available' ||
        status.state === 'not-available' ||
        status.state === 'error',
      CHECK_POLL_ATTEMPTS
    )

    if (checkOnly || check.timedOut || check.response.result.state !== 'available') {
      finishUpdateCommand(check.response, json, {
        operation: checkOnly ? 'check' : 'update',
        installRequested: false,
        timedOut: check.timedOut
      })
      return
    }

    if (!json) {
      console.log(`Update available: Orca ${check.response.result.version}. Downloading...`)
    }
    const initialDownload = await withUpdaterRecovery(() => client.downloadUpdate())
    let lastProgress = ''
    let ttyProgressLineActive = false
    const download = await pollForStatus(
      client,
      initialDownload,
      (status) => status.state === 'downloaded' || status.state === 'error',
      DOWNLOAD_POLL_ATTEMPTS,
      (status) => {
        if (json) {
          return
        }
        const progress = formatUpdateProgress(status)
        if (process.stdout.isTTY === true) {
          if (status.state === 'downloading' && progress) {
            process.stdout.write(`\r${progress}`)
            ttyProgressLineActive = true
          } else if (ttyProgressLineActive) {
            process.stdout.write('\n')
            ttyProgressLineActive = false
          }
          return
        }
        if (progress && progress !== lastProgress) {
          console.log(progress)
          lastProgress = progress
        }
      }
    )
    // Why: timeouts can end polling without a terminal updater state; close any
    // in-place TTY line before final output.
    if (ttyProgressLineActive) {
      process.stdout.write('\n')
    }

    if (download.timedOut || download.response.result.state !== 'downloaded') {
      finishUpdateCommand(download.response, json, {
        operation: 'update',
        installRequested: false,
        timedOut: download.timedOut
      })
      return
    }

    await withUpdaterRecovery(() => client.installUpdate())
    finishUpdateCommand(download.response, json, {
      operation: 'update',
      installRequested: true,
      timedOut: false
    })
  }
}

async function pollForStatus(
  client: RuntimeClient,
  initialResponse: RuntimeRpcSuccess<UpdateStatus>,
  isTerminal: (status: UpdateStatus) => boolean,
  maxAttempts: number,
  onStatus?: (status: UpdateStatus) => void
): Promise<PollResult> {
  let response = initialResponse
  onStatus?.(response.result)
  if (isTerminal(response.result)) {
    return { response, timedOut: false }
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await delay(POLL_INTERVAL_MS)
    response = await withUpdaterRecovery(() => client.getUpdateStatus())
    onStatus?.(response.result)
    if (isTerminal(response.result)) {
      return { response, timedOut: false }
    }
  }
  return { response, timedOut: true }
}

function finishUpdateCommand(
  response: RuntimeRpcSuccess<UpdateStatus>,
  json: boolean,
  details: Omit<UpdateCommandResult, 'status'>
): void {
  const result: RuntimeRpcSuccess<UpdateCommandResult> = {
    ...response,
    result: { ...details, status: response.result }
  }
  if (details.timedOut || response.result.state === 'error') {
    process.exitCode = 1
  }
  printResult(result, json, formatUpdateResult)
}

async function withUpdaterRecovery<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!(error instanceof RuntimeClientError) || error.code !== 'runtime_unavailable') {
      throw error
    }
    const nextSteps = [
      'Open Orca, then retry the command.',
      'Download the latest Orca release from https://onorca.dev/download.'
    ]
    if (process.platform === 'darwin') {
      nextSteps.splice(1, 0, "If Orca was installed with Homebrew, run 'brew upgrade --cask orca'.")
    }
    throw new RuntimeClientError('runtime_unavailable', "Could not reach Orca's desktop updater.", {
      nextSteps
    })
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
