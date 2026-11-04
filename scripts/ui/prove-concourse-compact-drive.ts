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
  check('60 columns and 16 rows and up stack two frames; under 60 columns or 16 rows the board stands alone', board.compactConcourseProfileOf(60, 16) === 'split' && board.compactConcourseProfileOf(59, 40) === 'single' && board.compactConcourseProfileOf(80, 15) === 'single' && board.compactConcourseProfileOf(80) === 'split' && board.compactConcourseProfileOf(50) === 'single')
  const g21 = board.compactConcourseGeometry(80, 21, { sessionCount: 2, newSessionDoor: true, composerBand: 1 })
  check('80×21: the live frame stacks on top across the width (rows 0–13), the list frame below it (rows 14–20)', g21.live.x0 === 0 && g21.live.x1 === 79 && g21.live.inner === 78 && g21.live.y0 === 0 && g21.live.y1 === 13 && g21.list.x0 === 0 && g21.list.x1 === 79 && g21.list.y0 === 14 && g21.list.y1 === 20)
  check('80×21: the live frame holds twelve inner rows — eight mirror rows, a three-row composer, one foot', g21.framed && g21.live.innerRows === 12 && g21.mirrorRows === 8 && g21.composerRows === 3 && g21.composerBand === 1 && g21.liveFootRows === 1)
  check('80×21: two sessions leave the blank row and the new-session row in the list frame', g21.newSessionRows === 2 && g21.listFootRows === 1 && g21.listWindowRows === 2 && g21.list.innerRows === 5)
  const g14 = board.compactConcourseGeometry(80, 14, { sessionCount: 2, newSessionDoor: true, composerBand: 1 })
  check('80×14: too short to stack — one frame at a time, twelve inner rows: eight mirror rows, the framed composer, one foot', g14.profile === 'single' && g14.inner === 12 && g14.mirrorRows === 8 && g14.composerRows === 3 && g14.liveFootRows === 1)
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
  check('a long title truncates with the ellipsis and the frame stays its width', board.compactFrameTop('<local-command-caveat>The rows below are commands the user ran', 28).length === 28 && board.compactFrameTop('<local-command-caveat>The rows below are commands the user ran', 28).includes('…'))
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
  check('the door composer’s note and rest hint are the approved words', board.COMPACT_DOOR_NOTE === 'start a new chat to message here' && board.COMPACT_DOOR_REST_HINT === 'type a message' && board.COMPACT_DOOR_NOTE_MS >= 3000)
  const split = await import('../../src/components/concourse/splitView.ts')
  check('the s split never composes under the compact decision', !split.splitActiveOf({ on: true, cols: 130, rows: 24, plainWorld: false, compact: true }) && split.splitActiveOf({ on: true, cols: 130, rows: 24, plainWorld: false, compact: false }))
}

