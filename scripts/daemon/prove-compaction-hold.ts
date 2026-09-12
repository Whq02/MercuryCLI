#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const REPO = join(import.meta.dir, '..', '..')
const SRC = join(REPO, 'src')
const DIST = join(REPO, 'dist', 'mercury.mjs')
const FIXTURE = join(import.meta.dir, 'compaction-hold-fixture-server.ts')
const BUN = process.env.BUN ?? join(process.env.HOME ?? '', '.bun/bin/bun')

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

const SCRATCH = mkdtempSync(join(tmpdir(), 'compaction-hold-face-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const connectorModule = await import(join(SRC, 'services/engine-connector/daemonConnector.ts'))
const { DaemonSessionConnector, RECALL_UNKNOWN_LINE } = connectorModule
const lostLine = (words: string): string => (typeof connectorModule.lostLine === 'function' ? connectorModule.lostLine(words) : '(no lost-line road)')
const lostWithRunnerLine = (lines: string[]): string => (typeof connectorModule.lostWithRunnerLine === 'function' ? connectorModule.lostWithRunnerLine(lines) : '(no lost-line road)')
const { createUserMessage } = await import(join(SRC, 'utils/messages/factories.ts'))

type Reply = Record<string, unknown>
type Send = { clientMessageId: string; text: string; sentAtMs: number; state: 'pending' | 'delivered' | 'queued' | 'taken'; heldFor?: 'compaction'; mode: 'prompt' | 'bash'; source?: { text: string; mode: 'prompt' | 'bash'; pastedContents: Record<number, unknown> }; withdrawing?: true }
type Guts = {
  sends: Send[]
  echoRows: Map<string, unknown>
  rpc: (req: Reply) => Promise<Reply>
  reconcileQueuedSends: (facts: Record<string, unknown>) => void
  setLiveStateWord: (word: 'compacting' | null) => void
  factsBusy: boolean
  paint: () => void
}
const connector = new DaemonSessionConnector({ sessionId: 'compaction-hold-proof', runnerId: 'runner-1', title: 'compaction hold', projectLabel: 'proof', workspaceId: 'ws', home: SCRATCH, modelKey: 'claude-sonnet-5' })
const g = connector as unknown as Guts
const lostLineOf = (): { text: string; atMs: number } | null | undefined => (typeof connector.lostLine === 'function' ? connector.lostLine() : undefined)
let answer: (req: Reply) => Promise<Reply> = async () => ({ ok: true, op: 'sessionControl', outcome: 'applied' })
const rpcLog: Reply[] = []
g.rpc = async req => {
  rpcLog.push(req)
  return answer(req)
}
let liveWakes = 0
connector.subscribeLive(() => liveWakes++)
const seed = (id: string, text: string, state: Send['state']): void => {
  g.sends = [...g.sends, { clientMessageId: id, text, sentAtMs: Date.now(), state, mode: 'prompt', source: { text, mode: 'prompt', pastedContents: {} } }]
  g.echoRows.set(id, { ...(createUserMessage({ content: text }) as object), ...(state === 'queued' ? { queued: true } : {}) })
  g.paint()
}
const sendOf = (id: string): Send | undefined => g.sends.find(s => s.clientMessageId === id)
const painted = (): string => JSON.stringify(connector.records())
const queued = (entries: Array<{ uuid: string; value: string }>): Array<{ uuid: string; value: string; mode: string; priority: string }> =>
  entries.map(e => ({ ...e, mode: 'prompt', priority: 'next' }))
const foldRunning = (on: boolean): void => {
  g.factsBusy = on
  g.setLiveStateWord(on ? 'compacting' : null)
}

section("F1 the withdraw's UNKNOWN retires the row and names the words")
{
  const id = randomUUID()
  seed(id, 'the words no runner holds', 'delivered')
  foldRunning(true)
  g.reconcileQueuedSends({ queue: queued([{ uuid: id, value: 'the words no runner holds' }]), atMs: Date.now(), busy: true })
  check('the row stands queued and held while the runner says its queue holds it', sendOf(id)?.state === 'queued' && sendOf(id)?.heldFor === 'compaction' && painted().includes('the words no runner holds'), j(sendOf(id)))
  answer = async () => ({ ok: true, op: 'sessionControl', outcome: 'refused', withdrawn: false, reason: 'unknown', detail: "the runner's queue never held the line" })
  liveWakes = 0
  const receipt = await connector.withdrawSend(id)
  check("the receipt is the runner's unknown, marked retired, naming the words", receipt.withdrawn === false && receipt.reason === 'unknown' && receipt.retired === true && receipt.detail === lostLine('the words no runner holds') && receipt.detail.includes('“the words no runner holds”'), j(receipt))
  check('the send and its row left the screen — no orphan stands', sendOf(id) === undefined && !painted().includes('the words no runner holds'), painted().slice(0, 160))
  check('the live listeners woke', liveWakes >= 1, `${liveWakes} wakes`)
  const again = await connector.withdrawSend(id)
  check('a second withdraw finds nothing sent — the plain no-queue line, no retired mark', again.withdrawn === false && again.reason === 'unknown' && again.detail === RECALL_UNKNOWN_LINE && again.retired === undefined, j(again))
  check('a long line is quoted cut, one line — short enough for the hint row beside the shortcuts', lostLine('a'.repeat(80)).includes('…”') && lostLine('a'.repeat(80)).length <= 80, lostLine('a'.repeat(80)))
  foldRunning(false)
}

section("F2 the runner's life count: the same runner takes, a new runner loses")
{
  const same = randomUUID()
  seed(same, 'taken by the same runner', 'delivered')
  g.reconcileQueuedSends({ queue: queued([{ uuid: same, value: 'taken by the same runner' }]), atMs: Date.now(), busy: true, runnerGeneration: 1 })
  check('the first count latches and the listed send reads queued', sendOf(same)?.state === 'queued', j(sendOf(same)))
  g.reconcileQueuedSends({ queue: [], atMs: Date.now(), busy: true, runnerGeneration: 1 })
  check('the SAME runner no longer listing it dresses it taken (the landing law) — the row stays as a sent row', sendOf(same)?.state === 'taken' && painted().includes('taken by the same runner'), j(sendOf(same)))
  check('no lost line is announced for a take', lostLineOf() === null)
  g.sends = g.sends.filter(s => s.clientMessageId !== same)
  g.echoRows.delete(same)

  const one = randomUUID()
  const two = randomUUID()
  seed(one, 'first held words', 'delivered')
  seed(two, 'second held words [Pasted text #1 +3 lines]', 'delivered')
  foldRunning(true)
  g.reconcileQueuedSends({ queue: queued([{ uuid: one, value: 'first held words' }, { uuid: two, value: 'second held words the pasted lines' }]), atMs: Date.now(), busy: true, runnerGeneration: 1 })
  check('two held rows stand while the runner holds both', sendOf(one)?.heldFor === 'compaction' && sendOf(two)?.heldFor === 'compaction', j(g.sends.map(s => [s.state, s.heldFor])))
  liveWakes = 0
  g.reconcileQueuedSends({ queue: [], atMs: Date.now(), busy: false, runnerGeneration: 2 })
  check('a NEW runner (the count moved) with an empty queue retires both held sends', sendOf(one) === undefined && sendOf(two) === undefined, j(g.sends.map(s => [s.text, s.state])))
  check('…and their rows are gone from the transcript', !painted().includes('first held words') && !painted().includes('second held words'), painted().slice(0, 160))
  const lost = lostLineOf()
  check("lostLine() names both, the composer's own words (pastes unexpanded, cut past thirty-two characters), on the restart line", lost !== null && lost !== undefined && lost.text === lostWithRunnerLine(['first held words', 'second held words [Pasted text #1 +3 lines]']) && lost.text.includes('the runner restarted') && lost.text.includes('“first held words” · “second held words [Pasted text…”') && lost.text.endsWith('not taken; type them again'), j(lost))
  check('the live listeners woke for the notice', liveWakes >= 1, `${liveWakes} wakes`)
  check('one lost line reads singular', lostWithRunnerLine(['only one']).endsWith('not taken; type it again') && lostWithRunnerLine(['only one']).includes('“only one”'), lostWithRunnerLine(['only one']))
  foldRunning(false)
}

section('F3 the count never over-reaches')
{
  const older = randomUUID()
  seed(older, 'a line under an older daemon', 'delivered')
  g.reconcileQueuedSends({ queue: queued([{ uuid: older, value: 'a line under an older daemon' }]), atMs: Date.now(), busy: true })
  const before = lostLineOf()
  g.reconcileQueuedSends({ queue: [], atMs: Date.now(), busy: true })
  check('facts with no count: an empty queue dresses taken as before, nothing retired', sendOf(older)?.state === 'taken' && lostLineOf() === before, j(sendOf(older)))
  g.sends = g.sends.filter(s => s.clientMessageId !== older)
  g.echoRows.delete(older)

  const kept = randomUUID()
  seed(kept, 'a withdraw on its way', 'queued')
  g.sends = g.sends.map(s => (s.clientMessageId === kept ? { ...s, withdrawing: true as const } : s))
  const notice = 'notice:' + randomUUID()
  g.sends = [...g.sends, { clientMessageId: notice, text: 'A background agent completed a task', sentAtMs: Date.now(), state: 'queued', mode: 'prompt' }]
  const beforeCount = lostLineOf()
  g.reconcileQueuedSends({ queue: [], atMs: Date.now(), busy: false, runnerGeneration: 3 })
  check('a moved count leaves a send whose withdraw is on its way, and a crew notice, untouched', sendOf(kept)?.state === 'queued' && sendOf(notice) !== undefined && lostLineOf() === beforeCount, j(g.sends.map(s => [s.text, s.state, s.withdrawing])))
  g.sends = []
  g.echoRows.clear()
  g.paint()
}

section('F4 the wiring — the seat, the roster, the daemon, the hint row, the composer')
{
  const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')
  const seat = read('daemon/sessionSeat.ts')
  check('the seat bumps its runner life on every spawn hook and publishes it on the facts', seat.includes('seat.generation += 1') && seat.includes('runnerGeneration: seat.generation'))
  const roster = read('daemon/roster.ts')
  check('the roster fires the relaunch hook after the first life, once the child is wired', roster.includes('onChildRelaunched?: (short: string, pid: number) => void') && /ll\.spawnGeneration > 1 && this\.opts\.onChildRelaunched/.test(roster))
  const main = read('daemon/main.ts')
  check('the daemon routes a session runner relaunch to the seat spawn hook', /onChildRelaunched: short => \{\s*if \(!short\.startsWith\('concourse-w'\) \|\| roster === null\) return\s*onSeatSpawned\(short, roster\)/.test(main))
  const projections = read('services/engine-connector/seatProjections.ts')
  check('the facts carry the count as an optional field (the mixed-version law)', projections.includes('runnerGeneration?: number'))
  const repl = read('screens/REPL.tsx')
  check('the hint row paints lostLine once per clock on the live channel', repl.includes("key: 'lost-line'") && repl.includes('lost.atMs <= lostLinePaintedAtRef.current') && repl.includes('focusedConnector.subscribeLive(paintLostLine)'))
  const composer = read('components/PromptInput/PromptInput.tsx')
  check("the composer's lost-line notice outlives the plain refusal", composer.includes("addNotification({ key: 'recall-send', text: receipt.detail") && composer.includes('receipt.retired === true ? LOST_LINE_NOTICE_MS : 4000'))
  const live = read('services/engine-connector/seatLive.ts')
  check('the live extension names the lost line', live.includes('lostLine?(): LostLineV1 | null'))
  const normalize = read('utils/messages/normalize.ts')
  check('the normalizer carries the held dress beside the queued one onto the row the plate reads', normalize.includes("...(message.queued === true ? { queued: true as const } : {})") && normalize.includes("...(message.heldFor === 'compaction' ? { heldFor: 'compaction' as const } : {})"))
  const rowMemo = read('components/Message.tsx')
  check('the row repaints when the held dress moves, as it does for the queued one', rowMemo.includes("(prev.message as { heldFor?: 'compaction' }).heldFor !== (next.message as { heldFor?: 'compaction' }).heldFor) return false"))
}

rmSync(SCRATCH, { recursive: true, force: true })

if (!existsSync(DIST)) {
  console.log('\nFAIL dist/mercury.mjs missing — run `bun run build.ts` first (the runner half drives the BUILT runner)')
  failures++
} else {
  const RUN_HOME = join(realpathSync(tmpdir()), `mercury-compaction-hold-${process.pid}`)
  const CWD = join(RUN_HOME, 'repo')
  rmSync(RUN_HOME, { recursive: true, force: true })
  mkdirSync(CWD, { recursive: true })
  const PROBE_KEY = 'sk-ant-compaction-hold-key'
  writeFileSync(
    join(RUN_HOME, '.mercury.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: 'dark',
      projects: { [CWD]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
    }),
  )
  writeFileSync(join(RUN_HOME, 'settings.json'), '{}')
  const captureFile = join(RUN_HOME, 'wire.jsonl')
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: RUN_HOME,
    MERCURY_DAEMON_DIR: join(RUN_HOME, 'daemon'),
    MERCURY_TEAMS_DIR: join(RUN_HOME, 'teams'),
    MERCURY_TABULA_DIR: join(RUN_HOME, 'tabula'),
    MERCURY_HOME: join(RUN_HOME, 'proof-home'),
    ANTHROPIC_API_KEY: PROBE_KEY,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
  }
  delete env.NODE_ENV
  delete env.ANTHROPIC_AUTH_TOKEN
  const runner = spawn('node', [DIST, '-p', '--input-format=stream-json', '--output-format=stream-json', '--model', 'claude-opus-4-8', '--permission-mode', 'bypassPermissions'], { cwd: CWD, env, stdio: ['pipe', 'pipe', 'pipe'] })
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
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i]!.test(frame)) waiters.splice(i, 1)[0]!.resolve(frame)
        }
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
  const user = (text: string, uuid: string): Record<string, unknown> => ({ type: 'user', message: { role: 'user', content: text }, uuid, session_id: '' })
  const control = (requestId: string, request: Record<string, unknown>): Record<string, unknown> => ({ type: 'control_request', request_id: requestId, request })
  const responseOf = (f: Record<string, unknown> | null): Record<string, unknown> => {
    const r = f?.response as { subtype?: string; response?: Record<string, unknown>; error?: string } | undefined
    return r?.response ?? (r?.error !== undefined ? { error: r.error } : {})
  }
  const isControlResponse = (id: string) => (f: Record<string, unknown>): boolean => f.type === 'control_response' && (f.response as { request_id?: string } | undefined)?.request_id === id
  const isResult = (f: Record<string, unknown>): boolean => f.type === 'result'
  const isCompactingStatus = (f: Record<string, unknown>): boolean =>
    f.type === 'system' && f.subtype === 'status' && (f.status === 'compacting' || (f.status !== null && typeof f.status === 'object' && 'compacting' in (f.status as object)))
  const isTurnStarted = (f: Record<string, unknown>): boolean => f.type === 'system' && f.subtype === 'turn_started'
  const queueOf = async (id: string): Promise<Array<{ uuid?: string; value?: string }>> => {
    send(control(id, { subtype: 'session_facts' }))
    const f = responseOf(await waitFor(id, isControlResponse(id), 5_000))
    return ((f as { queue?: Array<{ uuid?: string; value?: string }> }).queue ?? [])
  }
  const reap = async (): Promise<void> => {
    try {
      runner.stdin.end()
    } catch {
    }
    await Promise.race([exited, sleep(8_000)])
    try {
      runner.kill('SIGKILL')
    } catch {
    }
    try {
      fixture.kill('SIGTERM')
    } catch {
    }
  }
  const U0 = '00000000-0000-4000-8000-000000000000'
  const UC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const U1 = '11111111-1111-4111-8111-111111111111'
  const U2 = '22222222-2222-4222-8222-222222222222'
  const U3 = '33333333-3333-4333-8333-333333333333'
  const U4 = '44444444-4444-4444-8444-444444444444'
  const U5 = '55555555-5555-4555-8555-555555555555'
  const U6 = '66666666-6666-4666-8666-666666666666'
  const FIRST = 'first held words'
  const SECOND = 'second held words'
  const WITHDRAWN = 'the words to take back'
  const LATER = 'the later line'
  const AUTO1 = 'the auto-held words'
  const AUTO2 = 'the second auto-held words'

  section('R1 a manual fold: lines sent while the runner compacts wait in its queue and ride the next turn, in order')
  send(user('hello there', U0))
  const first = await waitFor('the first turn', isResult, 40_000)
  check('the first turn answered (the runner is up)', first !== null, stderrText.split('\n').slice(-5).join(' | '))
  const beforeFold = lines.length
  send(user('/compact', UC))
  const compacting = await waitFor("the runner's compacting word", isCompactingStatus, 20_000, beforeFold)
  check("the runner stamps 'compacting' on its status frame as the fold begins", compacting !== null)
  send(user(FIRST, U1))
  send(user(WITHDRAWN, U2))
  send(user(SECOND, U3))
  await sleep(400)
  const duringFold = await queueOf('facts-during-fold')
  check("the runner's queue holds the three lines, in the order sent, while the fold runs", j(duringFold.map(q => q.uuid)) === j([U1, U2, U3]) && duringFold[0]?.value === FIRST, j(duringFold))
  check('the fold is still running while the lines wait (no result yet)', lines.slice(beforeFold).find(isResult) === undefined)

  section('R2 a withdraw during the hold pops the line by identity')
  send(control('w-hold', { subtype: 'withdraw_send', client_message_id: U2 }))
  const held = responseOf(await waitFor('w-hold', isControlResponse('w-hold'), 5_000))
  check('the withdraw answers withdrawn with the words while the fold runs', held.withdrawn === true && held.text === WITHDRAWN, j(held))
  const afterWithdraw = await queueOf('facts-after-withdraw')
  check('the queue keeps the other two, in order', j(afterWithdraw.map(q => q.uuid)) === j([U1, U3]), j(afterWithdraw))

  const foldResult = await waitFor("the fold's own turn", isResult, 40_000, beforeFold)
  check("the fold landed (the /compact turn's receipt names it)", foldResult !== null && String(foldResult.result ?? '').startsWith('Compacted'), j(foldResult?.result))
  const afterFold = lines.length
  const heldTurnStart = lines.slice(beforeFold).filter(isTurnStarted).find(f => j(f.uuids).includes(U1)) ?? (await waitFor('the held turn opens', f => isTurnStarted(f) && j(f.uuids).includes(U1), 20_000, afterFold))
  check('the runner opens the next turn on the held lines — both identities, first before second', heldTurnStart !== null && j(heldTurnStart.uuids) === j([U1, U3]), j(heldTurnStart?.uuids))
  const heldResult = await waitFor('the held turn', f => isResult(f) && f !== foldResult, 30_000, afterFold)
  check('the held turn answered', heldResult !== null)
  check("the runner's queue is empty once it took them", (await queueOf('facts-after-take')).length === 0)
  send(control('w-taken', { subtype: 'withdraw_send', client_message_id: U1 }))
  const taken = responseOf(await waitFor('w-taken', isControlResponse('w-taken'), 5_000))
  check('a withdraw after the take answers taken', taken.withdrawn === false && taken.reason === 'taken', j(taken))

  section('R3 a later line rides behind the held ones')
  const beforeLater = lines.length
  send(user(LATER, U4))
  const laterResult = await waitFor('the later line', isResult, 30_000, beforeLater)
  check('the later line answered', laterResult !== null)

  section('R4 the automatic fold inside a running turn holds and delivers the same way')
  const beforeAuto = lines.length
  send(user(TOOL_ASK_LINE(), U5))
  const autoFold = await waitFor('the automatic fold begins', isCompactingStatus, 60_000, beforeAuto)
  check("the tool turn's next request folds first (the runner stamps 'compacting' mid-turn)", autoFold !== null, stderrText.split('\n').slice(-5).join(' | '))
  send(user(AUTO1, U6))
  const U7 = '77777777-7777-4777-8777-777777777777'
  send(user(AUTO2, U7))
  await sleep(400)
  const duringAuto = await queueOf('facts-during-auto')
  check('the lines wait in the queue while the turn folds', j(duringAuto.map(q => q.uuid)) === j([U6, U7]), j(duringAuto))
  const toolResult = await waitFor('the tool turn', isResult, 60_000, beforeAuto)
  check('the tool turn answered after its fold', toolResult !== null)
  const autoHeldResult = await waitFor('the turn after the automatic fold', f => isResult(f) && f !== toolResult, 30_000, beforeAuto)
  check('the held lines ran as the turn after it', autoHeldResult !== null)
  await reap()

  type Wire = { kind: string; n?: number; ask?: string; order?: string[]; last?: string[]; tools?: number; at: number }
  const wire: Wire[] = readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Wire)
  for (const c of wire) console.log(`  #${c.n ?? '-'} ${c.kind} ask=${j((c.ask ?? '').slice(0, 40))} last=${j(c.last ?? [])}`)
  const asks = wire.filter(w => (w.kind === 'anthropic' || w.kind === 'tool-turn') && (w.tools ?? 0) > 0)
  const carrying = (words: string): Wire[] => asks.filter(c => (c.last ?? []).includes(words))
  const foldLanded = wire.filter(w => w.kind === 'fold-landed')
  section('the wire: once, in order, behind nothing newer')
  check('the fold landed twice on the wire (the manual fold, the automatic one)', foldLanded.length === 2, j(foldLanded))
  const heldRequest = carrying(FIRST)[0]
  check('exactly one request carries the held lines, after the manual fold landed, first before second', carrying(FIRST).length === 1 && heldRequest !== undefined && heldRequest.at > foldLanded[0]!.at && j(heldRequest.last) === j([FIRST, SECOND]), j(carrying(FIRST).map(c => [c.n, c.last])))
  check('no request ever carried the withdrawn words', carrying(WITHDRAWN).length === 0)
  check('the later line rode behind the held ones — its own request, after theirs', carrying(LATER).length === 1 && carrying(LATER)[0]!.n! > heldRequest!.n!, j(carrying(LATER).map(c => c.n)))
  const autoRequest = carrying(AUTO1)[0]
  check('the automatic fold: one request carries both auto-held lines, in order, after that fold landed', carrying(AUTO1).length === 1 && autoRequest !== undefined && autoRequest.at > foldLanded[1]!.at && j(autoRequest.last) === j([AUTO1, AUTO2]), j(carrying(AUTO1).map(c => [c.n, c.last])))
  if (failures === 0) rmSync(RUN_HOME, { recursive: true, force: true })
  else {
    console.log(`[forensics] world kept: ${RUN_HOME}`)
    console.log(stderrText.split('\n').slice(-20).join('\n'))
  }
}

function TOOL_ASK_LINE(): string {
  return 'run a tool then fold'
}

console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-compaction-hold: ALL LAWS HOLD' : `prove-compaction-hold: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
