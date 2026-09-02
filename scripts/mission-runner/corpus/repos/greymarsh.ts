// ============================================================================
//  corpus repo: greymarsh — the lived-in cross-module pack
//  (family 20). An event-sourced bothy-booking service with a
//  two-generation policy migration mid-flight (_meta/STATUS.md), a command
//  layer over a pure fold, and compaction. task/x1 plants the winter-log
//  regression: the SYMPTOM (confirmations that do not stick) points at the
//  fold; the TRUE cause is seq assignment in the event log after
//  compaction. This module is CANONICAL.
// ============================================================================
import type { BranchOverlay, FileMap, HelixRepoSpec } from '../contracts.js'

const FILES: FileMap = {
  '.gitignore': `node_modules/
.DS_Store
`,
  'README.md': "# greymarsh\n\nBothy booking for the Greymarsh field stations. Everything the service knows\nis an append-only event log; state is a fold; commands validate against the\nfold and append.\n\n```\nsrc/events.js    the log: append (seq assignment), read, compact\nsrc/state.js     foldState(events) -> { huts, bookings, occupancy }\nsrc/booking.js   commands: registerHut \u00b7 requestBooking \u00b7 confirmBooking \u00b7 cancelBooking\nsrc/policy.js    pricing/priority \u2014 GENERATION 1 (being retired; see _meta/STATUS.md)\nsrc/policy2.js   pricing/priority \u2014 generation 2 (partially adopted)\nsrc/render.js    the text admin view (status tables)\n```\n\nGround rules the tests pin:\n\n- events are the ONLY durable truth; seq is strictly increasing and unique\n  across the log's whole history (compaction must never let a new event\n  collide with a kept one);\n- the fold is pure and order-independent for a valid log (sorted by seq;\n  a seq tie is a LOG DEFECT \u2014 the fold keeps the first and the suite\n  treats ties as corruption);\n- commands never mutate state directly: validate against the fold, append,\n  re-fold.\n\nSee `_meta/STATUS.md` for where the policy migration stands.\n",
  '_meta/CHANGELOG.md': `# Changelog

- 0.7.2 policy2 quote + render migration (priority path still gen-1)
- 0.7.1 event-log compaction
- 0.7.0 day-set occupancy; named overlap refusals
- 0.6.x command layer split out of the fold
- 0.5.x first event-sourced rewrite (the flat-file era ends)
`,
  '_meta/STATUS.md': "# Status \u2014 greymarsh working notes\n\nUpdated whenever a work session ends. Newest first.\n\n## 0.7.2 \u2014 the policy migration (IN FLIGHT)\n\nRetiring generation-1 `src/policy.js` in favour of `src/policy2.js`\n(band-based pricing, no per-call season lookups). Checklist:\n\n- [x] policy2 module landed with its own suite\n- [x] `booking.js` quote path moved to policy2\n- [x] `render.js` price column moved to policy2\n- [ ] `booking.js` PRIORITY path still calls policy.js \u2014 move to\n      `policy2.priorityBand` (same inputs; policy2 returns a band object,\n      use `.rank`)\n- [ ] delete `src/policy.js` + its suite once no caller remains\n\nDo NOT hand-edit prices in render output; both generations must agree to\nthe penny until the old module is deleted (the parity test pins this).\n\n## 0.7.1\n\nCompaction landed (`events.compact`) \u2014 the winter logs were getting slow to\nfold. Kept: every hut registration, the LATEST terminal event per booking,\nand every event of still-open bookings.\n\n## 0.7.0\n\nOccupancy rewritten as day-set intersection; overlap refusals now name the\nblocking booking id.\n",
  'package.json': `{
  "name": "greymarsh",
  "version": "0.7.2",
  "type": "module",
  "description": "Bothy-booking for the Greymarsh field stations: an event-sourced ledger with a command layer and a text admin view.",
  "scripts": {
    "test": "node --test"
  }
}
`,
  'src/booking.js': `// The command layer: validate against the fold, append, re-fold. Commands
// never mutate state directly.
import { appendEvent, readEvents } from './events.js'
import { blockingBooking, foldState } from './state.js'
import { priorityRank } from './policy.js'
import { quote } from './policy2.js'

let nextBookingId = 0
export function resetIds() {
  nextBookingId = 0
}

export function registerHut(logFile, { hutId, name, berths }) {
  if (!hutId || !Number.isInteger(berths) || berths < 1) {
    throw new Error('registerHut: hutId and a positive berth count are required')
  }
  return appendEvent(logFile, { type: 'hut-registered', hutId, name: name ?? hutId, berths })
}

export function requestBooking(logFile, { hutId, party, from, to }) {
  const state = foldState(readEvents(logFile))
  if (!state.huts[hutId]) throw new Error('requestBooking: unknown hut ' + String(hutId))
  if (!Number.isInteger(party) || party < 1) throw new Error('requestBooking: party must be >= 1')
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
    throw new Error('requestBooking: [from, to) must be a forward day range')
  }
  if (party > state.huts[hutId].berths) {
    throw new Error('requestBooking: party exceeds the hut (' + String(state.huts[hutId].berths) + ' berths)')
  }
  nextBookingId += 1
  const bookingId = 'b' + String(nextBookingId).padStart(4, '0')
  const event = appendEvent(logFile, { type: 'booking-requested', bookingId, hutId, party, from, to })
  return { bookingId, seq: event.seq, price: quote(party, from, to) }
}

export function confirmBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('confirmBooking: unknown booking ' + String(bookingId))
  if (booking.status !== 'requested') {
    throw new Error('confirmBooking: ' + bookingId + ' is ' + booking.status + ', not requested')
  }
  const blocker = blockingBooking(state, booking.hutId, booking.party, booking.from, booking.to)
  if (blocker) {
    throw new Error('confirmBooking: berth occupied by ' + blocker.id + ' — refusing ' + bookingId)
  }
  return appendEvent(logFile, { type: 'booking-confirmed', bookingId })
}

export function cancelBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('cancelBooking: unknown booking ' + String(bookingId))
  if (booking.status === 'cancelled') return null
  return appendEvent(logFile, { type: 'booking-cancelled', bookingId })
}

// Requests are served in priority order when a day frees up. Still the
// GENERATION-1 policy call — see _meta/STATUS.md before touching.
export function queuedRequests(logFile) {
  const state = foldState(readEvents(logFile))
  return Object.values(state.bookings)
    .filter(b => b.status === 'requested')
    .sort((a, b) => priorityRank(a.party, a.to - a.from) - priorityRank(b.party, b.to - b.from))
    .map(b => b.id)
}
`,
  'src/events.js': "// The event log \u2014 the only durable truth. JSON lines on disk; seq is\n// strictly increasing and UNIQUE across the log's whole history: compaction\n// removes rows but must never let a new event collide with a kept one.\nimport { existsSync, readFileSync, writeFileSync } from 'node:fs'\n\nexport function readEvents(logFile) {\n  if (!existsSync(logFile)) return []\n  return readFileSync(logFile, 'utf8')\n    .split('\\n')\n    .filter(line => line.trim())\n    .map(line => JSON.parse(line))\n}\n\nfunction writeAll(logFile, events) {\n  writeFileSync(logFile, events.map(e => JSON.stringify(e)).join('\\n') + (events.length ? '\\n' : ''), 'utf8')\n}\n\nexport function appendEvent(logFile, event) {\n  const events = readEvents(logFile)\n  const seq = events.reduce((max, e) => Math.max(max, e.seq), 0) + 1\n  const complete = { seq, ...event }\n  events.push(complete)\n  writeAll(logFile, events)\n  return complete\n}\n\n// Winter logs fold slowly; keep every hut registration, the LATEST terminal\n// event per booking plus its request/confirmation history only while the\n// booking is open, and drop everything a terminal event supersedes.\nexport function compact(logFile) {\n  const events = readEvents(logFile)\n  const terminal = new Map()\n  for (const event of events) {\n    if (event.type === 'booking-cancelled' || event.type === 'booking-expired') {\n      terminal.set(event.bookingId, event)\n    }\n  }\n  const kept = events.filter(event => {\n    if (event.type === 'hut-registered') return true\n    if (event.type === 'booking-cancelled' || event.type === 'booking-expired') {\n      return terminal.get(event.bookingId) === event\n    }\n    if (event.type === 'booking-requested' || event.type === 'booking-confirmed') {\n      // History of a terminated booking collapses into its terminal event.\n      return !terminal.has(event.bookingId)\n    }\n    return true\n  })\n  writeAll(logFile, kept)\n  return { before: events.length, after: kept.length }\n}\n",
  'src/policy.js': `// Pricing + priority, GENERATION 1. Being retired for policy2 — see
// _meta/STATUS.md. Older idioms preserved on purpose; do not modernise
// in place.
var SEASON_RATE = { low: 4, mid: 6, high: 9 }

function seasonOf(day) {
  var d = day % 360
  if (d < 120) return 'low'
  if (d < 240) return 'mid'
  return 'high'
}

var legacyPriceTable = null // 0.4.x relic; kept until the migration lands

export function price(party, from, to) {
  var total = 0
  for (var day = from; day < to; day++) {
    total += SEASON_RATE[seasonOf(day)] * party
  }
  return total
}

export function priorityRank(party, nights) {
  // Small parties on short stays first; the warden's ancient rule of thumb.
  var rank = party * 10 + (nights > 3 ? 5 : 0)
  return rank
}
`,
  'src/policy2.js': "// Pricing + priority, generation 2: band tables, no per-day season lookups.\n// Adopted by the quote and render paths (0.7.2); the priority path is still\n// generation 1 \u2014 see _meta/STATUS.md for the migration checklist.\nconst BANDS = [\n  { untilDay: 120, rate: 4 },\n  { untilDay: 240, rate: 6 },\n  { untilDay: 360, rate: 9 },\n]\n\nexport function quote(party, from, to) {\n  let total = 0\n  for (let day = from; day < to; day++) {\n    const yearDay = day % 360\n    const band = BANDS.find(b => yearDay < b.untilDay)\n    total += band.rate * party\n  }\n  return total\n}\n\n// The generation-2 priority shape: a band OBJECT (rank + reason), so the\n// queue view can explain itself. Callers migrating from policy.priorityRank\n// use `.rank`.\nexport function priorityBand(party, nights) {\n  const rank = party * 10 + (nights > 3 ? 5 : 0)\n  const reason = party <= 2 ? 'small party' : nights > 3 ? 'long stay' : 'standard'\n  return { rank, reason }\n}\n",
  'src/render.js': "// The text admin view. Reads the fold, never the log directly. Prices come\n// from policy2 (migrated 0.7.2); both generations must agree to the penny\n// until policy.js is deleted (the parity test pins this).\nimport { quote } from './policy2.js'\n\nexport function renderStatus(state) {\n  const lines = []\n  lines.push('GREYMARSH STATIONS')\n  lines.push('==================')\n  for (const hut of Object.values(state.huts).sort((a, b) => a.id.localeCompare(b.id))) {\n    lines.push(hut.id + '  ' + hut.name + '  (' + String(hut.berths) + ' berths)')\n    const bookings = Object.values(state.bookings)\n      .filter(b => b.hutId === hut.id)\n      .sort((a, b) => a.id.localeCompare(b.id))\n    for (const b of bookings) {\n      lines.push(\n        '  ' +\n          b.id +\n          '  ' +\n          b.status.padEnd(9) +\n          ' party ' +\n          String(b.party) +\n          '  days ' +\n          String(b.from) +\n          '\u2013' +\n          String(b.to) +\n          '  \u00a3' +\n          String(quote(b.party, b.from, b.to)),\n      )\n    }\n    if (bookings.length === 0) lines.push('  (no bookings)')\n  }\n  return lines.join('\\n') + '\\n'\n}\n",
  'src/state.js': "// The fold: events -> state. Pure; sorted by seq; a seq tie is a log\n// defect \u2014 the fold keeps the FIRST and ignores the rest (corruption must\n// never double-apply).\nexport function foldState(events) {\n  const ordered = [...events].sort((a, b) => a.seq - b.seq)\n  const state = { huts: {}, bookings: {} }\n  const seen = new Set()\n  for (const event of ordered) {\n    if (seen.has(event.seq)) continue // tie: keep the first, drop the rest\n    seen.add(event.seq)\n    apply(state, event)\n  }\n  return state\n}\n\nfunction apply(state, event) {\n  switch (event.type) {\n    case 'hut-registered':\n      state.huts[event.hutId] = { id: event.hutId, name: event.name, berths: event.berths }\n      break\n    case 'booking-requested':\n      state.bookings[event.bookingId] = {\n        id: event.bookingId,\n        hutId: event.hutId,\n        party: event.party,\n        from: event.from,\n        to: event.to,\n        status: 'requested',\n      }\n      break\n    case 'booking-confirmed': {\n      const booking = state.bookings[event.bookingId]\n      if (booking && booking.status === 'requested') booking.status = 'confirmed'\n      break\n    }\n    case 'booking-cancelled': {\n      const booking = state.bookings[event.bookingId]\n      if (booking) booking.status = 'cancelled'\n      break\n    }\n    case 'booking-expired': {\n      const booking = state.bookings[event.bookingId]\n      if (booking && booking.status === 'requested') booking.status = 'expired'\n      break\n    }\n    default:\n      break\n  }\n}\n\n// Day-set occupancy: how many berths hut `hutId` has taken on each day of\n// [from, to). Confirmed bookings hold berths; requests do not.\nexport function occupiedBerths(state, hutId, from, to) {\n  let peak = 0\n  for (let day = from; day < to; day++) {\n    let taken = 0\n    for (const booking of Object.values(state.bookings)) {\n      if (booking.hutId !== hutId || booking.status !== 'confirmed') continue\n      if (day >= booking.from && day < booking.to) taken += booking.party\n    }\n    peak = Math.max(peak, taken)\n  }\n  return peak\n}\n\n// The first confirmed booking blocking `party` berths on [from, to), if any.\nexport function blockingBooking(state, hutId, party, from, to) {\n  const hut = state.huts[hutId]\n  if (!hut) return null\n  for (let day = from; day < to; day++) {\n    let taken = 0\n    let lastHolder = null\n    for (const booking of Object.values(state.bookings)) {\n      if (booking.hutId !== hutId || booking.status !== 'confirmed') continue\n      if (day >= booking.from && day < booking.to) {\n        taken += booking.party\n        lastHolder = booking\n      }\n    }\n    if (taken + party > hut.berths) return lastHolder\n  }\n  return null\n}\n",
  'test/booking.test.mjs': `import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cancelBooking, confirmBooking, queuedRequests, registerHut, requestBooking, resetIds } from '../src/booking.js'
import { readEvents } from '../src/events.js'
import { foldState } from '../src/state.js'

const fresh = () => {
  resetIds()
  return join(mkdtempSync(join(tmpdir(), 'greymarsh-')), 'log.jsonl')
}

test('the happy flow: register, request, confirm, cancel', () => {
  const log = fresh()
  registerHut(log, { hutId: 'ridge', name: 'Ridge Bothy', berths: 2 })
  const { bookingId, price } = requestBooking(log, { hutId: 'ridge', party: 2, from: 10, to: 12 })
  assert.ok(price > 0)
  confirmBooking(log, bookingId)
  assert.equal(foldState(readEvents(log)).bookings[bookingId].status, 'confirmed')
  cancelBooking(log, bookingId)
  assert.equal(foldState(readEvents(log)).bookings[bookingId].status, 'cancelled')
})

test('a genuine overlap refuses and names the blocker', () => {
  const log = fresh()
  registerHut(log, { hutId: 'ridge', berths: 2 })
  const first = requestBooking(log, { hutId: 'ridge', party: 2, from: 10, to: 14 })
  confirmBooking(log, first.bookingId)
  const second = requestBooking(log, { hutId: 'ridge', party: 1, from: 12, to: 13 })
  assert.throws(
    () => confirmBooking(log, second.bookingId),
    new RegExp('berth occupied by ' + first.bookingId),
  )
})

test('validation refusals are typed', () => {
  const log = fresh()
  registerHut(log, { hutId: 'ridge', berths: 2 })
  assert.throws(() => requestBooking(log, { hutId: 'ridge', party: 3, from: 1, to: 2 }), /exceeds the hut/)
  assert.throws(() => requestBooking(log, { hutId: 'nowhere', party: 1, from: 1, to: 2 }), /unknown hut/)
  assert.throws(() => requestBooking(log, { hutId: 'ridge', party: 1, from: 5, to: 5 }), /forward day range/)
  assert.throws(() => confirmBooking(log, 'b9999'), /unknown booking/)
})

test('cancelling twice is a quiet no-op', () => {
  const log = fresh()
  registerHut(log, { hutId: 'ridge', berths: 2 })
  const { bookingId } = requestBooking(log, { hutId: 'ridge', party: 1, from: 1, to: 2 })
  cancelBooking(log, bookingId)
  assert.equal(cancelBooking(log, bookingId), null)
})

test('queued requests come small-party-first', () => {
  const log = fresh()
  registerHut(log, { hutId: 'ridge', berths: 4 })
  const big = requestBooking(log, { hutId: 'ridge', party: 4, from: 1, to: 3 })
  const small = requestBooking(log, { hutId: 'ridge', party: 1, from: 1, to: 3 })
  assert.deepEqual(queuedRequests(log), [small.bookingId, big.bookingId])
})
`,
  'test/events.test.mjs': `import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEvent, compact, readEvents } from '../src/events.js'

const fresh = () => join(mkdtempSync(join(tmpdir(), 'greymarsh-')), 'log.jsonl')

test('append assigns increasing seq', () => {
  const log = fresh()
  const a = appendEvent(log, { type: 'hut-registered', hutId: 'ridge', name: 'Ridge', berths: 2 })
  const b = appendEvent(log, { type: 'booking-requested', bookingId: 'b1', hutId: 'ridge', party: 1, from: 1, to: 3 })
  assert.equal(a.seq, 1)
  assert.equal(b.seq, 2)
  assert.equal(readEvents(log).length, 2)
})

test('compaction collapses a terminated booking into its terminal event', () => {
  const log = fresh()
  appendEvent(log, { type: 'hut-registered', hutId: 'ridge', name: 'Ridge', berths: 2 })
  appendEvent(log, { type: 'booking-requested', bookingId: 'bA', hutId: 'ridge', party: 2, from: 10, to: 12 })
  appendEvent(log, { type: 'booking-confirmed', bookingId: 'bA' })
  appendEvent(log, { type: 'booking-cancelled', bookingId: 'bA' })
  const { before, after } = compact(log)
  assert.equal(before, 4)
  assert.equal(after, 2)
  const kept = readEvents(log)
  assert.deepEqual(kept.map(e => e.type).sort(), ['booking-cancelled', 'hut-registered'])
  // Kept rows keep their identity: compaction removes, it never renumbers.
  assert.deepEqual(kept.map(e => e.seq).sort((a, b) => a - b), [1, 4])
})

test('compaction keeps the history of still-open bookings', () => {
  const log = fresh()
  appendEvent(log, { type: 'hut-registered', hutId: 'ridge', name: 'Ridge', berths: 2 })
  appendEvent(log, { type: 'booking-requested', bookingId: 'bB', hutId: 'ridge', party: 1, from: 1, to: 2 })
  appendEvent(log, { type: 'booking-confirmed', bookingId: 'bB' })
  const { before, after } = compact(log)
  assert.equal(before, 3)
  assert.equal(after, 3)
})
`,
  'test/policy-parity.test.mjs': "// The two-generation parity law from _meta/STATUS.md: both policies agree\n// to the penny until policy.js is deleted at the end of the migration.\nimport test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { price, priorityRank } from '../src/policy.js'\nimport { priorityBand, quote } from '../src/policy2.js'\nimport { foldState } from '../src/state.js'\nimport { renderStatus } from '../src/render.js'\n\ntest('gen-1 price and gen-2 quote agree across season boundaries', () => {\n  for (const [party, from, to] of [\n    [1, 0, 10],\n    [2, 115, 125],\n    [3, 235, 245],\n    [4, 350, 365],\n    [2, 0, 360],\n  ]) {\n    assert.equal(price(party, from, to), quote(party, from, to), party + ':' + from + '-' + to)\n  }\n})\n\ntest('gen-1 priorityRank and gen-2 priorityBand.rank agree', () => {\n  for (const [party, nights] of [\n    [1, 1],\n    [2, 4],\n    [4, 2],\n    [6, 7],\n  ]) {\n    assert.equal(priorityRank(party, nights), priorityBand(party, nights).rank)\n  }\n})\n\ntest('the admin view prices with generation 2 and shows statuses', () => {\n  const state = foldState([\n    { seq: 1, type: 'hut-registered', hutId: 'ridge', name: 'Ridge Bothy', berths: 4 },\n    { seq: 2, type: 'booking-requested', bookingId: 'bA', hutId: 'ridge', party: 2, from: 10, to: 12 },\n    { seq: 3, type: 'booking-confirmed', bookingId: 'bA' },\n  ])\n  const view = renderStatus(state)\n  assert.match(view, /Ridge Bothy/)\n  assert.match(view, /bA\\s+confirmed/)\n  assert.match(view, new RegExp('\u00a3' + String(quote(2, 10, 12))))\n})\n",
  'test/state.test.mjs': `import test from 'node:test'
import assert from 'node:assert/strict'
import { blockingBooking, foldState, occupiedBerths } from '../src/state.js'

const EVENTS = [
  { seq: 1, type: 'hut-registered', hutId: 'ridge', name: 'Ridge Bothy', berths: 4 },
  { seq: 2, type: 'booking-requested', bookingId: 'bA', hutId: 'ridge', party: 3, from: 10, to: 14 },
  { seq: 3, type: 'booking-confirmed', bookingId: 'bA' },
  { seq: 4, type: 'booking-requested', bookingId: 'bB', hutId: 'ridge', party: 2, from: 12, to: 16 },
]

test('the fold derives statuses and ignores order of arrival', () => {
  const shuffled = [EVENTS[3], EVENTS[0], EVENTS[2], EVENTS[1]]
  const state = foldState(shuffled)
  assert.equal(state.bookings.bA.status, 'confirmed')
  assert.equal(state.bookings.bB.status, 'requested')
  assert.equal(state.huts.ridge.berths, 4)
})

test('a seq tie is corruption: the fold keeps the FIRST and drops the rest', () => {
  const tied = [
    ...EVENTS,
    { seq: 4, type: 'booking-confirmed', bookingId: 'bB' }, // colliding row
  ]
  const state = foldState(tied)
  assert.equal(state.bookings.bB.status, 'requested', 'the colliding second row must not apply')
})

test('occupancy counts confirmed parties per day; requests hold nothing', () => {
  const state = foldState(EVENTS)
  assert.equal(occupiedBerths(state, 'ridge', 10, 14), 3)
  assert.equal(occupiedBerths(state, 'ridge', 14, 16), 0)
})

test('blockingBooking names the holder that would burst the hut', () => {
  const state = foldState(EVENTS)
  assert.equal(blockingBooking(state, 'ridge', 2, 12, 14).id, 'bA')
  assert.equal(blockingBooking(state, 'ridge', 1, 12, 14), null)
})
`,}

