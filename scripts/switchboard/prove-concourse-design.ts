#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-concourse-design.ts — THE CONCOURSE DESIGN
// pins (ledger L17 + L20). Executed units over the
//  REAL census owner and the REAL builder on a scratch store — no boot, no
//  daemon; the operator's look-captures ride the pool pass.
//
//   §1  THE OLDER-CHATS CENSUS (L20, the scope-truth bug): the "N older
//       chats" line's N and the browse list are ONE enumeration — the count
//       can never promise what no browse can show. The retired arithmetic
//       (projectChatCount − painted − a live estimate) counted auth husks
//       and wordless leftovers, while the ↵ door opened the /sessions
//       switcher whose project scope subtracts board-homed sessions and
//       cleared marks and partitions by each transcript's RECORDED cwd —
//       the live repro read "21 older chats" over a panel saying "No other
//       sessions in this project". The poison is any N the enumeration
//       cannot reproduce: a husk in the count, a cleared chat missing from
//       it, an entry the count never covered, or a second arithmetic.
// ============================================================================
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
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const { workerTranscriptPath } = await import('../../src/services/concourse/workerTranscript.ts')
const { buildConcourseSnapshot, olderChatsCensus, parkedBoardRows, markParkedCleared, OLDER_CHATS_ROW_PREFIX } = await import(
  '../../src/services/concourse/concourseSnapshot.ts'
)
const { projectIdentity } = await import('../../src/utils/bootCardFacts.ts')
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourseSupervisor.ts'

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
function baseRow(cwd: string, sessionId: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd,
    sessionId,
    version: '1.0.0-beta.1',
    gitBranch: 'main',
    parentUuid: null,
    uuid: `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
    timestamp: new Date(NOW).toISOString(),
    ...extra,
  }
}
function reply(cwd: string, sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return baseRow(cwd, sessionId, {
    type: 'assistant',
    message: { id: `msg_${sessionId.slice(-4)}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'a reply.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
    ...extra,
  })
}
/** Seed one chat file: words ⇒ a real chat; '' ⇒ a wordless leftover;
 *  husk ⇒ every output row wears the auth-failure annotation. */
function seedChat(project: string, sessionId: string, words: string, ageMs: number, opts: { husk?: boolean } = {}): string {
  const file = workerTranscriptPath({ sessionId, workspaceId: project })
  mkdirSync(project, { recursive: true })
  mkdirSync(dirname(file), { recursive: true })
  const rows =
    opts.husk === true
      ? [reply(project, sessionId, { error: 'authentication_failed' })]
      : words.length > 0
        ? [baseRow(project, sessionId, { type: 'user', message: { role: 'user', content: words } }), reply(project, sessionId)]
        : [reply(project, sessionId)]
  writeFileSync(file, encodeSeedTranscript(rows as never, sessionId))
  const at = new Date(NOW - ageMs)
  utimesSync(file, at, at)
  return file
}
const sid = (tail: string): string => `00000000-cccc-4000-8000-${tail.padStart(12, '0')}`

