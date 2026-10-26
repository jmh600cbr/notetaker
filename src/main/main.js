const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  dialog,
  globalShortcut,
  Notification,
  shell,
  safeStorage,
  systemPreferences,
  powerSaveBlocker,
  powerMonitor,
  net,
} = require('electron');
const { initMain: initAudioLoopback } = require('electron-audio-loopback');
const { Store, sanitizeSettings } = require('./store');
const { transcribeMeeting } = require('./transcribe');
const { summarize, answerQuestion, identifySpeakers, formatTranscript } = require('./summarize');
const { Updater } = require('./updater');
const { claudeCost, deepgramCost } = require('./pricing');

// Must run before the app is ready: enables capturing the computer's audio
// output (what you hear from Zoom/Teams/Meet) without a virtual audio driver.
initAudioLoopback();

// Ctrl/Cmd+Shift+R alone is the browsers' hard-reload, so add Alt/Option.
const SHORTCUT = 'CommandOrControl+Alt+Shift+R';
const APP_ID = 'io.github.jmh600cbr.sidebar';
const ASSETS = path.join(__dirname, '..', '..', 'assets');

let mainWindow = null;
let tray = null;
let store = null;
// The meeting being recorded, from the moment it's created until it's
// stopped or discarded (including the seconds while capture is starting).
let activeRecordingId = null;
let recordingInfo = { systemAudio: true, micAudio: true };
let sleepBlocker = null;
let isQuitting = false;
let updater = null;

const isRecording = () => activeRecordingId !== null;
const MIN_FREE_BYTES = 300 * 1024 * 1024;

// A second launch (e.g. clicking the desktop shortcut while Sidebar sits in
// the tray) must exit before doing anything, or it would mark the running
// instance's recording as interrupted.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.exit(0);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

function showWindow() {
  if (!mainWindow) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

// Start/stop from the tray or keyboard shortcut. Runs as a user gesture
// because capturing computer audio requires one.
function toggleRecording() {
  if (!mainWindow) createWindow();
  mainWindow.webContents
    .executeJavaScript('window.sidebarToggle && window.sidebarToggle()', true)
    .catch((err) => console.error('Toggle failed', err));
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: 'Sidebar',
    backgroundColor: '#0f1420',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    icon: path.join(ASSETS, 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep recording at full speed while the window is hidden.
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  mainWindow.removeMenu();
  // Windows logoff/shutdown: don't start installing an update mid-shutdown.
  mainWindow.on('session-end', () => updater && updater.onSessionEnd());

  // Grant only what Sidebar uses (microphone/computer audio, notifications,
  // copying notes), and only to its own page.
  const allowed = new Set(['media', 'display-capture', 'notifications', 'clipboard-sanitized-write']);
  const ownPage = (webContents) => webContents === mainWindow.webContents;
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(ownPage(webContents) && allowed.has(permission));
  });
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    return Boolean(webContents) && ownPage(webContents) && allowed.has(permission);
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    const openedAtLogin =
      process.argv.includes('--hidden') ||
      (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
    if (!openedAtLogin) mainWindow.show();
  });

  // Closing the window keeps Sidebar running in the tray / menu bar.
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Links in notes open in the user's browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  // If the window's process dies, the recording it was running stops. Don't
  // pretend otherwise: keep the audio, tell the user, and bring the window back.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    if (activeRecordingId) {
      const id = activeRecordingId;
      setRecording(null);
      try {
        store.updateMeeting(id, {
          status: 'error',
          error: 'Sidebar stopped unexpectedly during this recording. The audio up to that point is saved: click "Retry" to make notes.',
        });
      } catch {
        // meeting gone
      }
      notify('Sidebar stopped recording', 'Something went wrong and the recording stopped. The audio so far is saved.', id);
      showWindow();
    }
    if (!mainWindow.isDestroyed()) mainWindow.reload();
  });
}

