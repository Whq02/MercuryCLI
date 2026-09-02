#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'reap-drive-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const ground = join(SCRATCH, 'ground')
for (const d of [home, daemonDir, ground]) mkdirSync(d, { recursive: true })
spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: ground })
spawnSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@x', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: ground })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
process.env.MERCURY_CONCOURSE = 'always'
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
const OUT_DIR = process.env.CONCFLOW_CAPTURE_DIR ?? join(tmpdir(), `reap-drive-captures-${process.pid}`)
mkdirSync(OUT_DIR, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
    }
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [ground])
{
  const cfgPath = join(home, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  cfg['switchboardCapacity'] = { askedAt: 1754000000000, allowed: true, recommendedSeats: 5 }
  cfg['customApiKeyResponses'] = { approved: ['fixture-key-000'], rejected: [] }
  writeFileSync(cfgPath, JSON.stringify(cfg))
}

writeFileSync(join(home, 'settings.json'), JSON.stringify({ permissions: { ask: ['Bash(rm:*)'] } }))
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([
  { kind: 'tool_use', whenModel: 'opus', name: 'Bash', input: { command: `rm -f ${join(SCRATCH, 'nothing-here')}`, description: 'tidy' }, preText: 'about to tidy up. ' },
  { kind: 'tool_use', whenModel: 'sonnet', name: 'Bash', input: { command: `rm -f ${join(SCRATCH, 'nothing-here-beta')}`, description: 'tidy too' }, preText: 'about to tidy up too. ' },
  { kind: 'text', text: 'Spare.' },
  { kind: 'text', text: 'Spare.' },
  { kind: 'text', text: 'Spare.' },
])

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
const childEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: daemonDir,
  ANTHROPIC_API_KEY: 'fixture-key-000',
  ANTHROPIC_BASE_URL: api.url,
  MERCURY_CACHE_CLOCK: '0',
  MERCURY_PARTY: '0',
  MERCURY_AWAY_SUMMARY: '0',
}
const daemon = spawn('node', [BIN, 'daemon', 'run', ground], { cwd: ground, env: childEnv, stdio: ['ignore', logFd, logFd] })

