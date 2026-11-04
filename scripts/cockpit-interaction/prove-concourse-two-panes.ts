#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const BIN = resolve(argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs'))
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}
const OUT_DIR = resolve(argAfter('--frames') ?? join(tmpdir(), `concourse-two-panes-${process.pid}`))
mkdirSync(OUT_DIR, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const scratch = join(tmpdir(), `concourse-two-panes-${process.pid}-home`)
removeScratch(scratch)
const chatHome = join(scratch, 'chat-home')
mkdirSync(chatHome, { recursive: true })
process.env.MERCURY_CONFIG_DIR = chatHome
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { referenceFixtureSnapshot } = await import('../notifications/concourseReferenceSeed.ts')
const { scenario, cleanupScenario, encodeFixtureTranscript } = await import('../ui/renderScenarios.ts')

type Grid = { grid: { c: string }[][]; endReason?: string }
const linesOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join(''))
const CRITTER_RUN = /[▀▄█]{7,}/
const critterRows = (lines: string[]): number[] => lines.flatMap((l, i) => (CRITTER_RUN.test(l) ? [i] : []))

function capture(name: string, cfg: Record<string, unknown>, env: NodeJS.ProcessEnv, cwd: string): string[] {
  const out = join(OUT_DIR, `${name}.json`)
  const cfgPath = join(scratch, `${name}.cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out }))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(240_000), env, cwd })
  if (!existsSync(out)) {
    check(`${name}: the scene painted ready (vshot exit ${res.status ?? '?'}, no frame)`, false, (res.stderr ?? '').slice(-600))
    return []
  }
  const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid
  const lines = linesOf(payload)
  writeFileSync(join(OUT_DIR, `${name}.txt`), lines.map(l => l.trimEnd()).join('\n') + '\n')
  check(`${name}: the scene painted ready (${payload.endReason ?? '?'})`, payload.endReason === 'ready', lines.slice(0, 6).join('\n'))
  return lines
}

const boardHome = join(scratch, 'board-home')
seedFirstRun(boardHome, [REPO])
process.env.MERCURY_CONFIG_DIR = boardHome
const { workerTranscriptPath } = await import('../../src/services/concourse/workerTranscript.ts')
const SEEDED: Array<{ sid: string; ask: string; reply: string }> = [
  { sid: 's-audit', ask: 'Audit the billing receipts under invoices/', reply: 'Reading the receipts and the ledger.' },
  { sid: 's-oauth', ask: 'Fix the OAuth callback redirect', reply: 'Tracing the callback owner in src/auth.' },
]
for (const [n, s] of SEEDED.entries()) {
  const base = (extra: Record<string, unknown>) => ({ isSidechain: false, entrypoint: 'cli', cwd: boardHome, sessionId: s.sid, version: '1.0.0', gitBranch: 'main', ...extra })
  const uUuid = `00000000-0000-4000-8000-${String(n * 2 + 1).padStart(12, '0')}`
  const aUuid = `00000000-0000-4000-8000-${String(n * 2 + 2).padStart(12, '0')}`
  const path = workerTranscriptPath({ sessionId: s.sid, workspaceId: boardHome })
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    encodeFixtureTranscript(
      [
        base({ parentUuid: null, type: 'user', uuid: uUuid, message: { role: 'user', content: s.ask }, timestamp: '2026-11-04T20:48:07.000Z' }),
        base({
          parentUuid: uUuid, type: 'assistant', uuid: aUuid, requestId: `req_two_panes_${n}`,
          message: { id: `msg_two_panes_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: s.reply }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
          timestamp: '2026-11-04T20:48:08.000Z',
        }),
      ],
      s.sid,
    ),
  )
}
process.env.MERCURY_CONFIG_DIR = chatHome

