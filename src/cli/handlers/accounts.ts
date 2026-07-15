import type {
  RuntimeAccountAddStarted,
  RuntimeAccountPollAddResult,
  RuntimeAccountProvider,
  RuntimeAccountsSnapshot
} from '../../shared/runtime-types'
import type { ClaudeRateLimitAccountsState, CodexRateLimitAccountsState } from '../../shared/types'
import type { CommandHandler } from '../dispatch'
import {
  formatAccountAddResult,
  formatAccountAddStarted,
  formatAccountRemoveResult,
  formatAccountSelectResult,
  formatAccountsList,
  printResult
} from '../format'
import { getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'
import type { RuntimeClient, RuntimeRpcSuccess } from '../runtime-client'

// Why: mirrors the main-process login timeouts (CodexAccountService /
// ClaudeAccountService LOGIN_TIMEOUT_MS) plus grace for the pollAdd
// long-poll round trip, so the CLI doesn't give up before the server does.
const ADD_ACCOUNT_TIMEOUT_MS: Record<RuntimeAccountProvider, number> = {
  codex: 130_000,
  claude: 190_000
}
const POLL_WINDOW_MS = 15_000
const POLL_CLIENT_GRACE_MS = 5_000
const LOGIN_URL_PATTERN = /https?:\/\/\S+/

function getProviderFlag(flags: Map<string, string | boolean>): RuntimeAccountProvider {
  const value = getRequiredStringFlag(flags, 'provider')
  if (value !== 'codex' && value !== 'claude') {
    throw new RuntimeClientError(
      'invalid_argument',
      `--provider must be codex or claude, got "${value}"`
    )
  }
  return value
}

function extractLoginUrl(outputTail: string): string | undefined {
  const match = LOGIN_URL_PATTERN.exec(outputTail)
  return match ? match[0].replace(/[).,\]}'"]+$/, '') : undefined
}

async function pollAccountAdd(
  client: RuntimeClient,
  provider: RuntimeAccountProvider,
  loginId: string,
  json: boolean
): Promise<RuntimeRpcSuccess<RuntimeAccountPollAddResult>> {
  const deadline = Date.now() + ADD_ACCOUNT_TIMEOUT_MS[provider]
  let printedChars = 0
  let announcedLoginUrl = false

  for (;;) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new RuntimeClientError(
        'timeout',
        `Timed out waiting for the ${provider} login to finish. Run \`orca accounts add --provider ${provider}\` again.`
      )
    }
    const pollTimeoutMs = Math.min(POLL_WINDOW_MS, remainingMs)
    const response = await client.call<RuntimeAccountPollAddResult>(
      'accounts.pollAdd',
      { loginId, timeoutMs: pollTimeoutMs },
      { timeoutMs: pollTimeoutMs + POLL_CLIENT_GRACE_MS }
    )
    const { outputTail, status } = response.result

    if (!json) {
      if (outputTail.length > printedChars) {
        process.stdout.write(outputTail.slice(printedChars))
        printedChars = outputTail.length
      }
      if (!announcedLoginUrl) {
        const loginUrl = extractLoginUrl(outputTail)
        if (loginUrl) {
          announcedLoginUrl = true
          console.log(`\nLogin URL (open on another device if needed): ${loginUrl}`)
        }
      }
    }

    if (status !== 'in_progress') {
      return response
    }
  }
}

export const ACCOUNTS_HANDLERS: Record<string, CommandHandler> = {
  'accounts list': async ({ client, json }) => {
    const result = await client.call<RuntimeAccountsSnapshot>('accounts.list')
    printResult(result, json, formatAccountsList)
  },
  'accounts select': async ({ flags, client, json }) => {
    const provider = getProviderFlag(flags)
    const accountId = getRequiredStringFlag(flags, 'id')
    const result = await client.call<CodexRateLimitAccountsState | ClaudeRateLimitAccountsState>(
      provider === 'codex' ? 'accounts.selectCodex' : 'accounts.selectClaude',
      { accountId }
    )
    printResult(result, json, (state) => formatAccountSelectResult(provider, state))
  },
  'accounts rm': async ({ flags, client, json }) => {
    const provider = getProviderFlag(flags)
    const accountId = getRequiredStringFlag(flags, 'id')
    const result = await client.call<CodexRateLimitAccountsState | ClaudeRateLimitAccountsState>(
      provider === 'codex' ? 'accounts.removeCodex' : 'accounts.removeClaude',
      { accountId }
    )
    printResult(result, json, (state) => formatAccountRemoveResult(provider, state))
  },
  'accounts add': async ({ flags, client, json }) => {
    const provider = getProviderFlag(flags)
    const started = await client.call<RuntimeAccountAddStarted>(
      provider === 'codex' ? 'accounts.addCodex' : 'accounts.addClaude',
      {}
    )
    if (!json) {
      console.log(formatAccountAddStarted(provider, started.result.loginId))
    }

    const finalResponse = await pollAccountAdd(client, provider, started.result.loginId, json)
    const loginUrl = extractLoginUrl(finalResponse.result.outputTail)
    const augmentedResponse: RuntimeRpcSuccess<RuntimeAccountPollAddResult> = {
      ...finalResponse,
      result: { ...finalResponse.result, ...(loginUrl ? { loginUrl } : {}) }
    }
    printResult(augmentedResponse, json, formatAccountAddResult)
    if (finalResponse.result.status === 'failed') {
      process.exitCode = 1
    }
  }
}
