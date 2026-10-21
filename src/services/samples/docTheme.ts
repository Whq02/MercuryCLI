export const DOC_STYLE = `
:root {
  color-scheme: dark;
  --bg: #090d16;
  --bg-deep: #050910;
  --panel: #0c1220;
  --panel-line: #232d44;
  --slot-line: #3b496a;
  --line-ui: #566890;
  --cream: #ede8dd;
  --text: #eceff3;
  --prose: #d7dbe3;
  --muted: #999ea9;
  --faint: #798296;
  --accent: #a4b4da;
  --accent-dim: #4d7ae2;
  --water-light: #aabdf1;
  --red: #cb414a;
  --red-ink: #f07178;
  --ok: #5ec49e;
  --warn: #e0a94c;
  --glyph-far: #171c28;
  --glyph-near: #202633;
  --tty-bg: #0b0b0b; --tty-bar: #161616; --tty-line: #2e2e2e;
  --tty-text: #28fe14; --tty-dim: #1fb214; --tty-del: #fc391f; --tty-del-band: #2b0b07; --tty-add-band: #0c2e0a;
  --tty-warn: #e5e02a; --tty-accent: #37d2d9; --tty-bar-text: #9c9c9c; --tty-cmd: #e0e0e0; --tty-btn-line: #6b6b6b; --tty-btn-text: #bdbdbd;
  --font-display: "Cinzel", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif;
  --font-serif: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", Times, serif;
  --font-ui: "Source Sans 3", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, "Cascadia Code", "SFMono-Regular", Menlo, Consolas, monospace;
  --s-1: 4px; --s-2: 8px; --s-3: 12px; --s-4: 16px; --s-5: 24px; --s-6: 40px; --s-7: 56px; --s-8: 80px;
}
html[data-theme="light"] {
  color-scheme: light;
  --bg: #ece2cc; --bg-deep: #e3d7bc; --panel: #e7dcc3; --panel-line: #cdbd9c; --slot-line: #b09d78; --line-ui: #7e6b52;
  --cream: #241c15; --text: #241c15; --prose: #2e2419; --muted: #5a4a3a; --faint: #64533f;
  --accent: #3f4e6b; --accent-dim: #2c3a52; --water-light: #3f4e6b;
  --red: #8a2b24; --red-ink: #8a2b24; --ok: #295e35; --warn: #6e480b;
}
@media print {
  :root {
    color-scheme: light;
    --bg: #ece2cc; --bg-deep: #e3d7bc; --panel: #e7dcc3; --panel-line: #cdbd9c; --slot-line: #b09d78; --line-ui: #7e6b52;
    --cream: #241c15; --text: #241c15; --prose: #2e2419; --muted: #5a4a3a; --faint: #64533f;
    --accent: #3f4e6b; --accent-dim: #2c3a52; --water-light: #3f4e6b;
    --red: #8a2b24; --red-ink: #8a2b24; --ok: #295e35; --warn: #6e480b;
  }
}

*, *::before, *::after { box-sizing: border-box; }
html { background: var(--bg); color: var(--text); scroll-behavior: smooth; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 var(--font-ui); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
[hidden] { display: none !important; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

.glyph-field { position: fixed; inset: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; display: block; }
main.tabula { position: relative; z-index: 1; max-width: 1000px; margin: 0 auto; padding: var(--s-7) 32px var(--s-8); }

a { color: var(--accent); text-decoration: underline; text-decoration-color: var(--water-light); text-decoration-thickness: 1px; text-underline-offset: 3px; }
a:hover, a:focus-visible { color: var(--cream); }
button, input { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--cream); outline-offset: 2px; }
.tabula code { font-family: var(--font-mono); font-size: .875em; color: var(--text); background: var(--bg-deep); border: 1px solid var(--panel-line); padding: 1px 5px; border-radius: 0; }

.eyebrow, .label, .meta-strip, .data-table th, .verdict-stamp, .diff-label, .term-title, .opt-rec, .sticky-stamp, .sticky-link, .outline-link, .btn-ghost {
  font: 500 .72rem/1.25 var(--font-ui); letter-spacing: .16em; text-transform: uppercase; color: var(--muted);
}
.interpunct { color: var(--faint); padding: 0 .35em; }

.doc-header { margin-bottom: var(--s-5); }
.doc-header-top { display: flex; align-items: center; justify-content: space-between; gap: var(--s-4); flex-wrap: wrap; }
.brand-lockup { display: inline-flex; align-items: center; gap: 12px; }
.brand-mark { display: block; flex: none; }
.bm-bone { fill: #f0e8d6; } .bm-shade { fill: #a89880; } .bm-wing { fill: #acbbe0; } .bm-wing-dim { fill: #5575be; }
html[data-theme="light"] .bm-bone { fill: #241c15; } html[data-theme="light"] .bm-shade { fill: #5a4a3a; }
html[data-theme="light"] .bm-wing { fill: #3f4e6b; } html[data-theme="light"] .bm-wing-dim { fill: #2c3a52; }
.view-bar { display: inline-flex; gap: 6px; }
.btn-ghost { min-height: 28px; padding: 5px 12px; border: 1px solid var(--line-ui); background: transparent; letter-spacing: .14em; font-size: .68rem; border-radius: 0; cursor: pointer; white-space: nowrap; }
.btn-ghost:hover, .btn-ghost[aria-pressed="true"] { color: var(--cream); border-color: var(--cream); }
.doc-title { font: 500 clamp(1.65rem, 3.2vw, 2.35rem)/1.18 var(--font-display); letter-spacing: .06em; text-transform: uppercase; color: var(--cream); margin: 22px 0 0; overflow-wrap: anywhere; }
.doc-subtitle { font-family: var(--font-serif); font-size: 1.0625rem; line-height: 1.65; color: var(--prose); max-width: 65ch; margin: 14px 0 0; }
.meta-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 0; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--panel-line); letter-spacing: .12em; }
.meta-item + .meta-item::before { content: "·"; color: var(--faint); margin: 0 10px; }
.doc-outline { display: flex; flex-wrap: wrap; gap: 8px 22px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--panel-line); }
.outline-link { letter-spacing: .12em; text-decoration: none; }
.outline-link:hover, .outline-link:focus-visible { color: var(--cream); }
.outline-num { color: var(--accent); margin-right: 6px; font-family: var(--font-display); letter-spacing: .06em; }

.sticky-verdict { position: fixed; top: 0; left: 0; right: 0; z-index: 20; height: 34px; display: flex; align-items: center; gap: 14px; padding: 0 20px; background: var(--bg-deep); border-bottom: 1px solid var(--slot-line); }
.sticky-stamp { white-space: nowrap; letter-spacing: .14em; font-size: .68rem; color: var(--accent); }
.sticky-verdict.status-approved .sticky-stamp { color: var(--ok); }
.sticky-verdict.status-changes-needed .sticky-stamp, .sticky-verdict.status-halted .sticky-stamp { color: var(--red-ink); }
.sticky-verdict.status-warning .sticky-stamp { color: var(--warn); }
.sticky-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 14px/1.2 var(--font-serif); color: var(--prose); }
.sticky-link { color: var(--accent); white-space: nowrap; letter-spacing: .14em; font-size: .68rem; text-decoration: none; }
.sticky-link:hover, .sticky-link:focus-visible { color: var(--cream); }

.part { margin-top: var(--s-6); }
.part, .section-title { scroll-margin-top: 48px; }
.section-head { display: flex; align-items: baseline; gap: 12px; border-top: 1px solid var(--panel-line); padding-top: 24px; margin-bottom: 16px; }
.sec-num { font: 500 .95rem/1.3 var(--font-display); letter-spacing: .1em; color: var(--accent); flex: none; min-width: 2ch; }
.section-title { font: 500 1.02rem/1.3 var(--font-display); letter-spacing: .14em; text-transform: uppercase; color: var(--cream); margin: 0; }

.part-verdict { margin-top: var(--s-5); background: var(--bg-deep); border: 1px solid var(--slot-line); border-left: 3px solid var(--accent); padding: 20px 24px; }
.part-verdict.status-approved { border-left-color: var(--ok); }
.part-verdict.status-changes-needed, .part-verdict.status-halted { border-left-color: var(--red); }
.part-verdict.status-warning { border-left-color: var(--warn); }
.verdict-stamp { color: var(--accent); margin-bottom: 10px; }
.status-approved .verdict-stamp { color: var(--ok); }
.status-changes-needed .verdict-stamp, .status-halted .verdict-stamp { color: var(--red-ink); }
.status-warning .verdict-stamp { color: var(--warn); }
.verdict-summary { margin: 0; font-family: var(--font-serif); font-size: 1.15rem; line-height: 1.48; color: var(--cream); max-width: 70ch; }
.verdict-detail { margin: 10px 0 0; font: 14.5px/1.55 var(--font-ui); color: var(--muted); max-width: 80ch; }

.prose-body { max-width: 65ch; }
.prose-p { margin: 0 0 14px; font-family: var(--font-serif); font-size: 1.0625rem; line-height: 1.65; color: var(--prose); }
.prose-list { margin: 0 0 14px; padding-left: 1.3em; font-family: var(--font-serif); font-size: 1rem; line-height: 1.6; color: var(--prose); }
.prose-li { margin: 5px 0; padding-left: .2em; }
.prose-li::marker { color: var(--accent); }
.prose-note { margin: 18px 0 0; padding: 12px 16px; background: var(--bg-deep); border: 1px solid var(--panel-line); border-left: 2px solid var(--accent); font-family: var(--font-serif); font-size: .97rem; line-height: 1.6; color: var(--prose); }
.prose-note strong { color: var(--cream); font-weight: 600; }

.card-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; padding: 0 1px 1px 0; }
.card-grid.cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.card-grid.cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.card { background: var(--bg-deep); padding: 20px 22px; display: flex; flex-direction: column; gap: 6px; min-width: 0; border: 1px solid var(--panel-line); margin: 0 -1px -1px 0; }
.card .label { display: block; }
.tone-ok .label { color: var(--ok); } .tone-warn .label { color: var(--warn); } .tone-danger .label { color: var(--red-ink); } .tone-accent .label { color: var(--accent); }
.card-value { font: 500 24px/1.2 var(--font-display); color: var(--cream); font-variant-numeric: tabular-nums; margin: 2px 0 0; }
.card-title { font: 600 15.5px/1.35 var(--font-ui); color: var(--text); margin: 0; }
.card-body { font: 14.5px/1.55 var(--font-ui); color: var(--muted); margin: 0; }

.table-wrap { width: 100%; overflow-x: auto; }
.data-table { width: 100%; border-collapse: collapse; font: 14.5px/1.55 var(--font-ui); font-variant-numeric: tabular-nums; border-top: 1px solid var(--slot-line); }
.data-table th, .data-table td { padding: 11px 14px 11px 0; text-align: left; vertical-align: top; border-bottom: 1px solid var(--panel-line); }
.data-table th { border-bottom: 1px solid var(--slot-line); white-space: nowrap; }
.data-table.long thead th { position: sticky; top: 0; background: var(--bg); }
.data-table tbody tr:hover { background: var(--panel); }
.cell-mono { font: 13px/1.55 var(--font-mono); color: var(--text); white-space: nowrap; }
.cell-ok, .cell-warn, .cell-danger, .cell-accent { font: 600 12px/1.6 var(--font-ui); letter-spacing: .1em; text-transform: uppercase; white-space: nowrap; }
.cell-ok { color: var(--ok); } .cell-warn { color: var(--warn); } .cell-danger { color: var(--red-ink); } .cell-accent { color: var(--accent); }
.part-caption { margin: 10px 0 0; font: 13.5px/1.5 var(--font-ui); color: var(--muted); max-width: 90ch; }

.diff-tools { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.diff-tools .part-caption { margin: 0; }
.diff-actions { display: inline-flex; gap: 6px; margin-left: auto; }
.diff-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.diff-grid.unified { grid-template-columns: 1fr; }
.diff-pane { min-width: 0; background: var(--tty-bg); border: 1px solid var(--tty-line); display: flex; flex-direction: column; }
.diff-bar, .term-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 8px 14px; background: var(--tty-bar); border-bottom: 1px solid var(--tty-line); }
.diff-label, .term-title { color: var(--tty-bar-text); }
.diff-before .diff-label { color: var(--tty-del); } .diff-after .diff-label { color: var(--tty-text); }
.diff-meta { font: 12.5px/1.4 var(--font-mono); color: var(--tty-bar-text); }
.diff-code, .term-pre { margin: 0; padding: 12px 0; overflow-x: auto; font: 13px/1.55 var(--font-mono); tab-size: 2; color: var(--tty-text); background: var(--tty-bg); }
.code-line, .term-line { display: block; padding: 1px 16px; white-space: pre; }
.line-num { display: inline-block; width: 28px; margin-right: 14px; text-align: right; color: var(--tty-dim); user-select: none; }
.tone-del { background: var(--tty-del-band); color: var(--tty-del); } .tone-del .line-num { color: var(--tty-del); }
.tone-add { background: var(--tty-add-band); color: var(--tty-text); } .tone-add .line-num { color: var(--tty-text); }
.tone-dim { color: var(--tty-dim); } .tone-warn-line { color: var(--tty-warn); } .tone-accent { color: var(--tty-accent); }
.diff-pane :focus-visible, .term-box :focus-visible { outline-color: var(--tty-text); }

.term-box { margin: 0; background: var(--tty-bg); border: 1px solid var(--tty-line); }
.term-bar .term-cmd { flex: 1 1 auto; min-width: 0; font: 12.5px/1.5 var(--font-mono); color: var(--tty-cmd); overflow-wrap: anywhere; }
.term-cmd::before { content: "$ "; color: var(--tty-text); }
.term-bar .btn-ghost { border-color: var(--tty-btn-line); color: var(--tty-btn-text); }
.term-bar .btn-ghost:hover, .term-bar .btn-ghost:focus-visible { border-color: var(--tty-cmd); color: var(--tty-cmd); }
.term-pre.folded .term-line:nth-child(n+31) { display: none; }
.term-more { margin-top: 8px; }

.figure-box { margin: 0; padding: 22px; border: 1px solid var(--panel-line); }
.figure-box svg, .figure-box img { max-width: 100%; height: auto; display: block; margin: 0 auto; }
.fx-box { fill: var(--bg-deep); stroke: var(--slot-line); stroke-width: 1; }
.fx-top { stroke: var(--accent); stroke-width: 1.5; }
.fx-arrow { stroke: var(--accent); fill: var(--accent); stroke-width: 1.5; }
.fx-caps { fill: var(--muted); font: 500 10px var(--font-ui); letter-spacing: 1.6px; }
.fx-label { fill: var(--cream); font: 500 13px var(--font-display); }
.flow { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px 28px; margin: 0; padding: 0; list-style: none; }
.flow-step { position: relative; min-width: 0; background: var(--bg-deep); border: 1px solid var(--slot-line); padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; }
.flow-step + .flow-step::before { content: "→"; position: absolute; left: -23px; top: 50%; transform: translateY(-50%); color: var(--accent); font: 18px/1 var(--font-serif); }
.flow-step .label { color: var(--accent); }
.flow-text { font: 14px/1.45 var(--font-ui); color: var(--text); }
.flow-detail { font: 12px/1.5 var(--font-mono); color: var(--muted); overflow-wrap: anywhere; }

.check-list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--panel-line); }
.check-item { display: flex; align-items: flex-start; gap: 14px; padding: 12px 4px; border-bottom: 1px solid var(--panel-line); }
.check-box { flex: 0 0 20px; width: 20px; text-align: center; font: 15px/1.5 var(--font-mono); border: 0; background: transparent; padding: 0; }
.state-done .check-box { color: var(--ok); } .state-pending .check-box { color: var(--warn); }
.state-failed .check-box { color: var(--red-ink); } .state-skipped .check-box { color: var(--muted); }
.check-content { min-width: 0; flex: 1; }
.check-text { font: 15px/1.5 var(--font-ui); color: var(--text); }
.check-detail { display: block; margin-top: 2px; font: 13.5px/1.5 var(--font-ui); color: var(--muted); }

.question-box { background: var(--bg-deep); border: 1px solid var(--slot-line); border-left: 3px solid var(--accent); padding: 22px 24px; }
.question-prompt { margin: 0 0 18px; font-family: var(--font-serif); font-size: 1.0625rem; line-height: 1.65; color: var(--prose); max-width: 65ch; }
.question-opts { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; margin-bottom: 16px; }
.question-opt { text-align: left; background: transparent; border: 1px solid var(--line-ui); padding: 14px 16px; border-radius: 0; cursor: pointer; display: flex; flex-direction: column; gap: 6px; color: var(--text); }
.question-opt:hover { border-color: var(--accent); }
.question-opt[aria-pressed="true"] { border-color: var(--cream); box-shadow: inset 0 0 0 1px var(--cream); }
.opt-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; font: 600 15px/1.35 var(--font-ui); color: var(--text); }
.opt-rec { color: var(--accent); font-size: .62rem; letter-spacing: .14em; white-space: nowrap; }
.opt-desc { font: 13.5px/1.5 var(--font-ui); color: var(--muted); }
.question-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding-top: 12px; border-top: 1px solid var(--panel-line); }
.question-status { font: 12.5px/1.4 var(--font-ui); color: var(--muted); }

@media (max-width: 900px) {
  .card-grid, .card-grid.cols-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .diff-grid { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  main.tabula { padding: 32px 18px 48px; }
  .card-grid, .card-grid.cols-2, .card-grid.cols-4 { grid-template-columns: 1fr; }
  .flow { grid-template-columns: 1fr; gap: 26px 0; }
  .flow-step + .flow-step::before { content: "↓"; left: 50%; top: -22px; transform: translateX(-50%); }
  .data-table th, .data-table td { padding: 9px 10px 9px 0; }
}
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
@page { size: A4; margin: 14mm 12mm 16mm; }
@media print {
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .glyph-field, .sticky-verdict, .view-bar, .btn-ghost, .doc-outline, .term-more, .question-copy { display: none !important; }
  html, body { background: var(--bg); }
  main.tabula { max-width: 100%; padding: 0; }
  .section-head, .diff-bar, .term-bar, .data-table thead { break-after: avoid; }
  .part-verdict, .card, .diff-pane, .term-box, .question-box, .figure-box, .check-item, .flow-step, .data-table tr, .prose-note, .question-opt { break-inside: avoid; }
  .card-grid { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
  .diff-grid { grid-template-columns: 1fr; }
  .diff-code, .term-pre { overflow: visible; }
  .diff-pane, .term-box { border-color: var(--tty-line); }
  .code-line, .term-line { white-space: pre-wrap; }
  .data-table tbody tr:hover { background: transparent; }
}
`

