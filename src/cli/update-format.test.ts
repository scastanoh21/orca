import { describe, expect, it } from 'vitest'
import { formatAppVersion, formatUpdateProgress, formatUpdateResult } from './update-format'

describe('updater CLI formatting', () => {
  it('prints only the version in human mode', () => {
    expect(formatAppVersion({ version: '1.4.0' })).toBe('1.4.0')
  })

  it('describes available and current versions', () => {
    expect(
      formatUpdateResult({
        operation: 'check',
        status: { state: 'available', version: '1.5.0', changelog: null },
        installRequested: false
      })
    ).toBe('Update available: Orca 1.5.0.')
    expect(
      formatUpdateResult({
        operation: 'check',
        status: { state: 'not-available' },
        installRequested: false
      })
    ).toBe('Orca is up to date.')
  })

  it('describes an install request', () => {
    expect(
      formatUpdateResult({
        operation: 'update',
        status: { state: 'downloaded', version: '1.5.0' },
        installRequested: true
      })
    ).toContain('Orca will quit and restart')
  })

  it('formats compact download progress for an in-place line', () => {
    expect(formatUpdateProgress({ state: 'downloading', version: '1.5.0', percent: 42 })).toBe(
      'Downloading Orca 1.5.0… 42%'
    )
  })
})
