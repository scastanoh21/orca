import { describe, expect, it } from 'vitest'
import { isSuccessfulSkillInstallExit } from './skill-install-terminal-exit'

describe('skill install terminal exit', () => {
  it('accepts only a successful process exit after the install window began', () => {
    expect(isSuccessfulSkillInstallExit({ code: 0 }, 1)).toBe(true)
    expect(isSuccessfulSkillInstallExit({ code: 1 }, 1)).toBe(false)
    expect(isSuccessfulSkillInstallExit({ code: null }, 1)).toBe(false)
    expect(isSuccessfulSkillInstallExit({ code: 0 }, null)).toBe(false)
  })
})
