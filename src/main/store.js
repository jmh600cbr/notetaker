// Local storage for settings and meetings. Everything lives in the user's
// app-data folder; nothing is uploaded except to the transcription and
// summary APIs during processing.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECRET_KEYS = ['deepgramApiKey', 'anthropicApiKey'];

const DEFAULT_SETTINGS = {
  deepgramApiKey: '',
  anthropicApiKey: '',
  defaultTemplate: 'court',
  keepAudio: false,
  headphones: true,
  openAtLogin: false,
  language: 'en',
  acceptedNotice: false,
};

const CHOICES = {
  defaultTemplate: ['court', 'client', 'general'],
  language: ['en', 'fr', 'multi'],
};

function pickKnown(obj) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([k]) => k in DEFAULT_SETTINGS));
}

// Keep only known settings with the right types, so a bad import file or a
// confused renderer can't store junk.
function sanitizeSettings(patch) {
  const out = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    const expected = typeof DEFAULT_SETTINGS[key];
    if (expected === 'boolean') {
      if (typeof value === 'boolean') out[key] = value;
    } else if (typeof value === 'string') {
      const v = value.trim().slice(0, 500);
      if (CHOICES[key] && !CHOICES[key].includes(v)) continue;
      out[key] = v;
    }
  }
  return out;
}

class Store {
  constructor(baseDir, safeStorage) {
    this.baseDir = baseDir;
    this.safeStorage = safeStorage;
    this.meetingsDir = path.join(baseDir, 'meetings');
    this.settingsPath = path.join(baseDir, 'settings.json');
    fs.mkdirSync(this.meetingsDir, { recursive: true });
  }

  // ---- settings ----

  canEncrypt() {
    return Boolean(this.safeStorage && this.safeStorage.isEncryptionAvailable());
  }

  readRawSettings() {
    try {
      return JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
    } catch {
      return {}; // first run
    }
  }

  // Full settings, including decrypted API keys. Main process only.
  getSettings({ includeEnv = true } = {}) {
    const raw = this.readRawSettings();
    const settings = { ...DEFAULT_SETTINGS, ...pickKnown(raw) };
    for (const key of SECRET_KEYS) {
      const enc = raw[`${key}Enc`];
      if (enc && !this.canEncrypt()) {
        // The keychain isn't available (e.g. access denied after an update).
        settings.keysLocked = true;
      } else if (enc) {
        try {
          settings[key] = this.safeStorage.decryptString(Buffer.from(enc, 'base64'));
        } catch {
          // e.g. keychain access denied after an update; tell the user why.
          settings[key] = '';
          settings.keysLocked = true;
        }
      }
    }
    // Environment variables let an admin preconfigure keys without the UI.
    // They're used, but never written to disk or into team exports.
    if (!includeEnv) return settings;
    if (!settings.deepgramApiKey && process.env.DEEPGRAM_API_KEY) {
      settings.deepgramApiKey = process.env.DEEPGRAM_API_KEY;
    }
    if (!settings.anthropicApiKey && process.env.ANTHROPIC_API_KEY) {
      settings.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    }
    return settings;
  }

  // What the UI may see: everything except the keys themselves.
  getPublicSettings() {
    const s = this.getSettings();
    const pub = { ...s, hasDeepgramKey: Boolean(s.deepgramApiKey), hasAnthropicKey: Boolean(s.anthropicApiKey) };
    for (const key of SECRET_KEYS) delete pub[key];
    return pub;
  }

