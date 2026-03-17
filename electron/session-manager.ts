import fs from 'node:fs'
import { access, copyFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { finished } from 'node:stream/promises'

import { app } from 'electron'
import { execa } from 'execa'
import { v4 as uuidv4 } from 'uuid'

import { resolveBitrateKbps, sanitizeSessionName } from '../src/shared/session-utils.js'
import {
  DEFAULT_EXPORT_SETTINGS,
  type ExportSettings,
  type RecorderStartOptions,
  type RecorderStartResponse,
  type RecorderStopResponse,
  type RecorderStreamType,
  type SessionMetadata,
  type SessionSettings,
} from '../src/shared/types.js'
import { exportSettingsSchema, sessionSettingsSchema } from '../src/shared/validation.js'

type SessionWriters = Partial<Record<RecorderStreamType, fs.WriteStream>>

const METADATA_FILE_NAME = 'session.json'
const require = createRequire(import.meta.url)
const ffmpegStatic = require('ffmpeg-static') as string | null

const timestamp = (): string => new Date().toISOString()

const cloneSession = (session: SessionMetadata): SessionMetadata =>
  JSON.parse(JSON.stringify(session)) as SessionMetadata

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

const getBundledFfmpegPath = (): string | null => {
  const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const packagedPath = path.join(process.resourcesPath, 'ffmpeg', executable)

  if (fs.existsSync(packagedPath)) {
    return packagedPath
  }

  const localBundledPath = path.join(process.cwd(), 'resources', 'ffmpeg', executable)
  if (fs.existsSync(localBundledPath)) {
    return localBundledPath
  }

  if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
    return ffmpegStatic
  }

  return null
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionMetadata>()

  private readonly writers = new Map<string, SessionWriters>()

  private resolveDefaultSaveRoot(): string {
    if (app.isPackaged) {
      return path.join(app.getPath('documents'), 'ScreenRecorder', 'videos')
    }

    return path.join(process.cwd(), 'videos')
  }

  private getMetadataPath(folderPath: string): string {
    return path.join(folderPath, METADATA_FILE_NAME)
  }

  private assertSession(sessionId: string): SessionMetadata {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    return session
  }

  private async closeWriter(writer: fs.WriteStream): Promise<void> {
    if (writer.destroyed) {
      return
    }

    writer.end()
    await finished(writer)
  }

  private async updateMetadata(session: SessionMetadata): Promise<void> {
    session.updatedAt = timestamp()
    await writeFile(
      this.getMetadataPath(session.folderPath),
      JSON.stringify(session, null, 2),
      'utf8',
    )
  }

  async createSession(input: SessionSettings): Promise<SessionMetadata> {
    const parsed = sessionSettingsSchema.parse(input)
    const saveRoot = parsed.saveRoot?.trim()
      ? path.resolve(parsed.saveRoot)
      : this.resolveDefaultSaveRoot()
    const id = uuidv4()
    const now = timestamp()
    const folderPath = path.join(saveRoot, id)
    const name =
      sanitizeSessionName(parsed.sessionName ?? '') ||
      `Recording ${new Date().toLocaleString()}`

    await mkdir(folderPath, { recursive: true })

    const session: SessionMetadata = {
      id,
      name,
      sourceId: parsed.sourceId,
      sourceName: parsed.sourceName,
      webcamEnabled: parsed.webcamEnabled,
      saveRoot,
      folderPath,
      createdAt: now,
      updatedAt: now,
      durationMs: 0,
      files: {},
      exportSettings: parsed.exportSettings ?? DEFAULT_EXPORT_SETTINGS,
      exportStatus: {
        state: 'idle',
        updatedAt: now,
      },
    }

    await this.updateMetadata(session)
    this.sessions.set(id, session)
    return cloneSession(session)
  }

  async startRecorder(
    sessionId: string,
    streamType: RecorderStreamType,
    options?: RecorderStartOptions,
  ): Promise<RecorderStartResponse> {
    void options
    const session = this.assertSession(sessionId)
    const key = streamType === 'screen' ? 'screenPath' : 'webcamPath'
    const filePath = path.join(
      session.folderPath,
      streamType === 'screen' ? 'screen.webm' : 'webcam.webm',
    )
    const existingWriters = this.writers.get(sessionId) ?? {}

    if (existingWriters[streamType]) {
      throw new Error(`${streamType} recorder is already running`)
    }

    await mkdir(path.dirname(filePath), { recursive: true })
    const writer = fs.createWriteStream(filePath, { flags: 'w' })
    existingWriters[streamType] = writer
    this.writers.set(sessionId, existingWriters)

    session.files[key] = filePath
    await this.updateMetadata(session)
    return { filePath }
  }

  async appendChunk(
    sessionId: string,
    streamType: RecorderStreamType,
    chunk: Uint8Array,
  ): Promise<void> {
    const writer = this.writers.get(sessionId)?.[streamType]

    if (!writer) {
      throw new Error(`${streamType} recorder is not running`)
    }

    await new Promise<void>((resolve, reject) => {
      writer.write(Buffer.from(chunk), (error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })
  }

  async stopRecorder(
    sessionId: string,
    streamType: RecorderStreamType,
  ): Promise<RecorderStopResponse> {
    const session = this.assertSession(sessionId)
    const key = streamType === 'screen' ? 'screenPath' : 'webcamPath'
    const targetPath = session.files[key]

    if (!targetPath) {
      throw new Error(`No file path found for stream: ${streamType}`)
    }

    const existingWriters = this.writers.get(sessionId)
    const writer = existingWriters?.[streamType]

    if (writer) {
      await this.closeWriter(writer)
      if (existingWriters) {
        delete existingWriters[streamType]
      }
    }

    await this.updateMetadata(session)
    return { filePath: targetPath }
  }

  async finalizeSession(sessionId: string, durationMs: number): Promise<SessionMetadata> {
    const session = this.assertSession(sessionId)
    const existingWriters = this.writers.get(sessionId)

    if (existingWriters) {
      for (const streamType of ['screen', 'webcam'] as const) {
        const writer = existingWriters[streamType]
        if (writer) {
          await this.closeWriter(writer)
          delete existingWriters[streamType]
        }
      }
    }

    session.durationMs = Math.max(0, Math.floor(durationMs))
    await this.updateMetadata(session)
    return cloneSession(session)
  }

  async openSessionFolder(sessionId: string): Promise<string> {
    const session = this.assertSession(sessionId)
    return session.folderPath
  }

  async renameSession(sessionId: string, inputName: string): Promise<SessionMetadata> {
    const session = this.assertSession(sessionId)
    const sanitized = sanitizeSessionName(inputName)

    if (!sanitized) {
      throw new Error('Session name cannot be empty.')
    }

    const baseDir = path.dirname(session.folderPath)
    const baseCandidate = `${session.id}--${sanitized.replace(/\s+/g, '-')}`
    let nextPath = path.join(baseDir, baseCandidate)
    let suffix = 1

    while (await fileExists(nextPath)) {
      nextPath = path.join(baseDir, `${baseCandidate}-${suffix}`)
      suffix += 1
    }

    const previousFolderPath = session.folderPath
    await rename(previousFolderPath, nextPath)

    session.folderPath = nextPath
    session.name = sanitized

    for (const fileKey of ['screenPath', 'webcamPath', 'finalPath'] as const) {
      const filePath = session.files[fileKey]
      if (filePath && filePath.startsWith(previousFolderPath)) {
        session.files[fileKey] = filePath.replace(previousFolderPath, nextPath)
      }
    }

    await this.updateMetadata(session)
    return cloneSession(session)
  }

  private async runFfmpeg(args: string[]): Promise<void> {
    const bundled = getBundledFfmpegPath()
    const ffmpegExecutable = bundled ?? 'ffmpeg'
    await execa(ffmpegExecutable, args, {
      windowsHide: true,
    })
  }

  async exportSession(sessionId: string, rawSettings: ExportSettings): Promise<SessionMetadata> {
    const session = this.assertSession(sessionId)
    const settings = exportSettingsSchema.parse(rawSettings)
    const outputRoot = settings.customSaveRoot?.trim()
      ? path.resolve(settings.customSaveRoot)
      : session.folderPath

    await mkdir(outputRoot, { recursive: true })

    session.exportSettings = settings
    session.exportStatus = {
      state: 'in_progress',
      updatedAt: timestamp(),
    }
    await this.updateMetadata(session)

    const screenPath = session.files.screenPath
    const webcamPath = session.files.webcamPath
    const hasScreen = Boolean(screenPath && (await fileExists(screenPath)))
    const hasWebcam = Boolean(webcamPath && (await fileExists(webcamPath)))

    try {
      if (settings.format === 'webm') {
        if (outputRoot !== session.folderPath) {
          if (screenPath && hasScreen) {
            await copyFile(screenPath, path.join(outputRoot, 'screen.webm'))
          }

          if (webcamPath && hasWebcam) {
            await copyFile(webcamPath, path.join(outputRoot, 'webcam.webm'))
          }
        }

        session.exportStatus = {
          state: 'success',
          message: outputRoot === session.folderPath
            ? 'WebM files are ready in the session folder.'
            : `WebM files copied to ${outputRoot}`,
          updatedAt: timestamp(),
        }
        await this.updateMetadata(session)
        return cloneSession(session)
      }

      const bitrate = `${resolveBitrateKbps(settings)}k`
      const outputPath = path.join(outputRoot, 'final.mp4')

      if (hasScreen && hasWebcam && settings.mergeStreams && screenPath && webcamPath) {
        await this.runFfmpeg([
          '-y',
          '-i',
          screenPath,
          '-i',
          webcamPath,
          '-filter_complex',
          '[1:v]scale=iw*0.28:ih*0.28[cam];[0:v][cam]overlay=W-w-24:H-h-24[v]',
          '-map',
          '[v]',
          '-map',
          '0:a?',
          '-c:v',
          'libx264',
          '-c:a',
          'aac',
          '-b:v',
          bitrate,
          '-pix_fmt',
          'yuv420p',
          '-shortest',
          outputPath,
        ])
      } else {
        const source = hasScreen ? screenPath : webcamPath
        if (!source) {
          throw new Error('No recording files available to export.')
        }

        await this.runFfmpeg([
          '-y',
          '-i',
          source,
          '-c:v',
          'libx264',
          '-c:a',
          'aac',
          '-b:v',
          bitrate,
          '-pix_fmt',
          'yuv420p',
          outputPath,
        ])
      }

      session.files.finalPath = outputPath
      session.exportStatus = {
        state: 'success',
        message: `Exported final.mp4 to ${outputPath}`,
        updatedAt: timestamp(),
      }
      await this.updateMetadata(session)
      return cloneSession(session)
    } catch (error) {
      session.exportStatus = {
        state: 'failed',
        message: error instanceof Error ? error.message : 'Export failed',
        updatedAt: timestamp(),
      }
      await this.updateMetadata(session)
      return cloneSession(session)
    }
  }

  async getSession(sessionId: string): Promise<SessionMetadata> {
    const session = this.assertSession(sessionId)
    return cloneSession(session)
  }

  async closeAllRecorders(): Promise<void> {
    for (const [sessionId, streamWriters] of this.writers.entries()) {
      for (const streamType of ['screen', 'webcam'] as const) {
        const writer = streamWriters[streamType]
        if (writer) {
          await this.closeWriter(writer)
          delete streamWriters[streamType]
        }
      }

      const session = this.sessions.get(sessionId)
      if (session) {
        await this.updateMetadata(session)
      }
    }
  }
}