const boardFixture = (mode: 'off' | 'agent-assisted'): Record<string, unknown> => {
  const fixture = referenceFixtureSnapshot()
  fixture.coordinator = mode === 'off' ? { mode: 'off' } : { mode: 'agent-assisted', assistModelLabel: 'GPT-5.6 Sol' }
  fixture.peek = { ...(fixture.peek as Record<string, unknown>), sessionId: 's-audit', title: 'Audit billing receipts', state: 'ready-to-review', modelLabel: 'Opus 5.5' }
  ;(fixture.context as Record<string, unknown>).effortLabel = 'max'
  for (const g of fixture.groups as Array<{ rows: Array<Record<string, unknown>> }>) {
    for (const r of g.rows) {
      r.workspaceDir = boardHome
      if (r.sessionId === 's-oauth') Object.assign(r, { modelLabel: 'GPT-5.6 Sol', effortLabel: 'xhigh' })
    }
  }
  return fixture
}
const boardEnv = (fixture: Record<string, unknown>, tag: string): NodeJS.ProcessEnv => {
  const fixturePath = join(boardHome, `${tag}-fixture.json`)
  writeFileSync(fixturePath, JSON.stringify(fixture))
  return {
    ...process.env,
    MERCURY_CONFIG_DIR: boardHome,
    MERCURY_HOME: '',
    MERCURY_CONCOURSE: 'always',
    MERCURY_CONCOURSE_FIXTURE: fixturePath,
    MERCURY_DAEMON_DIR: join(boardHome, 'daemon'),
    MERCURY_CREW_DIR: join(boardHome, 'crew'),
    MERCURY_AWAY_SUMMARY: '0',
    MERCURY_PARTY: '0',
    MERCURY_CRITTER_GAZE: '0',
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  }
}
const DOWN = '\u001b[B'
const TAB = '\t'
const boardCfg = (cols: number, rows: number, readyText: string, sends: Array<Record<string, unknown>> = []): Record<string, unknown> =>
  ({ argv: ['node', BIN], sends, total: 150, readyText, readySettleTicks: 4, cols, rows })

const HANDLE = ((referenceFixtureSnapshot().context as { operatorHandle: string }).operatorHandle)
const handleRe = new RegExp(`(^|[^\\w])${HANDLE}([^\\w]|$)`)
const COORDINATOR_WORDS = /coordinator|⌃s/i
const slice = (lines: string[], top: number, bottom: number, x0: number, x1: number): string[] =>
  lines.slice(top, bottom + 1).map(l => l.slice(x0, x1 + 1))
const statusRowOf = (lines: string[]): number => lines.findIndex((l, i) => i > lines.length - 6 && l.includes('▚▛▀▜▞'))

function twoColumns(lines: string[]): { left: [number, number]; right: [number, number]; bottom: number } | null {
  const top = lines[0] ?? ''
  const corners = [...top].flatMap((c, i) => (c === '╭' || c === '┏' ? [i] : []))
  if (corners.length !== 2) return null
  const bottom = lines.findIndex((l, i) => i > 0 && /^\s*[╰┗]/.test(l))
  return { left: [corners[0]!, corners[1]! - 2], right: [corners[1]!, top.trimEnd().length - 1], bottom }
}

function boardLaws(tag: string, lines: string[], headerLine: RegExp): void {
  const cols = twoColumns(lines)
  check(`${tag}·1 two panes side by side: two top borders on the first row`, cols !== null, (lines[0] ?? '').trimEnd())
  if (cols === null) return
  const left = slice(lines, 0, cols.bottom, cols.left[0], cols.left[1])
  const right = slice(lines, 0, cols.bottom, cols.right[0], cols.right[1])
  const leftText = left.join('\n')
  const rightText = right.join('\n')
  check(
    `${tag}·2 the left column opens on the chosen session's header line — title · project · model · effort, ↵ enter session at its right`,
    headerLine.test(left[1] ?? ''),
    (left[1] ?? '').trim(),
  )
  check(
    `${tag}·3 the left column paints that session's running transcript`,
    leftText.includes('Audit the billing receipts') && leftText.includes('Reading the receipts and the ledger.'),
    left.slice(0, 8).map(l => l.trimEnd()).join(' | '),
  )
  const box = left.findIndex(l => l.includes('❯ message Audit billing receipts'))
  check(
    `${tag}·4 the session's own message box sits at the foot of the left column (its prompt, then "tab or click to type")`,
    box > left.length / 2 && (left[box + 1] ?? '').includes('tab or click to type'),
    left.slice(-6).map(l => l.trimEnd()).join(' | '),
  )
  check(
    `${tag}·5 the right column is the session list: SESSIONS with "+ new session · n" on its title row`,
    /SESSIONS\s+\+ new session · n/.test(right[1] ?? ''),
    (right[1] ?? '').trim(),
  )
  const header = right.find(l => l.includes('STATUS & TITLE')) ?? ''
  check(
    `${tag}·6 the column header reads STATUS & TITLE · PROJECT · LAST USED (AGE is gone)`,
    header.includes('PROJECT') && /LAST USED\s*│?\s*$/.test(header.trimEnd()) && !/\bAGE\b/.test(rightText),
    header.trim(),
  )
  const rowAt = (needle: string): number => right.findIndex(l => l.includes(needle))
  const needs = rowAt('NEEDS YOU · ')
  const lastListRow = right.reduce((at, l, i) => (i < needs && /[⊞▸●◑◒◓□⋮]/.test(l) ? i : at), -1)
  const legend = rowAt('↑↓ choose · ↵ enter · n new · p pause')
  check(
    `${tag}·7 the NEEDS YOU block sits inside the right pane below the list, its ask row under it`,
    needs > lastListRow && lastListRow > 2 && (right[needs + 1] ?? '').includes('◆ Migration'),
    `list ends row ${lastListRow}, NEEDS YOU row ${needs}: ${(right[needs] ?? '').trim()} / ${(right[needs + 1] ?? '').trim()}`,
  )
  check(
    `${tag}·8 the row actions are the pane's own legend, below the NEEDS YOU block`,
    legend > needs && legend === right.length - 2,
    `legend row ${legend}: ${(right[legend] ?? '').trim()}`,
  )
  check(`${tag}·9 no COORDINATOR word, chip or ⌃s key anywhere on the board (mode off)`, !lines.some(l => COORDINATOR_WORDS.test(l)), lines.filter(l => COORDINATOR_WORDS.test(l)).map(l => l.trim()).join(' | '))
  const status = statusRowOf(lines)
  const statusText = (lines[status] ?? '').trimEnd()
  check(
    `${tag}·10 the status row is "▚▛▀▜▞ │ Moodle ⌄ … N/M seats" — no live, no need you, no name`,
    status > 0 && /▚▛▀▜▞ │ Moodle ⌄\s+\d+\/\d+ seats │$/.test(statusText) && !/live|need/.test(statusText) && !handleRe.test(statusText),
    statusText.trim(),
  )
  check(`${tag}·11 the legend row carries no coordinator model key`, !(lines[lines.length - 1] ?? '').includes('⌃s'), (lines[lines.length - 1] ?? '').trim())
}

