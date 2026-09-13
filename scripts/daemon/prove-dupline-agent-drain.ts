#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { describeCapturePreflight, preflightCaptureDriver } from '../lib/capturePreflight.ts'

const REPO = join(import.meta.dir, '..', '..')
const distArg = process.argv.indexOf('--dist')
const DIST = distArg >= 0 && process.argv[distArg + 1] !== undefined ? process.argv[distArg + 1]! : join(REPO, 'dist', 'mercury.mjs')
const FIXTURE = join(import.meta.dir, 'dupline-fixture-server.ts')
const BUN = process.env.BUN ?? join(process.env.HOME ?? '', '.bun/bin/bun')
const VENDORED_NODE = join(DIST, '..', 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'bin', ...(process.platform === 'win32' ? [] : ['node']))
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : 'node'
const LINE = 'the line during the agent'
const AGENT_TURN_ASK = 'agent turn'
const PROBE_KEY = 'sk-ant-dupline-key'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

type Rec = { recordId?: string; creationOrdinal?: string; occurredAt?: string; threadId?: string; payload?: { kind?: string; attachmentType?: string; metaKind?: string; content?: unknown; fields?: Record<string, unknown> } }
type Carrier = { file: string; kind: string; recordId: string; occurredAt: string; sourceUuid: string; sentAt: string; thread: string }
function textOfRecord(r: Rec): string {
  const p = r.payload ?? {}
  if (p.kind === 'input') {
    const c = p.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map(b => String((b as { text?: string }).text ?? '')).join('\n')
    return ''
  }
  if (p.kind === 'attachment') return String((p.fields ?? {}).prompt ?? '')
  return ''
}
function transcriptFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    try {
      if (statSync(p).isDirectory()) out.push(...transcriptFiles(p))
      else if (name.endsWith('.jsonl')) out.push(p)
    } catch {
    }
  }
  return out
}
function carriersOf(projectsDir: string, line: string): Carrier[] {
  const out: Carrier[] = []
  for (const p of transcriptFiles(projectsDir)) {
    let text = ''
    try {
      text = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    for (const raw of text.split('\n')) {
      if (!raw.includes(line)) continue
      let r: Rec
      try {
        r = JSON.parse(raw) as Rec
      } catch {
        continue
      }
      if (!textOfRecord(r).includes(line)) continue
      const p2 = r.payload ?? {}
      const f = p2.fields ?? {}
      out.push({
        file: relative(projectsDir, p),
        kind: p2.kind === 'attachment' ? `attachment/${p2.attachmentType}` : String(p2.kind),
        recordId: String(r.recordId ?? ''),
        occurredAt: String(r.occurredAt ?? ''),
        sourceUuid: String(f.source_uuid ?? ''),
        sentAt: String(f.sentAt ?? ''),
        thread: String(r.threadId ?? ''),
      })
    }
  }
  return out
}
const inMainFile = (c: Carrier): boolean => !c.file.includes('subagents')
const briefly = (cs: Carrier[]): string => j(cs.map(c => `${c.file.replace(/^.*?\//, '')} ${c.kind} src=${c.sourceUuid.slice(0, 8)} at=${c.occurredAt}`))

function childEnv(runHome: string, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: runHome,
    MERCURY_DAEMON_DIR: join(runHome, 'daemon'),
    MERCURY_TEAMS_DIR: join(runHome, 'teams'),
    MERCURY_TABULA_DIR: join(runHome, 'tabula'),
    MERCURY_TABULA_MINERVA: '0',
    MERCURY_HOME: join(runHome, 'proof-home'),
    MERCURY_DOCTOR_STATE_DIR: join(runHome, 'doctor-state'),
    ANTHROPIC_API_KEY: PROBE_KEY,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    MERCURY_STREAM_IDLE_TIMEOUT_MS: '30000',
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_DECK_COMPANION: '0',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CONNECTOR_TRACE: join(runHome, 'connector-trace.jsonl'),
    BROWSER: '/usr/bin/true',
  }
  delete env.NODE_ENV
  delete env.ANTHROPIC_AUTH_TOKEN
  return env
}
function seedHome(runHome: string, cwd: string): void {
  rmSync(runHome, { recursive: true, force: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(
    join(runHome, '.mercury.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: 'dark',
      projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
    }),
  )
  writeFileSync(join(runHome, 'settings.json'), '{}')
  writeFileSync(join(cwd, 'README.md'), '# fixture\n')
}
type Wire = { kind: string; n: number; arm?: string; step?: number; at: number; counts?: Record<string, number> }
async function startFixture(captureFile: string, agentSleepSeconds: number): Promise<{ port: number; kill: () => void; wire: () => Wire[] }> {
  writeFileSync(captureFile, '')
  const fixture = spawn(BUN, ['run', FIXTURE, captureFile, String(agentSleepSeconds), '6'], { stdio: ['ignore', 'pipe', 'pipe'] })
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
  })
  const wire = (): Wire[] =>
    readFileSync(captureFile, 'utf8')
      .split('\n')
      .filter(l => l.trim() !== '')
      .map(l => JSON.parse(l) as Wire)
  return {
    port,
    wire,
    kill: () => {
      try {
        fixture.kill('SIGTERM')
      } catch {
      }
    },
  }
}
async function waitWire(wire: () => Wire[], label: string, test: (w: Wire) => boolean, timeoutMs: number): Promise<Wire | null> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const hit = wire().find(test)
    if (hit !== undefined) return hit
    await sleep(60)
  }
  console.log(`  [wait] ${label}: nothing on the wire within ${timeoutMs} ms`)
  return null
}

