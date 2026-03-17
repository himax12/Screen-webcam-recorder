export const IPC_CHANNELS = {
  listSources: 'recorder:list-sources',
  chooseSaveRoot: 'recorder:choose-save-root',
  createSession: 'recorder:create-session',
  startRecorder: 'recorder:start-recorder',
  appendChunk: 'recorder:append-chunk',
  stopRecorder: 'recorder:stop-recorder',
  finalizeSession: 'recorder:finalize-session',
  exportSession: 'recorder:export-session',
  openSessionFolder: 'recorder:open-session-folder',
  renameSession: 'recorder:rename-session',
  getSession: 'recorder:get-session',
} as const

