import { contextBridge, ipcRenderer } from 'electron'

import { IPC_CHANNELS } from '../src/shared/ipc.js'
import type { RecorderApi } from '../src/shared/types.js'

const recorderApi: RecorderApi = {
  listSources: () => ipcRenderer.invoke(IPC_CHANNELS.listSources),
  chooseSaveRoot: () => ipcRenderer.invoke(IPC_CHANNELS.chooseSaveRoot),
  createSession: (settings) =>
    ipcRenderer.invoke(IPC_CHANNELS.createSession, settings),
  startRecorder: (sessionId, streamType, options) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.startRecorder,
      sessionId,
      streamType,
      options,
    ),
  appendChunk: (sessionId, streamType, chunk) =>
    ipcRenderer.invoke(IPC_CHANNELS.appendChunk, sessionId, streamType, chunk),
  stopRecorder: (sessionId, streamType) =>
    ipcRenderer.invoke(IPC_CHANNELS.stopRecorder, sessionId, streamType),
  finalizeSession: (sessionId, durationMs) =>
    ipcRenderer.invoke(IPC_CHANNELS.finalizeSession, sessionId, durationMs),
  exportSession: (sessionId, exportSettings) =>
    ipcRenderer.invoke(IPC_CHANNELS.exportSession, sessionId, exportSettings),
  openSessionFolder: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.openSessionFolder, sessionId),
  renameSession: (sessionId, newName) =>
    ipcRenderer.invoke(IPC_CHANNELS.renameSession, sessionId, newName),
  getSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.getSession, sessionId),
}

contextBridge.exposeInMainWorld('recorderApi', recorderApi)

