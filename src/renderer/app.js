/* global Recorder, marked, DOMPurify */
const api = window.sidebar;

const TEMPLATE_LABELS = { court: 'Court hearing', client: 'Client meeting', general: 'General meeting' };
const STATUS_LABELS = {
  recording: 'Recording',
  transcribing: 'Transcribing…',
  identifying: 'Identifying speakers…',
  summarizing: 'Writing notes…',
  ready: 'Ready',
  error: 'Needs attention',
};

const state = {
  settings: null,
  meetings: [],
  selectedId: null, // null = the "new recording" screen
  detail: null, // { meeting, transcript }
  tab: 'notes',
  search: '',
  recorder: null,
  recordingId: null,
  tick: null,
  askHistory: {},
  draft: { title: '', template: null, keyterms: '' },
};

// ---------- helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function markdown(text) {
  return DOMPurify.sanitize(marked.parse(text || '', { gfm: true, breaks: false }));
}

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${m}:${sec}` : `${m}:${sec}`;
}

function shortDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function shortcutLabel() {
  return state.settings && state.settings.platform === 'darwin' ? '⌘⇧R' : 'Ctrl+Shift+R';
}

function needsKeys() {
  const s = state.settings;
  return !s.deepgramApiKey || !s.anthropicApiKey;
}

let toastTimer;
function toast(message) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- sidebar list ----------

function renderList() {
  const list = $('#meetingList');
  const q = state.search.toLowerCase();
  const items = state.meetings.filter((m) => !q || m.title.toLowerCase().includes(q) || (m.summary || '').toLowerCase().includes(q));
  if (!items.length) {
    list.innerHTML = `<li class="empty">${state.meetings.length ? 'No matches' : 'Your notes will appear here'}</li>`;
    return;
  }
  list.innerHTML = items
    .map((m) => `
      <li class="meeting-item ${m.id === state.selectedId ? 'active' : ''}" data-id="${esc(m.id)}">
        <div class="meeting-title">${esc(m.title)}</div>
        <div class="meeting-meta">
          <span>${esc(shortDate(m.createdAt))}</span>
          ${m.status !== 'ready' ? `<span class="chip ${esc(m.status)}">${esc(STATUS_LABELS[m.status] || m.status)}</span>` : ''}
        </div>
      </li>`)
    .join('');
}

$('#meetingList').addEventListener('click', (e) => {
  const item = e.target.closest('.meeting-item');
  if (item) openMeeting(item.dataset.id);
});

$('#search').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderList();
});

$('#newBtn').addEventListener('click', () => {
  state.selectedId = null;
  state.detail = null;
  renderList();
  render();
});

// ---------- views ----------

function render() {
  if (state.recorder) return renderRecording();
  if (state.selectedId && state.detail) return renderMeeting();
  return renderStart();
}

function renderStart() {
  const s = state.settings;
  const template = state.draft.template || s.defaultTemplate;
  $('#view').innerHTML = `
    <div class="start drag-top">
      ${needsKeys() ? `
        <div class="callout">
          <div><strong>Finish setup.</strong> Add your transcription and summary keys (or import your team's setup file) to start taking notes.</div>
          <button class="btn primary" id="openSetup">Open settings</button>
        </div>` : ''}
      <h1>Ready when you are.</h1>
      <p class="lede">Sidebar listens on your computer, not in the meeting. No bot joins, so it works for court hearings and any call where bots aren't allowed.</p>

      <div class="card form">
        <label class="field">
          <span>What's this for?</span>
          <input id="titleInput" placeholder="e.g. Smith v. Jones, motion hearing" value="${esc(state.draft.title)}" />
        </label>
        <div class="field">
          <span>Note style</span>
          <div class="segmented" id="templatePicker">
            ${Object.entries(TEMPLATE_LABELS).map(([k, v]) => `<button type="button" data-template="${k}" class="${k === template ? 'on' : ''}">${v}</button>`).join('')}
          </div>
        </div>
        <label class="field">
          <span>Names &amp; terms to listen for <small>(optional, comma separated)</small></span>
          <input id="keytermsInput" placeholder="e.g. Justice Okafor, Harris Partners, Rule 20 motion" value="${esc(state.draft.keyterms)}" />
        </label>
        <button class="btn record" id="recordBtn"><span class="dot"></span> Start recording</button>
        <p class="hint center">Tip: press <kbd>${shortcutLabel()}</kbd> anywhere to start or stop, even with Sidebar hidden.</p>
      </div>

      <div class="steps">
        <div><b>1</b> Join your Zoom, Teams or Meet call as usual.</div>
        <div><b>2</b> Hit record. Sidebar runs quietly in the ${s.platform === 'darwin' ? 'menu bar' : 'system tray'}.</div>
        <div><b>3</b> Stop when you're done. Notes arrive in a minute or two.</div>
      </div>
    </div>`;

  $('#titleInput').addEventListener('input', (e) => (state.draft.title = e.target.value));
  $('#keytermsInput').addEventListener('input', (e) => (state.draft.keyterms = e.target.value));
  $('#templatePicker').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.draft.template = b.dataset.template;
    renderStart();
  });
  $('#recordBtn').addEventListener('click', startRecording);
  const setup = $('#openSetup');
  if (setup) setup.addEventListener('click', openSettings);
}

function renderRecording() {
  const r = state.recorder;
  const paused = r.state === 'paused';
  $('#view').innerHTML = `
    <div class="recording drag-top">
      ${!r.systemAudio ? `
        <div class="callout warn">
          <div><strong>Only your microphone is being recorded.</strong> Sidebar couldn't capture your computer's audio, so other people on the call may be missed.
          ${state.settings.platform === 'darwin' ? 'Allow Sidebar under System Settings → Privacy &amp; Security → Screen &amp; System Audio Recording, then quit and reopen Sidebar.' : ''}</div>
          ${state.settings.platform === 'darwin' ? '<button class="btn ghost" id="openScreenPerm">Open settings</button>' : ''}
        </div>` : ''}
      <div class="rec-indicator ${paused ? 'paused' : ''}"><span class="dot"></span>${paused ? 'Paused' : 'Recording'}</div>
      <div class="timer" id="timer">${clock(r.elapsedSeconds())}</div>
      <div class="rec-title">${esc(state.draft.title || 'Untitled meeting')}</div>
      <div class="meters">
        <div class="meter"><span>You</span><div class="bar"><i id="micLevel"></i></div></div>
        <div class="meter ${r.systemAudio ? '' : 'off'}"><span>Call audio</span><div class="bar"><i id="sysLevel"></i></div></div>
      </div>
      <div class="rec-actions">
        <button class="btn ghost" id="pauseBtn">${paused ? 'Resume' : 'Pause'}</button>
        <button class="btn stop" id="stopBtn">Stop &amp; make notes</button>
      </div>
      <button class="link danger" id="discardBtn">Discard recording</button>
      <p class="hint center">You can close this window. Sidebar keeps recording in the ${state.settings.platform === 'darwin' ? 'menu bar' : 'system tray'}. Press <kbd>${shortcutLabel()}</kbd> to stop.</p>
    </div>`;
  $('#pauseBtn').addEventListener('click', () => {
    if (r.state === 'paused') r.resume();
    else r.pause();
    renderRecording();
  });
  $('#stopBtn').addEventListener('click', stopRecording);
  $('#discardBtn').addEventListener('click', discardRecording);
  const perm = $('#openScreenPerm');
  if (perm) perm.addEventListener('click', () => api.openPermissionSettings('screen'));
}

function renderMeeting() {
  const { meeting, transcript } = state.detail;
  const busy = ['recording', 'transcribing', 'identifying', 'summarizing'].includes(meeting.status);
  const tab = state.tab;
  $('#view').innerHTML = `
    <div class="meeting drag-top">
      <header class="meeting-header">
        <div class="grow">
          <input class="title-input" id="titleEdit" value="${esc(meeting.title)}" />
          <div class="meta">
            ${esc(new Date(meeting.createdAt).toLocaleString())}
            · ${Math.max(1, Math.round((meeting.durationSec || 0) / 60))} min
            · ${esc(TEMPLATE_LABELS[meeting.template] || 'Meeting')}
            ${meeting.status !== 'ready' ? `<span class="chip ${esc(meeting.status)}">${esc(STATUS_LABELS[meeting.status])}</span>` : ''}
          </div>
        </div>
        <div class="actions">
          <button class="btn ghost" id="copyBtn" ${busy ? 'disabled' : ''}>Copy</button>
          <button class="btn ghost" id="exportBtnM" ${busy ? 'disabled' : ''}>Export</button>
          <button class="btn ghost icon" id="deleteBtn" title="Delete">Delete</button>
        </div>
      </header>

      ${meeting.status === 'error' ? `
        <div class="callout error">
          <div>${esc(meeting.error)}</div>
          <div class="row">
            ${/API key/.test(meeting.error || '') ? '<button class="btn ghost" id="fixKeys">Settings</button>' : ''}
            <button class="btn primary" id="retryBtn">Retry</button>
          </div>
        </div>` : ''}

      ${busy ? `
        <div class="progress">
          <div class="spinner"></div>
          <div>
            <strong>${esc(STATUS_LABELS[meeting.status])}</strong>
            <p>This usually takes a minute or two. Feel free to close the window; you'll get a notification when your notes are ready.</p>
          </div>
        </div>` : ''}

      <nav class="tabs">
        ${[['notes', 'Notes'], ['transcript', 'Transcript'], ['ask', 'Ask']].map(([k, v]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${v}</button>`).join('')}
      </nav>
      <section class="tab-body" id="tabBody"></section>
    </div>`;

  if (tab === 'notes') renderNotes(meeting, busy);
  if (tab === 'transcript') renderTranscript(meeting, transcript);
  if (tab === 'ask') renderAsk(meeting, transcript);

  $('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.tab = b.dataset.tab;
    renderMeeting();
  });
  $('#titleEdit').addEventListener('change', async (e) => {
    const title = e.target.value.trim() || meeting.title;
    await api.updateMeeting(meeting.id, { title });
    toast('Renamed');
  });
  $('#copyBtn').addEventListener('click', async () => {
    await navigator.clipboard.writeText(await api.meetingText(meeting.id));
    toast('Notes and transcript copied');
  });
  $('#exportBtnM').addEventListener('click', () => api.exportMeeting(meeting.id));
  $('#deleteBtn').addEventListener('click', async () => {
    if (await api.deleteMeeting(meeting.id)) {
      state.selectedId = null;
      state.detail = null;
      await refreshMeetings();
      render();
    }
  });
  const retry = $('#retryBtn');
  if (retry) retry.addEventListener('click', () => api.retryMeeting(meeting.id));
  const fix = $('#fixKeys');
  if (fix) fix.addEventListener('click', openSettings);
}

function renderNotes(meeting, busy) {
  const body = $('#tabBody');
  if (!meeting.summary) {
    body.innerHTML = `<div class="empty-state">${busy ? 'Your notes will appear here.' : 'No notes yet.'}</div>`;
    return;
  }
  body.innerHTML = `
    <article class="notes">${markdown(meeting.summary)}</article>
    <div class="notes-footer">
      <span class="hint">AI-generated. Check important details against the transcript.</span>
      <div class="row">
        <select id="templateSwitch">${Object.entries(TEMPLATE_LABELS).map(([k, v]) => `<option value="${k}" ${k === meeting.template ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <button class="btn ghost" id="regenBtn" ${busy ? 'disabled' : ''}>Regenerate notes</button>
      </div>
    </div>`;
  body.querySelectorAll('a[href]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      api.openExternal(a.href);
    });
  });
  $('#regenBtn').addEventListener('click', async () => {
    await api.updateMeeting(meeting.id, { template: $('#templateSwitch').value });
    await api.resummarize(meeting.id);
  });
}

function renderTranscript(meeting, transcript) {
  const body = $('#tabBody');
  if (!transcript.length) {
    body.innerHTML = '<div class="empty-state">The transcript will appear here once it\'s ready.</div>';
    return;
  }
  const speakers = meeting.speakers || {};
  const keys = [...new Set(transcript.map((s) => s.speaker))];
  body.innerHTML = `
    <div class="speakers">
      <span class="hint">Sidebar guessed who's who from the conversation (a “?” means it isn't sure). Fix any names, then regenerate the notes.</span>
      <div class="speaker-fields">
        ${keys.map((k, i) => `<label class="speaker-chip c${i % 6}"><input data-key="${esc(k)}" value="${esc(speakers[k] || `Speaker ${k}`)}" /></label>`).join('')}
      </div>
    </div>
    <div class="transcript">
      ${transcript.map((s) => `
        <div class="line">
          <span class="ts">${clock(s.start)}</span>
          <span class="who c${keys.indexOf(s.speaker) % 6}">${esc(speakers[s.speaker] || `Speaker ${s.speaker}`)}</span>
          <p>${esc(s.text)}</p>
        </div>`).join('')}
    </div>`;
  body.querySelector('.speaker-fields').addEventListener('change', async (e) => {
    const input = e.target.closest('input');
    if (!input) return;
    const next = { ...speakers, [input.dataset.key]: input.value.trim() || speakers[input.dataset.key] };
    await api.updateMeeting(meeting.id, { speakers: next });
    toast('Speaker renamed. Regenerate the notes to use the new name.');
  });
}

function renderAsk(meeting, transcript) {
  const body = $('#tabBody');
  const history = state.askHistory[meeting.id] || [];
  if (!transcript.length) {
    body.innerHTML = '<div class="empty-state">You can ask questions once the transcript is ready.</div>';
    return;
  }
  body.innerHTML = `
    <div class="ask">
      <div class="ask-log">
        ${history.length ? history.map((h) => `
          <div class="q">${esc(h.q)}</div>
          <div class="a ${h.pending ? 'pending' : ''}">${h.pending ? 'Thinking…' : markdown(h.a)}</div>`).join('') : `
          <div class="suggestions">
            ${['What did the judge order?', 'What deadlines were set?', 'What did opposing counsel concede?', 'What do I need to do next?']
              .map((q) => `<button class="btn ghost small" data-q="${esc(q)}">${esc(q)}</button>`).join('')}
          </div>`}
      </div>
      <form class="ask-form" id="askForm">
        <input id="askInput" placeholder="Ask anything about this meeting…" autocomplete="off" />
        <button class="btn primary">Ask</button>
      </form>
    </div>`;
  const ask = async (q) => {
    if (!q.trim()) return;
    const entry = { q, a: '', pending: true };
    state.askHistory[meeting.id] = [...history, entry];
    renderAsk(meeting, transcript);
    try {
      entry.a = await api.ask(meeting.id, q);
    } catch (err) {
      entry.a = `**Couldn't answer:** ${String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
    }
    entry.pending = false;
    if (state.selectedId === meeting.id && state.tab === 'ask') renderAsk(meeting, transcript);
  };
  $('#askForm').addEventListener('submit', (e) => {
    e.preventDefault();
    ask($('#askInput').value);
  });
  body.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => ask(b.dataset.q)));
  $('#askInput').focus();
}

