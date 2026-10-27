$(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const displayId = params.get('id');
  const scale = parseFloat(params.get('scale')) || 1;
  const bx = parseFloat(params.get('bx')) || 0;
  const by = parseFloat(params.get('by')) || 0;
  const windowMode = params.get('mode') === 'window';
  const MIN = 16;

  const $body = $('body');
  const $sel = $('#sel');
  const $size = $('#size');
  const $hint = $('#hint');
  let start = null;
  let rect = null;
  let sent = false;
  let windows = null;
  let hovered = null;
  let lastPoint = null;

  function finish(data) {
    if (sent) return;
    sent = true;
    window.overlay.done(Object.assign({ displayId }, data));
  }

  function cancel() {
    if (sent) return;
    sent = true;
    window.overlay.cancel();
  }

  function placeLabel(r) {
    const below = r.y + r.height + 8;
    let top = below + 28 > window.innerHeight ? r.y - 32 : below;
    if (top < 4) top = r.y + 8;
    const left = Math.min(Math.max(4, r.x), window.innerWidth - $size.outerWidth() - 4);
    $size.css({ left, top });
  }

  /* ---------- Region mode ---------- */

  function drawRect() {
    $sel.css({ left: rect.x, top: rect.y, width: rect.width, height: rect.height });
    const w = Math.floor(rect.width * scale / 2) * 2;
    const h = Math.floor(rect.height * scale / 2) * 2;
    $size.text(`${w} × ${h}`);
    placeLabel(rect);
  }

  /* ---------- Window mode ---------- */

  function setHint() {
    if (!windowMode) {
      $hint.html('<b>Drag to select a region</b> &nbsp;·&nbsp; <kbd>Enter</kbd> full display &nbsp;·&nbsp; <kbd>Esc</kbd> cancel');
    } else if (!windows) {
      $hint.html('<b>Finding windows…</b> &nbsp;·&nbsp; <kbd>Esc</kbd> cancel');
    } else if (!windows.length) {
      $hint.html('<b>No windows found</b> &nbsp;·&nbsp; <kbd>Esc</kbd> cancel');
    } else {
      $hint.html('<b>Click a window to record it</b> &nbsp;·&nbsp; <kbd>Esc</kbd> cancel');
    }
  }

  // Topmost window under the point, in this display's coordinates
  function windowAt(x, y) {
    if (!windows) return null;
    const gx = x + bx;
    const gy = y + by;
    return windows.find(w =>
      gx >= w.dip.x && gx < w.dip.x + w.dip.width &&
      gy >= w.dip.y && gy < w.dip.y + w.dip.height
    ) || null;
  }

  function highlight(w) {
    if (w === hovered) return;
    hovered = w;
    if (!w) {
      $body.removeClass('has-sel');
      return;
    }

    const r = {
      x: w.dip.x - bx,
      y: w.dip.y - by,
      width: w.dip.width,
      height: w.dip.height
    };
    const vis = {
      x: Math.max(0, r.x),
      y: Math.max(0, r.y),
      width: Math.min(window.innerWidth, r.x + r.width) - Math.max(0, r.x),
      height: Math.min(window.innerHeight, r.y + r.height) - Math.max(0, r.y)
    };

    $sel.css({ left: vis.x, top: vis.y, width: vis.width, height: vis.height });
    $size.empty()
      .append(document.createTextNode(w.app || w.title || 'Window'))
      .append($('<small>').text(w.size));
    $size.attr('title', w.title);
    $body.addClass('has-sel');
    placeLabel(vis);
  }

  window.overlay.onWindows(list => {
    windows = Array.isArray(list) ? list : [];
    setHint();
    if (lastPoint) highlight(windowAt(lastPoint.x, lastPoint.y));
  });

  /* ---------- Events ---------- */

  $(document).on('mousedown', e => {
    if (e.button !== 0) return;
    if (windowMode) {
      const w = windowAt(e.clientX, e.clientY);
      if (w) finish({ hwnd: w.hwnd });
      return;
    }
    start = { x: e.clientX, y: e.clientY };
    rect = { x: start.x, y: start.y, width: 0, height: 0 };
    $body.addClass('dragging has-sel');
    drawRect();
  });

  $(document).on('mousemove', e => {
    $body.removeClass('away');
    lastPoint = { x: e.clientX, y: e.clientY };

    if (windowMode) {
      highlight(windowAt(e.clientX, e.clientY));
      return;
    }

    $('#gx').css('top', e.clientY);
    $('#gy').css('left', e.clientX);
    if (!start) return;

    rect = {
      x: Math.min(start.x, e.clientX),
      y: Math.min(start.y, e.clientY),
      width: Math.abs(e.clientX - start.x),
      height: Math.abs(e.clientY - start.y)
    };
    drawRect();
  });

  $(document).on('mouseup', e => {
    if (windowMode || e.button !== 0 || !start) return;
    start = null;
    $body.removeClass('dragging');

    if (rect.width < MIN || rect.height < MIN) {
      $body.removeClass('has-sel');
      rect = null;
      return;
    }
    finish({ rect });
  });

  $(document).on('mouseleave', () => {
    $body.addClass('away');
    if (windowMode) highlight(null);
  });

  $(document).on('keydown', e => {
    if (e.key === 'Escape') cancel();
    else if (!windowMode && (e.key === 'Enter' || e.key === 'f' || e.key === 'F')) finish({ full: true });
  });

  $(document).on('contextmenu', e => {
    e.preventDefault();
    cancel();
  });

  if (windowMode) $body.addClass('mode-window');
  setHint();
});
