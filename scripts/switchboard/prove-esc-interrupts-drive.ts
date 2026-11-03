#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs as S } from '../lib/captureDriver.ts'
import { READING_PHASE_WORD } from '../../src/components/Spinner/liveCounterWords.ts'
import { adoptSeatTurnStart, anchorSeatClock, anchoredElapsedMs } from '../../src/components/Spinner/seatClock.ts'
import { ALL_MODEL_CONFIGS, newestGenerationKey } from '../../src/utils/model/configs.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const DEFAULT_OPUS = ALL_MODEL_CONFIGS[newestGenerationKey('opus')].firstParty

const DIST = process.env.MERCURY_PROOF_DIST ?? join(process.cwd(), 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
let failures = 0
let firstBytePending: string | null = null
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const { runArtifactArena, grabScreens, sendStamp } = await import('../streaming/artifactArena.ts')
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

const hoppedLeg = async (
  tag: string,
  cols: number,
  rows: number,
  turnShape: Record<string, unknown>,
): Promise<void> => {
  const SCRATCH = mkdtempSync(join(tmpdir(), `escpin-${tag}-`))
  const daemonDir = join(SCRATCH, 'daemon')
  const work = join(SCRATCH, 'work')
  for (const d of [daemonDir, work]) mkdirSync(d, { recursive: true })
  process.env.MERCURY_DAEMON_DIR = daemonDir
  delete process.env.MERCURY_HOME
  process.env.MERCURY_CONCOURSE = 'always'
  const api = await startFixtureApi([turnShape as never, { kind: 'text', text: 'Spare.' }])
  const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
  let daemon: ReturnType<typeof spawn> | null = null
  let sid = ''
  const run = await runArtifactArena({
    turns: [],
    sends: ['after:Alpha think:2500:\t', 'after:Alpha think:4000:\r', 'after:Alpha think:5200:\r', 'after:Alpha think:12000:\x1b'],
    seconds: 24,
    cols,
    rows,
    keep: true,
    seedHome: async (configDir, _cwd) => {
      seedFirstRun(configDir, [_cwd, work])
      process.env.MERCURY_CONFIG_DIR = configDir
      daemon = spawn('node', [DIST, 'daemon', 'run', work], {
        cwd: work,
        env: { ...process.env, MERCURY_CONFIG_DIR: configDir, MERCURY_DAEMON_DIR: daemonDir, ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: api.url, MERCURY_CACHE_CLOCK: '0', MERCURY_PARTY: '0' },
        stdio: ['ignore', logFd, logFd],
      })
      check(`${tag}: the daemon serves`, await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
      const a = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: `escpin-${tag}`,
        prompt: 'think for a long while',
        workspaceDir: _cwd,
        title: 'Alpha think',
        model: DEFAULT_OPUS,
        effort: 'xhigh',
      } as never, { timeoutMs: 15_000 })) as { ok?: boolean; sessionId?: string }
      check(`${tag}: dispatched`, a.ok === true, JSON.stringify(a))
      sid = a.sessionId ?? ''
      const t = join(paths.getProjectDir(_cwd), `${sid}.jsonl`)
      check(`${tag}: transcript born`, await untilAsync(() => existsSync(t) && statSync(t).size > 100, 30_000))
    },
    extraEnv: { MERCURY_CONCOURSE: 'always', MERCURY_DAEMON_DIR: daemonDir, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'fixture-key-000', MERCURY_CACHE_CLOCK: '0' },
  })
  try {
    const escMs = run.sendLog.filter(s => Buffer.from(s.b64, 'base64').toString('latin1') === '\x1b').map(s => sendStamp(run, s)).sort((a, b) => a - b)[0]
    check(`${tag}: the esc was sent`, escMs !== undefined, `stamp ${escMs}; anchor shift ${run.anchorShiftMs}`)
    const grabs = grabScreens(run, cols, rows, [-S(1000), S(4000), S(8000), S(11000)].map(m => Math.max(0, (escMs ?? S(12000)) + m)))
    const text = (g: { rows: string[] }): string => g.rows.join('\n')
    const before = grabs.slice(0, 1)
    check(`${tag}: the turn was LIVE before esc (the status row offers the in-flight interrupt)`, before.some(g => text(g).split('\n').some(row => /esc interrupts/.test(row) && /← back/.test(row))), before.flatMap(g => text(g).split('\n').filter(row => /← back|first byte/.test(row))).join(' · ').slice(0, 500))
    const late = grabs.slice(1)
    check(`${tag}: esc INTERRUPTED — the screen says so (⨯ Interrupted)`, late.some(g => /Interrupted/.test(text(g))), late.map(g => String(g.atMs)).join(','))
    check(`${tag}: the composer returned (poison: still replying in every late frame)`, late.some(g => /Type a prompt/.test(text(g))) && !late.every(g => /replying — your words land/.test(text(g))))
    const recs = JSON.parse(readFileSync(join(daemonDir, 'concourse-workers.json'), 'utf8')) as { workers: Record<string, { sessionId: string; lastDeliveryAt?: number; lastTurnSettledAt?: number }> }
    const rec = Object.values(recs.workers).find(w => w.sessionId === sid)
    check(`${tag}: the record settled (the daemon carried the interrupt)`, (rec?.lastTurnSettledAt ?? 0) >= (rec?.lastDeliveryAt ?? 1), JSON.stringify(rec ?? {}))
  } finally {
    run.cleanup()
  }
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
  }
  ;(daemon as ReturnType<typeof spawn> | null)?.kill('SIGTERM')
  await api.close()
  removeScratch(SCRATCH)
}

