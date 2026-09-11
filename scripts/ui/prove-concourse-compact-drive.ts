#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
const ESC = '\x1b'
const SHIFT_RIGHT = `${ESC}[1;2C`
const DOWN = `${ESC}[B`

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail.slice(0, 400)}` : ''}`)
  }
}

console.log('§1 the pure geometry and legends of the compact concourse')
{
  const board = await import('../../src/components/concourse/compactBoard.ts')
  check('60 columns and up split; under 60 the board stands alone', board.compactConcourseProfileOf(60) === 'split' && board.compactConcourseProfileOf(59) === 'single' && board.compactConcourseProfileOf(80) === 'split' && board.compactConcourseProfileOf(50) === 'single')
  const g21 = board.compactConcourseGeometry(80, 21, { sessionCount: 2, newSessionDoor: true, composerBand: 1 })
  check('80×21: the list frame is 28 wide, the live frame takes the rest after one gap column', g21.list.x0 === 0 && g21.list.x1 === 27 && g21.list.inner === 26 && g21.live.x0 === 29 && g21.live.x1 === 79 && g21.live.inner === 49)
  check('80×21: nineteen inner rows — fifteen mirror rows, a three-row composer, one foot', g21.framed && g21.inner === 19 && g21.mirrorRows === 15 && g21.composerRows === 3 && g21.composerBand === 1 && g21.liveFootRows === 1)
  check('80×21: two sessions leave the blank row and the new-session row', g21.newSessionRows === 2 && g21.listFootRows === 1 && g21.listWindowRows === 16)
  const g14 = board.compactConcourseGeometry(80, 14, { sessionCount: 2, newSessionDoor: true, composerBand: 1 })
  check('80×14: twelve inner rows — eight mirror rows, the framed composer, one foot', g14.inner === 12 && g14.mirrorRows === 8 && g14.composerRows === 3 && g14.liveFootRows === 1)
  const g16 = board.compactConcourseGeometry(50, 16, { sessionCount: 6, newSessionDoor: true, composerBand: 1 })
  check('50×16: one frame across the width; fourteen inner rows; the six rows keep the new-session row', g16.profile === 'single' && g16.list.x0 === 0 && g16.list.x1 === 49 && g16.list.inner === 48 && g16.inner === 14 && g16.newSessionRows === 2 && g16.listWindowRows === 11)
  const g13 = board.compactConcourseGeometry(80, 13, { sessionCount: 2, newSessionDoor: true, composerBand: 3 })
  check('80×13: the composer sheds its border with the estate floor; a three-line draft keeps its band and the mirror keeps seven rows', g13.composerRows === 3 && g13.composerBand === 3 && g13.mirrorRows === 7)
  const g9 = board.compactConcourseGeometry(80, 9, { sessionCount: 2, newSessionDoor: true, composerBand: 3 })
  check('80×9: a three-line draft keeps its band and the mirror keeps its three rows', g9.composerRows === 3 && g9.mirrorRows === 3)
  const g8 = board.compactConcourseGeometry(80, 8, { sessionCount: 2, newSessionDoor: true, composerBand: 3 })
  check('80×8: the band clamps to two lines so the mirror keeps its three rows', g8.composerRows === 2 && g8.mirrorRows === 3)
  const g5 = board.compactConcourseGeometry(80, 5, { sessionCount: 2, newSessionDoor: true, composerBand: 1 })
  check('80×5: three inner rows — one composer line, one mirror row, the foot', g5.composerRows === 1 && g5.mirrorRows === 1 && g5.liveFootRows === 1)
  for (const [c, r] of [[1, 1], [2, 2], [3, 3], [40, 10], [59, 3], [60, 3], [80, 2]] as const) {
    const g = board.compactConcourseGeometry(c, r, { sessionCount: 4, newSessionDoor: true, composerBand: 1 })
    check(`${c}×${r}: a layout, never a refusal — every grant nonnegative and inside the frame`, g.inner >= 0 && g.mirrorRows >= 0 && g.composerRows >= 0 && g.listWindowRows >= 0 && g.mirrorRows + g.composerRows + g.liveFootRows <= Math.max(g.inner, 0) && g.listWindowRows + g.newSessionRows + g.listFootRows <= Math.max(g.inner, 0) && (!g.framed || g.inner === r - 2))
  }
  check('the list frame top reads as the mockup draws it', board.compactFrameTop('sessions · 2', 28) === '╭─sessions · 2 ────────────╮')
  check('the live frame top reads as the mockup draws it', board.compactFrameTop('mercury-beta6-lead · running · 12m', 51) === '╭─mercury-beta6-lead · running · 12m ─────────────╮')
  check('a long title truncates with the ellipsis and the frame stays its width', board.compactFrameTop('<local-command-caveat>Caveat: The messages below were generated', 28).length === 28 && board.compactFrameTop('<local-command-caveat>Caveat: The messages below were generated', 28).includes('…'))
  check('the frame bottom closes at the width', board.compactFrameBottom(28) === '╰──────────────────────────╯')
  check('the bold fork keeps the collapsed-palette shape grammar', board.compactFrameTop('sessions · 2', 28, board.compactFrameGlyphs(true)).startsWith('┏━sessions · 2 ━'))
  check('the titles are one owner', board.compactListTitle(2, '') === 'sessions · 2' && board.compactListTitle(1, ' oauth ') === 'sessions · 1 · /oauth' && board.compactLiveTitle({ title: 'mercury-beta6-lead', stateWord: 'running', ageLabel: '12m' }) === 'mercury-beta6-lead · running · 12m' && board.compactLiveTitle({ title: 'x', stateWord: 'parked', ageLabel: null }) === 'x · parked')
  check('the board title counts running and finished from the rows, never a door', board.compactBoardTitle([{ state: 'working' }, { state: 'ready-to-review' }, { state: 'queued' }, { state: 'elsewhere', door: {} }]) === 'Session Concourse · 1 running · 1 finished')
  check('the split legends are the approved words', board.COMPACT_LIST_FOOT === '↑↓ pick · ↵ steer' && board.compactLiveFoot({ verbsFire: true }) === '⇥ list · x stop · p pause · esc board' && board.compactLiveFoot({ verbsFire: false }) === '⇥ list · esc board')
  check('the board foot carries every key at width and shortens to the three that matter', board.compactBoardFoot(76, { filtering: false, newSessionDoor: true }) === '↵ open · n new · / filter · ? keys · esc boot face' && board.compactBoardFoot(47, { filtering: false, newSessionDoor: true }) === '↵ open · n new · esc' && board.compactBoardFoot(9, { filtering: false, newSessionDoor: true }) === '↵ open')
  check('the opened foot says send with words held and enter without', board.compactOpenedFoot({ reduced: false, verbsFire: true, draftHeld: true }) === '↵ send · x stop · p pause · esc back' && board.compactOpenedFoot({ reduced: false, verbsFire: true, draftHeld: false }) === '↵ enter · x stop · p pause · esc back')
  check('the filter legend is the board’s own', board.compactListFoot({ filtering: true, reduced: false }) === 'type to filter · ↵ apply · esc clear')
  const olderPrefix = 'older:'
  check('a session row steers; doors, the older line, held launches and parked rows keep their one press', board.compactSteerable({ sessionId: 's1', state: 'working' }, { reduced: false, olderPrefix }) && !board.compactSteerable({ sessionId: 's1', state: 'working', door: {} }, { reduced: false, olderPrefix }) && !board.compactSteerable({ sessionId: 'older:/p', state: 'parked' }, { reduced: false, olderPrefix }) && !board.compactSteerable({ sessionId: 'dispatch:1', state: 'queued' }, { reduced: false, olderPrefix }) && !board.compactSteerable({ sessionId: 's2', state: 'parked' }, { reduced: false, olderPrefix }) && !board.compactSteerable({ sessionId: 's1', state: 'working' }, { reduced: true, olderPrefix }))
  const win = board.compactListWindow(6, 5, 4)
  check('a long list windows around the selection with one more-row', win.moreRow === 1 && win.end - win.start === 3 && win.start <= 5 && 5 < win.end && win.above + win.below === 3)
  const split = await import('../../src/components/concourse/splitView.ts')
  check('the s split never composes under the compact decision', !split.splitActiveOf({ on: true, cols: 130, rows: 24, plainWorld: false, compact: true }) && split.splitActiveOf({ on: true, cols: 130, rows: 24, plainWorld: false, compact: false }))
}

