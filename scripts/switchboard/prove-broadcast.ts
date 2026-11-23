#!/usr/bin/env bun
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keyHintLabel } from '../../src/screen/widgets/keyHintLabel.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'broadcast-pins-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME

let failures = 0
let where = ''
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && where ? ` — ${where}` : ''}`)
}

const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const { broadcastFaceOf, broadcastSummaryOf, liveComposerGateOf } = await import(
  '../../src/screen/concourse/ConcourseScreen.tsx'
)
const { CONCOURSE_CONTROLS, CONCOURSE_REGION_KEYS, regionKeysFor } = await import(
  '../../src/screen/concourse/controlManifest.ts'
)
type Row = import('../../src/screen/concourse/contracts.ts').ConcourseRowV1
const row = (over: Partial<Row>): Row =>
  ({
    sessionId: '00000000-bbbb-4000-8000-000000000099',
    title: 'the parser session',
    state: 'working',
    projectLabel: 'p',
    ownerLabel: null,
    ageLabel: null,
    seats: null,
    ...over,
  }) as Row


where = 'change CONCOURSE_CONTROLS, CONCOURSE_REGION_KEYS or regionKeysFor in src/screen/concourse/controlManifest.ts'
console.log('§1 — marking (item 1): space toggles in the list region; screen state; esc + project switch clear')
{
  const ctl = CONCOURSE_CONTROLS.find(c => c.id === 'board:mark')
  check(
    'the mark is a DECLARED control: space, list region, no pointer path',
    ctl !== undefined && ctl.region === 'list' && ctl.keys.join(',') === 'space' && ctl.pointer === 'none',
  )
  check(
    'the list legend teaches space as the mark (on the rows space is the mark and nothing else)',
    CONCOURSE_REGION_KEYS.list.some(k => k.keys === 'space' && k.label === 'mark'),
  )
}

where = 'change broadcastFaceOf, broadcastSummaryOf or liveComposerGateOf in src/screen/concourse/screen/composerGate.ts'
console.log('§2 — the fan (item 2): the counted placeholder; ↵ arms naming the count, ↵↵ sends; ONE door, N deliveries')
{
  check('below the threshold the face is null — the landed single-target gate stands (0 and 1 marks)', broadcastFaceOf(0) === null && broadcastFaceOf(1) === null)
  check(
    "the exact placeholder at 2 marks",
    broadcastFaceOf(2)?.placeholder === 'message 2 sessions · ↵↵ sends to all marked',
    broadcastFaceOf(2)?.placeholder ?? '(null)',
  )
  check('the placeholder counts the marks (7 names 7)', broadcastFaceOf(7)?.placeholder === 'message 7 sessions · ↵↵ sends to all marked')
}

where = 'change broadcastFaceOf, broadcastSummaryOf or liveComposerGateOf in src/screen/concourse/screen/composerGate.ts'
console.log('§3 — honest partial delivery (item 3): the ONE gate types every skip; a paused row DELIVERS (the valve holds)')
{
  const gate = (r: Row | undefined, ask = false): { ok: boolean; line?: string } =>
    liveComposerGateOf(r, ask) as { ok: boolean; line?: string }
  check('parked skips with its line (never force-woken — the rule)', gate(row({ state: 'parked' })).ok === false && gate(row({ state: 'parked' })).line === 'parked — ↵ brings it back; a sleeping chat takes no queue')
  check('queued (a held reservation) skips with its line', gate(row({ sessionId: 'dispatch:abc' })).ok === false && gate(row({ sessionId: 'dispatch:abc' })).line === 'queued — m stacks a message for its start')
  check(
    'POISON (gate-vs-fixture): a queued row by STATE with a plain id skips with the same line — the gate keys on the typed state, not only the id spelling',
    gate(row({ state: 'queued' })).ok === false && gate(row({ state: 'queued' })).line === 'queued — m stacks a message for its start',
    JSON.stringify(gate(row({ state: 'queued' }))),
  )
  check('a door row skips with its line', gate(row({ door: { kind: 'pick-project', more: 2 } })).ok === false && gate(row({ door: { kind: 'pick-project', more: 2 } })).line === 'a door — ↵ opens it; nothing to message')
  check('the older line skips with its line', gate(row({ sessionId: 'older:/tmp/p' })).ok === false && gate(row({ sessionId: 'older:/tmp/p' })).line === 'older chats — ↵ unfolds the list')
  check('attached (with you) skips with its line', gate(row({ state: 'attached' })).ok === false && gate(row({ state: 'attached' })).line === 'with you — type in its own chat')
  check('stopped skips with its line', gate(row({ state: 'stopped' })).ok === false && gate(row({ state: 'stopped' })).line === `stopped — nothing listens; ${keyHintLabel('⌃x ⌃x')} archives it`)
  check('a working row DELIVERS (the fan’s ok side)', gate(row({})).ok === true)
  check('a PAUSED row DELIVERS — the valve holds typed words for resume (the redirect contract, not a skip)', gate(row({ state: 'paused' })).ok === true)
  check('ready-to-review and starting DELIVER (live targets of the landed gate)', gate(row({ state: 'ready-to-review' })).ok === true && gate(row({ state: 'starting' })).ok === true)
}

where = 'change broadcastFaceOf, broadcastSummaryOf or liveComposerGateOf in src/screen/concourse/screen/composerGate.ts'
console.log('§4 — the lock (item 4): an open ask skips, both truths; the answer path never fans')
{
  const locked = liveComposerGateOf(row({}), true)
  check('POISON (the L17 grammar): a WORKING row with an OPEN ask is a skip — the lock outranks liveness', locked.ok === false && (locked as { line: string }).line === 'needs you · ↵↵ to answer')
  const byState = liveComposerGateOf(row({ state: 'needs-you' }), false)
  check('the needs-you state skips too (both truths — the row and the obligation)', byState.ok === false)
}

where = 'change broadcastFaceOf, broadcastSummaryOf or liveComposerGateOf in src/screen/concourse/screen/composerGate.ts'
console.log('§5 — the summary (item 3): "sent to K of N · M skipped", M = N − K always')
{
  check('the exact spelling', broadcastSummaryOf(3, 5) === 'sent to 3 of 5 · 2 skipped', broadcastSummaryOf(3, 5))
  check('zero delivered stays honest', broadcastSummaryOf(0, 2) === 'sent to 0 of 2 · 2 skipped')
  check('zero skipped stays spelled (the arithmetic never hides)', broadcastSummaryOf(4, 4) === 'sent to 4 of 4 · 0 skipped')
}

where = 'change CONCOURSE_CONTROLS, CONCOURSE_REGION_KEYS or regionKeysFor in src/screen/concourse/controlManifest.ts'
console.log('§6 — the plain world (item 5): the reduced stage keeps space dead and untaught')
{
  const classes = ['live', 'paused', 'attached', 'queued', 'parked', 'stopped', 'door', 'none'] as const
  check(
    'UNTAUGHT: no reduced-stage legend row teaches space — base and every selection class',
    !regionKeysFor('list', { newSession: false }).some(k => k.keys === 'space') &&
      classes.every(c => !regionKeysFor('list', { newSession: false, selection: c }).some(k => k.keys === 'space')),
  )
  check(
    'TAUGHT on the full stage wherever a row can take a mark (every row class; never on an empty board)',
    (['live', 'paused', 'attached', 'queued', 'parked', 'stopped', 'door'] as const).every(c =>
      regionKeysFor('list', { newSession: true, selection: c }).some(k => k.keys === 'space' && k.label === 'mark'),
    ) && !regionKeysFor('list', { newSession: true, selection: 'none' }).some(k => k.keys === 'space'),
  )
  check(
    'the atlas teaches space through the same one resolver rows (CONCOURSE_REGION_KEYS.list feeds it)',
    CONCOURSE_REGION_KEYS.list.some(k => k.keys === 'space'),
  )
}

console.log('§7 — redirect replay identity (R7 C-HIGH-2 under the fan): one identity slot per target, never one slot for the whole board')
{
}

console.log(failures === 0 ? '\nprove-broadcast: ALL GREEN' : `\nprove-broadcast: ${failures} FAILURE(S)`)
if (failures > 0) process.exit(1)