const X1_OVERLAY: BranchOverlay = {
  'src/events.js': "// The event log \u2014 the only durable truth. JSON lines on disk; seq is\n// strictly increasing and UNIQUE across the log's whole history: compaction\n// removes rows but must never let a new event collide with a kept one.\nimport { existsSync, readFileSync, writeFileSync } from 'node:fs'\n\nexport function readEvents(logFile) {\n  if (!existsSync(logFile)) return []\n  return readFileSync(logFile, 'utf8')\n    .split('\\n')\n    .filter(line => line.trim())\n    .map(line => JSON.parse(line))\n}\n\nfunction writeAll(logFile, events) {\n  writeFileSync(logFile, events.map(e => JSON.stringify(e)).join('\\n') + (events.length ? '\\n' : ''), 'utf8')\n}\n\nexport function appendEvent(logFile, event) {\n  const events = readEvents(logFile)\n  const seq = events.length + 1\n  const complete = { seq, ...event }\n  events.push(complete)\n  writeAll(logFile, events)\n  return complete\n}\n\n// Winter logs fold slowly; keep every hut registration, the LATEST terminal\n// event per booking plus its request/confirmation history only while the\n// booking is open, and drop everything a terminal event supersedes.\nexport function compact(logFile) {\n  const events = readEvents(logFile)\n  const terminal = new Map()\n  for (const event of events) {\n    if (event.type === 'booking-cancelled' || event.type === 'booking-expired') {\n      terminal.set(event.bookingId, event)\n    }\n  }\n  const kept = events.filter(event => {\n    if (event.type === 'hut-registered') return true\n    if (event.type === 'booking-cancelled' || event.type === 'booking-expired') {\n      return terminal.get(event.bookingId) === event\n    }\n    if (event.type === 'booking-requested' || event.type === 'booking-confirmed') {\n      // History of a terminated booking collapses into its terminal event.\n      return !terminal.has(event.bookingId)\n    }\n    return true\n  })\n  writeAll(logFile, kept)\n  return { before: events.length, after: kept.length }\n}\n",
  'test/rebooking.test.mjs': `// The winter-log regression the wardens reported after 0.7.1: a re-booking
// made after compaction confirms without error but stays 'requested' in the
// admin view.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cancelBooking, confirmBooking, registerHut, requestBooking, resetIds } from '../src/booking.js'
import { compact, readEvents } from '../src/events.js'
import { foldState } from '../src/state.js'

const fresh = () => {
  resetIds()
  return join(mkdtempSync(join(tmpdir(), 'greymarsh-')), 'log.jsonl')
}

test('a re-booking after compaction actually confirms', () => {
  const log = fresh()
  registerHut(log, { hutId: 'ridge', name: 'Ridge Bothy', berths: 2 })
  const first = requestBooking(log, { hutId: 'ridge', party: 2, from: 10, to: 12 })
  confirmBooking(log, first.bookingId)
  cancelBooking(log, first.bookingId) // the trip is called off
  compact(log) // the winter maintenance pass
  const second = requestBooking(log, { hutId: 'ridge', party: 2, from: 10, to: 12 })
  confirmBooking(log, second.bookingId) // no error...
  const state = foldState(readEvents(log))
  assert.equal(
    state.bookings[second.bookingId].status,
    'confirmed',
    'the confirmation was accepted — the booking must not stay requested',
  )
})

test('the log never carries two events with the same seq', () => {
  const log = fresh()
  registerHut(log, { hutId: 'ridge', name: 'Ridge Bothy', berths: 2 })
  const first = requestBooking(log, { hutId: 'ridge', party: 1, from: 1, to: 4 })
  confirmBooking(log, first.bookingId)
  cancelBooking(log, first.bookingId)
  compact(log)
  const second = requestBooking(log, { hutId: 'ridge', party: 1, from: 2, to: 5 })
  confirmBooking(log, second.bookingId)
  const seqs = readEvents(log).map(e => e.seq)
  assert.equal(new Set(seqs).size, seqs.length, 'duplicate seq in: ' + JSON.stringify(seqs))
})
`,
}

const X2_OVERLAY: BranchOverlay = {
  'test/storm-levy.test.mjs': `// The storm-levy request (0.7.3): winter quotes carry the coastguard levy.
// Three laws hold AT ONCE — the naive change sites each break one of them:
//   L1 the parity law (test/policy-parity.test.mjs): gen-1 price and gen-2
//      quote agree to the penny until the migration completes;
//   L2 the freeze law (below): the retired generation-1 module is FROZEN
//      while the migration is in flight — its bytes must not change;
//   L3 the levy law (below): a booking priced over any day in [300, 360)
//      includes the £2/party/levy-day storm levy.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerHut, requestBooking, resetIds } from '../src/booking.js'
import { quote } from '../src/policy2.js'

const fresh = () => {
  resetIds()
  return join(mkdtempSync(join(tmpdir(), 'greymarsh-')), 'log.jsonl')
}

// L2 — the freeze law. The migration checklist (_meta/STATUS.md) retires
// generation 1 by DELETION, never by edit; until then it is bit-frozen.
test('generation 1 stays frozen while the migration is in flight', () => {
  const bytes = readFileSync(new URL('../src/policy.js', import.meta.url))
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '76ad87a0505aec049cdd3d3a76f26e177c2ed50edb58315e4f1b63253f5ca08d',
    'src/policy.js must not change (retire by deletion at the end of the migration)',
  )
})

// L3 — the levy law, pinned at the COMMAND price (what a warden is quoted),
// not at any generation module.
test('a winter booking is quoted with the storm levy', () => {
  const log = fresh()
  registerHut(log, { hutId: 'ness', name: 'Ness Bothy', berths: 4 })
  // Days 350-355: five levy days, party 2 => quote + 2*2*5.
  const winter = requestBooking(log, { hutId: 'ness', party: 2, from: 350, to: 355 })
  assert.equal(winter.price, quote(2, 350, 355) + 2 * 2 * 5)
})

test('a levy-free range is quoted unchanged', () => {
  const log = fresh()
  registerHut(log, { hutId: 'ness', name: 'Ness Bothy', berths: 4 })
  const spring = requestBooking(log, { hutId: 'ness', party: 3, from: 20, to: 24 })
  assert.equal(spring.price, quote(3, 20, 24))
})

test('a range straddling the levy season pays only for levy days', () => {
  const log = fresh()
  registerHut(log, { hutId: 'ness', name: 'Ness Bothy', berths: 4 })
  // Days 298-302: two levy days (300, 301), party 1 => quote + 1*2*2.
  const straddle = requestBooking(log, { hutId: 'ness', party: 1, from: 298, to: 302 })
  assert.equal(straddle.price, quote(1, 298, 302) + 1 * 2 * 2)
})
`,
}

