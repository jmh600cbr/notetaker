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

// Notes and answers are written by an AI from what people said on the call, so
// treat them as untrusted: no links (a spoken instruction could plant one that
// leaks meeting details), no forms or buttons that could pass for app UI, no
// ids that could shadow the app's own elements. Only read-only checkboxes for
// task lists survive.
DOMPurify.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName === 'input' && !(node.getAttribute('type') === 'checkbox')) node.remove();
});
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'INPUT') node.setAttribute('disabled', '');
});

// IPC errors arrive as "Error invoking remote method 'x': Error: message".
function cleanError(err) {
  return String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function markdown(text) {
  return DOMPurify.sanitize(marked.parse(text || '', { gfm: true, breaks: false }), {
    FORBID_TAGS: ['a', 'form', 'button', 'dialog', 'textarea', 'select', 'option', 'style', 'img', 'video', 'audio', 'iframe', 'svg', 'math'],
    FORBID_ATTR: ['style', 'id', 'name', 'class', 'href', 'src', 'action', 'formaction'],
  });
}

function money(n) {
  if (!n) return '$0.00';
  return n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
}

function meetingCost(m) {
  return m.cost ? (m.cost.transcription || 0) + (m.cost.ai || 0) : 0;
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
  return state.settings && state.settings.platform === 'darwin' ? '⌥⇧⌘R' : 'Ctrl+Alt+Shift+R';
}

function needsKeys() {
  const s = state.settings;
  return !s.hasDeepgramKey || !s.hasAnthropicKey;
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
      <li class="meeting-item ${m.id === state.selectedId ? 'active' : ''}" data-id="${esc(m.id)}" tabindex="0" role="button">
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
$('#meetingList').addEventListener('keydown', (e) => {
  const item = e.target.closest('.meeting-item');
  if (item && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openMeeting(item.dataset.id);
  }
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
          <div>${s.keysLocked
            ? "<strong>Sidebar couldn't unlock your saved keys.</strong> This can happen after an update if macOS asked for keychain access and it wasn't allowed. Re-enter your keys or import your team's setup file."
            : "<strong>Finish setup.</strong> Add your transcription and summary keys (or import your team's setup file) to start taking notes."}</div>
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
          <input id="keytermsInput" placeholder="e.g. Justice Okafor, Acme Holdings, Rule 20 motion" value="${esc(state.draft.keyterms)}" />
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
  $('#recordBtn').addEventListener('click', () => exclusive(() => startRecording()));
  const setup = $('#openSetup');
  if (setup) setup.addEventListener('click', openSettings);
}

function renderRecording() {
  const r = state.recorder;
  const paused = r.state === 'paused';
  const mac = state.settings.platform === 'darwin';
  $('#view').innerHTML = `
    <div class="recording drag-top">
      ${state.diskError ? `
        <div class="callout error">
          <div><strong>Audio isn't being saved.</strong> ${esc(state.diskError)}. Sidebar is holding the audio in memory and keeps retrying. If your disk is full, free up some space now.</div>
        </div>` : ''}
      ${!r.systemAudio ? `
        <div class="callout warn">
          <div><strong>Only your microphone is being recorded.</strong> Sidebar couldn't capture your computer's audio, so other people on the call may be missed.
          ${mac ? 'Allow Sidebar under System Settings → Privacy &amp; Security → Screen &amp; System Audio Recording, then quit and reopen Sidebar.' : ''}</div>
          ${mac ? '<button class="btn ghost" id="openScreenPerm">Open settings</button>' : ''}
        </div>` : ''}
      ${!r.micAudio ? `
        <div class="callout warn">
          <div><strong>Your microphone isn't being recorded.</strong> Only the call audio is captured, so your own voice will be missing. Check that a microphone is connected and that Sidebar is allowed to use it.</div>
          <button class="btn ghost" id="openMicPerm">Open settings</button>
        </div>` : ''}
      ${state.reconnectedAt ? `<p class="hint center">An audio device changed at ${esc(state.reconnectedAt)}; Sidebar reconnected and kept recording.</p>` : ''}
      <div class="rec-indicator ${paused ? 'paused' : ''}"><span class="dot"></span>${paused ? 'Paused' : 'Recording'}</div>
      <div class="timer" id="timer">${clock(r.elapsedSeconds())}</div>
      <div class="rec-title">${esc(state.recordingTitle || 'Untitled meeting')}</div>
      <div class="meters">
        <div class="meter ${r.micAudio ? '' : 'off'}"><span>You</span><div class="bar"><i id="micLevel"></i></div></div>
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
  $('#stopBtn').addEventListener('click', () => exclusive(stopRecording));
  $('#discardBtn').addEventListener('click', () => exclusive(discardRecording));
  const perm = $('#openScreenPerm');
  if (perm) perm.addEventListener('click', () => api.openPermissionSettings('screen'));
  const micPerm = $('#openMicPerm');
  if (micPerm) micPerm.addEventListener('click', () => api.openPermissionSettings('microphone'));
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
            ${meetingCost(meeting) ? `· <span title="Estimated: transcription ${esc(money(meeting.cost.transcription))}, AI notes &amp; questions ${esc(money(meeting.cost.ai))}">≈ ${esc(money(meetingCost(meeting)))}</span>` : ''}
            ${meeting.status !== 'ready' ? `<span class="chip ${esc(meeting.status)}">${esc(STATUS_LABELS[meeting.status])}</span>` : ''}
          </div>
        </div>
        <div class="actions">
          <button class="btn ghost" id="copyBtn" ${busy ? 'disabled' : ''}>Copy</button>
          <button class="btn ghost" id="exportBtnM" ${busy ? 'disabled' : ''}>Export</button>
          <button class="btn ghost icon" id="deleteBtn" title="Delete">Delete</button>
        </div>
      </header>

      ${meeting.warning ? `
        <div class="callout warn"><div><strong>Check these notes.</strong> ${esc(meeting.warning)}</div></div>` : ''}

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
    try {
      await navigator.clipboard.writeText(await api.meetingText(meeting.id));
      toast('Notes and transcript copied');
    } catch (err) {
      toast(`Couldn't copy: ${cleanError(err)}`);
    }
  });
  $('#exportBtnM').addEventListener('click', async () => {
    try {
      await api.exportMeeting(meeting.id);
    } catch (err) {
      toast(`Couldn't export: ${cleanError(err)}`);
    }
  });
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
  const hasTranscript = state.detail && state.detail.transcript.length > 0;
  const notes = meeting.summary
    ? `<article class="notes">${markdown(meeting.summary)}</article>`
    : `<div class="empty-state">${busy ? 'Your notes will appear here.' : 'No notes yet.'}</div>`;
  if (!meeting.summary && !hasTranscript) {
    body.innerHTML = notes;
    return;
  }
  body.innerHTML = `
    ${notes}
    <div class="notes-footer">
      <span class="hint">${meeting.summary ? 'AI-generated. Check important details against the transcript.' : ''}</span>
      <div class="row">
        <select id="templateSwitch" aria-label="Note style">${Object.entries(TEMPLATE_LABELS).map(([k, v]) => `<option value="${k}" ${k === meeting.template ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <button class="btn ghost" id="regenBtn" ${busy ? 'disabled' : ''}>${meeting.summary ? 'Regenerate notes' : 'Make notes'}</button>
      </div>
    </div>`;
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
  const typing = $('#askInput') ? $('#askInput').value : '';
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
    state.askHistory[meeting.id] = [...(state.askHistory[meeting.id] || []), entry];
    if ($('#askInput')) $('#askInput').value = '';
    renderAsk(meeting, transcript);
    try {
      entry.a = await api.ask(meeting.id, q);
    } catch (err) {
      entry.a = `**Couldn't answer:** ${cleanError(err)}`;
    }
    entry.pending = false;
    if (state.selectedId === meeting.id && state.tab === 'ask') renderAsk(meeting, transcript);
  };
  $('#askForm').addEventListener('submit', (e) => {
    e.preventDefault();
    ask($('#askInput').value);
  });
  body.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => ask(b.dataset.q)));
  $('#askInput').value = typing;
  $('#askInput').focus();
}

