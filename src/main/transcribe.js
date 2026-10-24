// Speech-to-text via Deepgram's pre-recorded API.
//
// The recording is stereo: left = your microphone, right = computer audio
// (everyone else on the call). With headphones on, transcribing the channels
// separately tells us exactly which lines are yours. Without headphones the mic
// also picks up the speakers, so we let Deepgram mix the channels and rely on
// diarization alone to avoid duplicate lines.
const fs = require('fs');

const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';

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
  // Keyterm prompting (party names, case names, legal terms) is English-only on nova-3.
  if ((language || 'en').startsWith('en')) {
    for (const term of keyterms || []) {
      const clean = term.trim();
      if (clean) params.append('keyterm', clean);
    }
  }
  return `${DEEPGRAM_URL}?${params}`;
}

function speakerKey(utterance, multichannel) {
  const speaker = utterance.speaker ?? 0;
  return multichannel ? `${utterance.channel ?? 0}-${speaker}` : `${speaker}`;
}

// Turn Deepgram utterances into transcript segments, merging back-to-back
// lines from the same speaker so the transcript reads like a conversation.
function parseDeepgram(json, { multichannel }) {
  const utterances = (json.results && json.results.utterances) || [];
  const sorted = [...utterances].sort((a, b) => a.start - b.start);
  const segments = [];
  for (const u of sorted) {
    const text = (u.transcript || '').trim();
    if (!text) continue;
    const key = speakerKey(u, multichannel);
    const last = segments[segments.length - 1];
    if (last && last.speaker === key && u.start - last.end < 1.5) {
      last.text += ` ${text}`;
      last.end = u.end;
    } else {
      segments.push({ start: u.start, end: u.end, speaker: key, text });
    }
  }
  return segments;
}

// Friendly default names: in headphones mode the mic channel is "You".
function defaultSpeakerNames(segments, { multichannel }) {
  const names = {};
  const keys = [...new Set(segments.map((s) => s.speaker))];
  let n = 1;
  for (const key of keys) {
    if (multichannel && key === '0-0') names[key] = 'You';
    else if (multichannel && key.startsWith('0-')) names[key] = `In the room ${key.split('-')[1]}`;
    else names[key] = `Speaker ${n++}`;
  }
  return names;
}

async function transcribeFile(filePath, { apiKey, language, keyterms, headphones }) {
  if (!apiKey) throw new Error('Add your Deepgram API key in Settings to transcribe.');
  const multichannel = Boolean(headphones);
  const audio = await fs.promises.readFile(filePath);
  if (audio.length < 1000) throw new Error('No audio was captured for this meeting.');

  const res = await fetch(buildDeepgramUrl({ multichannel, language, keyterms }), {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'audio/webm',
    },
    body: audio,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('Deepgram rejected the API key. Check it in Settings.');
    throw new Error(`Transcription failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const json = await res.json();
  const segments = parseDeepgram(json, { multichannel });
  return {
    segments,
    speakers: defaultSpeakerNames(segments, { multichannel }),
    durationSec: Math.round((json.metadata && json.metadata.duration) || 0),
  };
}

module.exports = { transcribeFile, buildDeepgramUrl, parseDeepgram, defaultSpeakerNames };
