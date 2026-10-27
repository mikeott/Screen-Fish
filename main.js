'use strict';

const {
  app, BrowserWindow, ipcMain, screen, dialog, shell,
  globalShortcut, session, desktopCapturer
} = require('electron');
const path = require('path');
const fs = require('fs');
const Recorder = require('./src/recorder');
const store = require('./src/settings');
const winHelper = require('./src/winhelper');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const WIN_WIDTH = 940;

let win = null;
let overlays = [];
let borderWin = null;
let borderCssKey = null;
let settings = null;
let settingsFile = null;
let region = null;
let savedRegion = null;
let recorder = null;
let finishing = null;
let lastFile = null;
let selectResolve = null;
let pickerWindows = null;
let trackTimer = null;
let dismissRegistered = null;
let quitting = false;

const wait = ms => new Promise(r => setTimeout(r, ms));

function ffmpegPath() {
  return require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Window selections aren't persisted since handles don't survive a restart
function saveSettings() {
  store.save(settingsFile, Object.assign({}, settings, { region: savedRegion }));
}

function setRegion(r) {
  region = r;
  if (r && r.kind !== 'window') {
    savedRegion = r;
    saveSettings();
  }
  send('region:changed', region);
}

// Region is only restored when it still sits inside a connected display
function validRegion(r) {
  if (!r || !r.dip || r.kind === 'window') return null;
  const nums = ['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k]) && Number.isFinite(r.dip[k]));
  if (!nums || r.width < 2 || r.height < 2) return null;
  const fits = screen.getAllDisplays().some(d =>
    r.dip.x >= d.bounds.x && r.dip.y >= d.bounds.y &&
    r.dip.x + r.dip.width <= d.bounds.x + d.bounds.width &&
    r.dip.y + r.dip.height <= d.bounds.y + d.bounds.height
  );
  return fits ? r : null;
}

function createWindow() {
  win = new BrowserWindow({
    width: WIN_WIDTH,
    height: 300,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    title: 'Screen Fish',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  win.setContentProtection(!!settings.hideFromCapture);
  setOnTop(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.on('close', e => {
    if (recorder && !quitting) {
      e.preventDefault();
      send('app:close-request');
    }
  });
  win.on('closed', () => { win = null; });
}

/* ---------- Coordinates ---------- */

function toPhysical(dip, ov) {
  if (process.platform === 'win32') return screen.dipToScreenRect(ov, dip);
  const d = screen.getDisplayMatching(dip);
  return {
    x: Math.round(dip.x * d.scaleFactor),
    y: Math.round(dip.y * d.scaleFactor),
    width: Math.round(dip.width * d.scaleFactor),
    height: Math.round(dip.height * d.scaleFactor)
  };
}

function toDip(phys) {
  if (process.platform === 'win32') return screen.screenToDipRect(null, phys);
  return phys;
}

function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  return r > x && btm > y ? { x, y, width: r - x, height: btm - y } : null;
}

/* ---------- Region selection ---------- */

function closeOverlays() {
  overlays.forEach(ov => { if (!ov.isDestroyed()) ov.destroy(); });
  overlays = [];
}

function pushWindows(ov) {
  if (!pickerWindows) return;
  const list = pickerWindows.map(w => ({ hwnd: w.hwnd, app: w.app, title: w.title, dip: w.dip, size: `${w.width}×${w.height}` }));
  (ov ? [ov] : overlays).forEach(o => {
    if (!o.isDestroyed()) o.webContents.send('overlay:windows', list);
  });
}

function loadPickerWindows() {
  pickerWindows = null;
  winHelper.list()
    .then(data => {
      pickerWindows = (data.windows || [])
        .filter(w => w.pid !== process.pid)
        .map(w => Object.assign(w, { virtual: data.virtual, dip: toDip({ x: w.x, y: w.y, width: w.width, height: w.height }) }));
      pushWindows();
    })
    .catch(() => {
      pickerWindows = [];
      pushWindows();
    });
}

function openOverlays(mode) {
  closeOverlays();
  const active = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (mode === 'window') loadPickerWindows();

  screen.getAllDisplays().forEach((d, i) => {
    const ov = new BrowserWindow({
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      backgroundColor: '#00000000',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'src', 'overlay-preload.js'),
        contextIsolation: true,
        sandbox: true
      }
    });

    ov.setAlwaysOnTop(true, 'screen-saver');
    ov.loadFile(path.join(__dirname, 'renderer', 'overlay.html'), {
      query: {
        id: String(d.id),
        scale: String(d.scaleFactor),
        index: String(i + 1),
        bx: String(d.bounds.x),
        by: String(d.bounds.y),
        mode
      }
    });
    ov.webContents.once('did-finish-load', () => pushWindows(ov));
    ov.once('ready-to-show', () => {
      ov.setBounds(d.bounds);
      ov.show();
      ov.setBounds(d.bounds);
      if (d.id === active.id) ov.focus();
    });

    overlays.push(ov);
  });
}

function finishSelect(result) {
  closeOverlays();
  pickerWindows = null;
  if (win && !win.isDestroyed()) win.show();
  if (selectResolve) {
    const done = selectResolve;
    selectResolve = null;
    done(result);
  }
  refreshOutline();
}

function buildRegion(displayId, rect, full, ov) {
  const displays = screen.getAllDisplays();
  const d = displays.find(x => String(x.id) === String(displayId));
  if (!d) return null;

  let r;
  if (full) {
    r = { x: 0, y: 0, width: d.bounds.width, height: d.bounds.height };
  } else {
    const n = v => Math.round(Number(v) || 0);
    const x = Math.min(Math.max(0, n(rect && rect.x)), d.bounds.width);
    const y = Math.min(Math.max(0, n(rect && rect.y)), d.bounds.height);
    r = {
      x, y,
      width: Math.min(Math.max(0, n(rect && rect.width)), d.bounds.width - x),
      height: Math.min(Math.max(0, n(rect && rect.height)), d.bounds.height - y)
    };
  }

  const dip = { x: d.bounds.x + r.x, y: d.bounds.y + r.y, width: r.width, height: r.height };
  const phys = toPhysical(dip, ov);
  const width = Math.floor(phys.width / 2) * 2;
  const height = Math.floor(phys.height / 2) * 2;
  if (width < 16 || height < 16) return null;

  return {
    kind: full ? 'display' : 'region',
    x: Math.round(phys.x),
    y: Math.round(phys.y),
    width,
    height,
    dip,
    full: !!full,
    label: `Display ${displays.indexOf(d) + 1} · ${width}×${height}`
  };
}

// Capture area for a window, clipped to the virtual desktop
function windowRegion(info, rect, virt) {
  const clip = intersect(
    { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    virt || rect
  );
  if (!clip) return null;

  const width = Math.floor(clip.width / 2) * 2;
  const height = Math.floor(clip.height / 2) * 2;
  if (width < 16 || height < 16) return null;

  const phys = { x: clip.x, y: clip.y, width, height };
  const app = info.app || 'Window';
  return {
    kind: 'window',
    hwnd: info.hwnd,
    app,
    title: info.title || '',
    x: phys.x,
    y: phys.y,
    width,
    height,
    dip: toDip(phys),
    full: false,
    label: `${app} · ${width}×${height}`
  };
}

ipcMain.handle('region:select', (e, mode) => new Promise(resolve => {
  if (recorder || selectResolve) return resolve(null);
  const pickMode = mode === 'window' && winHelper.available() ? 'window' : 'region';
  selectResolve = r => {
    if (r) setRegion(r);
    resolve(r);
  };
  stopTracking();
  hideBorder();
  syncDismissShortcut();
  if (win) win.hide();
  setTimeout(() => openOverlays(pickMode), 120);
}));

ipcMain.handle('region:get', () => region);

ipcMain.handle('region:clear', () => clearRegion());

ipcMain.on('overlay:done', (e, data) => {
  let r = null;
  if (data && data.hwnd && pickerWindows) {
    const w = pickerWindows.find(x => String(x.hwnd) === String(data.hwnd));
    if (w) r = windowRegion(w, w, w.virtual);
  } else if (data) {
    r = buildRegion(data.displayId, data.rect, !!data.full, BrowserWindow.fromWebContents(e.sender));
  }
  finishSelect(r);
});

ipcMain.on('overlay:cancel', () => finishSelect(null));

/* ---------- Region outline ---------- */

const BORDER_CSS = {
  idle: 'body::before { border-style: dashed; border-color: rgba(240, 86, 107, 0.85); }',
  recording: 'body::before { border-style: solid; border-color: #f0566b; }',
  paused: 'body::before { border-style: dashed; border-color: #f4b14e; }'
};

let borderState = 'idle';

function borderBounds(dip) {
  const pad = 4;
  return {
    x: Math.round(dip.x - pad),
    y: Math.round(dip.y - pad),
    width: Math.round(dip.width + pad * 2),
    height: Math.round(dip.height + pad * 2)
  };
}

function applyBorderState() {
  if (!borderWin || borderWin.isDestroyed()) return;
  const wc = borderWin.webContents;
  const prev = borderCssKey;
  borderCssKey = null;
  if (prev) wc.removeInsertedCSS(prev).catch(() => {});
  wc.insertCSS(BORDER_CSS[borderState] || BORDER_CSS.idle)
    .then(key => {
      if (borderCssKey) wc.removeInsertedCSS(borderCssKey).catch(() => {});
      borderCssKey = key;
    })
    .catch(() => {});
}

function setBorderState(state) {
  borderState = state;
  applyBorderState();
}

function showBorder() {
  hideBorder();
  if (!settings.showBorder || !region || region.full || selectResolve) return;

  const b = borderBounds(region.dip);

  borderWin = new BrowserWindow({
    ...b,
    frame: false,
    transparent: true,
    focusable: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true }
  });

  borderWin.setIgnoreMouseEvents(true);
  borderWin.setAlwaysOnTop(true, 'screen-saver');
  borderWin.setContentProtection(true);
  borderWin.loadFile(path.join(__dirname, 'renderer', 'border.html'));
  borderWin.webContents.once('did-finish-load', applyBorderState);
  borderWin.once('ready-to-show', () => {
    if (!borderWin) return;
    borderWin.setBounds(b);
    borderWin.showInactive();
    borderWin.setBounds(b);
  });
}

function moveBorder(dip) {
  if (!borderWin || borderWin.isDestroyed()) return;
  borderWin.setBounds(borderBounds(dip));
  if (!borderWin.isVisible()) borderWin.showInactive();
}

function hideBorder() {
  if (borderWin && !borderWin.isDestroyed()) borderWin.destroy();
  borderWin = null;
  borderCssKey = null;
}

// Shows the outline for the current region and follows picked windows
function refreshOutline() {
  showBorder();
  startTracking();
  syncDismissShortcut();
}

// Clears the selected region and its outline
function clearRegion() {
  if (recorder || selectResolve) return false;
  stopTracking();
  hideBorder();
  region = null;
  savedRegion = null;
  saveSettings();
  send('region:changed', null);
  syncDismissShortcut();
  return true;
}

function releaseDismissShortcut() {
  if (!dismissRegistered) return;
  try { globalShortcut.unregister(dismissRegistered); } catch (e) { /* ignore */ }
  dismissRegistered = null;
}

// Global dismiss key is only held while an outline is showing
function syncDismissShortcut() {
  const want = settings && settings.dismissGlobal && region && !recorder && !selectResolve
    ? settings.dismissKey
    : null;
  if (want === dismissRegistered) return;

  releaseDismissShortcut();
  if (!want) return;

  try {
    if (globalShortcut.register(want, () => clearRegion())) dismissRegistered = want;
  } catch (e) {
    // Invalid or unavailable accelerator
  }
}

/* ---------- Window tracking ---------- */

function sameArea(a, b) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

// Brings the window forward and reads its current position
async function prepareWindow(r) {
  const res = await winHelper.front(r.hwnd);
  if (!res || !res.exists) return null;
  await wait(350);
  const rect = await winHelper.rect(r.hwnd);
  if (!rect || !rect.exists) return null;
  if (rect.minimized) return r;
  return windowRegion(r, rect, rect.virtual) || r;
}

// Follows the picked window, moving the capture once it settles
function startTracking() {
  stopTracking();
  if (!region || region.kind !== 'window') return;
  let lastKey = null;
  let busy = false;

  trackTimer = setInterval(async () => {
    if (busy || finishing || selectResolve || !region || region.kind !== 'window') return;
    busy = true;
    const rec = recorder;
    const hwnd = region.hwnd;
    try {
      const rect = await winHelper.rect(hwnd);
      if (recorder !== rec || !region || region.hwnd !== hwnd || finishing) return;

      if (!rect || !rect.exists) {
        stopTracking();
        if (rec) {
          const result = await finishRecording();
          send('rec:failed', { error: 'The window was closed.', file: result.ok ? result.file : null });
        }
        stopTracking();
        region = null;
        hideBorder();
        syncDismissShortcut();
        send('region:changed', null);
        return;
      }

      if (rect.minimized) {
        if (borderWin && !borderWin.isDestroyed() && borderWin.isVisible()) borderWin.hide();
        return;
      }

      const next = windowRegion(region, rect, rect.virtual);
      if (!next) return;

      moveBorder(next.dip);
      const key = `${next.x},${next.y},${next.width},${next.height}`;
      if (key !== lastKey) {
        lastKey = key;
        return;
      }
      if (!sameArea(next, region)) {
        region = next;
        send('region:changed', region);
        if (rec) await rec.relocate(next);
      }
    } catch (e) {
      // Lookup failed, try again next tick
    } finally {
      busy = false;
    }
  }, 300);
}

function stopTracking() {
  clearInterval(trackTimer);
  trackTimer = null;
}

/* ---------- Recording ---------- */

function outputFile(folder) {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const base = `Recording ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  let file = path.join(folder, `${base}.mp4`);
  let i = 2;
  while (fs.existsSync(file)) file = path.join(folder, `${base} (${i++}).mp4`);
  return file;
}

// Keeps the window on top while recording or when the setting is on
function setOnTop(on) {
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(!!(on || settings.alwaysOnTop), 'floating');
}

function finishRecording() {
  if (finishing) return finishing;
  const rec = recorder;
  if (!rec) return Promise.resolve({ ok: false, error: 'Not recording.' });

  stopTracking();
  finishing = rec.stop()
    .then(file => {
      lastFile = file;
      let size = 0;
      try { size = fs.statSync(file).size; } catch (e) { /* ignore */ }
      return { ok: true, file, size };
    })
    .catch(err => ({ ok: false, error: err.message }))
    .finally(() => {
      setOnTop(false);
      recorder = null;
      finishing = null;
      setBorderState('idle');
      refreshOutline();
      if (win && !win.isDestroyed() && win.isMinimized()) win.restore();
    });

  return finishing;
}

ipcMain.handle('rec:start', async (e, opts) => {
  if (recorder) return { ok: false, error: 'Already recording.' };
  if (!region) return { ok: false, error: 'Draw a region or pick a window first.' };

  try {
    fs.mkdirSync(settings.folder, { recursive: true });
    fs.accessSync(settings.folder, fs.constants.W_OK);
  } catch (err) {
    return { ok: false, error: `Can't write to the save folder: ${settings.folder}` };
  }

  stopTracking();
  releaseDismissShortcut();

  if (region.kind === 'window') {
    let fresh = null;
    try { fresh = await prepareWindow(region); } catch (err) { fresh = region; }
    if (!fresh) {
      refreshOutline();
      return { ok: false, error: 'That window is no longer open. Pick it again.' };
    }
    region = fresh;
    send('region:changed', region);
  }

  const rec = new Recorder({
    ffmpeg: ffmpegPath(),
    region,
    settings: Object.assign({}, settings),
    hasAudio: !!(opts && opts.hasAudio),
    outFile: outputFile(settings.folder)
  });

  rec.on('failed', async message => {
    if (recorder !== rec) return;
    const result = await finishRecording();
    send('rec:failed', { error: message, file: result.ok ? result.file : null });
  });

  recorder = rec;
  try {
    await rec.start();
  } catch (err) {
    rec.cleanup();
    recorder = null;
    refreshOutline();
    return { ok: false, error: err.message };
  }

  setBorderState('recording');
  refreshOutline();
  if (settings.minimizeOnRecord && win) win.minimize();
  else if (settings.hideFromCapture) setOnTop(true);
  return { ok: true };
});