console.log('leg A — hopped seat, THINKING phase (no deltas yet), 120x40')
await hoppedLeg('A-thinking', 120, 40, { kind: 'paced', deltas: ['never-arrives '], gapMs: 500, startDelayMs: 60_000, whenModel: 'opus' })

console.log('leg C — hopped seat, mid-REPLYING, 100x30')
await hoppedLeg('C-small', 100, 30, { kind: 'paced', deltas: Array.from({ length: 80 }, (_, i) => `pondering ${String(i + 1).padStart(3, '0')} `), gapMs: 500, settleDelayMs: 2000, whenModel: 'opus' })

console.log('leg B — the born session, mid-thinking, 120x40')
{
  const SCRATCH = mkdtempSync(join(tmpdir(), 'escpin-boot-'))
  const daemonDir = join(SCRATCH, 'daemon')
  mkdirSync(daemonDir, { recursive: true })
  process.env.MERCURY_DAEMON_DIR = daemonDir
  delete process.env.MERCURY_CONCOURSE
  const run = await runArtifactArena({
    turns: [
      { kind: 'paced', deltas: ['never-arrives '], gapMs: 500, startDelayMs: 60_000, whenModel: 'opus' },
      { kind: 'text', text: 'Spare.' },
    ],
    sends: ['after:Type a prompt:1200:think about the sea', 'after:Type a prompt:2400:\r', 'after:Type a prompt:8400:\x1b'],
    seconds: 20,
    cols: 120,
    rows: 40,
    keep: true,
    extraEnv: { MERCURY_DAEMON_DIR: daemonDir },
  })
  try {
    const escMs = run.sendLog
      .filter(s => Buffer.from(s.b64, 'base64').toString('latin1') === '\x1b')
      .map(s => sendStamp(run, s))
      .sort((a, b) => a - b)[0]
    check('B: the capture completed', run.outcome.complete, run.outcome.reason ?? '')
    check('B: the esc was sent', escMs !== undefined, JSON.stringify(run.sendLog.length))
    const grabs = grabScreens(run, 120, 40, [Math.max(0, (escMs ?? 8000) - 700), (escMs ?? 8000) + 2500, (escMs ?? 8000) + 5500])
    const text = (g: { rows: string[] }): string => g.rows.join('\n')
    const before = text(grabs[0]!)
    const waiting = before.split('\n').filter(row => /first byte|first token|ingesting/.test(row)).join(' · ').trim()
    check('B: the born session offers esc interrupts before the key is sent', /esc interrupts/.test(before), before.split('\n').filter(row => /esc interrupt|first byte/.test(row)).join(' · ').slice(0, 500))
    if (run.outcome.complete && escMs !== undefined && waiting) {
      firstBytePending = `B: no first token before the esc capture window; ${waiting}`
      console.log(`  [NEUTRAL] ${firstBytePending}`)
    } else {
      check('B: the born session was reading, thinking or replying before esc', before.includes(READING_PHASE_WORD) || /replying — your words land|thinking/.test(before), before.slice(-500))
    }
    const late = grabs.slice(1)
    check('B: esc interrupted the born session (⨯ Interrupted painted)', late.some(g => /Interrupted/.test(text(g))), late.map(g => String(g.atMs)).join(','))
    check('B: the composer returned', late.some(g => /Type a prompt/.test(text(g))))
  } finally {
    run.cleanup()
  }
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
  }
  removeScratch(SCRATCH)
}