console.log('§2 the screen: the compact decision is the size latch; two focus targets; the letter verbs')
{
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check('the compact decision is the layout latch, stacked from 60 columns and 16 rows', screen.includes('const compactProfile = isCompact ? compactConcourseProfileOf(termCols, termRows) : null'))
  check('the split frame stands down under compact', screen.includes('const splitActive = !reducedStage && !compact && splitViewOn() && splitAvailableAt(termCols, termRows)'))
  check('the list has focus first; the ring is the two frames', screen.includes("if (compact) return carried === 'live' ? 'live' : 'list'") && screen.includes("const ring: ConcourseRegion[] = compact || reducedStage ? ['list', 'live'] : ['live', 'list']") && screen.includes("if (compact && region !== 'list' && region !== 'live') setRegion('list')"))
  check('↵ on the list hands focus to the composer — the arm, then the region', screen.includes("boardArmedRef.current = sel.sessionId\n      setBoardArmed(sel.sessionId)\n      setRegion('live')") && screen.includes('if (sel) compactSteerOrEnter(sel)'))
  check('esc from the composer returns to the list before the arm layer', screen.indexOf("if (compact && region === 'live') {\n        boardArmedRef.current = null") < screen.indexOf('if (boardArmedRef.current !== null) {') && screen.indexOf("if (compact && region === 'live') {\n        boardArmedRef.current = null") > 0)
  const xSites = screen.match(/input === 'x'/g) ?? []
  check('plain x stops from the rows of every board (the manager legend names it) and, on the compact concourse, from the composer while its draft is empty', xSites.length === 3 && screen.includes("if (input === 'x' && !key.ctrl && !key.meta && pastGate()) {") && screen.includes("if (compact && region === 'live' && !key.ctrl && !key.meta && (input === 'x' || input === 'p') && liveDraftRef.current.text.length === 0 && pastGate()) {") && screen.includes("if (input === 'x') rowStop()"))
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
  cfg['coordinatorEnabled'] = true
  cfg['customApiKeyResponses'] = { approved: ['fixture-key-000'], rejected: [] }
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const fixture = referenceFixtureSnapshot() as { groups: Array<{ id: string; label: string; rows: Array<Record<string, unknown>> }>; needsYou: unknown[]; coordinator: unknown }
  for (const g of fixture.groups) for (const r of g.rows) r.workspaceDir = scratch
  fixture.groups.push({
    id: 'elsewhere',
    label: 'OTHER PROJECTS',
    rows: [
      {
        sessionId: 'door:orchard',
        title: '1 running in orchard-src',
        state: 'elsewhere',
        projectLabel: 'orchard-src',
        ownerLabel: null,
        ageLabel: null,
        seats: null,
        door: { kind: 'switch-project', dir: join(scratch, 'orchard-src'), running: 1, needsYou: 0, finished: 0 },
      },
    ],
  })
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

const listTopOf = (rows: string[]): number => rows.findIndex(r => r.startsWith('╭─sessions · '))
const liveOf = (rows: string[]): string[] => rows.slice(0, Math.max(0, listTopOf(rows)))
const listOf = (rows: string[]): string[] => rows.slice(Math.max(0, listTopOf(rows)))
const rowAt = (rows: string[], needle: string): string => rows.find(r => r.includes(needle)) ?? ''
const composerRowOf = (rows: string[]): string => rows.find(r => r.startsWith('│ │ ❯')) ?? ''
const liveFootOf = (rows: string[]): string => liveOf(rows).find(r => r.startsWith('│ ⇥ list')) ?? ''

console.log('§3a 80×21 — two stacked frames (the live view on top), the key journey')
{
  const status = capture('split', 80, 21, [
    face,
    { atTick: 999, awaitText: 'sessions · 7', minTick: 3, awaitSettleTicks: 3, requireAwait: true, data: DOWN, mark: 'board' },
    { afterPrevTicks: 4, data: '\r', mark: 'down' },
    { afterPrevTicks: 4, data: 'steer words', mark: 'enter' },
    { afterPrevTicks: 5, data: '\t', mark: 'typed' },
    { afterPrevTicks: 4, data: ESC, mark: 'tab' },
    { afterPrevTicks: 4, data: SHIFT_RIGHT, mark: 'esc' },
    { atTick: 999, awaitText: 'sessions · 7', minTick: 3, awaitSettleTicks: 3, requireAwait: true, data: 'n', mark: 'back' },
    { afterPrevTicks: 6, data: '', mark: 'new' },
  ], 150)
  check('80×21: the drive ran every send', status === 0)
  const board = markOf('split', 'board')
  for (const label of ['board', 'down', 'enter', 'typed', 'tab', 'esc', 'new']) printFrame(`80×21 ${label}`, markOf('split', label))
  const listTop = listTopOf(board)
  check('80×21: 21 rows — the live frame titled with the selected session, its state and its age, then the session frame below it', board.length === 21 && board[0]?.startsWith('╭─Audit billing receipts · ready · 12m ') === true && (board[0]?.length ?? 0) === 80 && listTop > 8 && board[20]?.startsWith('╰') === true, `${board[0]} / row ${listTop}`)
  check('80×21: the list carries the selected row with ❯ and the state glyph, its name whole at this width', rowAt(listOf(board), 'Audit billing receipts').startsWith('│ ❯ ') && /^│   . Fix OAuth callback/.test(rowAt(listOf(board), 'Fix OAuth callback')), `${rowAt(listOf(board), 'Audit billing receipts')} / ${rowAt(listOf(board), 'Fix OAuth callback')}`)
  check('80×21: each frame keeps its approved foot', rowAt(listOf(board), '↑↓ pick').startsWith('│ ↑↓ pick · ↵ steer') && liveFootOf(board).startsWith('│ ⇥ list · x stop · p pause · esc board'), `${rowAt(listOf(board), '↑↓ pick')} / ${liveFootOf(board)}`)
  check('80×21: the live frame paints the session’s own rows', has(liveOf(board), 'Ready to help'), liveOf(board).slice(1, 5).join(' | '))
  const boxAt = liveOf(board).findIndex(r => r.startsWith('│ ╭'))
  check('80×21: the composer sits in its rounded frame above the live foot', boxAt > 0 && (liveOf(board)[boxAt + 1] ?? '').startsWith('│ │ ❯') && (liveOf(board)[boxAt + 2] ?? '').startsWith('│ ╰'), liveOf(board).slice(boxAt, boxAt + 3).join(' / '))
  check('80×21: no coordinator pane, no rails, no strips', !has(board, 'COORDINATOR') && !has(board, 'NEEDS YOU') && !has(board, 'seats') && !has(board, 'launch two sessions'))
  const down = markOf('split', 'down')
  check('80×21: ↓ moves the selection and the live frame follows at once', down[0]?.startsWith('╭─Fix OAuth callback · working · 07m ') === true && rowAt(listOf(down), 'Fix OAuth callback').startsWith('│ ❯ '), down[0])
  const enter = markOf('split', 'enter')
  check('80×21: ↵ on the list keeps the board and the frame titles (no enter, no route change)', enter.length === 21 && enter[0]?.startsWith('╭─Fix OAuth callback') === true && listTopOf(enter) > 0, enter[0])
  check('80×21: ↵ hands focus to the composer — the caret block stands in the composer row', composerRowOf(enter).includes('▌') || composerRowOf(enter).startsWith('│ │ ❯  '), composerRowOf(enter))
  const typed = markOf('split', 'typed')
  check('80×21: typed words land in the composer, never the list or a filter', composerRowOf(typed).includes('steer words') && !has(listOf(typed), 'steer words') && listTopOf(typed) > 0, composerRowOf(typed))
  check('80×21: with words held the live foot drops the letter verbs (they are letters now)', liveFootOf(typed).startsWith('│ ⇥ list · esc board') && !liveFootOf(typed).includes('x stop'), liveFootOf(typed))
  const tab = markOf('split', 'tab')
  check('80×21: ⇥ returns focus to the list — the letter verbs print again', liveFootOf(tab).startsWith('│ ⇥ list · x stop · p pause · esc board') && composerRowOf(tab).includes('steer words'), liveFootOf(tab))
  const esc = markOf('split', 'esc')
  check('80×21: esc from the list returns to the boot face', has(esc, '↑↓ choose') && !has(esc, 'sessions · 7'), esc.slice(0, 3).join(' | '))
  const back = markOf('split', 'back')
  check('80×21: ⇧→ brings the board back', listTopOf(back) > 0)
  const fresh = markOf('split', 'new')
  check('80×21: n opens the new-session door (the contract offer) in the live frame', has(liveOf(fresh), 'Start with a contract?') && listTopOf(fresh) > 0, liveOf(fresh).slice(1, 4).join(' | '))
}

console.log('§3d 80×21 — a door row selected: the composer takes words, ↵ answers with the note above it')
{
  const status = capture('door', 80, 21, [
    face,
    { atTick: 999, awaitText: 'sessions · 7', minTick: 3, awaitSettleTicks: 3, requireAwait: true, data: DOWN, mark: 'board' },
    { afterPrevTicks: 1, data: DOWN },
    { afterPrevTicks: 1, data: DOWN },
    { afterPrevTicks: 1, data: DOWN },
    { afterPrevTicks: 1, data: DOWN },
    { afterPrevTicks: 1, data: DOWN },
    { afterPrevTicks: 4, data: '\t', mark: 'door' },
    { afterPrevTicks: 4, data: 'hello door', mark: 'focus' },
    { afterPrevTicks: 5, data: '\r', mark: 'typed' },
    { afterPrevTicks: 4, data: '!', mark: 'enter' },
    { afterPrevTicks: 4, data: '', mark: 'again' },
  ], 150)
  check('80×21 door: the drive ran every send', status === 0)
  for (const label of ['door', 'typed', 'enter', 'again']) printFrame(`80×21 door ${label}`, markOf('door', label))
  const door = markOf('door', 'door')
  check('80×21 door: six ↓ select the door row and the live frame names it as a door', rowAt(listOf(door), '1 running in orchard').startsWith('│ ❯ ⇄ 1 running in orchar') && door[0]?.startsWith('╭─1 running in orchard-src · a door ') === true && has(liveOf(door), '1 running in orchard-src — ↵ switches the bo'), `${rowAt(listOf(door), '1 running in orchard')} / ${door[0]}`)
  const focus = markOf('door', 'focus')
  check('80×21 door: ⇥ focuses the composer, whose rest hint invites typing', /❯ [▌ ]type a message/.test(composerRowOf(focus)), composerRowOf(focus))
  const typed = markOf('door', 'typed')
  check('80×21 door: the typed words land in the composer and the foot keeps its legend', composerRowOf(typed).includes('hello door') && liveFootOf(typed).startsWith('│ ⇥ list · esc board'), `${composerRowOf(typed)} / ${liveFootOf(typed)}`)
  const enter = markOf('door', 'enter')
  const boxAt = liveOf(enter).findIndex(r => r.startsWith('│ ╭'))
  check('80×21 door: ↵ paints the note directly above the composer, sends nothing, keeps the words and the legend', (liveOf(enter)[boxAt - 1] ?? '').includes('start a new chat to message here') && composerRowOf(enter).includes('hello door') && liveFootOf(enter).startsWith('│ ⇥ list · esc board') && !has(enter, 'UNTRUSTED FOLDER') && listTopOf(enter) > 0, `${liveOf(enter)[boxAt - 1]} / ${composerRowOf(enter)}`)
  const again = markOf('door', 'again')
  check('80×21 door: the next keystroke clears the note and lands', !has(again, 'start a new chat to message here') && composerRowOf(again).includes('hello door!'), composerRowOf(again))
}

console.log('§3b 80×14 — too short to stack: one frame at a time; ↵ steers into the live frame')
{
  const status = capture('short', 80, 14, [
    face,
    { atTick: 999, awaitText: 'Session Concourse ·', minTick: 3, awaitSettleTicks: 3, requireAwait: true, data: DOWN, mark: 'board' },
    { afterPrevTicks: 4, data: '\r', mark: 'down' },
    { afterPrevTicks: 4, data: 'hi there', mark: 'enter' },
    { afterPrevTicks: 5, data: '', mark: 'typed' },
  ], 110)
  check('80×14: the drive ran every send', status === 0)
  const board = markOf('short', 'board')
  for (const label of ['board', 'down', 'enter', 'typed']) printFrame(`80×14 ${label}`, markOf('short', label))
  check('80×14: fourteen rows, the list frame alone, titled with the counts', board.length === 14 && board[0]?.startsWith('╭─Session Concourse · ') === true && board[13]?.startsWith('╰') === true && listTopOf(board) === -1, board[0])
  const down = markOf('short', 'down')
  check('80×14: ↓ moves the selection in the list frame', rowAt(down, 'Fix OAuth callback').startsWith('│ ❯ '), rowAt(down, 'Fix OAuth callback'))
  const enter = markOf('short', 'enter')
  check('80×14: ↵ steers into the live frame of the selected session', enter[0]?.startsWith('╭─Fix OAuth callback · working · 07m ') === true, enter[0])
  const typed = markOf('short', 'typed')
  check('80×14: typing lands the words in the composer', composerRowOf(typed).includes('hi there'), composerRowOf(typed))
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
  check('50×16: the door row carries its glyph and the state word', /⇄ 1 running in orchard-src +a door +— │$/.test(board[7] ?? ''), board[7])
  check('50×16: the new-session row stands after the seven rows', board[9] === inner50('   n  new session'), board[9])
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