function setRecording(id) {
  activeRecordingId = id;
  // Keep the computer awake while recording (an in-person hearing can run
  // past the idle-sleep timer with nobody touching the laptop).
  if (id && sleepBlocker === null) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!id && sleepBlocker !== null) {
    powerSaveBlocker.stop(sleepBlocker);
    sleepBlocker = null;
  }
  refreshTray();
}

function trayImage(recording) {
  const mac = process.platform === 'darwin';
  const name = recording ? 'trayRecording.png' : mac ? 'trayTemplate.png' : 'tray.png';
  const image = nativeImage.createFromPath(path.join(ASSETS, name));
  if (mac && !recording) image.setTemplateImage(true);
  return image;
}

function refreshTray() {
  if (!tray) return;
  const recording = isRecording();
  const partial = recording && (!recordingInfo.systemAudio || !recordingInfo.micAudio);
  tray.setImage(trayImage(recording));
  tray.setToolTip(
    !recording ? 'Sidebar' : partial ? `Sidebar — recording ${recordingInfo.systemAudio ? 'call audio only' : 'microphone only'}` : 'Sidebar — recording',
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(partial ? [{ label: recordingInfo.systemAudio ? '⚠ Microphone not recorded' : '⚠ Call audio not recorded', enabled: false }] : []),
      {
        label: recording ? 'Stop recording' : 'Start recording',
        accelerator: SHORTCUT,
        click: toggleRecording,
      },
      { label: 'Open Sidebar', click: showWindow },
      { type: 'separator' },
      { label: 'Quit Sidebar', click: () => app.quit() },
    ]),
  );
}

function createTray() {
  tray = new Tray(trayImage(false));
  tray.on('click', () => {
    if (process.platform !== 'darwin') showWindow();
  });
  refreshTray();
}

// Keep notifications referenced until they're dismissed, otherwise their
// click handlers can be garbage-collected.
const liveNotifications = new Set();

function notify(title, body, meetingId) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  liveNotifications.add(n);
  n.on('click', () => {
    liveNotifications.delete(n);
    showWindow();
    if (meetingId) send('meetings:open', meetingId);
  });
  n.on('close', () => liveNotifications.delete(n));
  n.show();
}

function broadcastMeeting(meeting) {
  send('meetings:updated', meeting);
  return meeting;
}

// ---- processing pipeline: transcribe -> summarize -> clean up ----

const processing = new Set();

