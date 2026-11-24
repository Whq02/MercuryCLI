#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BLOCK_HEADER, BLOCK_MARK, SUMMARY_HEADER, SUMMARY_MARK, TOOL_RESULT_MARK } from './compaction-hold-fixture-words.ts'
import { hostRunner } from '../lib/runnerHost.ts'
import type { Message } from '../../src/engine/message-shapes/message.ts'

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

const connectorModule = await import(join(SRC, 'engine/connector/daemonConnector.ts'))
const { DaemonSessionConnector, RECALL_UNKNOWN_LINE } = connectorModule
const lostLine = (words: string): string => (typeof connectorModule.lostLine === 'function' ? connectorModule.lostLine(words) : '(no lost-line road)')
const lostWithRunnerLine = (lines: string[]): string => (typeof connectorModule.lostWithRunnerLine === 'function' ? connectorModule.lostWithRunnerLine(lines) : '(no lost-line road)')
const { createUserMessage } = await import(join(SRC, 'engine/message-shapes/factories.ts'))

type Reply = Record<string, unknown>
type Send = { clientMessageId: string; text: string; sentAtMs: number; state: 'pending' | 'delivered' | 'queued' | 'taken'; heldFor?: 'compaction'; mode: 'prompt' | 'bash'; source?: { text: string; mode: 'prompt' | 'bash'; pastedContents: Record<number, unknown> }; withdrawing?: true }
type Guts = {
  sends: Send[]
  echoRows: Map<string, Message>
  deliveredNotices: Map<string, { row: Message; text: string; sentAtMs: number; seq: number }>
  rawRecords: Message[]
  reconcileQueuedSends: (facts: Record<string, unknown>) => void
  readTail: () => void
  paint: () => void
}
let factsFeedReads: () => void = () => {}
let answer: (req: Reply) => Promise<Reply> = async () => ({ ok: true, op: 'sessionControl', outcome: 'applied' })
const rpcLog: Reply[] = []
const connector = new DaemonSessionConnector({ sessionId: 'compaction-hold-proof', runnerId: 'runner-1', title: 'compaction hold', projectLabel: 'proof', workspaceId: 'ws', home: SCRATCH, modelKey: 'claude-sonnet-5' }, {
  rpc: async (req: Reply) => {
    rpcLog.push(req)
    return answer(req)
  },
  factsRead: (read: () => void) => {
    factsFeedReads = read
  },
})
const g = connector as unknown as Guts
const lostLineOf = (): { text: string; atMs: number } | null | undefined => (typeof connector.lostLine === 'function' ? connector.lostLine() : undefined)
let liveWakes = 0
connector.subscribeLive(() => liveWakes++)
const painted = (): string => JSON.stringify(connector.records())
const queued = (entries: Array<{ uuid: string; value: string }>): Array<{ uuid: string; value: string; mode: string; priority: string }> =>
  entries.map(e => ({ ...e, mode: 'prompt', priority: 'next' }))
const { publishSessionFacts, publishSessionTail } = await import(join(SRC, 'engine/connector/seatProjections.ts'))
let factsStamp = Date.now()
const runnerSays = (busy: boolean): void => {
  publishSessionFacts({ schema: 1, sessionId: 'compaction-hold-proof', atMs: ++factsStamp, busy, queueReady: false, pendingModel: null, model: { effective: 'claude-sonnet-5', setting: null }, usage: {}, queue: [] } as never)
  factsFeedReads()
}
let tailStamp = 0
const tailSays = (word: 'compacting' | 'waiting-on-agents' | null): void => {
  publishSessionTail({ schema: 1, sessionId: 'compaction-hold-proof', atMs: ++tailStamp, text: null, ...(word !== null ? { stateWord: word } : {}) })
  g.readTail.call(connector)
}
const foldRunning = (on: boolean): void => {
  runnerSays(on)
  tailSays(on ? 'compacting' : null)
}

