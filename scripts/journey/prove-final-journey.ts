#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(import.meta.dir, '../ui/vshot.py')
const FIX = join(REPO, '.claude', 'journey-fixtures', 'jx')
const { resolveProofHome } = await import('../lib/proofHome.ts')
const CONFIG_HOME = resolveProofHome([FIX], { keep: Boolean(process.env.JOURNEY_KEEP_FIXTURE) })
const { sanitizePath } = await import('../../src/utils/sessionStoragePortable.ts')
const PROJ_DIR = join(CONFIG_HOME, 'projects', sanitizePath(FIX))
const SID_A = 'facef00d-aaaa-4aaa-8aaa-000000000001'
const SID_B = 'facef00d-bbbb-4bbb-8bbb-000000000002'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: FIX, stdio: 'ignore' })
}

const SATURN_RECORDS = () => {
  const now = new Date()
  const h = (plus: number) => (now.getHours() + plus) % 24
  const m = now.getMinutes()
  const acct = { family: 'anthropic', source: 'oauth' }
  const fire = (prompt: string) => ({ kind: 'fire', prompt })
  const sched = (id: string, plus: number, prompt: string, recurring: boolean) => ({
    schema: 1, id,
    when: recurring ? { kind: 'every', cron: `${m} ${h(plus)} * * *` } : { kind: 'at', atMs: Date.now() + plus * 3_600_000 },
    action: fire(prompt), account: acct, modelKey: 'claude-opus-5',
    createdAt: Date.now() - 30_000, createdBy: 'operator:journey',
  })
  return {
    version: 1,
    workers: {
      'concourse-w1': {
        schema: 1, runnerId: 'concourse-w1', sessionId: 'jrny-sess-1', workspaceId: FIX,
        isolation: 'shared', modelKey: 'claude-opus-5', spawnedAt: Date.now() - 60_000, lastLiveAt: Date.now(),
        title: 'journey session',
        schedules: [
          sched('a1b2c3d4', 2, 'rotate the api keys before year end (journey fixture)', false),
          sched('b2c3d4e5', 3, 'sweep the repo for stale worktrees and report', true),
          sched('c3d4e5f6', 4, 'standup digest: summarize overnight CI', true),
        ],
      },
    },
  }
}
function seedSchedules(): void {
  mkdirSync(join(FIX, '.claude'), { recursive: true })
  const daemonDir = SCRATCH('daemon')
  mkdirSync(daemonDir, { recursive: true })
  writeFileSync(join(daemonDir, 'concourse-workers.json'), JSON.stringify(SATURN_RECORDS()))
}

function purgeDrafts(): void {
  const key = createHash('sha256').update(FIX).digest('hex').slice(0, 16)
  try { rmSync(join(CONFIG_HOME, 'drafts', `${key}.json`)) } catch {  }
}

const AGENT_REPORT_LINE = 'REPORT-LINE the journey manifest is pinned and the build is green.'