async function processMeeting(id) {
  if (processing.has(id)) return;
  processing.add(id);
  const settings = store.getSettings();
  const onUsage = (usage) => store.addCost(id, { ai: claudeCost(usage) });
  try {
    let meeting = store.getMeeting(id);
    let segments = store.getTranscript(id);
    let keepAudio = settings.keepAudio;

    if (!store.hasTranscript(id)) {
      const files = store.audioFiles(id);
      if (!files.length) throw new Error('The audio for this meeting is no longer available.');
      broadcastMeeting(store.updateMeeting(id, { status: 'transcribing', error: null }));
      const result = await transcribeMeeting(files, {
        apiKey: settings.deepgramApiKey,
        language: settings.language,
        keyterms: meeting.keyterms,
        headphones: settings.headphones,
        // Chromium's network stack: honours system proxies and has no
        // 5-minute limit, so long hearings on slow connections still upload.
        fetchImpl: (url, init) => net.fetch(url, init),
      });
      segments = result.segments;
      store.saveTranscript(id, segments);
      store.addCost(id, { transcription: deepgramCost(result.billedSeconds, settings.deepgramPerMinute) });

      // If far less audio reached the file than the time spent recording,
      // capture failed somewhere. Say so, and keep the audio for checking.
      let warning = null;
      const recorded = meeting.durationSec || 0;
      if (recorded > 60 && result.durationSec < recorded * 0.8 - 30) {
        warning = `Only ${humanDuration(result.durationSec)} of the ${humanDuration(recorded)} recording reached the audio file. Parts of the meeting may be missing from these notes; the audio has been kept.`;
        keepAudio = true;
      }
      meeting = store.updateMeeting(id, {
        speakers: result.speakers,
        durationSec: result.durationSec || meeting.durationSec,
        recordedSec: recorded || null,
        warning,
      });

      if (!segments.length) {
        // Nothing was said (or nothing was captured). Not something Retry can
        // fix, so finish here and keep the audio so the user can check it.
        meeting = store.updateMeeting(id, {
          status: 'ready',
          error: null,
          summary: '_No speech was detected in this recording. If you expected speech, check that the microphone and call audio were working; the audio has been kept._',
        });
        broadcastMeeting(meeting);
        notify('No speech detected', meeting.title, id);
        return;
      }

      // Put names to voices. Nice to have, so a failure here never blocks the notes.
      broadcastMeeting(store.updateMeeting(id, { status: 'identifying' }));
      try {
        const names = await identifySpeakers({ apiKey: settings.anthropicApiKey, meeting, segments, onUsage });
        // The user may have renamed speakers while we waited; their names win.
        const current = store.getMeeting(id).speakers || {};
        const speakers = { ...current };
        for (const [key, name] of Object.entries(names)) {
          if (current[key] === result.speakers[key]) speakers[key] = name;
        }
        store.updateMeeting(id, { speakers });
      } catch (err) {
        console.warn('Speaker identification failed:', err.message);
      }
    }

    broadcastMeeting(store.updateMeeting(id, { status: 'summarizing', error: null }));
    // Re-read so speaker names and note style edited during processing are used.
    meeting = store.getMeeting(id);
    const summary = await summarize({ apiKey: settings.anthropicApiKey, meeting, segments, onUsage });
    meeting = store.updateMeeting(id, { summary, status: 'ready', error: null });

    if (!keepAudio && !meeting.warning) meeting = store.deleteAudio(id);
    broadcastMeeting(meeting);
    notify('Your notes are ready', meeting.title, id);
  } catch (err) {
    try {
      // Existing notes (e.g. when regenerating) stay as they are.
      broadcastMeeting(store.updateMeeting(id, { status: 'error', error: err.message }));
      notify('Sidebar couldn’t finish your notes', err.message, id);
    } catch {
      // The meeting was deleted while processing.
    }
  } finally {
    processing.delete(id);
  }
}

function meetingToMarkdown(meeting, segments) {
  const date = new Date(meeting.createdAt).toLocaleString();
  return [
    `# ${meeting.title}`,
    '',
    `_${date} · ${Math.max(1, Math.round((meeting.durationSec || 0) / 60))} min · Notes by Sidebar_`,
    '',
    meeting.summary || '_No summary yet._',
    '',
    '---',
    '',
    '## Transcript',
    '',
    formatTranscript(segments, meeting.speakers || {})
      .split('\n')
      .map((line) => `${line}  `)
      .join('\n'),
    '',
  ].join('\n');
}

// ---- IPC ----

