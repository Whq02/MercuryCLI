#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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

const ASK = 'run the long sleep please'
const WORDS = 'the words to take back'
const REPLY = 'the reply stands here after its last item'
const REFUSAL = 'already taken — esc interrupts the turn'
const TOOL_ROW = '▰ Bash'
const UP = '\x1b[A'
const ESC = '\x1b'

type Scene = 'recall' | 'race' | 'chat'
type Wire = { kind: string; n?: number; ask?: string; arm?: string; step?: number; shape?: string; tools?: number; texts?: string[]; at: number }
type Mark = { label: string; atTick: number; grid: Array<Array<{ c: string }>> }
type LedgerRow = { action: string; detail?: string; outcome: string; atMs: number }
type CensusRow = { site: string; at: number; digest?: string; len?: number }
const gridText = (grid: Array<Array<{ c: string }>>): string =>
  grid.map(r => r.map(c => c.c || ' ').join('').replace(/\s+$/, '')).join('\n')
const tail = (s: string, n = 12): string => s.split('\n').slice(-n).join('\n')
const count = (s: string, needle: string): number => s.split(needle).length - 1
const digestOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 8)

const composerHolds = (frame: string, words: string): boolean =>
  frame.split('\n').some(line => /^│❯ /.test(line) && line.includes(words))
const composerEmpty = (frame: string): boolean => frame.split('\n').some(line => /^│❯\s*│$/.test(line))
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const queuedRow = (frame: string, words: string): boolean => new RegExp(`queued\\s+\\[sam\\] ❯ ${escapeRe(words)}`).test(frame)
const transcriptRows = (frame: string, words: string): number => frame.split('\n').filter(line => new RegExp(`\\[sam\\] ❯ ${escapeRe(words)}`).test(line)).length