// ---------- recording ----------

async function startRecording() {
  if (state.recorder) return;
  // Started from the shortcut with setup unfinished: bring the window up.
  if (!state.settings.acceptedNotice || needsKeys()) api.showWindow();
  if (!state.settings.acceptedNotice) {
    const ok = await showNotice();
    if (!ok) return;
  }
  if (needsKeys()) {
    toast('Add your API keys first');
    openSettings();
    return;
  }
  const perms = await api.checkPermissions();
  if (!perms.microphone) {
    api.showWindow();
    toast('Sidebar needs microphone access');
    api.openPermissionSettings('microphone');
    return;
  }

  const recorder = new Recorder();
  let meeting;
  try {
    meeting = await api.startRecording({
      title: state.draft.title.trim(),
      template: state.draft.template || state.settings.defaultTemplate,
      keyterms: state.draft.keyterms.split(',').map((t) => t.trim()).filter(Boolean),
    });
    state.recordingId = meeting.id;
    await recorder.start((buf) => api.sendChunk(meeting.id, buf));
  } catch (err) {
    if (meeting) await api.discardRecording(meeting.id);
    state.recordingId = null;
    api.showWindow();
    toast(`Couldn't start recording: ${err.message}`);
    return;
  }
  state.recorder = recorder;
  state.selectedId = null;
  api.setRecordingState(true);
  if (document.hidden) new Notification('Sidebar is recording', { body: `Press ${shortcutLabel()} to stop.`, silent: true });
  render();
  state.tick = setInterval(() => {
    const t = $('#timer');
    if (t) t.textContent = clock(recorder.elapsedSeconds());
    const lv = recorder.levels();
    const mic = $('#micLevel');
    const sys = $('#sysLevel');
    if (mic) mic.style.width = `${Math.round(lv.mic * 100)}%`;
    if (sys) sys.style.width = `${Math.round(lv.system * 100)}%`;
  }, 120);
}