function writeSessions(): void {
  mkdirSync(PROJ_DIR, { recursive: true })
  const base = (sid: string) => (extra: Record<string, unknown>) => ({
    isSidechain: false, entrypoint: 'cli',
    cwd: FIX, sessionId: sid, version: '1.0.0-beta.1', gitBranch: 'main', ...extra,
  })
  const a = base(SID_A)
  const linesA = [
    a({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-a000-000000000001',
      message: { role: 'user', content: 'bump v1 in file-1 and scout the manifest' },
      timestamp: '2026-06-19T13:00:01.000Z' }),
    a({ parentUuid: '00000000-0000-4000-a000-000000000001', type: 'assistant',
      uuid: '00000000-0000-4000-a000-000000000002', requestId: 'req_j_1',
      message: { id: 'msg_j_1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'tool_use', id: 'toolu_j_edit1', name: 'Edit',
          input: { file_path: join(FIX, 'file-1.ts'), old_string: 'export const v1 = 1', new_string: 'export const v1 = 10' } }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      timestamp: '2026-06-19T13:00:02.000Z' }),
    a({ parentUuid: '00000000-0000-4000-a000-000000000002', type: 'user',
      uuid: '00000000-0000-4000-a000-000000000003',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_j_edit1', content: 'ok' }] },
      toolUseResult: {
        filePath: join(FIX, 'file-1.ts'), oldString: 'export const v1 = 1', newString: 'export const v1 = 10',
        originalFile: 'export const v1 = 1\nexport const w1 = 1\n',
        structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2,
          lines: ['-export const v1 = 1', '+export const v1 = 10', ' export const w1 = 1'] }],
        userModified: false, replaceAll: false,
      },
      timestamp: '2026-06-19T13:00:03.000Z' }),
    a({ parentUuid: '00000000-0000-4000-a000-000000000003', type: 'assistant',
      uuid: '00000000-0000-4000-a000-000000000004', requestId: 'req_j_2',
      message: { id: 'msg_j_2', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'tool_use', id: 'toolu_j_agent1', name: 'Agent',
          input: { description: 'Scout the manifest', prompt: 'Read the manifest and report.', subagent_type: 'Explore' } }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      timestamp: '2026-06-19T13:00:04.000Z' }),
    a({ parentUuid: '00000000-0000-4000-a000-000000000004', type: 'user',
      uuid: '00000000-0000-4000-a000-000000000005',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_j_agent1', content: [{ type: 'text', text: AGENT_REPORT_LINE }] }] },
      toolUseResult: {
        status: 'completed', agentId: 'journeyagent1', agentType: 'Explore',
        content: [{ type: 'text', text: AGENT_REPORT_LINE }],
        totalDurationMs: 12_345, totalToolUseCount: 3, totalTokens: 4567,
        usage: { input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0, server_tool_use: null, service_tier: null, cache_creation: null },
        prompt: 'Read the manifest and report.',
      },
      timestamp: '2026-06-19T13:00:05.000Z' }),
    a({ parentUuid: '00000000-0000-4000-a000-000000000005', type: 'assistant',
      uuid: '00000000-0000-4000-a000-000000000006', requestId: 'req_j_3',
      message: { id: 'msg_j_3', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'file-1 bumped; the manifest is pinned and the build is green.' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      timestamp: '2026-06-19T13:00:06.000Z' }),
  ]
  const b = base(SID_B)
  const linesB = [
    b({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-b000-000000000001',
      message: { role: 'user', content: 'session bravo standby' },
      timestamp: '2026-06-19T12:00:01.000Z' }),
    b({ parentUuid: '00000000-0000-4000-b000-000000000001', type: 'assistant',
      uuid: '00000000-0000-4000-b000-000000000002', requestId: 'req_j_b1',
      message: { id: 'msg_j_b1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'standing by in bravo.' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      timestamp: '2026-06-19T12:00:02.000Z' }),
  ]
  writeFileSync(join(PROJ_DIR, `${SID_A}.jsonl`), encodeSeedTranscript(linesA, SID_A))
  writeFileSync(join(PROJ_DIR, `${SID_B}.jsonl`), encodeSeedTranscript(linesB, SID_B))
}

function buildFixture(): void {
  rmSync(FIX, { recursive: true, force: true })
  rmSync(PROJ_DIR, { recursive: true, force: true })
  mkdirSync(FIX, { recursive: true })
  git('init', '-q')
  git('config', 'user.email', 'fixture@mercury.local')
  git('config', 'user.name', 'fixture')
  writeFileSync(join(FIX, '.gitignore'), '.claude/\n.mercury/\n')
  const multiBase = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a-multi`).join('\n')
  writeFileSync(join(FIX, 'a-multi.ts'), multiBase + '\n')
  writeFileSync(join(FIX, 'file-1.ts'), 'export const v1 = 1\nexport const w1 = 1\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  const multi = multiBase.split('\n')
  multi[1] = 'CHANGED line 2'
  multi[19] = 'CHANGED line 20'
  multi[37] = 'CHANGED line 38'
  writeFileSync(join(FIX, 'a-multi.ts'), multi.join('\n') + '\n')
  writeFileSync(join(FIX, 'file-1.ts'), 'export const v1 = 10\nexport const w1 = 1\n')
  seedSchedules()
  writeSessions()
  purgeDrafts()
}

type Cell = { c: string }
const SCRATCH = (name: string) => join(tmpdir(), `hermes-journey-${name}-${process.pid}`)

const READY = '❯'
const READY_TICK = 5
const SLACK = 30
type Timeline = Array<{ atTick: number; data: string; awaitText?: string }>
function anchored(sends: Timeline, total: number, ready: string | null): Record<string, unknown> {
  let prev = 0
  const out = sends.map((s, i) => {
    const send = i === 0
      ? { awaitText: s.awaitText ?? READY, requireAwait: true, minTick: 1, awaitSettleTicks: Math.max(0, s.atTick - READY_TICK), data: s.data }
      : { afterPrevTicks: Math.max(1, s.atTick - prev), data: s.data }
    prev = s.atTick
    return send
  })
  const last = sends.length ? sends[sends.length - 1]!.atTick : READY_TICK
  const end = ready === null ? {} : { readyText: ready, readySettleTicks: Math.max(1, total - last) }
  return { sends: out, ...end, total: total + SLACK }
}

function capture(
  tag: string,
  sends: Timeline,
  total: number,
  opts: { cols?: number; rows?: number; sid?: string; ready?: string | null } = {},
): string[] | null {
  const { cols = 120, rows = 50, sid = SID_A, ready = READY } = opts
  const gridPath = `/tmp/journey-${tag}-${process.pid}.json`
  const cfgPath = `/tmp/journey-${tag}-cfg-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({
    argv: ['node', BIN, '--resume', sid, ...(process.env.JOURNEY_DEBUG === '1' ? ['--debug'] : [])],
    cwd: FIX, ...anchored(sends, total, ready), cols, rows, out: gridPath,
  }))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(180_000),
    env: {
      ...process.env,
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_TURN_RECEIPT: '0',
      MERCURY_TABULA_MINERVA: '0',
      MERCURY_CONFIG_DIR: CONFIG_HOME,
      MERCURY_DAEMON_DIR: SCRATCH('daemon'),
      MERCURY_TEAMS_DIR: SCRATCH('teams'),
      MERCURY_TABULA_DIR: SCRATCH('tabula'),
      MERCURY_HOME: SCRATCH('home'),
      VISUAL: '',
      EDITOR: '',
    },
  })
  if (res.status !== 0) {
    check(`${tag}: PTY capture ran`, false, res.stderr?.slice(0, 200) ?? '')
    return null
  }
  const grid = (JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: Cell[][] }).grid
  const lines = grid.map(r => r.map(c => c.c).join(''))
  const inkCells = lines.join('').replace(/\s/g, '').length
  check(`${tag}: frame is painted (no all-blank grid)`, inkCells > 400, `${inkCells} ink cells`)
  return lines
}

