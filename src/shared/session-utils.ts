import type { ExportSettings } from './types.js'

const BITRATE_MAP: Record<'low' | 'medium' | 'high', number> = {
  low: 1500,
  medium: 3000,
  high: 5000,
}

export const sanitizeSessionName = (name: string): string => {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')

  return cleaned.slice(0, 60)
}

export const resolveBitrateKbps = (settings: ExportSettings): number => {
  if (
    settings.bitrateProfile === 'custom' &&
    typeof settings.customBitrateKbps === 'number'
  ) {
    return settings.customBitrateKbps
  }

  if (settings.bitrateProfile === 'low') {
    return BITRATE_MAP.low
  }

  if (settings.bitrateProfile === 'high') {
    return BITRATE_MAP.high
  }

  return BITRATE_MAP.medium
}

export const formatDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0')
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}
