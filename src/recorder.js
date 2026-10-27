'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const net = require('net');
const path = require('path');
const fs = require('fs');

const LEVELS = ['speed', 'balanced', 'quality', 'max'];
const PRESETS = {
  x264: ['ultrafast', 'veryfast', 'medium', 'slow'],
  nvenc: ['p2', 'p4', 'p6', 'p7'],
  qsv: ['veryfast', 'medium', 'slower', 'veryslow'],
  amf: ['speed', 'balanced', 'quality', 'quality']
};

// Encoder arguments for the chosen encoder, quality preset and rate control
function videoCodecArgs(s) {
  const lvl = Math.max(0, LEVELS.indexOf(s.preset));
  const kb = Math.max(500, Math.round(s.bitrate));
  const cq = String(Math.min(51, Math.max(0, Math.round(s.cq))));
  const cbr = s.rateControl !== 'quality';
  const vbv = ['-b:v', `${kb}k`, '-maxrate', `${kb}k`, '-bufsize', `${kb * 2}k`];

  switch (s.encoder) {
    case 'nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', PRESETS.nvenc[lvl],
        ...(cbr ? ['-rc', 'cbr', ...vbv] : ['-rc', 'vbr', '-cq', cq, '-b:v', '0']),
        '-pix_fmt', 'yuv420p'];
    case 'qsv':
      return ['-c:v', 'h264_qsv', '-preset', PRESETS.qsv[lvl],
        ...(cbr ? vbv : ['-global_quality', cq]),
        '-pix_fmt', 'nv12'];
    case 'amf':
      return ['-c:v', 'h264_amf', '-quality', PRESETS.amf[lvl],
        ...(cbr ? ['-rc', 'cbr', ...vbv] : ['-rc', 'cqp', '-qp_i', cq, '-qp_p', cq]),
        '-pix_fmt', 'nv12'];
    default:
      return ['-c:v', 'libx264', '-preset', PRESETS.x264[lvl],
        ...(cbr ? vbv : ['-crf', cq]),
        '-pix_fmt', 'yuv420p'];
  }
}

function tail(text, lines = 6) {
  return String(text || '').trim().split(/\r?\n/).slice(-lines).join('\n');
}

class Recorder extends EventEmitter {
  constructor(opts) {
    super();
    this.ffmpeg = opts.ffmpeg;
    this.region = opts.region;
    this.s = opts.settings;
    this.hasAudio = !!opts.hasAudio;
    this.outFile = opts.outFile;
    this.tmpDir = path.join(path.dirname(this.outFile), '.' + path.basename(this.outFile, '.mp4') + '.parts');

    // Output size stays fixed so segments can be joined without re-encoding
    const even = v => Math.max(2, Math.floor(v / 2) * 2);
    this.outW = even(this.region.width * this.s.scale);
    this.outH = even(this.region.height * this.s.scale);

    this.chain = Promise.resolve();
    this.state = 'idle';
    this.segments = [];
    this.doneBytes = 0;
    this.segIndex = 0;
    this.proc = null;
    this.procExit = null;
    this.currentFile = null;
    this.active = false;
    this.server = null;
    this.sock = null;
    this.log = '';
  }

  async start() {
    fs.mkdirSync(this.tmpDir, { recursive: true });
    await this.startSegment();
    this.state = 'recording';
  }