console.log('leg D — the seat clock ledger: a pause measured against an older turn start never hides the live counter')
{
  const paused = adoptSeatTurnStart({ startMs: 1_000, pausedMs: 40_000, pauseStartMs: null }, 50_000, 60_000)
  check('D: a turn start that moved forward drops the pause measured before it', paused.startMs === 50_000 && paused.pausedMs === 0 && paused.pauseStartMs === null, JSON.stringify(paused))
  const open = adoptSeatTurnStart({ startMs: 1_000, pausedMs: 40_000, pauseStartMs: 45_000 }, 50_000, 60_000)
  check('D: an open pause is clipped to the new start', open.pausedMs === 0 && open.pauseStartMs === 50_000, JSON.stringify(open))
  const back = adoptSeatTurnStart({ startMs: 50_000, pausedMs: 4_000, pauseStartMs: null }, 20_000, 60_000)
  check('D: a start that moved back keeps the ledger', back.startMs === 20_000 && back.pausedMs === 4_000, JSON.stringify(back))
  const kept = adoptSeatTurnStart({ startMs: 50_000, pausedMs: 4_000, pauseStartMs: null }, null, 60_000)
  check('D: no start keeps the ledger; a fresh ledger with no start reads now', kept.startMs === 50_000 && kept.pausedMs === 4_000 && adoptSeatTurnStart({ startMs: 0, pausedMs: 0, pauseStartMs: null }, null, 60_000).startMs === 60_000)
  const mounted = anchorSeatClock(null, 1_000, 40_000)
  const restamped = anchorSeatClock(mounted, 50_000, 0)
  check('D: a mounted row carries the dropped pause so its clock never leaps at the re-stamp', anchoredElapsedMs(mounted, 53_000, 0) === 12_000 && anchoredElapsedMs(restamped, 53_000, 0) === 12_000 && restamped.carriedMs === 40_000, JSON.stringify({ mounted, restamped }))
  const remounted = anchorSeatClock(null, 50_000, 3_000)
  check('D: a row mounted after the re-stamp reads from the new start less the pauses after it', anchoredElapsedMs(remounted, 67_000, 0) === 14_000)
}