// ---------- recording ----------

// Start and stop each take a few seconds (permission prompts, flushing audio).
// Ignore extra presses of the shortcut until the current one has finished,
// so a double press can never leave a second recorder running.
let transition = null;
function exclusive(fn) {
  if (transition) return transition;
  transition = fn().finally(() => {
    transition = null;
  });
  return transition;
}

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
    if (!$('#settingsDialog').open) openSettings();
    return;
  }
  const perms = await api.checkPermissions();
  // Without permission, macOS never hands over the computer's audio and the
  // request would just hang; go straight to microphone-only and say so.
  const skipSystemAudio = perms.screen === 'denied' || perms.screen === 'restricted';

  // Use what's typed on the start screen only if that's what's showing, so an
  // old draft never ends up on a different meeting started from the shortcut.
  const draft = state.selectedId === null ? state.draft : { title: '', template: null, keyterms: '' };
  let meeting;
  let recorder;
  try {
    meeting = await api.startRecording({
      title: draft.title.trim(),
      template: draft.template || state.settings.defaultTemplate,
      keyterms: draft.keyterms.split(',').map((t) => t.trim()).filter(Boolean),
    });
    state.recordingId = meeting.id;
    recorder = new Recorder({
      writeChunk: (part, buf) => api.sendChunk(meeting.id, part, buf),
      onFault: handleRecorderFault,
      skipSystemAudio,
    });
    await recorder.start();
  } catch (err) {
    if (meeting) await api.discardRecording(meeting.id);
    state.recordingId = null;
    api.showWindow();
    toast(`Couldn't start recording: ${cleanError(err)}`);
    return;
  }
  state.recorder = recorder;
  state.recordingTitle = meeting.title;
  state.diskError = null;
  state.reconnectedAt = null;
  state.selectedId = null;
  state.draft = { title: '', template: null, keyterms: '' };
  api.recordingInfo({ started: true, systemAudio: recorder.systemAudio, micAudio: recorder.micAudio });
  renderUpdate();
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

