#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'concourse-design-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const failHint = cond ? '' : ' | to fix: the older-chats count and rows come from olderChatsCensus and parkedBoardRows in src/screen/concourse-model/concourseSnapshot.ts; declared controls and legends from CONCOURSE_CONTROLS and regionKeysFor in src/screen/concourse/controlManifest.ts; the live composer lock and paint from liveComposerGateOf and liveComposerPaintOf in src/screen/concourse/screen/composerGate.ts(x), whichever the label names'
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${failHint}`)
}

const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const { workerTranscriptPath } = await import('../../src/screen/concourse-model/workerTranscript.ts')
const { buildConcourseSnapshot, olderChatsCensus, parkedBoardRows, markParkedCleared, OLDER_CHATS_ROW_PREFIX } = await import(
  '../../src/screen/concourse-model/concourseSnapshot.ts'
)
const { projectIdentity } = await import('../../src/screen/boot-face/bootCardFacts.ts')
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourse-workers/concourseWorkers.ts'

const NOW = Date.now()
const DAY = 24 * 60 * 60_000
const recordsDir = join(SCRATCH, 'daemon')
const crewDir = join(SCRATCH, 'crew')
const draftDir = join(SCRATCH, 'draft')
for (const d of [recordsDir, crewDir, draftDir]) mkdirSync(d, { recursive: true })

function seedWorkers(records: ConcourseWorkerRecordV1[]): void {
  const workers = Object.fromEntries(records.map(r => [r.runnerId, r]))
  writeFileSync(join(recordsDir, 'concourse-workers.json'), `${JSON.stringify({ version: 1, workers }, null, 1)}\n`)
}
function liveRecord(runnerId: string, sessionId: string, workspaceId: string): ConcourseWorkerRecordV1 {
  return {
    schema: 1,
    runnerId,
    sessionId,
    workspaceId,
    isolation: 'exclusive',
    modelKey: 'fable',
    spawnedAt: NOW - 7 * 60_000,
    lastLiveAt: NOW,
    pid: process.pid,
  } as ConcourseWorkerRecordV1
}
function baseRow(cwd: string, sessionId: string, extra: Record<string, unknown>, atMs: number = NOW): Record<string, unknown> {
  return {
    isSidechain: false,
    entrypoint: 'cli',
    cwd,
    sessionId,
    version: '1.0.0-beta.1',
    gitBranch: 'main',
    parentUuid: null,
    uuid: `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
    timestamp: new Date(atMs).toISOString(),
    ...extra,
  }
}
function reply(cwd: string, sessionId: string, extra: Record<string, unknown> = {}, atMs: number = NOW): Record<string, unknown> {
  return baseRow(cwd, sessionId, {
    type: 'assistant',
    message: { id: `msg_${sessionId.slice(-4)}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'a reply.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
    ...extra,
  }, atMs)
}
function seedChat(project: string, sessionId: string, words: string, ageMs: number, opts: { husk?: boolean } = {}): string {
  const file = workerTranscriptPath({ sessionId, workspaceId: project })
  mkdirSync(project, { recursive: true })
  mkdirSync(dirname(file), { recursive: true })
  const atMs = NOW - ageMs
  const rows =
    opts.husk === true
      ? [reply(project, sessionId, { error: 'authentication_failed' }, atMs)]
      : words.length > 0
        ? [baseRow(project, sessionId, { type: 'user', message: { role: 'user', content: words } }, atMs), reply(project, sessionId, {}, atMs)]
        : [reply(project, sessionId, {}, atMs)]
  writeFileSync(file, encodeSeedTranscript(rows as never, sessionId))
  const at = new Date(atMs)
  utimesSync(file, at, at)
  return file
}
const sid = (tail: string): string => `00000000-cccc-4000-8000-${tail.padStart(12, '0')}`
const uncappedHas = (project: string, excluded: Set<string>, sessionId: string): boolean => olderChatsCensus(project, excluded, NOW, { entryCap: 99 }).entries.some(e => e.sessionId === sessionId)

console.log('§1 — the older-chats census (L20): one enumeration behind the N and the browse')
{
  const P = join(SCRATCH, 'proj-census')
  const S_LIVE = sid('11')
  const S_P1 = sid('a1')
  const S_P2 = sid('a2')
  const S_CLR = sid('c1')
  const S_O1 = sid('e1')
  const S_O2 = sid('e2')
  const S_O3 = sid('e3')
  const S_HUSK = sid('f1')
  const S_BLANK = sid('f2')
  const S_CMD = sid('f3')
  seedChat(P, S_LIVE, 'the live chat', 5 * 60_000)
  seedChat(P, S_P1, 'painted one', 60 * 60_000)
  seedChat(P, S_P2, 'painted two', 2 * 60 * 60_000)
  seedChat(P, S_CLR, 'the cleared chat', 3 * 60 * 60_000)
  seedChat(P, S_O1, 'older one', 8 * DAY)
  seedChat(P, S_O2, 'older two', 9 * DAY)
  seedChat(P, S_O3, 'older three', 10 * DAY)
  seedChat(P, S_HUSK, '', 4 * 60 * 60_000, { husk: true })
  seedChat(P, S_BLANK, '', 5 * 60 * 60_000)
  seedChat(P, S_CMD, '<command-name>/model</command-name><command-message>model</command-message><command-args>claude-opus-5</command-args>', 6 * 60 * 60_000)
  seedWorkers([liveRecord('concourse-w1', S_LIVE, P)])
  await markParkedCleared(S_CLR, draftDir)

  const excluded = new Set([S_LIVE, S_P1, S_P2])
  const census = olderChatsCensus(P, excluded, NOW, { entryCap: 2 })
  check('the N counts exactly the enumerable older chats (cleared + beyond-week; 1 + 3 = 4)', census.total === 4, String(census.total))
  check('POISON (the 21-vs-0 lie): the husk and the wordless leftover are in the store but in NEITHER the count NOR the list', census.total === 4 && !census.entries.some(e => e.sessionId === S_HUSK || e.sessionId === S_BLANK))
  check('a chat whose only input is a slash command (a /model switch, nothing said) is a leftover too: in the store, in neither the count nor the list', census.total === 4 && !uncappedHas(P, excluded, S_CMD))
  check('…and it is no painted parked row either — the board carries nothing of a chat where nothing was said', !parkedBoardRows(P, new Set([S_LIVE]), new Set([S_CLR]), NOW).some(r => r.sessionId === S_CMD))
  check('the entries are newest-first and carry the L16 stage-2 title, the transcript and a real age', census.entries.map(e => e.sessionId).join(',') === [S_CLR, S_O1].join(',') && census.entries[0]?.title === 'the cleared chat' && census.entries.every(e => e.transcriptPath.endsWith('.jsonl') && e.ageMs > 0), census.entries.map(e => `${e.sessionId.slice(-2)}:${e.title}`).join(' | '))
  check('the cap bounds the LIST, never the COUNT — the "+N more" tail arithmetic is honest (4 total − 2 listed = 2 more)', census.entries.length === 2 && census.total - census.entries.length === 2)
  const uncapped = olderChatsCensus(P, excluded, NOW, { entryCap: 99 })
  check('THE PIN (L20): the N equals the list the door opens — uncapped, entries.length === total', uncapped.total === 4 && uncapped.entries.length === uncapped.total, `${uncapped.total} vs ${uncapped.entries.length}`)
  check('an excluded id (live or painted) never appears as an entry', uncapped.entries.every(e => !excluded.has(e.sessionId)))

  const snap = await buildConcourseSnapshot({ recordsDir, crewDir, draftDir, nowMs: NOW, project: projectIdentity(P) })
  const parked = snap.groups.find(g => g.id === 'parked')?.rows ?? []
  const line = parked.find(r => r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX))
  const painted = parked.filter(r => !r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX))
  check('the board paints the week-tier rows and ONE older line whose N is the census total', painted.map(r => r.sessionId).join(',') === [S_P1, S_P2].join(',') && line?.title === '4 older chats · ↵ to browse', `${painted.map(r => r.sessionId.slice(-2)).join(',')} · ${line?.title ?? '(no line)'}`)
  const rebuilt = olderChatsCensus(P, new Set([S_LIVE, ...painted.map(r => r.sessionId)]), NOW, { entryCap: 99 })
  check('END TO END: the line\'s N === the census the door enumerates from (count = list, always)', line !== undefined && rebuilt.total === 4 && line.title.startsWith(`${rebuilt.total} older chat`), `${line?.title} vs ${rebuilt.total}`)

  const one = olderChatsCensus(P, new Set([S_LIVE, S_P1, S_P2, S_O1, S_O2, S_O3]), NOW, {})
  check('a census of one reads "1 older chat" (the row title\'s singular)', one.total === 1, String(one.total))

  const facts = [
    { sessionId: S_P1, transcriptPath: workerTranscriptPath({ sessionId: S_P1, workspaceId: P }), ageMs: 60 * 60_000 },
    { sessionId: S_CLR, transcriptPath: workerTranscriptPath({ sessionId: S_CLR, workspaceId: P }), ageMs: 3 * 60 * 60_000 },
    { sessionId: S_BLANK, transcriptPath: workerTranscriptPath({ sessionId: S_BLANK, workspaceId: P }), ageMs: 5 * 60 * 60_000 },
  ]
  const pure = parkedBoardRows(P, new Set<string>(), new Set([S_CLR]), NOW, undefined, facts)
  check('the fixture seam walks the same law: the cleared fact counts behind the line, the wordless fact never does', pure.filter(r => !r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)).map(r => r.sessionId).join(',') === S_P1 && pure.find(r => r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX))?.title === '1 older chat · ↵ to browse', pure.map(r => r.title).join(' | '))
}

console.log('§2 — the older-chats drop-down: unfolds on the board, ↵ reactivates through the one door, esc folds')
{
  const { CONCOURSE_CONTROLS, regionKeysFor } = await import('../../src/screen/concourse/controlManifest.ts')
  const { paneWindow } = await import('../../src/screen/widgets/geometry.ts')
  const ctl = CONCOURSE_CONTROLS.find(c => c.id === 'board:older-browse')
  check('the drop-down is a DECLARED control (return/right unfold · up/down choose · escape folds · rows click)', ctl !== undefined && ctl.region === 'list' && ['return', 'right', 'up', 'down', 'escape'].every(k => ctl.keys.includes(k)) && ctl.pointer === 'select-then-activate')
  check('while it stands the row legend yields to the browse grammar (one resolver)', regionKeysFor('list', { newSession: true, olderBrowse: true }).map(k => `${k.keys} ${k.label}`).join(',') === '↵ bring it back')
  const win = paneWindow(10, 7, 5)
  check('the cursor window keeps the pick visible with exact overflow counts (10 entries · cursor 7 · span 5)', win.start <= 7 && 7 < win.end && win.above === win.start && win.below === 10 - win.end)
}


console.log('§4 — one composer: the live pane owns its box; the strip is retired')
{
  const manifest = await import('../../src/screen/concourse/controlManifest.ts')
  check('the live panel key rows exist and the region table holds four panels (one resolver feeds legend + atlas)', manifest.CONCOURSE_REGION_KEYS.live.some(k => k.keys === 'pgup/pgdn') && Object.keys(manifest.CONCOURSE_REGION_KEYS).sort().join(',') === 'chat,list,live,rail')
}

console.log('§5 — arm-then-enter: the first ↵ arms the row as the live composer\'s target; the second enters')
{
  const manifest = await import('../../src/screen/concourse/controlManifest.ts')
  check('the arm is a DECLARED control and the list legend teaches ↵↵', manifest.CONCOURSE_CONTROLS.some(c => c.id === 'board:arm') && manifest.CONCOURSE_REGION_KEYS.list.some(k => k.keys === '↵↵' && k.label === 'enter session'))
}

console.log('§6 — the lock: an open ask ⇒ the live composer refuses with "needs you · ↵↵ to answer"; settle ⇒ unlocked')
{
  const { liveComposerGateOf } = await import('../../src/screen/concourse/ConcourseScreen.tsx')
  type Row = import('../../src/screen/concourse/contracts.ts').ConcourseRowV1
  const row = (over: Partial<Row>): Row =>
    ({ sessionId: sid('99'), title: 'the parser session', state: 'working', projectLabel: 'p', ownerLabel: null, ageLabel: null, seats: null, ...over }) as Row
  const locked = liveComposerGateOf(row({}), true)
  check('POISON (words queued behind an ask): an open ask LOCKS the box with the exact line', locked.ok === false && locked.line === 'needs you · ↵↵ to answer')
  const byState = liveComposerGateOf(row({ state: 'needs-you' }), false)
  check('the needs-you state locks too (both truths — the row state and the obligation)', byState.ok === false && byState.line === 'needs you · ↵↵ to answer')
  const working = liveComposerGateOf(row({ state: 'working' }), false)
  check('working ⇒ unlocked on the derived beat, the placeholder naming the target', working.ok === true && working.placeholder === 'message the parser session')
  const idle = liveComposerGateOf(row({ state: 'ready-to-review' }), false)
  check('idle ⇒ unlocked on the derived beat, the placeholder naming the target', idle.ok === true && idle.placeholder === 'message the parser session')
  check('every non-target class refuses in type (no silent dead box)', [
    liveComposerGateOf(undefined, false),
    liveComposerGateOf(row({ state: 'parked' }), false),
    liveComposerGateOf(row({ sessionId: 'dispatch:x' }), false),
    liveComposerGateOf(row({ state: 'queued' }), false),
    liveComposerGateOf(row({ door: { kind: 'pick-project', more: 2 } }), false),
    liveComposerGateOf(row({ state: 'attached' }), false),
    liveComposerGateOf(row({ state: 'stopped' }), false),
  ].every(g => g.ok === false))
  check('a queued row refuses by its TYPED state as well as by the live `dispatch:` id spelling (a fixture’s plain-id queued row takes no words either)', (liveComposerGateOf(row({ state: 'queued' }), false) as { line?: string }).line === 'queued — m stacks a message for its start')
  const older = (regionArg?: import('../../src/screen/concourse/ConcourseLayout.tsx').ConcourseRegion) =>
    liveComposerGateOf(row({ sessionId: `${OLDER_CHATS_ROW_PREFIX}/tmp/p` }), false, regionArg) as { ok: false; line: string }
  check('the older line speaks ↵ exactly where ↵ fires: the list region and the live box', older('list').line === 'older chats — ↵ unfolds the list' && older('live').line === 'older chats — ↵ unfolds the list' && older(undefined).line === 'older chats — ↵ unfolds the list')
  check('POISON (a ↵ advertised where it goes to another owner): from the rail or the split pane the note names the move that works from there', (['rail', 'chat'] as const).every(r => older(r).line === 'older chats — tab to the list, ↵ unfolds it'))

  console.log('§6b — the single-paint law: bottom hint stays, placeholder empties, one paint per refusal')
  {
    const { liveComposerPaintOf } = await import('../../src/screen/concourse/ConcourseScreen.tsx')
    const parkedGate = liveComposerGateOf(row({ state: 'parked' }), false)
    const parkedPaint = liveComposerPaintOf(parkedGate, null)
    check('PARKED: the placeholder EMPTIES and the BOTTOM hint carries the line, standing (no send needed)', parkedGate.ok === false && parkedPaint.restHint === '' && parkedPaint.note?.text === 'parked — ↵ brings it back; a sleeping chat takes no queue')
    const dupNote = { tone: 'muted' as const, text: parkedGate.ok === false ? parkedGate.line : '' }
    const parkedAfterSend = liveComposerPaintOf(parkedGate, dupNote)
    check('PARKED after a refused send (the screenshot): ONE paint — the note keeps the line, the placeholder stays empty', parkedAfterSend.restHint === '' && parkedAfterSend.note === dupNote)
    const queuedGate = liveComposerGateOf(row({ state: 'queued' }), false)
    const queuedPaint = liveComposerPaintOf(queuedGate, null)
    check('QUEUED (the second class — the generalization proven): same law, its own line once', queuedGate.ok === false && queuedPaint.restHint === '' && queuedPaint.note?.text === 'queued — m stacks a message for its start')
    const receipt = { tone: 'warning' as const, text: 'sent to 1 of 2 · 1 skipped' }
    check('an EXPLICIT note outranks the standing line (send receipts never masked)', liveComposerPaintOf(parkedGate, receipt).note === receipt)
    const okGate = liveComposerGateOf(row({}), false)
    const okPaint = liveComposerPaintOf(okGate, null)
    check('an OK gate is unchanged: the placeholder advertises the target, the note passes through', okGate.ok === true && okPaint.restHint === (okGate.ok ? okGate.placeholder : '') && okPaint.note === null && liveComposerPaintOf(okGate, receipt).note === receipt)
  }
}


console.log('§8 — G1/G3: text clips inside its container; every printed key fires on its stage')
{
  const { regionKeysFor } = await import('../../src/screen/concourse/controlManifest.ts')
  const reducedList = regionKeysFor('list', { newSession: false })
  check('G3: the reduced stage\'s ↵ enters on ONE press — its legend never teaches ↵↵ (no arm without a composer)', reducedList.some(k => k.keys === '↵' && k.label === 'enter session') && !reducedList.some(k => k.keys === '↵↵'))
  check('G3: the reduced stage prints no newline row (no composer takes one)', !regionKeysFor('live', { newSession: false }).some(k => k.label === 'newline') && !reducedList.some(k => k.label === 'newline'))
  const fullList = regionKeysFor('list', { newSession: true })
  check('G3 CONTROL: the full stage keeps the arm grammar (↵↵) and the composer rows', fullList.some(k => k.keys === '↵↵') && regionKeysFor('live', { newSession: true }).some(k => k.label === 'newline'))
}

console.log(failures === 0 ? '\nprove-concourse-design: ALL GREEN' : `\nprove-concourse-design: ${failures} FAILURE(S)`)
if (failures > 0) process.exit(1)