const click = (x: number, y: number): string => `\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`
const rowOf = (lines: string[], needle: string): number => lines.findIndex(l => l.includes(needle))
const countRows = (lines: string[], needle: string): number => lines.filter(l => l.includes(needle)).length
const promptRow = (lines: string[]): number => lines.reduce((acc, l, i) => (l.includes('❯') ? i : acc), -1)

console.log('============================================================')
console.log(' the final Mercury interaction journey — real binary, PTY')
console.log('============================================================')
buildFixture()

console.log('\n── J1 · cold start to home ─────────────────────────────────')
const j1 = capture('j1-home', [], 80)
let promptY0 = -1
if (j1) {
  check('home: the settled ± meta appears EXACTLY once', countRows(j1, '· +1/-1') === 1)
  check('home: ONE agent Done card', countRows(j1, 'Done (3 tool uses') === 1)
  check('home: agent report collapsed', rowOf(j1, 'REPORT-LINE') === -1)
  promptY0 = promptRow(j1)
  check('home: prompt row present', promptY0 >= 0, `row ${promptY0}`)
  const stripRow = rowOf(j1, '⊞ SESSIONS')
  check('home: SESSIONS tab strip present', stripRow >= 0)
  check('home: session-B tab visible in the strip', stripRow >= 0 && (j1[stripRow]?.includes('bravo') ?? false))
}

