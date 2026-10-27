'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  done: data => ipcRenderer.send('overlay:done', data),
  cancel: () => ipcRenderer.send('overlay:cancel'),
  onWindows: fn => ipcRenderer.on('overlay:windows', (e, list) => fn(list))
});
