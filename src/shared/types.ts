export type RecorderStreamType = 'screen' | 'webcam'
export type ExportFormat = 'webm' | 'mp4'
export type BitrateProfile = 'low' | 'medium' | 'high' | 'custom'
export type CaptureRisk = 'safe' | 'warning'

export interface CaptureSource {
  id: string
  name: string
  displayId: string
  type: 'screen' | 'window'
  captureRisk: CaptureRisk
  isSelfCapture: boolean
  thumbnailDataUrl: string
  appIconDataUrl?: string
}

export interface ExportSettings {
  format: ExportFormat
  bitrateProfile: BitrateProfile
  customBitrateKbps?: number
  customSaveRoot?: string
  mergeStreams: boolean
}

export interface SessionSettings {
  sourceId: string
  sourceName: string
  webcamEnabled: boolean
  saveRoot?: string
  sessionName?: string
  exportSettings?: ExportSettings
}

export interface SessionFiles {
  screenPath?: string
  webcamPath?: string
  finalPath?: string
}

export interface ExportStatus {
  state: 'idle' | 'in_progress' | 'success' | 'failed'
  message?: string
  updatedAt: string
}

export interface SessionMetadata {
  id: string
  name: string
  sourceId: string
  sourceName: string
  webcamEnabled: boolean
  saveRoot: string
  folderPath: string
  createdAt: string
  updatedAt: string
  durationMs: number
  files: SessionFiles
  exportSettings: ExportSettings
  exportStatus: ExportStatus
}

export interface RecorderStartOptions {
  mimeType?: string
  bitrateKbps?: number
}

export interface RecorderStartResponse {
  filePath: string
}

export interface RecorderStopResponse {
  filePath: string
}

export interface RecorderApi {
  listSources: () => Promise<CaptureSource[]>
  chooseSaveRoot: () => Promise<string | null>
  createSession: (settings: SessionSettings) => Promise<SessionMetadata>
  startRecorder: (
    sessionId: string,
    streamType: RecorderStreamType,
    options?: RecorderStartOptions,
  ) => Promise<RecorderStartResponse>
  appendChunk: (
    sessionId: string,
    streamType: RecorderStreamType,
    chunk: Uint8Array,
  ) => Promise<void>
  stopRecorder: (
    sessionId: string,
    streamType: RecorderStreamType,
  ) => Promise<RecorderStopResponse>
  finalizeSession: (
    sessionId: string,
    durationMs: number,
  ) => Promise<SessionMetadata>
  exportSession: (
    sessionId: string,
    exportSettings: ExportSettings,
  ) => Promise<SessionMetadata>
  openSessionFolder: (sessionId: string) => Promise<void>
  renameSession: (
    sessionId: string,
    newName: string,
  ) => Promise<SessionMetadata>
  getSession: (sessionId: string) => Promise<SessionMetadata>
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  format: 'webm',
  bitrateProfile: 'medium',
  mergeStreams: true,
}
