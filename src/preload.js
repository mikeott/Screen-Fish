'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['hotkey', 'rec:failed', 'app:close-request', 'region:changed'];

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: s => ipcRenderer.invoke('settings:save', s),
  browseFolder: () => ipcRenderer.invoke('folder:browse'),
  openFolder: () => ipcRenderer.invoke('folder:open'),
  showFile: () => ipcRenderer.invoke('file:show'),
  openFile: () => ipcRenderer.invoke('file:open'),

  selectRegion: mode => ipcRenderer.invoke('region:select', mode),
  getRegion: () => ipcRenderer.invoke('region:get'),
  clearRegion: () => ipcRenderer.invoke('region:clear'),
  checkShortcut: acc => ipcRenderer.invoke('shortcut:check', acc),

  start: opts => ipcRenderer.invoke('rec:start', opts),
  pause: () => ipcRenderer.invoke('rec:pause'),
  resume: () => ipcRenderer.invoke('rec:resume'),
  stop: () => ipcRenderer.invoke('rec:stop'),
  size: () => ipcRenderer.invoke('rec:size'),
  sendAudio: bytes => ipcRenderer.send('rec:audio', bytes),

  setHeight: h => ipcRenderer.send('win:height', h),
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),

  on: (channel, fn) => {
    if (EVENTS.includes(channel)) ipcRenderer.on(channel, (e, payload) => fn(payload));
  }
});