async function finishRecorder() {
  clearInterval(state.tick);
  const seconds = await state.recorder.stop();
  const id = state.recordingId;
  state.recorder = null;
  state.recordingId = null;
  api.setRecordingState(false);
  return { id, seconds };
}

async function stopRecording() {
  if (!state.recorder) return;
  const { id, seconds } = await finishRecorder();
  await api.stopRecording(id, seconds);
  state.draft = { title: '', template: null, keyterms: '' };
  if (document.hidden) new Notification('Recording saved', { body: 'Sidebar is writing your notes.', silent: true });
  await openMeeting(id);
}

async function discardRecording() {
  if (!state.recorder) return;
  if (!confirm('Discard this recording? Nothing will be saved.')) return;
  const { id } = await finishRecorder();
  await api.discardRecording(id);
  await refreshMeetings();
  render();
}

// Called by the tray menu and the global shortcut.
window.sidebarToggle = () => (state.recorder ? stopRecording() : startRecording());

// ---------- data ----------

async function refreshMeetings() {
  state.meetings = await api.listMeetings();
  renderList();
}

async function openMeeting(id) {
  if (state.recorder) return;
  state.selectedId = id;
  state.detail = await api.getMeeting(id);
  if (state.detail.meeting.status !== 'ready' && state.tab === 'ask') state.tab = 'notes';
  await refreshMeetings();
  render();
}

