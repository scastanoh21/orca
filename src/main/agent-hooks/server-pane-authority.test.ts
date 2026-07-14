import { describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

const SOURCE = makePaneKey('tab-source', '11111111-1111-4111-8111-111111111111')
const TARGET = makePaneKey('tab-target', '22222222-2222-4222-8222-222222222222')
const FINAL = makePaneKey('tab-final', '33333333-3333-4333-8333-333333333333')
const SIBLING = makePaneKey('tab-target', '44444444-4444-4444-8444-444444444444')

describe('AgentHookServer pane authority', () => {
  it('keeps physical hooks routed after the source tab closes and suppresses them after owner retire', () => {
    const server = new AgentHookServer()
    server.ingestTerminalStatus({
      paneKey: SOURCE,
      tabId: 'tab-source',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'source' }
    })

    server.transferPaneAuthority(SOURCE, TARGET, 'pty-1')
    server.dropStatusEntriesByTabPrefix('tab-source')
    server.ingestTerminalStatus({
      paneKey: SOURCE,
      tabId: 'tab-source',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'after source close' }
    })

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: TARGET,
        tabId: 'tab-target',
        prompt: 'after source close'
      })
    ])

    server.ingestTerminalStatus({
      paneKey: SIBLING,
      tabId: 'tab-target',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'sibling' }
    })
    server.retirePaneAuthority(TARGET)
    server.ingestTerminalStatus({
      paneKey: SOURCE,
      tabId: 'tab-source',
      worktreeId: 'wt-1',
      payload: { state: 'done', prompt: 'too late' }
    })

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: SIBLING, prompt: 'sibling' })
    ])
  })

  it('persists one physical alias while chained transfers advance its owner', () => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.setPaneKeyAliasPersistenceListener(listener)

    server.transferPaneAuthority(SOURCE, TARGET, 'pty-1', 10)
    server.transferPaneAuthority(TARGET, FINAL, 'pty-1', 20)

    expect(listener).toHaveBeenLastCalledWith([
      {
        legacyPaneKey: SOURCE,
        stablePaneKey: FINAL,
        ptyId: 'pty-1',
        updatedAt: 20
      }
    ])
  })
})
