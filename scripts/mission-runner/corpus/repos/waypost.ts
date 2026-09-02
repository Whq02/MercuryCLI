// ============================================================================
//  corpus repo: waypost — the responsive web product pack
//  (family 24). A courier dispatch board: plain ES modules, no
//  build step, pure state/filter/render-to-string/keynav modules the browser
//  shell hydrates — so structure, semantics, honesty states and the v0.2
//  overdue clarification are all headless-gradable; the real-browser
//  geometry/interaction floor rides the lane as ADDITIONAL grader
//  components. WP1 rides main. This module is CANONICAL.
// ============================================================================
import type { FileMap, HelixRepoSpec } from '../contracts.js'

const FILES: FileMap = {
  '.gitignore': `node_modules/
.DS_Store
`,
  'README.md': "# waypost\n\nThe dispatch board for the Waypost courier network: stations, couriers,\nconsignments. Plain ES modules, no build step, no dependencies; the browser\nshell hydrates HTML produced by pure render functions, so everything that\nmatters is testable headless.\n\n```\nsrc/data.js         the deterministic seed + the day clock (injected, never Date.now)\nsrc/store.js        state container over an injected storage adapter\nsrc/filter.js       search/filter/sort \u2014 including the overdue sort-pin rule\nsrc/renderBoard.js  the board as an HTML string (columns, chips, states, aria)\nsrc/keynav.js       the pure keyboard model (focus movement + intents)\nsrc/app.js          the browser shell: store + filter + render + hydration\ntools/serve.mjs     static server (npm run serve -> http://localhost:8138)\n```\n\n## The board\n\nConsignments group into four columns by status \u2014 waiting \u00b7 moving \u00b7\ndelivered \u00b7 flagged. The filter bar narrows by free text (id, label,\ncourier), status and station. Keyboard: arrows walk the visible cards,\nEnter opens, Escape clears the filter.\n\n## The overdue clarification (v0.2 \u2014 arrived after the original spec)\n\nA consignment past its due day that is not delivered is OVERDUE: it pins to\nthe head of its column (most overdue first) and carries a distinct chip\nreading `overdue Nd`. This composes with \u2014 never replaces \u2014 the existing\nordering (due day, then id) for the rest.\n\n## States\n\nThe board renders honestly in every phase: a loading skeleton (aria-busy),\na per-column declared empty state, and an error panel (role=alert) with the\nfailure detail and a retry action. Labels are untrusted text: everything\ninterpolated into HTML is escaped.\n",
  'index.html': `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Waypost — dispatch board</title>
<style>
  :root { color-scheme: dark; --ink: #dce8de; --ground: #10161a; --card: #1a232a; --line: #2c3a44; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--ground); color: var(--ink); font: 14px/1.45 system-ui, sans-serif; }
  header { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 16px; border-bottom: 1px solid var(--line); align-items: center; }
  header h1 { font-size: 16px; margin: 0 12px 0 0; letter-spacing: 0.08em; }
  input, select { background: var(--card); color: var(--ink); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
  .board { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; padding: 16px; }
  .board section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px; min-height: 80px; }
  .board article { border: 1px solid var(--line); border-radius: 8px; padding: 8px; margin: 8px 0; }
  .board article.focused { outline: 2px solid #dd8844; }
  .chip { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 11px; margin-right: 6px; background: #24333d; }
  .chip-overdue { background: #5a2a24; }
  .empty { opacity: 0.6; font-style: italic; }
  .board-error { border: 1px solid #5a2a24; border-radius: 10px; margin: 16px; padding: 16px; }
</style>
</head>
<body>
<header>
  <h1>WAYPOST</h1>
  <input id="search" type="search" placeholder="search consignments" aria-label="search consignments">
  <select id="status-pick" aria-label="status filter">
    <option value="all">all statuses</option>
    <option value="waiting">waiting</option>
    <option value="moving">moving</option>
    <option value="delivered">delivered</option>
    <option value="flagged">flagged</option>
  </select>
  <select id="station-pick" aria-label="station filter">
    <option value="all">all stations</option>
    <option value="st-hollow">Hollowmere</option>
    <option value="st-bray">Braycliff</option>
    <option value="st-fenn">Fennick Cross</option>
  </select>
</header>
<main id="board-root" aria-live="polite"></main>
<script type="module" src="./src/app.js"></script>
</body>
</html>
`,
  'package.json': `{
  "name": "waypost",
  "version": "0.2.0",
  "type": "module",
  "description": "The Waypost dispatch board: stations, couriers, consignments. Zero dependencies, no build step.",
  "scripts": {
    "test": "node --test",
    "serve": "node tools/serve.mjs"
  }
}
`,
  'src/app.js': `// The browser shell: store + filter + render + hydration. GIVEN — all the
// interesting behaviour lives in the pure modules it wires together.
import { STATUSES, courierName } from './data.js'
import { loadState, saveState } from './store.js'
import { filterConsignments } from './filter.js'
import { renderBoard } from './renderBoard.js'
import { createNav, navReduce } from './keynav.js'

const root = document.getElementById('board-root')
const searchBox = document.getElementById('search')
const statusPick = document.getElementById('status-pick')
const stationPick = document.getElementById('station-pick')

const state = loadState(window.localStorage)
let nav = createNav()
let visibleIds = []

function model(phase, errorDetail) {
  const columns = STATUSES.map(status => {
    const inColumn = state.consignments.filter(c => c.status === status)
    const { pinned, rest } = filterConsignments(inColumn, { ...state.filter, today: state.today })
    return { status, pinned, rest }
  })
  visibleIds = columns.flatMap(col => [...col.pinned, ...col.rest].map(c => c.id))
  return { phase: phase ?? 'ready', errorDetail: errorDetail ?? '', columns, today: state.today, filter: state.filter }
}

function paint(phase, errorDetail) {
  try {
    root.innerHTML = renderBoard(model(phase, errorDetail))
  } catch (error) {
    root.innerHTML = renderBoard({ phase: 'error', errorDetail: String(error), columns: [], today: state.today, filter: state.filter })
  }
  const focused = visibleIds[nav.index]
  for (const card of root.querySelectorAll('[data-cid]')) {
    card.classList.toggle('focused', card.dataset.cid === focused)
  }
}

searchBox.addEventListener('input', () => {
  state.filter.text = searchBox.value
  saveState(window.localStorage, state)
  paint()
})
statusPick.addEventListener('change', () => {
  state.filter.status = statusPick.value
  saveState(window.localStorage, state)
  paint()
})
stationPick.addEventListener('change', () => {
  state.filter.station = stationPick.value
  saveState(window.localStorage, state)
  paint()
})

window.addEventListener('keydown', event => {
  if (event.target === searchBox && event.key !== 'Escape') return
  const { nav: next, intent } = navReduce(nav, event.key, visibleIds.length)
  nav = next
  if (intent && intent.type === 'clear-filter') {
    state.filter = { text: '', status: 'all', station: 'all' }
    searchBox.value = ''
    statusPick.value = 'all'
    stationPick.value = 'all'
    saveState(window.localStorage, state)
  }
  if (intent && intent.type === 'open') {
    const id = visibleIds[intent.index]
    const consignment = state.consignments.find(c => c.id === id)
    if (consignment) {
      window.alert(consignment.id + ' — ' + consignment.label + ' · ' + courierName(consignment.courier))
    }
  }
  paint()
})

// Expose a read-only probe for external checks and curious dispatchers.
window.__waypost = {
  state: () => JSON.parse(JSON.stringify(state)),
  visible: () => [...visibleIds],
}

paint('loading')
setTimeout(() => paint(), 30)
`,
  'src/data.js': `// The deterministic seed. The day clock is a NUMBER passed around
// explicitly — nothing in src/ reads Date.now (the board must render the
// same bytes for the same inputs on any machine).
export const TODAY = 118

export const STATIONS = [
  { id: 'st-hollow', name: 'Hollowmere' },
  { id: 'st-bray', name: 'Braycliff' },
  { id: 'st-fenn', name: 'Fennick Cross' },
]

export const COURIERS = [
  { id: 'c-ash', name: 'Ash Trelawny' },
  { id: 'c-ivo', name: 'Ivo Marsh' },
  { id: 'c-una', name: 'Una Voss' },
]

export const STATUSES = ['waiting', 'moving', 'delivered', 'flagged']

export const CONSIGNMENTS = [
  { id: 'w-1001', label: 'Beacon lenses (crated)', station: 'st-hollow', courier: 'c-ash', status: 'waiting', dueDay: 121 },
  { id: 'w-1002', label: 'Peat samples <batch 4>', station: 'st-fenn', courier: 'c-ivo', status: 'waiting', dueDay: 115 },
  { id: 'w-1003', label: 'Rope & tackle', station: 'st-bray', courier: 'c-una', status: 'moving', dueDay: 119 },
  { id: 'w-1004', label: 'Signal flags', station: 'st-hollow', courier: 'c-ivo', status: 'moving', dueDay: 112 },
  { id: 'w-1005', label: 'Medical resupply', station: 'st-fenn', courier: 'c-ash', status: 'delivered', dueDay: 110 },
  { id: 'w-1006', label: 'Winter stores manifest', station: 'st-bray', courier: 'c-ivo', status: 'flagged', dueDay: 116 },
  { id: 'w-1007', label: 'Lamp oil (drums)', station: 'st-hollow', courier: 'c-una', status: 'waiting', dueDay: 118 },
  { id: 'w-1008', label: 'Chart corrections', station: 'st-fenn', courier: 'c-una', status: 'moving', dueDay: 125 },
]

export function courierName(courierId) {
  const courier = COURIERS.find(c => c.id === courierId)
  return courier ? courier.name : courierId
}
`,
  'src/filter.js': `// Search, filter and ordering — including the v0.2 overdue clarification.
//
// MISSION SEAM (task/w1). The contract the tests pin:
//   - isOverdue(consignment, today): dueDay < today AND status is not
//     'delivered';
//   - filterConsignments(consignments, { text, status, station, today })
//     returns { pinned, rest }:
//       text     case-insensitive substring over id, label and the courier's
//                display name (courierName from data.js); empty matches all;
//       status   'all' or one of STATUSES — exact match;
//       station  'all' or a station id — exact match;
//       pinned   the OVERDUE survivors, most overdue first (largest
//                today-dueDay), ties by id ascending;
//       rest     the remaining survivors, dueDay ascending, ties by id
//                ascending;
//   - pure: the input array and its items are never mutated.
export function isOverdue(consignment, today) {
  // TODO(task/w1): implement per the contract above.
  void consignment
  void today
  throw new Error('not implemented: isOverdue')
}

export function filterConsignments(consignments, options) {
  // TODO(task/w1): implement per the contract above.
  void consignments
  void options
  throw new Error('not implemented: filterConsignments')
}
`,
  'src/keynav.js': `// The pure keyboard model over the VISIBLE (filtered) cards.
//
// MISSION SEAM (task/w1). The contract the tests pin:
//   - createNav() -> { index: -1 } (nothing focused);
//   - navReduce(nav, key, count) -> { nav, intent }:
//       ArrowDown  index + 1, CLAMPED to count - 1 (no wraparound);
//                  from -1 it focuses 0;
//       ArrowUp    index - 1, clamped to 0; from -1 it stays -1;
//       Home/End   0 / count - 1 (count 0 keeps -1);
//       Enter      intent { type: 'open', index } when index >= 0, else
//                  no intent;
//       Escape     intent { type: 'clear-filter' } and index resets to -1;
//       any other  unchanged, no intent;
//   - count 0 clamps every movement back to -1;
//   - pure: the incoming nav object is never mutated.
export function createNav() {
  // TODO(task/w1): implement per the contract above.
  throw new Error('not implemented: createNav')
}

export function navReduce(nav, key, count) {
  // TODO(task/w1): implement per the contract above.
  void nav
  void key
  void count
  throw new Error('not implemented: navReduce')
}
`,
  'src/renderBoard.js': `// The board as an HTML string — pure functions the browser shell hydrates,
// so structure, semantics and honesty are all testable headless.
//
// MISSION SEAM (task/w1). The contract the tests pin:
//   - renderBoard(model) where model = { phase, errorDetail, columns, today,
//     filter }; columns = [{ status, pinned, rest }] (one per STATUSES entry,
//     already filtered/ordered by src/filter.js);
//   - phase 'loading': one <div class="board board-loading" aria-busy="true">
//     skeleton — no consignment content;
//   - phase 'error': one <div class="board board-error" role="alert">
//     containing the escaped errorDetail and a
//     <button data-action="retry">retry</button>;
//   - phase 'ready': a <div class="board"> of four
//     <section role="list" aria-label="<Status> (<count>)"> columns (count =
//     pinned+rest), each item an
//     <article role="listitem" data-cid="<id>" aria-label="<id> <label>">:
//       · a status chip <span class="chip chip-<status>"><status></span>
//       · an OVERDUE item additionally carries
//         <span class="chip chip-overdue">overdue <N>d</span> where N =
//         today - dueDay (pinned items come first — the filter's order is
//         preserved, never re-sorted here);
//       · the label and courier name render ESCAPED (labels are untrusted);
//   - an empty column renders <p class="empty">nothing <status></p> instead
//     of a blank body;
//   - escapeHtml(text) is exported and escapes & < > " '.
export function escapeHtml(text) {
  // TODO(task/w1): implement per the contract above.
  void text
  throw new Error('not implemented: escapeHtml')
}

export function renderBoard(model) {
  // TODO(task/w1): implement per the contract above.
  void model
  throw new Error('not implemented: renderBoard')
}
`,
  'src/store.js': `// The state container. Storage is INJECTED (the browser shell passes
// localStorage; tests pass a plain object adapter) — src/ never touches a
// global store directly.
import { CONSIGNMENTS, TODAY } from './data.js'

const KEY = 'waypost:v1'

export function memoryStorage() {
  const bag = new Map()
  return {
    getItem: key => (bag.has(key) ? bag.get(key) : null),
    setItem: (key, value) => void bag.set(key, String(value)),
    removeItem: key => void bag.delete(key),
  }
}

export function loadState(storage) {
  const raw = storage.getItem(KEY)
  if (raw === null) {
    const fresh = {
      consignments: CONSIGNMENTS.map(c => ({ ...c })),
      filter: { text: '', status: 'all', station: 'all' },
      today: TODAY,
    }
    storage.setItem(KEY, JSON.stringify(fresh))
    return fresh
  }
  return JSON.parse(raw)
}

export function saveState(storage, state) {
  storage.setItem(KEY, JSON.stringify(state))
}

export function resetState(storage) {
  storage.removeItem(KEY)
  return loadState(storage)
}
`,
  'test/filter.test.mjs': `// The filter contract (src/filter.js mission seam).
import test from 'node:test'
import assert from 'node:assert/strict'
import { filterConsignments, isOverdue } from '../src/filter.js'
import { CONSIGNMENTS, TODAY } from '../src/data.js'

const all = () => CONSIGNMENTS.map(c => ({ ...c }))
const base = { text: '', status: 'all', station: 'all', today: TODAY }

test('isOverdue: past due and not delivered', () => {
  assert.equal(isOverdue({ status: 'waiting', dueDay: TODAY - 1 }, TODAY), true)
  assert.equal(isOverdue({ status: 'waiting', dueDay: TODAY }, TODAY), false)
  assert.equal(isOverdue({ status: 'delivered', dueDay: TODAY - 10 }, TODAY), false)
})

test('text search covers id, label and courier display name', () => {
  const byId = filterConsignments(all(), { ...base, text: 'w-1003' })
  assert.deepEqual([...byId.pinned, ...byId.rest].map(c => c.id), ['w-1003'])
  const byLabel = filterConsignments(all(), { ...base, text: 'peat SAMPLES' })
  assert.deepEqual([...byLabel.pinned, ...byLabel.rest].map(c => c.id), ['w-1002'])
  const byCourier = filterConsignments(all(), { ...base, text: 'trelawny' })
  assert.deepEqual(
    [...byCourier.pinned, ...byCourier.rest].map(c => c.id).sort(),
    ['w-1001', 'w-1005'],
  )
})

test('status and station filters are exact', () => {
  const moving = filterConsignments(all(), { ...base, status: 'moving' })
  assert.deepEqual([...moving.pinned, ...moving.rest].map(c => c.status), ['moving', 'moving', 'moving'])
  const fenn = filterConsignments(all(), { ...base, station: 'st-fenn' })
  assert.ok([...fenn.pinned, ...fenn.rest].every(c => c.station === 'st-fenn'))
})

test('the overdue clarification: pinned head, most overdue first', () => {
  const { pinned, rest } = filterConsignments(all(), base)
  // At day 118: w-1004 (due 112, 6d), w-1002 (due 115, 3d), w-1006 (due 116,
  // 2d) are overdue; w-1005 is past due but delivered; w-1007 is due TODAY.
  assert.deepEqual(pinned.map(c => c.id), ['w-1004', 'w-1002', 'w-1006'])
  assert.deepEqual(rest.map(c => c.id), ['w-1005', 'w-1007', 'w-1003', 'w-1001', 'w-1008'])
})

test('overdue ties order by id; rest orders by dueDay then id', () => {
  const items = [
    { id: 'b', label: '', station: 's', courier: 'c-ash', status: 'waiting', dueDay: 100 },
    { id: 'a', label: '', station: 's', courier: 'c-ash', status: 'waiting', dueDay: 100 },
    { id: 'd', label: '', station: 's', courier: 'c-ash', status: 'waiting', dueDay: 200 },
    { id: 'c', label: '', station: 's', courier: 'c-ash', status: 'waiting', dueDay: 200 },
  ]
  const { pinned, rest } = filterConsignments(items, { ...base, today: 150 })
  assert.deepEqual(pinned.map(c => c.id), ['a', 'b'])
  assert.deepEqual(rest.map(c => c.id), ['c', 'd'])
})

test('purity: inputs are never mutated', () => {
  const input = all()
  const snapshot = JSON.stringify(input)
  filterConsignments(input, { ...base, text: 'rope' })
  assert.equal(JSON.stringify(input), snapshot)
})
`,
  'test/keynav.test.mjs': `// The keyboard model (src/keynav.js mission seam) — pure, clamped, intent-
// bearing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createNav, navReduce } from '../src/keynav.js'

test('fresh nav focuses nothing', () => {
  assert.deepEqual(createNav(), { index: -1 })
})

test('arrows clamp — no wraparound', () => {
  let nav = createNav()
  ;({ nav } = navReduce(nav, 'ArrowDown', 3))
  assert.equal(nav.index, 0)
  ;({ nav } = navReduce(nav, 'ArrowDown', 3))
  ;({ nav } = navReduce(nav, 'ArrowDown', 3))
  ;({ nav } = navReduce(nav, 'ArrowDown', 3))
  assert.equal(nav.index, 2, 'ArrowDown clamps at the last card')
  ;({ nav } = navReduce(nav, 'ArrowUp', 3))
  ;({ nav } = navReduce(nav, 'ArrowUp', 3))
  ;({ nav } = navReduce(nav, 'ArrowUp', 3))
  assert.equal(nav.index, 0, 'ArrowUp clamps at the first card')
})

test('Home and End jump; an empty board keeps -1', () => {
  let nav = createNav()
  ;({ nav } = navReduce(nav, 'End', 5))
  assert.equal(nav.index, 4)
  ;({ nav } = navReduce(nav, 'Home', 5))
  assert.equal(nav.index, 0)
  let empty = createNav()
  ;({ nav: empty } = navReduce(empty, 'ArrowDown', 0))
  assert.equal(empty.index, -1)
  ;({ nav: empty } = navReduce(empty, 'End', 0))
  assert.equal(empty.index, -1)
})

test('Enter opens the focused card; unfocused Enter is silent', () => {
  let nav = createNav()
  const silent = navReduce(nav, 'Enter', 3)
  assert.equal(silent.intent, undefined)
  ;({ nav } = navReduce(nav, 'ArrowDown', 3))
  const open = navReduce(nav, 'Enter', 3)
  assert.deepEqual(open.intent, { type: 'open', index: 0 })
})

test('Escape clears the filter and drops focus', () => {
  let nav = createNav()
  ;({ nav } = navReduce(nav, 'ArrowDown', 3))
  const cleared = navReduce(nav, 'Escape', 3)
  assert.deepEqual(cleared.intent, { type: 'clear-filter' })
  assert.equal(cleared.nav.index, -1)
})

test('unknown keys change nothing; the incoming nav is never mutated', () => {
  const nav = createNav()
  const frozen = JSON.stringify(nav)
  const result = navReduce(nav, 'x', 3)
  assert.equal(result.intent, undefined)
  assert.equal(JSON.stringify(nav), frozen)
})
`,
  'test/render.test.mjs': "// The render contract (src/renderBoard.js mission seam) \u2014 structure and\n// honesty, headless.\nimport test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { escapeHtml, renderBoard } from '../src/renderBoard.js'\n\nconst column = (status, pinned = [], rest = []) => ({ status, pinned, rest })\nconst card = (id, label, status, dueDay, courier = 'c-ash') => ({ id, label, station: 'st-hollow', courier, status, dueDay })\n\nconst READY = {\n  phase: 'ready',\n  errorDetail: '',\n  today: 118,\n  filter: { text: '', status: 'all', station: 'all' },\n  columns: [\n    column('waiting', [card('w-9002', 'Peat samples', 'waiting', 115)], [card('w-9001', 'Beacon lenses', 'waiting', 121)]),\n    column('moving', [], []),\n    column('delivered', [], [card('w-9005', 'Medical resupply', 'delivered', 110)]),\n    column('flagged', [], []),\n  ],\n}\n\ntest('loading renders an aria-busy skeleton with no content', () => {\n  const html = renderBoard({ ...READY, phase: 'loading' })\n  assert.match(html, /class=\"board board-loading\"/)\n  assert.match(html, /aria-busy=\"true\"/)\n  assert.doesNotMatch(html, /w-9002/)\n})\n\ntest('error renders role=alert with the escaped detail and a retry action', () => {\n  const html = renderBoard({ ...READY, phase: 'error', errorDetail: 'seed <corrupt>' })\n  assert.match(html, /role=\"alert\"/)\n  assert.match(html, /seed &lt;corrupt&gt;/)\n  assert.match(html, /<button data-action=\"retry\">retry<\\/button>/)\n})\n\ntest('ready renders four labelled list columns with counts', () => {\n  const html = renderBoard(READY)\n  assert.match(html, /<section role=\"list\" aria-label=\"Waiting \\(2\\)\"/)\n  assert.match(html, /<section role=\"list\" aria-label=\"Moving \\(0\\)\"/)\n  assert.match(html, /<section role=\"list\" aria-label=\"Delivered \\(1\\)\"/)\n  assert.match(html, /<section role=\"list\" aria-label=\"Flagged \\(0\\)\"/)\n})\n\ntest('cards carry listitem semantics, ids, chips \u2014 pinned first', () => {\n  const html = renderBoard(READY)\n  const first = html.indexOf('data-cid=\"w-9002\"')\n  const second = html.indexOf('data-cid=\"w-9001\"')\n  assert.ok(first >= 0 && second > first, 'the pinned overdue card renders before the rest')\n  assert.match(html, /<article role=\"listitem\" data-cid=\"w-9002\" aria-label=\"w-9002 Peat samples\"/)\n  assert.match(html, /class=\"chip chip-waiting\"/)\n  assert.match(html, /class=\"chip chip-overdue\">overdue 3d</)\n  // The delivered card is past due but NOT overdue.\n  const delivered = html.slice(html.indexOf('data-cid=\"w-9005\"'))\n  assert.doesNotMatch(delivered.slice(0, 300), /chip-overdue/)\n})\n\ntest('empty columns declare themselves', () => {\n  const html = renderBoard(READY)\n  assert.match(html, /<p class=\"empty\">nothing moving<\\/p>/)\n  assert.match(html, /<p class=\"empty\">nothing flagged<\\/p>/)\n})\n\ntest('labels and courier names are untrusted: everything escapes', () => {\n  const hostile = {\n    ...READY,\n    columns: [\n      column('waiting', [], [card('w-6666', '<script>alert(1)</script> & \"quotes\"', 'waiting', 121)]),\n      column('moving', [], []),\n      column('delivered', [], []),\n      column('flagged', [], []),\n    ],\n  }\n  const html = renderBoard(hostile)\n  assert.doesNotMatch(html, /<script>alert/)\n  assert.match(html, /&lt;script&gt;alert\\(1\\)&lt;\\/script&gt; &amp; &quot;quotes&quot;/)\n})\n\ntest('escapeHtml covers the five metacharacters', () => {\n  assert.equal(escapeHtml(`&<>\"'`), '&amp;&lt;&gt;&quot;&#39;')\n})\n",
  'test/store.test.mjs': `// The given seed + store — green from the start.
import test from 'node:test'
import assert from 'node:assert/strict'
import { CONSIGNMENTS, STATIONS, STATUSES, courierName } from '../src/data.js'
import { loadState, memoryStorage, resetState, saveState } from '../src/store.js'

test('the seed is well-formed', () => {
  assert.equal(STATIONS.length, 3)
  assert.equal(CONSIGNMENTS.length, 8)
  for (const c of CONSIGNMENTS) {
    assert.ok(STATUSES.includes(c.status), c.id)
    assert.ok(Number.isInteger(c.dueDay), c.id)
  }
  assert.equal(courierName('c-ash'), 'Ash Trelawny')
})

test('the store loads a fresh seed, persists edits, resets clean', () => {
  const storage = memoryStorage()
  const state = loadState(storage)
  assert.equal(state.consignments.length, 8)
  state.filter.text = 'rope'
  saveState(storage, state)
  assert.equal(loadState(storage).filter.text, 'rope')
  assert.equal(resetState(storage).filter.text, '')
})
`,
  'tools/serve.mjs': `#!/usr/bin/env node
// Tiny static server — zero dependencies, no caching, module-friendly types.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const PORT = Number(process.env.PORT ?? 8138)
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
}

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]))
  const file = join(ROOT, path === '/' ? 'index.html' : path.slice(1))
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end()
    return
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(PORT, () => {
  console.log('waypost: http://localhost:' + PORT)
})
`,}

