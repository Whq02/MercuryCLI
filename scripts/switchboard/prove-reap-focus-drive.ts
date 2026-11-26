#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { startDaemonClientBeat } from '../lib/daemonClientBeat.ts'
import { ALL_MODEL_CONFIGS, newestGenerationKey } from '../../src/models/facts/builtInModelTable.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { paintsBootFaceReady } from '../lib/bootFace.ts'

const DEFAULT_OPUS = ALL_MODEL_CONFIGS[newestGenerationKey('opus')].firstParty

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
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — to fix: ${hint}` : ''}`)
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

writeFileSync(join(home, 'settings.json'), JSON.stringify({ guardrails: { ask: ['Bash(rm *)'] } }))
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
const clientBeat = startDaemonClientBeat()

type Grid = { grid: { c: string }[][] }
const linesOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join(''))
interface Send {
  atTick?: number
  afterPrevTicks?: number
  data: string
  awaitText?: string
  awaitPattern?: string
  minTick?: number
  awaitSettleTicks?: number
  mark?: string
}
const markedFrames = new Map<string, string[]>()
const markOf = (tag: string, label: string): string[] => markedFrames.get(`${tag}:${label}`) ?? []
function drive(tag: string, sends: Send[], total: number, ready?: { text: string[]; stable?: number; settle?: number }, cols = 120, rows = 40): string[] {
  const out = join(OUT_DIR, `${tag}-${cols}x${rows}.json`)
  const cfgPath = join(SCRATCH, `${tag}-cfg.json`)
  const end = ready === undefined ? {} : { readyText: ready.text, stableTicks: ready.stable, readySettleTicks: ready.settle }
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN], cwd: ground, sends, total, cols, rows, out, ...end }))
  const env: Record<string, string> = { ...(childEnv as Record<string, string>), MERCURY_CONCOURSE: 'always' }
  delete env.MERCURY_CONCOURSE_FIXTURE
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(240_000), env })
  if (res.status !== 0 && res.status !== 3) throw new Error(`vshot ${tag} failed: ${(res.stderr ?? '').slice(-600)}`)
  const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid & { marks?: ({ label: string } & Grid)[] }
  const lines = linesOf(payload)
  writeFileSync(join(OUT_DIR, `${tag}-${cols}x${rows}.txt`), lines.join('\n') + '\n')
  for (const m of payload.marks ?? []) {
    markedFrames.set(`${tag}:${m.label}`, linesOf(m))
    writeFileSync(join(OUT_DIR, `${tag}-${cols}x${rows}-mark-${m.label}.txt`), linesOf(m).join('\n') + '\n')
  }
  return lines
}
const { keyHintLabel } = await import('../../src/screen/widgets/keyHintLabel.ts')
const ARCHIVE_LEGEND = keyHintLabel('⌃x ⌃x archive · delete')
const DELETE_LEGEND = keyHintLabel('⌃x ⌃x delete')
const TAG = keyHintLabel('⇧← back')
const tagLine = (lines: string[]): string | undefined => lines.find(l => l.includes(TAG))
const has = (lines: string[], needle: string): boolean => lines.some(l => l.includes(needle))
const isBoard = (lines: string[]): boolean => has(lines, 'needs you · ') && (has(lines, 'status & title') || has(lines, 'no sessions yet'))
const isFace = (lines: string[]): boolean => has(lines, 'New Session') && paintsBootFaceReady(lines.join('\n'))

const SHIFT_LEFT = '\x1b[1;2D'
const SHIFT_RIGHT = '\x1b[1;2C'
const CTRL_X = '\x18'
const REAP_CHORDS: Send[] = [
  { atTick: 999, awaitText: 'status & title', minTick: 5, awaitSettleTicks: 3, data: CTRL_X },
  { afterPrevTicks: 2, data: CTRL_X },
  { atTick: 999, awaitText: ARCHIVE_LEGEND, minTick: 2, awaitSettleTicks: 3, data: CTRL_X },
  { afterPrevTicks: 2, data: CTRL_X },
  { atTick: 999, awaitText: DELETE_LEGEND, minTick: 2, awaitSettleTicks: 3, data: CTRL_X },
  { afterPrevTicks: 2, data: CTRL_X },
]
const enterSelected = (title: string): Send[] => [
  { atTick: 999, awaitText: title, minTick: 5, awaitSettleTicks: 3, data: '\r' },
  { afterPrevTicks: 3, data: '\r' },
]