const X3_OVERLAY: BranchOverlay = {
  '_meta/STATUS.md': "# Status \u2014 greymarsh working notes\n\nUpdated whenever a work session ends. Newest first.\n\n## 0.7.2 \u2014 the policy migration (IN FLIGHT)\n\nRetiring generation-1 `src/policy.js` in favour of `src/policy2.js`\n(band-based pricing, no per-call season lookups). Checklist:\n\n- [x] policy2 module landed with its own suite\n- [x] `booking.js` quote path moved to policy2\n- [x] `render.js` price column moved to policy2\n- [ ] `booking.js` PRIORITY path still calls policy.js \u2014 move to\n      `policy2.priorityBand` (same inputs; policy2 returns a band object,\n      use `.rank`)\n\nDeletion of `src/policy.js` + its parity suite is SCHEDULED FOR 0.7.4,\nafter a full season of parity telemetry \u2014 do NOT delete early; the parity\nlaw stands until then.\n\nDo NOT hand-edit prices in render output; both generations must agree to\nthe penny until the old module is deleted (the parity test pins this).\n\n## 0.7.1\n\nCompaction landed (`events.compact`) \u2014 the winter logs were getting slow to\nfold. Kept: every hut registration, the LATEST terminal event per booking,\nand every event of still-open bookings.\n\n## 0.7.0\n\nOccupancy rewritten as day-set intersection; overlap refusals now name the\nblocking booking id.\n",
  'test/migration.test.mjs': "// The 0.7.2 migration close-out: the LAST checklist item lands exactly as\n// recorded in _meta/STATUS.md \u2014 the priority path moves to generation 2\n// (priorityBand().rank), the box is ticked, and nothing else moves early.\nimport test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { mkdtempSync, readFileSync } from 'node:fs'\nimport { tmpdir } from 'node:os'\nimport { join } from 'node:path'\nimport { queuedRequests, registerHut, requestBooking, resetIds } from '../src/booking.js'\n\nconst bookingSource = () => readFileSync(new URL('../src/booking.js', import.meta.url), 'utf8')\nconst statusNotes = () => readFileSync(new URL('../_meta/STATUS.md', import.meta.url), 'utf8')\n\ntest('the priority path is generation 2', () => {\n  const source = bookingSource()\n  assert.doesNotMatch(source, /from '\\.\\/policy\\.js'/, 'no generation-1 import may remain')\n  assert.match(source, /priorityBand/, 'the recorded target is policy2.priorityBand (use .rank)')\n})\n\ntest('the checklist records the move', () => {\n  const notes = statusNotes()\n  assert.doesNotMatch(notes, /- \\[ \\] `booking\\.js` PRIORITY/, 'the open box must be ticked')\n  assert.match(notes, /- \\[x\\] `booking\\.js` PRIORITY/, 'the completed item stays in the checklist')\n})\n\ntest('queue order is unchanged by the move (intent retained)', () => {\n  resetIds()\n  const log = join(mkdtempSync(join(tmpdir(), 'greymarsh-')), 'log.jsonl')\n  registerHut(log, { hutId: 'ridge', berths: 6 })\n  const big = requestBooking(log, { hutId: 'ridge', party: 5, from: 1, to: 3 })\n  const small = requestBooking(log, { hutId: 'ridge', party: 1, from: 1, to: 3 })\n  const long = requestBooking(log, { hutId: 'ridge', party: 1, from: 1, to: 8 })\n  assert.deepEqual(queuedRequests(log), [small.bookingId, long.bookingId, big.bookingId])\n})\n\ntest('generation 1 itself has not been touched early', () => {\n  const gen1 = readFileSync(new URL('../src/policy.js', import.meta.url), 'utf8')\n  assert.match(gen1, /GENERATION 1/, 'policy.js stays in place until 0.7.4')\n})\n",
}

const X4_OVERLAY: BranchOverlay = {
  'test/wardens.test.mjs': `// The warden features (0.7.3): TWO separable areas over TWO shared seams.
//   Area A — maintenance windows: declareMaintenance(log, {hutId, from, to})
//     appends 'maintenance-declared'; a confirmed booking and a maintenance
//     window can NEVER overlap, whichever comes second is refused by name.
//   Area B — the expiry sweep: expireStale(log, {beforeDay}) appends ONE
//     'booking-expired' per still-requested booking whose stay ended before
//     beforeDay; idempotent; returns the expired ids sorted.
// Shared seams: the event vocabulary (both areas append through the log and
// fold through state) and the fold itself (maintenance + statuses live in
// ONE state shape; the queue and occupancy views must stay coherent).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cancelBooking,
  confirmBooking,
  declareMaintenance,
  expireStale,
  queuedRequests,
  registerHut,
  requestBooking,
  resetIds,
} from '../src/booking.js'
import { readEvents } from '../src/events.js'
import { foldState } from '../src/state.js'

const fresh = () => {
  resetIds()
  return join(mkdtempSync(join(tmpdir(), 'greymarsh-')), 'log.jsonl')
}

test('a booking cannot confirm into a maintenance window', () => {
  const log = fresh()
  registerHut(log, { hutId: 'ridge', berths: 4 })
  declareMaintenance(log, { hutId: 'ridge', from: 10, to: 20 })
  const req = requestBooking(log, { hutId: 'ridge', party: 1, from: 12, to: 14 })
  assert.throws(() => confirmBooking(log, req.bookingId), /hut closed for maintenance/)
})

test('maintenance cannot be declared over a confirmed booking — refused by name', () => {
  const log = fresh()
  registerHut(log, { hutId: 'ridge', berths: 4 })
  const req = requestBooking(log, { hutId: 'ridge', party: 2, from: 12, to: 14 })
  confirmBooking(log, req.bookingId)
  assert.throws(
    () => declareMaintenance(log, { hutId: 'ridge', from: 10, to: 20 }),
    new RegExp('maintenance conflicts with ' + req.bookingId),
  )
})

test('non-overlapping maintenance and bookings coexist', () => {
  const log = fresh()
  registerHut(log, { hutId: 'ridge', berths: 4 })
  declareMaintenance(log, { hutId: 'ridge', from: 10, to: 20 })
  const req = requestBooking(log, { hutId: 'ridge', party: 2, from: 20, to: 22 })
  confirmBooking(log, req.bookingId)
  assert.equal(foldState(readEvents(log)).bookings[req.bookingId].status, 'confirmed')
})

test('the sweep expires exactly the stale requests, sorted, and spares the rest', () => {
  const log = fresh()
  registerHut(log, { hutId: 'ridge', berths: 6 })
  const stale1 = requestBooking(log, { hutId: 'ridge', party: 1, from: 1, to: 3 })
  const fresh1 = requestBooking(log, { hutId: 'ridge', party: 1, from: 40, to: 42 })
  const confirmedOld = requestBooking(log, { hutId: 'ridge', party: 1, from: 2, to: 4 })
  confirmBooking(log, confirmedOld.bookingId)
  const cancelledOld = requestBooking(log, { hutId: 'ridge', party: 1, from: 2, to: 4 })
  cancelBooking(log, cancelledOld.bookingId)
  const stale2 = requestBooking(log, { hutId: 'ridge', party: 2, from: 5, to: 7 })
  const expired = expireStale(log, { beforeDay: 30 })
  assert.deepEqual(expired, [stale1.bookingId, stale2.bookingId].sort())
  const state = foldState(readEvents(log))
  assert.equal(state.bookings[stale1.bookingId].status, 'expired')
  assert.equal(state.bookings[stale2.bookingId].status, 'expired')
  assert.equal(state.bookings[fresh1.bookingId].status, 'requested')
  assert.equal(state.bookings[confirmedOld.bookingId].status, 'confirmed')
  assert.equal(state.bookings[cancelledOld.bookingId].status, 'cancelled')
  assert.deepEqual(queuedRequests(log), [fresh1.bookingId], 'the queue view drops expired requests')
})

test('the sweep is idempotent: a second pass appends nothing', () => {
  const log = fresh()
  registerHut(log, { hutId: 'ridge', berths: 4 })
  requestBooking(log, { hutId: 'ridge', party: 1, from: 1, to: 3 })
  expireStale(log, { beforeDay: 10 })
  const eventsAfterFirst = readEvents(log).length
  const second = expireStale(log, { beforeDay: 10 })
  assert.deepEqual(second, [])
  assert.equal(readEvents(log).length, eventsAfterFirst)
})

test('integration: a request under a maintenance window still expires normally', () => {
  const log = fresh()
  registerHut(log, { hutId: 'ridge', berths: 4 })
  declareMaintenance(log, { hutId: 'ridge', from: 1, to: 10 })
  const req = requestBooking(log, { hutId: 'ridge', party: 1, from: 2, to: 4 })
  const expired = expireStale(log, { beforeDay: 30 })
  assert.deepEqual(expired, [req.bookingId])
  assert.equal(foldState(readEvents(log)).bookings[req.bookingId].status, 'expired')
})
`,
}

export const GREYMARSH_REPO: HelixRepoSpec = {
  id: 'greymarsh',
  seed: 'inline',
  files: FILES,
  branches: { 'task/x1': X1_OVERLAY, 'task/x2': X2_OVERLAY, 'task/x3': X3_OVERLAY, 'task/x4': X4_OVERLAY },
}

/** GM1 reference: seq assignment restored to max(seq)+1 — kept rows keep
 *  their identity and new events never collide after compaction. */
export const GREYMARSH_X1_REFERENCE: FileMap = {
  'src/events.js': "// The event log \u2014 the only durable truth. JSON lines on disk; seq is\n// strictly increasing and UNIQUE across the log's whole history: compaction\n// removes rows but must never let a new event collide with a kept one.\nimport { existsSync, readFileSync, writeFileSync } from 'node:fs'\n\nexport function readEvents(logFile) {\n  if (!existsSync(logFile)) return []\n  return readFileSync(logFile, 'utf8')\n    .split('\\n')\n    .filter(line => line.trim())\n    .map(line => JSON.parse(line))\n}\n\nfunction writeAll(logFile, events) {\n  writeFileSync(logFile, events.map(e => JSON.stringify(e)).join('\\n') + (events.length ? '\\n' : ''), 'utf8')\n}\n\nexport function appendEvent(logFile, event) {\n  const events = readEvents(logFile)\n  const seq = events.reduce((max, e) => Math.max(max, e.seq), 0) + 1\n  const complete = { seq, ...event }\n  events.push(complete)\n  writeAll(logFile, events)\n  return complete\n}\n\n// Winter logs fold slowly; keep every hut registration, the LATEST terminal\n// event per booking plus its request/confirmation history only while the\n// booking is open, and drop everything a terminal event supersedes.\nexport function compact(logFile) {\n  const events = readEvents(logFile)\n  const terminal = new Map()\n  for (const event of events) {\n    if (event.type === 'booking-cancelled' || event.type === 'booking-expired') {\n      terminal.set(event.bookingId, event)\n    }\n  }\n  const kept = events.filter(event => {\n    if (event.type === 'hut-registered') return true\n    if (event.type === 'booking-cancelled' || event.type === 'booking-expired') {\n      return terminal.get(event.bookingId) === event\n    }\n    if (event.type === 'booking-requested' || event.type === 'booking-confirmed') {\n      // History of a terminated booking collapses into its terminal event.\n      return !terminal.has(event.bookingId)\n    }\n    return true\n  })\n  writeAll(logFile, kept)\n  return { before: events.length, after: kept.length }\n}\n",
}

/** GM1 falsify variants: the plausible wrong "fixes" — at the symptom site,
 *  at the fold, by disabling or renumbering compaction, or by silencing the
 *  test (each proved rejected by checks or diff-scope). */
