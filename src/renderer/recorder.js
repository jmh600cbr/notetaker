// Records the microphone and the computer's audio output into one stereo file:
// left channel = microphone (you), right channel = computer audio (the call).
// Nothing joins the meeting; this only listens to your own device.

class Recorder {
  constructor() {
    this.state = 'idle'; // idle | recording | paused
    this.systemAudio = false;
    this.chunkChain = Promise.resolve();
    this.elapsedMs = 0;
    this.resumedAt = 0;
  }

  async start(onChunk) {
    this.onChunk = onChunk;
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });

    try {
      this.system = await this.captureSystemAudio();
      this.systemAudio = true;
    } catch (err) {
      console.warn('System audio unavailable:', err);
      this.system = null;
      this.systemAudio = false;
      this.systemError = err;
    }

    this.ctx = new AudioContext({ sampleRate: 48000 });
    await this.ctx.resume();
    const merger = this.ctx.createChannelMerger(2);
    const destination = this.ctx.createMediaStreamDestination();
    destination.channelCount = 2;

    const micSource = this.ctx.createMediaStreamSource(this.mic);
    micSource.connect(merger, 0, 0);
    this.micAnalyser = this.analyser(micSource);

    if (this.system) {
      const systemSource = this.ctx.createMediaStreamSource(this.system);
      systemSource.connect(merger, 0, 1);
      this.systemAnalyser = this.analyser(systemSource);
    }
    merger.connect(destination);

    this.mediaRecorder = new MediaRecorder(destination.stream, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 64000,
    });
    this.mediaRecorder.ondataavailable = (event) => {
      if (!event.data || !event.data.size) return;
      // Keep chunks in order and write them to disk as we go, so a crash
      // never loses more than a few seconds.
      this.chunkChain = this.chunkChain
        .then(() => event.data.arrayBuffer())
        .then((buf) => this.onChunk(buf))
        .catch((err) => console.error('Failed to save audio chunk', err));
    };
    this.mediaRecorder.start(5000);
    this.state = 'recording';
    this.resumedAt = Date.now();
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

  analyser(source) {
    const node = this.ctx.createAnalyser();
    node.fftSize = 1024;
    source.connect(node);
    return node;
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
    return { mic: Recorder.level(this.micAnalyser), system: Recorder.level(this.systemAnalyser) };
  }

  elapsedSeconds() {
    const running = this.state === 'recording' ? Date.now() - this.resumedAt : 0;
    return Math.floor((this.elapsedMs + running) / 1000);
  }

  pause() {
    if (this.state !== 'recording') return;
    this.mediaRecorder.pause();
    this.elapsedMs += Date.now() - this.resumedAt;
    this.state = 'paused';
  }

  resume() {
    if (this.state !== 'paused') return;
    this.mediaRecorder.resume();
    this.resumedAt = Date.now();
    this.state = 'recording';
  }

  async stop() {
    const seconds = this.elapsedSeconds();
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      const stopped = new Promise((resolve) => {
        this.mediaRecorder.onstop = resolve;
      });
      this.mediaRecorder.stop();
      await stopped;
    }
    await this.chunkChain;
    for (const stream of [this.mic, this.system]) {
      if (stream) stream.getTracks().forEach((t) => t.stop());
    }
    if (this.ctx) await this.ctx.close();
    this.state = 'idle';
    return seconds;
  }
}

window.Recorder = Recorder;