async function drive(scene: Scene): Promise<void> {
  const words = scene === 'race' ? ASK : WORDS
  const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-recall-${scene}-${process.pid}`)
  const FIXTURE_CWD = path.join(RUN_HOME, 'fixture-repo')
  const PROBE_KEY = 'sk-ant-recall-probe-key'
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
    { requireAwait: true, minTick: 10, awaitText: '? for shortcuts', awaitSettleTicks: 2, data: `${ASK}\r` },
    { requireAwait: true, minTick: 10, awaitText: 'running…', awaitSettleTicks: 6, data: `${words}\r`, mark: 'tool-running' },
  ]
  const rest =
    scene === 'race'
      ? [
          { afterPrevTicks: 8, data: ESC, mark: 'queued' },
          { afterPrevTicks: 4, data: UP, mark: 'esc-landed' },
          { afterPrevTicks: 5, data: '', mark: 'after-up' },
          { afterPrevTicks: 10, data: ESC, mark: 'next-turn' },
          { afterPrevTicks: 20, data: '', mark: 'settled' },
        ]
      : [
          { afterPrevTicks: 8, data: UP, mark: 'queued' },
          { afterPrevTicks: 5, data: '', mark: 'after-up' },
          { afterPrevTicks: 2, data: ESC, mark: 'before-esc' },
          { afterPrevTicks: 20, data: '', mark: 'settled' },
          { afterPrevTicks: 2, data: '\r', mark: 'resend' },
          { requireAwait: true, minTick: 5, awaitText: 'after its last item', awaitSettleTicks: 5, data: '', mark: 'answered' },
        ]
  const sends = [...boot, ...rest]
  const readyText = scene === 'race' ? '· ready' : REPLY
  const cfg = {
    argv: ['node', DIST, '--model', 'claude-opus-4-8', ...(scene === 'chat' ? ['--chat'] : [])],
    cwd: FIXTURE_CWD,
    sends,
    total: 450,
    readyText,
    cols: 120,
    rows: 40,
    out,
  }
  const cfgPath = path.join(RUN_HOME, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(cfg))

  const daemonDir = path.join(RUN_HOME, 'daemon')
  const censusPath = path.join(RUN_HOME, 'submit-trace.jsonl')
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
    MERCURY_SUBMIT_TRACE: censusPath,
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
  let trace: Array<Record<string, unknown>> = []
  try {
    trace = readFileSync(path.join(RUN_HOME, 'connector-trace.jsonl'), 'utf8')
      .split('\n')
      .filter(l => l.trim() !== '')
      .map(l => JSON.parse(l) as Record<string, unknown>)
      .filter(e => ['facts', 'interrupt', 'send', 'send-landed', 'withdraw', 'withdrawn'].includes(String(e.ev)))
  } catch {
  }
  let census: CensusRow[] = []
  try {
    census = readFileSync(censusPath, 'utf8')
      .split('\n')
      .filter(l => l.trim() !== '')
      .map(l => JSON.parse(l) as CensusRow)
  } catch {
  }
  const wordRows = census.filter(r => r.digest === digestOf(words))
  console.log(`\n── ${scene}: the seat's timeline (connector trace) ──`)
  const t0 = trace.length > 0 ? Number(trace[0]!.t) : 0
  for (const e of trace) {
    const { t, sid: _sid, ev, ...restOf } = e
    console.log(`  +${String(Number(t) - t0).padStart(6)}ms ${String(ev).padEnd(13)} ${JSON.stringify(restOf)}`)
  }
  console.log(`── ${scene}: the wire ──`)
  const conversation = wire.filter(w => w.kind === 'anthropic')
  for (const c of conversation) console.log(`  #${c.n} ${c.arm} step=${c.step ?? '-'} ask=${JSON.stringify((c.ask ?? '').slice(0, 60))} shape=${c.shape ?? ''} tools=${c.tools ?? 0}`)
  console.log(`── ${scene}: the census rows for the words ──`)
  for (const r of wordRows) console.log(`  ${r.site} @${r.at}`)

  const carrying = conversation.filter(c => (c.tools ?? 0) > 0 && ((c.ask ?? '').includes(words) || JSON.stringify(c.texts ?? []).includes(words)))
  const sleepSteps = conversation.filter(c => c.arm === 'sleep-tool' && c.step === 0 && (c.tools ?? 0) > 0)

  section(`${scene} — R1: the words queued into the running turn`)
  check(`${scene}: vshot ran the journey as written`, res.status === 0, `status=${res.status} ${(res.stderr ?? '').split('\n').slice(-3).join(' | ')}`)
  console.log(`  [record] ${scene}: the capture ended on '${endReason}' at tick ${endedAtTick} (ready text ${JSON.stringify(readyText)})`)
  check(`${scene}: the capture ended on the scene's ready text, never the budget`, endReason === 'ready', `endReason=${endReason} at tick ${endedAtTick}`)
  check(`${scene}: the Bash tool was running its sleep when the words were typed`, at('tool-running').includes(TOOL_ROW) && at('tool-running').includes('running…'), tail(at('tool-running')))
  check(`${scene}: the words painted as the QUEUED row before the press, the composer empty`, queuedRow(at('queued'), words) && !composerHolds(at('queued'), words) && composerEmpty(at('queued')), tail(at('queued'), 24))

  if (scene === 'race') {
    section(`${scene} — R2: a line the runner took is never withdrawn`)
    const refused = at('after-up').includes(REFUSAL) && composerEmpty(at('after-up'))
    const history = !at('after-up').includes(REFUSAL) && composerHolds(at('after-up'), ASK)
    console.log(`  [record] ↑ after the take met: ${refused ? 'the refusal line (taken, still tracked)' : history ? 'history (taken and retired)' : 'neither'}`)
    check(`${scene}: after ↑ the line stays taken — the refusal line with the composer empty, or history once the seat retired it; never the words withdrawn`, refused || history, tail(at('after-up')))
    check(`${scene}: the seat's record holds no withdrawn answer`, !trace.some(e => e.ev === 'withdrawn' && e.withdrawn === true), JSON.stringify(trace.filter(e => e.ev === 'withdrawn')))
    check(`${scene}: the drained turn is running its own sleep at the press (the words were taken)`, at('after-up').includes('running…') || at('next-turn').includes('running…'), tail(at('next-turn')))
    section(`${scene} — R3: the wire: the words went once, as the drained turn`)
    check(`${scene}: the fixture served the sleep twice — the ask and the drained turn, never a third`, sleepSteps.length === 2, JSON.stringify(conversation.map(c => [c.n, c.arm, c.step])))
    check(`${scene}: the applied-ops ledger holds two plain interrupts`, interrupts.length === 2 && interrupts.every(r => r.outcome === 'applied' && (r.detail ?? '').startsWith('interrupt ')), JSON.stringify(interrupts))
    section(`${scene} — R4: the census: two deliveries of the words (the ask, the queued line), no second road`)
    check(`${scene}: the connector delivered the words exactly twice — the ask and the queued line; ↑ delivered nothing`, wordRows.filter(r => r.site === 'connector-deliver').length === 2, wordRows.map(r => r.site).join(' ') || 'no rows')
    check(`${scene}: no other writer submitted the words (the recall added no road)`, wordRows.every(r => r.site === 'repl-onSubmit' || r.site === 'connector-deliver'), wordRows.map(r => r.site).join(' '))
  } else {
    section(`${scene} — R2: ↑ brings the queued words back into the composer`)
    check(`${scene}: after ↑ the composer holds the words`, composerHolds(at('after-up'), words), tail(at('after-up')))
    check(`${scene}: the queued row is gone — no transcript row carries the words`, !queuedRow(at('after-up'), words) && transcriptRows(at('after-up'), words) === 0, tail(at('after-up'), 24))
    check(`${scene}: no history recall rode the press (the previous prompt is not in the composer)`, !composerHolds(at('after-up'), ASK), tail(at('after-up')))
    check(`${scene}: the refusal line never painted`, !at('after-up').includes(REFUSAL), tail(at('after-up')))
    check(`${scene}: the composer still holds the words when esc ends the turn`, composerHolds(at('before-esc'), words), tail(at('before-esc')))
    section(`${scene} — R3: the wire: no drained turn, the re-send carried once`)
    check(`${scene}: the sleep was served once — no drained turn ran behind the interrupt`, sleepSteps.length === 1, JSON.stringify(conversation.map(c => [c.n, c.arm, c.step])))
    const resendAt = carrying[0]?.at ?? 0
    const escAt = interrupts[0]?.atMs ?? 0
    check(`${scene}: exactly one request carries the words — the re-send, after the interrupt`, carrying.length === 1 && resendAt > escAt, `${carrying.length} carrying · resend ${resendAt} · esc ${escAt}`)
    check(`${scene}: the applied-ops ledger holds one plain interrupt`, interrupts.length === 1 && interrupts.every(r => r.outcome === 'applied' && (r.detail ?? '').startsWith('interrupt ')), JSON.stringify(interrupts))
    section(`${scene} — R4: the census: two submits, two deliveries, no second road`)
    check(`${scene}: the composer submitted the words twice (the send, the re-send) and the connector delivered them twice`, wordRows.filter(r => r.site === 'repl-onSubmit').length === 2 && wordRows.filter(r => r.site === 'connector-deliver').length === 2, wordRows.map(r => r.site).join(' ') || 'no rows')
    check(`${scene}: no other writer submitted the words (the recall added no road)`, wordRows.every(r => r.site === 'repl-onSubmit' || r.site === 'connector-deliver'), wordRows.map(r => r.site).join(' '))
    const withdrawn = trace.filter(e => e.ev === 'withdrawn')
    check(`${scene}: the seat's record: one withdraw answered withdrawn`, withdrawn.length === 1 && withdrawn[0]!.withdrawn === true, JSON.stringify(withdrawn))
  }

  section(`${scene} — R5: the settle: ready, the child dead, the runner alive`)
  check(`${scene}: the strip is back at ready`, /· ready/.test(at('settled')), tail(at('settled')))
  check(`${scene}: the sleeping child is dead`, sleepers() === '', `alive: ${sleepers()}`)
  if (scene !== 'race') check(`${scene}: the re-sent words were answered — the runner is alive`, at('answered').includes(REPLY) || fin.includes(REPLY), tail(at('answered') || fin))

  if (failures === 0) rmSync(RUN_HOME, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${RUN_HOME}`)
}

console.log('============================================================')
console.log(' ↑ pulls a sent, not yet taken line back into the composer — the built bundle')
console.log('============================================================')
const only = (process.env.RECALL_SCENES ?? '').split(',').map(s => s.trim()).filter(s => s !== '')
const wants = (scene: Scene): boolean => only.length === 0 || only.includes(scene)
if (wants('recall')) await drive('recall')
if (wants('race')) await drive('race')
if (wants('chat')) await drive('chat')
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
