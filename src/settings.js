'use strict';

const fs = require('fs');
const path = require('path');

const ENCODERS = ['x264', 'nvenc', 'qsv', 'amf'];
const PRESETS = ['speed', 'balanced', 'quality', 'max'];

function defaults(videosDir) {
  return {
    folder: path.join(videosDir, 'Screen Fish'),
    fps: 30,
    encoder: 'x264',
    preset: 'balanced',
    rateControl: 'bitrate',
    bitrate: 8000,
    cq: 23,
    scale: 1,
    cursor: true,
    micEnabled: true,
    micId: 'default',
    micLabel: '',
    systemAudio: true,
    audioBitrate: 160,
    audioDelay: 0,
    countdown: 3,
    hideFromCapture: true,
    showBorder: true,
    minimizeOnRecord: false,
    alwaysOnTop: false,
    dismissKey: 'Escape',
    dismissGlobal: false,
    region: null
  };
}

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Super'];

// Accepts accelerators like "Escape", "Ctrl+Shift+X", "F9"
function validAccelerator(acc) {
  if (acc.length > 40) return false;
  const parts = acc.split('+');
  const key = parts.pop();
  if (!parts.every(p => MODIFIERS.includes(p))) return false;
  return /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Escape|Space|Tab|Backspace|Delete|Insert|Return|Home|End|PageUp|PageDown|Up|Down|Left|Right|Plus|[-=\[\];',./`\\])$/.test(key);
}

function num(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Coerces incoming values to known keys and safe types
function clean(input, base) {
  const s = Object.assign({}, base);
  if (!input || typeof input !== 'object') return s;

  if (typeof input.folder === 'string' && input.folder.trim()) s.folder = input.folder.trim();
  s.fps = [24, 30, 50, 60].includes(Number(input.fps)) ? Number(input.fps) : base.fps;
  s.encoder = ENCODERS.includes(input.encoder) ? input.encoder : base.encoder;
  s.preset = PRESETS.includes(input.preset) ? input.preset : base.preset;
  s.rateControl = input.rateControl === 'quality' ? 'quality' : (input.rateControl === 'bitrate' ? 'bitrate' : base.rateControl);
  s.bitrate = Math.round(num(input.bitrate, 500, 100000, base.bitrate));
  s.cq = Math.round(num(input.cq, 0, 51, base.cq));
  s.scale = [1, 0.75, 0.5].includes(Number(input.scale)) ? Number(input.scale) : base.scale;
  s.audioBitrate = [96, 128, 160, 192, 256, 320].includes(Number(input.audioBitrate)) ? Number(input.audioBitrate) : base.audioBitrate;
  s.audioDelay = Math.round(num(input.audioDelay, -2000, 2000, base.audioDelay));
  s.countdown = [0, 3, 5].includes(Number(input.countdown)) ? Number(input.countdown) : base.countdown;

  if (typeof input.dismissKey === 'string' && validAccelerator(input.dismissKey)) s.dismissKey = input.dismissKey;

  ['cursor', 'micEnabled', 'systemAudio', 'hideFromCapture', 'showBorder', 'minimizeOnRecord', 'alwaysOnTop', 'dismissGlobal'].forEach(k => {
    if (k in input) s[k] = !!input[k];
  });

  if (typeof input.micId === 'string') s.micId = input.micId.slice(0, 512);
  if (typeof input.micLabel === 'string') s.micLabel = input.micLabel.slice(0, 200);
  if ('region' in input) s.region = input.region && typeof input.region === 'object' ? input.region : null;

  return s;
}

function load(file, videosDir) {
  const base = defaults(videosDir);
  try {
    return clean(JSON.parse(fs.readFileSync(file, 'utf8')), base);
  } catch (e) {
    return base;
  }
}

function save(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    // Settings are non-critical
  }
}

module.exports = { defaults, clean, load, save, validAccelerator };