// ── §1: the census — the count IS the list ──────────────────────────────────
console.log('§1 — the older-chats census (L20): one enumeration behind the N and the browse')
{
  const P = join(SCRATCH, 'proj-census')
  const S_LIVE = sid('11')
  const S_P1 = sid('a1') // painted parked row (this week)
  const S_P2 = sid('a2') // painted parked row (this week)
  const S_CLR = sid('c1') // cleared (x-x) — hidden row, census member
  const S_O1 = sid('e1') // beyond the week — census member
  const S_O2 = sid('e2') // beyond the week — census member
  const S_O3 = sid('e3') // beyond the week — census member
  const S_HUSK = sid('f1') // auth husk — never a chat
  const S_BLANK = sid('f2') // wordless leftover — never a chat
  seedChat(P, S_LIVE, 'the live chat', 5 * 60_000)
  seedChat(P, S_P1, 'painted one', 60 * 60_000)
  seedChat(P, S_P2, 'painted two', 2 * 60 * 60_000)
  seedChat(P, S_CLR, 'the cleared chat', 3 * 60 * 60_000)
  seedChat(P, S_O1, 'older one', 8 * DAY)
  seedChat(P, S_O2, 'older two', 9 * DAY)
  seedChat(P, S_O3, 'older three', 10 * DAY)
  seedChat(P, S_HUSK, '', 4 * 60 * 60_000, { husk: true })
  seedChat(P, S_BLANK, '', 5 * 60 * 60_000)
  seedWorkers([liveRecord('concourse-w1', S_LIVE, P)])
  await markParkedCleared(S_CLR, draftDir)

  // The pure owner: excluded = the standing record + the painted rows.
  const excluded = new Set([S_LIVE, S_P1, S_P2])
  const census = olderChatsCensus(P, excluded, NOW, { entryCap: 2 })
  check('the N counts exactly the enumerable older chats (cleared + beyond-week; 1 + 3 = 4)', census.total === 4, String(census.total))
  check('POISON (the 21-vs-0 lie): the husk and the wordless leftover are in the store but in NEITHER the count NOR the list', census.total === 4 && !census.entries.some(e => e.sessionId === S_HUSK || e.sessionId === S_BLANK))
  check('the entries are newest-first and carry the L16 stage-2 title, the transcript and a real age', census.entries.map(e => e.sessionId).join(',') === [S_CLR, S_O1].join(',') && census.entries[0]?.title === 'the cleared chat' && census.entries.every(e => e.transcriptPath.endsWith('.jsonl') && e.ageMs > 0), census.entries.map(e => `${e.sessionId.slice(-2)}:${e.title}`).join(' | '))
  check('the cap bounds the LIST, never the COUNT — the "+N more" tail arithmetic is honest (4 total − 2 listed = 2 more)', census.entries.length === 2 && census.total - census.entries.length === 2)
  const uncapped = olderChatsCensus(P, excluded, NOW, { entryCap: 99 })
  check('THE PIN (L20): the N equals the list the door opens — uncapped, entries.length === total', uncapped.total === 4 && uncapped.entries.length === uncapped.total, `${uncapped.total} vs ${uncapped.entries.length}`)
  check('an excluded id (live or painted) never appears as an entry', uncapped.entries.every(e => !excluded.has(e.sessionId)))

  // The builder end-to-end: the painted line's N is the census's total.
  const snap = await buildConcourseSnapshot({ recordsDir, crewDir, draftDir, nowMs: NOW, project: projectIdentity(P) })
  const parked = snap.groups.find(g => g.id === 'parked')?.rows ?? []
  const line = parked.find(r => r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX))
  const painted = parked.filter(r => !r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX))
  check('the board paints the week-tier rows and ONE older line whose N is the census total', painted.map(r => r.sessionId).join(',') === [S_P1, S_P2].join(',') && line?.title === '4 older chats · ↵ to browse', `${painted.map(r => r.sessionId.slice(-2)).join(',')} · ${line?.title ?? '(no line)'}`)
  const rebuilt = olderChatsCensus(P, new Set([S_LIVE, ...painted.map(r => r.sessionId)]), NOW, { entryCap: 99 })
  check('END TO END: the line\'s N === the census the door enumerates from (count = list, always)', line !== undefined && rebuilt.total === 4 && line.title.startsWith(`${rebuilt.total} older chat`), `${line?.title} vs ${rebuilt.total}`)

  // The singular spelling stays honest.
  const one = olderChatsCensus(P, new Set([S_LIVE, S_P1, S_P2, S_O1, S_O2, S_O3]), NOW, {})
  check('a census of one reads "1 older chat" (the row title\'s singular)', one.total === 1, String(one.total))

  // The pure fold path (the fixture seam): facts handed in walk the same law.
  const facts = [
    { sessionId: S_P1, transcriptPath: workerTranscriptPath({ sessionId: S_P1, workspaceId: P }), ageMs: 60 * 60_000 },
    { sessionId: S_CLR, transcriptPath: workerTranscriptPath({ sessionId: S_CLR, workspaceId: P }), ageMs: 3 * 60 * 60_000 },
    { sessionId: S_BLANK, transcriptPath: workerTranscriptPath({ sessionId: S_BLANK, workspaceId: P }), ageMs: 5 * 60 * 60_000 },
  ]
  const pure = parkedBoardRows(P, new Set<string>(), new Set([S_CLR]), NOW, undefined, facts)
  check('the fixture seam walks the same law: the cleared fact counts behind the line, the wordless fact never does', pure.filter(r => !r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)).map(r => r.sessionId).join(',') === S_P1 && pure.find(r => r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX))?.title === '1 older chat · ↵ to browse', pure.map(r => r.title).join(' | '))
}

