const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildDeepgramUrl, parseDeepgram, defaultSpeakerNames, cleanKeyterms } = require('../src/main/transcribe');
const { formatTranscript, formatTimestamp, TEMPLATES } = require('../src/main/summarize');
const { Store } = require('../src/main/store');

test('Deepgram URL enables diarization, channels and key terms', () => {
  const url = new URL(buildDeepgramUrl({ multichannel: true, language: 'en', keyterms: ['Justice Okafor', ' ', 'Rule 20'] }));
  assert.equal(url.searchParams.get('model'), 'nova-3');
  assert.equal(url.searchParams.get('multichannel'), 'true');
  assert.equal(url.searchParams.get('diarize_model'), 'latest');
  assert.deepEqual(url.searchParams.getAll('keyterm'), ['Justice Okafor', 'Rule 20']);
});

test('Deepgram URL keeps key terms for French and mixes channels without headphones', () => {
  const url = new URL(buildDeepgramUrl({ multichannel: false, language: 'fr', keyterms: ['Cour'] }));
  assert.equal(url.searchParams.get('multichannel'), null);
  assert.deepEqual(url.searchParams.getAll('keyterm'), ['Cour']);
});

test('key terms are capped so Deepgram never rejects them', () => {
  const terms = cleanKeyterms(['a'.repeat(500), 'Okafor', 'Okafor', ...Array.from({ length: 80 }, (_, i) => `Term ${i}`)]);
  assert.equal(terms[0].length, 60);
  assert.equal(terms.filter((t) => t === 'Okafor').length, 1);
  assert.ok(terms.length <= 50);
  assert.ok(terms.join('').length <= 1000);
});

test('the first mic voice is only "You" when there is call audio', () => {
  const inRoom = [{ speaker: '0-0' }, { speaker: '0-1' }];
  assert.deepEqual(defaultSpeakerNames(inRoom, { multichannel: true }), { '0-0': 'Speaker 1', '0-1': 'Speaker 2' });
  const later = [{ speaker: '1/0-0' }, { speaker: '1/1-0' }];
  assert.deepEqual(defaultSpeakerNames(later, { multichannel: true }), { '1/0-0': 'You', '1/1-0': 'Speaker 1' });
});

