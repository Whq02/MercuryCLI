#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-broadcast.ts — THE BROADCAST pins.
//  One message to many sessions:
//  mark rows on the board, speak once through the LANDED live composer, and
//  every marked live session takes it as its next turn — receipts on every
//  row. Executed units over the PURE faces (broadcastFaceOf ·
//  broadcastSummaryOf · liveComposerGateOf — the fan's own classifier) plus
//  source-lock pins on the screen's wiring; the operator's look-capture
//  rides prove-broadcast-look.ts at the fold's pool.
//
//   §1  the mark toggle + clear laws (item 1): space toggles in the list
//       region only, marks are SCREEN state beside the arm (POISON: the
//       capsule persists none), esc clears all as its own layer, a project
//       switch clears them (item 5).
//   §2  the N-delivery fan through the ONE door (item 2): ≥2 marks flip
//       the placeholder to the counted broadcast face; the fan is N calls
//       of session.redirect in board order. POISON: a second delivery path
//       or a daemon verb.
//   §3  every skip class with its typed reason (item 3): the fan's
//       classifier IS the landed gate — parked · queued · doors · attached
//       · stopped · the older line each refuse with their own line; a
//       paused row is DELIVERED (the valve holds — the redirect contract).
//   §4  the needs-you lock always wins (item 4): an open ask skips, both
//       truths (row state and obligation); asks are answered in the chat.
//   §5  the summary arithmetic (item 3): "sent to K of N · M skipped",
//       M = N − K always.
//   §6  plain-world absence (item 5): the reduced stage keeps space dead
//       and untaught at every selection class.
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keyHintLabel } from '../../src/components/mercury-ui/keyHintLabel.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'broadcast-pins-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
/** The vacuous-ordering guard (the vacuous-pin class): an ordering
 *  compare is meaningful only when BOTH needles exist — a rotted needle's
 *  indexOf(-1) must read RED, never trivially green. */
function ordered(hay: string, a: string, b: string): boolean {
  const ia = hay.indexOf(a)
  const ib = hay.indexOf(b)
  return ia !== -1 && ib !== -1 && ia < ib
}

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { broadcastFaceOf, broadcastSummaryOf, liveComposerGateOf } = await import(
  '../../src/components/concourse/ConcourseScreen.tsx'
)
const { CONCOURSE_CONTROLS, CONCOURSE_REGION_KEYS, regionKeysFor } = await import(
  '../../src/components/concourse/controlManifest.ts'
)
type Row = import('../../src/components/concourse/contracts.ts').ConcourseRowV1
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

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')
const screen = read('src/components/concourse/ConcourseScreen.tsx')
const layout = read('src/components/concourse/ConcourseLayout.tsx')

