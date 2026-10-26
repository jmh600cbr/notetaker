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
const { Store, sanitizeSettings, PATH_SETTINGS } = require('./store');
const { transcribeMeeting } = require('./transcribe');
const {
  summarize,
  answerQuestion,
  answerMatterQuestion,
  identifySpeakers,
  draftTimeEntry,
  formatTranscript,
} = require('./summarize');
const { buildDocx } = require('./docx');
const { Calendar, attendeeNames } = require('./calendar');
const { AppLock } = require('./lock');
const { Updater } = require('./updater');
const { claudeCost, deepgramCost } = require('./pricing');

// Must run before the app is ready: enables capturing the computer's audio
// output (what you hear from Zoom/Teams/Meet) without a virtual audio driver.
initAudioLoopback();

// Ctrl/Cmd+Shift+R alone is the browsers' hard-reload, so add Alt/Option.
const SHORTCUT = 'CommandOrControl+Alt+Shift+R';
// Flag an important moment while recording.
const MARK_SHORTCUT = 'CommandOrControl+Alt+Shift+M';
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
let calendar = null;
let appLock = null;

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
    meeting = store.updateMeeting(id, { summary });

    // A ready-to-paste time entry. Nice to have; never blocks the notes.
    try {
      const timeEntry = await draftTimeEntry({ apiKey: settings.anthropicApiKey, meeting, segments, onUsage });
      meeting = store.updateMeeting(id, { timeEntry });
    } catch (err) {
      console.warn('Time entry failed:', err.message);
    }
    meeting = store.updateMeeting(id, { status: 'ready', error: null });
    await saveToFolder(id);
    meeting = store.getMeeting(id);

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

// Writes the finished notes into the user's chosen folder (e.g. in OneDrive),
// in a subfolder per matter, replacing the previous copy if it moved.
async function saveToFolder(id) {
  const settings = store.getSettings();
  if (!settings.saveFolder) return;
  let meeting = store.getMeeting(id);
  if (meeting.status !== 'ready' || !meeting.summary) return;
  try {
    const dir = meeting.matter ? path.join(settings.saveFolder, safeFileName(meeting.matter)) : settings.saveFolder;
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date(meeting.createdAt);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const base = path.join(dir, `${day} ${safeFileName(meeting.title)}`);
    const segments = store.getTranscript(id);
    const written = [];
    if (settings.saveFormat !== 'md') {
      const buf = await buildDocx({ meeting, segments, headerText: settings.docHeader, logoPath: settings.docLogo });
      fs.writeFileSync(`${base}.docx`, buf);
      written.push(`${base}.docx`);
    }
    if (settings.saveFormat !== 'docx') {
      fs.writeFileSync(`${base}.md`, meetingToMarkdown(meeting, segments));
      written.push(`${base}.md`);
    }
    // Renamed or moved to another matter: remove the old copies.
    for (const old of meeting.savedFiles || []) {
      if (!written.includes(old)) fs.rmSync(old, { force: true });
    }
    meeting = store.updateMeeting(id, { savedFiles: written, saveError: null });
  } catch (err) {
    const message = err.code === 'EBUSY' || err.code === 'EPERM'
      ? 'The file is open in another app (e.g. Word). Close it and click "Save to folder" again.'
      : err.message;
    meeting = store.updateMeeting(id, { saveError: message });
    notify('Couldn’t save notes to your folder', message, id);
  }
  broadcastMeeting(meeting);
}