section('F4 the wiring — the seat, the roster, the daemon, the hint row, the composer')
{
  const { normalizeMessages } = await import('../../src/engine/message-shapes/normalize.ts')
  const dressed = normalizeMessages([
    { type: 'user', uuid: '00000000-0000-4000-8000-0000000000d1', timestamp: '2026-01-01T00:00:00.000Z', queued: true, heldFor: 'compaction', message: { role: 'user', content: [{ type: 'text', text: 'held' }] } },
    { type: 'user', uuid: '00000000-0000-4000-8000-0000000000d2', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'plain' }] } },
  ] as never) as Array<{ queued?: boolean; heldFor?: string }>
  check('the normalizer carries the held dress beside the queued one onto the row the plate reads', dressed[0]?.queued === true && dressed[0]?.heldFor === 'compaction' && dressed[1]?.queued === undefined && dressed[1]?.heldFor === undefined, 'normalizeMessages in src/engine/message-shapes/normalize.ts must copy heldFor beside queued onto the normalized user row; got ' + j(dressed))
}

section("F5 a context block is known by its header and its isMeta mark, never by its words — the fixture's recognisers are the product's own")
{
  const { operatorMessagesBlockText } = await import(join(SRC, 'engine/compaction-window/operatorMessages.ts'))
  const { normalizeAttachmentForAPI } = await import(join(SRC, 'engine/messages/attachmentText.ts'))
  const { getFoldUserSummaryMessage } = await import(join(SRC, 'engine/compaction/summariserPrompt.ts'))
  const block = { type: 'compact_operator_messages', messages: [{ ordinal: 2, text: 'second held words' }, { ordinal: 1, text: 'first held words' }], omitted: 0 }
  const projected = normalizeAttachmentForAPI(block as never) as Array<{ isMeta?: boolean; message: { content: unknown } }>
  const projectedText = projected.length === 1 && typeof projected[0]!.message.content === 'string' ? projected[0]!.message.content : ''
  check("the operator block projects to ONE meta user row headed by the fixture's block header", projected.length === 1 && projected[0]!.isMeta === true && projectedText.startsWith(BLOCK_HEADER) && operatorMessagesBlockText(block as never).startsWith(BLOCK_HEADER), projectedText.slice(0, 120) + ' — normalizeAttachmentForAPI (src/engine/messages/attachmentText.ts) and operatorMessagesBlockText (src/engine/compaction-window/operatorMessages.ts) must produce one isMeta user row starting with BLOCK_HEADER; if the header was changed on purpose, update compaction-hold-fixture-words.ts to match')
  check('…the header stands whatever the entries say (a different block, the same head)', operatorMessagesBlockText({ ...block, messages: [{ ordinal: 1, text: 'other words entirely' }] } as never).startsWith(BLOCK_HEADER), 'operatorMessagesBlockText in src/engine/compaction-window/operatorMessages.ts must start with BLOCK_HEADER whatever the entries say')
  check("the summary row opens with the fixture's summary header", getFoldUserSummaryMessage('the stretch').startsWith(SUMMARY_HEADER) && !getFoldUserSummaryMessage('the stretch').startsWith(BLOCK_HEADER), 'getFoldUserSummaryMessage in src/engine/compaction/summariserPrompt.ts must open with SUMMARY_HEADER and never with BLOCK_HEADER; if the header was changed on purpose, update compaction-hold-fixture-words.ts to match')
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
  const lines: Array<Record<string, unknown>> = []
  const waiters: Array<{ test: (f: Record<string, unknown>) => boolean; resolve: (f: Record<string, unknown>) => void }> = []
  let stderrText = ''
  const host = hostRunner({
    node: 'node',
    dist: DIST,
    argv: ['--model', 'claude-opus-4-6', '--mode', 'sovereign'],
    cwd: CWD,
    env: env as Record<string, string | undefined>,
    home: RUN_HOME,
    onRow: frame => {
      lines.push(frame)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.test(frame)) waiters.splice(i, 1)[0]!.resolve(frame)
      }
    },
  })
  const runner = host.child
  runner.stderr!.on('data', (chunk: Buffer) => {
    stderrText += chunk.toString('utf8')
  })
  const exited = host.exited
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
  const send = (text: string, id: string): void => {
    void host.prompt(text, { id }).catch(() => undefined)
  }
  const withdraw = (label: string, id: string): Promise<Record<string, unknown>> =>
    host.request('queue/withdraw', { id }, 5_000).then(
      result => result as Record<string, unknown>,
      (error: unknown) => {
        console.log(`  [wait] ${label}: ${error instanceof Error ? error.message : String(error)}`)
        return {}
      },
    )
  const isResult = (f: Record<string, unknown>): boolean => f.type === 'outcome'
  const isCompactingStatus = (f: Record<string, unknown>): boolean => f.type === 'compaction' && f.state !== 'ended'
  const isTurnStarted = (f: Record<string, unknown>): boolean => f.type === 'turn' && f.state === 'started'
  const queueOf = async (label: string): Promise<Array<{ uuid?: string; value?: string }>> => {
    const facts = await host.request('session/facts', {}, 5_000).catch((error: unknown) => {
      console.log(`  [wait] ${label}: ${error instanceof Error ? error.message : String(error)}`)
      return {} as Record<string, unknown>
    })
    return ((facts as { queue?: Array<{ uuid?: string; value?: string }> }).queue ?? [])
  }
  const reap = async (): Promise<void> => {
    host.end()
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
  await host.initialize().catch(() => undefined)
  send('hello there', U0)
  const first = await waitFor('the first turn', isResult, 40_000)
  check('the first turn answered (the runner is up)', first !== null, stderrText.split('\n').slice(-5).join(' | ') + ' — the built runner (dist/mercury.mjs, rebuild with bun run build.ts) never finished a turn against the fixture server; read its stderr above')
  const beforeFold = lines.length
  send('/compact', UC)
  const compacting = await waitFor("the runner's compacting word", isCompactingStatus, 20_000, beforeFold)
  check("the runner writes a compaction row as the fold begins", compacting !== null, 'the runner never wrote a compaction row (state started or progress) after /compact within 20 s; check the wait line above and the fold start stamp in src/engine/compaction/fold/foldStatusAndRestore.ts (withFoldStatus)')
  send(FIRST, U1)
  send(WITHDRAWN, U2)
  send(SECOND, U3)
  await sleep(400)
  const duringFold = await queueOf('facts-during-fold')
  check("the runner's queue holds the three lines, in the order sent, while the fold runs", j(duringFold.map(q => q.uuid)) === j([U1, U2, U3]) && duringFold[0]?.value === FIRST, j(duringFold) + ' — the runner must keep prompts sent during a fold in its queue, in send order, and report them in session/facts')
  check('the fold is still running while the lines wait (no outcome yet)', lines.slice(beforeFold).find(isResult) === undefined, 'an outcome row arrived before the fold finished; the /compact turn ended too early or the fixture server answered it as a normal turn')

  section('R2 a withdraw during the hold pops the line by identity')
  const held = await withdraw('w-hold', U2)
  check('the withdraw answers withdrawn with the words while the fold runs', held.withdrawn === true && held.text === WITHDRAWN, j(held) + ' — the runner queue/withdraw handler (verb declared in src/daemon/runner-wire/sessionVerbs.ts) must pop a queued line by uuid while a fold runs')
  const afterWithdraw = await queueOf('facts-after-withdraw')
  check('the queue keeps the other two, in order', j(afterWithdraw.map(q => q.uuid)) === j([U1, U3]), j(afterWithdraw) + ' — a withdraw must remove only the named uuid and leave the other queued lines in order')

  const foldResult = await waitFor("the fold's own turn", isResult, 40_000, beforeFold)
  check("the fold landed (the /compact turn's receipt names it)", foldResult !== null && String(foldResult.answer ?? '').startsWith('Compacted'), j(foldResult?.answer) + ' — the /compact turn must end with an outcome whose answer starts with Compacted; read the runner stderr and the fixture server log')
  const afterFold = lines.length
  const heldTurnStart = lines.slice(beforeFold).filter(isTurnStarted).find(f => j(f.message_ids).includes(U1)) ?? (await waitFor('the held turn opens', f => isTurnStarted(f) && j(f.message_ids).includes(U1), 20_000, afterFold))
  check('the runner opens the next turn on the held lines — both identities, first before second', heldTurnStart !== null && j(heldTurnStart.message_ids) === j([U1, U3]), j(heldTurnStart?.message_ids) + ' — after the fold the runner must open one turn on the held lines, first before second, with the withdrawn one absent')
  const heldResult = await waitFor('the held turn', f => isResult(f) && f !== foldResult, 30_000, afterFold)
  check('the held turn answered', heldResult !== null, 'no outcome row for the held turn within 30 s; the runner did not run its queued lines after the fold ended')
  check("the runner's queue is empty once it took them", (await queueOf('facts-after-take')).length === 0, 'the runner must empty its queue when it takes the held lines into a turn (session/facts queue)')
  const taken = await withdraw('w-taken', U1)
  check('a withdraw after the take answers taken', taken.withdrawn === false && taken.reason === 'taken', j(taken) + ' — queue/withdraw (verb declared in src/daemon/runner-wire/sessionVerbs.ts) must answer reason taken for a line already taken into a turn')

  section('R3 a later line rides behind the held ones')
  const beforeLater = lines.length
  send(LATER, U4)
  const laterResult = await waitFor('the later line', isResult, 30_000, beforeLater)
  check('the later line answered', laterResult !== null)

  section('R4 the automatic fold inside a running turn holds and delivers the same way')
  const beforeAuto = lines.length
  send(TOOL_ASK_LINE(), U5)
  const autoFold = await waitFor('the automatic fold begins', isCompactingStatus, 60_000, beforeAuto)
  check("the tool turn's next request folds first (the runner writes a compaction row mid-turn)", autoFold !== null, stderrText.split('\n').slice(-5).join(' | ') + ' — no automatic compaction row within 60 s; the fixture server must report a full context on the tool turn, and the runner must fold before its next request')
  send(AUTO1, U6)
  const U7 = '77777777-7777-4777-8777-777777777777'
  send(AUTO2, U7)
  await sleep(400)
  const duringAuto = await queueOf('facts-during-auto')
  check('the lines wait in the queue while the turn folds', j(duringAuto.map(q => q.uuid)) === j([U6, U7]), j(duringAuto) + ' — lines sent while an automatic fold runs must wait in the runner queue in send order')
  const toolResult = await waitFor('the tool turn', isResult, 60_000, beforeAuto)
  check('the tool turn answered after its fold', toolResult !== null)
  const autoEnded = lines.slice(beforeAuto).find(f => f.type === 'compaction' && f.state === 'ended')
  const autoEndedAt = autoEnded === undefined ? -1 : lines.indexOf(autoEnded)
  const toolResultAt = toolResult === null ? -1 : lines.indexOf(toolResult)
  check("the automatic fold's exit is the runner's own compaction row with state ended — written while the turn still runs, before its outcome (the word clears on the real emission)", autoEnded !== undefined && autoEnded.trigger === 'auto' && toolResultAt !== -1 && autoEndedAt < toolResultAt, j({ autoEnded, autoEndedAt, toolResultAt }) + ' — the runner must write a compaction row with state ended and trigger auto before the tool turn outcome row')
  const autoHeldResult = await waitFor('the turn after the automatic fold', f => isResult(f) && f !== toolResult, 30_000, beforeAuto)
  check('the held lines ran as the turn after it', autoHeldResult !== null)

  section('R5 one lifecycle per fold: one started row, one ended row carrying the exit and the size before, for the manual fold and the automatic one alike')
  const lifecycleOf = (from: number, to: number): { started: number; progress: number; ended: Array<Record<string, unknown>> } => {
    const rows = lines.slice(from, to === -1 ? undefined : to + 1).filter(f => f.type === 'compaction')
    return { started: rows.filter(f => f.state === 'started').length, progress: rows.filter(f => f.state === 'progress').length, ended: rows.filter(f => f.state === 'ended') }
  }
  const manual = lifecycleOf(beforeFold, foldResult === null ? -1 : lines.indexOf(foldResult))
  check('the manual fold began once (one started row)', manual.started === 1, j(manual) + ' — the runner must write exactly one compaction row with state started per fold; later stamps must be state progress')
  check('the manual fold ended once — exit landed, trigger manual, the size before the fold on the row', manual.ended.length === 1 && manual.ended[0]!.exit === 'landed' && manual.ended[0]!.trigger === 'manual' && typeof manual.ended[0]!.tokens_before === 'number', j(manual.ended) + ' — the manual fold must write exactly one ended compaction row carrying exit, trigger and tokens_before')
  const auto = lifecycleOf(beforeAuto, toolResultAt)
  check('the automatic fold began once (one started row, the fold\'s repeated stamps write no second)', auto.started === 1, j(auto) + ' — withFoldStatus (src/engine/compaction/fold/foldStatusAndRestore.ts) stamps must not write a second started row')
  check('the automatic fold ended once — exit landed, trigger auto, the size before the fold on the row; no second ended row cleared the word', auto.ended.length === 1 && auto.ended[0]!.exit === 'landed' && auto.ended[0]!.trigger === 'auto' && typeof auto.ended[0]!.tokens_before === 'number', j(auto.ended) + ' — the automatic fold must write exactly one ended compaction row carrying exit, trigger auto and tokens_before')
  await reap()

  type Wire = { kind: string; n?: number; ask?: string; order?: string[]; last?: string[]; block?: string[]; parts?: string[]; twice?: string[]; tools?: number; at: number }
  const wire: Wire[] = readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Wire)
  for (const c of wire) console.log(`  #${c.n ?? '-'} ${c.kind} ask=${j((c.ask ?? '').slice(0, 40))} last=${j(c.last ?? [])} block=${j(c.block ?? [])} parts=${j(c.parts ?? [])}`)
  const asks = wire.filter(w => (w.kind === 'anthropic' || w.kind === 'tool-turn') && (w.tools ?? 0) > 0)
  const carrying = (words: string): Wire[] => asks.filter(c => (c.last ?? []).includes(words))
  const partsOf = (c: Wire | undefined): string[] => c?.parts ?? []
  const foldLanded = wire.filter(w => w.kind === 'fold-landed')
  section('the wire: delivered once, in order, behind nothing newer — a context block, known by its header, is not a delivery')
  check('the fold landed twice on the wire (the manual fold, the automatic one)', foldLanded.length === 2, j(foldLanded) + ' — the fixture server (compaction-hold-fixture-server.ts) saw a different number of fold requests than the two the run drives; see the manual and automatic fold sections above')
  const heldRequest = carrying(FIRST)[0]
  check('exactly one request delivers the held lines, after the manual fold landed, first before second (the block that carries them again after the automatic fold is not a delivery)', carrying(FIRST).length === 1 && heldRequest !== undefined && heldRequest.at > foldLanded[0]!.at && j(heldRequest.last) === j([FIRST, SECOND]), j(carrying(FIRST).map(c => [c.n, c.last])) + ' — the runner must send the held lines once, in one request after the fold landed, first before second')
  check('no request ever delivered the withdrawn words', carrying(WITHDRAWN).length === 0, 'a withdrawn line still reached the model; the runner must drop it from its queue on queue/withdraw (verb declared in src/daemon/runner-wire/sessionVerbs.ts)')
  check('the later line rode behind the held ones — its own request, after theirs (its words inside a later block are not a delivery)', carrying(LATER).length === 1 && carrying(LATER)[0]!.n! > heldRequest!.n!, j(carrying(LATER).map(c => c.n)) + ' — a line sent after the held ones must go in its own later request')
  const autoRequest = carrying(AUTO1)[0]
  check('the automatic fold: one request delivers both auto-held lines, in order, after that fold landed', carrying(AUTO1).length === 1 && autoRequest !== undefined && autoRequest.at > foldLanded[1]!.at && j(autoRequest.last) === j([AUTO1, AUTO2]), j(carrying(AUTO1).map(c => [c.n, c.last])) + ' — lines held during an automatic fold must go out once, together, in send order, after that fold landed')
  section("the block's own law: once per request, ahead of the summary, never the last user text; no line twice outside it")
  const firstAfter = foldLanded.map(fold => asks.find(c => c.at > fold.at))
  check('the first request after each fold carries the block, ahead of the summary', firstAfter.length === 2 && firstAfter.every(c => partsOf(c).indexOf(BLOCK_MARK) >= 0 && partsOf(c).indexOf(BLOCK_MARK) < partsOf(c).indexOf(SUMMARY_MARK)), j(firstAfter.map(c => [c?.n, c?.parts])) + ' — the first request after each fold must carry the operator-messages block (see operatorMessagesBlockText in src/engine/compaction-window/operatorMessages.ts) ahead of the summary')
  const withBlock = asks.filter(c => partsOf(c).includes(BLOCK_MARK))
  check('every request carrying the block carries it once, and the summary after it', withBlock.length >= 2 && withBlock.every(c => partsOf(c).filter(p => p === BLOCK_MARK).length === 1 && partsOf(c).indexOf(BLOCK_MARK) >= 0 && partsOf(c).indexOf(BLOCK_MARK) < partsOf(c).indexOf(SUMMARY_MARK)), j(withBlock.map(c => [c.n, c.parts])) + ' — a request must carry the operator-messages block once, before the summary')
  check('the block is never the last user text: the delivered lines ride last after it — the held lines as one batched text, the later line, the auto-held lines', withBlock.every(c => partsOf(c).at(-1) !== BLOCK_MARK) && partsOf(heldRequest).at(-1) === `${FIRST}\n${SECOND}` && partsOf(carrying(LATER)[0]).at(-1) === LATER && partsOf(autoRequest).at(-1) === `${AUTO1}\n${AUTO2}`, j(withBlock.map(c => [c.n, partsOf(c).at(-1)])) + ' — the block must never be the last user text; delivered lines ride after it, batched in one text')
  const afterAutoFold = firstAfter[1]
  const behindSummary = partsOf(afterAutoFold).slice(partsOf(afterAutoFold).indexOf(SUMMARY_MARK) + 1)
  check('after the fold inside a running turn nothing is delivered: the folded lines ride only inside the block, and behind the summary rides only the running turn\'s own round kept whole (its ask, then its tool result)', afterAutoFold !== undefined && (afterAutoFold.last ?? []).length === 0 && [FIRST, SECOND, LATER].every(w => (afterAutoFold.block ?? []).includes(w)) && j(behindSummary) === j([afterAutoFold.ask, TOOL_RESULT_MARK]), j(afterAutoFold) + ' — after a fold inside a running turn nothing may be delivered again outside the block; only the running turn\'s ask and tool result ride behind the summary')
  check('no line rides twice in one request outside the block', asks.every(c => (c.twice ?? []).length === 0), j(asks.filter(c => (c.twice ?? []).length > 0).map(c => [c.n, c.twice])) + ' — a held line must appear once per request outside the block')
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