// ── §2: the drop-down door (7a) — in place, one resume door, honest tail ────
console.log('§2 — the older-chats drop-down: unfolds on the board, ↵ reactivates through the one door, esc folds')
{
  const { readFileSync } = await import('node:fs')
  const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')
  const { CONCOURSE_CONTROLS, regionKeysFor } = await import('../../src/components/concourse/controlManifest.ts')
  const { paneWindow } = await import('../../src/components/mercury-ui/geometry.ts')
  const ctl = CONCOURSE_CONTROLS.find(c => c.id === 'board:older-browse')
  check('the drop-down is a DECLARED control (return/right unfold · up/down choose · escape folds · rows click)', ctl !== undefined && ctl.region === 'list' && ['return', 'right', 'up', 'down', 'escape'].every(k => ctl.keys.includes(k)) && ctl.pointer === 'select-then-activate')
  check('while it stands the row legend yields to the browse grammar (one resolver)', regionKeysFor('list', { newSession: true, olderBrowse: true }).map(k => `${k.keys} ${k.label}`).join(',') === '↵ bring it back')
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  check('the pick rides the ONE resume door with its fact (resumeOlderChat: sessionId · transcriptPath · title)', screen.includes('callbacks.resumeOlderChat(pick.sessionId, pick.transcriptPath, pick.title)') && screen.includes('callbacks.resumeOlderChat(e.sessionId, e.transcriptPath, e.title)'))
  check('the entries come from THE CENSUS at the unfold, bounded by the week-tier budget (the count stays unbounded)', screen.includes('olderChatsCensus(projectDir, excluded, Date.now(), { entryCap: PARKED_CAP })'))
  check('the drop-down rides the peek\'s granted-rows channel in BOTH geometry call sites (one owner)', screen.includes('rowPeekOpen ? ROW_PEEK_DESIRED_ROWS : olderRows > 0 ? olderRows : chipRows') && layout.includes('rowPeekOpen ? ROW_PEEK_DESIRED_ROWS : olderRows > 0 ? olderRows : rowChipRows'))
  check('esc folds the list BEFORE the peek layer and the exit (one layer at a time)', ordered(screen, 'setOlderList(null)\n        return', 'setRowPeekOpen(false)\n        return') && ordered(screen, "if (ctx.kind !== 'chat') {", 'if (olderListRef.current !== null) {'))
  check('the tail is the honest arithmetic: window overflow + the census rest + the fold hint', screen.includes('+${beyond} more — /resume lists everything') && screen.includes("'esc folds'"))
  // The window math the paint uses: the cursor is always visible and the
  // overflow counts tile the entries exactly.
  const win = paneWindow(10, 7, 5)
  check('the cursor window keeps the pick visible with exact overflow counts (10 entries · cursor 7 · span 5)', win.start <= 7 && 7 < win.end && win.above === win.start && win.below === 10 - win.end)
}

