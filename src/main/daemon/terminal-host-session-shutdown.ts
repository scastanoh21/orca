import type { Session } from './session'

export async function disposeTerminalHostSessions(sessions: Iterable<Session>): Promise<void> {
  const results = await Promise.allSettled(
    [...sessions].map(async (session) => {
      session.detachAllClients()
      // Why: live children retain native ownership until physical exit, while
      // exited children must release handles without signalling a recycled pid.
      if (session.isAlive) {
        await session.forceKillAndDisposeSubprocess()
      } else {
        session.disposeSubprocess()
      }
    })
  )
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  )
  if (rejected) {
    throw rejected.reason
  }
}