console.log('§2 the screen: the compact decision is the size latch; two focus targets; the letter verbs')
{
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check('the compact decision is the layout latch, split at 60 columns', screen.includes('const compactProfile = isCompact ? compactConcourseProfileOf(termCols) : null'))
  check('the split frame stands down under compact', screen.includes('const splitActive = !reducedStage && !compact && splitViewOn() && splitAvailableAt(termCols, termRows)'))
  check('the list has focus first; the ring is the two frames', screen.includes("if (compact) return carried === 'live' ? 'live' : 'list'") && screen.includes("const ring: ConcourseRegion[] = compact || reducedStage ? ['list', 'live'] : ['coordinator', 'list', 'live']") && screen.includes("if (compact && region !== 'list' && region !== 'live') setRegion('list')"))
  check('↵ on the list hands focus to the composer — the arm, then the region', screen.includes("boardArmedRef.current = sel.sessionId\n      setBoardArmed(sel.sessionId)\n      setRegion('live')") && screen.includes('if (sel) compactSteerOrEnter(sel)'))
  check('esc from the composer returns to the list before the arm layer', screen.indexOf("if (compact && region === 'live') {\n        boardArmedRef.current = null") < screen.indexOf('if (boardArmedRef.current !== null) {') && screen.indexOf("if (compact && region === 'live') {\n        boardArmedRef.current = null") > 0)
  const xSites = screen.match(/input === 'x'/g) ?? []
  check('plain x stops only on the compact concourse — from the rows, and from the composer while its draft is empty', xSites.length === 3 && screen.includes("if (compact && input === 'x' && !key.ctrl && !key.meta && pastGate()) {") && screen.includes("if (compact && region === 'live' && !key.ctrl && !key.meta && (input === 'x' || input === 'p') && liveDraftRef.current.text.length === 0 && pastGate()) {") && screen.includes("if (input === 'x') rowStop()"))
  check('the coordinator pane and the rails are absent: the compact tree is its own painter', screen.includes('<CompactConcourse') && screen.includes('compactProfile !== null ? (') && screen.includes('mirrorNode={(rows, width) => mirrorSlot(rows, width, true)}'))
  check('the composer keeps its meta row only at full size; the compact foot carries the notes', screen.includes('foot={!compact}') && screen.includes("noteOf(controlNotes?.['strip:composer']) ??"))
  const strips = read('src/components/concourse/ConcourseStrips.tsx')
  check('the composer can stand without its meta row', strips.includes('foot = true,') && strips.includes('{foot ? (') )
  const manifest = await import('../../src/components/concourse/controlManifest.ts')
  check('the compact controls are declared', ['compact:row', 'compact:steer', 'compact:list-title', 'compact:live-title', 'compact:new-session', 'compact:stop'].every(id => manifest.CONCOURSE_CONTROLS.some(c => c.id === id)))
}