console.log('\n── J2/J3 · composer: draft, drag-replace, timeline, palette ─')
purgeDrafts()
const TYPE = [
  { atTick: 36, data: 'polish the alpha handler' },
  { atTick: 42, data: '\x1b\r' },
  { atTick: 44, data: 'then rerun the suite' },
]
const j2 = capture('j2-draft', TYPE, 54, { ready: 'polish the alpha handler' })
let dragY = -1
let dragX1 = -1
let dragX2 = -1
if (j2) {
  const y = rowOf(j2, 'polish the alpha handler')
  check('draft: line 1 painted', y >= 0)
  check('draft: line 2 painted (multiline)', rowOf(j2, 'then rerun the suite') > y)
  if (y >= 0) {
    const x = j2[y]!.indexOf('alpha')
    dragY = y + 1
    dragX1 = x + 1
    dragX2 = x + 5
  }
}
if (dragY > 0) {
  purgeDrafts()
  const drag = `\x1b[<0;${dragX1};${dragY}M\x1b[<32;${dragX1 + 1};${dragY}M\x1b[<32;${dragX2};${dragY}M\x1b[<0;${dragX2};${dragY}m`
  const j3open = capture('j3-palette-open', [
    ...TYPE,
    { atTick: 50, data: drag },
    { atTick: 54, data: 'omega' },
    { atTick: 58, data: '\x1f' },
    { atTick: 62, data: '\x18' }, { atTick: 64, data: '\x12' },
    { atTick: 70, data: '\x18' }, { atTick: 72, data: 'p' },
  ], 82, { ready: null })
  if (j3open) {
    check('palette: overlay painted over the draft', rowOf(j3open, 'no matches') >= 0 || countRows(j3open, '/') > 3)
  }
  purgeDrafts()
  const j3 = capture('j3-timeline', [
    ...TYPE,
    { atTick: 50, data: drag },
    { atTick: 54, data: 'omega' },
    { atTick: 58, data: '\x1f' },
    { atTick: 62, data: '\x18' }, { atTick: 64, data: '\x12' },
    { atTick: 70, data: '\x18' }, { atTick: 72, data: 'p' },
    { atTick: 78, data: '\x1b' },
  ], 92, { ready: 'polish the omega handler' })
  if (j3) {
    const y = rowOf(j3, 'polish the omega handler')
    check('replace→undo→redo lands on the REPLACED text', y >= 0)
    check('the original token is gone (splice, not append)', rowOf(j3, 'alpha handler') === -1)
    check('line 2 survived the whole timeline', rowOf(j3, 'then rerun the suite') > y)
    check('palette closed — draft rows back at their positions', y === rowOf(j2!, 'polish the alpha handler'))
  }
} else {
  check('drag coordinates derived', false, 'J2 draft rows missing')
}

console.log('\n── J4 · durable draft restore + disclosure toggle ──────────')
writeSessions()
const j4a = capture('j4-restore', [], 58, { ready: 'polish the omega handler' })
let agentY4 = -1
let agentX4 = -1
if (j4a) {
  check('relaunch: the omega draft RESTORED from the durable store', rowOf(j4a, 'polish the omega handler') >= 0)
  check('relaunch: multiline shape intact', rowOf(j4a, 'then rerun the suite') >= 0)
  agentY4 = rowOf(j4a, 'Done (3 tool uses')
  agentX4 = agentY4 >= 0 ? (j4a[agentY4] ?? '').indexOf('Done (') + 3 : -1
  check('relaunch: agent card present for the toggle leg', agentY4 >= 0)
}
if (agentY4 >= 0) {
  const j4b = capture('j4-toggle', [
    { atTick: 58, awaitText: 'polish the omega handler', data: click(agentX4, agentY4 + 1) },
    { atTick: 70, data: click(agentX4, agentY4 + 1) },
  ], 84)
  if (j4b) {
    check('toggle: report hidden again after the second click', rowOf(j4b, 'REPORT-LINE') === -1)
    check('toggle: Done row back with its fold cue', rowOf(j4b, 'Done (3 tool uses') >= 0)
    check('toggle: the draft was NOT touched by transcript clicks', rowOf(j4b, 'polish the omega handler') >= 0)
  }
}

