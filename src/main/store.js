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

  getSettings() {
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
    } catch {
      // first run
    }
    const settings = { ...DEFAULT_SETTINGS, ...raw };
    for (const key of SECRET_KEYS) {
      const enc = raw[`${key}Enc`];
      if (enc && this.canEncrypt()) {
        try {
          settings[key] = this.safeStorage.decryptString(Buffer.from(enc, 'base64'));
        } catch {
          settings[key] = '';
        }
      }
      delete settings[`${key}Enc`];
    }
    // Environment variables let an admin preconfigure keys without the UI.
    if (!settings.deepgramApiKey && process.env.DEEPGRAM_API_KEY) {
      settings.deepgramApiKey = process.env.DEEPGRAM_API_KEY;
    }
    if (!settings.anthropicApiKey && process.env.ANTHROPIC_API_KEY) {
      settings.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    }
    return settings;
  }

  saveSettings(patch) {
    const next = { ...this.getSettings(), ...patch };
    const onDisk = {};
    for (const [key, value] of Object.entries(next)) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      if (SECRET_KEYS.includes(key) && value && this.canEncrypt()) {
        onDisk[`${key}Enc`] = this.safeStorage.encryptString(value).toString('base64');
      } else {
        onDisk[key] = value;
      }
    }
    fs.writeFileSync(this.settingsPath, JSON.stringify(onDisk, null, 2));
    return this.getSettings();
  }

  // ---- meetings ----

  meetingDir(id) {
    if (!/^[\w-]+$/.test(id)) throw new Error('Invalid meeting id');
    return path.join(this.meetingsDir, id);
  }

  audioPath(id) {
    return path.join(this.meetingDir(id), 'audio.webm');
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

  writeMeeting(meeting) {
    fs.writeFileSync(
      path.join(this.meetingDir(meeting.id), 'meeting.json'),
      JSON.stringify(meeting, null, 2),
    );
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
        // skip half-written folders
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  deleteMeeting(id) {
    fs.rmSync(this.meetingDir(id), { recursive: true, force: true });
  }

  appendAudio(id, buffer) {
    fs.appendFileSync(this.audioPath(id), buffer);
  }

  deleteAudio(id) {
    fs.rmSync(this.audioPath(id), { force: true });
    return this.updateMeeting(id, { hasAudio: false });
  }

  saveTranscript(id, segments) {
    fs.writeFileSync(
      path.join(this.meetingDir(id), 'transcript.json'),
      JSON.stringify(segments, null, 2),
    );
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

module.exports = { Store, DEFAULT_SETTINGS };
