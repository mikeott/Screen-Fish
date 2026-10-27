'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Long-running PowerShell process for window lookups via the Win32 API
class WinHelper {
  constructor() {
    this.proc = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.ready = null;
  }

  available() {
    return process.platform === 'win32';
  }

  ensure() {
    if (!this.available()) return Promise.reject(new Error('Window capture is only available on Windows.'));
    if (this.ready) return this.ready;

    const script = fs.readFileSync(path.join(__dirname, 'winhelper.ps1'), 'utf8');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');

    const proc = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

    this.proc = proc;
    this.buf = '';

    this.ready = new Promise((resolve, reject) => {
      this.pending.set(0, { resolve, reject, timer: setTimeout(() => this.fail(0, 'Window helper did not start.'), 20000) });
    });

    this.ready.catch(() => this.dispose());

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', d => { if (this.proc === proc) this.onData(d); });
    proc.stderr.on('data', () => {});
    proc.stdin.on('error', () => {});
    proc.on('error', () => { if (this.proc === proc) this.reset('Window helper could not start.'); });
    proc.on('exit', () => { if (this.proc === proc) this.reset('Window helper stopped.'); });

    return this.ready;
  }

  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line.startsWith('{')) continue;

      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }

      const p = this.pending.get(msg.id);
      if (!p) continue;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.id === 0 ? true : msg.data);
      else p.reject(new Error('Window lookup failed.'));
    }
  }

  fail(id, message) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.reject(new Error(message));
  }

  reset(message) {
    this.pending.forEach(p => {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    });
    this.pending.clear();
    this.proc = null;
    this.ready = null;
  }

  async call(command, timeout = 8000) {
    await this.ensure();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(id, 'Window lookup timed out.'), timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${id} ${command}\n`);
    });
  }

  list() {
    return this.call('list', 15000);
  }

  rect(hwnd) {
    return this.call(`rect ${Number(hwnd)}`, 4000);
  }

  front(hwnd) {
    return this.call(`front ${Number(hwnd)}`, 4000);
  }

  dispose() {
    if (this.proc) {
      try { this.proc.stdin.end(); } catch (e) { /* ignore */ }
      try { this.proc.kill(); } catch (e) { /* ignore */ }
    }
    this.reset('Window helper closed.');
  }
}

module.exports = new WinHelper();