try {
  const { daemonControlRpc } = await import('../../src/daemon/control/controlSocket.ts')
  const sup = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
  check('the scratch daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000), '', 'the scratch daemon did not answer ping within 60 s; read daemon.log in the scratch folder named by the reap-drive- directory under the temp dir, and rebuild with bun run build.ts if dist/mercury.mjs is stale')
  const admit = async (title: string, work: string, cmid: string, modelKey: string): Promise<string> => {
    const d = (await daemonControlRpc({
      op: 'concourseDispatch',
      clientMessageId: cmid,
      prompt: `say ${title} is ready`,
      workspaceDir: work,
      title,
      model: modelKey,
      effort: 'high',
    } as never, { timeoutMs: 15_000 })) as { ok?: boolean; sessionId?: string; modelId?: string; error?: string; detail?: string }
    check(`${title} dispatched under the requested model`, d.ok === true && d.sessionId !== undefined && d.modelId === modelKey, JSON.stringify(d), 'the concourseDispatch op of the daemon (served through src/daemon/control/controlSocket.ts) must start a session under the requested model; the answer is printed above')
    return d.sessionId ?? ''
  }
  const sidA = await admit('alpha probe', ground, 'reap-drive-alpha', DEFAULT_OPUS)
  const sidB = await admit('beta probe', ground, 'reap-drive-beta', 'claude-sonnet-5')
  const liveIds = (): string[] =>
    Object.values(sup.readSessionWorkers(daemonDir))
      .filter(r => r.endedAt === undefined)
      .map(r => r.sessionId)
  check('both sessions live on the roster', await untilAsync(() => liveIds().includes(sidA) && liveIds().includes(sidB), 30_000), liveIds().join(','), 'a dispatched session never reached the live roster; read readSessionWorkers in src/daemon/concourse-workers/concourseWorkers.ts and daemon.log in the scratch folder')
  const obligations = await import('../../src/crew/crewmates/obligations.ts')
  const askOpen = (sid: string) => async (): Promise<boolean> =>
    (await obligations.openObligations({ scope: 'switchboard' })).some(o => o.sessionId === sid && (o.ref ?? '').startsWith('permission:'))
  const alphaAskOpen = askOpen(sidA)
  check('alpha parked a REAL permission ask (its card lives in the parked Chat)', await untilAsync(alphaAskOpen, 40_000), '', 'alpha never recorded an open permission obligation in the switchboard scope; read src/crew/crewmates/obligations.ts and the fixture API requests')
  check('beta parked one of its own (a mid-turn session drains at the quit, never parks — it stays a live row)', await untilAsync(askOpen(sidB), 40_000), '', 'beta never recorded an open permission obligation in the switchboard scope; read src/crew/crewmates/obligations.ts and the fixture API requests')
  await untilAsync(() => api.requests.length >= 2, 40_000)
  await new Promise(r => setTimeout(r, 2500))

  console.log('R4 the parked Chat card stays dead under the Concourse while the in-pane card answers')
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
  check('R4 the pane card ANSWERED (its receipt painted on the strip)', noteLine !== '', r4Answered.filter(l => l.includes('│')).slice(-8).map(l => l.trim().slice(0, 70)).join(' | '), 'answering the in-pane card with 2 must paint a receipt (refused, unknown, already-answered or denied) on the strip; see the captures directory printed at the end of the run')
  check('R4 alpha\'s parked ask is STILL parked (the covered Chat card answered nothing)', await alphaAskOpen(), '', 'the parked Chat card must stay dead while the Concourse is open, so the in-pane answer must not resolve alpha ask; see the captures directory printed at the end of the run')
  check('R4 neither probe\'s Bash ran (no tool result)', !existsSync(join(SCRATCH, 'nothing-here')) && !existsSync(join(SCRATCH, 'nothing-here-beta')) && !r4.some(l => l.includes('Tidied')), '', 'a Bash tool ran although no permission was granted; the in-pane card answer must not allow it')
  for (const o of await obligations.openObligations({ scope: 'switchboard' })) {
    if (o.ref === 'permission:git-init:deadbeef0001') await obligations.resolveObligation(o.obligationId, { kind: 'withdrawn', by: 'prover', scope: 'switchboard' } as never)
  }

  const board = drive('reap-board', [], 150, { text: ['status & title', 'alpha probe', 'beta probe'], stable: 8 })
  const listHeader = board.findIndex(l => l.includes('status & title'))
  const listRows = listHeader >= 0 ? board.slice(listHeader + 1) : []
  const listCell = (l: string): string => l.split('│').find(c => c.includes('alpha probe') || c.includes('beta probe'))?.trim() ?? ''
  const rowA = listRows.findIndex(l => listCell(l).includes('alpha probe'))
  const rowB = listRows.findIndex(l => listCell(l).includes('beta probe'))
  check('the live board lists both sessions under STATUS & TITLE', listHeader >= 0 && rowA >= 0 && rowB >= 0, `header=${listHeader} alpha=${rowA} beta=${rowB}`, 'the live board must list both sessions under STATUS & TITLE; open the reap-board capture in the captures directory printed at the end')
  const selectedCell = listRows.map(listCell).find(c => c.startsWith('▸')) ?? listRows.map(listCell).find(c => c !== '') ?? ''
  const firstTitle = selectedCell.includes('beta probe') ? 'beta probe' : 'alpha probe'
  const otherTitle = firstTitle === 'alpha probe' ? 'beta probe' : 'alpha probe'
  console.log(`  [INFO] the list's selected row: ${selectedCell.slice(0, 60)}`)

  console.log('R1 reap the focused session — the focused chat is the survivor')
  const r1 = drive(
    'reap-survivor',
    [
      ...enterSelected(firstTitle),
      { atTick: 999, awaitText: TAG, minTick: 5, awaitSettleTicks: 3, data: SHIFT_LEFT },
      ...REAP_CHORDS,
      { afterPrevTicks: 25, awaitPattern: `^(?![\\s\\S]*${firstTitle})`, data: SHIFT_RIGHT },
    ],
    300,
    { text: [TAG, otherTitle], settle: 45 },
  )
  const tag1 = tagLine(r1)
  check('R1 the focused chat opened onto a live session (tag bar present)', tag1 !== undefined, r1.filter(l => l.trim()).slice(0, 6).join(' | '), 'entering the selected row must open a live chat with the tag bar; open the reap-survivor capture in the captures directory printed at the end')
  const rail1 = r1.map(line => line.includes('│') ? line.slice(0, line.indexOf('│')) : '')
  const chat1 = r1.map(line => line.includes('│') ? line.slice(line.indexOf('│') + 1) : line)
  check(`R1 …and it is the SURVIVOR (${otherTitle}) — its own words on the chat, never the reaped ${firstTitle}`, has(chat1, otherTitle) && !has(chat1, firstTitle) && (!has(rail1, firstTitle) || has(rail1, 'RECENT')), r1.filter(l => l.includes('probe')).join(' | '), 'reaping the focused session must leave the other chat in view; open the reap-survivor capture in the captures directory printed at the end')
  check('R1 the reaped session left the roster', await untilAsync(() => liveIds().length === 1, 15_000), liveIds().join(','), 'the reap chord (three presses of ctrl-x) must remove the focused session from the roster; see readSessionWorkers in src/daemon/concourse-workers/concourseWorkers.ts')
  const survivorId = liveIds()[0] ?? ''
  check('R1 the roster survivor is the other session', survivorId === (firstTitle === 'alpha probe' ? sidB : sidA), '', 'the reap removed the wrong session; the focused chat must be the one reaped')

  console.log('R2 reap the last session — the board stays the frame')
  const r2 = drive(
    'reap-last',
    [
      ...enterSelected(otherTitle),
      { atTick: 999, awaitText: TAG, minTick: 5, awaitSettleTicks: 3, data: SHIFT_LEFT },
      ...REAP_CHORDS,
      { afterPrevTicks: 25, data: SHIFT_RIGHT, mark: 'landing' },
      { afterPrevTicks: 8, data: SHIFT_RIGHT, mark: 'after-right' },
    ],
    300,
    { text: ['needs you · '], settle: 90 },
  )
  const r2Landing = markOf('reap-last', 'landing')
  const r2AfterRight = markOf('reap-last', 'after-right')
  check('R2 the last release keeps the BOARD as the frame — no ghost chat, no root composer, no bounce to the menu', isBoard(r2Landing) && tagLine(r2Landing) === undefined && !isFace(r2Landing), r2Landing.filter(l => l.trim()).slice(0, 8).join(' | '), 'reaping the last session must leave the board as the frame; open the reap-last landing mark capture in the captures directory printed at the end')
  check('R2 no session tag bar on the landing (no chat is open)', tagLine(r2Landing) === undefined, tagLine(r2Landing) ?? '')
  check('R2 ⇧→ from the board is NO MOVEMENT (no chat stop exists after the last reap): still the board', isBoard(r2AfterRight) && tagLine(r2AfterRight) === undefined && !isFace(r2AfterRight), r2AfterRight.filter(l => l.trim()).slice(0, 3).join(' | '))
  check('R2 …and again: the final frame is still the board — never the dead chat, never a bounce back to the menu', isBoard(r2) && tagLine(r2) === undefined && !isFace(r2), r2.filter(l => l.trim()).slice(0, 3).join(' | '))
  check('R2 …and no dead session title anywhere on it', !has(r2, otherTitle) || has(r2, 'needs you · '), r2.filter(l => l.includes(otherTitle)).join(' | '))
  check('R2 the roster is empty', await untilAsync(() => liveIds().length === 0, 15_000), liveIds().join(','), 'the last reap must empty the roster; see readSessionWorkers in src/daemon/concourse-workers/concourseWorkers.ts')

  console.log('R3 the honesty leg — ⇧← from the board')
  const r3 = drive('board-shift-left', [{ atTick: 999, awaitText: 'needs you · ', minTick: 5, awaitSettleTicks: 3, data: SHIFT_LEFT }], 150, { text: ['New Session'], settle: 5 })
  const r3Face = isFace(r3) ? 'the Boot face' : has(r3, 'needs you · ') ? 'the board (no-op)' : has(r3, TAG) ? 'A SESSION TAG BAR' : 'another surface'
  console.log(`  [INFO] ⇧← from the board lands on: ${r3Face} — first rows: ${r3.filter(l => l.trim()).slice(0, 3).map(l => l.trim().slice(0, 60)).join(' | ')}`)
  check('R3 ⇧← from the board never opens a dead session', tagLine(r3) === undefined)
  check('R3 ⇧← from the board lands the Boot face (the strip\'s left stop)', isFace(r3) && !has(r3, 'needs you · '), r3.filter(l => l.trim()).slice(0, 3).join(' | '), 'shift-left from the board must land the Boot face; open the board-shift-left capture in the captures directory printed at the end')
} finally {
  clientBeat.stop()
  try {
    const { daemonControlRpc } = await import('../../src/daemon/control/controlSocket.ts')
    const sup = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
    for (const rec of Object.values(sup.readSessionWorkers(daemonDir))) {
      if (rec.endedAt === undefined) await daemonControlRpc({ op: 'concourseRelease', workerId: rec.workerId } as never).catch(() => undefined)
    }
  } catch {
  }
  daemon.kill('SIGTERM')
  await new Promise(r => setTimeout(r, 1500))
  if (daemon.exitCode === null) daemon.kill('SIGKILL')
  await api.close()
  removeScratch(join(SCRATCH, 'home', 'daemon'))
}

console.log(`captures under ${OUT_DIR}`)
console.log(failures === 0 ? 'ALL REAP LAWS HOLD' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