function registerIpc() {
  // The UI never receives the API keys themselves, only whether they're set.
  ipcMain.handle('settings:get', () => ({
    ...store.getPublicSettings(),
    platform: process.platform,
    shortcut: SHORTCUT,
    encrypted: store.canEncrypt(),
    costs: store.getCostSummary(),
  }));

  ipcMain.handle('settings:save', (_e, patch) => {
    const saved = store.saveSettings(patch);
    if ('openAtLogin' in patch) {
      app.setLoginItemSettings({ openAtLogin: Boolean(patch.openAtLogin), args: ['--hidden'] });
    }
    return saved;
  });

  // Team setup: an admin exports a config file once and shares it privately;
  // teammates import it instead of pasting keys.
  ipcMain.handle('settings:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Import team setup',
      filters: [{ name: 'Sidebar setup', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths[0]) return null;
    const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    const allowed = ['deepgramApiKey', 'anthropicApiKey', 'defaultTemplate', 'language', 'headphones', 'keepAudio'];
    const patch = sanitizeSettings(Object.fromEntries(Object.entries(data).filter(([k]) => allowed.includes(k))));
    if (!Object.keys(patch).length) throw new Error('Not a Sidebar setup file');

    // A setup file decides where meeting audio and transcripts are sent, so
    // show exactly what it changes before applying it.
    const labels = {
      deepgramApiKey: 'Deepgram key (transcription) will be replaced',
      anthropicApiKey: 'Anthropic key (summaries) will be replaced',
      defaultTemplate: `Default note style: ${patch.defaultTemplate}`,
      language: `Spoken language: ${patch.language}`,
      headphones: `Headphones mode: ${patch.headphones ? 'on' : 'off'}`,
      keepAudio: `Keep audio after notes: ${patch.keepAudio ? 'on' : 'off'}`,
    };
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Import', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: 'Import this team setup?',
      detail: `${Object.keys(patch).map((k) => `• ${labels[k]}`).join('\n')}\n\nOnly import setup files from someone you trust: meeting audio and transcripts are sent to the accounts these keys belong to.`,
    });
    if (response !== 0) return null;
    return store.saveSettings(patch);
  });

  ipcMain.handle('settings:export', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export team setup',
      defaultPath: 'sidebar-team-setup.json',
    });
    if (canceled || !filePath) return false;
    const s = store.getSettings({ includeEnv: false });
    const data = {
      deepgramApiKey: s.deepgramApiKey,
      anthropicApiKey: s.anthropicApiKey,
      defaultTemplate: s.defaultTemplate,
      language: s.language,
      headphones: s.headphones,
      keepAudio: s.keepAudio,
    };
    // Contains API keys: readable by the current user only.
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    return true;
  });

  ipcMain.handle('permissions:check', async () => {
    if (process.platform !== 'darwin') return { microphone: true, screen: 'granted' };
    const microphone = await systemPreferences.askForMediaAccess('microphone');
    return { microphone, screen: systemPreferences.getMediaAccessStatus('screen') };
  });

  ipcMain.handle('permissions:openSettings', (_e, kind) => {
    if (process.platform === 'darwin') {
      const pane = kind === 'microphone' ? 'Privacy_Microphone' : 'Privacy_ScreenCapture';
      shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
    } else if (process.platform === 'win32') {
      shell.openExternal('ms-settings:privacy-microphone');
    }
  });

  ipcMain.handle('meetings:list', () => store.listMeetings());

  ipcMain.handle('meetings:get', (_e, id) => ({
    meeting: store.getMeeting(id),
    transcript: store.getTranscript(id),
  }));

  ipcMain.handle('meetings:update', (_e, id, patch) => {
    const allowed = {};
    if (typeof patch.title === 'string') allowed.title = patch.title.slice(0, 200);
    if (patch.speakers && typeof patch.speakers === 'object') allowed.speakers = patch.speakers;
    if (typeof patch.template === 'string') allowed.template = patch.template;
    return broadcastMeeting(store.updateMeeting(id, allowed));
  });

  ipcMain.handle('meetings:delete', async (_e, id) => {
    if (processing.has(id)) {
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        message: 'This meeting is still being processed.',
        detail: 'You can delete it once the notes are ready or processing stops.',
      });
      return false;
    }
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Delete this meeting?',
      detail: 'The notes, transcript and any saved audio will be permanently removed.',
    });
    if (response !== 0) return false;
    store.deleteMeeting(id);
    return true;
  });

  ipcMain.handle('meetings:retry', (_e, id) => {
    processMeeting(id);
    return true;
  });

  // The current notes stay until the new ones succeed.
  ipcMain.handle('meetings:resummarize', (_e, id) => {
    processMeeting(id);
    return true;
  });

  ipcMain.handle('meetings:ask', async (_e, id, question) => {
    const settings = store.getSettings();
    return answerQuestion({
      apiKey: settings.anthropicApiKey,
      meeting: store.getMeeting(id),
      segments: store.getTranscript(id),
      question: String(question).slice(0, 2000),
      onUsage: (usage) => broadcastMeeting(store.addCost(id, { ai: claudeCost(usage) }) || store.getMeeting(id)),
    });
  });

  ipcMain.handle('meetings:export', async (_e, id) => {
    const meeting = store.getMeeting(id);
    const safeName = safeFileName(meeting.title);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export notes',
      defaultPath: `${safeName}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (canceled || !filePath) return false;
    fs.writeFileSync(filePath, meetingToMarkdown(meeting, store.getTranscript(id)));
    shell.showItemInFolder(filePath);
    return true;
  });

  ipcMain.handle('meetings:copyText', (_e, id) => {
    return meetingToMarkdown(store.getMeeting(id), store.getTranscript(id));
  });

  ipcMain.handle('recording:start', (_e, opts) => {
    if (activeRecordingId) throw new Error('Sidebar is already recording.');
    const free = store.freeSpace();
    if (free !== null && free < MIN_FREE_BYTES) {
      throw new Error(`Your disk is almost full (${Math.round(free / 1048576)} MB free). Free up some space and try again.`);
    }
    const settings = store.getSettings();
    const meeting = store.createMeeting({
      title: String(opts.title || '').slice(0, 200),
      template: ['court', 'client', 'general'].includes(opts.template) ? opts.template : settings.defaultTemplate,
      keyterms: (Array.isArray(opts.keyterms) ? opts.keyterms : []).map(String).slice(0, 50),
    });
    recordingInfo = { systemAudio: true, micAudio: true };
    setRecording(meeting.id);
    return broadcastMeeting(meeting);
  });

  ipcMain.handle('recording:chunk', (_e, id, part, data) => {
    if (!Number.isInteger(part) || part < 0 || part > 999) throw new Error('Invalid audio part');
    store.appendAudio(id, part, Buffer.from(data));
    return true;
  });

  ipcMain.handle('recording:stop', (_e, id, durationSec, { quitting = false, unsaved = 0 } = {}) => {
    if (activeRecordingId === id) setRecording(null);
    const patch = { durationSec: Math.round(durationSec || 0) };
    if (unsaved) {
      patch.warning = `About ${unsaved} seconds of audio at the end couldn't be saved (the disk may be full).`;
    }
    if (quitting) {
      // Don't start uploading while the app is closing.
      broadcastMeeting(store.updateMeeting(id, {
        ...patch,
        status: 'error',
        error: 'Sidebar was closed during this recording. The audio is saved: click "Retry" to make notes.',
      }));
      return true;
    }
    broadcastMeeting(store.updateMeeting(id, patch));
    processMeeting(id);
    return true;
  });

  ipcMain.handle('recording:discard', (_e, id) => {
    if (activeRecordingId === id) setRecording(null);
    store.deleteMeeting(id);
    return true;
  });

  ipcMain.on('window:show', showWindow);

  // What's being captured right now. If the call audio or the microphone is
  // missing, make sure the user knows even with the window hidden.
  ipcMain.on('recording:info', (_e, info) => {
    const before = recordingInfo;
    recordingInfo = { systemAudio: Boolean(info.systemAudio), micAudio: Boolean(info.micAudio) };
    refreshTray();
    const visible = mainWindow && mainWindow.isVisible() && mainWindow.isFocused();
    if (info.started && !visible) {
      notify('Sidebar is recording', `Press ${shortcutLabel()} to stop.`);
    }
    if (!recordingInfo.systemAudio && (before.systemAudio || info.started)) {
      notify('Call audio is NOT being recorded', 'Only your microphone is being recorded, so other people on the call may be missing.');
      showWindow();
    } else if (!recordingInfo.micAudio && (before.micAudio || info.started)) {
      notify('Your microphone is NOT being recorded', 'Only the call audio is being recorded, so your own voice will be missing.');
      showWindow();
    }
  });

  // Problems during a recording: devices dropping out, audio not saving.
  ipcMain.on('recording:fault', (_e, fault) => {
    if (fault.kind === 'disk' && !fault.recovered) {
      notify('Sidebar can’t save audio', `${fault.error || 'Saving failed'}. It keeps the audio in memory and keeps trying. Free up disk space if your disk is full.`);
      showWindow();
    } else if (fault.kind === 'capture' && fault.recovered) {
      notify('Recording reconnected', 'An audio device changed or dropped out. Sidebar reconnected and is still recording.');
    } else if (fault.kind === 'capture') {
      notify('Recording stopped', `Sidebar lost the audio and couldn't reconnect (${fault.reason}). The audio up to that point is saved.`);
      showWindow();
    }
  });

  ipcMain.handle('updater:get', () => (updater ? updater.state : { status: 'idle' }));
  ipcMain.handle('updater:check', () => (updater ? updater.check(true) : { status: 'idle' }));
  ipcMain.handle('updater:install', () => {
    if (!updater) return { ok: false };
    // Downloading is fine any time; only the restart has to wait.
    if (updater.state.status === 'ready' && !canRestart()) {
      return { ok: false, reason: 'You can restart to update once your recording and notes are finished.' };
    }
    updater.install();
    return { ok: true };
  });

  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url);
  });
}

