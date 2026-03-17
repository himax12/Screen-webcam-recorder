import { z } from 'zod'

import { DEFAULT_EXPORT_SETTINGS } from './types.js'

export const exportSettingsSchema = z.object({
  format: z.enum(['webm', 'mp4']),
  bitrateProfile: z.enum(['low', 'medium', 'high', 'custom']),
  customBitrateKbps: z.number().int().positive().max(50000).optional(),
  customSaveRoot: z.string().trim().optional(),
  mergeStreams: z.boolean().default(true),
})

export const sessionSettingsSchema = z.object({
  sourceId: z.string().min(1),
  sourceName: z.string().min(1),
  webcamEnabled: z.boolean(),
  saveRoot: z.string().trim().optional(),
  sessionName: z.string().trim().optional(),
  exportSettings: exportSettingsSchema.optional().default(DEFAULT_EXPORT_SETTINGS),
})