// ── §3: one project-name owner (item 3) — the header loses the name + clock ─
console.log('§3 — one project-name owner: the rail\'s ground chip is THE name; the header carries neither name nor clock')
{
  const { readFileSync, readdirSync } = await import('node:fs')
  const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')
  const header = read('src/components/concourse/ConcourseHeader.tsx')
  check('POISON (the dedup): the header paints NO project name and NO clock — and holds no live-clock subscription', !header.includes('context.projectLabel') && !header.includes('liveClock') && !header.includes('snapshot.clock') && !header.includes('padTo(clock'))
  const strips = read('src/components/concourse/ConcourseStrips.tsx')
  check('the rail\'s ground chip IS the name (painted AND clickable — the segment that switches)', strips.includes('{snapshot.context.projectLabel} {GLYPH.chevronDown}') && strips.includes("id=\"concourse:rail:project\""))
  // Two landed shapes: the split frame gives the chat
  // pane an IDENTITY chip (' · project' — pane chrome, not a second
  // switcher), and the broadcast marks read the label in a
  // change-DETECTOR ref (four occurrences, zero paints). The rail chip
  // stays THE switcher; nothing else in the estate may touch the label.
  const dir = join(process.cwd(), 'src', 'components', 'concourse')
  // PAINTS are the render interpolation `{…context.projectLabel}` — a bare
  // read (the project-switch mark clear reads the label four times) is not
  // a second name on screen. The estate now paints the name in exactly TWO
  // owned places: the rail's ground chip (the board's one name) and the
  // split chat pane's title line (the chat side's own chrome — the split
  // fold's run-green design).
  let namePaints = 0
  for (const f of readdirSync(dir)) {
    if (!/\.(ts|tsx)$/.test(f)) continue
    namePaints += read(join('src', 'components', 'concourse', f)).split('{snapshot.context.projectLabel}').length - 1
  }
  check(
    'TWO paint owners, counted by the render interpolation: the rail chip + the split chat pane title (reads never count; any third paint reds here)',
    namePaints === 2 &&
      read('src/components/concourse/ConcourseStrips.tsx').includes('{snapshot.context.projectLabel}') &&
      read('src/components/concourse/SplitChatPane.tsx').includes('{snapshot.context.projectLabel}'),
    String(namePaints),
  )
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check('the composer hint teaches the gesture without naming the project (no second name)', screen.includes('launch two sessions on this project') && !screen.includes('launch two sessions on ${'))
}

// ── §4: the two composers (item 1) — targets, poison both ways, one ring ────
console.log('§4 — two composers: the coordinator pane owns its box, the live pane owns its box; the strip is retired')
{
  const { readFileSync } = await import('node:fs')
  const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  const pane = read('src/components/concourse/CoordinatorPane.tsx')
  const manifest = await import('../../src/components/concourse/controlManifest.ts')
  // The whole-screen composer RETIRED: the layout carries no composerNode
  // slot and budgets no strip band; the geometry names the live box.
  check('the full-width strip slot is gone from the layout (no composerNode, no strip band)', !layout.includes('composerNode') && !layout.includes('stripRows') && layout.includes('liveComposerBand'))
  // TARGETS, poison BOTH directions: the live box can never reach the
  // coordinator; the coordinator box can never reach a session's turn.
  const liveSendAt = screen.indexOf('const sendLive = (): void => {')
  const coordSendAt = screen.indexOf('const sendCoordinator = (): void => {')
  const liveSendBody = screen.slice(liveSendAt, coordSendAt)
  // The body's END anchors on the next top-level block ('THE HONEST FIRST
  // LINE' follows sendCoordinator's close). A vanished anchor reads RED via
  // the endAt guard — the retired anchor comment silently slid this slice
  // to EOF, where the callbacks WIRING tripped the poison as a false hit.
  const coordSendEnd = screen.indexOf('// THE HONEST FIRST LINE', coordSendAt)
  const coordSendBody = coordSendEnd > coordSendAt ? screen.slice(coordSendAt, coordSendEnd) : ''
  check('the LIVE send exists and rides the steering door (session.redirect) with the answer/rename contexts as its own delivery', liveSendAt > 0 && liveSendBody.includes('callbacks.redirectSession(') && liveSendBody.includes("ctx.kind === 'answer'") && liveSendBody.includes("ctx.kind === 'rename'"))
  check('POISON (live→coordinator): the live send never reaches the coordinator or the launcher', !liveSendBody.includes('sendCoordinatorMessage') && !liveSendBody.includes('submitSessionDraft'))
  check('POISON (coordinator→session): the coordinator send never reaches a session\'s turn', coordSendAt > 0 && coordSendEnd > coordSendAt && !coordSendBody.includes('redirectSession') && !coordSendBody.includes('answerObligation'))
  // ONE input widget per pane: the screen owns BOTH mounts; the pane hosts
  // the node it is handed and mints none of its own.
  check('the screen mounts the shared composer exactly twice (the pane\'s box + the live box)', screen.split('<ConcourseComposer').length - 1 === 2 && !pane.includes('<ConcourseComposer'))
  check('the coordinator pane hosts its composer at the foot (the mini-REPL grammar)', pane.includes('composerNode !== undefined && !settingsOpen'))
  // THE GATE: a refusing target takes no text — the reason paints instead
  // (nothing queues where no queue exists; item 6 arms needs-you here).
  check('the live gate refuses in type before any edit (printables and newline both check it)', screen.split('liveGateRefusal()').length - 1 >= 2 && ordered(screen, 'const refusal = liveGateRefusal()', 'side.edit(d => insertAt(d, payload))'))
  check('the gate names the refusal classes (parked · door · queued · attached · none)', ['no session selected', 'a door —', 'queued — m stacks', 'parked —', 'with you —'].every(s => screen.includes(s)))
  // THE PANEL RING (item 4): coordinator · list · live (+rail); the
  // retired region names are gone from the manifest.
  check('the ring is panels and the manifest speaks it', screen.includes("['coordinator', 'list', 'live']") && !JSON.stringify(manifest.CONCOURSE_CONTROLS).includes("\"region\":\"composer\"") && !JSON.stringify(manifest.CONCOURSE_CONTROLS).includes("\"region\":\"mirror\""))
  check('the live panel and coordinator panel key rows exist (one resolver feeds legend + atlas)', manifest.CONCOURSE_REGION_KEYS.live.some(k => k.keys === 'pgup/pgdn') && manifest.CONCOURSE_REGION_KEYS.coordinator.some(k => k.keys === '↵' && k.label === 'send'))
  // The placeholder names the target (item 2's spelling lands with the arm).
  check("the live box's placeholder names the SELECTED row", screen.includes('placeholder: `message ${sel.title} · queued for its next turn`'))
}