// ---- app lifecycle ----

// Restarting for an update must never cut off a recording or notes in progress.
function canRestart() {
  return !isRecording() && processing.size === 0;
}

function shortcutLabel() {
  return process.platform === 'darwin' ? '⌥⇧⌘R' : 'Ctrl+Alt+Shift+R';
}

function humanDuration(sec) {
  return sec < 90 ? `${Math.round(sec)} seconds` : `${Math.round(sec / 60)} minutes`;
}

// A file name that keeps accents and other scripts but is valid on Windows
// and macOS.
function safeFileName(title) {
  let name = String(title)
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120);
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) name = `_${name}`;
  return name || 'meeting-notes';
}

app.on('second-instance', showWindow);

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
  store = new Store(app.getPath('userData'), safeStorage);
  store.recoverInterrupted();
  registerIpc();
  createWindow();
  createTray();

  updater = new Updater({
    onState: (state) => send('updater:state', state),
    beforeInstall: () => {
      isQuitting = true;
    },
    installFailed: () => {
      isQuitting = false;
    },
    canRestart,
  });
  updater.start();

  if (!globalShortcut.register(SHORTCUT, toggleRecording)) {
    console.warn(`Could not register ${SHORTCUT}; another app is using it.`);
  }

  app.on('activate', showWindow);

  // After sleep the audio devices may be gone; the recorder notices dead
  // devices itself, but ask it to check right away.
  powerMonitor.on('resume', () => {
    if (isRecording() && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript('window.sidebarCheckRecording && window.sidebarCheckRecording()').catch(() => {});
    }
  });
});

app.on('before-quit', (event) => {
  if (isRecording() && !isQuitting) {
    event.preventDefault();
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Keep recording', 'Stop and quit'],
      defaultId: 0,
      cancelId: 0,
      message: 'Sidebar is still recording.',
      detail: 'If you quit now, the recording is stopped and saved. You can make its notes next time you open Sidebar.',
    });
    if (choice === 0) return;
    // Let the recorder save its last few seconds before quitting.
    isQuitting = true;
    const done = () => app.quit();
    const timer = setTimeout(done, 10000);
    mainWindow.webContents
      .executeJavaScript('window.sidebarStopForQuit ? window.sidebarStopForQuit() : null')
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        done();
      });
    return;
  }
  isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Mac: an update staged during a recording goes in now, for next launch.
  if (updater) updater.applyOnQuit();
});

// Stay alive in the tray when the window is closed.
app.on('window-all-closed', () => {});
