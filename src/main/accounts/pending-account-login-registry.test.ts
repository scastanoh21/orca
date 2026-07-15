import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PendingAccountLoginRegistry } from './pending-account-login-registry'

describe('PendingAccountLoginRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('accumulates output chunks onto the in-progress snapshot', () => {
    const registry = new PendingAccountLoginRegistry<{ id: string }>()
    registry.begin('login-1', 'codex')

    registry.appendOutput('login-1', 'open this URL: ')
    registry.appendOutput('login-1', 'https://example.com/auth')

    expect(registry.get('login-1')).toEqual({
      loginId: 'login-1',
      provider: 'codex',
      status: 'in_progress',
      outputTail: 'open this URL: https://example.com/auth'
    })
  })

  it('resolves a successful login with its final state', () => {
    const registry = new PendingAccountLoginRegistry<{ id: string }>()
    registry.begin('login-1', 'claude')

    registry.complete('login-1', { id: 'account-1' })

    expect(registry.get('login-1')).toEqual({
      loginId: 'login-1',
      provider: 'claude',
      status: 'completed',
      outputTail: '',
      state: { id: 'account-1' }
    })
  })

  it('propagates a failed login error message', () => {
    const registry = new PendingAccountLoginRegistry<{ id: string }>()
    registry.begin('login-1', 'codex')

    registry.fail('login-1', 'Codex login failed: denied')

    expect(registry.get('login-1')).toEqual({
      loginId: 'login-1',
      provider: 'codex',
      status: 'failed',
      outputTail: '',
      error: 'Codex login failed: denied'
    })
  })

  it('ignores updates once a login has already settled', () => {
    const registry = new PendingAccountLoginRegistry<{ id: string }>()
    registry.begin('login-1', 'codex')
    registry.complete('login-1', { id: 'account-1' })

    registry.appendOutput('login-1', 'late chunk')
    registry.fail('login-1', 'too late')

    expect(registry.get('login-1')?.status).toBe('completed')
  })

  it('waitForUpdate resolves as soon as the login settles', async () => {
    const registry = new PendingAccountLoginRegistry<{ id: string }>()
    registry.begin('login-1', 'codex')

    const waitPromise = registry.waitForUpdate('login-1', 30_000)
    registry.complete('login-1', { id: 'account-1' })

    await expect(waitPromise).resolves.toBeUndefined()
  })

  it('waitForUpdate respects its timeout when no update arrives', async () => {
    const registry = new PendingAccountLoginRegistry<{ id: string }>()
    registry.begin('login-1', 'codex')

    const waitPromise = registry.waitForUpdate('login-1', 5_000)
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(waitPromise).resolves.toBeUndefined()
    expect(registry.get('login-1')?.status).toBe('in_progress')
  })

  it('reclaims a settled login after its TTL elapses', async () => {
    const registry = new PendingAccountLoginRegistry<{ id: string }>()
    registry.begin('login-1', 'codex')
    registry.complete('login-1', { id: 'account-1' })

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)

    expect(registry.get('login-1')).toBeUndefined()
  })
})