// ── §5: arm-then-enter (item 2) — one ↵ arms, ↵↵/→ enters, esc disarms ──────
console.log('§5 — arm-then-enter: the first ↵ arms the row as the live composer\'s target; the second enters')
{
  const { readFileSync } = await import('node:fs')
  const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  const manifest = await import('../../src/components/concourse/controlManifest.ts')
  check('the arm is a DECLARED control and the list legend teaches ↵↵', manifest.CONCOURSE_CONTROLS.some(c => c.id === 'board:arm') && manifest.CONCOURSE_REGION_KEYS.list.some(k => k.keys === '↵↵' && k.label === 'enter session'))
  const enterAt = screen.indexOf('const enterSession = (sessionId: string, opts')
  const enterBody = screen.slice(enterAt, screen.indexOf('// ── the git offer', enterAt))
  check('the arm stage sits AFTER the door/older/queued grammars (they keep one press) and skips pointer + the reduced stage', ordered(enterBody, 'door !== undefined', "opts.pointer !== true && boardArmedRef.current !== sessionId") && enterBody.includes('!reducedStage && opts.pointer !== true'))
  check('a second ↵ on the ARMED row enters (the arm clears at the door)', ordered(enterBody, 'setBoardArmed(sessionId)', 'boardArmedRef.current = null') && enterBody.includes('callbacks.enterSession(sessionId)'))
  check('→ on an ARMED row enters (both the list and the live panel arms)', screen.split('boardArmedRef.current === sel.sessionId').length - 1 >= 2)
  check('esc disarms as its own layer (after the older fold, before the peek)', ordered(screen, '// ITEM 7: esc folds the drop-down', '// ARM-THEN-ENTER (item 2): esc disarms') && ordered(screen, '// ARM-THEN-ENTER (item 2): esc disarms', '// Line 5: esc closes the row peek first'))
  check('a selection move disarms (the target is ALWAYS the selected chat — the operator\'s words)', screen.includes('if (boardArmed !== null && boardSel !== boardArmed) setBoardArmed(null)'))
  check('typing in the live composer ARMS the selected row (the target turns explicit)', screen.split('armSelectedForTyping()').length - 1 >= 2)
  check('the armed row SHOWS the arm on its granted line — the words road is tab (the composer’s own focus), advertised only where the gate takes words (G4; the broadcast face suppresses it too), and a held draft says send', screen.includes("'armed — ↵ again enters'") && screen.includes("liveDraft.text.trim().length === 0 && liveComposerGate(sel).ok && broadcastFaceOf(markedRows.length) === null ? ' · tab to message' : ''") && screen.includes("'armed — ↵ sends the draft · → enters'"))
  // TYPED WORDS OUTRANK THE EXAMPLE (the driven arena red: with words in the
  // coordinator composer, ↵ dispatched the ghost example over the operator's
  // own ask) — the pane's example ↵ yields to a held draft, and the screen
  // hands the fact from the one draft owner.
  const pane = read('src/components/concourse/CoordinatorPane.tsx')
  check('the example walk\'s ↵ yields to a held draft (typed words outrank the example — the one precedence law)', pane.includes('&& !pending && !draftHeld) {') && screen.includes('draftHeld={draft.text.trim().length > 0}'))
  // THE EXAMPLE FILLS THE BOX, NEVER SENDS (field TASK-E001, item 7): a bare ↵
  // on the empty coordinator composer dispatched the ghost example as a real
  // message. The pick handler places the words in the composer and calls no
  // send; the next ↵ (words held) is the operator's own send.
  const pickAt = screen.indexOf('onPickExample={text => {')
  const pickBody = pickAt === -1 ? '' : screen.slice(pickAt, screen.indexOf('}}', pickAt))
  check('the example walk\'s ↵ (and a click) FILLS the composer and never sends — the pick handler calls no send', pickAt !== -1 && pickBody.includes('setDraft(draftRef.current)') && !pickBody.includes('sendCoordinator(') && !pane.includes('onSendExample') && pane.includes('onPickExample(COORDINATOR_EXAMPLE_PROMPTS[exampleIdxRef.current]!)') && pane.includes('· ↵ fills the box'), pickBody.slice(0, 160))
  // THE ONE MODAL OWNER reaches the pane (the driven cross-project red: the
  // repo picker painted while the pane's ↓/↵ walked the ghost example — a
  // pairwise settingsOpen/gitOffer guard is the fossil class boardModalOwner
  // replaced): the pane parks whole on the one screen-computed fact.
  check('the pane\'s own verbs park under ANY board modal owner (modalUp = the one boardModalOwner read, never a pairwise guard)', pane.includes('if (modalUp || settingsOpen) return') && screen.includes('modalUp={') && screen.split('boardModalOwner({').length - 1 >= 2)
  check('the legend says the truth in both states (↵↵ unarmed · ↵ enters while armed)', layout.includes("{ keys: '↵', label: 'enters (armed)' }") && layout.includes("{ keys: '↵↵', label: 'enter session' }"))
}