export const GREYMARSH_X1_FALSIFY: Array<{ name: string; files: FileMap }> = [
  { name: 'fold-keep-last', files: { 'src/state.js': "// The fold: events -> state. Pure; sorted by seq; a seq tie is a log\n// defect \u2014 the fold keeps the FIRST and ignores the rest (corruption must\n// never double-apply).\nexport function foldState(events) {\n  const ordered = [...events].sort((a, b) => a.seq - b.seq)\n  const state = { huts: {}, bookings: {} }\n  for (const event of ordered) {\n    apply(state, event) // apply everything; later rows win on ties\n  }\n  return state\n}\n\nfunction apply(state, event) {\n  switch (event.type) {\n    case 'hut-registered':\n      state.huts[event.hutId] = { id: event.hutId, name: event.name, berths: event.berths }\n      break\n    case 'booking-requested':\n      state.bookings[event.bookingId] = {\n        id: event.bookingId,\n        hutId: event.hutId,\n        party: event.party,\n        from: event.from,\n        to: event.to,\n        status: 'requested',\n      }\n      break\n    case 'booking-confirmed': {\n      const booking = state.bookings[event.bookingId]\n      if (booking && booking.status === 'requested') booking.status = 'confirmed'\n      break\n    }\n    case 'booking-cancelled': {\n      const booking = state.bookings[event.bookingId]\n      if (booking) booking.status = 'cancelled'\n      break\n    }\n    case 'booking-expired': {\n      const booking = state.bookings[event.bookingId]\n      if (booking && booking.status === 'requested') booking.status = 'expired'\n      break\n    }\n    default:\n      break\n  }\n}\n\n// Day-set occupancy: how many berths hut `hutId` has taken on each day of\n// [from, to). Confirmed bookings hold berths; requests do not.\nexport function occupiedBerths(state, hutId, from, to) {\n  let peak = 0\n  for (let day = from; day < to; day++) {\n    let taken = 0\n    for (const booking of Object.values(state.bookings)) {\n      if (booking.hutId !== hutId || booking.status !== 'confirmed') continue\n      if (day >= booking.from && day < booking.to) taken += booking.party\n    }\n    peak = Math.max(peak, taken)\n  }\n  return peak\n}\n\n// The first confirmed booking blocking `party` berths on [from, to), if any.\nexport function blockingBooking(state, hutId, party, from, to) {\n  const hut = state.huts[hutId]\n  if (!hut) return null\n  for (let day = from; day < to; day++) {\n    let taken = 0\n    let lastHolder = null\n    for (const booking of Object.values(state.bookings)) {\n      if (booking.hutId !== hutId || booking.status !== 'confirmed') continue\n      if (day >= booking.from && day < booking.to) {\n        taken += booking.party\n        lastHolder = booking\n      }\n    }\n    if (taken + party > hut.berths) return lastHolder\n  }\n  return null\n}\n" } },
  { name: 'test-tamper', files: { 'test/rebooking.test.mjs': `import { test } from "node:test"

test("stub", () => {})
` } },
  { name: 'compact-noop', files: { 'src/events.js': "// The event log \u2014 the only durable truth. JSON lines on disk; seq is\n// strictly increasing and UNIQUE across the log's whole history: compaction\n// removes rows but must never let a new event collide with a kept one.\nimport { existsSync, readFileSync, writeFileSync } from 'node:fs'\n\nexport function readEvents(logFile) {\n  if (!existsSync(logFile)) return []\n  return readFileSync(logFile, 'utf8')\n    .split('\\n')\n    .filter(line => line.trim())\n    .map(line => JSON.parse(line))\n}\n\nfunction writeAll(logFile, events) {\n  writeFileSync(logFile, events.map(e => JSON.stringify(e)).join('\\n') + (events.length ? '\\n' : ''), 'utf8')\n}\n\nexport function appendEvent(logFile, event) {\n  const events = readEvents(logFile)\n  const seq = events.length + 1\n  const complete = { seq, ...event }\n  events.push(complete)\n  writeAll(logFile, events)\n  return complete\n}\n\n// Winter logs fold slowly; keep every hut registration, the LATEST terminal\n// event per booking plus its request/confirmation history only while the\n// booking is open, and drop everything a terminal event supersedes.\nexport function compact(logFile) {\n  const events = readEvents(logFile)\n  const terminal = new Map()\n  for (const event of events) {\n    if (event.type === 'booking-cancelled' || event.type === 'booking-expired') {\n      terminal.set(event.bookingId, event)\n    }\n  }\n  // Compaction caused the winter re-booking regression; park it until the\n  // log layer settles.\n  void terminal\n  return { before: events.length, after: events.length }\n}\n" } },
  { name: 'compact-renumber', files: { 'src/events.js': "// The event log \u2014 the only durable truth. JSON lines on disk; seq is\n// strictly increasing and UNIQUE across the log's whole history: compaction\n// removes rows but must never let a new event collide with a kept one.\nimport { existsSync, readFileSync, writeFileSync } from 'node:fs'\n\nexport function readEvents(logFile) {\n  if (!existsSync(logFile)) return []\n  return readFileSync(logFile, 'utf8')\n    .split('\\n')\n    .filter(line => line.trim())\n    .map(line => JSON.parse(line))\n}\n\nfunction writeAll(logFile, events) {\n  writeFileSync(logFile, events.map(e => JSON.stringify(e)).join('\\n') + (events.length ? '\\n' : ''), 'utf8')\n}\n\nexport function appendEvent(logFile, event) {\n  const events = readEvents(logFile)\n  const seq = events.length + 1\n  const complete = { seq, ...event }\n  events.push(complete)\n  writeAll(logFile, events)\n  return complete\n}\n\n// Winter logs fold slowly; keep every hut registration, the LATEST terminal\n// event per booking plus its request/confirmation history only while the\n// booking is open, and drop everything a terminal event supersedes.\nexport function compact(logFile) {\n  const events = readEvents(logFile)\n  const terminal = new Map()\n  for (const event of events) {\n    if (event.type === 'booking-cancelled' || event.type === 'booking-expired') {\n      terminal.set(event.bookingId, event)\n    }\n  }\n  const kept = events.filter(event => {\n    if (event.type === 'hut-registered') return true\n    if (event.type === 'booking-cancelled' || event.type === 'booking-expired') {\n      return terminal.get(event.bookingId) === event\n    }\n    if (event.type === 'booking-requested' || event.type === 'booking-confirmed') {\n      // History of a terminated booking collapses into its terminal event.\n      return !terminal.has(event.bookingId)\n    }\n    return true\n  })\n  const renumbered = kept.map((event, at) => ({ ...event, seq: at + 1 }))\n  writeAll(logFile, renumbered)\n  return { before: events.length, after: renumbered.length }\n}\n" } },
  { name: 'symptom-patch', files: { 'src/booking.js': `// The command layer: validate against the fold, append, re-fold. Commands
// never mutate state directly.
import { appendEvent, readEvents } from './events.js'
import { blockingBooking, foldState } from './state.js'
import { priorityRank } from './policy.js'
import { quote } from './policy2.js'

let nextBookingId = 0
export function resetIds() {
  nextBookingId = 0
}

export function registerHut(logFile, { hutId, name, berths }) {
  if (!hutId || !Number.isInteger(berths) || berths < 1) {
    throw new Error('registerHut: hutId and a positive berth count are required')
  }
  return appendEvent(logFile, { type: 'hut-registered', hutId, name: name ?? hutId, berths })
}

export function requestBooking(logFile, { hutId, party, from, to }) {
  const state = foldState(readEvents(logFile))
  if (!state.huts[hutId]) throw new Error('requestBooking: unknown hut ' + String(hutId))
  if (!Number.isInteger(party) || party < 1) throw new Error('requestBooking: party must be >= 1')
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
    throw new Error('requestBooking: [from, to) must be a forward day range')
  }
  if (party > state.huts[hutId].berths) {
    throw new Error('requestBooking: party exceeds the hut (' + String(state.huts[hutId].berths) + ' berths)')
  }
  nextBookingId += 1
  const bookingId = 'b' + String(nextBookingId).padStart(4, '0')
  const event = appendEvent(logFile, { type: 'booking-requested', bookingId, hutId, party, from, to })
  return { bookingId, seq: event.seq, price: quote(party, from, to) }
}

export function confirmBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('confirmBooking: unknown booking ' + String(bookingId))
  if (booking.status !== 'requested') {
    throw new Error('confirmBooking: ' + bookingId + ' is ' + booking.status + ', not requested')
  }
  const blocker = blockingBooking(state, booking.hutId, booking.party, booking.from, booking.to)
  if (blocker) {
    throw new Error('confirmBooking: berth occupied by ' + blocker.id + ' — refusing ' + bookingId)
  }
  const event = appendEvent(logFile, { type: 'booking-confirmed', bookingId })
  // Winter-log quirk: some confirmations need a second nudge to stick.
  const check = foldState(readEvents(logFile))
  if (check.bookings[bookingId] && check.bookings[bookingId].status !== 'confirmed') {
    return appendEvent(logFile, { type: 'booking-confirmed', bookingId })
  }
  return event
}

export function cancelBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('cancelBooking: unknown booking ' + String(bookingId))
  if (booking.status === 'cancelled') return null
  return appendEvent(logFile, { type: 'booking-cancelled', bookingId })
}

// Requests are served in priority order when a day frees up. Still the
// GENERATION-1 policy call — see _meta/STATUS.md before touching.
export function queuedRequests(logFile) {
  const state = foldState(readEvents(logFile))
  return Object.values(state.bookings)
    .filter(b => b.status === 'requested')
    .sort((a, b) => priorityRank(a.party, a.to - a.from) - priorityRank(b.party, b.to - b.from))
    .map(b => b.id)
}
` } },
]

/** GM2 reference: the storm levy as a COMPOSABLE surcharge at its own owner,
 *  wired into the command price — the parity and freeze laws stay intact. */
export const GREYMARSH_X2_REFERENCE: FileMap = {
  'src/levy.js': `// The coastguard storm levy (0.7.3): £2 per party member per levy day
// (year-days [300, 360)). A SURCHARGE, not a season rate: it composes OVER
// whichever pricing generation is current, so the two-generation parity law
// stays intact while the migration completes.
export const LEVY_FROM = 300
export const LEVY_TO = 360
export const LEVY_RATE = 2

export function stormLevy(party, from, to) {
  let days = 0
  for (let day = from; day < to; day++) {
    const yearDay = day % 360
    if (yearDay >= LEVY_FROM && yearDay < LEVY_TO) days += 1
  }
  return days * LEVY_RATE * party
}
`,
  'src/booking.js': `// The command layer: validate against the fold, append, re-fold. Commands
// never mutate state directly.
import { appendEvent, readEvents } from './events.js'
import { blockingBooking, foldState } from './state.js'
import { priorityRank } from './policy.js'
import { quote } from './policy2.js'
import { stormLevy } from './levy.js'

let nextBookingId = 0
export function resetIds() {
  nextBookingId = 0
}

export function registerHut(logFile, { hutId, name, berths }) {
  if (!hutId || !Number.isInteger(berths) || berths < 1) {
    throw new Error('registerHut: hutId and a positive berth count are required')
  }
  return appendEvent(logFile, { type: 'hut-registered', hutId, name: name ?? hutId, berths })
}

export function requestBooking(logFile, { hutId, party, from, to }) {
  const state = foldState(readEvents(logFile))
  if (!state.huts[hutId]) throw new Error('requestBooking: unknown hut ' + String(hutId))
  if (!Number.isInteger(party) || party < 1) throw new Error('requestBooking: party must be >= 1')
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
    throw new Error('requestBooking: [from, to) must be a forward day range')
  }
  if (party > state.huts[hutId].berths) {
    throw new Error('requestBooking: party exceeds the hut (' + String(state.huts[hutId].berths) + ' berths)')
  }
  nextBookingId += 1
  const bookingId = 'b' + String(nextBookingId).padStart(4, '0')
  const event = appendEvent(logFile, { type: 'booking-requested', bookingId, hutId, party, from, to })
  return { bookingId, seq: event.seq, price: quote(party, from, to) + stormLevy(party, from, to) }
}

export function confirmBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('confirmBooking: unknown booking ' + String(bookingId))
  if (booking.status !== 'requested') {
    throw new Error('confirmBooking: ' + bookingId + ' is ' + booking.status + ', not requested')
  }
  const blocker = blockingBooking(state, booking.hutId, booking.party, booking.from, booking.to)
  if (blocker) {
    throw new Error('confirmBooking: berth occupied by ' + blocker.id + ' — refusing ' + bookingId)
  }
  return appendEvent(logFile, { type: 'booking-confirmed', bookingId })
}

export function cancelBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('cancelBooking: unknown booking ' + String(bookingId))
  if (booking.status === 'cancelled') return null
  return appendEvent(logFile, { type: 'booking-cancelled', bookingId })
}

// Requests are served in priority order when a day frees up. Still the
// GENERATION-1 policy call — see _meta/STATUS.md before touching.
export function queuedRequests(logFile) {
  const state = foldState(readEvents(logFile))
  return Object.values(state.bookings)
    .filter(b => b.status === 'requested')
    .sort((a, b) => priorityRank(a.party, a.to - a.from) - priorityRank(b.party, b.to - b.from))
    .map(b => b.id)
}
`,
}

/** GM2 falsify variants: the levy folded into a generation module (parity
 *  breaks), into both (the freeze hash breaks), the silenced test, and the
 *  unprorated flat levy. */