function handleRecorderFault(fault) {
  const r = state.recorder;
  if (fault.error) fault = { ...fault, error: cleanError(fault.error) };
  api.recordingFault(fault);
  if (fault.kind === 'disk') {
    state.diskError = fault.recovered ? null : fault.error || 'Saving failed';
  } else if (fault.kind === 'capture' && fault.recovered) {
    state.reconnectedAt = r ? clock(r.elapsedSeconds()) : null;
    api.recordingInfo({ systemAudio: fault.systemAudio, micAudio: fault.micAudio });
  } else if (fault.kind === 'capture') {
    // Couldn't reconnect: save what we have and make notes from it.
    exclusive(stopRecording);
    return;
  }
  if (state.recorder) renderRecording();
}

async function finishRecorder() {
  clearInterval(state.tick);
  const id = state.recordingId;
  const { seconds, unsaved } = await state.recorder.stop();
  state.recorder = null;
  state.recordingId = null;
  state.diskError = null;
  renderUpdate();
  return { id, seconds, unsaved };
}

async function stopRecording() {
  if (!state.recorder) return;
  const { id, seconds, unsaved } = await finishRecorder();
  await api.stopRecording(id, seconds, { unsaved });
  if (unsaved) toast(`About ${unsaved} seconds of audio couldn't be saved.`);
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
window.sidebarToggle = () => exclusive(() => (state.recorder ? stopRecording() : startRecording()));

// Called when the app is quitting mid-recording: save the last seconds.
window.sidebarStopForQuit = () =>
  exclusive(async () => {
    if (!state.recorder) return;
    const { id, seconds, unsaved } = await finishRecorder();
    await api.stopRecording(id, seconds, { quitting: true, unsaved });
  });

// Called after the computer wakes from sleep.
window.sidebarCheckRecording = () => {
  if (state.recorder) state.recorder.checkHealth();
};

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

// Re-render the meeting view while keeping whatever the user is typing
// (title, a question, a speaker name) and where they were scrolled.
function rerenderMeeting() {
  const active = document.activeElement;
  let restore = null;
  if (active && active.tagName === 'INPUT' && $('#view').contains(active)) {
    const selector = active.id ? `#${active.id}` : active.dataset.key ? `input[data-key="${CSS.escape(active.dataset.key)}"]` : null;
    if (selector) restore = { selector, value: active.value, start: active.selectionStart, end: active.selectionEnd };
  }
  const scrollTop = $('#tabBody') ? $('#tabBody').scrollTop : 0;
  renderMeeting();
  if ($('#tabBody')) $('#tabBody').scrollTop = scrollTop;
  const el = restore && $(restore.selector);
  if (el) {
    el.value = restore.value;
    el.focus();
    try {
      el.setSelectionRange(restore.start, restore.end);
    } catch {
      // not a text input
    }
  }
}

api.onMeetingUpdated(async (meeting) => {
  await refreshMeetings();
  if (meeting.id !== state.selectedId || state.recorder) return;
  const detail = await api.getMeeting(meeting.id);
  // The user may have moved on while we were loading.
  if (meeting.id !== state.selectedId || state.recorder) return;
  state.detail = detail;
  rerenderMeeting();
});

api.onOpenMeeting((id) => openMeeting(id));

// ---------- settings & notice ----------

function fillSettingsForm() {
  const form = $('#settingsForm');
  const s = state.settings;
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') el.checked = Boolean(s[el.name]);
    else if (el.type === 'password') el.value = ''; // keys are write-only
    else el.value = s[el.name] ?? '';
  }
  // Saved keys are never sent back to this window; just say they're there.
  form.elements.deepgramApiKey.placeholder = s.hasDeepgramKey ? 'Saved. Paste a new key to replace it' : 'Paste key';
  form.elements.anthropicApiKey.placeholder = s.hasAnthropicKey ? 'Saved. Paste a new key to replace it' : 'sk-ant-…';
  const c = s.costs || {};
  const row = (label, v = {}) => `
    <div class="cost-row"><span>${label}</span><strong>${money((v.transcription || 0) + (v.ai || 0))}</strong>
    <small>Transcription ${money(v.transcription)} · AI ${money(v.ai)}</small></div>`;
  $('#costSummary').innerHTML = row('This month', c.thisMonth) + row('Last month', c.lastMonth) + row('All time', c.allTime);
  $('#encryptionHint').textContent = s.encrypted
    ? 'Keys are stored encrypted on this computer.'
    : 'Keys are stored on this computer.';
}

