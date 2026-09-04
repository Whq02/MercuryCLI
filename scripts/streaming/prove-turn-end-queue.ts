#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = path.resolve(import.meta.dir, '../..')
const DIST = path.join(REPO, 'dist/mercury.mjs')
const VSHOT = path.join(REPO, 'scripts/ui/vshot.py')
const FIXTURE = path.join(import.meta.dir, 'turn-end-fixture-server.ts')
const BUN = process.env.BUN ?? path.join(process.env.HOME ?? '', '.bun/bin/bun')
const BUDGET_MS = 8_000

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
const ASK = 'hold after settle please'
const FIRST = 'first queued words'
const SECOND = 'second queued words'

type Wire = { kind: string; n?: number; ask?: string; arm?: string; at: number }
type Mark = { label: string; atTick: number; grid: Array<Array<{ c: string }>> }
const gridText = (grid: Array<Array<{ c: string }>>): string =>
  grid.map(r => r.map(c => c.c || ' ').join('').replace(/\s+$/, '')).join('\n')

async function driveWire(route: 'openai' | 'anthropic'): Promise<void> {
  const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-turnend-${route}-${process.pid}`)
  const FIXTURE_CWD = path.join(RUN_HOME, 'fixture-repo')
  const PROBE_KEY = 'sk-ant-turnend-probe-key'
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
  const fixture = spawn(BUN, ['run', FIXTURE, captureFile], { stdio: ['ignore', 'pipe', 'pipe'] })
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

  const model = route === 'openai' ? 'gpt-5.6-sol' : 'claude-opus-4-8'
  const out = path.join(RUN_HOME, 'grid.json')
  const cfg = {
    argv: ['node', DIST, '--model', model],
    cwd: FIXTURE_CWD,
    sends: [
      { atTick: 60, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { requireAwait: true, minTick: 10, awaitText: '? for shortcuts', awaitSettleTicks: 2, data: `${ASK}\r` },
      { requireAwait: true, minTick: 10, awaitText: 'after its last item', awaitSettleTicks: 6, data: `${FIRST}\r` },
      { afterPrevTicks: 10, data: `${SECOND}\r` },
      { afterPrevTicks: 12, data: '/workbench\r', mark: 'chat-queued' },
      { requireAwait: true, minTick: 5, awaitText: 'PROMPTS (', awaitSettleTicks: 6, data: '\x1b', mark: 'workbench' },
      { afterPrevTicks: 5 + Math.ceil(BUDGET_MS / 200) + 40, data: '', mark: 'after-budget' },
    ],
    total: 400,
    cols: 120,
    rows: 40,
    out,
  }
  const cfgPath = path.join(RUN_HOME, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(cfg))

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: RUN_HOME,
    ANTHROPIC_API_KEY: PROBE_KEY,
    ANTHROPIC_BASE_URL: base,
    OPENAI_API_KEY: 'sk-test-turnend-openai',
    MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
    MERCURY_STREAM_IDLE_TIMEOUT_MS: String(BUDGET_MS),
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
    MERCURY_DAEMON_DIR: path.join(RUN_HOME, 'daemon'),
    MERCURY_TEAMS_DIR: path.join(RUN_HOME, 'teams'),
    MERCURY_TABULA_DIR: path.join(RUN_HOME, 'tabula'),
    MERCURY_TABULA_MINERVA: '0',
    MERCURY_HOME: path.join(RUN_HOME, 'proof-home'),
  }
  delete childEnv.NODE_ENV
  delete childEnv.ANTHROPIC_AUTH_TOKEN

  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(150_000),
    cwd: FIXTURE_CWD,
    env: childEnv,
  })
  reap()
  const marks = new Map<string, string>()
  let fin = ''
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>>; marks?: Mark[] }
    for (const m of payload.marks ?? []) marks.set(m.label, gridText(m.grid))
    fin = gridText(payload.grid)
  }
  const wire: Wire[] = readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Wire)
  const label = route === 'openai' ? 'OpenAI' : 'Anthropic'
  const calls = wire.filter(c => c.kind === route)
  const holds = wire.filter(c => c.kind === 'held')
  const chat = marks.get('chat-queued') ?? ''
  const bench = marks.get('workbench') ?? ''
  const after = marks.get('after-budget') ?? ''
  const tail = (s: string): string => s.split('\n').slice(-14).join('\n')

  section(`${label} — Q1/Q2: the reply settled, the typed rows say QUEUED, the roll agrees`)
  check(`${label}: vshot ran the journey as written`, res.status === 0, `status=${res.status} ${(res.stderr ?? '').split('\n').slice(-3).join(' | ')}`)
  check(`${label}: the reply row settled while the turn ran on`, chat.includes(`[Mercury] ${REPLY}`) && /esc interrupt/.test(chat), tail(chat))
  check(`${label}: the first typed row paints QUEUED in the clock column — no sent time`, /queued\s+\[sam\] ❯ first queued words/.test(chat), tail(chat))
  check(`${label}: the second typed row paints QUEUED too`, /queued\s+\[sam\] ❯ second queued words/.test(chat), tail(chat))
  check(`${label}: no typed row wears a sent time while queued`, !/\d\d:\d\d:\d\d \[sam\] ❯ (first|second) queued words/.test(chat), tail(chat))
  check(`${label}: the roll counts one sent and two queued`, bench.includes('1 prompt since') && bench.includes('2 queued'), bench.split('\n').slice(0, 6).join('\n'))
  check(`${label}: the roll's rows read queued in the time column`, /queued\s+plain\s+first queued words/.test(bench) && /queued\s+plain\s+second queued words/.test(bench), bench.split('\n').slice(0, 10).join('\n'))
  check(`${label}: the roll's card says the words wait for the running turn`, bench.includes('waiting for the'), bench.split('\n').slice(0, 10).join('\n'))

  section(`${label} — Q3/Q4: the typed end at the budget, the queue drained on it`)
  check(`${label}: the receipt row names the silence and that the reply stands`, after.includes(`the ${label} stream went silent ${Math.round(BUDGET_MS / 1000)} s after its last item; the reply stands`), tail(after))
  check(`${label}: the strip is back at ready — no "may be stuck", no interrupt hint`, /· ready/.test(after) && !/may be stuck/.test(after) && !/esc interrupt/.test(after), tail(after))
  check(`${label}: no fault row, no recovery notice`, !/stream fault|Stream dropped|failed/i.test(after), tail(after))
  check(`${label}: the drained words paint as a sent row with a clock`, /\d\d:\d\d:\d\d \[sam\] ❯ first queued words/.test(after), tail(after))
  check(`${label}: no queued row survives the drain`, !/queued\s+\[sam\]/.test(after) && !/queued\s+\[sam\]/.test(fin), tail(fin))

  section(`${label} — Q5: the wire`)
  check(`${label}: exactly one hold`, holds.length === 1, JSON.stringify(holds))
  check(`${label}: the ask was issued once — never a reissue`, calls.filter(c => c.arm === 'hold-after-settle').length === 1 && !calls.some(c => /dropped mid-response|Pick up exactly/.test(c.ask ?? '')), JSON.stringify(calls.map(c => [c.n, c.arm, c.ask?.slice(0, 40)])))
  const held = holds[0]
  const drained = calls.find(c => (c.ask ?? '').includes(FIRST))
  check(`${label}: the second call carries both queued messages`, drained !== undefined && (drained.ask ?? '').includes(FIRST) && (drained.ask ?? '').includes(SECOND), drained?.ask)
  const gap = held !== undefined && drained !== undefined ? drained.at - held.at : -1
  check(`${label}: the drain came at the budget with no keystroke`, gap >= BUDGET_MS - 200 && gap <= BUDGET_MS + 6_000, `gap=${gap}ms budget=${BUDGET_MS}ms`)

  if (failures === 0) rmSync(RUN_HOME, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${RUN_HOME}`)
}

console.log('============================================================')
console.log(' the turn ends on facts · the queue tells the truth — the built bundle')
console.log('============================================================')
await driveWire('openai')
await driveWire('anthropic')
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