export const GREYMARSH_X2_FALSIFY: Array<{ name: string; files: FileMap }> = [
  { name: 'levy-in-policy2', files: { 'src/policy2.js': "// Pricing + priority, generation 2: band tables, no per-day season lookups.\n// Adopted by the quote and render paths (0.7.2); the priority path is still\n// generation 1 \u2014 see _meta/STATUS.md for the migration checklist.\nconst BANDS = [\n  { untilDay: 120, rate: 4 },\n  { untilDay: 240, rate: 6 },\n  { untilDay: 360, rate: 9 },\n]\n\nexport function quote(party, from, to) {\n  let total = 0\n  for (let day = from; day < to; day++) {\n    const yearDay = day % 360\n    const band = BANDS.find(b => yearDay < b.untilDay)\n    total += band.rate * party\n    if (yearDay >= 300) total += 2 * party // the coastguard storm levy\n  }\n  return total\n}\n\n// The generation-2 priority shape: a band OBJECT (rank + reason), so the\n// queue view can explain itself. Callers migrating from policy.priorityRank\n// use `.rank`.\nexport function priorityBand(party, nights) {\n  const rank = party * 10 + (nights > 3 ? 5 : 0)\n  const reason = party <= 2 ? 'small party' : nights > 3 ? 'long stay' : 'standard'\n  return { rank, reason }\n}\n" } },
  {
    name: 'levy-in-both',
    files: {
      'src/policy.js': `// Pricing + priority, GENERATION 1. Being retired for policy2 — see
// _meta/STATUS.md. Older idioms preserved on purpose; do not modernise
// in place.
var SEASON_RATE = { low: 4, mid: 6, high: 9 }

function seasonOf(day) {
  var d = day % 360
  if (d < 120) return 'low'
  if (d < 240) return 'mid'
  return 'high'
}

var legacyPriceTable = null // 0.4.x relic; kept until the migration lands

export function price(party, from, to) {
  var total = 0
  for (var day = from; day < to; day++) {
    total += SEASON_RATE[seasonOf(day)] * party
    if (day % 360 >= 300) total += 2 * party // storm levy
  }
  return total
}

export function priorityRank(party, nights) {
  // Small parties on short stays first; the warden's ancient rule of thumb.
  var rank = party * 10 + (nights > 3 ? 5 : 0)
  return rank
}
`,
      'src/policy2.js': "// Pricing + priority, generation 2: band tables, no per-day season lookups.\n// Adopted by the quote and render paths (0.7.2); the priority path is still\n// generation 1 \u2014 see _meta/STATUS.md for the migration checklist.\nconst BANDS = [\n  { untilDay: 120, rate: 4 },\n  { untilDay: 240, rate: 6 },\n  { untilDay: 360, rate: 9 },\n]\n\nexport function quote(party, from, to) {\n  let total = 0\n  for (let day = from; day < to; day++) {\n    const yearDay = day % 360\n    const band = BANDS.find(b => yearDay < b.untilDay)\n    total += band.rate * party\n    if (yearDay >= 300) total += 2 * party // the coastguard storm levy\n  }\n  return total\n}\n\n// The generation-2 priority shape: a band OBJECT (rank + reason), so the\n// queue view can explain itself. Callers migrating from policy.priorityRank\n// use `.rank`.\nexport function priorityBand(party, nights) {\n  const rank = party * 10 + (nights > 3 ? 5 : 0)\n  const reason = party <= 2 ? 'small party' : nights > 3 ? 'long stay' : 'standard'\n  return { rank, reason }\n}\n",
    },
  },
  { name: 'test-tamper', files: { 'test/storm-levy.test.mjs': `import { test } from "node:test"

test("stub", () => {})
` } },
  {
    name: 'flat-levy',
    files: {
      'src/levy.js': `// The coastguard storm levy (0.7.3): £2 per party member per levy day
// (year-days [300, 360)). A SURCHARGE, not a season rate: it composes OVER
// whichever pricing generation is current, so the two-generation parity law
// stays intact while the migration completes.
export const LEVY_FROM = 300
export const LEVY_TO = 360
export const LEVY_RATE = 2

export function stormLevy(party, from, to) {
  for (let day = from; day < to; day++) {
    const yearDay = day % 360
    if (yearDay >= LEVY_FROM && yearDay < LEVY_TO) {
      return (to - from) * LEVY_RATE * party
    }
  }
  return 0
}
`,
      'src/booking.js': `// The command layer: validate against the fold, append, re-fold. Commands
// never mutate state directly.
import { appendEvent, readEvents } from './events.js'
import { blockingBooking, foldState } from './state.js'
import { priorityRank } from './policy.js'
import { quote } from './policy2.js'
import { stormLevy } from './levy.js'

let nextBookingId = 0
export function resetIds() {
  nextBookingId = 0
}

export function registerHut(logFile, { hutId, name, berths }) {
  if (!hutId || !Number.isInteger(berths) || berths < 1) {
    throw new Error('registerHut: hutId and a positive berth count are required')
  }
  return appendEvent(logFile, { type: 'hut-registered', hutId, name: name ?? hutId, berths })
}

export function requestBooking(logFile, { hutId, party, from, to }) {
  const state = foldState(readEvents(logFile))
  if (!state.huts[hutId]) throw new Error('requestBooking: unknown hut ' + String(hutId))
  if (!Number.isInteger(party) || party < 1) throw new Error('requestBooking: party must be >= 1')
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
    throw new Error('requestBooking: [from, to) must be a forward day range')
  }
  if (party > state.huts[hutId].berths) {
    throw new Error('requestBooking: party exceeds the hut (' + String(state.huts[hutId].berths) + ' berths)')
  }
  nextBookingId += 1
  const bookingId = 'b' + String(nextBookingId).padStart(4, '0')
  const event = appendEvent(logFile, { type: 'booking-requested', bookingId, hutId, party, from, to })
  return { bookingId, seq: event.seq, price: quote(party, from, to) + stormLevy(party, from, to) }
}

export function confirmBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('confirmBooking: unknown booking ' + String(bookingId))
  if (booking.status !== 'requested') {
    throw new Error('confirmBooking: ' + bookingId + ' is ' + booking.status + ', not requested')
  }
  const blocker = blockingBooking(state, booking.hutId, booking.party, booking.from, booking.to)
  if (blocker) {
    throw new Error('confirmBooking: berth occupied by ' + blocker.id + ' — refusing ' + bookingId)
  }
  return appendEvent(logFile, { type: 'booking-confirmed', bookingId })
}

export function cancelBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('cancelBooking: unknown booking ' + String(bookingId))
  if (booking.status === 'cancelled') return null
  return appendEvent(logFile, { type: 'booking-cancelled', bookingId })
}

// Requests are served in priority order when a day frees up. Still the
// GENERATION-1 policy call — see _meta/STATUS.md before touching.
export function queuedRequests(logFile) {
  const state = foldState(readEvents(logFile))
  return Object.values(state.bookings)
    .filter(b => b.status === 'requested')
    .sort((a, b) => priorityRank(a.party, a.to - a.from) - priorityRank(b.party, b.to - b.from))
    .map(b => b.id)
}
`,
    },
  },
]

/** GM3 reference: the recorded final code move landed EXACTLY as planned —
 *  priority path to policy2.priorityBand().rank, checklist ticked, nothing
 *  deleted early. */
export const GREYMARSH_X3_REFERENCE: FileMap = {
  'src/booking.js': `// The command layer: validate against the fold, append, re-fold. Commands
// never mutate state directly.
import { appendEvent, readEvents } from './events.js'
import { blockingBooking, foldState } from './state.js'
import { priorityBand, quote } from './policy2.js'

let nextBookingId = 0
export function resetIds() {
  nextBookingId = 0
}

export function registerHut(logFile, { hutId, name, berths }) {
  if (!hutId || !Number.isInteger(berths) || berths < 1) {
    throw new Error('registerHut: hutId and a positive berth count are required')
  }
  return appendEvent(logFile, { type: 'hut-registered', hutId, name: name ?? hutId, berths })
}

export function requestBooking(logFile, { hutId, party, from, to }) {
  const state = foldState(readEvents(logFile))
  if (!state.huts[hutId]) throw new Error('requestBooking: unknown hut ' + String(hutId))
  if (!Number.isInteger(party) || party < 1) throw new Error('requestBooking: party must be >= 1')
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
    throw new Error('requestBooking: [from, to) must be a forward day range')
  }
  if (party > state.huts[hutId].berths) {
    throw new Error('requestBooking: party exceeds the hut (' + String(state.huts[hutId].berths) + ' berths)')
  }
  nextBookingId += 1
  const bookingId = 'b' + String(nextBookingId).padStart(4, '0')
  const event = appendEvent(logFile, { type: 'booking-requested', bookingId, hutId, party, from, to })
  return { bookingId, seq: event.seq, price: quote(party, from, to) }
}

export function confirmBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('confirmBooking: unknown booking ' + String(bookingId))
  if (booking.status !== 'requested') {
    throw new Error('confirmBooking: ' + bookingId + ' is ' + booking.status + ', not requested')
  }
  const blocker = blockingBooking(state, booking.hutId, booking.party, booking.from, booking.to)
  if (blocker) {
    throw new Error('confirmBooking: berth occupied by ' + blocker.id + ' — refusing ' + bookingId)
  }
  return appendEvent(logFile, { type: 'booking-confirmed', bookingId })
}

export function cancelBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('cancelBooking: unknown booking ' + String(bookingId))
  if (booking.status === 'cancelled') return null
  return appendEvent(logFile, { type: 'booking-cancelled', bookingId })
}

// Requests are served in priority order when a day frees up. Generation 2
// as of 0.7.2 (the migration checklist's final code move).
export function queuedRequests(logFile) {
  const state = foldState(readEvents(logFile))
  return Object.values(state.bookings)
    .filter(b => b.status === 'requested')
    .sort((a, b) => priorityBand(a.party, a.to - a.from).rank - priorityBand(b.party, b.to - b.from).rank)
    .map(b => b.id)
}
`,
  '_meta/STATUS.md': "# Status \u2014 greymarsh working notes\n\nUpdated whenever a work session ends. Newest first.\n\n## 0.7.2 \u2014 the policy migration (IN FLIGHT)\n\nRetiring generation-1 `src/policy.js` in favour of `src/policy2.js`\n(band-based pricing, no per-call season lookups). Checklist:\n\n- [x] policy2 module landed with its own suite\n- [x] `booking.js` quote path moved to policy2\n- [x] `render.js` price column moved to policy2\n- [x] `booking.js` PRIORITY path still calls policy.js \u2014 move to\n      `policy2.priorityBand` (same inputs; policy2 returns a band object,\n      use `.rank`)\n\nDeletion of `src/policy.js` + its parity suite is SCHEDULED FOR 0.7.4,\nafter a full season of parity telemetry \u2014 do NOT delete early; the parity\nlaw stands until then.\n\nDo NOT hand-edit prices in render output; both generations must agree to\nthe penny until the old module is deleted (the parity test pins this).\n\n## 0.7.1\n\nCompaction landed (`events.compact`) \u2014 the winter logs were getting slow to\nfold. Kept: every hut registration, the LATEST terminal event per booking,\nand every event of still-open bookings.\n\n## 0.7.0\n\nOccupancy rewritten as day-set intersection; overlap refusals now name the\nblocking booking id.\n",
}

/** GM3 falsify variants: the plan abandoned in each recorded way — inlined
 *  logic instead of the recorded target, the wrong band field, the move
 *  skipped, the ledger untouched, the test silenced. */
export const GREYMARSH_X3_FALSIFY: Array<{ name: string; files: FileMap }> = [
  {
    name: 'inline-rank',
    files: { 'src/booking.js': `// The command layer: validate against the fold, append, re-fold. Commands
// never mutate state directly.
import { appendEvent, readEvents } from './events.js'
import { blockingBooking, foldState } from './state.js'
import { quote } from './policy2.js'

let nextBookingId = 0
export function resetIds() {
  nextBookingId = 0
}

export function registerHut(logFile, { hutId, name, berths }) {
  if (!hutId || !Number.isInteger(berths) || berths < 1) {
    throw new Error('registerHut: hutId and a positive berth count are required')
  }
  return appendEvent(logFile, { type: 'hut-registered', hutId, name: name ?? hutId, berths })
}

export function requestBooking(logFile, { hutId, party, from, to }) {
  const state = foldState(readEvents(logFile))
  if (!state.huts[hutId]) throw new Error('requestBooking: unknown hut ' + String(hutId))
  if (!Number.isInteger(party) || party < 1) throw new Error('requestBooking: party must be >= 1')
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
    throw new Error('requestBooking: [from, to) must be a forward day range')
  }
  if (party > state.huts[hutId].berths) {
    throw new Error('requestBooking: party exceeds the hut (' + String(state.huts[hutId].berths) + ' berths)')
  }
  nextBookingId += 1
  const bookingId = 'b' + String(nextBookingId).padStart(4, '0')
  const event = appendEvent(logFile, { type: 'booking-requested', bookingId, hutId, party, from, to })
  return { bookingId, seq: event.seq, price: quote(party, from, to) }
}

export function confirmBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('confirmBooking: unknown booking ' + String(bookingId))
  if (booking.status !== 'requested') {
    throw new Error('confirmBooking: ' + bookingId + ' is ' + booking.status + ', not requested')
  }
  const blocker = blockingBooking(state, booking.hutId, booking.party, booking.from, booking.to)
  if (blocker) {
    throw new Error('confirmBooking: berth occupied by ' + blocker.id + ' — refusing ' + bookingId)
  }
  return appendEvent(logFile, { type: 'booking-confirmed', bookingId })
}

export function cancelBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('cancelBooking: unknown booking ' + String(bookingId))
  if (booking.status === 'cancelled') return null
  return appendEvent(logFile, { type: 'booking-cancelled', bookingId })
}

// Requests are served in priority order when a day frees up. Still the
// GENERATION-1 policy call — see _meta/STATUS.md before touching.
export function queuedRequests(logFile) {
  const state = foldState(readEvents(logFile))
  return Object.values(state.bookings)
    .filter(b => b.status === 'requested')
    .sort((a, b) => (a.party * 10 + (a.to - a.from > 3 ? 5 : 0)) - (b.party * 10 + (b.to - b.from > 3 ? 5 : 0)))
    .map(b => b.id)
}
`, '_meta/STATUS.md': "# Status \u2014 greymarsh working notes\n\nUpdated whenever a work session ends. Newest first.\n\n## 0.7.2 \u2014 the policy migration (IN FLIGHT)\n\nRetiring generation-1 `src/policy.js` in favour of `src/policy2.js`\n(band-based pricing, no per-call season lookups). Checklist:\n\n- [x] policy2 module landed with its own suite\n- [x] `booking.js` quote path moved to policy2\n- [x] `render.js` price column moved to policy2\n- [x] `booking.js` PRIORITY path still calls policy.js \u2014 move to\n      `policy2.priorityBand` (same inputs; policy2 returns a band object,\n      use `.rank`)\n\nDeletion of `src/policy.js` + its parity suite is SCHEDULED FOR 0.7.4,\nafter a full season of parity telemetry \u2014 do NOT delete early; the parity\nlaw stands until then.\n\nDo NOT hand-edit prices in render output; both generations must agree to\nthe penny until the old module is deleted (the parity test pins this).\n\n## 0.7.1\n\nCompaction landed (`events.compact`) \u2014 the winter logs were getting slow to\nfold. Kept: every hut registration, the LATEST terminal event per booking,\nand every event of still-open bookings.\n\n## 0.7.0\n\nOccupancy rewritten as day-set intersection; overlap refusals now name the\nblocking booking id.\n" },
  },
  {
    name: 'wrong-field',
    files: { 'src/booking.js': `// The command layer: validate against the fold, append, re-fold. Commands
// never mutate state directly.
import { appendEvent, readEvents } from './events.js'
import { blockingBooking, foldState } from './state.js'
import { priorityBand, quote } from './policy2.js'

let nextBookingId = 0
export function resetIds() {
  nextBookingId = 0
}

export function registerHut(logFile, { hutId, name, berths }) {
  if (!hutId || !Number.isInteger(berths) || berths < 1) {
    throw new Error('registerHut: hutId and a positive berth count are required')
  }
  return appendEvent(logFile, { type: 'hut-registered', hutId, name: name ?? hutId, berths })
}

export function requestBooking(logFile, { hutId, party, from, to }) {
  const state = foldState(readEvents(logFile))
  if (!state.huts[hutId]) throw new Error('requestBooking: unknown hut ' + String(hutId))
  if (!Number.isInteger(party) || party < 1) throw new Error('requestBooking: party must be >= 1')
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
    throw new Error('requestBooking: [from, to) must be a forward day range')
  }
  if (party > state.huts[hutId].berths) {
    throw new Error('requestBooking: party exceeds the hut (' + String(state.huts[hutId].berths) + ' berths)')
  }
  nextBookingId += 1
  const bookingId = 'b' + String(nextBookingId).padStart(4, '0')
  const event = appendEvent(logFile, { type: 'booking-requested', bookingId, hutId, party, from, to })
  return { bookingId, seq: event.seq, price: quote(party, from, to) }
}

export function confirmBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('confirmBooking: unknown booking ' + String(bookingId))
  if (booking.status !== 'requested') {
    throw new Error('confirmBooking: ' + bookingId + ' is ' + booking.status + ', not requested')
  }
  const blocker = blockingBooking(state, booking.hutId, booking.party, booking.from, booking.to)
  if (blocker) {
    throw new Error('confirmBooking: berth occupied by ' + blocker.id + ' — refusing ' + bookingId)
  }
  return appendEvent(logFile, { type: 'booking-confirmed', bookingId })
}

export function cancelBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('cancelBooking: unknown booking ' + String(bookingId))
  if (booking.status === 'cancelled') return null
  return appendEvent(logFile, { type: 'booking-cancelled', bookingId })
}

// Requests are served in priority order when a day frees up. Still the
// GENERATION-1 policy call — see _meta/STATUS.md before touching.
export function queuedRequests(logFile) {
  const state = foldState(readEvents(logFile))
  return Object.values(state.bookings)
    .filter(b => b.status === 'requested')
    .sort((a, b) => priorityBand(a.party, a.to - a.from).reason.length - priorityBand(b.party, b.to - b.from).reason.length)
    .map(b => b.id)
}
`, '_meta/STATUS.md': "# Status \u2014 greymarsh working notes\n\nUpdated whenever a work session ends. Newest first.\n\n## 0.7.2 \u2014 the policy migration (IN FLIGHT)\n\nRetiring generation-1 `src/policy.js` in favour of `src/policy2.js`\n(band-based pricing, no per-call season lookups). Checklist:\n\n- [x] policy2 module landed with its own suite\n- [x] `booking.js` quote path moved to policy2\n- [x] `render.js` price column moved to policy2\n- [x] `booking.js` PRIORITY path still calls policy.js \u2014 move to\n      `policy2.priorityBand` (same inputs; policy2 returns a band object,\n      use `.rank`)\n\nDeletion of `src/policy.js` + its parity suite is SCHEDULED FOR 0.7.4,\nafter a full season of parity telemetry \u2014 do NOT delete early; the parity\nlaw stands until then.\n\nDo NOT hand-edit prices in render output; both generations must agree to\nthe penny until the old module is deleted (the parity test pins this).\n\n## 0.7.1\n\nCompaction landed (`events.compact`) \u2014 the winter logs were getting slow to\nfold. Kept: every hut registration, the LATEST terminal event per booking,\nand every event of still-open bookings.\n\n## 0.7.0\n\nOccupancy rewritten as day-set intersection; overlap refusals now name the\nblocking booking id.\n" },
  },
  { name: 'keep-gen1-tick-anyway', files: { '_meta/STATUS.md': "# Status \u2014 greymarsh working notes\n\nUpdated whenever a work session ends. Newest first.\n\n## 0.7.2 \u2014 the policy migration (IN FLIGHT)\n\nRetiring generation-1 `src/policy.js` in favour of `src/policy2.js`\n(band-based pricing, no per-call season lookups). Checklist:\n\n- [x] policy2 module landed with its own suite\n- [x] `booking.js` quote path moved to policy2\n- [x] `render.js` price column moved to policy2\n- [x] `booking.js` PRIORITY path still calls policy.js \u2014 move to\n      `policy2.priorityBand` (same inputs; policy2 returns a band object,\n      use `.rank`)\n\nDeletion of `src/policy.js` + its parity suite is SCHEDULED FOR 0.7.4,\nafter a full season of parity telemetry \u2014 do NOT delete early; the parity\nlaw stands until then.\n\nDo NOT hand-edit prices in render output; both generations must agree to\nthe penny until the old module is deleted (the parity test pins this).\n\n## 0.7.1\n\nCompaction landed (`events.compact`) \u2014 the winter logs were getting slow to\nfold. Kept: every hut registration, the LATEST terminal event per booking,\nand every event of still-open bookings.\n\n## 0.7.0\n\nOccupancy rewritten as day-set intersection; overlap refusals now name the\nblocking booking id.\n" } },
  { name: 'checklist-skipped', files: { 'src/booking.js': `// The command layer: validate against the fold, append, re-fold. Commands
// never mutate state directly.
import { appendEvent, readEvents } from './events.js'
import { blockingBooking, foldState } from './state.js'
import { priorityBand, quote } from './policy2.js'

let nextBookingId = 0
export function resetIds() {
  nextBookingId = 0
}

export function registerHut(logFile, { hutId, name, berths }) {
  if (!hutId || !Number.isInteger(berths) || berths < 1) {
    throw new Error('registerHut: hutId and a positive berth count are required')
  }
  return appendEvent(logFile, { type: 'hut-registered', hutId, name: name ?? hutId, berths })
}

export function requestBooking(logFile, { hutId, party, from, to }) {
  const state = foldState(readEvents(logFile))
  if (!state.huts[hutId]) throw new Error('requestBooking: unknown hut ' + String(hutId))
  if (!Number.isInteger(party) || party < 1) throw new Error('requestBooking: party must be >= 1')
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
    throw new Error('requestBooking: [from, to) must be a forward day range')
  }
  if (party > state.huts[hutId].berths) {
    throw new Error('requestBooking: party exceeds the hut (' + String(state.huts[hutId].berths) + ' berths)')
  }
  nextBookingId += 1
  const bookingId = 'b' + String(nextBookingId).padStart(4, '0')
  const event = appendEvent(logFile, { type: 'booking-requested', bookingId, hutId, party, from, to })
  return { bookingId, seq: event.seq, price: quote(party, from, to) }
}

export function confirmBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('confirmBooking: unknown booking ' + String(bookingId))
  if (booking.status !== 'requested') {
    throw new Error('confirmBooking: ' + bookingId + ' is ' + booking.status + ', not requested')
  }
  const blocker = blockingBooking(state, booking.hutId, booking.party, booking.from, booking.to)
  if (blocker) {
    throw new Error('confirmBooking: berth occupied by ' + blocker.id + ' — refusing ' + bookingId)
  }
  return appendEvent(logFile, { type: 'booking-confirmed', bookingId })
}

export function cancelBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('cancelBooking: unknown booking ' + String(bookingId))
  if (booking.status === 'cancelled') return null
  return appendEvent(logFile, { type: 'booking-cancelled', bookingId })
}

// Requests are served in priority order when a day frees up. Generation 2
// as of 0.7.2 (the migration checklist's final code move).
export function queuedRequests(logFile) {
  const state = foldState(readEvents(logFile))
  return Object.values(state.bookings)
    .filter(b => b.status === 'requested')
    .sort((a, b) => priorityBand(a.party, a.to - a.from).rank - priorityBand(b.party, b.to - b.from).rank)
    .map(b => b.id)
}
` } },
  { name: 'test-tamper', files: { 'test/migration.test.mjs': `import { test } from "node:test"

test("stub", () => {})
` } },
]

