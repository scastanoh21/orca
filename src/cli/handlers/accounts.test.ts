import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../runtime-client', () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }

  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  class RuntimeRpcFailureError extends RuntimeClientError {
    readonly response: unknown

    constructor(response: unknown) {
      super('runtime_error', 'runtime_error')
      this.response = response
    }
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError
  }
})

import { main } from '../index'
import { okFixture, queueFixtures } from '../test-fixtures'

describe('orca accounts CLI handlers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    process.exitCode = undefined
  })

  it('prints a table of managed accounts with usage', async () => {
    queueFixtures(
      callMock,
      okFixture('req_list', {
        codex: {
          accounts: [{ id: 'acc-codex-1', email: 'codex@example.com' }],
          activeAccountId: 'acc-codex-1'
        },
        claude: {
          accounts: [{ id: 'acc-claude-1', email: 'claude@example.com' }],
          activeAccountId: null
        },
        rateLimits: {
          codex: { provider: 'codex', session: { usedPercent: 42.4 }, weekly: null },
          claude: null,
          inactiveCodexAccounts: [],
          inactiveClaudeAccounts: [{ accountId: 'acc-claude-1', rateLimits: null }]
        }
      })
    )

    await main(['accounts', 'list'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('accounts.list')
    const output = String(vi.mocked(console.log).mock.calls[0][0])
    expect(output).toContain('PROVIDER')
    expect(output).toContain('codex')
    expect(output).toContain('codex@example.com')
    expect(output).toContain('acc-codex-1')
    expect(output).toContain('yes')
    expect(output).toContain('5h 42%')
    expect(output).toContain('claude@example.com')
    expect(output).toContain('n/a')
  })

  it('rejects an unknown --provider before calling the runtime', async () => {
    await main(['accounts', 'select', '--provider', 'gemini', '--id', 'acc-1'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      '--provider must be codex or claude'
    )
    expect(process.exitCode).toBe(1)
  })

  it('selects a codex account by id', async () => {
    queueFixtures(
      callMock,
      okFixture('req_select', {
        accounts: [{ id: 'acc-codex-1', email: 'codex@example.com' }],
        activeAccountId: 'acc-codex-1'
      })
    )

    await main(['accounts', 'select', '--provider', 'codex', '--id', 'acc-codex-1'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('accounts.selectCodex', { accountId: 'acc-codex-1' })
    expect(vi.mocked(console.log).mock.calls[0][0]).toContain(
      'Active codex account: codex@example.com (acc-codex-1)'
    )
  })

  it('selects a claude account by id', async () => {
    queueFixtures(
      callMock,
      okFixture('req_select', {
        accounts: [{ id: 'acc-claude-1', email: 'claude@example.com' }],
        activeAccountId: 'acc-claude-1'
      })
    )

    await main(['accounts', 'select', '--provider', 'claude', '--id', 'acc-claude-1'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('accounts.selectClaude', { accountId: 'acc-claude-1' })
  })

  it('removes a codex account via the remove alias for the canonical rm command', async () => {
    queueFixtures(
      callMock,
      okFixture('req_remove', {
        accounts: [],
        activeAccountId: null
      })
    )

    await main(['accounts', 'remove', '--provider', 'codex', '--id', 'acc-codex-1'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('accounts.removeCodex', { accountId: 'acc-codex-1' })
    expect(vi.mocked(console.log).mock.calls[0][0]).toContain(
      'Removed codex account. 0 account(s) remain.'
    )
  })

  it('streams login output live, announces the login URL, and reports the added account', async () => {
    queueFixtures(
      callMock,
      okFixture('req_add', { loginId: 'login-1' }),
      okFixture('req_poll_1', {
        loginId: 'login-1',
        provider: 'codex',
        status: 'in_progress',
        outputTail: 'Visit https://auth.example.com/login?code=abc to continue.\n'
      }),
      okFixture('req_poll_2', {
        loginId: 'login-1',
        provider: 'codex',
        status: 'completed',
        outputTail: 'Visit https://auth.example.com/login?code=abc to continue.\nSigned in.\n',
        state: {
          accounts: [{ id: 'acc-codex-1', email: 'codex@example.com' }],
          activeAccountId: 'acc-codex-1'
        }
      })
    )

    await main(['accounts', 'add', '--provider', 'codex'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('accounts.addCodex', {})
    expect(callMock).toHaveBeenCalledWith(
      'accounts.pollAdd',
      { loginId: 'login-1', timeoutMs: expect.any(Number) },
      { timeoutMs: expect.any(Number) }
    )
    expect(callMock).toHaveBeenCalledTimes(3)

    const written = vi.mocked(process.stdout.write).mock.calls.map((call) => String(call[0]))
    expect(written.join('')).toContain('Visit https://auth.example.com/login?code=abc')
    expect(written.join('')).toContain('Signed in.')

    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
    expect(logged.some((line) => line.includes('Login URL (open on another device'))).toBe(true)
    expect(logged.some((line) => line.includes('auth.example.com/login?code=abc'))).toBe(true)
    expect(
      logged.some((line) => line.includes('Added codex account: codex@example.com (acc-codex-1)'))
    ).toBe(true)
    // The final summary must not repeat the URL once the live poll already announced it.
    const finalSummary = logged.at(-1)
    expect(finalSummary).not.toContain('Login URL:')
    expect(process.exitCode).toBeUndefined()
  })

  it('omits the login URL from the final summary once it was announced live, but still prints it if only discovered at completion', async () => {
    queueFixtures(
      callMock,
      okFixture('req_add', { loginId: 'login-5' }),
      okFixture('req_poll_1', {
        loginId: 'login-5',
        provider: 'codex',
        status: 'completed',
        outputTail: 'Signed in without a printed URL.\n',
        state: {
          accounts: [{ id: 'acc-codex-2', email: 'codex2@example.com' }],
          activeAccountId: 'acc-codex-2'
        }
      })
    )

    await main(['accounts', 'add', '--provider', 'codex'], '/tmp/repo')

    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
    // No URL was ever present in the output tail, so there is nothing to announce
    // or repeat; the final summary should simply report the added account.
    expect(logged.some((line) => line.includes('Login URL'))).toBe(false)
    expect(
      logged.some((line) => line.includes('Added codex account: codex2@example.com (acc-codex-2)'))
    ).toBe(true)
  })

  it('adds a claude account without live output in --json mode, emitting one final JSON blob', async () => {
    queueFixtures(
      callMock,
      okFixture('req_add', { loginId: 'login-2' }),
      okFixture('req_poll_1', {
        loginId: 'login-2',
        provider: 'claude',
        status: 'completed',
        outputTail: 'https://claude.ai/oauth/authorize?state=xyz\n',
        state: {
          accounts: [{ id: 'acc-claude-1', email: 'claude@example.com' }],
          activeAccountId: 'acc-claude-1'
        }
      })
    )

    await main(['accounts', 'add', '--provider', 'claude', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('accounts.addClaude', {})
    expect(vi.mocked(process.stdout.write)).not.toHaveBeenCalled()
    expect(vi.mocked(console.log)).toHaveBeenCalledTimes(1)
    const printed = JSON.parse(String(vi.mocked(console.log).mock.calls[0][0]))
    expect(printed.result.status).toBe('completed')
    expect(printed.result.loginUrl).toBe('https://claude.ai/oauth/authorize?state=xyz')
  })

  it('sets a nonzero exit code when the login fails', async () => {
    queueFixtures(
      callMock,
      okFixture('req_add', { loginId: 'login-3' }),
      okFixture('req_poll_1', {
        loginId: 'login-3',
        provider: 'codex',
        status: 'failed',
        outputTail: 'error: denied\n',
        error: 'Codex sign-in was denied.'
      })
    )

    await main(['accounts', 'add', '--provider', 'codex'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
    expect(
      logged.some((line) => line.includes('codex login failed: Codex sign-in was denied.'))
    ).toBe(true)
  })

  it('times out client-side if the login never settles', async () => {
    vi.useFakeTimers()
    try {
      queueFixtures(callMock, okFixture('req_add', { loginId: 'login-4' }))
      callMock.mockImplementation(async (method: string) => {
        if (method === 'accounts.pollAdd') {
          vi.advanceTimersByTime(20_000)
          return okFixture('req_poll', {
            loginId: 'login-4',
            provider: 'codex',
            status: 'in_progress',
            outputTail: ''
          })
        }
        return okFixture('req_add', { loginId: 'login-4' })
      })

      await main(['accounts', 'add', '--provider', 'codex'], '/tmp/repo')

      expect(process.exitCode).toBe(1)
      expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
        'Timed out waiting for the codex login to finish'
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('tolerates the real-world claude worst case (180s login + 20s status) without timing out client-side', async () => {
    vi.useFakeTimers()
    try {
      queueFixtures(callMock, okFixture('req_add', { loginId: 'login-6' }))
      let elapsedMs = 0
      callMock.mockImplementation(async (method: string) => {
        if (method === 'accounts.pollAdd') {
          // 195s of polling mirrors the ClaudeAccountService worst case (180s
          // login + 20s status, minus the last poll window) before completing.
          if (elapsedMs < 195_000) {
            elapsedMs += 15_000
            vi.advanceTimersByTime(15_000)
            return okFixture('req_poll_in_progress', {
              loginId: 'login-6',
              provider: 'claude',
              status: 'in_progress',
              outputTail: ''
            })
          }
          return okFixture('req_poll_done', {
            loginId: 'login-6',
            provider: 'claude',
            status: 'completed',
            outputTail: 'Signed in.\n',
            state: {
              accounts: [{ id: 'acc-claude-2', email: 'claude2@example.com' }],
              activeAccountId: 'acc-claude-2'
            }
          })
        }
        return okFixture('req_add', { loginId: 'login-6' })
      })

      await main(['accounts', 'add', '--provider', 'claude'], '/tmp/repo')

      expect(process.exitCode).toBeUndefined()
      expect(vi.mocked(console.error)).not.toHaveBeenCalled()
      const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
      expect(
        logged.some((line) => line.includes('Added claude account: claude2@example.com'))
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
