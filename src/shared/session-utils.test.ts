import { describe, expect, it } from 'vitest'

import { formatDuration, resolveBitrateKbps, sanitizeSessionName } from './session-utils.js'
import type { ExportSettings } from './types.js'

describe('sanitizeSessionName', () => {
  it('removes invalid filesystem characters', () => {
    expect(sanitizeSessionName('My: Recording*?')).toBe('My Recording')
  })

  it('trims extra whitespace', () => {
    expect(sanitizeSessionName('  screen    demo   ')).toBe('screen demo')
  })
})

describe('resolveBitrateKbps', () => {
  it('resolves profile presets', () => {
    const settings: ExportSettings = {
      format: 'mp4',
      bitrateProfile: 'high',
      mergeStreams: true,
    }

    expect(resolveBitrateKbps(settings)).toBe(5000)
  })

  it('returns custom bitrate for custom profile', () => {
    const settings: ExportSettings = {
      format: 'mp4',
      bitrateProfile: 'custom',
      customBitrateKbps: 7200,
      mergeStreams: true,
    }

    expect(resolveBitrateKbps(settings)).toBe(7200)
  })
})

describe('formatDuration', () => {
  it('formats milliseconds to hh:mm:ss', () => {
    expect(formatDuration(3_661_000)).toBe('01:01:01')
  })
})