export const WAYPOST_REPO: HelixRepoSpec = {
  id: 'waypost',
  seed: 'inline',
  files: FILES,
  branches: {},
}

/** WP1 reference: the three seams implemented per the pinned contracts. */
export const WAYPOST_W1_REFERENCE: FileMap = {
  'src/filter.js': `// Search, filter and ordering — including the v0.2 overdue clarification.
// See test/filter.test.mjs for the pinned contract.
import { courierName } from './data.js'

export function isOverdue(consignment, today) {
  return consignment.dueDay < today && consignment.status !== 'delivered'
}

export function filterConsignments(consignments, options) {
  const { text, status, station, today } = options
  const needle = (text ?? '').trim().toLowerCase()
  const survivors = consignments.filter(c => {
    if (status && status !== 'all' && c.status !== status) return false
    if (station && station !== 'all' && c.station !== station) return false
    if (needle) {
      const haystack = (c.id + ' ' + c.label + ' ' + courierName(c.courier)).toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
  const pinned = survivors
    .filter(c => isOverdue(c, today))
    .sort((a, b) => (b.dueDay === a.dueDay ? (a.id < b.id ? -1 : 1) : a.dueDay - b.dueDay))
  const rest = survivors
    .filter(c => !isOverdue(c, today))
    .sort((a, b) => (a.dueDay === b.dueDay ? (a.id < b.id ? -1 : 1) : a.dueDay - b.dueDay))
  return { pinned, rest }
}
`,
  'src/renderBoard.js': `// The board as an HTML string — pure functions the browser shell hydrates.
// See test/render.test.mjs for the pinned contract.
import { courierName } from './data.js'
import { isOverdue } from './filter.js'

export function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderCard(consignment, today) {
  const overdue = isOverdue(consignment, today)
  const chips = ['<span class="chip chip-' + consignment.status + '">' + consignment.status + '</span>']
  if (overdue) {
    chips.push('<span class="chip chip-overdue">overdue ' + String(today - consignment.dueDay) + 'd</span>')
  }
  return (
    '<article role="listitem" data-cid="' +
    escapeHtml(consignment.id) +
    '" aria-label="' +
    escapeHtml(consignment.id + ' ' + consignment.label) +
    '">' +
    chips.join('') +
    '<h3>' +
    escapeHtml(consignment.label) +
    '</h3><p>' +
    escapeHtml(courierName(consignment.courier)) +
    ' · due day ' +
    String(consignment.dueDay) +
    '</p></article>'
  )
}

function renderColumn(column, today) {
  const items = [...column.pinned, ...column.rest]
  const title = column.status.charAt(0).toUpperCase() + column.status.slice(1)
  const body =
    items.length === 0
      ? '<p class="empty">nothing ' + column.status + '</p>'
      : items.map(item => renderCard(item, today)).join('')
  return (
    '<section role="list" aria-label="' + title + ' (' + String(items.length) + ')"><h2>' +
    title +
    '</h2>' +
    body +
    '</section>'
  )
}

export function renderBoard(model) {
  if (model.phase === 'loading') {
    return '<div class="board board-loading" aria-busy="true"><p>fetching the board…</p></div>'
  }
  if (model.phase === 'error') {
    return (
      '<div class="board board-error" role="alert"><p>the board failed to load: ' +
      escapeHtml(model.errorDetail) +
      '</p><button data-action="retry">retry</button></div>'
    )
  }
  return '<div class="board">' + model.columns.map(column => renderColumn(column, model.today)).join('') + '</div>'
}
`,
  'src/keynav.js': `// The pure keyboard model over the visible cards. See test/keynav.test.mjs
// for the pinned contract.
export function createNav() {
  return { index: -1 }
}

export function navReduce(nav, key, count) {
  const clamp = index => (count <= 0 ? -1 : Math.max(0, Math.min(count - 1, index)))
  switch (key) {
    case 'ArrowDown':
      return { nav: { index: clamp(nav.index + 1) } }
    case 'ArrowUp':
      return { nav: { index: nav.index <= 0 ? (nav.index === -1 ? -1 : 0) : clamp(nav.index - 1) } }
    case 'Home':
      return { nav: { index: clamp(0) } }
    case 'End':
      return { nav: { index: clamp(count - 1) } }
    case 'Enter':
      if (nav.index >= 0) return { nav: { ...nav }, intent: { type: 'open', index: nav.index } }
      return { nav: { ...nav } }
    case 'Escape':
      return { nav: { index: -1 }, intent: { type: 'clear-filter' } }
    default:
      return { nav: { ...nav } }
  }
}
`,}