console.log('\n── J5 · /diff: sources, files, hunks, close ────────────────')
purgeDrafts()
const DIFF_OPEN = [
  { atTick: 36, data: '/diff' },
  { atTick: 42, data: '\r' },
]
const j5a = capture('j5-list', DIFF_OPEN, 58, { ready: 'Current' })
if (j5a) {
  check('diff list: Current + T1 sources offered', rowOf(j5a, 'Current') >= 0 && countRows(j5a, 'T1') >= 1)
  check('diff list: working-tree files listed', rowOf(j5a, 'a-multi.ts') >= 0 && rowOf(j5a, 'file-1.ts') >= 0)
}
const j5b = capture('j5-carry', [
  ...DIFF_OPEN,
  { atTick: 50, data: '\x1b[B' },
  { atTick: 56, data: '\x1b[C' },
  { atTick: 60, data: '\x1b[C' },
  { atTick: 64, data: '\x1b[C' },
], 80, { ready: 'turn 1' })
if (j5b) {
  check('diff carry: T1 source active (turn kv)', rowOf(j5b, 'turn 1') >= 0)
  check('diff carry: file-1 selection carried by PATH into the new source', rowOf(j5b, 'file-1.ts') >= 0 && rowOf(j5b, 'a-multi.ts') === -1)
}
const j5c = capture('j5-hunks', [
  ...DIFF_OPEN,
  { atTick: 50, data: '\r' },
  { atTick: 58, data: 'n' },
], 72, { ready: 'hunk 2/3' })
if (j5c) {
  check('diff detail: hunk position advanced to 2/3', rowOf(j5c, 'hunk 2/3') >= 0)
  check('diff detail: the current hunk paints its edit', rowOf(j5c, 'CHANGED line 20') >= 0)
}
const j5d = capture('j5-close', [
  ...DIFF_OPEN,
  { atTick: 50, data: '\r' },
  { atTick: 56, data: 'n' },
  { atTick: 60, data: ']' },
  { atTick: 66, data: '\x1b' },
  { atTick: 72, data: '\x1b' },
], 92, { ready: '⊞ SESSIONS' })
if (j5d && j1) {
  check('diff close: home restored (tab strip back)', rowOf(j5d, '⊞ SESSIONS') >= 0)
  check('diff close: no workspace residue', rowOf(j5d, 'hunk ') === -1)
  check('diff close: prompt row back at its baseline position', promptRow(j5d) === promptY0, `row ${promptRow(j5d)} vs ${promptY0}`)
}

console.log('\n── J6 · /saturn board: rows painted · verbs armed · close ─')
purgeDrafts()
seedSchedules()
const SATURN_OPEN = [
  { atTick: 36, data: '/saturn' },
  { atTick: 42, data: '\r' },
]
const j6a = capture('j6-board', SATURN_OPEN, 60, { cols: 140, ready: 'b2c3d4e5' })
if (j6a) {
  check('board: all three schedules painted', rowOf(j6a, 'b2c3d4e5') >= 0 && rowOf(j6a, 'c3d4e5f6') >= 0 && rowOf(j6a, 'a1b2c3d4') >= 0)
  check('board: the verb floor is armed (x delete · n run-now · r refresh)', rowOf(j6a, 'x delete') >= 0 && rowOf(j6a, 'n run-now') >= 0 && rowOf(j6a, 'r refresh') >= 0)
  check('board: the owning session is named on its rows', rowOf(j6a, 'journey session') >= 0)
}
{
  const j6b = capture('j6-close', [
    ...SATURN_OPEN,
    { atTick: 52, data: '\x1b' },
  ], 76, { cols: 140, ready: '⊞ SESSIONS' })
  if (j6b) {
    check('board close: home restored after esc', rowOf(j6b, '⊞ SESSIONS') >= 0)
  }
}