  // Applies a validated patch. Secrets are only replaced when a new non-empty
  // value is given, and existing encrypted secrets are kept untouched otherwise
  // (even if they can't be decrypted right now).
  saveSettings(patch) {
    const clean = sanitizeSettings(patch);
    const raw = this.readRawSettings();
    const onDisk = { ...DEFAULT_SETTINGS, ...pickKnown(raw) };
    for (const key of SECRET_KEYS) {
      if (raw[`${key}Enc`]) onDisk[`${key}Enc`] = raw[`${key}Enc`];
    }
    for (const [key, value] of Object.entries(clean)) {
      if (SECRET_KEYS.includes(key)) {
        if (!value) continue;
        delete onDisk[`${key}Enc`];
        if (this.canEncrypt()) {
          onDisk[`${key}Enc`] = this.safeStorage.encryptString(value).toString('base64');
          onDisk[key] = '';
        } else {
          onDisk[key] = value;
        }
      } else {
        onDisk[key] = value;
      }
    }
    fs.writeFileSync(this.settingsPath, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
    return this.getPublicSettings();
  }

  // ---- meetings ----

  meetingDir(id) {
    if (!/^[\w-]+$/.test(id)) throw new Error('Invalid meeting id');
    return path.join(this.meetingsDir, id);
  }

  // A recording is one or more audio files: if the microphone or computer
  // audio drops out mid-meeting, capture restarts into the next part.
  audioPath(id, part = 0) {
    return path.join(this.meetingDir(id), part ? `audio-${part}.webm` : 'audio.webm');
  }

  audioFiles(id) {
    const dir = this.meetingDir(id);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .map((n) => ({ n, m: /^audio(?:-(\d+))?\.webm$/.exec(n) }))
      .filter((x) => x.m)
      .map((x) => ({ part: Number(x.m[1] || 0), file: path.join(dir, x.n) }))
      .sort((a, b) => a.part - b.part)
      .map((x) => x.file);
  }

  // Bytes free on the disk that holds recordings, or null if unknown.
  freeSpace() {
    try {
      const st = fs.statfsSync(this.baseDir);
      return st.bavail * st.bsize;
    } catch {
      return null;
    }
  }

  createMeeting({ title, template, keyterms }) {
    const now = new Date();
    const id = `${now.toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;
    const meeting = {
      id,
      title: title || `Meeting ${now.toLocaleString()}`,
      template: template || 'court',
      keyterms: keyterms || [],
      createdAt: now.toISOString(),
      durationSec: 0,
      status: 'recording',
      error: null,
      speakers: {},
      summary: '',
      hasAudio: true,
    };
    fs.mkdirSync(this.meetingDir(id), { recursive: true });
    this.writeMeeting(meeting);
    return meeting;
  }

  // Write to a temp file and rename, so a crash mid-write never leaves a
  // half-written meeting.json.
  writeMeeting(meeting) {
    const file = path.join(this.meetingDir(meeting.id), 'meeting.json');
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(meeting, null, 2));
    fs.renameSync(`${file}.tmp`, file);
    return meeting;
  }

  getMeeting(id) {
    return JSON.parse(fs.readFileSync(path.join(this.meetingDir(id), 'meeting.json'), 'utf8'));
  }

  updateMeeting(id, patch) {
    return this.writeMeeting({ ...this.getMeeting(id), ...patch });
  }

  listMeetings() {
    const out = [];
    for (const id of fs.readdirSync(this.meetingsDir)) {
      try {
        out.push(this.getMeeting(id));
      } catch {
        // meeting.json is missing or damaged. If there's audio, don't lose it:
        // rebuild a record the user can process with Retry.
        try {
          const rebuilt = this.rebuildMeeting(id);
          if (rebuilt) out.push(rebuilt);
        } catch {
          // not a meeting folder
        }
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  rebuildMeeting(id) {
    const files = this.audioFiles(id);
    if (!files.length) return null;
    const created = fs.statSync(files[0]).birthtime || new Date();
    return this.writeMeeting({
      id,
      title: `Recovered recording ${created.toLocaleString()}`,
      template: 'general',
      keyterms: [],
      createdAt: created.toISOString(),
      durationSec: 0,
      status: 'error',
      error: 'This meeting\'s details were damaged, but its audio was saved. Click "Retry" to make notes.',
      speakers: {},
      summary: '',
      hasAudio: true,
    });
  }

  deleteMeeting(id) {
    fs.rmSync(this.meetingDir(id), { recursive: true, force: true });
  }

  appendAudio(id, part, buffer) {
    fs.appendFileSync(this.audioPath(id, part), buffer);
  }

  deleteAudio(id) {
    for (const file of this.audioFiles(id)) fs.rmSync(file, { force: true });
    return this.updateMeeting(id, { hasAudio: false });
  }

  saveTranscript(id, segments) {
    const file = path.join(this.meetingDir(id), 'transcript.json');
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(segments, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  }

  hasTranscript(id) {
    return fs.existsSync(path.join(this.meetingDir(id), 'transcript.json'));
  }

  getTranscript(id) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.meetingDir(id), 'transcript.json'), 'utf8'));
    } catch {
      return [];
    }
  }

  // Meetings left in "recording" after a crash or force-quit still have their
  // audio on disk, so they can be processed later.
  recoverInterrupted() {
    for (const m of this.listMeetings()) {
      if (['recording', 'transcribing', 'identifying', 'summarizing'].includes(m.status)) {
        this.updateMeeting(m.id, {
          status: 'error',
          error: 'Sidebar closed before this meeting finished processing. Click "Retry" to process the saved audio.',
        });
      }
    }
  }
}

module.exports = { Store, DEFAULT_SETTINGS, sanitizeSettings };
