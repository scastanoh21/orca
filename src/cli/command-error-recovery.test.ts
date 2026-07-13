import { describe, expect, it } from 'vitest'

import { unknownCommandData, unknownFlagData } from './command-error-recovery'

describe('command error recovery', () => {
  it('directs unknown commands to read-only discovery', () => {
    expect(unknownCommandData()).toEqual({
      nextSteps: [
        'Run `orca help` or `orca agent-context --json` to inspect available commands before retrying.'
      ]
    })
  })

  it('enumerates flags without selecting one', () => {
    expect(unknownFlagData(['json', 'force'], ['worktree', 'rm'])).toEqual({
      validFlags: ['force', 'json'],
      nextSteps: ['Run `orca help worktree rm` to inspect supported flags before retrying.']
    })
  })
})
