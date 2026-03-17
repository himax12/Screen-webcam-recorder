import type { CaptureRisk, CaptureSource } from './types.js'

const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

interface CapturePolicyInput {
  sourceId: string
  sourceName: string
  sourceType: CaptureSource['type']
  appName?: string
  selfMediaSourceId?: string | null
}

interface CapturePolicyResult {
  captureRisk: CaptureRisk
  isSelfCapture: boolean
}

export const assessCapturePolicy = ({
  sourceId,
  sourceName,
  sourceType,
  appName,
  selfMediaSourceId,
}: CapturePolicyInput): CapturePolicyResult => {
  const normalizedSourceName = normalize(sourceName)
  const normalizedAppName = normalize(appName ?? '')
  const mediaIdMatches =
    typeof selfMediaSourceId === 'string' && selfMediaSourceId.length > 0
      ? sourceId === selfMediaSourceId
      : false
  const titleSuggestsSelfWindow =
    sourceType === 'window' &&
    normalizedAppName.length > 0 &&
    normalizedSourceName.includes(normalizedAppName)

  const isSelfCapture = mediaIdMatches || titleSuggestsSelfWindow
  return {
    captureRisk: isSelfCapture ? 'warning' : 'safe',
    isSelfCapture,
  }
}