export const DOC_SCRIPT = `
(function () {
  'use strict';
  var doc = document, root = doc.documentElement;
  function $(id) { return doc.getElementById(id); }
  function all(sel, el) { return Array.prototype.slice.call((el || doc).querySelectorAll(sel)); }
  function parentDoc() {
    try { if (window.parent && window.parent !== window && window.parent.document) return window.parent.document; } catch (e) {}
    return null;
  }
  function motion() { return (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ? 'auto' : 'smooth'; }

  var cv = $('glyph-field'), mainEl = $('tabula-root');
  function paintParchment(ctx, W, Hh) {
    ctx.fillStyle = '#ece2cc'; ctx.fillRect(0, 0, W, Hh);
    [[0.18, 0.25, 0.55], [0.82, 0.62, 0.6], [0.5, 0.95, 0.45]].forEach(function (sp) {
      var g = ctx.createRadialGradient(W * sp[0], Hh * sp[1], 0, W * sp[0], Hh * sp[1], Math.max(W, Hh) * sp[2]);
      g.addColorStop(0, 'rgba(120, 95, 60, 0.04)'); g.addColorStop(1, 'rgba(120, 95, 60, 0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, Hh);
    });
    var n = Math.round(W * Hh / 900);
    ctx.lineWidth = 1;
    for (var i = 0; i < n; i++) {
      var h = Math.imul(i ^ 0x9e3779b9, 2654435761) >>> 0; h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
      var x = (h % 10007) / 10007 * W, y = ((h >>> 8) % 10009) / 10009 * Hh;
      var len = 4 + (h % 23), ang = ((h >>> 16) % 1000) / 1000 * 0.9 - 0.45 + ((h & 1) ? 1.5708 : 0);
      var a = 0.03 + ((h >>> 20) % 40) / 1000;
      ctx.strokeStyle = (h & 2) ? 'rgba(120, 95, 60, ' + a + ')' : 'rgba(255, 250, 240, ' + (a + 0.03) + ')';
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); ctx.stroke();
    }
  }
  function paintGlyphField() {
    if (!cv) return;
    var ctx = cv.getContext('2d', { alpha: false });
    if (!ctx) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = window.innerWidth, Hh = window.innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (root.getAttribute('data-theme') === 'light') { paintParchment(ctx, W, Hh); return; }
    ctx.fillStyle = '#090d16'; ctx.fillRect(0, 0, W, Hh);
    var grad = ctx.createRadialGradient(W * 0.5, -Hh * 0.1, 0, W * 0.5, -Hh * 0.1, Math.max(W, Hh) * 0.65);
    grad.addColorStop(0, 'rgba(164, 180, 218, 0.06)'); grad.addColorStop(1, 'rgba(164, 180, 218, 0)');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, Hh);
    var rect = mainEl ? mainEl.getBoundingClientRect() : { left: W * 0.15, right: W * 0.85 };
    var x0 = rect.left - 8, x1 = rect.right + 8, fade = 80;
    var cw = 11, ch = 20, cols = Math.ceil(W / cw), rows = Math.ceil(Hh / ch);
    var ramp = "     .'\`,:;_-~\\"^*+<>=!|/\\\\il1r?()[]{}tfcvxzjy2373aeonus456wmkhbdpq890AEOSCZJULXY#%&$MWNB@";
    ctx.font = '13px "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'alphabetic';
    for (var r = 0; r < rows; r++) {
      var py = r * ch + 14;
      for (var c = 0; c < cols; c++) {
        var px = c * cw;
        var dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
        var u = dx / fade;
        var mask = dx <= 0 ? 0 : dx >= fade ? 1 : u * u * (3 - 2 * u);
        if (mask < 0.08) continue;
        var h = (c * 73856093 ^ r * 19349663) >>> 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
        var v = ((h & 1023) / 1023) * mask;
        if (v < 0.18) continue;
        var g = ramp.charAt(Math.min(ramp.length - 1, Math.floor(v * ramp.length)));
        if (g === ' ') continue;
        ctx.fillStyle = v > 0.68 ? '#263147' : v > 0.42 ? '#1e2638' : '#161c29';
        ctx.fillText(g, px, py);
      }
    }
  }
  paintGlyphField();
  var resizeTimer = 0;
  window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(paintGlyphField, 80); }, { passive: true });

  var themeBtn = $('theme-toggle');
  function applySurface(light) {
    if (light) root.setAttribute('data-theme', 'light'); else root.removeAttribute('data-theme');
    if (themeBtn) { themeBtn.setAttribute('aria-pressed', light ? 'true' : 'false'); themeBtn.textContent = light ? 'Dark surface' : 'Parchment'; }
    paintGlyphField();
  }
  var saved = null;
  try { saved = localStorage.getItem('mercury-sample-surface'); } catch (e) {}
  if (saved === 'light') applySurface(true);
  if (themeBtn) themeBtn.addEventListener('click', function () {
    var light = root.getAttribute('data-theme') !== 'light';
    applySurface(light);
    try { localStorage.setItem('mercury-sample-surface', light ? 'light' : 'dark'); } catch (e) {}
  });

  var heads = all('.section-head'), outline = $('doc-outline');
  if (outline && heads.length >= 3) {
    heads.forEach(function (h) {
      var num = h.querySelector('.sec-num'), title = h.querySelector('.section-title');
      if (!title || !title.id) return;
      var a = doc.createElement('a'), n = doc.createElement('span');
      a.className = 'outline-link'; a.href = '#' + title.id;
      n.className = 'outline-num'; n.textContent = num ? num.textContent.replace(/\\.$/, '') : '';
      a.appendChild(n); a.appendChild(doc.createTextNode(title.textContent.trim()));
      outline.appendChild(a);
    });
    outline.hidden = false;
  }

  var verdict = $('part-1-verdict'), sticky = $('sticky-verdict');
  if (verdict && sticky && 'IntersectionObserver' in window) {
    var stamp = verdict.querySelector('.verdict-stamp'), summary = verdict.querySelector('.verdict-summary');
    var status = (verdict.className.match(/status-[a-z-]+/) || [''])[0];
    if (status) sticky.classList.add(status);
    $('sticky-stamp').textContent = stamp ? stamp.textContent.trim() : 'Verdict';
    $('sticky-summary').textContent = summary ? summary.textContent.trim() : '';
    var q = doc.querySelector('.part-question'), link = $('sticky-link');
    if (q && q.id && link) { link.href = '#' + q.id; link.hidden = false; }
    new IntersectionObserver(function (entries) {
      var e = entries[0];
      sticky.hidden = e.isIntersecting || e.boundingClientRect.top > 0;
    }, { threshold: 0 }).observe(verdict);
  }

  function linesText(el) {
    var lines = all('.code-line, .term-line', el);
    if (!lines.length) lines = [el];
    return lines.map(function (l) {
      var t = '';
      for (var n = l.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 1 && n.classList.contains('line-num')) continue;
        t += n.textContent;
      }
      return t;
    }).join('\\n');
  }
  function copyText(text) {
    var legacy = function () {
      return new Promise(function (ok, bad) {
        var ta = doc.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
        doc.body.appendChild(ta); ta.select();
        var done = false;
        try { done = doc.execCommand('copy'); } catch (e) {}
        ta.remove();
        if (done) ok(); else bad(new Error('the clipboard is not available here'));
      });
    };
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(legacy);
    return legacy();
  }
  all('[data-copy-target]').forEach(function (btn) {
    var label = btn.textContent;
    btn.addEventListener('click', function () {
      var src = $(btn.getAttribute('data-copy-target'));
      if (!src) return;
      copyText(linesText(src)).then(function () { btn.textContent = 'Copied'; }, function () { btn.textContent = 'Not copied'; });
      setTimeout(function () { btn.textContent = label; }, 1600);
    });
  });

  all('[data-diff-toggle]').forEach(function (btn) {
    var grid = $(btn.getAttribute('data-diff-toggle'));
    if (!grid) return;
    function setUnified(on) {
      grid.classList.toggle('unified', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.textContent = on ? 'Split view' : 'Unified view';
    }
    var longest = 0;
    all('.code-line', grid).forEach(function (l) { longest = Math.max(longest, linesText(l).length); });
    if (longest > 72) setUnified(true);
    btn.addEventListener('click', function () { setUnified(!grid.classList.contains('unified')); });
  });

  all('.term-pre').forEach(function (pre) {
    var n = all('.term-line', pre).length;
    if (n <= 30) return;
    pre.classList.add('folded');
    var b = doc.createElement('button');
    b.type = 'button'; b.className = 'btn-ghost term-more'; b.textContent = 'Show all ' + n + ' lines';
    b.addEventListener('click', function () { pre.classList.remove('folded'); b.remove(); });
    pre.parentNode.insertBefore(b, pre.nextSibling);
  });

  function syncDecisionToShell(heading, choice) {
    var line = 'Decision (' + heading + '): ' + choice;
    try {
      var pd = parentDoc();
      if (!pd) return false;
      var note = pd.getElementById('note'), shellStatus = pd.getElementById('status');
      if (!note) return false;
      var cur = String(note.value || '').trim(), re = /^Decision \\([^)]+\\): [^\\n]+/;
      note.value = re.test(cur) ? cur.replace(re, line) : (cur ? line + ' · ' + cur : line);
      if (shellStatus) shellStatus.textContent = 'decision staged in the note — s sends it';
      return true;
    } catch (e) { return false; }
  }
  all('.part-question').forEach(function (part) {
    var box = part.querySelector('.question-box');
    if (!box) return;
    var titleEl = part.querySelector('.section-title');
    var heading = (box.getAttribute('data-question') || (titleEl ? titleEl.textContent : '') || 'question').replace(/\\s+/g, ' ').trim();
    var opts = all('.question-opt', box), status = box.querySelector('.question-status'), copyBtn = box.querySelector('.question-copy');
    var chosen = '';
    function say(t) { if (status) status.textContent = t; }
    opts.forEach(function (opt) {
      opt.addEventListener('click', function () {
        var lab = opt.querySelector('.opt-label');
        chosen = opt.getAttribute('data-opt') || (lab ? lab.textContent : opt.textContent).replace(/\\s+/g, ' ').trim();
        opts.forEach(function (o) { o.setAttribute('aria-pressed', o === opt ? 'true' : 'false'); });
        if (syncDecisionToShell(heading, chosen)) say('Staged in the Note below the page — press s to send it to Mercury');
        else say('Chosen. Copy decision puts it on the clipboard');
      });
    });
    if (copyBtn) copyBtn.addEventListener('click', function () {
      if (!chosen) { say('Pick an option first'); return; }
      copyText('Decision (' + heading + '): ' + chosen).then(
        function () { say('Copied — paste it into the composer'); },
        function () { say('The clipboard is not available here'); });
    });
  });

  var FORWARD = { m: 1, s: 1, c: 1, '?': 1, ArrowLeft: 1, ArrowRight: 1 };
  doc.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (t && t.tagName === 'PRE' && e.key.indexOf('Arrow') === 0) return;
    if (e.key === 'j' || e.key === 'k') { window.scrollBy({ top: e.key === 'j' ? 120 : -120, behavior: motion() }); e.preventDefault(); return; }
    if (/^[1-9]$/.test(e.key)) {
      var h = heads[Number(e.key) - 1];
      if (h) { h.scrollIntoView({ block: 'start', behavior: motion() }); e.preventDefault(); }
      return;
    }
    if (FORWARD[e.key]) {
      var pd = parentDoc();
      if (!pd) return;
      pd.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, bubbles: true }));
      e.preventDefault();
    }
  });
})();
`