// ── §6: the composer lock (item 6) — an open ask takes no queued words ──────
console.log('§6 — the lock: an open ask ⇒ the live composer refuses with "needs you · ↵↵ to answer"; settle ⇒ unlocked')
{
  const { liveComposerGateOf } = await import('../../src/components/concourse/ConcourseScreen.tsx')
  const { readFileSync } = await import('node:fs')
  const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')
  type Row = import('../../src/components/concourse/contracts.ts').ConcourseRowV1
  const row = (over: Partial<Row>): Row =>
    ({ sessionId: sid('99'), title: 'the parser session', state: 'working', projectLabel: 'p', ownerLabel: null, ageLabel: null, seats: null, ...over }) as Row
  const locked = liveComposerGateOf(row({}), true)
  check('POISON (words queued behind an ask): an open ask LOCKS the box with the exact line', locked.ok === false && locked.line === 'needs you · ↵↵ to answer')
  const byState = liveComposerGateOf(row({ state: 'needs-you' }), false)
  check('the needs-you state locks too (both truths — the row state and the obligation)', byState.ok === false && byState.line === 'needs you · ↵↵ to answer')
  const settled = liveComposerGateOf(row({}), false)
  check('settle ⇒ unlocked on the derived beat, the placeholder naming the target', settled.ok === true && settled.placeholder === 'message the parser session · queued for its next turn')
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
  // THE PRESENT-MOVES NOTE (TASK-017 V3, the box's region nuance): the older
  // line's refusal advertises ↵ — a key that unfolds only where it reaches
  // the board (the list's own ↵, the live box's empty-draft browse verb).
  // The coordinator's ↵ is owned by its zero-state example walk and its →
  // by caret travel, so the KEY cannot be generalized: the NOTE follows the
  // region. Undeclared region (delivery-time refusals) keeps the landed line.
  const older = (regionArg?: import('../../src/components/concourse/ConcourseLayout.tsx').ConcourseRegion) =>
    liveComposerGateOf(row({ sessionId: `${OLDER_CHATS_ROW_PREFIX}/tmp/p` }), false, regionArg) as { ok: false; line: string }
  check('the older line speaks ↵ exactly where ↵ fires: the list region and the live box', older('list').line === 'older chats — ↵ unfolds the list' && older('live').line === 'older chats — ↵ unfolds the list' && older(undefined).line === 'older chats — ↵ unfolds the list')
  check('POISON (the box\'s three identical coordinator passes): from the coordinator/rail/chat the note names the move that works from there, never a ↵ that goes to another owner', (['coordinator', 'rail', 'chat'] as const).every(r => older(r).line === 'older chats — tab to the list, ↵ unfolds it'))
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  // The derivation call is multiline and carries the wall-line arg
  // (the credential wall's one honest line rides the gate);
  // read it whitespace-folded so formatting can never red the law. The law
  // itself is unchanged: derived per paint from sel + needsYou + region,
  // no stored lock anywhere.
  const screenFolded = screen.replace(/\s+/g, ' ')
  check('the gate is DERIVED, never stored (the lock cannot go stale in either direction — the L17 cut\'s whole point)', screenFolded.includes('liveComposerGateOf( sel, sel !== undefined && snapshot.needsYou.some(o => o.sessionId === sel.sessionId), noteRegion, sel !== undefined ? wallLineBySession.get(sel.sessionId) : undefined, )'))
  check('the rest hint hands the gate its region (the advertisement follows the operator\'s focus)', screen.includes('liveComposerGate(sessionRows.find(r => r.sessionId === boardSel), region)'))
  check('the answer context rides ABOVE the gate (an answer is never queued behind the ask it settles)', screen.includes("if (composeContextRef.current.kind !== 'chat') return null") && ordered(screen, "ctx.kind === 'answer'", 'const gate = liveComposerGate(sel)'))

  // ── §6b THE SINGLE-PAINT LAW (AGENTDIALS C5): a refusing gate's line
  //    paints ONCE — the meta row carries it standing, the placeholder
  //    EMPTIES (the operator's screenshot: the parked line twice, the
  //    placeholder AND the hint under it after a refused send mirrored the
  //    same words into the note). Every refusing class inherits — the
  //    parked class AND a second class pinned so the generalization is
  //    proven, not assumed.
  console.log('§6b — the single-paint law: bottom hint stays, placeholder empties, one paint per refusal')
  {
    const { liveComposerPaintOf } = await import('../../src/components/concourse/ConcourseScreen.tsx')
    const parkedGate = liveComposerGateOf(row({ state: 'parked' }), false)
    const parkedPaint = liveComposerPaintOf(parkedGate, null)
    check('PARKED: the placeholder EMPTIES and the BOTTOM hint carries the line, standing (no send needed)', parkedGate.ok === false && parkedPaint.restHint === '' && parkedPaint.note?.text === 'parked — ↵↵ brings it back; a sleeping chat takes no queue')
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
    check('the composer consumes the one derivation (the raw gate line never rides restHint)', screen.includes('const paint = liveComposerPaintOf(g, liveNote)') && screen.includes('restHint={face !== null ? face.placeholder : paint.restHint}') && !screen.includes('return g.ok ? g.placeholder : g.line'))
  }
}

