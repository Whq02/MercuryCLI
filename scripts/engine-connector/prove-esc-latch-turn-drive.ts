#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = path.resolve(import.meta.dir, '../..')
const DIST = path.join(REPO, 'dist/mercury.mjs')
const VSHOT = path.join(REPO, 'scripts/ui/vshot.py')
const FIXTURE = path.join(REPO, 'scripts/streaming/turn-end-fixture-server.ts')
const BUN = process.env.BUN ?? path.join(process.env.HOME ?? '', '.bun/bin/bun')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

if (!existsSync(DIST)) {
  console.log('FAIL dist/mercury.mjs missing — run `bun run build.ts` first (the drive proves the BUILT binary)')
  process.exit(1)
}

const REPLY = 'the reply stands here after its last item'
const AFTER_WORDS = 'words after the settle'
const INTERRUPTING = 'interrupting — the request is torn down'
const HARD_STOPPING = 'stopping — the runner is cut'
const AGAIN = 'esc again forces a stop'

type Scene = 'fresh' | 'drain'
type Wire = { kind: string; n?: number; ask?: string; arm?: string; step?: number; shape?: string; at: number }
type Mark = { label: string; atTick: number; grid: Array<Array<{ c: string }>> }
type LedgerRow = { action: string; detail?: string; outcome: string; atMs: number }
const gridText = (grid: Array<Array<{ c: string }>>): string =>
  grid.map(r => r.map(c => c.c || ' ').join('').replace(/\s+$/, '')).join('\n')
const tail = (s: string, n = 12): string => s.split('\n').slice(-n).join('\n')
const count = (s: string, needle: string): number => s.split(needle).length - 1