if (process.env.PROVE_CONCOURSE_COMPACT_STATIC === '1') {
  console.log('§3 skipped (PROVE_CONCOURSE_COMPACT_STATIC=1)')
  process.exit(failures === 0 ? 0 : 1)
}

const BIN = process.env.MERCURY_CONCOURSE_COMPACT_DIST ?? join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}
console.log(`§3 the drive — ${BIN}`)
const OUT_DIR = process.env.CONCOURSE_COMPACT_CAPTURE_DIR ?? join(tmpdir(), `concourse-compact-${process.pid}`)
mkdirSync(OUT_DIR, { recursive: true })
const scratch = join(OUT_DIR, 'home')
rmSync(scratch, { recursive: true, force: true })
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_HOME = ''
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { referenceFixtureSnapshot } = await import('../notifications/concourseReferenceSeed.ts')
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const { workerTranscriptPath } = await import('../../src/services/concourse/workerTranscript.ts')
seedFirstRun(scratch, [REPO])
{
  const cfgPath = join(scratch, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  cfg['switchboardCapacity'] = { askedAt: 1754000000000, allowed: true, recommendedSeats: 5 }
  cfg['concourseCoordinator'] = { mode: 'agent-assisted', assistModel: 'claude-opus-5' }
  cfg['customApiKeyResponses'] = { approved: ['fixture-key-000'], rejected: [] }
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const fixture = referenceFixtureSnapshot() as { groups: Array<{ rows: Array<Record<string, unknown>> }>; needsYou: unknown[]; coordinator: unknown }
  for (const g of fixture.groups) for (const r of g.rows) r.workspaceDir = scratch
  fixture.needsYou = []
  fixture.coordinator = { mode: 'agent-assisted', assistModelLabel: 'Opus 5' }
  writeFileSync(join(scratch, 'concourse-fixture.json'), JSON.stringify(fixture))
  const now = Date.now()
  const base = (sessionId: string, extra: Record<string, unknown>): Record<string, unknown> => ({
    isSidechain: false,
    entrypoint: 'cli',
    cwd: scratch,
    sessionId,
    version: '1.0.0-beta.6',
    gitBranch: 'main',
    parentUuid: null,
    uuid: `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
    timestamp: new Date(now).toISOString(),
    ...extra,
  })
  for (const [sid, words, reply] of [
    ['s-audit', 'hi', 'Hi! Ready to help. What would you like to work on?'],
    ['s-oauth', 'fix the callback', 'Looking at the callback owner now.'],
  ] as const) {
    const file = workerTranscriptPath({ sessionId: sid, workspaceId: scratch })
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      encodeSeedTranscript(
        [
          base(sid, { type: 'user', message: { role: 'user', content: words } }),
          base(sid, { type: 'assistant', message: { id: `msg_${sid}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }),
        ] as never,
        sid,
      ),
    )
  }
}

