$(function () {
  'use strict';

  const api = window.api;
  const $card = $('#card');
  const $time = $('#time');

  let settings = {};
  let region = null;
  let state = 'idle';
  let busy = false;
  let elapsed = 0;
  let runStart = 0;
  let clockTimer = null;
  let sizeTimer = null;
  let toastTimer = null;
  let saveTimer = null;
  let countdownCancel = null;
  let defaultMicLabel = '';

  const LABELS = {
    idle: ['READY', 'Record'],
    countdown: ['READY', 'Cancel'],
    recording: ['REC', 'Stop'],
    paused: ['PAUSED', 'Stop'],
    saving: ['SAVING', 'Saving…']
  };

  /* ---------- Helpers ---------- */

  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    const p = n => String(n).padStart(2, '0');
    return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
  }

  // Renders each character in a fixed-width slot
  function setTime(text) {
    if ($time.data('text') === text) return;
    $time.data('text', text);
    $time.empty();
    String(text).split('').forEach(ch => {
      $time.append($('<span>').addClass(ch === ':' ? 'c' : 'd').text(ch));
    });
  }

  function fmtSize(bytes) {
    const mb = bytes / 1048576;
    return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
  }

  function shortMic(label) {
    if (!label) return 'Default mic';
    const m = label.match(/\(([^()]+)\)\s*$/);
    return m ? m[1] : label;
  }

  function toast(msg, type) {
    clearTimeout(toastTimer);
    $('#toast').text(msg).toggleClass('error', type === 'error').addClass('show');
    toastTimer = setTimeout(() => $('#toast').removeClass('show'), type === 'error' ? 7000 : 3500);
  }

  function now() {
    return performance.now();
  }

  function currentElapsed() {
    return elapsed + (state === 'recording' ? now() - runStart : 0);
  }

  /* ---------- State ---------- */

  function setState(s) {
    state = s;
    $card.attr('data-state', s);
    $('#badge .badge-text').text(LABELS[s][0]);
    $('.main-text').text(LABELS[s][1]);
    $('.pause-label').text(s === 'paused' ? 'Resume' : 'Pause');
    $('#btn-pause').attr('title', s === 'paused' ? 'Resume (Ctrl+Shift+P)' : 'Pause (Ctrl+Shift+P)');

    const locked = s !== 'idle';
    $('#btn-region, #btn-window, #f-region, #f-clear, #btn-settings').prop('disabled', locked);
    if (locked) toggleSettings(false);

    $('#eyebrow').text(s === 'countdown' ? 'STARTING IN' : 'ELAPSED');
    Wave.setMode(s === 'recording' ? 'recording' : (s === 'paused' ? 'paused' : 'idle'));
    syncButtons();
  }

  function setBusy(b) {
    busy = b;
    syncButtons();
  }

  function syncButtons() {
    $('#btn-main').prop('disabled', busy || state === 'saving');
    $('#btn-pause').prop('disabled', busy);
  }

  function startClock() {
    stopClock();
    clockTimer = setInterval(() => setTime(fmtTime(currentElapsed())), 200);
    sizeTimer = setInterval(() => {
      api.size().then(b => { if (b) $('#f-size').text(fmtSize(b)); });
    }, 1000);
  }

  function stopClock() {
    clearInterval(clockTimer);
    clearInterval(sizeTimer);
    clockTimer = sizeTimer = null;
  }

  /* ---------- Info display ---------- */

  function renderInfo() {
    const parts = [region && region.kind === 'window' ? 'Window' : 'Screen'];
    if (settings.micEnabled) parts.push('Mic');
    if (settings.systemAudio) parts.push('System audio');
    $('#sources').text(parts.join(' + '));

    $('#f-region span').text(region ? region.label : 'No region selected');
    $('#f-region').toggleClass('off', !region);
    $card.toggleClass('has-region', !!region);
    $('#f-clear').attr('title', `Dismiss region (${keyLabel(settings.dismissKey)})`);

    $('#f-mic span').text(settings.micEnabled ? shortMic(settings.micLabel) : 'Mic off');
    $('#f-mic').toggleClass('off', !settings.micEnabled);

    $('#f-sys span').text(settings.systemAudio ? 'System audio' : 'System audio off');
    $('#f-sys').toggleClass('off', !settings.systemAudio);

    $('#folder-path').text(settings.folder || '');
  }

  function showSaved(file, size) {
    if (!file) return;
    const name = file.split(/[\\/]/).pop();
    $('#f-saved').text(`Saved · ${name}`).attr('title', 'Show in folder').css('display', 'inline-block');
    if (size) $('#f-size').text(fmtSize(size));
  }

  /* ---------- Settings panel ---------- */

  function fillSettings() {
    $('#settings [data-key]').each(function () {
      const $el = $(this);
      const v = settings[$el.data('key')];
      if ($el.is('[type=checkbox]')) $el.prop('checked', !!v);
      else if ($el.is('[type=radio]')) $el.prop('checked', String(v) === $el.val());
      else $el.val(String(v));
    });
    syncSettingsUI();
  }

  function syncSettingsUI() {
    const quality = settings.rateControl === 'quality';
    $('.rc-bitrate').toggle(!quality);
    $('.rc-quality').toggle(quality);
    $('#cq-val').text(`${settings.cq} · lower is better`);
    $('#mic-select').closest('.field').toggleClass('disabled', !settings.micEnabled);

    if (!$('#dismiss-key').hasClass('listening')) $('#dismiss-key').text(keyLabel(settings.dismissKey));
    const bare = settings.dismissKey && settings.dismissKey.indexOf('+') === -1;
    $('#dismiss-note')
      .text(`While a region is shown, ${keyLabel(settings.dismissKey)} won't reach other apps. A combination like Ctrl + Shift + X avoids this.`)
      .toggleClass('show', !!(settings.dismissGlobal && bare));
  }

  function toggleSettings(open) {
    const show = typeof open === 'boolean' ? open : !$card.hasClass('open');
    $card.toggleClass('open', show);
    $('#btn-settings').toggleClass('active', show);
  }

  function loadMics() {
    return AudioCapture.listMics().then(res => {
      const $sel = $('#mic-select');
      defaultMicLabel = res.defaultLabel;
      $sel.find('option:not([value=default])').remove();
      res.list.forEach(d => $sel.append($('<option>').val(d.id).text(d.label)));

      if (settings.micId !== 'default' && !res.list.some(d => d.id === settings.micId)) {
        settings.micId = 'default';
      }
      if (settings.micId === 'default') {
        settings.micLabel = defaultMicLabel;
      }
      $sel.val(settings.micId);
      renderInfo();
    }).catch(() => {});
  }

  $('#settings').on('change input', '[data-key]', function () {
    const $el = $(this);
    const key = $el.data('key');
    let val;

    if ($el.is('[type=checkbox]')) {
      val = $el.prop('checked');
    } else if ($el.is('[type=radio]')) {
      if (!$el.prop('checked')) return;
      val = $el.val();
    } else {
      val = $el.val();
    }
    if ($el.data('type') === 'number') val = Number(val);
    if ($el.is('[type=number]') && $el.val() === '') return;

    settings[key] = val;
    if (key === 'micId') {
      settings.micLabel = val === 'default' ? defaultMicLabel : $el.find('option:selected').text();
    }

    syncSettingsUI();
    renderInfo();
    queueSave();
  });

  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api.saveSettings(settings).then(s => { settings = s; });
    }, 250);
  }

  /* ---------- Dismiss key ---------- */

  const KEY_NAMES = {
    Escape: 'Escape', ' ': 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
    Enter: 'Return', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', '+': 'Plus'
  };

  // Builds an Electron accelerator from a key event
  function toAccelerator(e) {
    const k = e.key;
    if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock'].includes(k)) return null;

    let key = KEY_NAMES[k] || null;
    if (!key && /^F([1-9]|1[0-9]|2[0-4])$/.test(k)) key = k;
    if (!key && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
    if (!key && /^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
    if (!key && /^[-=\[\];',./`\\]$/.test(k)) key = k;
    if (!key) return null;

    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey && key.length !== 1 || e.shiftKey && /[A-Z0-9]/.test(key)) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    return mods.concat(key).join('+');
  }

  function keyLabel(acc) {
    return String(acc || '').split('+').map(p => (p === 'Escape' ? 'Esc' : p === 'Return' ? 'Enter' : p)).join(' + ');
  }

  function stopListening() {
    $('#dismiss-key').removeClass('listening');
    syncSettingsUI();
  }

  $('#dismiss-key').on('click', function () {
    $(this).addClass('listening').text('Press a key…').trigger('focus');
  });

  $('#dismiss-key').on('blur', stopListening);

  $('#dismiss-key').on('keydown', async function (e) {
    if (!$(this).hasClass('listening')) return;
    e.preventDefault();
    e.stopPropagation();

    const acc = toAccelerator(e.originalEvent);
    if (!acc) return;

    const res = await api.checkShortcut(acc);
    if (res.ok) {
      settings.dismissKey = acc;
      queueSave();
      renderInfo();
    } else {
      toast(res.error, 'error');
    }
    $(this).trigger('blur');
  });

  $('#dismiss-reset').on('click', () => {
    settings.dismissKey = 'Escape';
    syncSettingsUI();
    renderInfo();
    queueSave();
  });

  function dismissRegion() {
    if (state !== 'idle' || busy || !region) return;
    api.clearRegion().then(ok => {
      if (ok) {
        region = null;
        renderInfo();
      }
    });
  }

  $('#f-clear').on('click', dismissRegion);

  // Dismiss key while this window is focused
  $(document).on('keydown', e => {
    if ($('#dismiss-key').hasClass('listening')) return;
    if ($(e.target).is('input, select, textarea')) return;
    const acc = toAccelerator(e.originalEvent);
    if (acc && acc === settings.dismissKey) {
      e.preventDefault();
      dismissRegion();
    }
  });

  /* ---------- Recording flow ---------- */

  function countdown(seconds) {
    return new Promise(resolve => {
      let left = seconds;
      setState('countdown');
      setTime(String(left));
      const t = setInterval(() => {
        left--;
        if (left <= 0) {
          clearInterval(t);
          countdownCancel = null;
          resolve(true);
        } else {
          setTime(String(left));
        }
      }, 1000);
      countdownCancel = () => {
        clearInterval(t);
        countdownCancel = null;
        resolve(false);
      };
    });
  }

  async function chooseRegion(mode) {
    if (state !== 'idle' || busy) return null;
    const r = await api.selectRegion(mode === 'window' ? 'window' : 'region');
    if (r) {
      region = r;
      renderInfo();
    }
    return r;
  }

  async function startFlow() {
    if (state !== 'idle' || busy) return;

    if (!region && !(await chooseRegion())) return;

    $('#f-saved').hide();
    $('#f-size').text('0.0 MB');

    if (settings.countdown > 0) {
      const go = await countdown(settings.countdown);
      if (!go) {
        setState('idle');
        setTime(fmtTime(0));
        return;
      }
    }

    setBusy(true);

    let hasAudio = false;
    if (settings.micEnabled || settings.systemAudio) {
      const res = await AudioCapture.start({
        mic: settings.micEnabled,
        micId: settings.micId,
        system: settings.systemAudio,
        onData: bytes => api.sendAudio(bytes)
      });
      hasAudio = res.ok;
      Wave.attach(res.ok ? AudioCapture.analyser : null);
      if (res.warnings.length) toast(`${res.warnings.join(' · ')} — recording continues`, 'error');
    }

    elapsed = 0;
    runStart = now();
    setState('recording');
    startClock();

    const r = await api.start({ hasAudio });
    setBusy(false);

    if (!r.ok) {
      stopClock();
      await AudioCapture.stop();
      Wave.attach(null);
      setState('idle');
      setTime(fmtTime(0));
      toast(r.error, 'error');
    }
  }

  async function stopFlow() {
    if ((state !== 'recording' && state !== 'paused') || busy) return;

    setBusy(true);
    elapsed = currentElapsed();
    setState('saving');
    stopClock();
    setTime(fmtTime(elapsed));

    const r = await api.stop();
    await AudioCapture.stop();
    Wave.attach(null);
    setState('idle');
    setBusy(false);

    if (r.ok) {
      showSaved(r.file, r.size);
      toast('Recording saved');
    } else {
      toast(r.error, 'error');
    }
  }

  async function togglePause() {
    if (busy) return;

    if (state === 'recording') {
      setBusy(true);
      elapsed = currentElapsed();
      setState('paused');
      const r = await api.pause();
      setBusy(false);
      if (!r.ok && r.error) toast(r.error, 'error');
    } else if (state === 'paused') {
      setBusy(true);
      runStart = now();
      setState('recording');
      const r = await api.resume();
      setBusy(false);
      if (!r.ok) {
        setState('paused');
        toast(r.error || 'Could not resume recording', 'error');
      }
    }
  }

  function onMainClick() {
    if (state === 'countdown' && countdownCancel) countdownCancel();
    else if (state === 'idle') startFlow();
    else stopFlow();
  }

  /* ---------- Events ---------- */

  $('#btn-main').on('click', onMainClick);
  $('#btn-pause').on('click', togglePause);
  $('#btn-region').on('click', () => chooseRegion('region'));
  $('#btn-window').on('click', () => chooseRegion('window'));
  $('#f-region').on('click', () => chooseRegion(region && region.kind === 'window' ? 'window' : 'region'));
  $('#btn-settings').on('click', () => toggleSettings());
  $('#btn-folder').on('click', () => api.openFolder());
  $('#f-saved').on('click', () => api.showFile());
  $('#f-saved').on('dblclick', () => api.openFile());
  $('#btn-min').on('click', () => api.minimize());

  $('#btn-close').on('click', async () => {
    if (state === 'countdown' && countdownCancel) countdownCancel();
    if (state === 'recording' || state === 'paused') await stopFlow();
    api.close();
  });

  $('#btn-browse').on('click', () => {
    api.browseFolder().then(folder => {
      settings.folder = folder;
      renderInfo();
    });
  });

  api.on('hotkey', action => {
    if (action === 'pause') togglePause();
    else if (state === 'countdown' && countdownCancel) countdownCancel();
    else if (state === 'idle') startFlow();
    else stopFlow();
  });

  api.on('rec:failed', async payload => {
    stopClock();
    await AudioCapture.stop();
    Wave.attach(null);
    setState('idle');
    setBusy(false);
    toast(`Recording stopped: ${payload.error}`, 'error');
    if (payload.file) showSaved(payload.file);
  });

  api.on('region:changed', r => {
    region = r || null;
    renderInfo();
  });

  api.on('app:close-request', async () => {
    await stopFlow();
    api.close();
  });

  $(navigator.mediaDevices).on('devicechange', () => {
    if (state === 'idle') loadMics();
  });

  // Window height follows the content
  new ResizeObserver(() => {
    api.setHeight(Math.ceil($('#shell').outerHeight()));
  }).observe($('#shell')[0]);

  /* ---------- Init ---------- */

  Wave.init('#wave');
  setTime(fmtTime(0));
  setState('idle');

  api.getSettings().then(s => {
    settings = s;
    region = s.region || null;
    $('#btn-window').toggle(!!s.windowPicker);
    if (s.appVersion) $('#app-version').text(`Screen Fish v${s.appVersion}`);
    fillSettings();
    renderInfo();
    loadMics();
  });
});
