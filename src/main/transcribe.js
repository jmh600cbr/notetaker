// Speech-to-text via Deepgram's pre-recorded API.
//
// The recording is stereo: left = your microphone, right = computer audio
// (everyone else on the call). With headphones on, transcribing the channels
// separately tells us exactly which lines are yours. Without headphones the mic
// also picks up the speakers, so we let Deepgram mix the channels and rely on
// diarization alone to avoid duplicate lines.
//
// A meeting can have several audio parts (capture restarts if a device drops
// out). Each part is transcribed separately and stitched together in time.
const fs = require('fs');

const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';

// Deepgram rejects requests whose key terms exceed ~500 tokens.
const MAX_KEYTERMS = 50;
const MAX_KEYTERM_CHARS = 60;
const MAX_KEYTERMS_TOTAL_CHARS = 1000;

function cleanKeyterms(keyterms) {
  const out = [];
  let total = 0;
  for (const term of keyterms || []) {
    const clean = String(term).replace(/\s+/g, ' ').trim().slice(0, MAX_KEYTERM_CHARS);
    if (!clean || out.includes(clean)) continue;
    if (out.length >= MAX_KEYTERMS || total + clean.length > MAX_KEYTERMS_TOTAL_CHARS) break;
    out.push(clean);
    total += clean.length;
  }
  return out;
}

function buildDeepgramUrl({ multichannel, language, keyterms }) {
  const params = new URLSearchParams({
    model: 'nova-3',
    smart_format: 'true',
    punctuate: 'true',
    utterances: 'true',
    diarize_model: 'latest',
    language: language || 'en',
  });
  if (multichannel) params.set('multichannel', 'true');
  // Key terms help with party names, case names and legal terms.
  for (const term of cleanKeyterms(keyterms)) params.append('keyterm', term);
  return `${DEEPGRAM_URL}?${params}`;
}

// Speaker keys: "<channel>-<speaker>" in headphones mode, "<speaker>" otherwise,
// prefixed with "<part>/" for audio parts after the first (speaker numbers
// from separate requests don't refer to the same people).
function speakerKey(utterance, multichannel, part) {
  const speaker = utterance.speaker ?? 0;
  const key = multichannel ? `${utterance.channel ?? 0}-${speaker}` : `${speaker}`;
  return part ? `${part}/${key}` : key;
}

function channelOf(key) {
  return key.split('/').pop().split('-')[0];
}

// Turn Deepgram utterances into transcript segments, merging back-to-back
// lines from the same speaker so the transcript reads like a conversation.
function parseDeepgram(json, { multichannel, part = 0, offset = 0 }) {
  const utterances = (json.results && json.results.utterances) || [];
  const sorted = [...utterances]
    .filter((u) => typeof u.start === 'number')
    .sort((a, b) => a.start - b.start);
  const segments = [];
  for (const u of sorted) {
    const text = (u.transcript || '').trim();
    if (!text) continue;
    const key = speakerKey(u, multichannel, part);
    const start = u.start + offset;
    const end = (typeof u.end === 'number' ? u.end : u.start) + offset;
    const last = segments[segments.length - 1];
    if (last && last.speaker === key && start - last.end < 1.5) {
      last.text += ` ${text}`;
      last.end = end;
    } else {
      segments.push({ start, end, speaker: key, text });
    }
  }
  return segments;
}

// Friendly default names. In headphones mode the first voice on the mic is
// "You", but only when there's also call audio: at an in-person hearing the
// laptop is silent and everyone is on the mic, and the first voice is just as
// likely to be the judge.
function defaultSpeakerNames(segments, { multichannel }) {
  const names = {};
  const keys = [...new Set(segments.map((s) => s.speaker))];
  const callParts = new Set(
    keys.filter((k) => multichannel && channelOf(k) === '1').map((k) => (k.includes('/') ? k.split('/')[0] : '')),
  );
  let n = 1;
  for (const key of keys) {
    const part = key.includes('/') ? key.split('/')[0] : '';
    const local = key.split('/').pop();
    if (multichannel && local === '0-0' && callParts.has(part)) names[key] = 'You';
    else names[key] = `Speaker ${n++}`;
  }
  return names;
}

function isTransient(err) {
  return err && (err.transient || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|socket/i.test(err.message || ''));
}

async function requestDeepgram(url, audio, { apiKey, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'audio/webm' },
      body: audio,
    });
  } catch (err) {
    const e = new Error(`Couldn't reach Deepgram (${err.message}). Check your internet connection and click Retry.`);
    e.transient = true;
    throw e;
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new Error('Deepgram rejected the API key. Check it in Settings.');
    }
    if (res.status === 402) throw new Error('Your Deepgram account is out of credit.');
    const e = new Error(`Transcription failed (${res.status}): ${detail.slice(0, 300)}`);
    e.status = res.status;
    e.transient = res.status === 429 || res.status >= 500;
    throw e;
  }
  return res.json();
}

async function transcribePart(file, opts, { part, offset }) {
  const multichannel = Boolean(opts.headphones);
  const audio = await fs.promises.readFile(file);
  if (audio.length < 1000) return { segments: [], duration: 0 };

  let keyterms = opts.keyterms;
  let json;
  for (let attempt = 1; ; attempt++) {
    try {
      json = await requestDeepgram(buildDeepgramUrl({ multichannel, language: opts.language, keyterms }), audio, opts);
      break;
    } catch (err) {
      // A bad request with key terms: try once more without them rather than
      // failing the same way on every Retry.
      if (err.status === 400 && keyterms && keyterms.length) {
        keyterms = [];
        continue;
      }
      if (isTransient(err) && attempt < 3) {
        await new Promise((r) => setTimeout(r, attempt * 5000));
        continue;
      }
      throw err;
    }
  }
  return {
    segments: parseDeepgram(json, { multichannel, part, offset }),
    duration: (json.metadata && json.metadata.duration) || 0,
  };
}

// Transcribes all audio parts of a meeting.
async function transcribeMeeting(files, opts) {
  if (!opts.apiKey) throw new Error('Add your Deepgram API key in Settings to transcribe.');
  if (!files.length) throw new Error('No audio was captured for this meeting.');
  const multichannel = Boolean(opts.headphones);
  let offset = 0;
  const segments = [];
  for (let part = 0; part < files.length; part++) {
    const result = await transcribePart(files[part], opts, { part, offset });
    segments.push(...result.segments);
    offset += result.duration;
  }
  return {
    segments,
    speakers: defaultSpeakerNames(segments, { multichannel }),
    durationSec: Math.round(offset),
  };
}

module.exports = { transcribeMeeting, buildDeepgramUrl, parseDeepgram, defaultSpeakerNames, cleanKeyterms };
