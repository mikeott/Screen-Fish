/* Scrolling level meter drawn as mirrored bars */
(function (window, $) {
  'use strict';

  const Wave = {
    $canvas: null,
    ctx: null,
    analyser: null,
    samples: null,
    levels: [],
    bars: 44,
    mode: 'idle',
    lastPush: 0,
    w: 0,
    h: 0,

    init(selector) {
      this.$canvas = $(selector);
      this.ctx = this.$canvas[0].getContext('2d');
      this.levels = new Array(this.bars).fill(0);
      this.resize();
      $(window).on('resize', () => this.resize());
      const loop = t => {
        this.frame(t);
        window.requestAnimationFrame(loop);
      };
      window.requestAnimationFrame(loop);
    },

    resize() {
      const el = this.$canvas[0];
      const dpr = window.devicePixelRatio || 1;
      this.w = this.$canvas.width();
      this.h = this.$canvas.height();
      el.width = Math.round(this.w * dpr);
      el.height = Math.round(this.h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    },

    attach(analyser) {
      this.analyser = analyser;
      this.samples = analyser ? new Float32Array(analyser.fftSize) : null;
    },

    setMode(mode) {
      this.mode = mode;
      if (mode === 'idle') this.levels.fill(0);
    },

    level() {
      if (!this.analyser) return 0;
      this.analyser.getFloatTimeDomainData(this.samples);
      let sum = 0;
      for (let i = 0; i < this.samples.length; i++) sum += this.samples[i] * this.samples[i];
      const rms = Math.sqrt(sum / this.samples.length);
      return Math.min(1, Math.sqrt(rms * 5));
    },

    frame(t) {
      if (this.mode === 'recording' && t - this.lastPush > 55) {
        this.lastPush = t;
        this.levels.shift();
        this.levels.push(this.level());
      }

      const c = this.ctx;
      const { w, h } = this;
      c.clearRect(0, 0, w, h);

      const gap = 4;
      const bw = 3;
      const total = this.bars * bw + (this.bars - 1) * gap;
      const x0 = (w - total) / 2;
      const mid = h / 2;
      const maxH = h * 0.78;
      const live = this.mode === 'recording';

      for (let i = 0; i < this.bars; i++) {
        const pos = i / (this.bars - 1);
        const env = 0.35 + 0.65 * Math.sin(Math.PI * pos);
        const v = this.levels[i] * env;
        const bh = Math.max(4, v * maxH);
        const x = x0 + i * (bw + gap);

        if (live) c.fillStyle = `rgba(240, 86, 107, ${0.55 + 0.45 * Math.min(1, v * 1.6)})`;
        else if (this.mode === 'paused') c.fillStyle = 'rgba(244, 177, 78, 0.45)';
        else c.fillStyle = 'rgba(255, 255, 255, 0.14)';

        c.beginPath();
        c.roundRect(x, mid - bh / 2, bw, bh, 1.5);
        c.fill();
      }
    }
  };

  window.Wave = Wave;
})(window, jQuery);