console.log('W — the wide board (160×48, mode off, the list focused on entry): live view left, the session manager right')
const wide = capture('board-wide-160x48', boardCfg(160, 48, 'STATUS & TITLE'), boardEnv(boardFixture('off'), 'wide-off'), REPO)
boardLaws('W', wide, /^. Audit billing receipts · Moodle · Opus 5\.5 · max\s+↵ enter session .$/)

console.log('S — the board at 110×34 (mode off): the same two panes side by side')
const mid = capture('board-mid-110x34', boardCfg(110, 34, 'STATUS & TITLE'), boardEnv(boardFixture('off'), 'mid-off'), REPO)
boardLaws('S', mid, /^. Audit billing receipts · Moodle · \S.*↵ enter session .$/)

console.log('C — the compact board (96×30, mode off): the live view stacks on top, the session list below')
{
  const lines = capture('board-compact-96x30', boardCfg(96, 30, 'sessions · '), boardEnv(boardFixture('off'), 'compact-off'), REPO)
  const listTop = lines.findIndex(l => /^╭─sessions · \d+ /.test(l.trimStart()))
  check('C1 the first frame is the live view: the chosen session titles its top border', /^╭─Audit billing receipts · ready/.test((lines[0] ?? '').trimStart()), (lines[0] ?? '').trimEnd())
  check(
    'C2 the live frame paints the transcript and its message box above the list frame',
    listTop > 0 &&
      lines.slice(0, listTop).some(l => l.includes('Reading the receipts and the ledger.')) &&
      lines.slice(0, listTop).some(l => l.includes('❯ message Audit billing receipts')),
    lines.slice(0, Math.max(0, listTop)).map(l => l.trimEnd()).join(' | '),
  )
  check(
    'C3 the session list is the frame below, every session row in it',
    listTop > 0 && ['Audit billing receipts', 'Fix OAuth callback', 'Document launch graph'].every(t => lines.slice(listTop).some(l => l.includes(t))),
    lines.slice(Math.max(0, listTop)).map(l => l.trimEnd()).join(' | '),
  )
  check('C4 no coordinator anywhere on the compact board', !lines.some(l => COORDINATOR_WORDS.test(l)))
}

