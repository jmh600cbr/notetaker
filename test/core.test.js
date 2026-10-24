const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildDeepgramUrl, parseDeepgram, defaultSpeakerNames } = require('../src/main/transcribe');
const { formatTranscript, formatTimestamp, TEMPLATES } = require('../src/main/summarize');
const { Store } = require('../src/main/store');

test('Deepgram URL enables diarization, channels and key terms', () => {
  const url = new URL(buildDeepgramUrl({ multichannel: true, language: 'en', keyterms: ['Justice Okafor', ' ', 'Rule 20'] }));
  assert.equal(url.searchParams.get('model'), 'nova-3');
  assert.equal(url.searchParams.get('multichannel'), 'true');
  assert.equal(url.searchParams.get('diarize_model'), 'latest');
  assert.deepEqual(url.searchParams.getAll('keyterm'), ['Justice Okafor', 'Rule 20']);
});

test('Deepgram URL skips key terms for non-English and mixes channels without headphones', () => {
  const url = new URL(buildDeepgramUrl({ multichannel: false, language: 'fr', keyterms: ['Cour'] }));
  assert.equal(url.searchParams.get('multichannel'), null);
  assert.deepEqual(url.searchParams.getAll('keyterm'), []);
});

test('utterances are sorted across channels and merged per speaker', () => {
  const json = {
    results: {
      utterances: [
        { start: 6, end: 7, channel: 1, speaker: 0, transcript: 'Counsel, go ahead.' },
        { start: 0, end: 2, channel: 1, speaker: 0, transcript: 'Good morning.' },
        { start: 2.5, end: 4, channel: 1, speaker: 0, transcript: 'Please be seated.' },
        { start: 7.5, end: 9, channel: 0, speaker: 0, transcript: 'Thank you, Your Honour.' },
        { start: 9.2, end: 9.3, channel: 0, speaker: 0, transcript: '  ' },
      ],
    },
  };
  const segments = parseDeepgram(json, { multichannel: true });
  assert.deepEqual(segments, [
    { start: 0, end: 4, speaker: '1-0', text: 'Good morning. Please be seated.' },
    { start: 6, end: 7, speaker: '1-0', text: 'Counsel, go ahead.' },
    { start: 7.5, end: 9, speaker: '0-0', text: 'Thank you, Your Honour.' },
  ]);
  assert.deepEqual(defaultSpeakerNames(segments, { multichannel: true }), { '1-0': 'Speaker 1', '0-0': 'You' });
});

test('without headphones every voice is a numbered speaker', () => {
  const segments = [{ speaker: '0' }, { speaker: '2' }, { speaker: '0' }];
  assert.deepEqual(defaultSpeakerNames(segments, { multichannel: false }), { 0: 'Speaker 1', 2: 'Speaker 2' });
});

test('transcript formatting uses timestamps and speaker names', () => {
  assert.equal(formatTimestamp(3725.9), '01:02:05');
  const text = formatTranscript(
    [{ start: 61, end: 62, speaker: '1-0', text: 'Adjourned to May 3.' }],
    { '1-0': 'Justice Okafor' },
  );
  assert.equal(text, '[00:01:01] Justice Okafor: Adjourned to May 3.');
  assert.ok(TEMPLATES.court.instructions.includes('Rulings'));
});

test('store saves meetings, audio and settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-'));
  const store = new Store(dir, null);
  const m = store.createMeeting({ title: 'Motion', template: 'court', keyterms: ['Okafor'] });
  store.appendAudio(m.id, Buffer.from('abc'));
  store.appendAudio(m.id, Buffer.from('def'));
  assert.equal(fs.readFileSync(store.audioPath(m.id), 'utf8'), 'abcdef');
  assert.equal(store.listMeetings().length, 1);

  store.recoverInterrupted();
  assert.equal(store.getMeeting(m.id).status, 'error');

  store.deleteAudio(m.id);
  assert.equal(fs.existsSync(store.audioPath(m.id)), false);
  assert.equal(store.getMeeting(m.id).hasAudio, false);

  const saved = store.saveSettings({ anthropicApiKey: 'k', bogus: 1 });
  assert.equal(saved.anthropicApiKey, 'k');
  assert.equal('bogus' in saved, false);
  assert.throws(() => store.meetingDir('../etc'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('update versions compare numerically', () => {
  const { isNewer } = require('../src/main/version');
  assert.equal(isNewer('v0.1.2', '0.1.1'), true);
  assert.equal(isNewer('v0.1.10', '0.1.9'), true);
  assert.equal(isNewer('v0.2.0', '0.10.0'), false);
  assert.equal(isNewer('v0.1.1', '0.1.1'), false);
  assert.equal(isNewer('v1.0.0', '0.9.9'), true);
});