ipcMain.handle('rec:pause', async () => {
  if (!recorder) return { ok: false };
  try {
    await recorder.pause();
    setBorderState('paused');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('rec:resume', async () => {
  if (!recorder) return { ok: false };
  try {
    await recorder.resume();
    setBorderState('recording');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('rec:stop', () => finishRecording());

ipcMain.handle('rec:size', () => (recorder ? recorder.size() : 0));

ipcMain.on('rec:audio', (e, data) => {
  if (recorder && data && data.byteLength) {
    recorder.writeAudio(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }
});

/* ---------- Settings, files, window ---------- */

ipcMain.handle('settings:get', () => Object.assign({}, settings, { region, windowPicker: winHelper.available(), appVersion: app.getVersion() }));

ipcMain.handle('shortcut:check', (e, acc) => {
  if (typeof acc !== 'string' || !store.validAccelerator(acc)) return { ok: false, error: 'That key can’t be used.' };
  if (['CommandOrControl+Shift+R', 'CommandOrControl+Shift+P', 'Ctrl+Shift+R', 'Ctrl+Shift+P'].includes(acc)) {
    return { ok: false, error: 'That combination is already used for recording.' };
  }
  if (acc !== dismissRegistered && globalShortcut.isRegistered(acc)) return { ok: false, error: 'That combination is already in use.' };
  return { ok: true };
});

ipcMain.handle('settings:save', (e, incoming) => {
  const keepFolder = settings.folder;
  const hadBorder = settings.showBorder;
  settings = store.clean(Object.assign({}, incoming, { region: savedRegion }), settings);
  settings.folder = keepFolder;
  if (win) win.setContentProtection(!!settings.hideFromCapture);
  setOnTop(!!recorder && settings.hideFromCapture && !settings.minimizeOnRecord);
  saveSettings();
  if (hadBorder !== settings.showBorder && !recorder && !selectResolve) refreshOutline();
  syncDismissShortcut();
  return Object.assign({}, settings, { region, windowPicker: winHelper.available() });
});

ipcMain.handle('folder:browse', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose where recordings are saved',
    defaultPath: settings.folder,
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths.length) return settings.folder;
  settings.folder = res.filePaths[0];
  saveSettings();
  return settings.folder;
});

ipcMain.handle('folder:open', async () => {
  try { fs.mkdirSync(settings.folder, { recursive: true }); } catch (e) { /* ignore */ }
  return shell.openPath(settings.folder);
});

ipcMain.handle('file:show', () => {
  if (lastFile && fs.existsSync(lastFile)) shell.showItemInFolder(lastFile);
});

ipcMain.handle('file:open', () => {
  if (lastFile && fs.existsSync(lastFile)) return shell.openPath(lastFile);
});

ipcMain.on('win:height', (e, h) => {
  if (!win) return;
  const height = Math.min(1000, Math.max(120, Math.round(Number(h) || 0)));
  const b = win.getBounds();
  if (b.height !== height) win.setBounds({ x: b.x, y: b.y, width: WIN_WIDTH, height });
});

ipcMain.on('win:minimize', () => { if (win) win.minimize(); });

ipcMain.on('win:close', () => {
  quitting = true;
  app.quit();
});

/* ---------- App lifecycle ---------- */

function registerShortcuts() {
  try {
    globalShortcut.register('CommandOrControl+Shift+R', () => send('hotkey', 'toggle'));
    globalShortcut.register('CommandOrControl+Shift+P', () => send('hotkey', 'pause'));
  } catch (e) {
    // Shortcut already taken by another app
  }
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

app.whenReady().then(() => {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  settings = store.load(settingsFile, app.getPath('videos'));
  savedRegion = validRegion(settings.region);
  region = savedRegion;

  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['media', 'display-capture'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) =>
    ['media', 'display-capture'].includes(permission)
  );

  // Supplies system audio loopback to getDisplayMedia without a picker
  session.defaultSession.setDisplayMediaRequestHandler((request, cb) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then(sources => cb({ video: sources[0], audio: 'loopback' }))
      .catch(() => cb({}));
  });

  createWindow();
  registerShortcuts();
  refreshOutline();

  // Warms up the window helper so the picker opens quickly
  if (winHelper.available()) winHelper.ensure().catch(() => {});
});

app.on('before-quit', e => {
  quitting = true;
  if (recorder) {
    e.preventDefault();
    finishRecording().then(() => app.quit());
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  winHelper.dispose();
});

app.on('window-all-closed', () => app.quit());