type Grid = { grid: { c: string }[][] }
const linesOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join(''))
interface Send {
  atTick?: number
  afterPrevTicks?: number
  data: string
  awaitText?: string
  minTick?: number
  awaitSettleTicks?: number
  mark?: string
}
const markedFrames = new Map<string, string[]>()
const markOf = (tag: string, label: string): string[] => markedFrames.get(`${tag}:${label}`) ?? []
function drive(tag: string, sends: Send[], total: number, cols = 120, rows = 40): string[] {
  const out = join(OUT_DIR, `${tag}-${cols}x${rows}.json`)
  const cfgPath = join(SCRATCH, `${tag}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN], cwd: ground, sends, total, cols, rows, out }))
  const env: Record<string, string> = { ...(childEnv as Record<string, string>), MERCURY_CONCOURSE: 'always' }
  delete env.MERCURY_CONCOURSE_FIXTURE
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(240_000), env })
  if (res.status !== 0) throw new Error(`vshot ${tag} failed: ${(res.stderr ?? '').slice(-600)}`)
  const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid & { marks?: ({ label: string } & Grid)[] }
  const lines = linesOf(payload)
  writeFileSync(join(OUT_DIR, `${tag}-${cols}x${rows}.txt`), lines.join('\n') + '\n')
  for (const m of payload.marks ?? []) {
    markedFrames.set(`${tag}:${m.label}`, linesOf(m))
    writeFileSync(join(OUT_DIR, `${tag}-${cols}x${rows}-mark-${m.label}.txt`), linesOf(m).join('\n') + '\n')
  }
  return lines
}
const tagLine = (lines: string[]): string | undefined => lines.find(l => l.includes('⇧← back'))
const has = (lines: string[], needle: string): boolean => lines.some(l => l.includes(needle))
const isBoard = (lines: string[]): boolean => has(lines, 'SESSIONS') && has(lines, 'STATUS & TITLE')
const isFace = (lines: string[]): boolean => has(lines, 'New Session') && has(lines, '↵ start')

const SHIFT_LEFT = '\x1b[1;2D'
const SHIFT_RIGHT = '\x1b[1;2C'
const CTRL_X = '\x18'
const REAP_CHORDS: Send[] = [
  { atTick: 999, awaitText: 'SESSIONS', minTick: 5, awaitSettleTicks: 3, data: CTRL_X },
  { afterPrevTicks: 2, data: CTRL_X },
  { afterPrevTicks: 8, data: CTRL_X },
  { afterPrevTicks: 2, data: CTRL_X },
]
const enterSelected = (title: string): Send[] => [
  { atTick: 999, awaitText: title, minTick: 5, awaitSettleTicks: 3, data: '\t' },
  { afterPrevTicks: 3, data: '\r' },
  { afterPrevTicks: 3, data: '\r' },
]

try {
  const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
  const sup = await import('../../src/daemon/concourseSupervisor.ts')
  check('the scratch daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
  const admit = async (title: string, work: string, cmid: string, modelKey: string): Promise<string> => {
    const d = (await daemonControlRpc({
      op: 'concourseDispatch',
      clientMessageId: cmid,
      prompt: `say ${title} is ready`,
      workspaceDir: work,
      title,
      model: modelKey,
      effort: 'high',
    } as never)) as { ok?: boolean; sessionId?: string; modelId?: string; error?: string; detail?: string }
    check(`${title} dispatched under the requested model`, d.ok === true && d.sessionId !== undefined && d.modelId === modelKey, JSON.stringify(d))
    return d.sessionId ?? ''
  }
  const sidA = await admit('alpha probe', ground, 'reap-drive-alpha', 'claude-opus-5')
  const sidB = await admit('beta probe', ground, 'reap-drive-beta', 'claude-sonnet-5')
  const liveIds = (): string[] =>
    Object.values(sup.readSessionWorkers(daemonDir))
      .filter(r => r.endedAt === undefined)
      .map(r => r.sessionId)
  check('both sessions live on the roster', await untilAsync(() => liveIds().includes(sidA) && liveIds().includes(sidB), 30_000), liveIds().join(','))
  const obligations = await import('../../src/services/crew/obligations.ts')
  const askOpen = (sid: string) => async (): Promise<boolean> =>
    (await obligations.openObligations({ scope: 'switchboard' })).some(o => o.sessionId === sid && (o.ref ?? '').startsWith('permission:'))
  const alphaAskOpen = askOpen(sidA)
  check('alpha parked a REAL permission ask (its card lives in the parked REPL)', await untilAsync(alphaAskOpen, 40_000))
  check('beta parked one of its own (a mid-turn session drains at the quit, never parks — it stays a live row)', await untilAsync(askOpen(sidB), 40_000))
  await untilAsync(() => api.requests.length >= 2, 40_000)
  await new Promise(r => setTimeout(r, 2500))

  console.log('R4 the parked REPL card stays dead under the Concourse while the in-pane card answers')
  const plainFolder = join(SCRATCH, 'plain-folder')
  mkdirSync(plainFolder, { recursive: true })
  await obligations.upsertObligation({
    ref: 'permission:git-init:deadbeef0001',
    sessionId: `folder:${plainFolder}`,
    question: `this folder has no git — start one in ${plainFolder} so sessions can fork it?`,
    owner: 'operator',
    scope: 'switchboard',
  })
  const r4 = drive(
    'leak-both-cards',
    [
      { atTick: 999, awaitText: 'Do you want to proceed?', minTick: 5, awaitSettleTicks: 3, data: '\u001b[B' },
      { atTick: 999, awaitText: 'No — run here as it is', minTick: 2, afterPrevTicks: 6, data: '\r' },
      { afterPrevTicks: 4, data: '2', mark: 'after-first-2' },
    ],
    90,
  )
  const r4Answered = markOf('leak-both-cards', 'after-first-2')
  const noteLine = [...r4Answered, ...r4].find(l => /refused|unknown|already-answered|denied/.test(l)) ?? ''
  check('R4 the pane card ANSWERED (its receipt painted on the strip)', noteLine !== '', r4Answered.filter(l => l.includes('│')).slice(-8).map(l => l.trim().slice(0, 70)).join(' | '))
  check('R4 alpha\'s parked ask is STILL parked (the covered REPL card answered nothing)', await alphaAskOpen())
  check('R4 neither probe\'s Bash ran (no tool result)', !existsSync(join(SCRATCH, 'nothing-here')) && !existsSync(join(SCRATCH, 'nothing-here-beta')) && !r4.some(l => l.includes('Tidied')))
  for (const o of await obligations.openObligations({ scope: 'switchboard' })) {
    if (o.ref === 'permission:git-init:deadbeef0001') await obligations.resolveObligation(o.obligationId, { kind: 'withdrawn', by: 'prover', scope: 'switchboard' } as never)
  }

  const board = drive('reap-board', [], 40)
  const rowA = board.findIndex(l => l.includes('alpha probe'))
  const rowB = board.findIndex(l => l.includes('beta probe'))
  check('the live board shows both sessions', rowA >= 0 && rowB >= 0, `alpha=${rowA} beta=${rowB}`)
  const firstTitle = rowA >= 0 && (rowB < 0 || rowA < rowB) ? 'alpha probe' : 'beta probe'
  const otherTitle = firstTitle === 'alpha probe' ? 'beta probe' : 'alpha probe'

  console.log('R1 reap the focused session — the focused chat is the survivor')
  const r1 = drive(
    'reap-survivor',
    [
      ...enterSelected(firstTitle),
      { atTick: 999, awaitText: '⇧← back', minTick: 5, awaitSettleTicks: 3, data: SHIFT_LEFT },
      ...REAP_CHORDS,
      { afterPrevTicks: 25, data: SHIFT_RIGHT },
    ],
    160,
  )
  const tag1 = tagLine(r1)
  check('R1 the focused chat opened onto a live session (tag bar present)', tag1 !== undefined, r1.filter(l => l.trim()).slice(0, 6).join(' | '))
  check(`R1 …and it is the SURVIVOR (${otherTitle}), never the reaped ${firstTitle}`, tag1 !== undefined && tag1.includes(otherTitle) && !tag1.includes(firstTitle), tag1 ?? '')
  check('R1 the reaped session left the roster', await untilAsync(() => liveIds().length === 1, 15_000), liveIds().join(','))
  const survivorId = liveIds()[0] ?? ''
  check('R1 the roster survivor is the other session', survivorId === (firstTitle === 'alpha probe' ? sidB : sidA))

  console.log('R2 reap the last session — the board stays the frame')
  const r2 = drive(
    'reap-last',
    [
      ...enterSelected(otherTitle),
      { atTick: 999, awaitText: '⇧← back', minTick: 5, awaitSettleTicks: 3, data: SHIFT_LEFT },
      ...REAP_CHORDS,
      { afterPrevTicks: 25, data: SHIFT_RIGHT, mark: 'landing' },
      { afterPrevTicks: 8, data: SHIFT_RIGHT, mark: 'after-right' },
    ],
    180,
  )
  const r2Landing = markOf('reap-last', 'landing')
  const r2AfterRight = markOf('reap-last', 'after-right')
  check('R2 the last release keeps the BOARD as the frame — no ghost chat, no root composer, no bounce to the menu', isBoard(r2Landing) && tagLine(r2Landing) === undefined && !isFace(r2Landing), r2Landing.filter(l => l.trim()).slice(0, 8).join(' | '))
  check('R2 no session tag bar on the landing (no chat is open)', tagLine(r2Landing) === undefined, tagLine(r2Landing) ?? '')
  check('R2 ⇧→ from the board is NO MOVEMENT (no chat stop exists after the last reap): still the board', isBoard(r2AfterRight) && tagLine(r2AfterRight) === undefined && !isFace(r2AfterRight), r2AfterRight.filter(l => l.trim()).slice(0, 3).join(' | '))
  check('R2 …and again: the final frame is still the board — never the dead chat, never a bounce back to the menu', isBoard(r2) && tagLine(r2) === undefined && !isFace(r2), r2.filter(l => l.trim()).slice(0, 3).join(' | '))
  check('R2 …and no dead session title anywhere on it', !has(r2, otherTitle) || has(r2, 'SESSIONS'), r2.filter(l => l.includes(otherTitle)).join(' | '))
  check('R2 the roster is empty', await untilAsync(() => liveIds().length === 0, 15_000), liveIds().join(','))

  console.log('R3 the honesty leg — ⇧← from the board')
  const r3 = drive('board-shift-left', [{ atTick: 999, awaitText: 'SESSIONS', minTick: 5, awaitSettleTicks: 3, data: SHIFT_LEFT }], 60)
  const r3Face = has(r3, '↵ start') ? 'the Boot face' : has(r3, 'SESSIONS') ? 'the board (no-op)' : has(r3, '⇧← back') ? 'A SESSION TAG BAR' : 'another surface'
  console.log(`  [INFO] ⇧← from the board lands on: ${r3Face} — first rows: ${r3.filter(l => l.trim()).slice(0, 3).map(l => l.trim().slice(0, 60)).join(' | ')}`)
  check('R3 ⇧← from the board never opens a dead session', tagLine(r3) === undefined)
  check('R3 ⇧← from the board lands the Boot face (the strip\'s left stop)', has(r3, '↵ start') && !has(r3, 'SESSIONS'), r3.filter(l => l.trim()).slice(0, 3).join(' | '))
} finally {
  try {
    const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
    const sup = await import('../../src/daemon/concourseSupervisor.ts')
    for (const rec of Object.values(sup.readSessionWorkers(daemonDir))) {
      if (rec.endedAt === undefined) await daemonControlRpc({ op: 'concourseRelease', workerId: rec.workerId } as never).catch(() => undefined)
    }
  } catch {
  }
  daemon.kill('SIGTERM')
  await new Promise(r => setTimeout(r, 1500))
  if (daemon.exitCode === null) daemon.kill('SIGKILL')
  await api.close()
  rmSync(join(SCRATCH, 'home', 'daemon'), { recursive: true, force: true })
}

console.log(`captures under ${OUT_DIR}`)
console.log(failures === 0 ? 'ALL REAP LAWS HOLD' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