console.log('R — choosing another row switches the live view (160×48: ↓ on the focused list)')
{
  const lines = capture(
    'board-wide-160x48-down',
    boardCfg(160, 48, 'Tracing the callback owner in src/auth.', [{ atTick: 120, awaitText: 'STATUS & TITLE', minTick: 5, awaitSettleTicks: 4, requireAwait: true, data: DOWN }]),
    boardEnv(boardFixture('off'), 'wide-down'),
    REPO,
  )
  const cols = twoColumns(lines)
  const left = cols === null ? [] : slice(lines, 0, cols.bottom, cols.left[0], cols.left[1])
  check(
    'R1 the left column now shows the chosen row: its header (its own model and effort from the row, no peek round-trip) and its transcript, not the first one',
    /^.{0,2}Fix OAuth callback · Moodle · GPT-5\.6 Sol · x/.test((left[1] ?? '').trim()) &&
      left.some(l => l.includes('Tracing the callback owner in src/auth.')) &&
      !left.some(l => l.includes('Reading the receipts and the ledger.')),
    left.slice(0, 8).map(l => l.trimEnd()).join(' | '),
  )
}

console.log("A — mode 'agent-assisted': the coordinator returns as the third pane, below the manager and in the tab cycle")
{
  const lines = capture('board-assisted-160x48', boardCfg(160, 48, 'STATUS & TITLE'), boardEnv(boardFixture('agent-assisted'), 'assisted'), REPO)
  const cols = twoColumns(lines)
  const right = cols === null ? [] : lines.map(l => l.slice(cols.right[0], cols.right[1] + 1))
  const legend = right.findIndex(l => l.includes('↑↓ choose · ↵ enter'))
  const third = right.findIndex(l => l.includes('COORDINATOR · tab or click to focus'))
  check('A1 the third pane rests collapsed under the manager in the right column', legend > 0 && third > legend, `legend row ${legend}, coordinator row ${third}`)
  const tabbed = capture(
    'board-assisted-160x48-tab-tab',
    boardCfg(160, 48, 'talk to the coordinator', [
      { atTick: 120, awaitText: 'STATUS & TITLE', minTick: 5, awaitSettleTicks: 4, requireAwait: true, data: TAB },
      { atTick: 140, awaitText: 'w withdraw', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: TAB },
    ]),
    boardEnv(boardFixture('agent-assisted'), 'assisted-tab'),
    REPO,
  )
  check(
    'A2 tab, tab from the list (past the NEEDS YOU block) focuses it: it opens tall with its own composer',
    tabbed.some(l => l.includes('talk to the coordinator')) && tabbed.some(l => /│ COORDINATOR\s/.test(l)),
    tabbed.filter(l => l.includes('COORDINATOR') || l.includes('talk to')).map(l => l.trim()).join(' | '),
  )
  check(
    'A3 the status row stays the same: no coordinator chip even when it is on',
    !(tabbed[statusRowOf(tabbed)] ?? '').toLowerCase().includes('coordinator'),
    (tabbed[statusRowOf(tabbed)] ?? '').trim(),
  )
}

console.log('M — the builder fills each row\'s own model and effort; the live view reads the row first')
{
  const builder = readFileSync(join(REPO, 'src/services/concourse/concourseSnapshot.ts'), 'utf8')
  const screen = readFileSync(join(REPO, 'src/components/concourse/ConcourseScreen.tsx'), 'utf8')
  check('M1 every row with a model gets its display name and its effort from the builder', builder.includes('if (entry !== undefined) row.modelLabel = sanitizeLabel(entry.displayName)') && builder.includes("if (effort !== undefined && effort !== '') row.effortLabel = effort"))
  check('M2 the header reads the row before the peek', screen.includes('const modelLabel = sel.modelLabel ?? peekFacts?.modelLabel') && screen.includes('const effortLabel = sel.effortLabel ?? (peekFacts !== null'))
}

console.log('G — the guard: the chat screen keeps its header critter (160×48)')
{
  const cfg = scenario('frame', 160, 48) as Record<string, unknown>
  const lines = capture('chat-160x48', { ...cfg, total: 150, readyText: '❯ first task', readySettleTicks: 4 }, { ...process.env, MERCURY_CONFIG_DIR: chatHome, MERCURY_AWAY_SUMMARY: '0', MERCURY_CRITTER_GAZE: '0' }, REPO)
  cleanupScenario('frame')
  const rows = critterRows(lines)
  const top = rows.find(r => r < 8 && rows.includes(r + 1) && rows.includes(r + 2))
  check('G1 the chat header paints the critter: three stacked rows of its art at the top of the frame', top !== undefined, lines.slice(0, 8).map(l => l.trimEnd()).join('\n'))
}

if (failures === 0) removeScratch(scratch)
else console.log(`[forensics] world kept: ${scratch}`)
console.log(`  frames: ${OUT_DIR}`)
console.log(failures === 0 ? '\nprove-concourse-two-panes: ALL LAWS HOLD' : `\nprove-concourse-two-panes: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