  // Runs operations one at a time
  run(fn) {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => {});
    return p;
  }

  pause() {
    return this.run(async () => {
      if (this.state !== 'recording') return;
      this.state = 'pausing';
      await this.stopSegment();
      this.state = 'paused';
    });
  }

  resume() {
    return this.run(async () => {
      if (this.state !== 'paused') return;
      await this.startSegment();
      this.state = 'recording';
    });
  }

  // Moves the capture area, starting a new segment when recording
  relocate(region) {
    return this.run(async () => {
      if (this.state === 'stopped') return;
      this.region = region;
      if (this.state !== 'recording') return;
      await this.stopSegment();
      try {
        await this.startSegment();
      } catch (err) {
        this.state = 'paused';
        this.emit('failed', err.message);
      }
    });
  }

  stop() {
    return this.run(async () => {
      if (this.state === 'stopped') throw new Error('Already stopped.');
      if (this.state === 'recording' || this.proc) await this.stopSegment();
      this.state = 'stopped';

      if (!this.segments.length) {
        this.cleanup();
        throw new Error('Nothing was recorded.');
      }

      await this.concat();
      this.cleanup();
      return this.outFile;
    });
  }

  size() {
    let bytes = this.doneBytes;
    if (this.currentFile) {
      try { bytes += fs.statSync(this.currentFile).size; } catch (e) { /* not created yet */ }
    }
    return bytes;
  }

  writeAudio(buf) {
    if (this.active && this.sock && !this.sock.destroyed && this.sock.writable) {
      this.sock.write(buf);
    }
  }

  openPipe(name) {
    return new Promise((resolve, reject) => {
      const server = net.createServer(sock => {
        if (this.sock) { sock.destroy(); return; }
        sock.on('error', () => {});
        this.sock = sock;
      });
      server.once('error', reject);
      server.listen(name, () => resolve());
      this.server = server;
    });
  }

  closePipe() {
    if (this.sock) {
      try { this.sock.end(); } catch (e) { /* ignore */ }
      this.sock = null;
    }
    if (this.server) {
      try { this.server.close(); } catch (e) { /* ignore */ }
      this.server = null;
    }
  }

  buildArgs(file, pipeName) {
    const s = this.s;
    const r = this.region;
    const fps = String(s.fps);
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];

    if (pipeName) {
      args.push('-thread_queue_size', '4096', '-f', 'f32le', '-ar', '48000', '-ac', '2');
      if (s.audioDelay) args.push('-itsoffset', (s.audioDelay / 1000).toFixed(3));
      args.push('-i', pipeName);
    }

    args.push(
      '-thread_queue_size', '1024',
      '-f', 'gdigrab',
      '-framerate', fps,
      '-draw_mouse', s.cursor ? '1' : '0',
      '-offset_x', String(r.x),
      '-offset_y', String(r.y),
      '-video_size', `${r.width}x${r.height}`,
      '-i', 'desktop'
    );

    args.push('-map', pipeName ? '1:v' : '0:v');
    if (pipeName) args.push('-map', '0:a');

    if (r.width !== this.outW || r.height !== this.outH) {
      const w = this.outW;
      const h = this.outH;
      args.push('-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`);
    }

    args.push(...videoCodecArgs(s), '-g', String(s.fps * 2), '-fps_mode', 'cfr', '-r', fps);

    if (pipeName) args.push('-c:a', 'aac', '-b:a', `${s.audioBitrate}k`, '-ar', '48000');

    args.push(file);
    return args;
  }

  async startSegment() {
    const idx = this.segIndex++;
    const file = path.join(this.tmpDir, `part-${String(idx).padStart(3, '0')}.mkv`);
    let pipeName = null;

    this.sock = null;
    this.log = '';

    if (this.hasAudio) {
      pipeName = `\\\\.\\pipe\\screen-fish-${process.pid}-${Date.now()}-${idx}`;
      await this.openPipe(pipeName);
    }

    const proc = spawn(this.ffmpeg, this.buildArgs(file, pipeName), {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe']
    });

    this.proc = proc;
    this.currentFile = file;
    this.active = true;

    this.procExit = new Promise(resolve => {
      proc.on('error', err => {
        this.log += '\n' + err.message;
        resolve(-1);
      });
      proc.on('exit', code => resolve(code));
    });

    proc.stdin.on('error', () => {});
    proc.stderr.on('data', d => { this.log = (this.log + d).slice(-4000); });

    this.procExit.then(() => {
      if (this.proc === proc) this.proc = null;
      if (this.active && this.currentFile === file && !this.starting) {
        this.active = false;
        this.emit('failed', tail(this.log) || 'FFmpeg stopped unexpectedly.');
      }
    });

    // Fails fast when FFmpeg rejects the arguments or encoder
    this.starting = true;
    const early = await Promise.race([
      this.procExit.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 1500))
    ]);
    this.starting = false;

    if (early) {
      this.active = false;
      this.closePipe();
      this.currentFile = null;
      throw new Error(tail(this.log) || 'FFmpeg failed to start.');
    }
  }

  async stopSegment() {
    const proc = this.proc;
    const file = this.currentFile;
    this.active = false;

    if (proc) {
      try { proc.stdin.write('q'); } catch (e) { /* ignore */ }
      this.closePipe();
      const timer = setTimeout(() => { try { proc.kill(); } catch (e) { /* ignore */ } }, 10000);
      await this.procExit;
      clearTimeout(timer);
    } else {
      this.closePipe();
    }

    this.proc = null;
    this.currentFile = null;

    if (file) {
      try {
        const size = fs.statSync(file).size;
        if (size > 2048) {
          this.segments.push(file);
          this.doneBytes += size;
        }
      } catch (e) { /* segment not written */ }
    }
  }

  concat() {
    const list = path.join(this.tmpDir, 'list.txt');
    const lines = this.segments.map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
    fs.writeFileSync(list, lines.join('\n'));

    const args = ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', list,
      '-map', '0', '-c', 'copy', '-movflags', '+faststart', this.outFile];

    return new Promise((resolve, reject) => {
      let log = '';
      const proc = spawn(this.ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      proc.stderr.on('data', d => { log = (log + d).slice(-4000); });
      proc.on('error', err => reject(err));
      proc.on('exit', code => {
        if (code === 0) resolve();
        else reject(new Error(`Could not finalise the MP4. Parts kept in ${this.tmpDir}\n${tail(log)}`));
      });
    });
  }

  cleanup() {
    try { fs.rmSync(this.tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

module.exports = Recorder;