function meetingToMarkdown(meeting, segments) {
  const date = new Date(meeting.createdAt).toLocaleString();
  return [
    `# ${meeting.title}`,
    '',
    `_${date} · ${Math.max(1, Math.round((meeting.durationSec || 0) / 60))} min${meeting.matter ? ` · Matter: ${meeting.matter}` : ''} · Notes by Sidebar_`,
    '',
    ...(meeting.timeEntry ? [`**Time entry:** ${meeting.timeEntry.hours.toFixed(1)} h — ${meeting.timeEntry.description}`, ''] : []),
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

// While Sidebar is locked, nothing that reveals or changes meetings or
// settings works. Recording itself, the lock screen and updates still do.
const LOCKED_CHANNELS = new Set([
  'settings:save', 'settings:import', 'settings:export', 'settings:chooseFolder', 'settings:chooseLogo', 'settings:clear',
  'meetings:list', 'meetings:get', 'meetings:update', 'meetings:delete', 'meetings:retry', 'meetings:resummarize',
  'meetings:ask', 'meetings:askMatter', 'meetings:matters', 'meetings:export', 'meetings:copyText', 'meetings:search', 'meetings:saveToFolder',
  'calendar:connect', 'calendar:disconnect', 'calendar:upcoming', 'lock:disable',
]);

function handle(channel, fn) {
  ipcMain.handle(channel, (...args) => {
    if (appLock && appLock.locked && LOCKED_CHANNELS.has(channel)) throw new Error('Sidebar is locked.');
    return fn(...args);
  });
}

function registerIpc() {
  // The UI never receives the API keys themselves, only whether they're set.
  handle('settings:get', () => ({
    ...store.getPublicSettings(),
    platform: process.platform,
    shortcut: SHORTCUT,
    encrypted: store.canEncrypt(),
    costs: store.getCostSummary(),
    markShortcut: MARK_SHORTCUT,
    locked: appLock.locked,
    lockEnabled: appLock.enabled(),
    touchId: process.platform === 'darwin' && systemPreferences.canPromptTouchID(),
  }));

  handle('settings:save', (_e, patch) => {
    patch = { ...patch };
    for (const key of PATH_SETTINGS) delete patch[key];
    const saved = store.saveSettings(patch);
    if ('openAtLogin' in patch) {
      app.setLoginItemSettings({ openAtLogin: Boolean(patch.openAtLogin), args: ['--hidden'] });
    }
    return saved;
  });

  // Team setup: an admin exports a config file once and shares it privately;
  // teammates import it instead of pasting keys.
  // Folders and files are picked in a native dialog, never typed in.
  handle('settings:chooseFolder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose where to save notes (for example a folder in OneDrive)',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths[0]) return null;
    return store.saveSettings({ saveFolder: filePaths[0] });
  });

  handle('settings:chooseLogo', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a logo for Word documents',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths[0]) return null;
    return store.saveSettings({ docLogo: filePaths[0] });
  });

  handle('settings:clear', (_e, key) => {
    if (!PATH_SETTINGS.includes(key)) return null;
    return store.saveSettings({ [key]: '' });
  });

  handle('settings:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Import team setup',
      filters: [{ name: 'Sidebar setup', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths[0]) return null;
    const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    const allowed = [
      'deepgramApiKey', 'anthropicApiKey', 'defaultTemplate', 'language', 'headphones', 'keepAudio',
      'docHeader', 'calendarClientId', 'calendarTenant', 'retentionDays', 'retentionScope', 'deepgramPerMinute',
    ];
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
      docHeader: `Word document header: ${String(patch.docHeader || '').split('\n')[0]}`,
      calendarClientId: 'Outlook calendar app registration',
      calendarTenant: `Microsoft tenant: ${patch.calendarTenant}`,
      retentionDays: `Auto-delete after: ${patch.retentionDays ? `${patch.retentionDays} days` : 'never'}`,
      retentionScope: `Auto-delete: ${patch.retentionScope === 'everything' ? 'whole meetings' : 'recordings and transcripts'}`,
      deepgramPerMinute: `Transcription price: $${patch.deepgramPerMinute}/min`,
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

  handle('settings:export', async () => {
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
      docHeader: s.docHeader,
      calendarClientId: s.calendarClientId,
      calendarTenant: s.calendarTenant,
      retentionDays: s.retentionDays,
      retentionScope: s.retentionScope,
      deepgramPerMinute: s.deepgramPerMinute,
    };
    // Contains API keys: readable by the current user only.
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    return true;
  });

  handle('permissions:check', async () => {
    if (process.platform !== 'darwin') return { microphone: true, screen: 'granted' };
    const microphone = await systemPreferences.askForMediaAccess('microphone');
    return { microphone, screen: systemPreferences.getMediaAccessStatus('screen') };
  });

  handle('permissions:openSettings', (_e, kind) => {
    if (process.platform === 'darwin') {
      const pane = kind === 'microphone' ? 'Privacy_Microphone' : 'Privacy_ScreenCapture';
      shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
    } else if (process.platform === 'win32') {
      shell.openExternal('ms-settings:privacy-microphone');
    }
  });

  handle('meetings:list', () => store.listMeetings());

  handle('meetings:get', (_e, id) => ({
    meeting: store.getMeeting(id),
    transcript: store.getTranscript(id),
  }));

  handle('meetings:update', (_e, id, patch) => {
    const allowed = {};
    if (typeof patch.title === 'string') allowed.title = patch.title.slice(0, 200);
    if (patch.speakers && typeof patch.speakers === 'object') allowed.speakers = patch.speakers;
    if (['court', 'client', 'general'].includes(patch.template)) allowed.template = patch.template;
    if (typeof patch.matter === 'string') allowed.matter = patch.matter.trim().slice(0, 120);
    if (Array.isArray(patch.marks)) {
      allowed.marks = patch.marks
        .filter((m) => m && Number.isFinite(m.t))
        .slice(0, 200)
        .map((m) => ({ t: Math.max(0, m.t), label: String(m.label || '').slice(0, 200) }));
    }
    const meeting = broadcastMeeting(store.updateMeeting(id, allowed));
    // Keep the copy in the save folder in step with renames and matter changes.
    if ((allowed.title || 'matter' in allowed) && (meeting.savedFiles || []).length) saveToFolder(id);
    return meeting;
  });

  handle('meetings:saveToFolder', (_e, id) => saveToFolder(id));

  handle('meetings:matters', () => store.listMatters());

  // Search titles, matters, notes and transcripts.
  handle('meetings:search', (_e, query) => {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return null;
    return store
      .listMeetings()
      .filter((m) => {
        const text = [m.title, m.matter, m.summary, m.timeEntry && m.timeEntry.description].join(' ').toLowerCase();
        if (text.includes(q)) return true;
        return store.getTranscript(m.id).some((seg) => seg.text.toLowerCase().includes(q));
      })
      .map((m) => m.id);
  });

  handle('meetings:askMatter', async (_e, id, question) => {
    const settings = store.getSettings();
    const matter = store.getMeeting(id).matter;
    if (!matter) throw new Error('This meeting has no matter.');
    const items = store
      .listMeetings()
      .filter((m) => m.matter === matter && (m.summary || store.hasTranscript(m.id)))
      .map((m) => ({ meeting: m, segments: store.getTranscript(m.id) }));
    return answerMatterQuestion({
      apiKey: settings.anthropicApiKey,
      matter,
      items,
      question: String(question).slice(0, 2000),
      onUsage: (usage) => broadcastMeeting(store.addCost(id, { ai: claudeCost(usage) }) || store.getMeeting(id)),
    });
  });

  handle('meetings:delete', async (_e, id) => {
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

  handle('meetings:retry', (_e, id) => {
    processMeeting(id);
    return true;
  });

  // The current notes stay until the new ones succeed.
  handle('meetings:resummarize', (_e, id) => {
    processMeeting(id);
    return true;
  });

  handle('meetings:ask', async (_e, id, question) => {
    const settings = store.getSettings();
    return answerQuestion({
      apiKey: settings.anthropicApiKey,
      meeting: store.getMeeting(id),
      segments: store.getTranscript(id),
      question: String(question).slice(0, 2000),
      onUsage: (usage) => broadcastMeeting(store.addCost(id, { ai: claudeCost(usage) }) || store.getMeeting(id)),
    });
  });

  handle('meetings:export', async (_e, id) => {
    const meeting = store.getMeeting(id);
    const safeName = safeFileName(meeting.title);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export notes',
      defaultPath: `${safeName}.docx`,
      filters: [
        { name: 'Word document', extensions: ['docx'] },
        { name: 'Markdown', extensions: ['md'] },
      ],
    });
    if (canceled || !filePath) return false;
    const segments = store.getTranscript(id);
    if (filePath.toLowerCase().endsWith('.md')) {
      fs.writeFileSync(filePath, meetingToMarkdown(meeting, segments));
    } else {
      const settings = store.getSettings();
      fs.writeFileSync(filePath, await buildDocx({ meeting, segments, headerText: settings.docHeader, logoPath: settings.docLogo }));
    }
    shell.showItemInFolder(filePath);
    return true;
  });

  handle('meetings:copyText', (_e, id) => {
    return meetingToMarkdown(store.getMeeting(id), store.getTranscript(id));
  });

  handle('recording:start', (_e, opts) => {
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
      matter: String(opts.matter || '').trim().slice(0, 120),
    });
    recordingInfo = { systemAudio: true, micAudio: true };
    setRecording(meeting.id);
    // Fill in the title and attendee names from the Outlook meeting that's on
    // now. Done in the background so recording starts immediately.
    if (calendar.configured()) fillFromCalendar(meeting.id, Boolean(opts.title));
    return broadcastMeeting(meeting);
  });

  handle('recording:mark', (_e, id, t) => {
    if (id !== activeRecordingId || !Number.isFinite(t)) return null;
    const m = store.getMeeting(id);
    const marks = [...(m.marks || []), { t: Math.max(0, t), label: '' }].slice(0, 200);
    return broadcastMeeting(store.updateMeeting(id, { marks }));
  });

  // ---- Outlook calendar ----
  ipcMain.handle('calendar:status', () => calendar.status());
  handle('calendar:connect', async () => {
    const result = await calendar.connect();
    scheduleReminders();
    return result;
  });
  handle('calendar:disconnect', () => calendar.disconnect());
  handle('calendar:upcoming', async () => {
    const events = await calendar.upcoming(12);
    return events.slice(0, 5).map((e) => ({
      id: e.id,
      subject: e.subject || '(No title)',
      start: `${e.start.dateTime}Z`,
      end: `${e.end.dateTime}Z`,
      online: Boolean(e.isOnlineMeeting),
    }));
  });

  // ---- app lock ----
  ipcMain.handle('lock:status', () => ({ enabled: appLock.enabled(), locked: appLock.locked }));
  ipcMain.handle('lock:unlock', (_e, password) => {
    const ok = appLock.unlock(password);
    if (ok) send('lock:changed', false);
    return ok;
  });
  ipcMain.handle('lock:touchId', async () => {
    if (process.platform !== 'darwin' || !systemPreferences.canPromptTouchID()) return false;
    try {
      await systemPreferences.promptTouchID('unlock Sidebar');
      appLock.unlockTrusted();
      send('lock:changed', false);
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle('lock:enable', (_e, password) => {
    if (appLock.enabled()) throw new Error('A password is already set.');
    appLock.setPassword(password);
    return true;
  });
  handle('lock:disable', (_e, password) => {
    appLock.disable(password);
    return true;
  });
  ipcMain.handle('lock:lockNow', () => lockApp());

  handle('recording:chunk', (_e, id, part, data) => {
    if (!Number.isInteger(part) || part < 0 || part > 999) throw new Error('Invalid audio part');
    store.appendAudio(id, part, Buffer.from(data));
    return true;
  });

  handle('recording:stop', (_e, id, durationSec, { quitting = false, unsaved = 0 } = {}) => {
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

  handle('recording:discard', (_e, id) => {
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

  handle('updater:get', () => (updater ? updater.state : { status: 'idle' }));
  handle('updater:check', () => (updater ? updater.check(true) : { status: 'idle' }));
  handle('updater:install', () => {
    if (!updater) return { ok: false };
    // Downloading is fine any time; only the restart has to wait.
    if (updater.state.status === 'ready' && !canRestart()) {
      return { ok: false, reason: 'You can restart to update once your recording and notes are finished.' };
    }
    updater.install();
    return { ok: true };
  });

  handle('shell:openExternal', (_e, url) => {
    if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url);
  });
}

// ---- calendar ----

async function fillFromCalendar(id, userTyped) {
  const event = await calendar.currentEvent();
  if (!event) return;
  try {
    const m = store.getMeeting(id);
    const names = attendeeNames(event);
    const patch = {
      attendees: names,
      keyterms: [...new Set([...(m.keyterms || []), ...names])].slice(0, 50),
    };
    if (!userTyped && event.subject) patch.title = event.subject.slice(0, 200);
    broadcastMeeting(store.updateMeeting(id, patch));
  } catch {
    // meeting discarded meanwhile
  }
}

// Remind the user to record when an Outlook meeting starts.
const reminded = new Set();
let reminderTimers = [];
async function scheduleReminders() {
  reminderTimers.forEach(clearTimeout);
  reminderTimers = [];
  const settings = store.getSettings();
  if (!settings.calendarReminders || !calendar.configured()) return;
  const events = await calendar.upcoming(1);
  for (const e of events) {
    const start = Date.parse(`${e.start.dateTime}Z`);
    const wait = start - Date.now() - 30000;
    if (reminded.has(e.id) || wait > 3600000 || start < Date.now() - 60000) continue;
    reminderTimers.push(
      setTimeout(() => {
        reminded.add(e.id);
        if (isRecording()) return;
        const n = new Notification({ title: `${e.subject || 'A meeting'} is starting`, body: 'Click to start recording with Sidebar.' });
        liveNotifications.add(n);
        n.on('click', () => {
          liveNotifications.delete(n);
          toggleRecording();
        });
        n.on('close', () => liveNotifications.delete(n));
        n.show();
      }, Math.max(0, wait)),
    );
  }
}

// ---- app lock ----

function lockApp() {
  if (!appLock.lock()) return false;
  send('lock:changed', true);
  return true;
}

// Lock after the computer has been idle for a while, or when the screen locks
// or the computer sleeps.
function startAutoLock() {
  setInterval(() => {
    if (!appLock.enabled() || appLock.locked) return;
    const minutes = store.getSettings().lockAfterMinutes || 15;
    if (powerMonitor.getSystemIdleTime() >= minutes * 60) lockApp();
  }, 30000);
  powerMonitor.on('lock-screen', lockApp);
  powerMonitor.on('suspend', lockApp);
}

// ---- retention ----

// Deletes old recordings and transcripts (keeping the notes), or whole
// meetings, after the number of days set in Settings.
function runRetention() {
  const { retentionDays, retentionScope } = store.getSettings();
  if (!retentionDays) return;
  const cutoff = Date.now() - retentionDays * 86400000;
  for (const m of store.listMeetings()) {
    if (Date.parse(m.createdAt) > cutoff) continue;
    if (m.id === activeRecordingId || processing.has(m.id) || !['ready', 'error'].includes(m.status)) continue;
    try {
      if (retentionScope === 'everything') {
        store.deleteMeeting(m.id);
      } else if (m.hasAudio !== false || store.hasTranscript(m.id)) {
        store.deleteAudio(m.id);
        store.deleteTranscript(m.id);
        store.updateMeeting(m.id, { transcriptDeleted: true });
      }
    } catch (err) {
      console.warn('Retention failed for', m.id, err.message);
    }
  }
  send('meetings:refresh');
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
  appLock = new AppLock(app.getPath('userData'));
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

  calendar = new Calendar({
    baseDir: app.getPath('userData'),
    safeStorage,
    shell,
    getSettings: () => store.getSettings(),
    fetchImpl: (url, init) => net.fetch(url, init),
  });
  scheduleReminders();
  setInterval(scheduleReminders, 10 * 60000);

  startAutoLock();
  runRetention();
  setInterval(runRetention, 6 * 3600000);

  globalShortcut.register(MARK_SHORTCUT, () => {
    if (!isRecording() || !mainWindow) return;
    mainWindow.webContents.executeJavaScript('window.sidebarMark && window.sidebarMark()').catch(() => {});
  });

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