async function drive(scene: Scene): Promise<void> {
  const ask = 'run the long sleep please'
  const arm = 'sleep-tool'
  const TOOL_ROW = '▰ Bash'
  const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-esclatch-${scene}-${process.pid}`)
  const FIXTURE_CWD = path.join(RUN_HOME, 'fixture-repo')
  const PROBE_KEY = 'sk-ant-esclatch-probe-key'
  rmSync(RUN_HOME, { recursive: true, force: true })
  mkdirSync(FIXTURE_CWD, { recursive: true })
  writeFileSync(
    path.join(RUN_HOME, '.mercury.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: 'dark',
      projects: { [FIXTURE_CWD]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
    }),
  )
  writeFileSync(path.join(RUN_HOME, 'settings.json'), JSON.stringify({}))
  writeFileSync(path.join(FIXTURE_CWD, 'README.md'), '# fixture\n')

  const captureFile = path.join(RUN_HOME, 'wire.jsonl')
  writeFileSync(captureFile, '')
  const fixture = spawn(BUN, ['run', FIXTURE, captureFile, FIXTURE_CWD], { stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const killer = setTimeout(() => reject(new Error('fixture never printed PORT')), 15_000)
    let buffer = ''
    fixture.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const m = /PORT (\d+)/.exec(buffer)
      if (m) {
        clearTimeout(killer)
        resolve(Number(m[1]))
      }
    })
    fixture.on('exit', code => reject(new Error(`fixture exited early (${code})`)))
  }).catch(err => {
    console.log(`FAIL ${String(err)}`)
    process.exit(1)
  })
  const base = `http://127.0.0.1:${port}`
  const reap = (): void => {
    try {
      fixture.kill('SIGTERM')
    } catch {
    }
  }

  const out = path.join(RUN_HOME, 'grid.json')
  const boot = [
    { atTick: 60, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, minTick: 10, awaitText: '? for shortcuts', awaitSettleTicks: 2, data: `${ask}\r` },
  ]
  const press =
    scene === 'fresh'
      ? [
          { requireAwait: true, minTick: 10, awaitText: 'running…', awaitSettleTicks: 6, data: '\x1b', mark: 'tool-running' },
          { afterPrevTicks: 1, data: `${ask}\r`, mark: 'esc-landed' },
          { afterPrevTicks: 5, data: '', mark: 'sent' },
        ]
      : [
          { requireAwait: true, minTick: 10, awaitText: 'running…', awaitSettleTicks: 6, data: `${ask}\r`, mark: 'tool-running' },
          { afterPrevTicks: 10, data: '\x1b', mark: 'queued' },
          { afterPrevTicks: 1, data: '', mark: 'esc-landed' },
          { afterPrevTicks: 5, data: '', mark: 'sent' },
        ]
  const rest = [
    { afterPrevTicks: 15, data: '', mark: 'next-turn' },
    { afterPrevTicks: 10, data: '\x1b', mark: 'next-turn-late' },
    { afterPrevTicks: 2, data: '', mark: 'after-esc-2' },
    { afterPrevTicks: 20, data: `${AFTER_WORDS}\r`, mark: 'settled' },
    { requireAwait: true, minTick: 5, awaitText: 'after its last item', awaitSettleTicks: 5, data: '', mark: 'answered' },
  ]
  const sends = [...boot, ...press, ...rest]
  const cfg = {
    argv: ['node', DIST, '--model', 'claude-opus-4-8'],
    cwd: FIXTURE_CWD,
    sends,
    total: 450,
    readyText: REPLY,
    cols: 120,
    rows: 40,
    out,
  }
  const cfgPath = path.join(RUN_HOME, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(cfg))

  const daemonDir = path.join(RUN_HOME, 'daemon')
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: RUN_HOME,
    ANTHROPIC_API_KEY: PROBE_KEY,
    ANTHROPIC_BASE_URL: base,
    MERCURY_STREAM_IDLE_TIMEOUT_MS: '30000',
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_DECK_COMPANION: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_DOCTOR_STATE_DIR: path.join(RUN_HOME, 'doctor-state'),
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_TEAMS_DIR: path.join(RUN_HOME, 'teams'),
    MERCURY_TABULA_DIR: path.join(RUN_HOME, 'tabula'),
    MERCURY_TABULA_MINERVA: '0',
    MERCURY_HOME: path.join(RUN_HOME, 'proof-home'),
    MERCURY_CONNECTOR_TRACE: path.join(RUN_HOME, 'connector-trace.jsonl'),
  }
  delete childEnv.NODE_ENV
  delete childEnv.ANTHROPIC_AUTH_TOKEN

  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(160_000),
    cwd: FIXTURE_CWD,
    env: childEnv,
  })
  reap()
  const marks = new Map<string, string>()
  let fin = ''
  let endReason = ''
  let endedAtTick = -1
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>>; marks?: Mark[]; endReason?: string; endedAtTick?: number }
    for (const m of payload.marks ?? []) marks.set(m.label, gridText(m.grid))
    fin = gridText(payload.grid)
    endReason = payload.endReason ?? ''
    endedAtTick = payload.endedAtTick ?? -1
  }
  const wire: Wire[] = readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Wire)
  const at = (label: string): string => marks.get(label) ?? ''
  const sleepers = (): string => spawnSync('/usr/bin/pgrep', ['-f', 'sleep 40'], { encoding: 'utf8' }).stdout.trim()
  let ledger: LedgerRow[] = []
  try {
    const raw = JSON.parse(readFileSync(path.join(daemonDir, 'concourse-control-ops.json'), 'utf8')) as { ops?: Record<string, LedgerRow> }
    ledger = Object.values(raw.ops ?? {}).sort((a, b) => a.atMs - b.atMs)
  } catch {
  }
  const interrupts = ledger.filter(r => r.action === 'interrupt')
  let daemonLog = ''
  try {
    daemonLog = readFileSync(path.join(daemonDir, 'daemon.log'), 'utf8')
  } catch {
  }
  let trace: Array<Record<string, unknown>> = []
  try {
    trace = readFileSync(path.join(RUN_HOME, 'connector-trace.jsonl'), 'utf8')
      .split('\n')
      .filter(l => l.trim() !== '')
      .map(l => JSON.parse(l) as Record<string, unknown>)
      .filter(e => ['facts', 'interrupt', 'latch-release', 'send', 'send-landed'].includes(String(e.ev)))
  } catch {
  }
  console.log(`\n── ${scene}: the seat's timeline (connector trace) ──`)
  const t0 = trace.length > 0 ? Number(trace[0]!.t) : 0
  for (const e of trace) {
    const { t, sid: _sid, ev, ...rest } = e
    console.log(`  +${String(Number(t) - t0).padStart(6)}ms ${String(ev).padEnd(13)} ${JSON.stringify(rest)}`)
  }
  console.log(`── ${scene}: the wire ──`)
  for (const c of wire.filter(w => w.kind === 'anthropic')) console.log(`  #${c.n} ${c.arm} step=${c.step ?? '-'} ask=${JSON.stringify((c.ask ?? '').slice(0, 60))} shape=${c.shape ?? ''}`)
  console.log(`  [record] one tick after the press: ${at('esc-landed').includes(INTERRUPTING) ? 'the interrupting rung' : /· ready/.test(at('esc-landed')) ? 'ready (the turn had ended)' : 'neither'}`)
  const releases = trace.filter(e => e.ev === 'latch-release').map(e => String(e.road))
  console.log(`  [record] latch releases by road: ${releases.join(', ') || 'none'}`)

  section(`${scene} — E1: the press lands on a running tool`)
  check(`${scene}: vshot ran the journey as written`, res.status === 0, `status=${res.status} ${(res.stderr ?? '').split('\n').slice(-3).join(' | ')}`)
  console.log(`  [record] ${scene}: the capture ended on '${endReason}' at tick ${endedAtTick} (ready text ${JSON.stringify(REPLY)})`)
  check(`${scene}: the capture ended on the scene's ready text, never the budget`, endReason === 'ready', `endReason=${endReason} at tick ${endedAtTick}`)
  check(`${scene}: the Bash tool was running its sleep, the row wearing "esc interrupts"`, at('tool-running').includes(TOOL_ROW) && at('tool-running').includes('running…') && /esc interrupts/.test(at('tool-running')), tail(at('tool-running')))
  if (scene === 'drain') check(`${scene}: the words typed into the running turn painted QUEUED before the press`, /queued\s+\[sam\] ❯ run the long sleep please/.test(at('queued')), tail(at('queued')))

  section(`${scene} — E2: the next turn wears its own phase, never the stale latch`)
  const sleepSteps = wire.filter(c => c.kind === 'anthropic' && c.arm === arm && c.step === 0 && ((c as { tools?: number }).tools ?? 0) > 0)
  check(`${scene}: the second ask earned a fresh sleep turn (the fixture served the sleep twice)`, sleepSteps.length === 2, JSON.stringify(wire.map(c => [c.n, c.arm, c.step])))
  const nextRunning = (frame: string): boolean => frame.includes(TOOL_ROW) && frame.includes('running…')
  check(`${scene}: the next turn is on screen — its Bash row running${scene === 'drain' ? ' (the drained turn opened the seat\'s edge on the wire)' : ''}`, nextRunning(at('next-turn')), tail(at('next-turn')))
  for (const label of ['next-turn', 'next-turn-late']) {
    const frame = at(label)
    check(`${scene} ${label}: the row wears the running turn's own rung — "esc interrupts"${scene === 'drain' ? ' (the seat reads busy over the drained turn)' : ''}`, /esc interrupts/.test(frame), tail(frame))
    check(`${scene} ${label}: no stale "interrupting" over a turn nobody interrupted`, !frame.includes(INTERRUPTING) && !frame.includes(AGAIN), tail(frame))
  }

  section(`${scene} — E3: the second esc is a plain interrupt of the new turn`)
  console.log(`  [record] after the second esc: ${at('after-esc-2').includes(INTERRUPTING) ? 'the interrupting rung' : /· ready/.test(at('after-esc-2')) ? 'ready (the turn had ended)' : 'neither'}`)
  check(`${scene}: never the hard stop ("stopping — the runner is cut")`, !at('after-esc-2').includes(HARD_STOPPING) && !at('settled').includes(HARD_STOPPING), tail(at('after-esc-2')))

  section(`${scene} — E4: the wire: plain interrupts only, no runner cut`)
  check(`${scene}: the applied-ops ledger holds exactly two interrupt rows${scene === 'drain' ? ' (the second press found the drained turn)' : ''}`, interrupts.length === 2, JSON.stringify(ledger))
  check(`${scene}: every interrupt on the ledger is a plain interrupt — never a hard stop`, interrupts.length >= 1 && interrupts.every(r => r.outcome === 'applied' && (r.detail ?? '').startsWith('interrupt ')), JSON.stringify(interrupts))
  check(`${scene}: the daemon never cut the runner (no hard-stop line in its log)`, !/hard stop:/.test(daemonLog), daemonLog.split('\n').filter(l => /hard stop/.test(l)).slice(-3).join(' | '))

  section(`${scene} — E5: the settle: ready, the child dead, the runner answers`)
  check(`${scene}: the strip is back at ready with no esc clause`, /· ready/.test(at('settled')) && !/esc interrupts/.test(at('settled')) && !at('settled').includes(INTERRUPTING) && !at('settled').includes(AGAIN), tail(at('settled')))
  check(`${scene}: the sleeping child is dead`, sleepers() === '', `alive: ${sleepers()}`)
  check(`${scene}: the words typed after the settle were answered — the runner is alive`, at('answered').includes(REPLY) || fin.includes(REPLY), tail(at('answered') || fin))

  if (failures === 0) rmSync(RUN_HOME, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${RUN_HOME}`)
}

console.log('============================================================')
console.log(' the interrupt latch belongs to the turn it interrupted — the built bundle')
console.log('============================================================')
const only = (process.env.ESC_LATCH_SCENES ?? '').split(',').map(s => s.trim()).filter(s => s !== '')
const wants = (scene: Scene): boolean => only.length === 0 || only.includes(scene)
if (wants('fresh')) await drive('fresh')
if (wants('drain')) await drive('drain')
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