console.log('\n── J7 · session flip out (tab click) + back (⌥← chord) ─────')
writeSessions()
const DRAFT7 = [
  { atTick: 36, data: 'session alpha draft line one' },
  { atTick: 42, data: '\x1b\r' },
  { atTick: 44, data: 'line two of the draft' },
]
let flipOut: string[] | null = null
let tab7X = -1
let tab7Y = -1
for (let attempt = 0; attempt < 2 && !flipOut?.some(l => l.includes('standing by in bravo')); attempt++) {
  purgeDrafts()
  const base = capture(`j7-draft${attempt ? '-r' : ''}`, DRAFT7, 66, { ready: 'session alpha draft line one' })
  if (!base) break
  if (attempt === 0) {
    check('flip: the multiline draft is live', rowOf(base, 'session alpha draft line one') >= 0 && rowOf(base, 'line two of the draft') >= 0)
  }
  const sessY = rowOf(base, '⊞ SESSIONS')
  const x = sessY >= 0 ? base[sessY]!.indexOf('bravo') : -1
  if (x < 0) continue
  tab7X = x + 1
  tab7Y = sessY + 1
  purgeDrafts()
  flipOut = capture(`j7-flip-out${attempt ? '-r' : ''}`, [
    ...DRAFT7,
    { atTick: 64, data: click(tab7X, tab7Y) },
  ], 100, { ready: 'standing by in bravo' })
}
check('flip: session-B tab located in the settled frame', tab7X > 0)
if (flipOut) {
  check('flip out: session B transcript live', rowOf(flipOut, 'standing by in bravo') >= 0)
  check('flip out: the A draft did NOT leak into B', rowOf(flipOut, 'session alpha draft line one') === -1)
}
if (tab7X > 0) {
  purgeDrafts()
  writeSessions()
  const j7c = capture('j7-flip-back', [
    ...DRAFT7,
    { atTick: 64, data: click(tab7X, tab7Y) },
    { atTick: 96, data: '\x1b[1;3D' },
  ], 136, { ready: 'file-1 bumped' })
  if (j7c) {
    check('flip back: session A transcript restored', rowOf(j7c, 'file-1 bumped') >= 0)
    check('flip back: the multiline draft RESTORED into the composer', rowOf(j7c, 'session alpha draft line one') >= 0 && rowOf(j7c, 'line two of the draft') >= 0)
    check('flip back: no duplicate settled ± card after the round-trip', countRows(j7c, '· +1/-1') === 1, `rows=${countRows(j7c, '· +1/-1')}`)
  }
  const draftsFile = join(CONFIG_HOME, 'drafts', `${createHash('sha256').update(FIX).digest('hex').slice(0, 16)}.json`)
  let durable = ''
  try { durable = readFileSync(draftsFile, 'utf8') } catch {  }
  check(
    "flip back: the durable store holds A's draft after the leg",
    durable.includes(SID_A) && durable.includes('session alpha draft line one'),
    durable === '' ? `drafts file absent: ${draftsFile}` : durable.replace(/\s+/g, ' ').slice(0, 240),
  )
}

console.log('\n── J8 · clean close ─────────────────────────────────────────')
purgeDrafts()
const j8 = capture('j8-close', [
  { atTick: 40, data: '\x04' },
  { atTick: 44, data: '\x04' },
], 58, { ready: null })
if (j8) {
  check('close: no crash residue on the final frame', rowOf(j8, 'Traceback') === -1 && rowOf(j8, 'ReferenceError') === -1 && rowOf(j8, 'TypeError') === -1)
}

console.log('\n── source contracts ─────────────────────────────────────────')
{
  const pending = readFileSync(join(REPO, 'src/input-core/pending-input.ts'), 'utf8')
  const rekeyAt = pending.indexOf('export async function rekeyToSession(')
  const rekey = rekeyAt === -1 ? '' : pending.slice(rekeyAt, pending.indexOf('\n}\n', rekeyAt))
  const flushAt = rekey.indexOf('await flushDraftSaves()')
  const rekeyOwnerAt = rekey.indexOf('owningSessionId = sessionId')
  check('the switch tail RESTORES the target draft (never blind-clears)', rekeyOwnerAt !== -1 && rekey.includes('const saved = readDraftSync(sessionId)') && !rekey.includes("draft = { text: ''"))
  check('pending source-owned saves flush during STAGE', flushAt !== -1 && rekeyOwnerAt !== -1 && flushAt < rekeyOwnerAt)
}

if (!process.env.JOURNEY_KEEP_FIXTURE) {
  rmSync(join(REPO, '.claude', 'journey-fixtures'), { recursive: true, force: true })
  rmSync(PROJ_DIR, { recursive: true, force: true })
  purgeDrafts()
}

console.log()
if (failures) {
  console.log(`❌ final-journey proof: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ final-journey proof green — the interaction system holds end to end')
