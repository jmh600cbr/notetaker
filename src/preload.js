// The only bridge between the UI and the rest of the app.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('sidebar', {
  // System audio capture (electron-audio-loopback's IPC channels).
  enableLoopbackAudio: () => invoke('enable-loopback-audio'),
  disableLoopbackAudio: () => invoke('disable-loopback-audio'),

  getSettings: () => invoke('settings:get'),
  saveSettings: (patch) => invoke('settings:save', patch),
  importSettings: () => invoke('settings:import'),
  exportSettings: () => invoke('settings:export'),
  checkPermissions: () => invoke('permissions:check'),
  openPermissionSettings: (kind) => invoke('permissions:openSettings', kind),

  listMeetings: () => invoke('meetings:list'),
  getMeeting: (id) => invoke('meetings:get', id),
  updateMeeting: (id, patch) => invoke('meetings:update', id, patch),
  deleteMeeting: (id) => invoke('meetings:delete', id),
  retryMeeting: (id) => invoke('meetings:retry', id),
  resummarize: (id) => invoke('meetings:resummarize', id),
  ask: (id, question) => invoke('meetings:ask', id, question),
  exportMeeting: (id) => invoke('meetings:export', id),
  meetingText: (id) => invoke('meetings:copyText', id),

  startRecording: (opts) => invoke('recording:start', opts),
  sendChunk: (id, data) => invoke('recording:chunk', id, data),
  stopRecording: (id, durationSec) => invoke('recording:stop', id, durationSec),
  discardRecording: (id) => invoke('recording:discard', id),
  setRecordingState: (recording) => ipcRenderer.send('recording:state', recording),

  openExternal: (url) => invoke('shell:openExternal', url),
  showWindow: () => ipcRenderer.send('window:show'),

  onMeetingUpdated: (cb) => on('meetings:updated', cb),
  onOpenMeeting: (cb) => on('meetings:open', cb),
});