// ── §7: focus is legible (item 4) — accent borders, dimmed siblings, the
//    spelled selected state, the designed empty state, mouse parity ─────────
console.log('§7 — focus legibility: the focused panel\'s border takes the accent; siblings dim; the selected row speaks')
{
  const { readFileSync } = await import('node:fs')
  const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  const pane = read('src/components/concourse/CoordinatorPane.tsx')
  const manifest = await import('../../src/components/concourse/controlManifest.ts')
  check('all three panels carry the ONE focus grammar (accent border focused, subtle otherwise — existing tokens, no new hex)', layout.includes("borderColor={region === 'list' ? t.info : t.borderSubtle}") && layout.includes("borderColor={region === 'live' ? t.info : t.borderSubtle}") && pane.includes('borderColor={focused ? t.info : t.borderSubtle}'))
  check('the panel titles dim with their panels', layout.includes("region === 'list' || hover ? t.infoText : t.textMuted") && pane.includes('focused || hover ? t.infoText : t.textMuted'))
  check('the SELECTED row spells its state beside the glyph (NEEDS YOU legible at a glance, its own ink)', layout.includes('STATE_WORD[r.state] ?? r.state') && layout.includes("'needs-you': 'NEEDS YOU'"))
  check('the empty state is designed: no column header over nothing; both doors clickable', layout.indexOf('THE EMPTY STATE, designed') > 0 && layout.includes('no sessions yet') && layout.includes("id=\"concourse:board:empty-new\"") && !layout.slice(layout.indexOf('THE EMPTY STATE, designed'), layout.indexOf('if (sessionRows.length === 0) {', layout.indexOf('THE EMPTY STATE, designed'))).includes('columnHeaderRow'))
  check('every Tab stop has a pointer path (the manifest census: title clicks focus panels)', ['board:focus', 'coordinator:focus-title', 'board:empty-new'].every(id => manifest.CONCOURSE_CONTROLS.some(c => c.id === id)))
  check('the live panel is a real frame around the mirror + its composer (the band unchanged; content rows − 2)', layout.includes('mirrorNode(Math.max(1, mirrorRows - 2)'))
}