/** WP1 falsify variants: pretty-but-dead filtering, the clarification done
 *  visually but not behaviourally, unescaped untrusted labels, blank empty
 *  states, wraparound keynav, the silenced suite. */
export const WAYPOST_W1_FALSIFY: Array<{ name: string; files: FileMap }> = [
  {
    name: 'pretty-but-dead',
    files: {
      'src/filter.js': `// Search, filter and ordering — including the v0.2 overdue clarification.
// See test/filter.test.mjs for the pinned contract.
import { courierName } from './data.js'

export function isOverdue(consignment, today) {
  return consignment.dueDay < today && consignment.status !== 'delivered'
}

export function filterConsignments(consignments, options) {
  const { text, status, station, today } = options
  const needle = (text ?? '').trim().toLowerCase()
  const survivors = consignments.filter(c => {
    if (station && station !== 'all' && c.station !== station) return false
    if (needle) {
      const haystack = (c.id + ' ' + c.label + ' ' + courierName(c.courier)).toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
  const pinned = survivors
    .filter(c => isOverdue(c, today))
    .sort((a, b) => (b.dueDay === a.dueDay ? (a.id < b.id ? -1 : 1) : a.dueDay - b.dueDay))
  const rest = survivors
    .filter(c => !isOverdue(c, today))
    .sort((a, b) => (a.dueDay === b.dueDay ? (a.id < b.id ? -1 : 1) : a.dueDay - b.dueDay))
  return { pinned, rest }
}
`,
      'src/renderBoard.js': `// The board as an HTML string — pure functions the browser shell hydrates.
// See test/render.test.mjs for the pinned contract.
import { courierName } from './data.js'
import { isOverdue } from './filter.js'

export function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderCard(consignment, today) {
  const overdue = isOverdue(consignment, today)
  const chips = ['<span class="chip chip-' + consignment.status + '">' + consignment.status + '</span>']
  if (overdue) {
    chips.push('<span class="chip chip-overdue">overdue ' + String(today - consignment.dueDay) + 'd</span>')
  }
  return (
    '<article role="listitem" data-cid="' +
    escapeHtml(consignment.id) +
    '" aria-label="' +
    escapeHtml(consignment.id + ' ' + consignment.label) +
    '">' +
    chips.join('') +
    '<h3>' +
    escapeHtml(consignment.label) +
    '</h3><p>' +
    escapeHtml(courierName(consignment.courier)) +
    ' · due day ' +
    String(consignment.dueDay) +
    '</p></article>'
  )
}

function renderColumn(column, today) {
  const items = [...column.pinned, ...column.rest]
  const title = column.status.charAt(0).toUpperCase() + column.status.slice(1)
  const body =
    items.length === 0
      ? '<p class="empty">nothing ' + column.status + '</p>'
      : items.map(item => renderCard(item, today)).join('')
  return (
    '<section role="list" aria-label="' + title + ' (' + String(items.length) + ')"><h2>' +
    title +
    '</h2>' +
    body +
    '</section>'
  )
}

export function renderBoard(model) {
  if (model.phase === 'loading') {
    return '<div class="board board-loading" aria-busy="true"><p>fetching the board…</p></div>'
  }
  if (model.phase === 'error') {
    return (
      '<div class="board board-error" role="alert"><p>the board failed to load: ' +
      escapeHtml(model.errorDetail) +
      '</p><button data-action="retry">retry</button></div>'
    )
  }
  return '<div class="board">' + model.columns.map(column => renderColumn(column, model.today)).join('') + '</div>'
}
`,
      'src/keynav.js': `// The pure keyboard model over the visible cards. See test/keynav.test.mjs
// for the pinned contract.
export function createNav() {
  return { index: -1 }
}

export function navReduce(nav, key, count) {
  const clamp = index => (count <= 0 ? -1 : Math.max(0, Math.min(count - 1, index)))
  switch (key) {
    case 'ArrowDown':
      return { nav: { index: clamp(nav.index + 1) } }
    case 'ArrowUp':
      return { nav: { index: nav.index <= 0 ? (nav.index === -1 ? -1 : 0) : clamp(nav.index - 1) } }
    case 'Home':
      return { nav: { index: clamp(0) } }
    case 'End':
      return { nav: { index: clamp(count - 1) } }
    case 'Enter':
      if (nav.index >= 0) return { nav: { ...nav }, intent: { type: 'open', index: nav.index } }
      return { nav: { ...nav } }
    case 'Escape':
      return { nav: { index: -1 }, intent: { type: 'clear-filter' } }
    default:
      return { nav: { ...nav } }
  }
}
`,
    },
  },
  {
    name: 'pin-visual-only',
    files: {
      'src/filter.js': `// Search, filter and ordering — including the v0.2 overdue clarification.
// See test/filter.test.mjs for the pinned contract. (chips still mark
// overdue items; pinning felt redundant visually)
import { courierName } from './data.js'

export function isOverdue(consignment, today) {
  return consignment.dueDay < today && consignment.status !== 'delivered'
}

export function filterConsignments(consignments, options) {
  const { text, status, station, today } = options
  const needle = (text ?? '').trim().toLowerCase()
  const survivors = consignments.filter(c => {
    if (status && status !== 'all' && c.status !== status) return false
    if (station && station !== 'all' && c.station !== station) return false
    if (needle) {
      const haystack = (c.id + ' ' + c.label + ' ' + courierName(c.courier)).toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
  const rest = survivors
    .sort((a, b) => (a.dueDay === b.dueDay ? (a.id < b.id ? -1 : 1) : a.dueDay - b.dueDay))
  return { pinned: [], rest }
}
`,
      'src/renderBoard.js': `// The board as an HTML string — pure functions the browser shell hydrates.
// See test/render.test.mjs for the pinned contract.
import { courierName } from './data.js'
import { isOverdue } from './filter.js'

export function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderCard(consignment, today) {
  const overdue = isOverdue(consignment, today)
  const chips = ['<span class="chip chip-' + consignment.status + '">' + consignment.status + '</span>']
  if (overdue) {
    chips.push('<span class="chip chip-overdue">overdue ' + String(today - consignment.dueDay) + 'd</span>')
  }
  return (
    '<article role="listitem" data-cid="' +
    escapeHtml(consignment.id) +
    '" aria-label="' +
    escapeHtml(consignment.id + ' ' + consignment.label) +
    '">' +
    chips.join('') +
    '<h3>' +
    escapeHtml(consignment.label) +
    '</h3><p>' +
    escapeHtml(courierName(consignment.courier)) +
    ' · due day ' +
    String(consignment.dueDay) +
    '</p></article>'
  )
}

function renderColumn(column, today) {
  const items = [...column.pinned, ...column.rest]
  const title = column.status.charAt(0).toUpperCase() + column.status.slice(1)
  const body =
    items.length === 0
      ? '<p class="empty">nothing ' + column.status + '</p>'
      : items.map(item => renderCard(item, today)).join('')
  return (
    '<section role="list" aria-label="' + title + ' (' + String(items.length) + ')"><h2>' +
    title +
    '</h2>' +
    body +
    '</section>'
  )
}

export function renderBoard(model) {
  if (model.phase === 'loading') {
    return '<div class="board board-loading" aria-busy="true"><p>fetching the board…</p></div>'
  }
  if (model.phase === 'error') {
    return (
      '<div class="board board-error" role="alert"><p>the board failed to load: ' +
      escapeHtml(model.errorDetail) +
      '</p><button data-action="retry">retry</button></div>'
    )
  }
  return '<div class="board">' + model.columns.map(column => renderColumn(column, model.today)).join('') + '</div>'
}
`,
      'src/keynav.js': `// The pure keyboard model over the visible cards. See test/keynav.test.mjs
// for the pinned contract.
export function createNav() {
  return { index: -1 }
}

export function navReduce(nav, key, count) {
  const clamp = index => (count <= 0 ? -1 : Math.max(0, Math.min(count - 1, index)))
  switch (key) {
    case 'ArrowDown':
      return { nav: { index: clamp(nav.index + 1) } }
    case 'ArrowUp':
      return { nav: { index: nav.index <= 0 ? (nav.index === -1 ? -1 : 0) : clamp(nav.index - 1) } }
    case 'Home':
      return { nav: { index: clamp(0) } }
    case 'End':
      return { nav: { index: clamp(count - 1) } }
    case 'Enter':
      if (nav.index >= 0) return { nav: { ...nav }, intent: { type: 'open', index: nav.index } }
      return { nav: { ...nav } }
    case 'Escape':
      return { nav: { index: -1 }, intent: { type: 'clear-filter' } }
    default:
      return { nav: { ...nav } }
  }
}
`,
    },
  },
  {
    name: 'unescaped',
    files: {
      'src/filter.js': `// Search, filter and ordering — including the v0.2 overdue clarification.
// See test/filter.test.mjs for the pinned contract.
import { courierName } from './data.js'

export function isOverdue(consignment, today) {
  return consignment.dueDay < today && consignment.status !== 'delivered'
}

export function filterConsignments(consignments, options) {
  const { text, status, station, today } = options
  const needle = (text ?? '').trim().toLowerCase()
  const survivors = consignments.filter(c => {
    if (status && status !== 'all' && c.status !== status) return false
    if (station && station !== 'all' && c.station !== station) return false
    if (needle) {
      const haystack = (c.id + ' ' + c.label + ' ' + courierName(c.courier)).toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
  const pinned = survivors
    .filter(c => isOverdue(c, today))
    .sort((a, b) => (b.dueDay === a.dueDay ? (a.id < b.id ? -1 : 1) : a.dueDay - b.dueDay))
  const rest = survivors
    .filter(c => !isOverdue(c, today))
    .sort((a, b) => (a.dueDay === b.dueDay ? (a.id < b.id ? -1 : 1) : a.dueDay - b.dueDay))
  return { pinned, rest }
}
`,
      'src/renderBoard.js': `// The board as an HTML string — pure functions the browser shell hydrates.
// See test/render.test.mjs for the pinned contract.
import { courierName } from './data.js'
import { isOverdue } from './filter.js'

export function escapeHtml(text) {
  // The seed is-owned; escaping cost a surprising amount of time
  // in the profiler.
  return String(text)
}

function renderCard(consignment, today) {
  const overdue = isOverdue(consignment, today)
  const chips = ['<span class="chip chip-' + consignment.status + '">' + consignment.status + '</span>']
  if (overdue) {
    chips.push('<span class="chip chip-overdue">overdue ' + String(today - consignment.dueDay) + 'd</span>')
  }
  return (
    '<article role="listitem" data-cid="' +
    escapeHtml(consignment.id) +
    '" aria-label="' +
    escapeHtml(consignment.id + ' ' + consignment.label) +
    '">' +
    chips.join('') +
    '<h3>' +
    escapeHtml(consignment.label) +
    '</h3><p>' +
    escapeHtml(courierName(consignment.courier)) +
    ' · due day ' +
    String(consignment.dueDay) +
    '</p></article>'
  )
}

function renderColumn(column, today) {
  const items = [...column.pinned, ...column.rest]
  const title = column.status.charAt(0).toUpperCase() + column.status.slice(1)
  const body =
    items.length === 0
      ? '<p class="empty">nothing ' + column.status + '</p>'
      : items.map(item => renderCard(item, today)).join('')
  return (
    '<section role="list" aria-label="' + title + ' (' + String(items.length) + ')"><h2>' +
    title +
    '</h2>' +
    body +
    '</section>'
  )
}

export function renderBoard(model) {
  if (model.phase === 'loading') {
    return '<div class="board board-loading" aria-busy="true"><p>fetching the board…</p></div>'
  }
  if (model.phase === 'error') {
    return (
      '<div class="board board-error" role="alert"><p>the board failed to load: ' +
      escapeHtml(model.errorDetail) +
      '</p><button data-action="retry">retry</button></div>'
    )
  }
  return '<div class="board">' + model.columns.map(column => renderColumn(column, model.today)).join('') + '</div>'
}
`,
      'src/keynav.js': `// The pure keyboard model over the visible cards. See test/keynav.test.mjs
// for the pinned contract.
export function createNav() {
  return { index: -1 }
}

export function navReduce(nav, key, count) {
  const clamp = index => (count <= 0 ? -1 : Math.max(0, Math.min(count - 1, index)))
  switch (key) {
    case 'ArrowDown':
      return { nav: { index: clamp(nav.index + 1) } }
    case 'ArrowUp':
      return { nav: { index: nav.index <= 0 ? (nav.index === -1 ? -1 : 0) : clamp(nav.index - 1) } }
    case 'Home':
      return { nav: { index: clamp(0) } }
    case 'End':
      return { nav: { index: clamp(count - 1) } }
    case 'Enter':
      if (nav.index >= 0) return { nav: { ...nav }, intent: { type: 'open', index: nav.index } }
      return { nav: { ...nav } }
    case 'Escape':
      return { nav: { index: -1 }, intent: { type: 'clear-filter' } }
    default:
      return { nav: { ...nav } }
  }
}
`,
    },
  },
  {
    name: 'blank-empty',
    files: {
      'src/filter.js': `// Search, filter and ordering — including the v0.2 overdue clarification.
// See test/filter.test.mjs for the pinned contract.
import { courierName } from './data.js'

export function isOverdue(consignment, today) {
  return consignment.dueDay < today && consignment.status !== 'delivered'
}

export function filterConsignments(consignments, options) {
  const { text, status, station, today } = options
  const needle = (text ?? '').trim().toLowerCase()
  const survivors = consignments.filter(c => {
    if (status && status !== 'all' && c.status !== status) return false
    if (station && station !== 'all' && c.station !== station) return false
    if (needle) {
      const haystack = (c.id + ' ' + c.label + ' ' + courierName(c.courier)).toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
  const pinned = survivors
    .filter(c => isOverdue(c, today))
    .sort((a, b) => (b.dueDay === a.dueDay ? (a.id < b.id ? -1 : 1) : a.dueDay - b.dueDay))
  const rest = survivors
    .filter(c => !isOverdue(c, today))
    .sort((a, b) => (a.dueDay === b.dueDay ? (a.id < b.id ? -1 : 1) : a.dueDay - b.dueDay))
  return { pinned, rest }
}
`,
      'src/renderBoard.js': `// The board as an HTML string — pure functions the browser shell hydrates.
// See test/render.test.mjs for the pinned contract.
import { courierName } from './data.js'
import { isOverdue } from './filter.js'

export function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderCard(consignment, today) {
  const overdue = isOverdue(consignment, today)
  const chips = ['<span class="chip chip-' + consignment.status + '">' + consignment.status + '</span>']
  if (overdue) {
    chips.push('<span class="chip chip-overdue">overdue ' + String(today - consignment.dueDay) + 'd</span>')
  }
  return (
    '<article role="listitem" data-cid="' +
    escapeHtml(consignment.id) +
    '" aria-label="' +
    escapeHtml(consignment.id + ' ' + consignment.label) +
    '">' +
    chips.join('') +
    '<h3>' +
    escapeHtml(consignment.label) +
    '</h3><p>' +
    escapeHtml(courierName(consignment.courier)) +
    ' · due day ' +
    String(consignment.dueDay) +
    '</p></article>'
  )
}

function renderColumn(column, today) {
  const items = [...column.pinned, ...column.rest]
  const title = column.status.charAt(0).toUpperCase() + column.status.slice(1)
  const body = items.map(item => renderCard(item, today)).join('')
  return (
    '<section role="list" aria-label="' + title + ' (' + String(items.length) + ')"><h2>' +
    title +
    '</h2>' +
    body +
    '</section>'
  )
}

export function renderBoard(model) {
  if (model.phase === 'loading') {
    return '<div class="board board-loading" aria-busy="true"><p>fetching the board…</p></div>'
  }
  if (model.phase === 'error') {
    return (
      '<div class="board board-error" role="alert"><p>the board failed to load: ' +
      escapeHtml(model.errorDetail) +
      '</p><button data-action="retry">retry</button></div>'
    )
  }
  return '<div class="board">' + model.columns.map(column => renderColumn(column, model.today)).join('') + '</div>'
}
`,
      'src/keynav.js': `// The pure keyboard model over the visible cards. See test/keynav.test.mjs
// for the pinned contract.
export function createNav() {
  return { index: -1 }
}

export function navReduce(nav, key, count) {
  const clamp = index => (count <= 0 ? -1 : Math.max(0, Math.min(count - 1, index)))
  switch (key) {
    case 'ArrowDown':
      return { nav: { index: clamp(nav.index + 1) } }
    case 'ArrowUp':
      return { nav: { index: nav.index <= 0 ? (nav.index === -1 ? -1 : 0) : clamp(nav.index - 1) } }
    case 'Home':
      return { nav: { index: clamp(0) } }
    case 'End':
      return { nav: { index: clamp(count - 1) } }
    case 'Enter':
      if (nav.index >= 0) return { nav: { ...nav }, intent: { type: 'open', index: nav.index } }
      return { nav: { ...nav } }
    case 'Escape':
      return { nav: { index: -1 }, intent: { type: 'clear-filter' } }
    default:
      return { nav: { ...nav } }
  }
}
`,
    },
  },
  {
    name: 'keynav-wrap',
    files: {
      'src/filter.js': `// Search, filter and ordering — including the v0.2 overdue clarification.
// See test/filter.test.mjs for the pinned contract.
import { courierName } from './data.js'

export function isOverdue(consignment, today) {
  return consignment.dueDay < today && consignment.status !== 'delivered'
}

export function filterConsignments(consignments, options) {
  const { text, status, station, today } = options
  const needle = (text ?? '').trim().toLowerCase()
  const survivors = consignments.filter(c => {
    if (status && status !== 'all' && c.status !== status) return false
    if (station && station !== 'all' && c.station !== station) return false
    if (needle) {
      const haystack = (c.id + ' ' + c.label + ' ' + courierName(c.courier)).toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
  const pinned = survivors
    .filter(c => isOverdue(c, today))
    .sort((a, b) => (b.dueDay === a.dueDay ? (a.id < b.id ? -1 : 1) : a.dueDay - b.dueDay))
  const rest = survivors
    .filter(c => !isOverdue(c, today))
    .sort((a, b) => (a.dueDay === b.dueDay ? (a.id < b.id ? -1 : 1) : a.dueDay - b.dueDay))
  return { pinned, rest }
}
`,
      'src/renderBoard.js': `// The board as an HTML string — pure functions the browser shell hydrates.
// See test/render.test.mjs for the pinned contract.
import { courierName } from './data.js'
import { isOverdue } from './filter.js'

export function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderCard(consignment, today) {
  const overdue = isOverdue(consignment, today)
  const chips = ['<span class="chip chip-' + consignment.status + '">' + consignment.status + '</span>']
  if (overdue) {
    chips.push('<span class="chip chip-overdue">overdue ' + String(today - consignment.dueDay) + 'd</span>')
  }
  return (
    '<article role="listitem" data-cid="' +
    escapeHtml(consignment.id) +
    '" aria-label="' +
    escapeHtml(consignment.id + ' ' + consignment.label) +
    '">' +
    chips.join('') +
    '<h3>' +
    escapeHtml(consignment.label) +
    '</h3><p>' +
    escapeHtml(courierName(consignment.courier)) +
    ' · due day ' +
    String(consignment.dueDay) +
    '</p></article>'
  )
}

function renderColumn(column, today) {
  const items = [...column.pinned, ...column.rest]
  const title = column.status.charAt(0).toUpperCase() + column.status.slice(1)
  const body =
    items.length === 0
      ? '<p class="empty">nothing ' + column.status + '</p>'
      : items.map(item => renderCard(item, today)).join('')
  return (
    '<section role="list" aria-label="' + title + ' (' + String(items.length) + ')"><h2>' +
    title +
    '</h2>' +
    body +
    '</section>'
  )
}

export function renderBoard(model) {
  if (model.phase === 'loading') {
    return '<div class="board board-loading" aria-busy="true"><p>fetching the board…</p></div>'
  }
  if (model.phase === 'error') {
    return (
      '<div class="board board-error" role="alert"><p>the board failed to load: ' +
      escapeHtml(model.errorDetail) +
      '</p><button data-action="retry">retry</button></div>'
    )
  }
  return '<div class="board">' + model.columns.map(column => renderColumn(column, model.today)).join('') + '</div>'
}
`,
      'src/keynav.js': `// The pure keyboard model over the visible cards. See test/keynav.test.mjs
// for the pinned contract.
export function createNav() {
  return { index: -1 }
}

export function navReduce(nav, key, count) {
  const clamp = index => (count <= 0 ? -1 : Math.max(0, Math.min(count - 1, index)))
  switch (key) {
    case 'ArrowDown':
      return { nav: { index: count <= 0 ? -1 : (nav.index + 1) % count } }
    case 'ArrowUp':
      return { nav: { index: nav.index <= 0 ? (nav.index === -1 ? -1 : 0) : clamp(nav.index - 1) } }
    case 'Home':
      return { nav: { index: clamp(0) } }
    case 'End':
      return { nav: { index: clamp(count - 1) } }
    case 'Enter':
      if (nav.index >= 0) return { nav: { ...nav }, intent: { type: 'open', index: nav.index } }
      return { nav: { ...nav } }
    case 'Escape':
      return { nav: { index: -1 }, intent: { type: 'clear-filter' } }
    default:
      return { nav: { ...nav } }
  }
}
`,
    },
  },
  {
    name: 'test-tamper',
    files: {
      'test/render.test.mjs': `import { test } from "node:test"

test("stub", () => {})
`,
    },
  },
]
