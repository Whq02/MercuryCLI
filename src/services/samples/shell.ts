import { SAMPLE_VERSIONS_POLL_MS, sampleStateWord, type SampleShellInput, type SampleState } from './contracts.js'

export function renderSampleShell(input: SampleShellInput): string {
  const { record, token } = input
  const inline = input.inline === true
  const versions = [...input.versions].map(v => v.n).sort((a, b) => a - b)
  if (versions.length === 0) versions.push(record.latestVersion)
  const latest = record.latestVersion
  const id = escapeHtml(record.id)
  const title = escapeHtml(record.title)
  const tokenQuery = token === null ? '' : `?t=${escapeHtml(token)}`
  const page = {
    id: record.id,
    slug: record.slug,
    title: record.title,
    state: record.state,
    latestVersion: latest,
    versions,
    base: `/s/${record.id}`,
    token: inline ? null : token,
    inline,
    pollMs: SAMPLE_VERSIONS_POLL_MS,
  }
  const pills = versions
    .map(n => `<button type="button" class="pill${n === latest ? ' on' : ''}" data-version="${n}" aria-label="version ${n}" aria-pressed="${n === latest ? 'true' : 'false'}">v${n}</button>`)
    .join('')
  const firstFrame = inline
    ? `<iframe class="frame" id="frame-a" title="${title} v${latest}" sandbox="allow-scripts allow-same-origin"></iframe>`
    : `<iframe class="frame" id="frame-a" title="${title} v${latest}" sandbox="allow-scripts allow-same-origin" src="/s/${id}/v/${latest}.html${tokenQuery}"></iframe>`
  const sources = inline
    ? versions.map(n => `<template data-version="${n}">${escapeHtml(input.versionHtml?.[n] ?? '')}</template>`).join('\n')
    : ''
  return [
    '<!doctype html>',
    '<html lang="en" style="background:#050f12">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="dark">',
    '<meta name="referrer" content="no-referrer">',
    '<link rel="icon" href="data:,">',
    `<title>${title} · Samples</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<header class="bar">',
    `<span class="eyebrow">${escapeHtml(record.glyph)} Sample</span>`,
    `<h1 class="title">${title}</h1>`,
    `<span class="chip${chipTone(record.state)}" id="state">${escapeHtml(sampleStateWord(record.state))}</span>`,
    `<nav class="versions" id="versions" aria-label="versions">${pills}</nav>`,
    '<div class="btns">',
    '<button type="button" class="btn" id="code" aria-pressed="false" title="c">Code</button>',
    '<button type="button" class="btn" id="copy" aria-label="Copy the version\'s HTML">Copy</button>',
    '<button type="button" class="btn" id="download" aria-label="Download the version as a file">Download</button>',
    '<button type="button" class="btn toggle" id="marks" aria-pressed="false" title="m">Edit with Mercury</button>',
    `<button type="button" class="btn primary" id="send" title="s">${inline ? 'Copy for Mercury' : 'Send marks to Mercury'}</button>`,
    '<span class="status" id="status" role="status" aria-live="polite"></span>',
    '</div>',
    '</header>',
    '<main class="stage" id="stage">',
    firstFrame,
    '<iframe class="frame" id="frame-b" title="" sandbox="allow-scripts allow-same-origin" hidden></iframe>',
    '<div class="layer" id="layer"></div>',
    '<section class="code" id="codepanel" aria-label="the version\'s HTML" hidden>',
    '<header><span id="codename"></span><button type="button" class="btn" id="codeclose">Close</button></header>',
    '<pre id="codetext" tabindex="0"></pre>',
    '</section>',
    '</main>',
    '<footer class="foot">',
    '<label class="notef"><small>Note</small><input id="note" type="text" placeholder="a note for the whole page" aria-label="Note for the whole page"></label>',
    '<div class="verdict" role="group" aria-label="verdict">',
    '<button type="button" class="btn" id="approve" data-verdict="approve" aria-pressed="false">Approve</button>',
    '<button type="button" class="btn" id="changes" data-verdict="changes-needed" aria-pressed="false">Changes needed</button>',
    '</div>',
    '<p class="hint" id="hint">m marks on/off · ← → versions · c code · s send · ? help</p>',
    '</footer>',
    sources,
    `<script id="sample-data" type="application/json">${jsonForScript(page)}</script>`,
    `<script>${SCRIPT}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

function chipTone(state: SampleState): string {
  if (state === 'approved') return ' ok'
  if (state === 'changes-needed') return ' warn'
  return ''
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const STYLE = String.raw`
:root{--bg:#050f12;--bg-deep:#020a0c;--panel-line:#163139;--slot-line:#274f5a;--accent:#47bfff;--accent-dim:#0084cc;--accent-ink:#050f12;--text:#e8f0f2;--muted:#8ea1a6;--faint:#516970;--ok:#3FBFA0;--font-mono:"JetBrains Mono",ui-monospace,"Cascadia Code",Consolas,monospace;--font-ui:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
html,body{height:100%;margin:0;background:var(--bg);color:var(--text)}
body{display:flex;flex-direction:column;font:13px/1.4 var(--font-ui);-webkit-font-smoothing:antialiased}
[hidden]{display:none!important}
.bar,.foot{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:10px 14px;background:var(--bg-deep)}
.bar{border-bottom:1px solid var(--panel-line)}
.foot{border-top:1px solid var(--panel-line)}
.eyebrow{font:11px var(--font-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
.title{font:700 14px var(--font-mono);margin:0;color:var(--text);overflow-wrap:anywhere}
.chip{font:11px var(--font-mono);letter-spacing:.02em;border:1px solid var(--panel-line);border-radius:999px;padding:3px 10px;color:var(--muted);background:var(--bg)}
.chip.warn{border-color:var(--accent-dim);color:var(--accent)}
.chip.ok{border-color:var(--ok);color:var(--ok)}
.versions{display:flex;flex-wrap:wrap;gap:6px;margin-left:auto}
.pill{font:12px var(--font-mono);padding:4px 12px;border-radius:999px;border:1px solid var(--panel-line);background:var(--bg-deep);color:var(--muted);cursor:pointer}
.pill.on,.verdict .btn.on{border-color:var(--accent);color:var(--accent);font-weight:700}
.btns{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.btn{font:12px/1.3 var(--font-mono);letter-spacing:.01em;border:1px solid var(--slot-line);border-radius:4px;background:transparent;color:var(--text);padding:6px 12px;white-space:nowrap;cursor:pointer}
.btn.toggle{border-color:var(--accent-dim);color:var(--accent)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:700}
.btn:disabled{opacity:.55;cursor:default}
.status{font:11px var(--font-mono);color:var(--muted);overflow-wrap:anywhere}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.stage{position:relative;flex:1;min-height:0;overflow:hidden;background:var(--bg)}
.frame{position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent;transition:opacity 180ms ease}
.frame.ready{background:#fff}
.layer{position:absolute;inset:0;z-index:3;pointer-events:none;overflow:hidden}
body.marking .layer{pointer-events:auto;cursor:crosshair}
.pin{position:absolute;width:20px;height:20px;margin:-10px 0 0 -10px;padding:0;border:0;border-radius:50%;background:var(--accent);color:var(--accent-ink);font:700 11px var(--font-mono);display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 3px rgba(71,191,255,.3);cursor:grab;pointer-events:auto;touch-action:none}
body:not(.marking) .pin{pointer-events:none}
.pin.drag{cursor:grabbing}
.comment{position:absolute;z-index:4;box-sizing:border-box;background:var(--bg-deep);color:var(--text);border:1px solid var(--slot-line);border-radius:4px;padding:8px 10px;box-shadow:0 10px 28px rgba(0,0,0,.35);font-size:12.5px;pointer-events:auto}
.comment .who{font:11px var(--font-mono);color:var(--muted);margin-bottom:5px;overflow-wrap:anywhere}
.comment textarea{display:block;width:100%;box-sizing:border-box;border:1px solid var(--accent-dim);border-radius:4px;padding:5px 8px;background:var(--bg);color:var(--text);font:12px/1.4 var(--font-mono);resize:vertical;min-height:34px}
.comment .keys{display:flex;justify-content:space-between;gap:8px;margin-top:6px;font:11px var(--font-mono);color:var(--faint)}
.comment .remove{background:none;border:0;padding:0;color:var(--muted);font:11px var(--font-mono);cursor:pointer}
.code{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;background:var(--bg-deep)}
.code header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 14px;border-bottom:1px solid var(--panel-line);font:11px var(--font-mono);color:var(--muted)}
.code pre{flex:1;margin:0;padding:12px 14px;overflow:auto;font:12px/1.5 var(--font-mono);color:var(--text);white-space:pre-wrap;overflow-wrap:anywhere}
.notef{flex:1;min-width:200px;display:flex;align-items:center;gap:8px;border:1px solid var(--slot-line);border-radius:4px;padding:6px 10px;background:transparent}
.notef:focus-within{border-color:var(--accent)}
.notef small{font:10.5px var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
.notef input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--text);font:12px var(--font-mono)}
.verdict{display:flex;flex-wrap:wrap;gap:6px}
.verdict .btn{border-radius:999px}
.hint{width:100%;margin:0;font:11px var(--font-mono);color:var(--faint)}
@media (max-width:640px){.versions{margin-left:0}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`

const SCRIPT = String.raw`
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('sample-data').textContent);
  var byId = function (id) { return document.getElementById(id); };
  var frameA = byId('frame-a'), frameB = byId('frame-b');
  var active = frameA, idle = frameB;
  var layer = byId('layer'), statusEl = byId('status'), chipEl = byId('state'), versionsEl = byId('versions');
  var codePanel = byId('codepanel'), codeText = byId('codetext'), codeName = byId('codename');
  var noteEl = byId('note'), hintEl = byId('hint');
  var marksBtn = byId('marks'), sendBtn = byId('send'), codeBtn = byId('code');
  var verdictBtns = [byId('approve'), byId('changes')];
  var versions = data.versions.slice();
  var current = data.latestVersion, newest = data.latestVersion;
  var state = data.state, verdict = null, marking = false;
  var pinsByVersion = {}, sourceCache = {}, loadSeq = 0, statusTimer = 0, box = null;

  function pins() { return pinsByVersion[current] || (pinsByVersion[current] = []); }
  function versionUrl(n) { return data.base + '/v/' + n + '.html?t=' + data.token; }
  function stateWord(s) { return s === 'changes-needed' ? 'changes needed' : s; }
  function verdictWord(v) { return v === 'approve' ? 'approved' : v === 'changes-needed' ? 'changes needed' : 'no verdict'; }
  function fold(text, max) { return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max); }
  function clamp(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function reducedMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }

  function setStatus(text, keep) {
    clearTimeout(statusTimer);
    statusEl.textContent = text;
    if (!keep) statusTimer = setTimeout(function () { statusEl.textContent = ''; }, 4000);
  }
  function setChip() {
    chipEl.textContent = stateWord(state);
    chipEl.className = 'chip' + (state === 'approved' ? ' ok' : state === 'changes-needed' ? ' warn' : '');
  }
  function setPressed(el, on) { el.classList.toggle('on', on); el.setAttribute('aria-pressed', on ? 'true' : 'false'); }

  function pillFor(n) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'pill'; b.dataset.version = String(n);
    b.setAttribute('aria-label', 'version ' + n); b.setAttribute('aria-pressed', 'false');
    b.textContent = 'v' + n;
    return b;
  }
  function markPills() {
    var list = versionsEl.querySelectorAll('.pill');
    for (var i = 0; i < list.length; i++) setPressed(list[i], Number(list[i].dataset.version) === current);
  }
  function step(d) { var i = versions.indexOf(current) + d; if (i >= 0 && i < versions.length) show(versions[i]); }
  versionsEl.addEventListener('click', function (e) { var b = e.target.closest('.pill'); if (b) show(Number(b.dataset.version)); });

  function sourceOf(n) { var t = document.querySelector('template[data-version="' + n + '"]'); return t ? t.content.textContent : ''; }
  function sourceText(n) {
    if (sourceCache[n] !== undefined) return Promise.resolve(sourceCache[n]);
    if (data.inline) { sourceCache[n] = sourceOf(n); return Promise.resolve(sourceCache[n]); }
    return fetch(versionUrl(n), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (t) { sourceCache[n] = t; return t; });
  }

  function show(n, first) {
    if (!first && n === current) return;
    var seq = ++loadSeq, from = active, to = first ? active : idle;
    current = n; markPills(); settleBox();
    if (!codePanel.hidden) fillCode();
    if (!first) {
      to.classList.remove('ready'); to.style.opacity = '0';
      to.style.zIndex = '2'; from.style.zIndex = '1'; to.hidden = false;
    }
    to.title = data.title + ' v' + n;
    to.onload = function () { landed(to, from, n, seq, first); };
    if (data.inline) to.srcdoc = sourceOf(n);
    else if (!(first && to.getAttribute('src'))) to.src = versionUrl(n);
    else alreadyLoaded(to, from, n, seq);
    renderPins();
  }
  function alreadyLoaded(to, from, n, seq) {
    try {
      var w = to.contentWindow;
      if (w && w.document.readyState === 'complete' && w.location.href !== 'about:blank') landed(to, from, n, seq, true);
    } catch (e) {}
  }
  function landed(to, from, n, seq, first) {
    if (seq !== loadSeq) return;
    to.classList.add('ready');
    if (!first) {
      active = to; idle = from;
      requestAnimationFrame(function () { to.style.opacity = '1'; });
      setTimeout(function () {
        if (idle !== from) return;
        from.onload = null; from.hidden = true; from.removeAttribute('srcdoc'); from.src = 'about:blank';
      }, reducedMotion() ? 0 : 220);
    }
    try { to.contentWindow.addEventListener('scroll', renderPins, { passive: true }); } catch (e) {}
    renderPins();
  }

  function metrics() {
    var rect = layer.getBoundingClientRect();
    try {
      var w = active.contentWindow, root = w.document.documentElement;
      return { rect: rect, doc: w.document, sx: w.scrollX, sy: w.scrollY, sw: Math.max(root.scrollWidth, root.clientWidth, 1), sh: Math.max(root.scrollHeight, root.clientHeight, 1) };
    } catch (e) {
      return { rect: rect, doc: null, sx: 0, sy: 0, sw: Math.max(rect.width, 1), sh: Math.max(rect.height, 1) };
    }
  }
  function pinAt(px, py, m) {
    var pin = { x: clamp((px + m.sx) / m.sw), y: clamp((py + m.sy) / m.sh), target: 'the page', text: '', node: null, nx: 0, ny: 0 };
    var node = nodeAt(px, py, m);
    if (node) {
      var r = node.getBoundingClientRect();
      pin.node = node; pin.target = describe(node);
      pin.nx = r.width ? (px - r.left) / r.width : 0; pin.ny = r.height ? (py - r.top) / r.height : 0;
    }
    return pin;
  }
  function nodeAt(px, py, m) {
    if (!m.doc) return null;
    try { return m.doc.elementFromPoint(px, py); } catch (e) { return null; }
  }
  function place(pin, m) {
    var node = pin.node;
    if (node && m.doc && node.ownerDocument === m.doc && node.isConnected) {
      var r = node.getBoundingClientRect();
      if (r.width || r.height) return { left: r.left + pin.nx * r.width, top: r.top + pin.ny * r.height };
    }
    return { left: pin.x * m.sw - m.sx, top: pin.y * m.sh - m.sy };
  }
  function describe(el) {
    if (!el || el.nodeType !== 1) return 'the page';
    var tag = el.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body') return 'the page';
    var s = tag;
    if (el.id) s += '#' + el.id;
    var cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) s += '.' + cls.join('.');
    var words = fold(el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('alt') || el.textContent, 400).split(' ').slice(0, 6).join(' ');
    if (words.length > 48) words = words.slice(0, 48) + '…';
    if (words) s += ' "' + words + '"';
    return s.slice(0, 160);
  }

  function renderPins() {
    var m = metrics(), list = pins(), old = layer.querySelectorAll('.pin');
    for (var i = 0; i < old.length; i++) old[i].remove();
    list.forEach(function (pin, i) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'pin'; b.textContent = String(i + 1);
      b.setAttribute('aria-label', 'pin ' + (i + 1) + (pin.text ? ': ' + pin.text : ''));
      var at = place(pin, m);
      b.style.left = at.left + 'px'; b.style.top = at.top + 'px';
      pin.el = b; armPin(b, pin);
      layer.insertBefore(b, box ? box.el : null);
    });
    positionBox();
  }
  function armPin(el, pin) {
    var start = null, moved = false;
    el.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY, left: parseFloat(el.style.left), top: parseFloat(el.style.top) };
      moved = false; el.setPointerCapture(e.pointerId); e.preventDefault();
    });
    el.addEventListener('pointermove', function (e) {
      if (!start) return;
      var dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true; el.classList.add('drag');
      el.style.left = (start.left + dx) + 'px'; el.style.top = (start.top + dy) + 'px';
      if (box && box.pin === pin) positionBox();
    });
    el.addEventListener('pointerup', function (e) {
      if (!start) return;
      var was = start; start = null; el.classList.remove('drag');
      if (!moved) { openBox(pin, false); return; }
      var m = metrics();
      var px = Math.min(Math.max(was.left + (e.clientX - was.x), 0), m.rect.width);
      var py = Math.min(Math.max(was.top + (e.clientY - was.y), 0), m.rect.height);
      var at = pinAt(px, py, m);
      pin.x = at.x; pin.y = at.y; pin.target = at.target; pin.node = at.node; pin.nx = at.nx; pin.ny = at.ny;
      if (box && box.pin === pin) box.who.textContent = whoText(pin);
      renderPins();
    });
    el.addEventListener('pointercancel', function () { start = null; el.classList.remove('drag'); renderPins(); });
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBox(pin, false); } });
  }

  layer.addEventListener('click', function (e) {
    if (!marking || e.target !== layer) return;
    settleBox();
    var m = metrics(), px = e.clientX - m.rect.left, py = e.clientY - m.rect.top;
    var pin = pinAt(px, py, m);
    pins().push(pin); renderPins(); openBox(pin, true);
  });
  layer.addEventListener('wheel', function (e) {
    if (!marking) return;
    try { active.contentWindow.scrollBy(e.deltaX, e.deltaY); e.preventDefault(); } catch (err) {}
  }, { passive: false });

  function whoText(pin) { return 'pin ' + (pins().indexOf(pin) + 1) + ' · ' + pin.target; }
  function openBox(pin, fresh) {
    if (box && box.pin === pin) { box.input.focus(); return; }
    settleBox();
    var el = document.createElement('div'); el.className = 'comment';
    var who = document.createElement('div'); who.className = 'who'; who.textContent = whoText(pin);
    var input = document.createElement('textarea');
    input.rows = 2; input.value = pin.text; input.placeholder = 'what should change here';
    input.setAttribute('aria-label', 'comment for ' + whoText(pin));
    var keys = document.createElement('div'); keys.className = 'keys';
    var hint = document.createElement('span'); hint.textContent = fresh ? '↵ keep · esc remove' : '↵ keep · esc close';
    var remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'remove'; remove.textContent = 'remove pin';
    remove.setAttribute('aria-label', 'remove ' + whoText(pin));
    keys.appendChild(hint); keys.appendChild(remove);
    el.appendChild(who); el.appendChild(input); el.appendChild(keys);
    layer.appendChild(el);
    box = { pin: pin, fresh: fresh, el: el, input: input, who: who };
    positionBox(); input.focus();
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        var text = input.value.trim();
        if (text) { pin.text = text; closeBox(); if (pin.el) pin.el.focus(); } else removePin(pin);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (fresh) removePin(pin); else { closeBox(); if (pin.el) pin.el.focus(); }
      }
    });
    remove.addEventListener('click', function () { removePin(pin); });
  }
  function positionBox() {
    if (!box) return;
    var m = metrics(), at = place(box.pin, m);
    var w = Math.min(230, Math.max(m.rect.width - 16, 120));
    var left = at.left + 14, top = at.top - 14;
    if (left + w > m.rect.width - 8) left = Math.max(8, at.left - w - 14);
    top = Math.min(Math.max(top, 8), Math.max(8, m.rect.height - box.el.offsetHeight - 8));
    box.el.style.left = left + 'px'; box.el.style.top = top + 'px'; box.el.style.width = w + 'px';
  }
  function settleBox() {
    if (!box) return;
    var text = box.input.value.trim();
    if (text) { box.pin.text = text; closeBox(); }
    else if (box.fresh) removePin(box.pin);
    else closeBox();
  }
  function closeBox() { if (!box) return; var el = box.el; box = null; el.remove(); renderPins(); }
  function removePin(pin) {
    var list = pins(), i = list.indexOf(pin);
    if (i >= 0) list.splice(i, 1);
    closeBox(); marksBtn.focus();
  }

  function setMarking(on) {
    marking = on;
    document.body.classList.toggle('marking', on);
    setPressed(marksBtn, on);
    marksBtn.textContent = on ? 'Edit with Mercury · on' : 'Edit with Mercury';
    if (!on) settleBox();
  }
  marksBtn.addEventListener('click', function () { setMarking(!marking); });

  function markVerdict() { verdictBtns.forEach(function (b) { setPressed(b, b.dataset.verdict === verdict); }); }
  verdictBtns.forEach(function (b) {
    b.addEventListener('click', function () { verdict = verdict === b.dataset.verdict ? null : b.dataset.verdict; markVerdict(); });
  });

  function marksBody() {
    return {
      version: current,
      pins: pins().map(function (p) {
        return { x: Math.round(p.x * 10000) / 10000, y: Math.round(p.y * 10000) / 10000, target: fold(p.target, 160) || 'the page', text: fold(p.text, 2000) };
      }),
      note: noteEl.value.trim().slice(0, 4000),
      verdict: verdict,
    };
  }
  function messageOf(m) {
    var k = m.pins.length;
    var lines = ['Marks on ' + data.title + ' v' + m.version + ': ' + k + ' ' + (k === 1 ? 'pin' : 'pins') + ' · ' + (m.note ? '1 note' : 'no note') + ' · ' + verdictWord(m.verdict)];
    m.pins.forEach(function (p) { lines.push('- at ' + p.target + ': ' + p.text); });
    if (m.note) { if (k > 0) lines.push(''); lines.push(m.note); }
    return lines.join('\n');
  }
  function afterSend(m) {
    pinsByVersion[m.version] = [];
    noteEl.value = ''; verdict = null; markVerdict();
    if (m.verdict === 'approve') state = 'approved';
    else if (m.verdict === 'changes-needed') state = 'changes-needed';
    setChip(); closeBox(); renderPins();
  }
  function send() {
    if (sendBtn.disabled) return;
    settleBox();
    var m = marksBody();
    if (!m.pins.length && !m.note && !m.verdict) { setStatus('nothing to send yet: drop a pin, write a note or pick a verdict'); return; }
    if (data.inline) {
      copyText(messageOf(m)).then(
        function () { setStatus('copied for Mercury: paste it into the composer', true); afterSend(m); },
        function (e) { setStatus('not copied: ' + e.message, true); }
      );
      return;
    }
    sendBtn.disabled = true; setStatus('sending…', true);
    fetch(data.base + '/marks?t=' + data.token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json().catch(function () { return {}; }); })
      .then(
        function (reply) { setStatus(reply.delivered === false ? 'kept, but the session did not take it' : 'sent'); afterSend(m); },
        function (e) { setStatus('not sent: ' + e.message, true); }
      )
      .then(function () { sendBtn.disabled = false; });
  }
  sendBtn.addEventListener('click', send);

  function copyText(text) {
    var legacy = function () {
      return new Promise(function (ok, bad) {
        var ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var done = false;
        try { done = document.execCommand('copy'); } catch (e) {}
        ta.remove();
        if (done) ok(); else bad(new Error('the clipboard is not available here'));
      });
    };
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(legacy);
    return legacy();
  }

  function fileName(n) { return data.slug + '-v' + n + '.html'; }
  function fillCode() {
    var n = current;
    codeName.textContent = fileName(n); codeText.textContent = 'reading…';
    sourceText(n).then(
      function (t) { if (n !== current) return; codeText.textContent = t; codeName.textContent = fileName(n) + ' · ' + new Blob([t]).size + ' bytes'; },
      function (e) { codeText.textContent = 'could not read the version: ' + e.message; }
    );
  }
  function toggleCode(force) {
    var open = force === undefined ? codePanel.hidden : force;
    codePanel.hidden = !open; setPressed(codeBtn, open);
    if (open) fillCode();
  }
  codeBtn.addEventListener('click', function () { toggleCode(); });
  byId('codeclose').addEventListener('click', function () { toggleCode(false); });
  byId('copy').addEventListener('click', function () {
    sourceText(current).then(copyText).then(function () { setStatus('copied'); }, function (e) { setStatus('not copied: ' + e.message, true); });
  });
  byId('download').addEventListener('click', function () {
    var n = current;
    sourceText(n).then(function (t) {
      var a = document.createElement('a'), url = URL.createObjectURL(new Blob([t], { type: 'text/html' }));
      a.href = url; a.download = fileName(n);
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      setStatus('downloading ' + fileName(n));
    }, function (e) { setStatus('could not read the version: ' + e.message, true); });
  });

  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (typing) { if (e.key === 'Escape' && t === noteEl) t.blur(); return; }
    if (e.key === 'm') setMarking(!marking);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'c') toggleCode();
    else if (e.key === 's') send();
    else if (e.key === '?') hintEl.hidden = !hintEl.hidden;
    else if (e.key === 'Escape') { if (!codePanel.hidden) toggleCode(false); else if (box) settleBox(); else return; }
    else return;
    e.preventDefault();
  });
  window.addEventListener('resize', renderPins);

  if (!data.inline && data.token) {
    var misses = 0;
    var timer = setInterval(function () {
      fetch(data.base + '/versions?t=' + data.token, { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (v) {
          misses = 0;
          var latest = Number(v && v.latestVersion) || 0;
          if (latest <= newest) return;
          var wasNewest = current === newest;
          for (var n = newest + 1; n <= latest; n++) { versions.push(n); versionsEl.appendChild(pillFor(n)); }
          newest = latest; state = 'open'; setChip(); markPills();
          if (wasNewest) show(latest);
        }, function () {
          if (++misses >= 3) { clearInterval(timer); setStatus('the session\'s listener is gone: reopen the sample from Mercury', true); }
        });
    }, data.pollMs);
  }

  setChip(); markVerdict();
  show(current, true);
})();
`