api.onMeetingUpdated(async (meeting) => {
  await refreshMeetings();
  if (meeting.id === state.selectedId && !state.recorder) {
    const scrollTop = $('#tabBody') ? $('#tabBody').scrollTop : 0;
    state.detail = await api.getMeeting(meeting.id);
    // Don't clobber the title while the user is editing it.
    if (document.activeElement && document.activeElement.id === 'titleEdit') return;
    renderMeeting();
    if ($('#tabBody')) $('#tabBody').scrollTop = scrollTop;
  }
});

api.onOpenMeeting((id) => openMeeting(id));

// ---------- settings & notice ----------

function fillSettingsForm() {
  const form = $('#settingsForm');
  const s = state.settings;
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') el.checked = Boolean(s[el.name]);
    else el.value = s[el.name] ?? '';
  }
  $('#encryptionHint').textContent = s.encrypted
    ? 'Keys are stored encrypted on this computer.'
    : 'Keys are stored on this computer.';
}

function openSettings() {
  fillSettingsForm();
  $('#settingsDialog').showModal();
}

$('#settingsBtn').addEventListener('click', openSettings);

$('#settingsDialog').addEventListener('close', async () => {
  if ($('#settingsDialog').returnValue !== 'save') return;
  const form = $('#settingsForm');
  const patch = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    patch[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim();
  }
  state.settings = { ...state.settings, ...(await api.saveSettings(patch)) };
  toast('Settings saved');
  render();
});

