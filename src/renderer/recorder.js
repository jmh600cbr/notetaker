// Records the microphone and the computer's audio output into stereo files:
// left channel = microphone (you), right channel = computer audio (the call).
// Nothing joins the meeting; this only listens to your own device.
//
// Hearings can't be repeated, so the recorder watches itself: if a device
// drops out (headset unplugged, audio service restarted, laptop woke from
// sleep) it restarts capture into the next audio part, and if audio can't be
// saved it keeps it in memory and keeps retrying, reporting both to the app.

const CHUNK_MS = 5000;
const STALL_MS = 20000;
const RESTART_ATTEMPTS = 3;
// A working microphone always picks up some room noise. Complete silence for
// this long while other people are talking means it's muted or the wrong one.
const MIC_SILENT_MS = 2 * 60 * 1000;
const MIC_SILENT_PEAK = 0.0003;
const CALL_SOUND_RMS = 0.02;

class Recorder {
  constructor({ writeChunk, onFault, skipSystemAudio = false }) {
    this.writeChunk = writeChunk; // (part, ArrayBuffer) => Promise
    this.onFault = onFault || (() => {});
    this.skipSystemAudio = skipSystemAudio;
    this.state = 'idle'; // idle | recording | paused | failed
    this.part = 0;
    this.capture = null;
    this.queue = [];
    this.pumping = null;
    this.writeFailing = false;
    this.elapsedMs = 0;
    this.resumedAt = 0;
    this.lastChunkAt = 0;
  }

  get systemAudio() {
    return Boolean(this.capture && this.capture.system);
  }

  get micAudio() {
    return Boolean(this.capture && this.capture.mic);
  }

  async start() {
    this.capture = await this.openCapture(0);
    this.state = 'recording';
    this.resumedAt = Date.now();
    this.lastChunkAt = Date.now();
    this.resetSoundClock();
    this.watchdog = setInterval(() => this.checkHealth(), 5000);
    this.sampler = setInterval(() => this.sampleSound(), 250);
  }

  // ---- silent microphone ----

  resetSoundClock() {
    this.micSoundAt = Date.now();
    this.callSoundAt = 0;
  }

  sampleSound() {
    const c = this.capture;
    if (this.state !== 'recording' || this.restarting || !c || c.closed) return;
    const now = Date.now();
    if (c.micAnalyser && Recorder.peak(c.micAnalyser) > MIC_SILENT_PEAK) this.micSoundAt = now;
    if (c.systemAnalyser && Recorder.level(c.systemAnalyser) > CALL_SOUND_RMS) this.callSoundAt = now;
    const limit = Recorder.MIC_SILENT_MS || MIC_SILENT_MS;
    const silent = Boolean(c.mic) && now - this.micSoundAt > limit && now - this.callSoundAt < limit;
    if (silent && !this.micSilent) {
      this.micSilent = true;
      this.onFault({ kind: 'mic-silent', recovered: false });
    } else if (this.micSilent && now - this.micSoundAt < 1000) {
      this.micSilent = false;
      this.onFault({ kind: 'mic-silent', recovered: true });
    }
  }

  // Reopens the microphone and computer audio, picking up whatever devices
  // the system is using now (e.g. after switching from Teams to a browser).
  restartCapture() {
    return this.fault(this.capture, 'reconnected by user');
  }

  // ---- capture ----

