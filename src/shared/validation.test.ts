import { describe, expect, it } from 'vitest'

import { exportSettingsSchema, sessionSettingsSchema } from './validation.js'

describe('exportSettingsSchema', () => {
  it('accepts valid custom bitrate settings', () => {
    const result = exportSettingsSchema.parse({
      format: 'mp4',
      bitrateProfile: 'custom',
      customBitrateKbps: 6000,
      mergeStreams: true,
    })

    expect(result.customBitrateKbps).toBe(6000)
  })
})

describe('sessionSettingsSchema', () => {
  it('assigns default export settings', () => {
    const result = sessionSettingsSchema.parse({
      sourceId: 'screen:1:0',
      sourceName: 'Display 1',
      webcamEnabled: false,
    })

    expect(result.exportSettings.format).toBe('webm')
  })
})