$('#importBtn').addEventListener('click', async () => {
  try {
    const saved = await api.importSettings();
    if (saved) {
      state.settings = { ...state.settings, ...saved };
      fillSettingsForm();
      toast('Team setup imported');
    }
  } catch {
    toast("That file isn't a valid Sidebar setup file");
  }
});

$('#exportBtn').addEventListener('click', async () => {
  if (await api.exportSettings()) toast('Saved. Share this file privately: it contains your API keys.');
});

document.querySelectorAll('[data-link]').forEach((a) =>
  a.addEventListener('click', (e) => {
    e.preventDefault();
    api.openExternal(a.dataset.link);
  }),
);

function showNotice() {
  return new Promise((resolve) => {
    const dialog = $('#noticeDialog');
    const box = $('#noticeAccept');
    box.checked = false;
    $('#noticeOk').disabled = true;
    box.onchange = () => ($('#noticeOk').disabled = !box.checked);
    dialog.onclose = async () => {
      const ok = dialog.returnValue === 'ok' && box.checked;
      if (ok) state.settings = { ...state.settings, ...(await api.saveSettings({ acceptedNotice: true })) };
      resolve(ok);
    };
    dialog.showModal();
  });
}

// ---------- boot ----------

(async function init() {
  state.settings = await api.getSettings();
  document.body.classList.add(`platform-${state.settings.platform}`);
  await refreshMeetings();
  render();
})();