// ── §1: the mark toggle + clear laws ────────────────────────────────────────
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
  // The handler lives INSIDE the list-region block (a list verb) — after
  // the split keys, before the block closes into the chat-pane grammar.
  const SPACE_GUARD = "if (input === ' ' && !key.ctrl && !key.meta && !reducedStage && pastGate()) {"
  const spaceAt = screen.indexOf(SPACE_GUARD)
  check(
    'space fires as a LIST verb (inside the list block, full stage only)',
    spaceAt > 0 &&
      ordered(screen, "if (region === 'list') {", SPACE_GUARD) &&
      ordered(screen, SPACE_GUARD, "if (region === 'chat') {"),
  )
  // SPACE IS A PRINTABLE IN THE COMPOSER, THE MARK ON THE ROWS — pin BOTH
  // directions through the composer-focus gate that stands between them.
  const COMPOSER_GATE = "if (region !== 'coordinator' && region !== 'live') {"
  check(
    'POISON (a mid-sentence space toggling a mark): typing never reaches the rows’ grammar — the composer-focus gate keeps every non-composer region out of the type-through, and the mark verb never yields to a draft',
    !SPACE_GUARD.includes('verbsYield') &&
      !screen.includes('letterVerbsYield') &&
      ordered(screen, SPACE_GUARD, COMPOSER_GATE) &&
      ordered(screen, COMPOSER_GATE, 'side.edit(d => insertAt(d, payload))'),
  )
  check(
    'POISON (a rows-side space landing in the draft): the verb CONSUMES it above the composer gate (stop + return, never a fall-through)',
    (() => {
      const slice = screen.slice(spaceAt, screen.indexOf('return\n      }', spaceAt) + 1)
      return spaceAt > 0 && slice.includes('event.stopImmediatePropagation()') && ordered(screen, SPACE_GUARD, COMPOSER_GATE)
    })(),
  )
  check(
    'space toggles the SELECTED row through the one toggle (add ⇄ delete)',
    screen.includes('if (sel !== undefined) toggleMark(sel.sessionId)') &&
      ordered(screen, 'if (next.has(sessionId)) next.delete(sessionId)', 'else next.add(sessionId)'),
  )
  check(
    "the marks' home is SCREEN state beside the arm (a ReadonlySet in useState)",
    screen.includes("const [markedIds, setMarkedIds] = useState<ReadonlySet<string>>(() => new Set())"),
  )
  // POISON (never persisted): the capsule keeps its exact landed field list
  // — no marks slot in the interface, none in the capture, and the durable
  // draft stores never see the set.
  check(
    'POISON (item 1): the presentation capsule carries NO marks — the capture line is the landed six fields',
    screen.includes('capsuleRef.current = { region, filtering, filter, boardSel, railSel, boardScroll, managerMode: managerArmed }') &&
      !screen.slice(screen.indexOf('interface ConcourseCapsuleV2'), screen.indexOf('let presentationCapsule')).includes('mark'),
  )
  check(
    'POISON: no durable write ever carries the marks (the coordinator draft store stays the composers’)',
    screen.includes('markedIds') &&
      !/writeCoordinatorComposerDraft\([^)]*marked/.test(screen) &&
      !/persistDraft\([^)]*marked/.test(screen),
  )
  // esc clears ALL marks as its own layer — after the peek closes, before
  // the exit (the deepest layer before leaving).
  check(
    'esc clears all marks as its own layer (after the peek close, before exitToRepl)',
    ordered(screen, '// Line 5: esc closes the row peek first', 'if (markedIdsRef.current.size > 0) {') &&
      ordered(screen, 'if (markedIdsRef.current.size > 0) {', 'callbacks.exitToRepl()\n      return\n    }'),
  )
  // Item 5: a project switch clears the marks — the snapshot's own project
  // word is the signal (every switch door lands there).
  const projClear = screen.slice(
    screen.indexOf('const markProjectRef = useRef(snapshot.context.projectLabel)'),
    screen.indexOf("}, [snapshot.context.projectLabel])"),
  )
  check(
    'a project switch clears the marks (the effect on the snapshot’s own project word)',
    projClear.includes('if (markProjectRef.current === snapshot.context.projectLabel) return') &&
      projClear.includes('setMarkedIds(new Set())'),
  )
  // The visible mark: the layout paints the kit's check in the accent on
  // marked rows, from the screen's own set (paint only — no second home).
  check(
    'the row wears the visible mark glyph (GLYPH.check in the accent, from the handed-down set)',
    layout.includes("markedIds?.has(r.sessionId) === true ? (") &&
      layout.includes('<Text color={t.info}>{GLYPH.check} </Text>') &&
      screen.includes('markedIds={markedIds}'),
  )
  // Every count that speaks is the INTERSECTION with the board's rows — a
  // stale id (its row left the board) is inert, never a phantom target.
  check(
    'the counts and the fan derive from the board intersection (stale ids inert)',
    screen.includes('sessionRows.filter(r => markedIds.has(r.sessionId))') &&
      screen.includes('sessionRows.filter(r => markedIdsRef.current.has(r.sessionId))'),
  )
}

