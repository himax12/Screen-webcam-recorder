import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BrowserWindow,
  app,
  desktopCapturer,
  dialog,
  ipcMain,
  session,
  shell,
  type OpenDialogOptions,
} from 'electron'

import { IPC_CHANNELS } from '../src/shared/ipc.js'
import { assessCapturePolicy } from '../src/shared/capture-policy.js'
import type {
  CaptureSource,
  RecorderStartOptions,
  RecorderStreamType,
  SessionSettings,
} from '../src/shared/types.js'
import { SessionManager } from './session-manager.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let mainWindow: BrowserWindow | null = null
const sessionManager = new SessionManager()
const distIndexPath = path.join(__dirname, '../../dist/index.html')

const loadRenderer = async (window: BrowserWindow): Promise<void> => {
  const explicitDevServerUrl =
    process.env.ELECTRON_RENDERER_URL ?? process.env.VITE_DEV_SERVER_URL

  if (app.isPackaged || !explicitDevServerUrl) {
    await window.loadFile(distIndexPath)
    return
  }

  try {
    await window.loadURL(explicitDevServerUrl)
    if (explicitDevServerUrl.includes('localhost')) {
      window.webContents.openDevTools({ mode: 'detach' })
    }
  } catch {
    await window.loadFile(distIndexPath)
  }
}

const createMainWindow = async (): Promise<void> => {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0d1216',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  await loadRenderer(mainWindow)
}

const mapSource = (
  source: Electron.DesktopCapturerSource,
  appName: string,
  selfMediaSourceId: string,
): CaptureSource => {
  const sourceType: CaptureSource['type'] = source.id.startsWith('screen:')
    ? 'screen'
    : 'window'
  const capturePolicy = assessCapturePolicy({
    sourceId: source.id,
    sourceName: source.name,
    sourceType,
    appName,
    selfMediaSourceId,
  })

  return {
    id: source.id,
    name: source.name,
    displayId: source.display_id || '',
    type: sourceType,
    captureRisk: capturePolicy.captureRisk,
    isSelfCapture: capturePolicy.isSelfCapture,
    thumbnailDataUrl: source.thumbnail.toDataURL(),
    appIconDataUrl: source.appIcon?.toDataURL(),
  }
}

const registerIpcHandlers = (): void => {
  ipcMain.handle(IPC_CHANNELS.listSources, async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      fetchWindowIcons: true,
      thumbnailSize: {
        width: 480,
        height: 270,
      },
    })
    const appName = app.getName()
    const selfMediaSourceId = ''

    return sources
      .map((source) => mapSource(source, appName, selfMediaSourceId))
      .sort((left, right) => {
        if (left.captureRisk !== right.captureRisk) {
          return left.captureRisk === 'safe' ? -1 : 1
        }

        if (left.type !== right.type) {
          return left.type === 'screen' ? -1 : 1
        }

        return left.name.localeCompare(right.name)
      })
  })

  ipcMain.handle(IPC_CHANNELS.chooseSaveRoot, async () => {
    const dialogOptions: OpenDialogOptions = {
      title: 'Choose recording save location',
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    return result.filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.createSession, async (_event, settings: SessionSettings) =>
    sessionManager.createSession(settings),
  )

  ipcMain.handle(
    IPC_CHANNELS.startRecorder,
    async (
      _event,
      sessionId: string,
      streamType: RecorderStreamType,
      options?: RecorderStartOptions,
    ) => sessionManager.startRecorder(sessionId, streamType, options),
  )

  ipcMain.handle(
    IPC_CHANNELS.appendChunk,
    async (
      _event,
      sessionId: string,
      streamType: RecorderStreamType,
      chunk: Uint8Array,
    ) => sessionManager.appendChunk(sessionId, streamType, chunk),
  )

  ipcMain.handle(
    IPC_CHANNELS.stopRecorder,
    async (_event, sessionId: string, streamType: RecorderStreamType) =>
      sessionManager.stopRecorder(sessionId, streamType),
  )

  ipcMain.handle(
    IPC_CHANNELS.finalizeSession,
    async (_event, sessionId: string, durationMs: number) =>
      sessionManager.finalizeSession(sessionId, durationMs),
  )

  ipcMain.handle(
    IPC_CHANNELS.exportSession,
    async (_event, sessionId: string, exportSettings) =>
      sessionManager.exportSession(sessionId, exportSettings),
  )

  ipcMain.handle(IPC_CHANNELS.openSessionFolder, async (_event, sessionId: string) => {
    const folder = await sessionManager.openSessionFolder(sessionId)
    await shell.openPath(folder)
  })

  ipcMain.handle(
    IPC_CHANNELS.renameSession,
    async (_event, sessionId: string, newName: string) =>
      sessionManager.renameSession(sessionId, newName),
  )

  ipcMain.handle(IPC_CHANNELS.getSession, async (_event, sessionId: string) =>
    sessionManager.getSession(sessionId),
  )
}

app.commandLine.appendSwitch('enable-usermedia-screen-capturing')

app.whenReady().then(async () => {
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    const permissionName = permission as string
    if (permissionName === 'media' || permissionName === 'display-capture') {
      return true
    }

    return false
  })

  session.defaultSession.setPermissionRequestHandler((_, permission, callback) => {
    if (permission === 'media' || permission === 'display-capture') {
      callback(true)
      return
    }

    callback(false)
  })

  registerIpcHandlers()
  await createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow()
    }
  })
})

app.on('before-quit', () => {
  void sessionManager.closeAllRecorders()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