  async openCapture(part) {
    const capture = { part, mic: null, system: null, closed: false };
    try {
      capture.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (err) {
      console.warn('Microphone unavailable:', err);
      capture.micError = err;
    }
    if (!this.skipSystemAudio) {
      try {
        capture.system = await this.captureSystemAudio();
      } catch (err) {
        console.warn('System audio unavailable:', err);
        capture.systemError = err;
      }
    }
    if (!capture.mic && !capture.system) {
      throw new Error(
        `Sidebar couldn't use the microphone or the computer's audio (${(capture.micError || capture.systemError || {}).message || 'no audio source'}).`,
      );
    }

    try {
      capture.ctx = new AudioContext({ sampleRate: 48000 });
      await capture.ctx.resume();
      const merger = capture.ctx.createChannelMerger(2);
      const destination = capture.ctx.createMediaStreamDestination();
      destination.channelCount = 2;
      if (capture.mic) {
        const src = capture.ctx.createMediaStreamSource(capture.mic);
        src.connect(merger, 0, 0);
        capture.micAnalyser = this.analyser(capture.ctx, src);
      }
      if (capture.system) {
        const src = capture.ctx.createMediaStreamSource(capture.system);
        src.connect(merger, 0, 1);
        capture.systemAnalyser = this.analyser(capture.ctx, src);
      }
      merger.connect(destination);

      capture.recorder = new MediaRecorder(destination.stream, {
        mimeType: 'audio/webm;codecs=opus',
        audioBitsPerSecond: 64000,
      });
      capture.recorder.ondataavailable = (event) => {
        if (!event.data || !event.data.size) return;
        this.lastChunkAt = Date.now();
        this.enqueue(part, event.data);
      };
      capture.recorder.onerror = (event) => this.fault(capture, `recording error: ${event.error ? event.error.message : 'unknown'}`);
      capture.ctx.onstatechange = () => {
        if (capture.ctx.state !== 'running' && !capture.closed) this.fault(capture, `audio engine ${capture.ctx.state}`);
      };
      for (const [name, stream] of [['microphone', capture.mic], ['computer audio', capture.system]]) {
        if (!stream) continue;
        for (const track of stream.getAudioTracks()) {
          track.addEventListener('ended', () => this.fault(capture, `${name} stopped`));
        }
      }
      capture.recorder.start(CHUNK_MS);
      return capture;
    } catch (err) {
      await this.closeCapture(capture);
      throw err;
    }
  }

  async captureSystemAudio() {
    await window.sidebar.enableLoopbackAudio();
    let stream;
    try {
      // If the OS gives the loopback handler no source (e.g. macOS permission
      // missing), getDisplayMedia never settles. Give up after a while and
      // record the microphone only, rather than hanging.
      const request = navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for computer audio.')), 20000);
      });
      try {
        stream = await Promise.race([request, timeout]);
      } catch (err) {
        // Release the stream if it arrives after we gave up.
        request.then((late) => late.getTracks().forEach((t) => t.stop())).catch(() => {});
        throw err;
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await window.sidebar.disableLoopbackAudio();
    }
    for (const track of stream.getVideoTracks()) {
      track.stop();
      stream.removeTrack(track);
    }
    if (!stream.getAudioTracks().length) throw new Error('No computer audio track was provided.');
    return stream;
  }

  // Stops a capture, waiting for its last chunk to be queued.
  async closeCapture(capture) {
    if (!capture || capture.closed) return;
    capture.closed = true;
    const rec = capture.recorder;
    if (rec && rec.state !== 'inactive') {
      const stopped = new Promise((resolve) => {
        rec.onstop = resolve;
        setTimeout(resolve, 3000); // a broken recorder may never fire onstop
      });
      try {
        rec.stop();
      } catch {
        // already stopped
      }
      await stopped;
    }
    for (const stream of [capture.mic, capture.system]) {
      if (stream) stream.getTracks().forEach((t) => t.stop());
    }
    if (capture.ctx && capture.ctx.state !== 'closed') await capture.ctx.close().catch(() => {});
  }

  // ---- self-healing ----

  checkHealth() {
    if (this.state === 'recording' && !this.restarting && Date.now() - this.lastChunkAt > STALL_MS) {
      this.fault(this.capture, 'no audio arriving');
    }
  }