// ── §2: the broadcast face + the N-delivery fan through the ONE door ───────
console.log('§2 — the fan (item 2): the counted placeholder; ↵ arms naming the count, ↵↵ sends; ONE door, N deliveries')
{
  check('below the threshold the face is null — the landed single-target gate stands (0 and 1 marks)', broadcastFaceOf(0) === null && broadcastFaceOf(1) === null)
  check(
    "the exact placeholder at 2 marks",
    broadcastFaceOf(2)?.placeholder === 'message 2 sessions · ↵↵ sends to all marked',
    broadcastFaceOf(2)?.placeholder ?? '(null)',
  )
  check('the placeholder counts the marks (7 names 7)', broadcastFaceOf(7)?.placeholder === 'message 7 sessions · ↵↵ sends to all marked')
  // The screen consults the face FIRST at the rest hint, bypasses the
  // selection's gate in type, and never single-arms the selection while the
  // face stands (the marked set is the addressee).
  check(
    'the rest hint speaks the face first, then the landed gate',
    ordered(screen, 'const face = broadcastFaceOf(markedRows.length)', 'const g = liveComposerGate(sessionRows.find(r => r.sessionId === boardSel), region)'),
  )
  check(
    'the type-through gate yields under the face (the fan types each verdict at the send instead)',
    screen.includes('if (broadcastFaceOf(markedRowsOf().length) !== null) return null'),
  )
  check(
    'typing never single-arms the selection under the face',
    screen.includes('if (broadcastFaceOf(markedRowsOf().length) !== null) return\n'),
  )
  // THE FAN SLICE: everything between the marked read and the single-send
  // fallback — the arm stage, the loop, the receipts, the summary.
  const fanAt = screen.indexOf('const marked = markedRowsOf()')
  const fanEnd = screen.indexOf('const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)', fanAt)
  const fan = screen.slice(fanAt, fanEnd)
  check('the fan slice exists inside sendLive, before the landed single send', fanAt > 0 && fanEnd > fanAt)
  check(
    'the first ↵ ARMS (set + return, no delivery); the second fans',
    ordered(fan, 'if (!broadcastArmedRef.current) {', 'setBroadcastArmed(true)') &&
      ordered(fan, 'setBroadcastArmed(true)', 'for (const row of marked) {') &&
      fan.indexOf('for (const row of marked) {') !== -1 && fan.indexOf('callbacks.redirectSession') > fan.indexOf('for (const row of marked) {'),
  )
  check(
    'the armed line NAMES THE COUNT, derived every paint (item 2 — the first ↵ arms naming the count)',
    screen.includes('broadcast · sends to ${markedRows.length} sessions · ↵ again sends · esc cancels'),
  )
  check(
    'an edit to the words or the marks DISARMS (the named count must be what sends)',
    screen.includes('if (broadcastArmedRef.current) setBroadcastArmed(false)') &&
      screen.includes('}, [liveDraft.text, markedIds])'),
  )
  check(
    'esc cancels the armed fan as its own layer (after the older fold, before the enter-arm)',
    ordered(screen, '// ITEM 7: esc folds the drop-down back to the line', 'THE BROADCAST ARM (item 2): esc cancels') &&
      ordered(screen, 'THE BROADCAST ARM (item 2): esc cancels', '// ARM-THEN-ENTER (item 2): esc disarms'),
  )
  check(
    'ONE door, N deliveries: exactly one delivery call site in the fan — the SAME steering door the single send uses',
    fan.split('callbacks.redirectSession(row.sessionId, text)').length - 1 === 1 &&
      screen.includes('callbacks.redirectSession(sel!.sessionId, text)'),
  )
  check(
    'POISON (a second delivery path): the fan reaches NO other delivery — no coordinator send, no launcher, no answer door, no kernel import',
    !fan.includes('sendCoordinatorMessage') &&
      !fan.includes('submitSessionDraft') &&
      !fan.includes('answerObligation') &&
      !fan.includes('answerPermission') &&
      !fan.includes('executeKernelDecision') &&
      !screen.includes('executeKernelDecision'),
  )
  // POISON (a daemon verb): the kernel's verb union gains nothing — the
  // fan is N session.redirect decisions and the union spells no broadcast.
  const kernel = read('src/services/concourse/coordinatorKernel.ts')
  check(
    "POISON (item 2's handshake law): NO new daemon verb — the kernel union carries no broadcast spelling",
    !/verb: '[a-z.]*broadcast[a-z.]*'/.test(kernel) && kernel.includes("verb: 'session.redirect'"),
  )
  check(
    'delivered rows paint their receipt on the ROW slot; skips paint the typed reason there too (receipts on every row)',
    fan.includes('`board:row-control:${row.sessionId}`') &&
      fan.includes("reason: 'broadcast sent — queued for its next turn'") &&
      fan.includes('reason: `skipped — ${rowGate.line}`'),
  )
  check(
    'the fan clears the draft once, after the loop (one message, spoken once)',
    ordered(fan, 'setLiveNote({ tone: sent > 0', 'clearLiveDraft()'),
  )
  // The contexts stay their own delivery: the answer/rename branches sit
  // ABOVE the fan (a broadcast never answers an ask — §4's law has a
  // structural half here). The contract-compose context RETIRED with L25
  // (the offer card owns its own field; the live composer is never the
  // door for a birth-time contract) — its absence is the poison.
  // The absence needle reads the source COMMENTS-STRIPPED: the L25 cut's
  // own retirement comment lawfully quotes the dead spelling (a comment
  // naming the dead disease is not the disease), and a bare-substring
  // absence needle must never trip on it.
  const screenCode = screen.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  check(
    'the compose contexts branch BEFORE the fan (answer · rename are their own delivery); the contract context is GONE (L25)',
    ordered(screen, "if (ctx.kind === 'answer') {", 'const marked = markedRowsOf()') &&
      ordered(screen, "if (ctx.kind === 'rename') {", 'const marked = markedRowsOf()') &&
      !screenCode.includes("'contract-compose'"),
  )
}