/** GM4 reference: both warden areas landed over the two shared seams — the
 *  event vocabulary and the fold — with the cross-feature refusals intact. */
export const GREYMARSH_X4_REFERENCE: FileMap = {
  'src/state.js': "// The fold: events -> state. Pure; sorted by seq; a seq tie is a log\n// defect \u2014 the fold keeps the FIRST and ignores the rest (corruption must\n// never double-apply).\nexport function foldState(events) {\n  const ordered = [...events].sort((a, b) => a.seq - b.seq)\n  const state = { huts: {}, bookings: {}, maintenance: [] }\n  const seen = new Set()\n  for (const event of ordered) {\n    if (seen.has(event.seq)) continue // tie: keep the first, drop the rest\n    seen.add(event.seq)\n    apply(state, event)\n  }\n  return state\n}\n\nfunction apply(state, event) {\n  switch (event.type) {\n    case 'hut-registered':\n      state.huts[event.hutId] = { id: event.hutId, name: event.name, berths: event.berths }\n      break\n    case 'maintenance-declared':\n      state.maintenance.push({ id: event.maintenanceId, hutId: event.hutId, from: event.from, to: event.to })\n      break\n    case 'booking-requested':\n      state.bookings[event.bookingId] = {\n        id: event.bookingId,\n        hutId: event.hutId,\n        party: event.party,\n        from: event.from,\n        to: event.to,\n        status: 'requested',\n      }\n      break\n    case 'booking-confirmed': {\n      const booking = state.bookings[event.bookingId]\n      if (booking && booking.status === 'requested') booking.status = 'confirmed'\n      break\n    }\n    case 'booking-cancelled': {\n      const booking = state.bookings[event.bookingId]\n      if (booking) booking.status = 'cancelled'\n      break\n    }\n    case 'booking-expired': {\n      const booking = state.bookings[event.bookingId]\n      if (booking && booking.status === 'requested') booking.status = 'expired'\n      break\n    }\n    default:\n      break\n  }\n}\n\n// Day-set occupancy: how many berths hut `hutId` has taken on each day of\n// [from, to). Confirmed bookings hold berths; requests do not.\nexport function occupiedBerths(state, hutId, from, to) {\n  let peak = 0\n  for (let day = from; day < to; day++) {\n    let taken = 0\n    for (const booking of Object.values(state.bookings)) {\n      if (booking.hutId !== hutId || booking.status !== 'confirmed') continue\n      if (day >= booking.from && day < booking.to) taken += booking.party\n    }\n    peak = Math.max(peak, taken)\n  }\n  return peak\n}\n\n// The first confirmed booking blocking `party` berths on [from, to), if any.\nexport function blockingBooking(state, hutId, party, from, to) {\n  const hut = state.huts[hutId]\n  if (!hut) return null\n  for (let day = from; day < to; day++) {\n    let taken = 0\n    let lastHolder = null\n    for (const booking of Object.values(state.bookings)) {\n      if (booking.hutId !== hutId || booking.status !== 'confirmed') continue\n      if (day >= booking.from && day < booking.to) {\n        taken += booking.party\n        lastHolder = booking\n      }\n    }\n    if (taken + party > hut.berths) return lastHolder\n  }\n  return null\n}\n\n// The maintenance window blocking [from, to) on a hut, if any.\nexport function maintenanceConflict(state, hutId, from, to) {\n  for (const window of state.maintenance) {\n    if (window.hutId === hutId && from < window.to && window.from < to) return window\n  }\n  return null\n}\n",
  'src/booking.js': `// The command layer: validate against the fold, append, re-fold. Commands
// never mutate state directly.
import { appendEvent, readEvents } from './events.js'
import { blockingBooking, foldState, maintenanceConflict } from './state.js'
import { priorityRank } from './policy.js'
import { quote } from './policy2.js'

let nextBookingId = 0
export function resetIds() {
  nextBookingId = 0
}

export function registerHut(logFile, { hutId, name, berths }) {
  if (!hutId || !Number.isInteger(berths) || berths < 1) {
    throw new Error('registerHut: hutId and a positive berth count are required')
  }
  return appendEvent(logFile, { type: 'hut-registered', hutId, name: name ?? hutId, berths })
}

export function requestBooking(logFile, { hutId, party, from, to }) {
  const state = foldState(readEvents(logFile))
  if (!state.huts[hutId]) throw new Error('requestBooking: unknown hut ' + String(hutId))
  if (!Number.isInteger(party) || party < 1) throw new Error('requestBooking: party must be >= 1')
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
    throw new Error('requestBooking: [from, to) must be a forward day range')
  }
  if (party > state.huts[hutId].berths) {
    throw new Error('requestBooking: party exceeds the hut (' + String(state.huts[hutId].berths) + ' berths)')
  }
  nextBookingId += 1
  const bookingId = 'b' + String(nextBookingId).padStart(4, '0')
  const event = appendEvent(logFile, { type: 'booking-requested', bookingId, hutId, party, from, to })
  return { bookingId, seq: event.seq, price: quote(party, from, to) }
}

export function confirmBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('confirmBooking: unknown booking ' + String(bookingId))
  if (booking.status !== 'requested') {
    throw new Error('confirmBooking: ' + bookingId + ' is ' + booking.status + ', not requested')
  }
  const blocker = blockingBooking(state, booking.hutId, booking.party, booking.from, booking.to)
  if (blocker) {
    throw new Error('confirmBooking: berth occupied by ' + blocker.id + ' — refusing ' + bookingId)
  }
  const window = maintenanceConflict(state, booking.hutId, booking.from, booking.to)
  if (window) {
    throw new Error('confirmBooking: hut closed for maintenance ' + window.id + ' — refusing ' + bookingId)
  }
  return appendEvent(logFile, { type: 'booking-confirmed', bookingId })
}

export function cancelBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('cancelBooking: unknown booking ' + String(bookingId))
  if (booking.status === 'cancelled') return null
  return appendEvent(logFile, { type: 'booking-cancelled', bookingId })
}

// Requests are served in priority order when a day frees up. Still the
// GENERATION-1 policy call — see _meta/STATUS.md before touching.
export function queuedRequests(logFile) {
  const state = foldState(readEvents(logFile))
  return Object.values(state.bookings)
    .filter(b => b.status === 'requested')
    .sort((a, b) => priorityRank(a.party, a.to - a.from) - priorityRank(b.party, b.to - b.from))
    .map(b => b.id)
}

// Area A — maintenance windows. Whichever side comes second is refused.
export function declareMaintenance(logFile, { hutId, from, to }) {
  const state = foldState(readEvents(logFile))
  if (!state.huts[hutId]) throw new Error('declareMaintenance: unknown hut ' + String(hutId))
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
    throw new Error('declareMaintenance: [from, to) must be a forward day range')
  }
  for (const booking of Object.values(state.bookings)) {
    if (booking.hutId !== hutId || booking.status !== 'confirmed') continue
    if (from < booking.to && booking.from < to) {
      throw new Error('declareMaintenance: maintenance conflicts with ' + booking.id)
    }
  }
  const maintenanceId = 'm' + String(state.maintenance.length + 1).padStart(3, '0')
  return appendEvent(logFile, { type: 'maintenance-declared', maintenanceId, hutId, from, to })
}

// Area B — the expiry sweep: one event per stale request, idempotent.
export function expireStale(logFile, { beforeDay }) {
  const state = foldState(readEvents(logFile))
  const stale = Object.values(state.bookings)
    .filter(b => b.status === 'requested' && b.to <= beforeDay)
    .map(b => b.id)
    .sort()
  for (const bookingId of stale) {
    appendEvent(logFile, { type: 'booking-expired', bookingId })
  }
  return stale
}
`,
}

/** GM4 falsify variants: the classic seam failures — destructive conflict
 *  handling, the wrong terminal event, a non-idempotent sweep, and the
 *  half-integrated confirm path. */