type Grid = { grid: { c: string }[][] }
const linesOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join('').replace(/\s+$/, ''))
interface Send {
  atTick?: number
  afterPrevTicks?: number
  data: string
  awaitText?: string
  minTick?: number
  awaitSettleTicks?: number
  requireAwait?: boolean
  mark?: string
}
const marked = new Map<string, string[]>()
const markOf = (tag: string, label: string): string[] => marked.get(`${tag}:${label}`) ?? []
function capture(tag: string, cols: number, rows: number, sends: Send[], total: number): number | null {
  const out = join(OUT_DIR, `${tag}-${cols}x${rows}.json`)
  const cfgPath = join(OUT_DIR, `${tag}-${cols}x${rows}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN], cwd: REPO, sends, total, cols, rows, out }))
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MERCURY_CONFIG_DIR: scratch,
    MERCURY_HOME: '',
    MERCURY_CONCOURSE_FIXTURE: join(scratch, 'concourse-fixture.json'),
    MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
    MERCURY_CREW_DIR: join(scratch, 'crew'),
    MERCURY_AWAY_SUMMARY: '0',
    MERCURY_PARTY: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  }
  delete env.MERCURY_CONCOURSE
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(240_000), env })
  if (res.status !== 0) console.error(`  vshot ${tag} ${cols}x${rows} exit=${res.status}: ${(res.stderr ?? '').slice(-600)}`)
  if (!existsSync(out)) return res.status
  const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid & { marks?: ({ label: string } & Grid)[] }
  for (const m of payload.marks ?? []) {
    marked.set(`${tag}:${m.label}`, linesOf(m))
    writeFileSync(join(OUT_DIR, `${tag}-${cols}x${rows}-mark-${m.label}.txt`), linesOf(m).join('\n') + '\n')
  }
  return res.status
}
const printFrame = (label: string, rows: string[]): void => {
  console.log(`┌── ${label}`)
  for (const r of rows) console.log(`│${r}`)
  console.log('└──')
}
const has = (rows: string[], needle: string): boolean => rows.some(r => r.includes(needle))
const rowOf = (rows: string[], needle: string): number => rows.findIndex(r => r.includes(needle))
const rightOf = (line: string | undefined, col: number): string => (line ?? '').slice(col)
const leftOf = (line: string | undefined, col: number): string => (line ?? '').slice(0, col)

const face = { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: SHIFT_RIGHT, mark: 'face' }

console.log('§3a 80×21 — two frames, the key journey')
{
  const status = capture('split', 80, 21, [
    face,
    { atTick: 999, awaitText: 'sessions · 6', minTick: 3, awaitSettleTicks: 3, requireAwait: true, data: DOWN, mark: 'board' },
    { afterPrevTicks: 4, data: '\r', mark: 'down' },
    { afterPrevTicks: 4, data: 'steer words', mark: 'enter' },
    { afterPrevTicks: 5, data: '\t', mark: 'typed' },
    { afterPrevTicks: 4, data: ESC, mark: 'tab' },
    { afterPrevTicks: 4, data: SHIFT_RIGHT, mark: 'esc' },
    { atTick: 999, awaitText: 'sessions · 6', minTick: 3, awaitSettleTicks: 3, requireAwait: true, data: 'n', mark: 'back' },
    { afterPrevTicks: 6, data: '', mark: 'new' },
  ], 150)
  check('80×21: the drive ran every send', status === 0)
  const board = markOf('split', 'board')
  for (const label of ['board', 'down', 'enter', 'typed', 'tab', 'esc', 'new']) printFrame(`80×21 ${label}`, markOf('split', label))
  check('80×21: the frame is 21 rows with the two frames side by side', board.length === 21 && board[0]?.startsWith('╭─sessions · 6 ────────────╮ ╭─') === true && board[20]?.startsWith('╰──────────────────────────╯ ╰') === true, board[0])
  check('80×21: the right frame names the selected session, its state and its age in its top border', rightOf(board[0], 29).startsWith('╭─Audit billing receipts · ready · 12m ') && (board[0]?.length ?? 0) === 80 && board[0]?.endsWith('╮') === true, rightOf(board[0], 29))
  check('80×21: the list carries the selected row with ❯ and the state glyph, names truncated with the ellipsis', /^│ ❯ . Audit billing recei… │$/.test(leftOf(board[1], 28)) && /^│   . Fix OAuth callback   │$/.test(leftOf(board[2], 28)), `${leftOf(board[1], 28)} / ${leftOf(board[2], 28)}`)
  check('80×21: the blank row then the new-session row follow the sessions', leftOf(board[7], 28) === '│                          │' && leftOf(board[8], 28) === '│   n  new session         │', `${leftOf(board[7], 28)} / ${leftOf(board[8], 28)}`)
  check('80×21: the list foot and the live foot carry the approved legends', leftOf(board[19], 28) === '│ ↑↓ pick · ↵ steer        │' && rightOf(board[19], 29) === '│ ⇥ list · x stop · p pause · esc board           │', `${leftOf(board[19], 28)} / ${rightOf(board[19], 29)}`)
  check('80×21: the mirror paints the session’s own rows', has(board.slice(1, 16).map(l => rightOf(l, 29)), 'Ready to help'), board.slice(1, 5).map(l => rightOf(l, 29)).join(' | '))
  check('80×21: the composer sits in its rounded frame above the foot', rightOf(board[16], 29).startsWith('│ ╭') && rightOf(board[17], 29).startsWith('│ │ ❯') && rightOf(board[18], 29).startsWith('│ ╰'), `${rightOf(board[16], 29)} / ${rightOf(board[17], 29)}`)
  check('80×21: no coordinator pane, no rails, no strips', !has(board, 'COORDINATOR') && !has(board, 'NEEDS YOU') && !has(board, 'seats') && !has(board, 'launch two sessions'))
  const down = markOf('split', 'down')
  check('80×21: ↓ moves the selection and the right frame follows at once', rightOf(down[0], 29).startsWith('╭─Fix OAuth callback · working · 07m ') && /^│ ❯ /.test(leftOf(down[2], 28)) && /^│   /.test(leftOf(down[1], 28)), rightOf(down[0], 29))
  const enter = markOf('split', 'enter')
  check('80×21: ↵ on the list keeps the board and the frame titles (no enter, no route change)', enter.length === 21 && enter[0]?.startsWith('╭─sessions · 6 ') === true && rightOf(enter[0], 29).startsWith('╭─Fix OAuth callback'), enter[0])
  check('80×21: ↵ hands focus to the composer — the caret block stands in the composer row', rightOf(enter[17], 29).includes('▌') || rightOf(enter[17], 29).startsWith('│ │ ❯  '), rightOf(enter[17], 29))
  const typed = markOf('split', 'typed')
  check('80×21: typed words land in the composer, never the list or a filter', rightOf(typed[17], 29).includes('steer words') && !has(typed.map(l => leftOf(l, 28)), 'steer words') && typed[0]?.startsWith('╭─sessions · 6 ') === true, rightOf(typed[17], 29))
  check('80×21: with words held the right foot drops the letter verbs (they are letters now)', rightOf(typed[19], 29) === '│ ⇥ list · esc board                              │', rightOf(typed[19], 29))
  const tab = markOf('split', 'tab')
  check('80×21: ⇥ returns focus to the list — the letter verbs print again', rightOf(tab[19], 29) === '│ ⇥ list · x stop · p pause · esc board           │' && rightOf(tab[17], 29).includes('steer words'), rightOf(tab[19], 29))
  const esc = markOf('split', 'esc')
  check('80×21: esc from the list returns to the boot face', has(esc, '↑↓ choose') && !has(esc, 'sessions · 6'), esc.slice(0, 3).join(' | '))
  const back = markOf('split', 'back')
  check('80×21: ⇧→ brings the split back', back[0]?.startsWith('╭─sessions · 6 ') === true)
  const fresh = markOf('split', 'new')
  check('80×21: n opens the new-session door (the contract offer) in the live frame', has(fresh.map(l => rightOf(l, 29)), 'Start with a contract?') && fresh[0]?.startsWith('╭─sessions · 6 ') === true, fresh.slice(1, 4).map(l => rightOf(l, 29)).join(' | '))
}

console.log('§3b 80×14 — the same split with fewer mirror rows')
{
  const status = capture('short', 80, 14, [
    face,
    { atTick: 999, awaitText: 'sessions · 6', minTick: 3, awaitSettleTicks: 3, requireAwait: true, data: DOWN, mark: 'board' },
    { afterPrevTicks: 4, data: '\r', mark: 'down' },
    { afterPrevTicks: 4, data: 'hi there', mark: 'enter' },
    { afterPrevTicks: 5, data: '', mark: 'typed' },
  ], 110)
  check('80×14: the drive ran every send', status === 0)
  const board = markOf('short', 'board')
  for (const label of ['board', 'down', 'enter', 'typed']) printFrame(`80×14 ${label}`, markOf('short', label))
  check('80×14: fourteen rows, two frames, the mirror shortened to eight rows', board.length === 14 && board[0]?.startsWith('╭─sessions · 6 ────────────╮ ╭─Audit billing receipts · ready · 12m ') === true && rightOf(board[9], 29).startsWith('│ ╭') && rightOf(board[10], 29).startsWith('│ │ ❯') && rightOf(board[11], 29).startsWith('│ ╰') && board[13]?.startsWith('╰──────────────────────────╯ ╰') === true, `${board[0]} / ${rightOf(board[9], 29)}`)
  check('80×14: the feet stand on the last inner row', leftOf(board[12], 28) === '│ ↑↓ pick · ↵ steer        │' && rightOf(board[12], 29) === '│ ⇥ list · x stop · p pause · esc board           │', `${leftOf(board[12], 28)} / ${rightOf(board[12], 29)}`)
  check('80×14: the mirror rows paint inside the frame', has(board.slice(1, 9).map(l => rightOf(l, 29)), 'Ready to help'))
  const down = markOf('short', 'down')
  check('80×14: ↓ follows in the right title', rightOf(down[0], 29).startsWith('╭─Fix OAuth callback · working · 07m '))
  const typed = markOf('short', 'typed')
  check('80×14: ↵ then typing lands the words in the composer', rightOf(typed[10], 29).includes('hi there') && !has(typed.map(l => leftOf(l, 28)), 'hi there'), rightOf(typed[10], 29))
}

console.log('§3c 50×16 — under 60 columns the board stands alone; ↵ opens the session in place')
{
  const status = capture('single', 50, 16, [
    face,
    { atTick: 999, awaitText: 'Session Concourse ·', minTick: 3, awaitSettleTicks: 3, requireAwait: true, data: DOWN, mark: 'board' },
    { afterPrevTicks: 4, data: '\r', mark: 'down' },
    { afterPrevTicks: 5, data: ESC, mark: 'opened' },
    { afterPrevTicks: 4, data: '', mark: 'back' },
  ], 110)
  check('50×16: the drive ran every send', status === 0)
  const board = markOf('single', 'board')
  for (const label of ['board', 'down', 'opened', 'back']) printFrame(`50×16 ${label}`, markOf('single', label))
  check('50×16: one frame across the width, titled with the counts', board.length === 16 && board[0] === '╭─Session Concourse · 3 running · 1 finished ────╮' && board[15] === '╰────────────────────────────────────────────────╯', board[0])
  check('50×16: rows carry glyph · name · state · age', /^│ ❯ . Audit billing receipts +ready +12m │$/.test(board[1] ?? '') && /^│   . Fix OAuth callback +working +07m │$/.test(board[2] ?? ''), `${board[1]} / ${board[2]}`)
  const inner50 = (text: string): string => `│${text.padEnd(48)}│`
  check('50×16: the foot shortened to the three keys that matter', board[14] === inner50(' ↵ open · n new · esc'), board[14])
  check('50×16: the new-session row stands after the six rows', board[8] === inner50('   n  new session'), board[8])
  const down = markOf('single', 'down')
  check('50×16: ↓ moves the cursor', /^│ ❯ /.test(down[2] ?? '') && /^│   /.test(down[1] ?? ''))
  const opened = markOf('single', 'opened')
  check('50×16: ↵ opens the selected session in the same frame — its title, its rows, its composer, the opened foot', opened[0]?.startsWith('╭─Fix OAuth callback · working · 07m ') === true && has(opened, 'callback') && opened[11]?.startsWith('│ ╭') === true && opened[12]?.startsWith('│ │ ❯') === true && opened[14] === inner50(' ↵ enter · x stop · p pause · esc back'), `${opened[0]} / ${opened[14]}`)
  const back = markOf('single', 'back')
  check('50×16: esc returns to the board', back[0] === '╭─Session Concourse · 3 running · 1 finished ────╮' && /^│ ❯ /.test(back[2] ?? ''), back[0])
}

console.log(`  captures: ${OUT_DIR}`)
console.log(failures === 0 ? '\nprove-concourse-compact-drive: ALL LAWS HOLD' : `\nprove-concourse-compact-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
