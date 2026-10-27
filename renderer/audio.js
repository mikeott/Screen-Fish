/* Captures mic + system audio, mixes them and streams 48 kHz stereo float PCM to the main process */
(function (window) {
  'use strict';

  const WORKLET = `
    class PcmTap extends AudioWorkletProcessor {
      constructor() {
        super();
        this.frames = 4800;
        this.buf = new Float32Array(this.frames * 2);
        this.n = 0;
      }
      process(inputs) {
        const ch = inputs[0] || [];
        const L = ch[0];
        const R = ch[1] || ch[0];
        const len = L ? L.length : 128;
        for (let i = 0; i < len; i++) {
          this.buf[this.n * 2] = L ? L[i] : 0;
          this.buf[this.n * 2 + 1] = R ? R[i] : 0;
          if (++this.n === this.frames) {
            this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
            this.buf = new Float32Array(this.frames * 2);
            this.n = 0;
          }
        }
        return true;
      }
    }
    registerProcessor('pcm-tap', PcmTap);
  `;

  const AudioCapture = {
    ctx: null,
    streams: [],
    tap: null,
    analyser: null,
    workletUrl: null,

    async listMics() {
      let devices = await navigator.mediaDevices.enumerateDevices();
      const unlabeled = devices.some(d => d.kind === 'audioinput' && !d.label);
      if (unlabeled) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true });
          s.getTracks().forEach(t => t.stop());
          devices = await navigator.mediaDevices.enumerateDevices();
        } catch (e) { /* no permission or no mic */ }
      }
      const def = devices.find(d => d.kind === 'audioinput' && d.deviceId === 'default');
      const list = devices
        .filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .map(d => ({ id: d.deviceId, label: d.label || 'Microphone' }));
      return {
        list,
        defaultLabel: def && def.label ? def.label.replace(/^Default\s*-\s*/i, '') : (list[0] ? list[0].label : '')
      };
    },

    // Desktop loopback via Electron's legacy constraint, falling back to getDisplayMedia
    async systemStream() {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: { mandatory: { chromeMediaSource: 'desktop' } },
          video: { mandatory: { chromeMediaSource: 'desktop', maxWidth: 16, maxHeight: 16, maxFrameRate: 1 } }
        });
      } catch (e) {
        return navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      }
    },

    async start(opts) {
      await this.stop();
      const warnings = [];
      const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      this.ctx = ctx;
      if (ctx.state === 'suspended') await ctx.resume();

      const mix = ctx.createGain();
      let sources = 0;

      if (opts.mic) {
        try {
          const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
          if (opts.micId && opts.micId !== 'default') audio.deviceId = { exact: opts.micId };
          const s = await navigator.mediaDevices.getUserMedia({ audio });
          this.streams.push(s);
          ctx.createMediaStreamSource(s).connect(mix);
          sources++;
        } catch (e) {
          warnings.push('Microphone unavailable');
        }
      }

      if (opts.system) {
        try {
          const s = await this.systemStream();
          s.getVideoTracks().forEach(t => t.stop());
          if (s.getAudioTracks().length) {
            this.streams.push(s);
            ctx.createMediaStreamSource(new MediaStream(s.getAudioTracks())).connect(mix);
            sources++;
          } else {
            warnings.push('System audio unavailable');
          }
        } catch (e) {
          warnings.push('System audio unavailable');
        }
      }

      if (!sources) {
        await this.stop();
        return { ok: false, warnings };
      }

      this.workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(this.workletUrl);

      const tap = new AudioWorkletNode(ctx, 'pcm-tap', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers'
      });
      tap.port.onmessage = e => opts.onData(new Uint8Array(e.data));

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;

      const mute = ctx.createGain();
      mute.gain.value = 0;

      mix.connect(tap);
      mix.connect(analyser);
      tap.connect(mute);
      mute.connect(ctx.destination);

      this.tap = tap;
      this.analyser = analyser;
      return { ok: true, warnings };
    },

    async stop() {
      if (this.tap) {
        this.tap.port.onmessage = null;
        try { this.tap.disconnect(); } catch (e) { /* ignore */ }
      }
      this.streams.forEach(s => s.getTracks().forEach(t => t.stop()));
      this.streams = [];
      if (this.ctx) {
        try { await this.ctx.close(); } catch (e) { /* ignore */ }
      }
      if (this.workletUrl) URL.revokeObjectURL(this.workletUrl);
      this.ctx = null;
      this.tap = null;
      this.analyser = null;
      this.workletUrl = null;
    }
  };

  window.AudioCapture = AudioCapture;
})(window);