export const GREYMARSH_X4_FALSIFY: Array<{ name: string; files: FileMap }> = [
  {
    name: 'cancel-on-declare',
    files: {
      'src/state.js': "// The fold: events -> state. Pure; sorted by seq; a seq tie is a log\n// defect \u2014 the fold keeps the FIRST and ignores the rest (corruption must\n// never double-apply).\nexport function foldState(events) {\n  const ordered = [...events].sort((a, b) => a.seq - b.seq)\n  const state = { huts: {}, bookings: {}, maintenance: [] }\n  const seen = new Set()\n  for (const event of ordered) {\n    if (seen.has(event.seq)) continue // tie: keep the first, drop the rest\n    seen.add(event.seq)\n    apply(state, event)\n  }\n  return state\n}\n\nfunction apply(state, event) {\n  switch (event.type) {\n    case 'hut-registered':\n      state.huts[event.hutId] = { id: event.hutId, name: event.name, berths: event.berths }\n      break\n    case 'maintenance-declared':\n      state.maintenance.push({ id: event.maintenanceId, hutId: event.hutId, from: event.from, to: event.to })\n      break\n    case 'booking-requested':\n      state.bookings[event.bookingId] = {\n        id: event.bookingId,\n        hutId: event.hutId,\n        party: event.party,\n        from: event.from,\n        to: event.to,\n        status: 'requested',\n      }\n      break\n    case 'booking-confirmed': {\n      const booking = state.bookings[event.bookingId]\n      if (booking && booking.status === 'requested') booking.status = 'confirmed'\n      break\n    }\n    case 'booking-cancelled': {\n      const booking = state.bookings[event.bookingId]\n      if (booking) booking.status = 'cancelled'\n      break\n    }\n    case 'booking-expired': {\n      const booking = state.bookings[event.bookingId]\n      if (booking && booking.status === 'requested') booking.status = 'expired'\n      break\n    }\n    default:\n      break\n  }\n}\n\n// Day-set occupancy: how many berths hut `hutId` has taken on each day of\n// [from, to). Confirmed bookings hold berths; requests do not.\nexport function occupiedBerths(state, hutId, from, to) {\n  let peak = 0\n  for (let day = from; day < to; day++) {\n    let taken = 0\n    for (const booking of Object.values(state.bookings)) {\n      if (booking.hutId !== hutId || booking.status !== 'confirmed') continue\n      if (day >= booking.from && day < booking.to) taken += booking.party\n    }\n    peak = Math.max(peak, taken)\n  }\n  return peak\n}\n\n// The first confirmed booking blocking `party` berths on [from, to), if any.\nexport function blockingBooking(state, hutId, party, from, to) {\n  const hut = state.huts[hutId]\n  if (!hut) return null\n  for (let day = from; day < to; day++) {\n    let taken = 0\n    let lastHolder = null\n    for (const booking of Object.values(state.bookings)) {\n      if (booking.hutId !== hutId || booking.status !== 'confirmed') continue\n      if (day >= booking.from && day < booking.to) {\n        taken += booking.party\n        lastHolder = booking\n      }\n    }\n    if (taken + party > hut.berths) return lastHolder\n  }\n  return null\n}\n\n// The maintenance window blocking [from, to) on a hut, if any.\nexport function maintenanceConflict(state, hutId, from, to) {\n  for (const window of state.maintenance) {\n    if (window.hutId === hutId && from < window.to && window.from < to) return window\n  }\n  return null\n}\n",
      'src/booking.js': `// The command layer: validate against the fold, append, re-fold. Commands
// never mutate state directly.
import { appendEvent, readEvents } from './events.js'
import { blockingBooking, foldState, maintenanceConflict } from './state.js'
import { priorityRank } from './policy.js'
import { quote } from './policy2.js'

let nextBookingId = 0
export function resetIds() {
  nextBookingId = 0
}

export function registerHut(logFile, { hutId, name, berths }) {
  if (!hutId || !Number.isInteger(berths) || berths < 1) {
    throw new Error('registerHut: hutId and a positive berth count are required')
  }
  return appendEvent(logFile, { type: 'hut-registered', hutId, name: name ?? hutId, berths })
}

export function requestBooking(logFile, { hutId, party, from, to }) {
  const state = foldState(readEvents(logFile))
  if (!state.huts[hutId]) throw new Error('requestBooking: unknown hut ' + String(hutId))
  if (!Number.isInteger(party) || party < 1) throw new Error('requestBooking: party must be >= 1')
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
    throw new Error('requestBooking: [from, to) must be a forward day range')
  }
  if (party > state.huts[hutId].berths) {
    throw new Error('requestBooking: party exceeds the hut (' + String(state.huts[hutId].berths) + ' berths)')
  }
  nextBookingId += 1
  const bookingId = 'b' + String(nextBookingId).padStart(4, '0')
  const event = appendEvent(logFile, { type: 'booking-requested', bookingId, hutId, party, from, to })
  return { bookingId, seq: event.seq, price: quote(party, from, to) }
}

export function confirmBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('confirmBooking: unknown booking ' + String(bookingId))
  if (booking.status !== 'requested') {
    throw new Error('confirmBooking: ' + bookingId + ' is ' + booking.status + ', not requested')
  }
  const blocker = blockingBooking(state, booking.hutId, booking.party, booking.from, booking.to)
  if (blocker) {
    throw new Error('confirmBooking: berth occupied by ' + blocker.id + ' — refusing ' + bookingId)
  }
  const window = maintenanceConflict(state, booking.hutId, booking.from, booking.to)
  if (window) {
    throw new Error('confirmBooking: hut closed for maintenance ' + window.id + ' — refusing ' + bookingId)
  }
  return appendEvent(logFile, { type: 'booking-confirmed', bookingId })
}

export function cancelBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('cancelBooking: unknown booking ' + String(bookingId))
  if (booking.status === 'cancelled') return null
  return appendEvent(logFile, { type: 'booking-cancelled', bookingId })
}

// Requests are served in priority order when a day frees up. Still the
// GENERATION-1 policy call — see _meta/STATUS.md before touching.
export function queuedRequests(logFile) {
  const state = foldState(readEvents(logFile))
  return Object.values(state.bookings)
    .filter(b => b.status === 'requested')
    .sort((a, b) => priorityRank(a.party, a.to - a.from) - priorityRank(b.party, b.to - b.from))
    .map(b => b.id)
}

// Area A — maintenance windows. Whichever side comes second is refused.
export function declareMaintenance(logFile, { hutId, from, to }) {
  const state = foldState(readEvents(logFile))
  if (!state.huts[hutId]) throw new Error('declareMaintenance: unknown hut ' + String(hutId))
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
    throw new Error('declareMaintenance: [from, to) must be a forward day range')
  }
  for (const booking of Object.values(state.bookings)) {
    if (booking.hutId !== hutId || booking.status !== 'confirmed') continue
    if (from < booking.to && booking.from < to) {
      appendEvent(logFile, { type: 'booking-cancelled', bookingId: booking.id })
    }
  }
  const maintenanceId = 'm' + String(state.maintenance.length + 1).padStart(3, '0')
  return appendEvent(logFile, { type: 'maintenance-declared', maintenanceId, hutId, from, to })
}

// Area B — the expiry sweep: one event per stale request, idempotent.
export function expireStale(logFile, { beforeDay }) {
  const state = foldState(readEvents(logFile))
  const stale = Object.values(state.bookings)
    .filter(b => b.status === 'requested' && b.to <= beforeDay)
    .map(b => b.id)
    .sort()
  for (const bookingId of stale) {
    appendEvent(logFile, { type: 'booking-expired', bookingId })
  }
  return stale
}
`,
    },
  },
  {
    name: 'sweep-cancels',
    files: {
      'src/state.js': "// The fold: events -> state. Pure; sorted by seq; a seq tie is a log\n// defect \u2014 the fold keeps the FIRST and ignores the rest (corruption must\n// never double-apply).\nexport function foldState(events) {\n  const ordered = [...events].sort((a, b) => a.seq - b.seq)\n  const state = { huts: {}, bookings: {}, maintenance: [] }\n  const seen = new Set()\n  for (const event of ordered) {\n    if (seen.has(event.seq)) continue // tie: keep the first, drop the rest\n    seen.add(event.seq)\n    apply(state, event)\n  }\n  return state\n}\n\nfunction apply(state, event) {\n  switch (event.type) {\n    case 'hut-registered':\n      state.huts[event.hutId] = { id: event.hutId, name: event.name, berths: event.berths }\n      break\n    case 'maintenance-declared':\n      state.maintenance.push({ id: event.maintenanceId, hutId: event.hutId, from: event.from, to: event.to })\n      break\n    case 'booking-requested':\n      state.bookings[event.bookingId] = {\n        id: event.bookingId,\n        hutId: event.hutId,\n        party: event.party,\n        from: event.from,\n        to: event.to,\n        status: 'requested',\n      }\n      break\n    case 'booking-confirmed': {\n      const booking = state.bookings[event.bookingId]\n      if (booking && booking.status === 'requested') booking.status = 'confirmed'\n      break\n    }\n    case 'booking-cancelled': {\n      const booking = state.bookings[event.bookingId]\n      if (booking) booking.status = 'cancelled'\n      break\n    }\n    case 'booking-expired': {\n      const booking = state.bookings[event.bookingId]\n      if (booking && booking.status === 'requested') booking.status = 'expired'\n      break\n    }\n    default:\n      break\n  }\n}\n\n// Day-set occupancy: how many berths hut `hutId` has taken on each day of\n// [from, to). Confirmed bookings hold berths; requests do not.\nexport function occupiedBerths(state, hutId, from, to) {\n  let peak = 0\n  for (let day = from; day < to; day++) {\n    let taken = 0\n    for (const booking of Object.values(state.bookings)) {\n      if (booking.hutId !== hutId || booking.status !== 'confirmed') continue\n      if (day >= booking.from && day < booking.to) taken += booking.party\n    }\n    peak = Math.max(peak, taken)\n  }\n  return peak\n}\n\n// The first confirmed booking blocking `party` berths on [from, to), if any.\nexport function blockingBooking(state, hutId, party, from, to) {\n  const hut = state.huts[hutId]\n  if (!hut) return null\n  for (let day = from; day < to; day++) {\n    let taken = 0\n    let lastHolder = null\n    for (const booking of Object.values(state.bookings)) {\n      if (booking.hutId !== hutId || booking.status !== 'confirmed') continue\n      if (day >= booking.from && day < booking.to) {\n        taken += booking.party\n        lastHolder = booking\n      }\n    }\n    if (taken + party > hut.berths) return lastHolder\n  }\n  return null\n}\n\n// The maintenance window blocking [from, to) on a hut, if any.\nexport function maintenanceConflict(state, hutId, from, to) {\n  for (const window of state.maintenance) {\n    if (window.hutId === hutId && from < window.to && window.from < to) return window\n  }\n  return null\n}\n",
      'src/booking.js': `// The command layer: validate against the fold, append, re-fold. Commands
// never mutate state directly.
import { appendEvent, readEvents } from './events.js'
import { blockingBooking, foldState, maintenanceConflict } from './state.js'
import { priorityRank } from './policy.js'
import { quote } from './policy2.js'

let nextBookingId = 0
export function resetIds() {
  nextBookingId = 0
}

export function registerHut(logFile, { hutId, name, berths }) {
  if (!hutId || !Number.isInteger(berths) || berths < 1) {
    throw new Error('registerHut: hutId and a positive berth count are required')
  }
  return appendEvent(logFile, { type: 'hut-registered', hutId, name: name ?? hutId, berths })
}

export function requestBooking(logFile, { hutId, party, from, to }) {
  const state = foldState(readEvents(logFile))
  if (!state.huts[hutId]) throw new Error('requestBooking: unknown hut ' + String(hutId))
  if (!Number.isInteger(party) || party < 1) throw new Error('requestBooking: party must be >= 1')
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
    throw new Error('requestBooking: [from, to) must be a forward day range')
  }
  if (party > state.huts[hutId].berths) {
    throw new Error('requestBooking: party exceeds the hut (' + String(state.huts[hutId].berths) + ' berths)')
  }
  nextBookingId += 1
  const bookingId = 'b' + String(nextBookingId).padStart(4, '0')
  const event = appendEvent(logFile, { type: 'booking-requested', bookingId, hutId, party, from, to })
  return { bookingId, seq: event.seq, price: quote(party, from, to) }
}

export function confirmBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('confirmBooking: unknown booking ' + String(bookingId))
  if (booking.status !== 'requested') {
    throw new Error('confirmBooking: ' + bookingId + ' is ' + booking.status + ', not requested')
  }
  const blocker = blockingBooking(state, booking.hutId, booking.party, booking.from, booking.to)
  if (blocker) {
    throw new Error('confirmBooking: berth occupied by ' + blocker.id + ' — refusing ' + bookingId)
  }
  const window = maintenanceConflict(state, booking.hutId, booking.from, booking.to)
  if (window) {
    throw new Error('confirmBooking: hut closed for maintenance ' + window.id + ' — refusing ' + bookingId)
  }
  return appendEvent(logFile, { type: 'booking-confirmed', bookingId })
}

export function cancelBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('cancelBooking: unknown booking ' + String(bookingId))
  if (booking.status === 'cancelled') return null
  return appendEvent(logFile, { type: 'booking-cancelled', bookingId })
}

// Requests are served in priority order when a day frees up. Still the
// GENERATION-1 policy call — see _meta/STATUS.md before touching.
export function queuedRequests(logFile) {
  const state = foldState(readEvents(logFile))
  return Object.values(state.bookings)
    .filter(b => b.status === 'requested')
    .sort((a, b) => priorityRank(a.party, a.to - a.from) - priorityRank(b.party, b.to - b.from))
    .map(b => b.id)
}

// Area A — maintenance windows. Whichever side comes second is refused.
export function declareMaintenance(logFile, { hutId, from, to }) {
  const state = foldState(readEvents(logFile))
  if (!state.huts[hutId]) throw new Error('declareMaintenance: unknown hut ' + String(hutId))
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
    throw new Error('declareMaintenance: [from, to) must be a forward day range')
  }
  for (const booking of Object.values(state.bookings)) {
    if (booking.hutId !== hutId || booking.status !== 'confirmed') continue
    if (from < booking.to && booking.from < to) {
      throw new Error('declareMaintenance: maintenance conflicts with ' + booking.id)
    }
  }
  const maintenanceId = 'm' + String(state.maintenance.length + 1).padStart(3, '0')
  return appendEvent(logFile, { type: 'maintenance-declared', maintenanceId, hutId, from, to })
}

// Area B — the expiry sweep: one event per stale request, idempotent.
export function expireStale(logFile, { beforeDay }) {
  const state = foldState(readEvents(logFile))
  const stale = Object.values(state.bookings)
    .filter(b => b.status === 'requested' && b.to <= beforeDay)
    .map(b => b.id)
    .sort()
  for (const bookingId of stale) {
    appendEvent(logFile, { type: 'booking-cancelled', bookingId })
  }
  return stale
}
`,
    },
  },
  {
    name: 'sweep-not-idempotent',
    files: {
      'src/state.js': "// The fold: events -> state. Pure; sorted by seq; a seq tie is a log\n// defect \u2014 the fold keeps the FIRST and ignores the rest (corruption must\n// never double-apply).\nexport function foldState(events) {\n  const ordered = [...events].sort((a, b) => a.seq - b.seq)\n  const state = { huts: {}, bookings: {}, maintenance: [] }\n  const seen = new Set()\n  for (const event of ordered) {\n    if (seen.has(event.seq)) continue // tie: keep the first, drop the rest\n    seen.add(event.seq)\n    apply(state, event)\n  }\n  return state\n}\n\nfunction apply(state, event) {\n  switch (event.type) {\n    case 'hut-registered':\n      state.huts[event.hutId] = { id: event.hutId, name: event.name, berths: event.berths }\n      break\n    case 'maintenance-declared':\n      state.maintenance.push({ id: event.maintenanceId, hutId: event.hutId, from: event.from, to: event.to })\n      break\n    case 'booking-requested':\n      state.bookings[event.bookingId] = {\n        id: event.bookingId,\n        hutId: event.hutId,\n        party: event.party,\n        from: event.from,\n        to: event.to,\n        status: 'requested',\n      }\n      break\n    case 'booking-confirmed': {\n      const booking = state.bookings[event.bookingId]\n      if (booking && booking.status === 'requested') booking.status = 'confirmed'\n      break\n    }\n    case 'booking-cancelled': {\n      const booking = state.bookings[event.bookingId]\n      if (booking) booking.status = 'cancelled'\n      break\n    }\n    case 'booking-expired': {\n      const booking = state.bookings[event.bookingId]\n      if (booking && booking.status === 'requested') booking.status = 'expired'\n      break\n    }\n    default:\n      break\n  }\n}\n\n// Day-set occupancy: how many berths hut `hutId` has taken on each day of\n// [from, to). Confirmed bookings hold berths; requests do not.\nexport function occupiedBerths(state, hutId, from, to) {\n  let peak = 0\n  for (let day = from; day < to; day++) {\n    let taken = 0\n    for (const booking of Object.values(state.bookings)) {\n      if (booking.hutId !== hutId || booking.status !== 'confirmed') continue\n      if (day >= booking.from && day < booking.to) taken += booking.party\n    }\n    peak = Math.max(peak, taken)\n  }\n  return peak\n}\n\n// The first confirmed booking blocking `party` berths on [from, to), if any.\nexport function blockingBooking(state, hutId, party, from, to) {\n  const hut = state.huts[hutId]\n  if (!hut) return null\n  for (let day = from; day < to; day++) {\n    let taken = 0\n    let lastHolder = null\n    for (const booking of Object.values(state.bookings)) {\n      if (booking.hutId !== hutId || booking.status !== 'confirmed') continue\n      if (day >= booking.from && day < booking.to) {\n        taken += booking.party\n        lastHolder = booking\n      }\n    }\n    if (taken + party > hut.berths) return lastHolder\n  }\n  return null\n}\n\n// The maintenance window blocking [from, to) on a hut, if any.\nexport function maintenanceConflict(state, hutId, from, to) {\n  for (const window of state.maintenance) {\n    if (window.hutId === hutId && from < window.to && window.from < to) return window\n  }\n  return null\n}\n",
      'src/booking.js': `// The command layer: validate against the fold, append, re-fold. Commands
// never mutate state directly.
import { appendEvent, readEvents } from './events.js'
import { blockingBooking, foldState, maintenanceConflict } from './state.js'
import { priorityRank } from './policy.js'
import { quote } from './policy2.js'

let nextBookingId = 0
export function resetIds() {
  nextBookingId = 0
}

export function registerHut(logFile, { hutId, name, berths }) {
  if (!hutId || !Number.isInteger(berths) || berths < 1) {
    throw new Error('registerHut: hutId and a positive berth count are required')
  }
  return appendEvent(logFile, { type: 'hut-registered', hutId, name: name ?? hutId, berths })
}

export function requestBooking(logFile, { hutId, party, from, to }) {
  const state = foldState(readEvents(logFile))
  if (!state.huts[hutId]) throw new Error('requestBooking: unknown hut ' + String(hutId))
  if (!Number.isInteger(party) || party < 1) throw new Error('requestBooking: party must be >= 1')
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
    throw new Error('requestBooking: [from, to) must be a forward day range')
  }
  if (party > state.huts[hutId].berths) {
    throw new Error('requestBooking: party exceeds the hut (' + String(state.huts[hutId].berths) + ' berths)')
  }
  nextBookingId += 1
  const bookingId = 'b' + String(nextBookingId).padStart(4, '0')
  const event = appendEvent(logFile, { type: 'booking-requested', bookingId, hutId, party, from, to })
  return { bookingId, seq: event.seq, price: quote(party, from, to) }
}

export function confirmBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('confirmBooking: unknown booking ' + String(bookingId))
  if (booking.status !== 'requested') {
    throw new Error('confirmBooking: ' + bookingId + ' is ' + booking.status + ', not requested')
  }
  const blocker = blockingBooking(state, booking.hutId, booking.party, booking.from, booking.to)
  if (blocker) {
    throw new Error('confirmBooking: berth occupied by ' + blocker.id + ' — refusing ' + bookingId)
  }
  const window = maintenanceConflict(state, booking.hutId, booking.from, booking.to)
  if (window) {
    throw new Error('confirmBooking: hut closed for maintenance ' + window.id + ' — refusing ' + bookingId)
  }
  return appendEvent(logFile, { type: 'booking-confirmed', bookingId })
}

export function cancelBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('cancelBooking: unknown booking ' + String(bookingId))
  if (booking.status === 'cancelled') return null
  return appendEvent(logFile, { type: 'booking-cancelled', bookingId })
}

// Requests are served in priority order when a day frees up. Still the
// GENERATION-1 policy call — see _meta/STATUS.md before touching.
export function queuedRequests(logFile) {
  const state = foldState(readEvents(logFile))
  return Object.values(state.bookings)
    .filter(b => b.status === 'requested')
    .sort((a, b) => priorityRank(a.party, a.to - a.from) - priorityRank(b.party, b.to - b.from))
    .map(b => b.id)
}

// Area A — maintenance windows. Whichever side comes second is refused.
export function declareMaintenance(logFile, { hutId, from, to }) {
  const state = foldState(readEvents(logFile))
  if (!state.huts[hutId]) throw new Error('declareMaintenance: unknown hut ' + String(hutId))
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
    throw new Error('declareMaintenance: [from, to) must be a forward day range')
  }
  for (const booking of Object.values(state.bookings)) {
    if (booking.hutId !== hutId || booking.status !== 'confirmed') continue
    if (from < booking.to && booking.from < to) {
      throw new Error('declareMaintenance: maintenance conflicts with ' + booking.id)
    }
  }
  const maintenanceId = 'm' + String(state.maintenance.length + 1).padStart(3, '0')
  return appendEvent(logFile, { type: 'maintenance-declared', maintenanceId, hutId, from, to })
}

// Area B — the expiry sweep: one event per stale request, idempotent.
export function expireStale(logFile, { beforeDay }) {
  const state = foldState(readEvents(logFile))
  const stale = Object.values(state.bookings)
    .filter(b => b.status !== 'cancelled' && b.status !== 'confirmed' && b.to <= beforeDay)
    .map(b => b.id)
    .sort()
  for (const bookingId of stale) {
    appendEvent(logFile, { type: 'booking-expired', bookingId })
  }
  return stale
}
`,
    },
  },
  {
    name: 'confirm-ignores-maintenance',
    files: {
      'src/state.js': "// The fold: events -> state. Pure; sorted by seq; a seq tie is a log\n// defect \u2014 the fold keeps the FIRST and ignores the rest (corruption must\n// never double-apply).\nexport function foldState(events) {\n  const ordered = [...events].sort((a, b) => a.seq - b.seq)\n  const state = { huts: {}, bookings: {}, maintenance: [] }\n  const seen = new Set()\n  for (const event of ordered) {\n    if (seen.has(event.seq)) continue // tie: keep the first, drop the rest\n    seen.add(event.seq)\n    apply(state, event)\n  }\n  return state\n}\n\nfunction apply(state, event) {\n  switch (event.type) {\n    case 'hut-registered':\n      state.huts[event.hutId] = { id: event.hutId, name: event.name, berths: event.berths }\n      break\n    case 'maintenance-declared':\n      state.maintenance.push({ id: event.maintenanceId, hutId: event.hutId, from: event.from, to: event.to })\n      break\n    case 'booking-requested':\n      state.bookings[event.bookingId] = {\n        id: event.bookingId,\n        hutId: event.hutId,\n        party: event.party,\n        from: event.from,\n        to: event.to,\n        status: 'requested',\n      }\n      break\n    case 'booking-confirmed': {\n      const booking = state.bookings[event.bookingId]\n      if (booking && booking.status === 'requested') booking.status = 'confirmed'\n      break\n    }\n    case 'booking-cancelled': {\n      const booking = state.bookings[event.bookingId]\n      if (booking) booking.status = 'cancelled'\n      break\n    }\n    case 'booking-expired': {\n      const booking = state.bookings[event.bookingId]\n      if (booking && booking.status === 'requested') booking.status = 'expired'\n      break\n    }\n    default:\n      break\n  }\n}\n\n// Day-set occupancy: how many berths hut `hutId` has taken on each day of\n// [from, to). Confirmed bookings hold berths; requests do not.\nexport function occupiedBerths(state, hutId, from, to) {\n  let peak = 0\n  for (let day = from; day < to; day++) {\n    let taken = 0\n    for (const booking of Object.values(state.bookings)) {\n      if (booking.hutId !== hutId || booking.status !== 'confirmed') continue\n      if (day >= booking.from && day < booking.to) taken += booking.party\n    }\n    peak = Math.max(peak, taken)\n  }\n  return peak\n}\n\n// The first confirmed booking blocking `party` berths on [from, to), if any.\nexport function blockingBooking(state, hutId, party, from, to) {\n  const hut = state.huts[hutId]\n  if (!hut) return null\n  for (let day = from; day < to; day++) {\n    let taken = 0\n    let lastHolder = null\n    for (const booking of Object.values(state.bookings)) {\n      if (booking.hutId !== hutId || booking.status !== 'confirmed') continue\n      if (day >= booking.from && day < booking.to) {\n        taken += booking.party\n        lastHolder = booking\n      }\n    }\n    if (taken + party > hut.berths) return lastHolder\n  }\n  return null\n}\n\n// The maintenance window blocking [from, to) on a hut, if any.\nexport function maintenanceConflict(state, hutId, from, to) {\n  for (const window of state.maintenance) {\n    if (window.hutId === hutId && from < window.to && window.from < to) return window\n  }\n  return null\n}\n",
      'src/booking.js': `// The command layer: validate against the fold, append, re-fold. Commands
// never mutate state directly.
import { appendEvent, readEvents } from './events.js'
import { blockingBooking, foldState, maintenanceConflict } from './state.js'
import { priorityRank } from './policy.js'
import { quote } from './policy2.js'

let nextBookingId = 0
export function resetIds() {
  nextBookingId = 0
}

export function registerHut(logFile, { hutId, name, berths }) {
  if (!hutId || !Number.isInteger(berths) || berths < 1) {
    throw new Error('registerHut: hutId and a positive berth count are required')
  }
  return appendEvent(logFile, { type: 'hut-registered', hutId, name: name ?? hutId, berths })
}

export function requestBooking(logFile, { hutId, party, from, to }) {
  const state = foldState(readEvents(logFile))
  if (!state.huts[hutId]) throw new Error('requestBooking: unknown hut ' + String(hutId))
  if (!Number.isInteger(party) || party < 1) throw new Error('requestBooking: party must be >= 1')
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
    throw new Error('requestBooking: [from, to) must be a forward day range')
  }
  if (party > state.huts[hutId].berths) {
    throw new Error('requestBooking: party exceeds the hut (' + String(state.huts[hutId].berths) + ' berths)')
  }
  nextBookingId += 1
  const bookingId = 'b' + String(nextBookingId).padStart(4, '0')
  const event = appendEvent(logFile, { type: 'booking-requested', bookingId, hutId, party, from, to })
  return { bookingId, seq: event.seq, price: quote(party, from, to) }
}

export function confirmBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('confirmBooking: unknown booking ' + String(bookingId))
  if (booking.status !== 'requested') {
    throw new Error('confirmBooking: ' + bookingId + ' is ' + booking.status + ', not requested')
  }
  const blocker = blockingBooking(state, booking.hutId, booking.party, booking.from, booking.to)
  if (blocker) {
    throw new Error('confirmBooking: berth occupied by ' + blocker.id + ' — refusing ' + bookingId)
  }
  return appendEvent(logFile, { type: 'booking-confirmed', bookingId })
}

export function cancelBooking(logFile, bookingId) {
  const state = foldState(readEvents(logFile))
  const booking = state.bookings[bookingId]
  if (!booking) throw new Error('cancelBooking: unknown booking ' + String(bookingId))
  if (booking.status === 'cancelled') return null
  return appendEvent(logFile, { type: 'booking-cancelled', bookingId })
}

// Requests are served in priority order when a day frees up. Still the
// GENERATION-1 policy call — see _meta/STATUS.md before touching.
export function queuedRequests(logFile) {
  const state = foldState(readEvents(logFile))
  return Object.values(state.bookings)
    .filter(b => b.status === 'requested')
    .sort((a, b) => priorityRank(a.party, a.to - a.from) - priorityRank(b.party, b.to - b.from))
    .map(b => b.id)
}

// Area A — maintenance windows. Whichever side comes second is refused.
export function declareMaintenance(logFile, { hutId, from, to }) {
  const state = foldState(readEvents(logFile))
  if (!state.huts[hutId]) throw new Error('declareMaintenance: unknown hut ' + String(hutId))
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
    throw new Error('declareMaintenance: [from, to) must be a forward day range')
  }
  for (const booking of Object.values(state.bookings)) {
    if (booking.hutId !== hutId || booking.status !== 'confirmed') continue
    if (from < booking.to && booking.from < to) {
      throw new Error('declareMaintenance: maintenance conflicts with ' + booking.id)
    }
  }
  const maintenanceId = 'm' + String(state.maintenance.length + 1).padStart(3, '0')
  return appendEvent(logFile, { type: 'maintenance-declared', maintenanceId, hutId, from, to })
}

// Area B — the expiry sweep: one event per stale request, idempotent.
export function expireStale(logFile, { beforeDay }) {
  const state = foldState(readEvents(logFile))
  const stale = Object.values(state.bookings)
    .filter(b => b.status === 'requested' && b.to <= beforeDay)
    .map(b => b.id)
    .sort()
  for (const bookingId of stale) {
    appendEvent(logFile, { type: 'booking-expired', bookingId })
  }
  return stale
}
`,
    },
  },
  { name: 'test-tamper', files: { 'test/wardens.test.mjs': `import { test } from "node:test"

test("stub", () => {})
` } },
]