export const DOC_BRAND_MARK = '<svg class="brand-mark" viewBox="0 0 33 30" width="28" height="26" aria-hidden="true" shape-rendering="crispEdges"><path class="bm-bone" d="M0 0h6v1h-6zM1 1h10v1h-10zM17 1h6v1h-6zM4 2h10v1h-10zM16 2h9v1h-9zM2 3h3v1h-3zM7 3h8v1h-8zM16 3h1v1h-1zM23 3h3v1h-3zM2 4h7v1h-7zM11 4h5v1h-5zM25 4h2v1h-2zM3 5h9v1h-9zM14 5h2v1h-2zM26 5h1v1h-1zM3 6h3v1h-3zM9 6h4v1h-4zM14 6h2v1h-2zM3 7h7v1h-7zM12 7h1v1h-1zM14 7h2v1h-2zM5 8h7v1h-7zM14 8h1v1h-1zM28 8h5v1h-5zM6 9h1v1h-1zM9 9h4v1h-4zM26 9h4v1h-4zM6 10h5v1h-5zM12 10h2v1h-2zM25 10h4v1h-4zM7 11h6v1h-6zM22 11h3v1h-3zM27 11h3v1h-3zM21 12h1v1h-1zM28 12h2v1h-2zM9 13h2v1h-2zM18 13h3v1h-3zM29 13h1v1h-1zM11 14h2v1h-2zM15 14h4v1h-4zM23 14h2v1h-2zM28 14h1v1h-1zM10 15h2v1h-2zM14 15h3v1h-3zM22 15h3v1h-3zM26 15h1v1h-1zM28 15h2v1h-2zM9 16h2v1h-2zM13 16h2v1h-2zM19 16h1v1h-1zM22 16h8v1h-8zM8 17h2v1h-2zM13 17h1v1h-1zM22 17h8v1h-8zM7 18h2v1h-2zM11 18h3v1h-3zM17 18h1v1h-1zM19 18h12v1h-12zM9 19h6v1h-6zM18 19h10v1h-10zM10 20h1v1h-1zM13 20h2v1h-2zM19 20h10v1h-10zM12 21h3v1h-3zM20 21h7v1h-7zM10 22h5v1h-5zM21 22h7v1h-7zM13 23h1v1h-1zM22 23h6v1h-6zM12 24h2v1h-2zM18 24h1v1h-1zM24 24h4v1h-4zM12 25h2v1h-2zM18 25h2v1h-2zM26 25h2v1h-2zM11 26h2v1h-2zM17 26h3v1h-3zM18 27h3v1h-3zM20 28h2v1h-2zM21 29h1v1h-1z"/><path class="bm-shade" d="M20 12h1v1h-1zM22 12h1v1h-1zM26 12h2v1h-2zM25 13h2v1h-2zM25 14h1v1h-1zM29 14h1v1h-1zM17 15h1v1h-1zM25 15h1v1h-1zM15 16h1v1h-1zM18 16h1v1h-1zM20 16h1v1h-1zM14 17h1v1h-1zM21 17h1v1h-1zM30 17h1v1h-1zM14 18h1v1h-1zM16 18h1v1h-1zM31 18h1v1h-1zM17 19h1v1h-1zM28 19h3v1h-3zM15 20h1v1h-1zM27 21h2v1h-2zM28 22h1v1h-1zM14 23h1v1h-1zM17 23h1v1h-1zM17 24h1v1h-1zM23 24h1v1h-1zM28 24h1v1h-1zM20 26h1v1h-1zM19 28h1v1h-1zM22 29h1v1h-1z"/><path class="bm-wing" d="M26 6h6v1h-6zM24 7h5v1h-5zM21 8h4v1h-4zM19 9h3v1h-3zM18 10h3v1h-3zM16 11h2v1h-2zM14 12h3v1h-3zM13 13h2v1h-2z"/><path class="bm-wing-dim" d="M23 7h1v1h-1zM25 8h1v1h-1zM22 9h1v1h-1zM17 10h1v1h-1zM15 11h1v1h-1zM18 11h1v1h-1zM12 13h1v1h-1zM15 13h1v1h-1z"/></svg>'
