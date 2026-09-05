#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { firstByteBudgetMs } from '../../src/services/providers/streamIdleBudget.ts'

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
const READ_ASK = 'read three files please'
const SLEEP_ASK = 'run the long sleep please'
const LAUNCH_ASK = 'launch one agent please'
const NOTICE_ASK = 'launch an errand and sleep please'
const NOTICE_ROW = '● Agent "a quick errand" completed'
const FIRST = 'first queued words'
const SECOND = 'second queued words'

type Wire = { kind: string; n?: number; ask?: string; arm?: string; order?: string[]; shape?: string; texts?: string[]; at: number }
type Mark = { label: string; atTick: number; grid: Array<Array<{ c: string }>> }
const gridText = (grid: Array<Array<{ c: string }>>): string =>
  grid.map(r => r.map(c => c.c || ' ').join('').replace(/\s+$/, '')).join('\n')

async function driveWire(route: 'openai' | 'anthropic', scene: 'hold' | 'tool' | 'stop' | 'crew' | 'notice' = 'hold'): Promise<void> {
  const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-turnend-${route}-${scene}-${process.pid}`)
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
  for (const name of ['a', 'b', 'c']) writeFileSync(path.join(FIXTURE_CWD, `${name}.md`), `# ${name}\nthe ${name} file body\n`)

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

  const model = route === 'openai' ? 'gpt-5.6-sol' : 'claude-opus-4-8'
  const out = path.join(RUN_HOME, 'grid.json')
  const holdSends = [
      { atTick: 60, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { requireAwait: true, minTick: 10, awaitText: '? for shortcuts', awaitSettleTicks: 2, data: `${ASK}\r` },
      { requireAwait: true, minTick: 10, awaitText: 'after its last item', awaitSettleTicks: 6, data: `${FIRST}\r` },
      { afterPrevTicks: 10, data: `${SECOND}\r` },
      { afterPrevTicks: 12, data: '/workbench\r', mark: 'chat-queued' },
      { requireAwait: true, minTick: 5, awaitText: 'PROMPTS (', awaitSettleTicks: 6, data: '\x1b', mark: 'workbench' },
      { afterPrevTicks: 5 + Math.ceil(BUDGET_MS / 200) + 40, data: '', mark: 'after-budget' },
  ]
  const toolSends = [
      { atTick: 60, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { requireAwait: true, minTick: 10, awaitText: '? for shortcuts', awaitSettleTicks: 2, data: `${READ_ASK}\r` },
      { requireAwait: true, minTick: 10, awaitText: 'Read', awaitSettleTicks: 3, data: `${FIRST}\r` },
      { afterPrevTicks: 8, data: '/workbench\r', mark: 'chat-queued' },
      { requireAwait: true, minTick: 5, awaitText: 'PROMPTS (', awaitSettleTicks: 4, data: '\x1b', mark: 'workbench' },
      { requireAwait: true, minTick: 5, awaitText: 'after its last item', awaitSettleTicks: 10, data: '/workbench\r', mark: 'after-turn' },
      { requireAwait: true, minTick: 5, awaitText: 'PROMPTS (', awaitSettleTicks: 4, data: '\x1b', mark: 'workbench-after' },
      { afterPrevTicks: 10, data: '', mark: 'settled' },
  ]
  const stopSends = [
      { atTick: 60, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { requireAwait: true, minTick: 10, awaitText: '? for shortcuts', awaitSettleTicks: 2, data: `${SLEEP_ASK}\r` },
      { requireAwait: true, minTick: 10, awaitText: 'the long sleep', awaitSettleTicks: 6, data: '\x1b', mark: 'tool-running' },
      { afterPrevTicks: 8, data: '\x1b', mark: 'after-first-esc' },
      { afterPrevTicks: 15, data: `${FIRST}\r`, mark: 'after-second-esc' },
      { afterPrevTicks: 40, data: '/workbench\r', mark: 'after-words' },
      { requireAwait: true, minTick: 5, awaitText: 'PROMPTS (', awaitSettleTicks: 4, data: '\x1b', mark: 'workbench-stop' },
      { afterPrevTicks: 10, data: '', mark: 'settled' },
  ]
  const crewSends = [
      { atTick: 60, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { requireAwait: true, minTick: 10, awaitText: '? for shortcuts', awaitSettleTicks: 2, data: `${LAUNCH_ASK}\r` },
      { requireAwait: true, minTick: 10, awaitText: 'first-byte-seat', awaitSettleTicks: 15, data: '', mark: 'seat-waiting' },
      { requireAwait: true, minTick: 5, awaitText: 'after its last item', awaitSettleTicks: 8, data: '', mark: 'after-seat' },
      { afterPrevTicks: 10, data: '', mark: 'settled' },
  ]
  const noticeSends = [
      { atTick: 60, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { requireAwait: true, minTick: 10, awaitText: '? for shortcuts', awaitSettleTicks: 2, data: `${NOTICE_ASK}\r` },
      { requireAwait: true, minTick: 10, awaitText: 'sleep 12', awaitSettleTicks: 15, data: `${FIRST}\r`, mark: 'notice-queued' },
      { afterPrevTicks: 8, data: '', mark: 'both-queued' },
      { requireAwait: true, minTick: 5, awaitText: 'after its last item', awaitSettleTicks: 8, data: '', mark: 'drained' },
  ]
  const cfg = {
    argv: ['node', DIST, '--model', model],
    cwd: FIXTURE_CWD,
    sends: scene === 'hold' ? holdSends : scene === 'tool' ? toolSends : scene === 'stop' ? stopSends : scene === 'crew' ? crewSends : noticeSends,
    total: scene === 'crew' ? 1100 : 400,
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
    MERCURY_CONNECTOR_TRACE: path.join(RUN_HOME, 'connector-trace.jsonl'),
  }
  delete childEnv.NODE_ENV
  delete childEnv.ANTHROPIC_AUTH_TOKEN

  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(scene === 'crew' ? 260_000 : 150_000),
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

  if (scene === 'crew') {
    const waiting = marks.get('seat-waiting') ?? ''
    const afterSeat = marks.get('after-seat') ?? ''
    const settled = marks.get('settled') ?? fin
    const heldHeaders = wire.filter(c => c.kind === 'held-headers')
    const parent = calls.filter(c => c.arm === 'launch-agent')
    section(`${label} — S2: a crew seat whose request never answers its headers ends typed within the budget`)
    check(`${label}: vshot ran the crew journey as written`, res.status === 0, `status=${res.status} ${(res.stderr ?? '').split('\n').slice(-3).join(' | ')}`)
    check(`${label}: the seat's request was parked with no headers (once, then at most the bounded retry)`, heldHeaders.length >= 1 && heldHeaders.length <= 2, JSON.stringify(heldHeaders))
    check(`${label}: while parked, the agent's row stood on the card as running (its own wait word is the card owner's — see the receipt)`, /first-byte-seat/.test(waiting) && /running a tool/.test(waiting), tail(waiting))
    check(`${label}: the parent's follow-up carried the seat's typed end and landed the final text`, parent.some(c => ((c as { step?: number }).step ?? 0) >= 1) && afterSeat.includes(REPLY), JSON.stringify(parent.map(c => [c.n, (c as { step?: number }).step])))
    const seatCalls = calls.filter(c => c.arm === 'seat-hold')
    const seatTokens = (seatCalls[0] as { promptTokens?: number } | undefined)?.promptTokens ?? 0
    const seatBudget = firstByteBudgetMs({ cold: true, promptTokens: seatTokens, idleMs: BUDGET_MS })
    const retryGap = heldHeaders.length >= 2 ? heldHeaders[1]!.at - heldHeaders[0]!.at : -1
    check(`${label}: the bounded retry re-parked at the owner's budget for the seat's own prompt`, retryGap >= seatBudget - 500 && retryGap <= seatBudget + 6_000, `retry gap=${retryGap}ms budget=${seatBudget}ms tokens=${seatTokens}`)
    const gap = heldHeaders.length > 0 && parent.length > 1 ? (parent[parent.length - 1]!.at - heldHeaders[0]!.at) : -1
    check(`${label}: the seat ended inside two budgets — never the fifty-minute ceiling`, gap > 0 && gap <= 2 * seatBudget + 15_000, `gap=${gap}ms budget=${seatBudget}ms`)
    check(`${label}: the turn is freed — the strip is back at ready`, /· ready/.test(settled) && !/esc interrupt/.test(settled), tail(settled))
    const files = readdirSync(path.join(RUN_HOME, 'projects'), { recursive: true }) as string[]
    const rows = files.filter(f => f.endsWith('.jsonl')).flatMap(f => readFileSync(path.join(RUN_HOME, 'projects', f), 'utf8').split('\n'))
    check(`${label}: the typed line reached the record ("no first byte from … after N s")`, rows.some(l => /no first byte from/.test(l)), `rows=${rows.length}`)
    if (failures === 0) rmSync(RUN_HOME, { recursive: true, force: true })
    else console.log(`[forensics] world kept: ${RUN_HOME}`)
    return
  }

  if (scene === 'notice') {
    try {
      const trace = readFileSync(path.join(RUN_HOME, 'connector-trace.jsonl'), 'utf8')
        .split('\n')
        .filter(l => l.trim() !== '')
        .map(l => JSON.parse(l) as Record<string, unknown>)
        .filter(e => ['notice', 'send', 'send-landed', 'facts'].includes(String(e.ev)))
      const t0 = trace.length > 0 ? Number(trace[0]!.t) : 0
      console.log('── the seat\'s timeline (connector trace) ──')
      for (const e of trace) {
        const { t, sid: _sid, ev, ...rest } = e
        console.log(`  +${String(Number(t) - t0).padStart(6)}ms ${String(ev).padEnd(12)} ${JSON.stringify(rest)}`)
      }
    } catch {
    }
    console.log('── the wire ──')
    for (const c of calls) console.log(`  #${c.n} ${c.arm} step=${(c as { step?: number }).step ?? '-'} shape=${c.shape ?? ''} order=${JSON.stringify(c.order ?? [])} texts=${JSON.stringify(c.texts ?? [])}`)
    const arrived = marks.get('notice-queued') ?? ''
    const both = marks.get('both-queued') ?? ''
    const drained = marks.get('drained') ?? fin
    const lineOf = (frame: string, re: RegExp): number => frame.split('\n').findIndex(l => re.test(l))
    const queuedNotice = new RegExp(`queued\\s+${NOTICE_ROW.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    const sentNotice = new RegExp(`\\d\\d:\\d\\d:\\d\\d ${NOTICE_ROW.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    const queuedWords = /queued\s+\[sam\] ❯ first queued words/
    const sentWords = /\d\d:\d\d:\d\d \[sam\] ❯ first queued words/
    section(`${label} — N1/N2: the crew notice paints queued when it arrives, above the words typed after it`)
    check(`${label}: vshot ran the notice journey as written`, res.status === 0, `status=${res.status} ${(res.stderr ?? '').split('\n').slice(-3).join(' | ')}`)
    check(`${label}: the errand's notice painted QUEUED before the operator typed`, queuedNotice.test(arrived) && !/first queued words/.test(arrived), tail(arrived))
    check(`${label}: the typed words paint QUEUED below the notice`, queuedNotice.test(both) && queuedWords.test(both) && lineOf(both, queuedNotice) < lineOf(both, queuedWords), tail(both))
    section(`${label} — N3/N4: the drain moves nothing`)
    check(`${label}: after the drain both rows wear clocks, the notice still above the words`, sentNotice.test(drained) && sentWords.test(drained) && lineOf(drained, sentNotice) < lineOf(drained, sentWords), tail(drained))
    check(`${label}: no queued row survives the drain`, !/queued\s+(●|\[sam\])/.test(drained), tail(drained))
    check(`${label}: the reply landed and the strip is back at ready`, drained.includes(REPLY) && /· ready/.test(drained), tail(drained))
    const folded = calls.find(c => c.arm === 'launch-and-sleep' && (c as { step?: number }).step === 2)
    check(`${label}: the request after the sleep carries the notification BEFORE the words`, folded !== undefined && JSON.stringify(folded.order) === JSON.stringify(['A background agent completed a task:', 'first queued words']), JSON.stringify(calls.map(c => [c.n, c.arm, (c as { step?: number }).step, c.order])))
    const files = readdirSync(path.join(RUN_HOME, 'projects'), { recursive: true }) as string[]
    const rows = files.filter(f => f.endsWith('.jsonl')).flatMap(f => readFileSync(path.join(RUN_HOME, 'projects', f), 'utf8').split('\n').filter(l => l.trim() !== ''))
    const noticeAt = rows.findIndex(l => l.includes('"queued_command"') && l.includes('task-notification') && l.includes('a quick errand'))
    const wordsAt = rows.findIndex(l => l.includes('"queued_command"') && l.includes(FIRST))
    check(`${label}: the transcript file holds the notice's drained row before the words' row`, noticeAt >= 0 && wordsAt > noticeAt, `notice=${noticeAt} words=${wordsAt} rows=${rows.length}`)
    if (failures === 0) rmSync(RUN_HOME, { recursive: true, force: true })
    else console.log(`[forensics] world kept: ${RUN_HOME}`)
    return
  }

  if (scene === 'stop') {
    const running = marks.get('tool-running') ?? ''
    const firstEsc = marks.get('after-first-esc') ?? ''
    const secondEsc = marks.get('after-second-esc') ?? ''
    const afterWords = marks.get('after-words') ?? ''
    const benchStop = marks.get('workbench-stop') ?? ''
    const settled = marks.get('settled') ?? fin
    const sleepers = (): string => spawnSync('/usr/bin/pgrep', ['-f', `sleep ${'40'}`], { encoding: 'utf8' }).stdout.trim()
    section(`${label} — S1: a forced stop stops the tool, ends the turn typed, and the queue drains`)
    check(`${label}: vshot ran the stop journey as written`, res.status === 0, `status=${res.status} ${(res.stderr ?? '').split('\n').slice(-3).join(' | ')}`)
    check(`${label}: the Bash tool was running its long sleep when esc landed`, /the long sleep/.test(running) && /esc interrupt/.test(running), tail(running))
    check(`${label}: after the second esc the strip is back at ready (the turn ended within the grace)`, /· ready/.test(secondEsc) || /· ready/.test(afterWords), tail(secondEsc))
    check(`${label}: the turn's end is typed — the receipt names the ended tool`, /the interrupt ended Bash — the turn is over/.test(firstEsc) || /the interrupt ended Bash — the turn is over/.test(secondEsc), tail(secondEsc))
    check(`${label}: the sleeping child is dead after the stop`, sleepers() === '', `alive: ${sleepers()}`)
    check(`${label}: the words typed after the stop ran as their own turn (the queue drained on the end)`, /\d\d:\d\d:\d\d \[sam\] ❯ first queued words/.test(afterWords) && afterWords.includes(REPLY), tail(afterWords))
    check(`${label}: no background task re-opened the turn (the strip stays ready)`, /· ready/.test(settled) && !/esc interrupt/.test(settled), tail(settled))
    const stepCalls = calls.filter(c => c.arm === 'sleep-tool')
    check(`${label}: no call followed the stop until the operator's own words (the stopped tool's result fed nothing by itself)`, stepCalls.every(c => ((c as { step?: number }).step ?? 0) === 0 || ((c as { carries?: string[] }).carries ?? []).includes(FIRST)), JSON.stringify(stepCalls.map(c => [c.n, (c as { step?: number }).step, (c as { carries?: string[] }).carries])))
    check(`${label}: the roll lists the words typed after the stop as sent`, benchStop.includes('2 prompts since') && /\d\d:\d\d\s+plain\s+first queued words/.test(benchStop), benchStop.split('\n').slice(0, 8).join('\n'))
    if (failures === 0) rmSync(RUN_HOME, { recursive: true, force: true })
    else console.log(`[forensics] world kept: ${RUN_HOME}`)
    return
  }

  if (scene === 'tool') {
    const afterTurn = marks.get('after-turn') ?? ''
    const benchAfter = marks.get('workbench-after') ?? ''
    const settled = marks.get('settled') ?? fin
    section(`${label} — Q6: a message typed during a Read says QUEUED, on screen and in the roll`)
    check(`${label}: vshot ran the tool journey as written`, res.status === 0, `status=${res.status} ${(res.stderr ?? '').split('\n').slice(-3).join(' | ')}`)
    check(`${label}: the typed row paints QUEUED while the turn runs`, /queued\s+\[sam\] ❯ first queued words/.test(chat) && /esc interrupt/.test(chat), tail(chat))
    check(`${label}: the roll counts it queued`, bench.includes('1 queued') && /queued\s+plain\s+first queued words/.test(bench), bench.split('\n').slice(0, 8).join('\n'))
    section(`${label} — Q7: the model sees it at the next tool boundary`)
    const steps = calls.filter(c => c.arm === 'read-three')
    const firstCarry = steps.find(c => Array.isArray((c as { carries?: string[] }).carries) && (c as { carries: string[] }).carries.includes(FIRST))
    check(`${label}: four calls make the tool turn (three reads, the final text)`, steps.length === 4, JSON.stringify(steps.map(c => [c.n, (c as { step?: number }).step, (c as { carries?: string[] }).carries])))
    check(`${label}: the words ride the request after the held read's result (step 2), never the turn's end`, firstCarry !== undefined && (firstCarry as { step?: number }).step === 2, JSON.stringify(steps.map(c => [c.n, (c as { step?: number }).step, (c as { carries?: string[] }).carries])))
    check(`${label}: every later request carries them too (they are in the conversation)`, steps.filter(c => ((c as { step?: number }).step ?? 0) >= 2).every(c => ((c as { carries?: string[] }).carries ?? []).includes(FIRST)), JSON.stringify(steps.map(c => [c.n, (c as { step?: number }).step, (c as { carries?: string[] }).carries])))
    section(`${label} — Q8: one transcript — the drained row, the roll, the file`)
    check(`${label}: the drained words paint as a sent row with a clock`, /\d\d:\d\d:\d\d \[sam\] ❯ first queued words/.test(afterTurn) || /\d\d:\d\d:\d\d \[sam\] ❯ first queued words/.test(settled), tail(afterTurn))
    check(`${label}: no queued row survives the drain`, !/queued\s+\[sam\]/.test(settled), tail(settled))
    check(`${label}: the roll lists the drained prompt as sent (2 prompts, none queued)`, benchAfter.includes('2 prompts since') && !/\bqueued\s+plain\b/.test(benchAfter) && !benchAfter.includes(' queued\n') && /\d\d:\d\d\s+plain\s+first queued words/.test(benchAfter), benchAfter.split('\n').slice(0, 8).join('\n'))
    check(`${label}: the reply settled and the strip is back at ready`, settled.includes(REPLY) && /· ready/.test(settled), tail(settled))
    const files = readdirSync(path.join(RUN_HOME, 'projects'), { recursive: true }) as string[]
    const jsonl = files.filter(f => f.endsWith('.jsonl')).map(f => path.join(RUN_HOME, 'projects', f))
    const rows = jsonl.flatMap(f => readFileSync(f, 'utf8').split('\n').filter(l => l.trim() !== ''))
    const drainedRow = rows.find(l => l.includes('"queued_command"') && l.includes(FIRST))
    check(`${label}: the transcript file holds the drained words as a queued_command row`, drainedRow !== undefined, `rows=${rows.length} files=${jsonl.length}`)
    if (failures === 0) rmSync(RUN_HOME, { recursive: true, force: true })
    else console.log(`[forensics] world kept: ${RUN_HOME}`)
    return
  }

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
const only = (process.env.TURN_END_SCENES ?? '').split(',').map(s => s.trim()).filter(s => s !== '')
const wants = (scene: string): boolean => only.length === 0 || only.includes(scene)
if (wants('hold')) {
  await driveWire('openai')
  await driveWire('anthropic')
}
if (wants('tool')) {
  await driveWire('anthropic', 'tool')
  await driveWire('openai', 'tool')
}
if (wants('stop')) await driveWire('anthropic', 'stop')
if (wants('crew')) await driveWire('openai', 'crew')
if (wants('notice')) await driveWire('anthropic', 'notice')
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
