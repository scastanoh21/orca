import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions harness-injected title seeding', () => {
  it('keeps harness-injected Claude turns without isMeta out of session titles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-claude-injected-title-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    await mkdir(join(roots.claudeProjectsDir, 'project'), { recursive: true })

    await writeFile(
      join(roots.claudeProjectsDir, 'project', 'injected-first.jsonl'),
      jsonLines([
        {
          type: 'user',
          sessionId: 'injected-first',
          timestamp: '2026-06-11T10:00:00.000Z',
          cwd: '/repo/app',
          // Task notifications carry no isMeta — only their text marks them.
          message: {
            role: 'user',
            content: '<task-notification> <task-id>abc</task-id> <status>completed</status>'
          }
        },
        {
          type: 'user',
          sessionId: 'injected-first',
          timestamp: '2026-06-11T10:00:01.000Z',
          cwd: '/repo/app',
          message: { role: 'user', content: 'Fix the sidebar label bug' }
        }
      ])
    )

    const result = await scanAiVaultSessions({
      ...roots,
      platform: 'darwin'
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]?.title).toBe('Fix the sidebar label bug')
  })

  it('titles a session by its first prompt even when it starts with a kebab-shaped tag', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-claude-kebab-title-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    await mkdir(join(roots.claudeProjectsDir, 'project'), { recursive: true })

    await writeFile(
      join(roots.claudeProjectsDir, 'project', 'kebab-first.jsonl'),
      jsonLines([
        {
          type: 'user',
          sessionId: 'kebab-first',
          timestamp: '2026-06-11T10:00:00.000Z',
          cwd: '/repo/app',
          // A genuine typed prompt that happens to start with a kebab tag — not
          // an observed harness tag, so it must remain the session title.
          message: { role: 'user', content: '<order-list>show me the orders' }
        },
        {
          type: 'user',
          sessionId: 'kebab-first',
          timestamp: '2026-06-11T10:00:01.000Z',
          cwd: '/repo/app',
          message: { role: 'user', content: 'A later follow-up prompt' }
        }
      ])
    )

    const result = await scanAiVaultSessions({
      ...roots,
      platform: 'darwin'
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]?.title).toBe('<order-list>show me the orders')
  })
})