// ── §8: the perfectionist pass (G1 overflow · G3 input-mapping truth) ───────
console.log('§8 — G1/G3: text clips inside its container; every printed key fires on its stage')
{
  const { readFileSync } = await import('node:fs')
  const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')
  const strips = read('src/components/concourse/ConcourseStrips.tsx')
  check('G1: the rail\'s coordinator chip clamps to its budget (an unbounded fallbackReason once pushed the counts)', strips.includes('truncateToWidth(`coordinator · ${snapshot.coordinator.fallbackReason}`, Math.max(16, chipBudget))'))
  check('G1: the repo picker\'s title clips honestly; the header\'s handle yields, never pushes the lockup', read('src/components/concourse/GroundPicker.tsx').includes('<Text wrap="truncate-end">\n          <Text color={t.infoText} bold>\n            REPO') && read('src/components/concourse/ConcourseHeader.tsx').includes('a long handle clips, never pushes the lockup'))
  const { regionKeysFor } = await import('../../src/components/concourse/controlManifest.ts')
  const reducedList = regionKeysFor('list', { newSession: false })
  check('G3: the reduced stage\'s ↵ enters on ONE press — its legend never teaches ↵↵ (no arm without a composer)', reducedList.some(k => k.keys === '↵' && k.label === 'enter session') && !reducedList.some(k => k.keys === '↵↵'))
  check('G3: the reduced stage prints no newline row (no composer takes one)', !regionKeysFor('live', { newSession: false }).some(k => k.keys === '⇧↵/⌃j') && !reducedList.some(k => k.keys === '⇧↵/⌃j'))
  const fullList = regionKeysFor('list', { newSession: true })
  check('G3 CONTROL: the full stage keeps the arm grammar (↵↵) and the composer rows', fullList.some(k => k.keys === '↵↵') && regionKeysFor('live', { newSession: true }).some(k => k.keys === '⇧↵/⌃j'))
}

console.log(failures === 0 ? '\nprove-concourse-design: ALL GREEN' : `\nprove-concourse-design: ${failures} FAILURE(S)`)
if (failures > 0) process.exit(1)
