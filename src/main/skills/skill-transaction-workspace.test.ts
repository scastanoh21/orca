import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RESERVED_SKILL_TRANSACTION_DIRECTORY } from './skill-transaction-paths'
import { skillTransactionReservedRoot } from './skill-transaction-workspace'

describe('skill transaction workspace selection', () => {
  it('uses the adjacent parent only when it shares the destination mount', () => {
    const skillsRoot = join('root', 'skills')
    const parentRoot = join('root')
    expect(
      skillTransactionReservedRoot({
        skillsRoot,
        skillsRootDevice: 1,
        parentRoot,
        parentRootDevice: 1
      })
    ).toBe(join(parentRoot, RESERVED_SKILL_TRANSACTION_DIRECTORY))
  })

  it('keeps the workspace inside the skills root across a mount boundary', () => {
    const skillsRoot = join('mounted', 'skills')
    const parentRoot = join('mounted')
    expect(
      skillTransactionReservedRoot({
        skillsRoot,
        skillsRootDevice: 2,
        parentRoot,
        parentRootDevice: 1
      })
    ).toBe(join(skillsRoot, RESERVED_SKILL_TRANSACTION_DIRECTORY))
  })
})
