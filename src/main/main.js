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
} = require('electron');
const { initMain: initAudioLoopback } = require('electron-audio-loopback');
const { Store } = require('./store');
const { transcribeFile } = require('./transcribe');
const { summarize, answerQuestion, identifySpeakers, formatTranscript } = require('./summarize');
const { Updater } = require('./updater');

// Must run before the app is ready: enables capturing the computer's audio
// output (what you hear from Zoom/Teams/Meet) without a virtual audio driver.
initAudioLoopback();

const SHORTCUT = 'CommandOrControl+Shift+R';
const ASSETS = path.join(__dirname, '..', '..', 'assets');

let mainWindow = null;
let tray = null;
let store = null;
let isRecording = false;
let isQuitting = false;
let updater = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

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
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) mainWindow.show();
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
  tray.setImage(trayImage(isRecording));
  tray.setToolTip(isRecording ? 'Sidebar — recording' : 'Sidebar');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: isRecording ? 'Stop recording' : 'Start recording',
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

function notify(title, body, meetingId) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => {
    showWindow();
    if (meetingId) send('meetings:open', meetingId);
  });
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
  try {
    let meeting = store.getMeeting(id);
    let segments = store.getTranscript(id);

    if (!segments.length) {
      if (!fs.existsSync(store.audioPath(id))) {
        throw new Error('The audio for this meeting is no longer available.');
      }
      broadcastMeeting(store.updateMeeting(id, { status: 'transcribing', error: null }));
      const result = await transcribeFile(store.audioPath(id), {
        apiKey: settings.deepgramApiKey,
        language: settings.language,
        keyterms: meeting.keyterms,
        headphones: settings.headphones,
      });
      segments = result.segments;
      store.saveTranscript(id, segments);
      meeting = store.updateMeeting(id, {
        speakers: result.speakers,
        durationSec: result.durationSec || meeting.durationSec,
      });

      // Put names to voices. Nice to have, so a failure here never blocks the notes.
      broadcastMeeting(store.updateMeeting(id, { status: 'identifying' }));
      try {
        const names = await identifySpeakers({ apiKey: settings.anthropicApiKey, meeting, segments });
        meeting = store.updateMeeting(id, { speakers: { ...meeting.speakers, ...names } });
      } catch (err) {
        console.warn('Speaker identification failed:', err.message);
      }
    }

    broadcastMeeting(store.updateMeeting(id, { status: 'summarizing', error: null }));
    const summary = await summarize({ apiKey: settings.anthropicApiKey, meeting, segments });
    meeting = store.updateMeeting(id, { summary, status: 'ready', error: null });

    if (!settings.keepAudio) meeting = store.deleteAudio(id);
    broadcastMeeting(meeting);
    notify('Your notes are ready', meeting.title, id);
  } catch (err) {
    broadcastMeeting(store.updateMeeting(id, { status: 'error', error: err.message }));
    notify('Sidebar couldn’t finish your notes', err.message, id);
  } finally {
    processing.delete(id);
  }
}

function meetingToMarkdown(meeting, segments) {
  const date = new Date(meeting.createdAt).toLocaleString();
  return [
    `# ${meeting.title}`,
    '',
    `_${date} · ${Math.round((meeting.durationSec || 0) / 60)} min · Notes by Sidebar_`,
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
  ipcMain.handle('settings:get', () => ({
    ...store.getSettings(),
    platform: process.platform,
    shortcut: SHORTCUT,
    encrypted: store.canEncrypt(),
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
    const patch = Object.fromEntries(Object.entries(data).filter(([k]) => allowed.includes(k)));
    return store.saveSettings(patch);
  });

  ipcMain.handle('settings:export', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export team setup',
      defaultPath: 'sidebar-team-setup.json',
    });
    if (canceled || !filePath) return false;
    const s = store.getSettings();
    const data = {
      deepgramApiKey: s.deepgramApiKey,
      anthropicApiKey: s.anthropicApiKey,
      defaultTemplate: s.defaultTemplate,
      language: s.language,
      headphones: s.headphones,
      keepAudio: s.keepAudio,
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
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

  ipcMain.handle('meetings:resummarize', (_e, id) => {
    broadcastMeeting(store.updateMeeting(id, { summary: '' }));
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
    });
  });

  ipcMain.handle('meetings:export', async (_e, id) => {
    const meeting = store.getMeeting(id);
    const safeName = meeting.title.replace(/[^\w\- ]+/g, '').trim() || 'meeting-notes';
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
    const settings = store.getSettings();
    const meeting = store.createMeeting({
      title: opts.title,
      template: opts.template || settings.defaultTemplate,
      keyterms: (opts.keyterms || []).slice(0, 50),
    });
    return broadcastMeeting(meeting);
  });

  ipcMain.handle('recording:chunk', (_e, id, data) => {
    store.appendAudio(id, Buffer.from(data));
    return true;
  });

  ipcMain.handle('recording:stop', (_e, id, durationSec) => {
    broadcastMeeting(store.updateMeeting(id, { durationSec: Math.round(durationSec || 0) }));
    processMeeting(id);
    return true;
  });

  ipcMain.handle('recording:discard', (_e, id) => {
    store.deleteMeeting(id);
    return true;
  });

  ipcMain.on('window:show', showWindow);

  ipcMain.on('recording:state', (_e, recording) => {
    isRecording = Boolean(recording);
    refreshTray();
  });

  ipcMain.handle('updater:get', () => (updater ? updater.state : { status: 'idle' }));
  ipcMain.handle('updater:check', () => (updater ? updater.check(true) : { status: 'idle' }));
  ipcMain.handle('updater:install', () => {
    // Never restart in the middle of a recording.
    if (isRecording || !updater) return false;
    updater.install();
    return true;
  });

  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url);
  });
}

// ---- app lifecycle ----

app.on('second-instance', showWindow);

app.whenReady().then(() => {
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
  });
  updater.start();

  if (!globalShortcut.register(SHORTCUT, toggleRecording)) {
    console.warn(`Could not register ${SHORTCUT}; another app is using it.`);
  }

  app.on('activate', showWindow);
});

app.on('before-quit', (event) => {
  if (isRecording && !isQuitting) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Keep recording', 'Quit anyway'],
      defaultId: 0,
      cancelId: 0,
      message: 'Sidebar is still recording.',
      detail: 'If you quit now, the audio recorded so far is kept and you can process it next time you open Sidebar.',
    });
    if (choice === 0) {
      event.preventDefault();
      return;
    }
  }
  isQuitting = true;
});

app.on('will-quit', () => globalShortcut.unregisterAll());

// Stay alive in the tray when the window is closed.
app.on('window-all-closed', () => {});