// ── §3: every skip class with its reason — the classifier IS the gate ──────
console.log('§3 — honest partial delivery (item 3): the ONE gate types every skip; a paused row DELIVERS (the valve holds)')
{
  const gate = (r: Row | undefined, ask = false): { ok: boolean; line?: string } =>
    liveComposerGateOf(r, ask) as { ok: boolean; line?: string }
  check('parked skips with its line (never force-woken — the rule)', gate(row({ state: 'parked' })).ok === false && gate(row({ state: 'parked' })).line === 'parked — ↵↵ brings it back; a sleeping chat takes no queue')
  check('queued (a held reservation) skips with its line', gate(row({ sessionId: 'dispatch:abc' })).ok === false && gate(row({ sessionId: 'dispatch:abc' })).line === 'queued — m stacks a message for its start')
  // The gate-vs-fixture divergence: the live builder always mints queued
  // reservations as `dispatch:<id>`, but a reference fixture's queued rows
  // carry plain ids and state 'queued' — the TYPED state is the law, so a
  // plain-id queued row refuses exactly like the prefixed one.
  check(
    'POISON (gate-vs-fixture): a queued row by STATE with a plain id skips with the same line — the gate keys on the typed state, not only the id spelling',
    gate(row({ state: 'queued' })).ok === false && gate(row({ state: 'queued' })).line === 'queued — m stacks a message for its start',
    JSON.stringify(gate(row({ state: 'queued' }))),
  )
  check('a door row skips with its line', gate(row({ door: { kind: 'pick-project', more: 2 } })).ok === false && gate(row({ door: { kind: 'pick-project', more: 2 } })).line === 'a door — ↵ opens it; nothing to message')
  check('the older line skips with its line', gate(row({ sessionId: 'older:/tmp/p' })).ok === false && gate(row({ sessionId: 'older:/tmp/p' })).line === 'older chats — ↵ unfolds the list')
  check('attached (with you) skips with its line', gate(row({ state: 'attached' })).ok === false && gate(row({ state: 'attached' })).line === 'with you — type in its own chat')
  check('stopped skips with its line', gate(row({ state: 'stopped' })).ok === false && gate(row({ state: 'stopped' })).line === `stopped — nothing listens; ${keyHintLabel('⌃x ⌃x')} removes it`)
  check('a working row DELIVERS (the fan’s ok side)', gate(row({})).ok === true)
  check('a PAUSED row DELIVERS — the valve holds typed words for resume (the redirect contract, not a skip)', gate(row({ state: 'paused' })).ok === true)
  check('ready-to-review and starting DELIVER (live targets of the landed gate)', gate(row({ state: 'ready-to-review' })).ok === true && gate(row({ state: 'starting' })).ok === true)
  // The fan consults THE gate — one classifier, no second vocabulary.
  const fanAt = screen.indexOf('const marked = markedRowsOf()')
  const fan = screen.slice(fanAt, screen.indexOf('const sel = sessionRows.find', fanAt))
  check(
    'the fan classifies each row through the ONE landed gate (liveComposerGate per row)',
    fan.includes('const rowGate = liveComposerGate(row)') && fan.split('liveComposerGate').length - 1 === 1,
  )
  check(
    'POISON (never force-woken, never entered): the fan touches no resume/enter door',
    !fan.includes('resumeSession') && !fan.includes('enterSession') && !fan.includes('resumeOlderChat'),
  )
}