  async fault(capture, reason) {
    if (capture !== this.capture || capture.closed || this.restarting) return;
    if (this.state !== 'recording' && this.state !== 'paused') return;
    this.restarting = true;
    const wasPaused = this.state === 'paused';
    await this.closeCapture(capture);
    let error = null;
    for (let attempt = 1; attempt <= RESTART_ATTEMPTS; attempt++) {
      if (this.state === 'idle') break; // stopped meanwhile
      try {
        this.part += 1;
        this.capture = await this.openCapture(this.part);
        if (wasPaused) this.capture.recorder.pause();
        this.lastChunkAt = Date.now();
        this.resetSoundClock();
        if (this.micSilent) {
          this.micSilent = false;
          this.onFault({ kind: 'mic-silent', recovered: true });
        }
        error = null;
        break;
      } catch (err) {
        error = err;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    this.restarting = false;
    if (this.state === 'idle') return;
    if (error) {
      if (!wasPaused) this.elapsedMs += Date.now() - this.resumedAt;
      this.state = 'failed';
      this.onFault({ kind: 'capture', recovered: false, reason, error: error.message });
    } else {
      this.onFault({ kind: 'capture', recovered: true, reason, systemAudio: this.systemAudio, micAudio: this.micAudio });
    }
  }

  // ---- saving ----

  enqueue(part, blob) {
    this.queue.push({ part, blob });
    if (!this.pumping) this.pumping = this.pump().finally(() => (this.pumping = null));
  }

  // Writes queued chunks strictly in order. A chunk that fails to save is
  // retried until it succeeds; it is never skipped (the first chunk of each
  // part holds the file header, so skipping it would ruin the whole part).
  async pump() {
    while (this.queue.length) {
      const item = this.queue[0];
      try {
        if (!item.buf) item.buf = await item.blob.arrayBuffer();
        await this.writeChunk(item.part, item.buf);
        this.queue.shift();
        if (this.writeFailing) {
          this.writeFailing = false;
          this.onFault({ kind: 'disk', recovered: true });
        }
      } catch (err) {
        if (!this.writeFailing) {
          this.writeFailing = true;
          this.onFault({ kind: 'disk', recovered: false, error: err.message });
        }
        item.tries = (item.tries || 0) + 1;
        if (this.stopping && item.tries > 3) throw err;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  unsavedSeconds() {
    return Math.round((this.queue.length * CHUNK_MS) / 1000);
  }

  // ---- levels & time ----

  analyser(ctx, source) {
    const node = ctx.createAnalyser();
    node.fftSize = 1024;
    source.connect(node);
    return node;
  }

  static peak(node) {
    const data = new Float32Array(node.fftSize);
    node.getFloatTimeDomainData(data);
    let max = 0;
    for (const v of data) max = Math.max(max, Math.abs(v));
    return max;
  }

  static level(node) {
    if (!node) return 0;
    const data = new Float32Array(node.fftSize);
    node.getFloatTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += v * v;
    const rms = Math.sqrt(sum / data.length);
    return Math.min(1, rms * 4);
  }

  levels() {
    const c = this.capture;
    if (!c || c.closed || this.state !== 'recording') return { mic: 0, system: 0 };
    return { mic: Recorder.level(c.micAnalyser), system: Recorder.level(c.systemAnalyser) };
  }

  elapsedSeconds() {
    const running = this.state === 'recording' ? Date.now() - this.resumedAt : 0;
    return Math.floor((this.elapsedMs + running) / 1000);
  }

  // ---- controls ----

  pause() {
    if (this.state !== 'recording') return;
    const rec = this.capture.recorder;
    // Save what's buffered now, so nothing sits in memory through a long recess.
    if (rec.state === 'recording') {
      rec.requestData();
      rec.pause();
    }
    this.elapsedMs += Date.now() - this.resumedAt;
    this.state = 'paused';
  }

  resume() {
    if (this.state !== 'paused') return;
    const rec = this.capture.recorder;
    if (rec.state === 'paused') rec.resume();
    this.resumedAt = Date.now();
    this.lastChunkAt = Date.now();
    this.resetSoundClock();
    this.state = 'recording';
  }

  // Stops recording and waits until every chunk is saved. Resolves with the
  // recorded seconds and how many seconds (if any) couldn't be saved.
  async stop() {
    const seconds = this.elapsedSeconds();
    this.state = 'idle';
    clearInterval(this.watchdog);
    clearInterval(this.sampler);
    await this.closeCapture(this.capture);
    this.stopping = true;
    let unsaved = 0;
    try {
      if (this.pumping) await this.pumping;
      if (this.queue.length) await this.pump();
    } catch {
      unsaved = this.unsavedSeconds();
    }
    return { seconds, unsaved };
  }
}

window.Recorder = Recorder;