test('later audio parts are offset in time and keep separate speakers', () => {
  const json = { results: { utterances: [{ start: 1, end: 2, channel: 1, speaker: 0, transcript: 'Back on the record.' }] } };
  assert.deepEqual(parseDeepgram(json, { multichannel: true, part: 2, offset: 600 }), [
    { start: 601, end: 602, speaker: '2/1-0', text: 'Back on the record.' },
  ]);
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
  store.appendAudio(m.id, 0, Buffer.from('abc'));
  store.appendAudio(m.id, 0, Buffer.from('def'));
  store.appendAudio(m.id, 1, Buffer.from('ghi'));
  assert.equal(fs.readFileSync(store.audioPath(m.id), 'utf8'), 'abcdef');
  assert.deepEqual(store.audioFiles(m.id).map((f) => path.basename(f)), ['audio.webm', 'audio-1.webm']);
  assert.equal(store.listMeetings().length, 1);

  store.recoverInterrupted();
  assert.equal(store.getMeeting(m.id).status, 'error');

  store.deleteAudio(m.id);
  assert.equal(store.audioFiles(m.id).length, 0);
  assert.equal(store.getMeeting(m.id).hasAudio, false);

  const saved = store.saveSettings({ anthropicApiKey: ' k ', bogus: 1, keepAudio: 'yes', language: 'xx', defaultTemplate: 'client' });
  assert.equal(saved.hasAnthropicKey, true);
  assert.equal('anthropicApiKey' in saved, false, 'keys never go to the UI');
  assert.equal('bogus' in saved, false);
  assert.equal(saved.keepAudio, false, 'wrong types are ignored');
  assert.equal(saved.language, 'en', 'unknown choices are ignored');
  assert.equal(saved.defaultTemplate, 'client');
  assert.equal(store.getSettings().anthropicApiKey, 'k');

  // An empty key from the form leaves the saved key alone.
  store.saveSettings({ anthropicApiKey: '', headphones: false });
  assert.equal(store.getSettings().anthropicApiKey, 'k');

  // Environment keys are used but never written to disk.
  process.env.DEEPGRAM_API_KEY = 'from-env';
  assert.equal(store.getSettings().deepgramApiKey, 'from-env');
  store.saveSettings({ headphones: true });
  assert.equal(store.getSettings({ includeEnv: false }).deepgramApiKey, '');
  assert.ok(!fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').includes('from-env'));
  delete process.env.DEEPGRAM_API_KEY;
  assert.throws(() => store.meetingDir('../etc'));

  // A damaged meeting.json with audio still shows up, ready to Retry.
  const m2 = store.createMeeting({ title: 'Crash' });
  store.appendAudio(m2.id, 0, Buffer.from('xyz'));
  fs.writeFileSync(path.join(store.meetingDir(m2.id), 'meeting.json'), '{"id": "trunc');
  const rebuilt = store.listMeetings().find((x) => x.id === m2.id);
  assert.equal(rebuilt.status, 'error');
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

test('Claude gets the local meeting date, not the UTC date', () => {
  // 8:30 pm in Toronto is already the next day in UTC.
  const meeting = { title: 'A "quoted" <title>', createdAt: '2026-10-25T00:30:00.000Z', speakers: {} };
  const text = require('child_process').execFileSync(process.execPath, ['-e', `
    const { transcriptBlock } = require(${JSON.stringify(require.resolve('../src/main/summarize'))});
    process.stdout.write(transcriptBlock(${JSON.stringify(meeting)}, []).text);
  `], { env: { ...process.env, TZ: 'America/Toronto' } }).toString();
  assert.match(text, /date="Saturday, October 24, 2026"/);
  assert.match(text, /title="A &quot;quoted&quot; &lt;title&gt;"/);
});

test('cost estimates', () => {
  const { claudeCost, deepgramCost } = require('../src/main/pricing');
  // 1M input + 100k output tokens on Opus 5.5 = $4 + $2
  assert.equal(claudeCost({ input_tokens: 1e6, output_tokens: 1e5 }).toFixed(2), '6.00');
  // fallback attempts are each counted
  assert.equal(claudeCost({ input_tokens: 9, iterations: [{ input_tokens: 1e6 }, { input_tokens: 1e6 }] }).toFixed(2), '8.00');
  // one hour of stereo audio = 120 channel-minutes
  assert.equal(deepgramCost(3600 * 2, 0.0063).toFixed(3), '0.756');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-'));
  const store = new Store(dir, null);
  const m = store.createMeeting({ title: 'Costs' });
  store.addCost(m.id, { transcription: 0.5 });
  store.addCost(m.id, { ai: 0.25 });
  store.addCost(m.id, { ai: 0.25 });
  assert.deepEqual(store.getMeeting(m.id).cost, { transcription: 0.5, ai: 0.5 });
  const summary = store.getCostSummary();
  assert.equal(summary.thisMonth.ai, 0.5);
  assert.equal(summary.allTime.transcription, 0.5);
  assert.equal(store.saveSettings({ deepgramPerMinute: '0.0043' }).deepgramPerMinute, 0.0043);
  assert.equal(store.saveSettings({ deepgramPerMinute: 'abc' }).deepgramPerMinute, 0.0043);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('picks the calendar meeting that is on now', () => {
  const { pickEvent, attendeeNames } = require('../src/main/calendar');
  const now = new Date('2026-10-26T14:05:00Z');
  const ev = (id, start, end, extra = {}) => ({ id, start: { dateTime: start }, end: { dateTime: end }, ...extra });
  const events = [
    ev('focus', '2026-10-26T13:00:00.0000000', '2026-10-26T17:00:00.0000000'),
    ev('hearing', '2026-10-26T14:00:00.0000000', '2026-10-26T15:00:00.0000000', { isOnlineMeeting: true }),
    ev('later', '2026-10-26T16:00:00.0000000', '2026-10-26T17:00:00.0000000', { isOnlineMeeting: true }),
    ev('cancelled', '2026-10-26T14:00:00.0000000', '2026-10-26T15:00:00.0000000', { isCancelled: true, isOnlineMeeting: true }),
  ];
  assert.equal(pickEvent(events, now).id, 'hearing');
  // starting in 8 minutes still counts; in an hour doesn't
  assert.equal(pickEvent([ev('soon', '2026-10-26T14:13:00.0000000', '2026-10-26T15:00:00.0000000')], now).id, 'soon');
  assert.equal(pickEvent([events[2]], now), null);
  const names = attendeeNames({
    organizer: { emailAddress: { name: 'Justice Okafor' } },
    attendees: [{ emailAddress: { name: 'Priya Patel' } }, { emailAddress: { name: 'room-12@court.ca' } }, { emailAddress: { name: 'Priya Patel' } }],
  });
  assert.deepEqual(names, ['Justice Okafor', 'Priya Patel']);
});

test('app lock checks the password and blocks repeated guesses', () => {
  const { AppLock } = require('../src/main/lock');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-'));
  const lock = new AppLock(dir);
  assert.equal(lock.enabled(), false);
  assert.throws(() => lock.setPassword('123'));
  lock.setPassword('correct horse');
  assert.equal(lock.lock(), true);
  assert.equal(lock.unlock('wrong'), false);
  assert.equal(lock.locked, true);
  assert.equal(lock.unlock('correct horse'), true);
  assert.equal(lock.locked, false);
  assert.ok(!fs.readFileSync(path.join(dir, 'lock.json'), 'utf8').includes('correct horse'));
  for (let i = 0; i < 5; i++) lock.unlock('nope');
  assert.throws(() => lock.unlock('correct horse'), /Too many attempts/);
  assert.equal(new AppLock(dir).locked, true, 'starts locked when enabled');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('time entries bill in 6-minute increments, rounded up', () => {
  const { billableHours } = require('../src/main/summarize');
  assert.equal(billableHours(0), 0.1);
  assert.equal(billableHours(360), 0.1);
  assert.equal(billableHours(361), 0.2);
  assert.equal(billableHours(2460), 0.7);
});

test('settings validate numbers and never accept file paths from the window', () => {
  const { sanitizeSettings, PATH_SETTINGS } = require('../src/main/store');
  assert.deepEqual(sanitizeSettings({ retentionDays: '90', lockAfterMinutes: '0', saveFormat: 'pdf', retentionScope: 'everything' }), {
    retentionDays: 90,
    retentionScope: 'everything',
  });
  assert.deepEqual(PATH_SETTINGS.sort(), ['docLogo', 'saveFolder']);
});

test('Word export produces a document with the notes and transcript', async () => {
  const { buildDocx } = require('../src/main/docx');
  const buf = await buildDocx({
    meeting: { title: 'Motion', createdAt: new Date().toISOString(), durationSec: 600, summary: '## Overview\n- [ ] Serve claim <b>now</b>', speakers: { 0: 'Judge' }, matter: 'Smith' },
    segments: [{ start: 1, end: 2, speaker: '0', text: 'Granted.' }],
    headerText: 'Example LLP',
  });
  assert.equal(buf.slice(0, 2).toString(), 'PK');
  // jszip comes with the docx library
  const xml = await (await require('jszip').loadAsync(buf)).file('word/document.xml').async('string');
  assert.match(xml, /Serve claim/);
  assert.match(xml, /Granted\./);
  assert.doesNotMatch(xml, /&lt;b&gt;/);
});