// ── §4: the needs-you lock always wins ──────────────────────────────────────
console.log('§4 — the lock (item 4): an open ask skips, both truths; the answer path never fans')
{
  const locked = liveComposerGateOf(row({}), true)
  check('POISON (the L17 grammar): a WORKING row with an OPEN ask is a skip — the lock outranks liveness', locked.ok === false && (locked as { line: string }).line === 'needs you · ↵↵ to answer')
  const byState = liveComposerGateOf(row({ state: 'needs-you' }), false)
  check('the needs-you state skips too (both truths — the row and the obligation)', byState.ok === false)
  // The wrapper call is multiline and carries the wall-line arg;
  // read it whitespace-folded — the law (derived per paint,
  // never stored) is unchanged.
  check(
    "the fan's wrapper derives the ask from the snapshot (the lock can never go stale — derived, never stored)",
    screen.replace(/\s+/g, ' ').includes('liveComposerGateOf( sel, sel !== undefined && snapshot.needsYou.some(o => o.sessionId === sel.sessionId), noteRegion, sel !== undefined ? wallLineBySession.get(sel.sessionId) : undefined, )'),
  )
}

// ── §5: the summary arithmetic ──────────────────────────────────────────────
console.log('§5 — the summary (item 3): "sent to K of N · M skipped", M = N − K always')
{
  check('the exact spelling', broadcastSummaryOf(3, 5) === 'sent to 3 of 5 · 2 skipped', broadcastSummaryOf(3, 5))
  check('zero delivered stays honest', broadcastSummaryOf(0, 2) === 'sent to 0 of 2 · 2 skipped')
  check('zero skipped stays spelled (the arithmetic never hides)', broadcastSummaryOf(4, 4) === 'sent to 4 of 4 · 0 skipped')
  check(
    'the fan paints EXACTLY this summary in the composer note (warning ink only when nothing sent)',
    screen.includes('setLiveNote({ tone: sent > 0 ? \'muted\' : \'warning\', text: broadcastSummaryOf(sent, marked.length) })'),
  )
}

// ── §6: plain-world absence ─────────────────────────────────────────────────
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
    "DEAD: the space handler is guarded by the stage fact itself (the reduced stage's list never marks)",
    screen.includes("if (input === ' ' && !key.ctrl && !key.meta && !reducedStage && pastGate()) {"),
  )
  check(
    'the atlas teaches space through the same one resolver rows (CONCOURSE_REGION_KEYS.list feeds it)',
    CONCOURSE_REGION_KEYS.list.some(k => k.keys === 'space'),
  )
}

// ── §7: the replay identity under the fan — one slot PER TARGET ─────────────
console.log('§7 — redirect replay identity (R7 C-HIGH-2 under the fan): one identity slot per target, never one slot for the whole board')
{
  // A fan of N through the one steering door used to overwrite ONE ref
  // N−1 times: only the LAST target's held/transport-lost delivery kept its
  // exact-replay id; an earlier target's re-send minted fresh, so the
  // daemon's idempotent door could not dedupe a first send that had landed.
  const route = read('src/components/concourse/ConcourseRoute.tsx')
  const at = route.indexOf('const redirectIdRef = useRef<')
  check('the redirect identity is a MAP keyed by the target session (one slot per target)', at !== -1 && route.slice(at, at + 160).includes('useRef<Map<string, { instruction: string; id: string }>>(new Map())'))
  const legAt = route.indexOf('redirectSession: (sessionId, instruction) => {')
  const leg = legAt === -1 ? '' : route.slice(legAt, route.indexOf('// BOARD CONTROLS item 1 (`e`)', legAt))
  check('the leg reads its target’s own slot and replays the SAME id for the same words on that target', leg.includes('const minted = redirectIdRef.current.get(sessionId)') && leg.includes("minted !== undefined && minted.instruction === instruction ? minted.id : `concourse-redirect-${randomUUID()}`"))
  check('…and stores the minted identity under that target', leg.includes('redirectIdRef.current.set(sessionId, { instruction, id: clientMessageId })'))
  check('applied releases ONLY that target’s slot (a sibling target’s held identity survives the fan)', leg.includes("if (receipt.outcome === 'applied') redirectIdRef.current.delete(sessionId)"))
  check('a terminal refusal releases only that target’s slot too; held and transport-lost keep it (the replay door)', leg.includes("else if (receipt.outcome !== 'failed' && !(receipt.detail ?? '').startsWith('session-paused'))\n              redirectIdRef.current.delete(sessionId)"))
  check('POISON: no whole-board reset of the identity remains (`redirectIdRef.current = null` is gone)', !route.includes('redirectIdRef.current = null') && !route.includes('redirectIdRef.current = {'))
}

console.log(failures === 0 ? '\nprove-broadcast: ALL GREEN' : `\nprove-broadcast: ${failures} FAILURE(S)`)
if (failures > 0) process.exit(1)