section('S the drain scope reads the agent id before the query source (the source)')
{
  const machine = readFileSync(join(REPO, 'src', 'run-core', 'turn-machine.ts'), 'utf8')
  check(
    "a query that runs under an agent id is never the main thread's drain, whatever its source label",
    machine.includes("currentAgentId === undefined &&\n      (querySource.startsWith('repl_main_thread') || querySource === 'sdk')"),
  )
}

if (!existsSync(DIST)) {
  console.log(`\nFAIL ${DIST} missing — run \`bun run build.ts\` first (both drives boot the BUILT product)`)
  failures++
} else {
  section("R the built runner, headless: the line sent while the model's sub-agent runs reaches the session's own model, once")
  const RUN_HOME = join(realpathSync(tmpdir()), `mercury-dupline-runner-${process.pid}`)
  const CWD = join(RUN_HOME, 'repo')
  seedHome(RUN_HOME, CWD)
  const fx = await startFixture(join(RUN_HOME, 'wire.jsonl'), 10)
  const runner = spawn(NODE, [DIST, '-p', '--input-format=stream-json', '--output-format=stream-json', '--model', 'claude-opus-4-8', '--permission-mode', 'bypassPermissions'], { cwd: CWD, env: childEnv(RUN_HOME, fx.port), stdio: ['pipe', 'pipe', 'pipe'] })
  const lines: Array<Record<string, unknown>> = []
  const waiters: Array<{ test: (f: Record<string, unknown>) => boolean; resolve: (f: Record<string, unknown>) => void }> = []
  let stdoutBuffer = ''
  let stderrText = ''
  runner.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8')
    let nl: number
    while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, nl)
      stdoutBuffer = stdoutBuffer.slice(nl + 1)
      if (line.trim() === '') continue
      try {
        const frame = JSON.parse(line) as Record<string, unknown>
        lines.push(frame)
        for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]!.test(frame)) waiters.splice(i, 1)[0]!.resolve(frame)
      } catch {
      }
    }
  })
  runner.stderr.on('data', (chunk: Buffer) => {
    stderrText += chunk.toString('utf8')
  })
  const exited = new Promise<number | null>(resolve => runner.on('exit', code => resolve(code)))
  function waitFor(label: string, test: (f: Record<string, unknown>) => boolean, timeoutMs: number, after = 0): Promise<Record<string, unknown> | null> {
    const seen = lines.slice(after).find(test)
    if (seen !== undefined) return Promise.resolve(seen)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        const at = waiters.findIndex(w => w.resolve === done)
        if (at >= 0) waiters.splice(at, 1)
        console.log(`  [wait] ${label}: nothing within ${timeoutMs} ms`)
        resolve(null)
      }, timeoutMs)
      const done = (f: Record<string, unknown>): void => {
        clearTimeout(timer)
        resolve(f)
      }
      waiters.push({ test, resolve: done })
    })
  }
  const send = (frame: Record<string, unknown>): void => {
    runner.stdin.write(`${JSON.stringify(frame)}\n`)
  }
  const user = (text: string, uuid: string, timestamp?: string): Record<string, unknown> => ({ type: 'user', message: { role: 'user', content: text }, uuid, session_id: '', ...(timestamp !== undefined ? { timestamp } : {}) })
  const isResult = (f: Record<string, unknown>): boolean => f.type === 'result'
  const isInit = (f: Record<string, unknown>): boolean => f.type === 'system' && f.subtype === 'init'
  const U0 = '00000000-0000-4000-8000-000000000000'
  const UT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const U1 = '11111111-1111-4111-8111-111111111111'

  send(user('hello there', U0))
  const init = await waitFor('the init frame', isInit, 40_000)
  const first = await waitFor('the first turn', isResult, 40_000)
  check('the runner is up and the first turn answered', init !== null && first !== null, stderrText.split('\n').slice(-5).join(' | '))
  const sessionId = String(init?.session_id ?? '')
  const beforeAgent = lines.length
  send(user(AGENT_TURN_ASK, UT))
  const mainOpen = await waitWire(fx.wire, "the main thread's opening request", w => w.kind === 'request' && w.arm === 'agent' && w.step === 0, 30_000)
  check("the session's model was asked and answered with the Agent tool", mainOpen !== null)
  const subOpen = await waitWire(fx.wire, "the sub-agent's first request", w => w.kind === 'request' && w.arm === 'subwork' && w.step === 0, 40_000)
  check("the sub-agent opened its own conversation (its tool runs for ten seconds)", subOpen !== null)
  const T1 = new Date().toISOString()
  send(user(LINE, U1, T1))
  const agentResult = await waitFor("the agent turn's result", isResult, 90_000, beforeAgent)
  check("the turn ended with the session's own final text", agentResult !== null && String(agentResult.result ?? '').startsWith(`done: ${AGENT_TURN_ASK}`), j(agentResult?.result))
  const requests = fx.wire().filter(w => w.kind === 'request')
  const subCarrying = requests.filter(w => w.arm === 'subwork' && (w.counts?.[LINE] ?? 0) > 0)
  const mainCarrying = requests.filter(w => w.arm === 'agent' && (w.counts?.[LINE] ?? 0) > 0)
  check("no request of the sub-agent's conversation carried the line", subCarrying.length === 0, j(subCarrying.map(w => [w.n, w.step])))
  check("the session's own next request after the Agent tool carried the line, once", mainCarrying.length >= 1 && mainCarrying[0]!.step === 1 && mainCarrying[0]!.counts?.[LINE] === 1, j(requests.map(w => [w.n, w.arm, w.step, w.counts?.[LINE]])))
  await sleep(500)
  const carriers = carriersOf(join(RUN_HOME, 'projects'), LINE)
  const mainRows = carriers.filter(c => inMainFile(c) && c.kind === 'attachment/queued_command')
  const agentRows = carriers.filter(c => !inMainFile(c))
  check("the session's transcript holds the line once, as the drained row under the send's identity and clock", mainRows.length === 1 && mainRows[0]!.sourceUuid === U1 && mainRows[0]!.occurredAt === T1 && mainRows[0]!.file.endsWith(`${sessionId}.jsonl`), briefly(carriers))
  check("no sub-agent's transcript holds the line", agentRows.length === 0, briefly(agentRows))
  try {
    runner.stdin.end()
  } catch {
  }
  await Promise.race([exited, sleep(8_000)])
  try {
    runner.kill('SIGKILL')
  } catch {
  }
  fx.kill()
  if (failures === 0) rmSync(RUN_HOME, { recursive: true, force: true })
  else console.log(`  [forensics] runner world kept: ${RUN_HOME}\n${stderrText.split('\n').slice(-12).join('\n')}`)

  section('C the whole product in a terminal: the row paints once, with the clock it was sent at, before and after the turn ends')
  const driver = resolveCaptureDriver()
  const preflight = driver.kind === 'unavailable' ? null : preflightCaptureDriver(driver, REPO)
  if (driver.kind === 'unavailable' || preflight === null || !preflight.ok) {
    console.log(`  [skip] no capture engine on this box — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : describeCapturePreflight(preflight!)}`)
  } else {
    const PTY_HOME = join(realpathSync(tmpdir()), `mercury-dupline-pty-${process.pid}`)
    const PTY_CWD = join(PTY_HOME, 'fixture-repo')
    seedHome(PTY_HOME, PTY_CWD)
    const pfx = await startFixture(join(PTY_HOME, 'wire.jsonl'), 25)
    const out = join(PTY_HOME, 'grid.json')
    const CTRL_O = '\x0f'
    const sends = [
      { atTick: 60, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { requireAwait: true, minTick: 10, awaitText: 'Type a prompt', awaitSettleTicks: 2, data: 'hello there\r' },
      { requireAwait: true, minTick: 5, awaitText: 'heard: hello there', awaitSettleTicks: 3, data: `${AGENT_TURN_ASK}\r`, mark: 'answered' },
      { afterPrevTicks: 40, data: `${LINE}\r`, mark: 'sent' },
      { afterPrevTicks: 5, data: '', mark: 'queued' },
      { requireAwait: true, minTick: 2, awaitText: `done: ${AGENT_TURN_ASK}`, awaitSettleTicks: 5, data: '', mark: 'end' },
      { afterPrevTicks: 50, data: CTRL_O, mark: 'end+10s' },
      { afterPrevTicks: 10, data: CTRL_O, mark: 'end+12s-view' },
      { afterPrevTicks: 10, data: '', mark: 'end+14s' },
      { afterPrevTicks: 80, data: '', mark: 'end+30s' },
    ]
    const cfg = { argv: [NODE, DIST, '--model', 'claude-opus-4-8'], cwd: PTY_CWD, sends, total: 1200, readyText: `done: ${AGENT_TURN_ASK}`, readySettleTicks: 3, cols: 120, rows: 40, out }
    const cfgPath = join(PTY_HOME, 'cfg.json')
    writeFileSync(cfgPath, JSON.stringify(cfg))
    const env = { ...childEnv(PTY_HOME, pfx.port), VSHOT_SLOTS: process.env.VSHOT_SLOTS ?? '3' }
    const stderr: string[] = []
    const status = await new Promise<number | null>(resolve => {
      const child = spawn(driver.python, [captureEngineEntry(driver, REPO), cfgPath], { cwd: PTY_CWD, env, stdio: ['ignore', 'ignore', 'pipe'] })
      const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(300_000))
      child.stderr?.on('data', c => stderr.push(String(c)))
      child.on('error', () => resolve(null))
      child.on('close', code => {
        clearTimeout(deadline)
        resolve(code)
      })
    })
    pfx.kill()
    check('the capture ran the whole journey', status === 0 && existsSync(out), `status=${status} ${stderr.join('').slice(-300)}`)
    type Grid = Array<Array<{ c?: string }>>
    const gridText = (grid: Grid): string => grid.map(row => row.map(c => c.c ?? ' ').join('').trimEnd()).join('\n')
    const marks: Record<string, string> = {}
    if (existsSync(out)) {
      const payload = JSON.parse(readFileSync(out, 'utf8')) as { marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
      for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
      check("the capture ended on the turn's own final text", payload.endReason === 'ready', String(payload.endReason))
    }
    const operatorRows = (frame: string | undefined): string[] => (frame ?? '').split('\n').filter(l => l.includes(`[sam] ❯ ${LINE}`)).map(l => l.replace(/\s+/g, ' ').trim())
    const clockOf = (row: string): string => (/(\d\d:\d\d:\d\d)\s+\[sam\]/.exec(row)?.[1] ?? row.split('[sam]')[0]!.replace(/[│\s]/g, ''))
    let sentAtMs: number | null = null
    try {
      const trace = readFileSync(join(PTY_HOME, 'connector-trace.jsonl'), 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as { t: number; ev: string; state?: string })
      const queuedSend = trace.filter(r => r.ev === 'send' && r.state === 'queued').pop()
      if (queuedSend !== undefined) sentAtMs = queuedSend.t
    } catch {
    }
    check('the connector recorded the send as queued under the running turn', sentAtMs !== null)
    const secondsOfDay = (hhmmss: string): number => {
      const m = /^(\d\d):(\d\d):(\d\d)$/.exec(hhmmss)
      return m === null ? Number.NaN : Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
    }
    const sendClock = sentAtMs === null ? '' : new Date(sentAtMs).toTimeString().slice(0, 8)
    const clockNear = (row: string): boolean => {
      const a = secondsOfDay(clockOf(row))
      const b = secondsOfDay(sendClock)
      return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 2
    }
    const queuedRows = operatorRows(marks.queued)
    check('while the sub-agent runs, the line paints once, as a queued row', queuedRows.length === 1 && /(^|[^A-Za-z])queued\s+\[sam\]/.test(queuedRows[0]!), j(queuedRows))
    for (const label of ['end', 'end+10s', 'end+14s', 'end+30s']) {
      const rows = operatorRows(marks[label])
      check(`at ${label}: exactly one row carries the line, stamped with the clock it was sent at (${sendClock})`, rows.length === 1 && clockNear(rows[0]!), j(rows))
    }
    const viewRows = operatorRows(marks['end+12s-view'])
    check('the detailed transcript view shows the line once, with the send clock', viewRows.length === 1 && clockNear(viewRows[0]!), j(viewRows))
    const ptyCarriers = carriersOf(join(PTY_HOME, 'projects'), LINE)
    const ptyMain = ptyCarriers.filter(c => inMainFile(c) && c.kind === 'attachment/queued_command')
    check("the session's transcript holds the drained row once, stamped at the send, and no sub-agent's transcript holds it", ptyMain.length === 1 && ptyCarriers.every(inMainFile) && sentAtMs !== null && Math.abs(Date.parse(ptyMain[0]!.occurredAt) - sentAtMs) <= 2_000, briefly(ptyCarriers))
    if (failures === 0) rmSync(PTY_HOME, { recursive: true, force: true })
    else {
      console.log(`  [forensics] terminal world kept: ${PTY_HOME}`)
      for (const label of ['queued', 'end', 'end+30s']) {
        console.log(`\n── ${label} ──`)
        for (const row of (marks[label] ?? '(no frame)').split('\n')) if (row.trim()) console.log(`│ ${row.slice(0, 150)}`)
      }
    }
  }
}

console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-dupline-agent-drain: ALL LAWS HOLD' : `prove-dupline-agent-drain: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