console.log('leg E — the capsule\'s live counter after a permission pause and a prompt sent mid-turn, 140x40')
{
  const driver = resolveCaptureDriver()
  if (driver.kind !== 'posix-pty') throw new Error('leg E drives a POSIX pty')
  const { recordPty } = await import('../lib/ptyRecorder.ts')
  const { nodeBinPath } = await import('../lib/nodeBin.ts')
  const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'escpin-counter-')))
  const home = join(SCRATCH, 'home')
  const work = join(SCRATCH, 'work')
  const daemonDir = join(SCRATCH, 'daemon')
  const frames = join(SCRATCH, 'frames')
  for (const d of [home, work, daemonDir, frames]) mkdirSync(d, { recursive: true })
  const COLS = 140
  const ROWS = 40
  const HOLD_MS = S(24_000)
  const SECOND_HOLD_MS = 2_000
  const THINK_DELTAS = 56
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'Write', input: { file_path: join(work, 'note-1.txt'), content: 'one\n' }, id: 'toolu_counter_1', model: DEFAULT_OPUS },
    { kind: 'stream', blocks: [{ type: 'thinking', deltas: Array.from({ length: THINK_DELTAS }, (_, i) => `weighing step ${i} `) }], gapMs: 250, tools: [{ name: 'Write', input: { file_path: join(work, 'note-2.txt'), content: 'two\n' }, id: 'toolu_counter_2' }], model: DEFAULT_OPUS },
    { kind: 'stream', blocks: [{ type: 'thinking', deltas: Array.from({ length: 96 }, (_, i) => `weighing step ${i} `) }, { type: 'text', deltas: ['done with the long turn.'] }], gapMs: 250, model: DEFAULT_OPUS },
  ])
  const env: Record<string, string | undefined> = { ...process.env }
  for (const key of Object.keys(env)) if (/^MERCURY_|_API_KEY$|TOKEN|^ANTHROPIC_|^CI$|^NODE_ENV$/.test(key)) delete env[key]
  Object.assign(env, {
    HOME: home, TERM: 'xterm-256color',
    MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: daemonDir, MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: api.url,
    MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_FULLSCREEN: '1', MERCURY_PARTY: '0', MERCURY_CACHE_CLOCK: '0',
    MERCURY_TERMINAL_TITLE: '0', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1', MERCURY_NPM_REGISTRY_BASE: 'http://127.0.0.1:9', BROWSER: '/usr/bin/true',
    MERCURY_CRITTER_IDLE: '0', MERCURY_CRITTER_GAZE: '0', MERCURY_CRITTER_SLEEP: '0', MERCURY_TURN_RECEIPT: '0', MERCURY_SPLASH: 'off', MERCURY_WARM_RUNNER: '0',
  })
  seedFirstRun(home, [work])
  const node = nodeBinPath()
  const pty = recordPty({ argv: [node, DIST], cwd: work, env, cols: COLS, rows: ROWS, path: join(SCRATCH, 'pty.bin') })
  const frame = (tag: string): string => {
    const tee = join(frames, `${tag}.tee`)
    const chunks = pty.records.filter(r => r.direction === 'output').map((r, i) => {
      const h = Buffer.alloc(8)
      h.writeUInt32BE(i)
      h.writeUInt32BE(r.bytes.length, 4)
      return Buffer.concat([h, r.bytes])
    })
    writeFileSync(tee, Buffer.concat(chunks))
    const read = spawnSync(driver.python, [join(process.cwd(), 'scripts', 'ui', 'replay-tee-grid.py'), tee, String(COLS), String(ROWS), join(frames, `${tag}.json`)], { encoding: 'utf8' })
    if (read.status !== 0) throw new Error(`replay-tee-grid failed: ${read.stderr}`)
    writeFileSync(join(frames, `${tag}.txt`), read.stdout)
    return read.stdout
  }
  const until = (read: () => boolean, ms: number): Promise<boolean> => untilAsync(read, ms)
  const holdDialog = (ms: number): Promise<boolean> => {
    const release = Date.now() + ms
    return untilAsync(() => Date.now() >= release, ms + S(5_000))
  }
  const capsuleRow = (text: string): string | null => {
    for (const line of text.split('\n')) {
      const m = /[✶✸✹✺✷]\s+\S[^│]*?…/.exec(line)
      if (m) return line.slice(m.index).replace(/│.*$/, '').trim()
    }
    return null
  }
  const clockOf = (row: string | null): number | null => {
    const m = row === null ? null : /\((?:(\d+)m )?(\d+)s · ↓ /.exec(row)
    return m === null ? null : Number(m[1] ?? 0) * 60 + Number(m[2])
  }
  const messageRequests = (): number => api.messageRequests().length
  const facts = (): { turnStartedAt?: number } | null => {
    try {
      const dir = join(daemonDir, 'session-facts')
      const name = existsSync(dir) ? readdirSync(dir).find(f => f.endsWith('.json')) : undefined
      return name === undefined ? null : (JSON.parse(readFileSync(join(dir, name), 'utf8')) as { turnStartedAt?: number })
    } catch {
      return null
    }
  }
  try {
    check('E: the boot menu painted', await until(() => /new session/i.test(frame('boot')), S(60_000)))
    pty.send('\r')
    check('E: the chat painted', await until(() => /Type a prompt|\? for shortcuts/.test(frame('chat')), S(60_000)))
    pty.send('write the first note')
    check('E: the composer took the prompt', await until(() => /write the first note/.test(frame('typed')), S(15_000)))
    pty.send('\r')
    check('E: the write asked for consent (the first permission dialog)', await until(() => /create note-1\.txt\?/.test(frame('dialog-1')), S(60_000)))
    await holdDialog(HOLD_MS)
    pty.send('\r')
    check('E: the second request streamed after the consent', await until(() => messageRequests() >= 2, S(30_000)))
    let before: string | null = null
    const counting = await until(() => {
      before = capsuleRow(frame('before-later'))
      const clock = clockOf(before)
      return clock !== null && clock >= 1 && clock < HOLD_MS / 1000
    }, S(15_000))
    const clockBefore = clockOf(before)
    check('E: the capsule row carries the clock and the count before the mid-turn prompt (the dialog hold is not counted)', counting && clockBefore !== null, JSON.stringify(before))
    const startBefore = facts()?.turnStartedAt ?? 0
    pty.send('later please')
    check('E: the composer took the mid-turn prompt', await until(() => /later please/.test(frame('typed-later')), S(15_000)))
    pty.send('\r')
    check('E: the queued prompt re-stamped the seat\'s turn start while the turn stayed busy', await until(() => (facts()?.turnStartedAt ?? 0) > startBefore, S(15_000)), JSON.stringify({ startBefore, after: facts()?.turnStartedAt }))
    let after: string | null = null
    const grew = await until(() => {
      after = capsuleRow(frame('after-later'))
      const clock = clockOf(after)
      return clock !== null && clockBefore !== null && clock >= clockBefore + 2
    }, S(12_000))
    const clockAfter = clockOf(after)
    check('E: the mounted row keeps counting across the re-stamp (no leap by the dialog hold, no loss)', grew && clockBefore !== null && clockAfter !== null && clockAfter - clockBefore <= 12, JSON.stringify({ before, after }))
    check('E: the second write asked for consent (the row remounts behind it)', await until(() => /create note-2\.txt\?/.test(frame('dialog-2')), S(60_000)))
    await holdDialog(SECOND_HOLD_MS)
    pty.send('\r')
    check('E: the third request streamed after the second consent', await until(() => messageRequests() >= 3, S(30_000)))
    const remounted: Array<{ row: string | null; atMs: number }> = []
    const sample = (tag: string): void => { remounted.push({ row: capsuleRow(frame(tag)), atMs: Date.now() }) }
    const painted = await until(() => clockOf(capsuleRow(frame('remounted-first'))) !== null, S(10_000))
    sample('remounted-first')
    const firstClock = clockOf(remounted[0]!.row)
    const kept = await until(() => {
      const clock = clockOf(capsuleRow(frame('remounted-later')))
      return clock !== null && firstClock !== null && clock >= firstClock + 3
    }, S(10_000))
    sample('remounted-later')
    check('E RED ON THE BASE: the remounted capsule row carries the clock and the ↓ count at once — the pause before the re-stamp never hides the live counter', painted && kept && remounted.every(({ row }) => clockOf(row) !== null), JSON.stringify(remounted))
    check('E: the remounted clock reads from the re-stamped start, the second hold excluded', remounted.every(({ row, atMs }) => { const c = clockOf(row); return c !== null && c >= 6 && c < (atMs - startBefore) / 1000 - 1 }), JSON.stringify(remounted))
    check('E: the long turn settled with its reply on the screen', await until(() => /done with the long turn/.test(frame('end')), S(60_000)))
  } catch (error) {
    check('E: the drive completed', false, String(error))
    frame('failed')
  } finally {
    await pty.close()
    const stop = spawn(node, [DIST, 'daemon', 'stop'], { cwd: work, env, stdio: 'ignore' })
    await new Promise<void>(r => stop.once('exit', () => r()))
    await api.close()
    if (failures === 0) removeScratch(SCRATCH)
    else console.log(`  [forensics] leg E frames kept: ${frames}`)
  }
}

console.log(failures > 0 ? `\nprove-esc-interrupts-drive: ${failures} FAILURE(S)` : firstBytePending !== null ? `\nprove-esc-interrupts-drive: NEUTRAL — ${firstBytePending}; interrupt checks passed` : '\nprove-esc-interrupts-drive: ALL LAWS HOLD')
process.exit(failures === 0 ? 0 : 1)