async function openSettings() {
  // Refresh so the cost totals are current.
  state.settings = { ...state.settings, ...(await api.getSettings()) };
  fillSettingsForm();
  const dialog = $('#settingsDialog');
  dialog.returnValue = '';
  dialog.showModal();
}

$('#settingsBtn').addEventListener('click', openSettings);
$('#cancelSettings').addEventListener('click', () => $('#settingsDialog').close('cancel'));

$('#settingsDialog').addEventListener('close', async () => {
  if ($('#settingsDialog').returnValue !== 'save') return;
  const form = $('#settingsForm');
  const patch = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'password' && !el.value.trim()) continue; // leave the saved key alone
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
      render();
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

// ---------- updates ----------

function updateStatusText(u) {
  switch (u.status) {
    case 'dev': return 'Updates are turned off in development builds.';
    case 'checking': return 'Checking for updates…';
    case 'current': return "You're on the latest version.";
    case 'available': return u.manual ? `Version ${u.version} is available to download.` : `Version ${u.version} is available.`;
    case 'downloading': return `Downloading version ${u.version || ''}… ${u.progress || 0}%`;
    case 'installing': return 'Installing the update…';
    case 'ready': return `Version ${u.version} is ready. Restart Sidebar to finish updating.`;
    case 'error': return u.error || 'Couldn’t check for updates.';
    default: return '';
  }
}

function renderUpdate() {
  const u = state.update || {};
  $('#appVersion').textContent = u.current ? `v${u.current}` : '';
  $('#updateStatus').textContent = updateStatusText(u);
  $('#checkUpdatesBtn').disabled = ['checking', 'downloading', 'installing', 'dev'].includes(u.status);

  const banner = $('#updateBanner');
  const recording = Boolean(state.recorder);
  let html = '';
  if (u.status === 'ready') {
    html = `<div><strong>Sidebar ${esc(u.version)} is ready.</strong> ${recording ? 'You can restart once this recording is done.' : 'Restart to finish updating.'}</div>
      <button class="btn primary" id="installUpdateBtn" ${recording ? 'disabled' : ''}>Restart to update</button>`;
  } else if (u.status === 'available' && u.manual) {
    html = `<div><strong>Sidebar ${esc(u.version)} is available.</strong> Download it and drag it into Applications to update.</div>
      <button class="btn primary" id="installUpdateBtn">Download update</button>`;
  } else if (u.status === 'downloading' && u.version) {
    html = `<div>Downloading Sidebar ${esc(u.version)}…</div><div class="bar"><i style="width:${Number(u.progress) || 0}%"></i></div>`;
  } else if (u.status === 'installing') {
    html = '<div>Installing the update. Sidebar will reopen in a moment…</div>';
  } else if (u.status === 'error' && u.version) {
    html = `<div><strong>Updating to ${esc(u.version)} didn't work.</strong> ${esc(u.error || '')}</div>
      <button class="btn ghost" id="installUpdateBtn" ${recording ? 'disabled' : ''}>Try again</button>`;
  }
  banner.hidden = !html;
  banner.innerHTML = html;
  const btn = $('#installUpdateBtn');
  if (btn) {
    btn.addEventListener('click', async () => {
      const result = await api.installUpdate();
      if (result && !result.ok && result.reason) toast(result.reason);
    });
  }
}

api.onUpdateState((u) => {
  state.update = u;
  renderUpdate();
});

$('#checkUpdatesBtn').addEventListener('click', async () => {
  state.update = await api.checkForUpdates();
  renderUpdate();
});

// ---------- boot ----------

(async function init() {
  state.settings = await api.getSettings();
  state.update = await api.getUpdate();
  renderUpdate();
  document.body.classList.add(`platform-${state.settings.platform}`);
  await refreshMeetings();
  render();
})();
