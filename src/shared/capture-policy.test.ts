import { describe, expect, it } from 'vitest'

import { assessCapturePolicy } from './capture-policy.js'

describe('assessCapturePolicy', () => {
  it('marks source as warning when source id matches current app media id', () => {
    const result = assessCapturePolicy({
      sourceId: 'window:123:0',
      sourceName: 'Recorder',
      sourceType: 'window',
      appName: 'screen-webcam-recorder',
      selfMediaSourceId: 'window:123:0',
    })

    expect(result.captureRisk).toBe('warning')
    expect(result.isSelfCapture).toBe(true)
  })

  it('marks source as warning when app title matches a window name', () => {
    const result = assessCapturePolicy({
      sourceId: 'window:888:0',
      sourceName: 'Screen Webcam Recorder',
      sourceType: 'window',
      appName: 'screen-webcam-recorder',
      selfMediaSourceId: '',
    })

    expect(result.captureRisk).toBe('warning')
    expect(result.isSelfCapture).toBe(true)
  })

  it('keeps non-app windows as safe', () => {
    const result = assessCapturePolicy({
      sourceId: 'window:778:0',
      sourceName: 'Visual Studio Code',
      sourceType: 'window',
      appName: 'screen-webcam-recorder',
      selfMediaSourceId: 'window:123:0',
    })

    expect(result.captureRisk).toBe('safe')
    expect(result.isSelfCapture).toBe(false)
  })
})
