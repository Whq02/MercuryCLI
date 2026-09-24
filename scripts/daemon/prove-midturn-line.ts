#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const SRC = join(REPO, 'src')
const distArg = process.argv.indexOf('--dist')
const DIST = distArg >= 0 && process.argv[distArg + 1] !== undefined ? process.argv[distArg + 1]! : join(REPO, 'dist', 'mercury.mjs')
const FIXTURE = join(import.meta.dir, 'midturn-line-fixture-server.ts')
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
const TURN_MS = 40_000

const SCRATCH = mkdtempSync(join(tmpdir(), 'midturn-line-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const OPENING = 'The operator sent a new message while you were working:'
const ACCOUNTING = 'Before ending your turn, account for this message: address it, incorporate it into the work, or explain any blocker. Do not silently drop it.'
const BULLETS = [
  '- If it corrects, clarifies, or adds a constraint to the active task, apply it before continuing any affected work.',
  '- If it asks a question or requests a status update, answer briefly, then resume the active task.',
  '- If it explicitly stops, cancels, replaces, or reprioritizes the task, follow that direction. Do not continue superseded work.',
  '- If it adds a separate task, retain it and complete it after the active task unless the operator specifies another order.',
]
const OBJECTIVE = 'A new message does not automatically replace the original objective. Preserve unfinished work and existing requirements unless the operator changes them.'
const THREE_ROUNDS_ASK = 'three tool rounds'
const LONG_ROUND_ASK = 'one long tool round'
const LINE1 = 'the first mid-turn line'
const LINE2 = 'the second mid-turn line'
const LINE3 = 'the third mid-turn line'
const LINE4 = 'the line before the escape'
const LINE5 = 'the line during the fold'
const SLASH = '/cost'

section('W the words the model reads (the source)')
{
  const text = await import(join(SRC, 'utils/messages/text.ts'))
  const human = text.wrapCommandText(LINE1, undefined) as string
  check('the default arm opens with the operator line and the message', human.startsWith(`${OPENING}\n${LINE1}\n\nIMPORTANT: Read this message before taking your next action and respond according to its intent.\n\n`), human.slice(0, 160))
  check('the four cases stand in order, then the objective sentence', BULLETS.every(b => human.includes(b)) && BULLETS.map(b => human.indexOf(b)).every((at, i, all) => i === 0 || at > all[i - 1]!) && human.includes(OBJECTIVE) && human.indexOf(OBJECTIVE) > human.indexOf(BULLETS[3]!))
  check('the arm ends with the accounting sentence', human.endsWith(ACCOUNTING))
  check('the explicit human origin reads the same', text.wrapCommandText(LINE1, { kind: 'human' }) === human)
  check('the other arms are unchanged', (text.wrapCommandText('X', { kind: 'task-notification' }) as string).startsWith('A background agent completed a task:') && (text.wrapCommandText('X', { kind: 'coordinator' }) as string).startsWith('The coordinator sent a message while you were working:') && (text.wrapCommandText('X', { kind: 'channel', server: 'slack' }) as string).startsWith('A message arrived from slack while you were working:'))
  check('no reader of the old sentences remains in the source', !(human.includes('The user sent a new message') || human.includes("you MUST address the user's message above")))
}

section("D the daemon road's clock — the frame and the wiring")
{
  const dispatch = await import(join(SRC, 'daemon/concourseDispatch.ts'))
  const identity = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111'
  const sentAt = '2026-09-12T08:00:05.123Z'
  const stamped = JSON.parse(dispatch.buildConcoursePromptFrame('the words', { identity, sentAt })) as Record<string, unknown>
  check("a dispatch's sentAt rides the runner frame as its timestamp, under the same identity", stamped.timestamp === sentAt && stamped.uuid === identity, j(stamped))
  const bare = JSON.parse(dispatch.buildConcoursePromptFrame('the words', { identity })) as Record<string, unknown>
  check('a frame without a send clock carries no timestamp key', !('timestamp' in bare), j(bare))
  const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')
  const connector = read('services/engine-connector/daemonConnector.ts')
  check("the connector's send carries its own send time on the sessionDispatch request", /op: 'sessionDispatch',[\s\S]{0,400}sentAt: new Date\(send\.sentAtMs\)\.toISOString\(\),/.test(connector))
  const control = read('daemon/controlServer.ts')
  check('the daemon forwards a parseable sentAt into the dispatch request', control.includes("...(typeof raw.sentAt === 'string' && Number.isFinite(Date.parse(raw.sentAt)) ? { sentAt: raw.sentAt } : {}),"))
  const dispatchSrc = read('daemon/concourseDispatch.ts')
  check('the prompt extras carry sentAt on both delivery legs (the admit leg and the redirect leg read promptExtrasOf)', dispatchSrc.includes("...(req.sentAt !== undefined ? { sentAt: req.sentAt } : {}),") && dispatchSrc.includes("...(extras?.sentAt !== undefined ? { timestamp: extras.sentAt } : {}),"))
  const printSrc = read('cli/print.ts')
  check("the runner stamps the queued command from the frame's timestamp, or the arrival", printSrc.includes("const sentAt = typeof typed.timestamp === 'string' && Number.isFinite(Date.parse(typed.timestamp)) ? typed.timestamp : new Date().toISOString()"))
  const attachments = read('utils/attachments/queuedCommands.ts')
  check('the queued_command attachment carries the clock', attachments.includes("...(_.sentAt !== undefined ? { sentAt: _.sentAt } : {}),"))
  const orchestrator = read('utils/attachments/orchestrator.ts')
  check("the attachment row is stamped with the line's own clock when it has one", orchestrator.includes('timestamp: sentClockOf(attachment) ?? new Date().toISOString(),'))
}

rmSync(SCRATCH, { recursive: true, force: true })

if (!existsSync(DIST)) {
  console.log(`\nFAIL ${DIST} missing — run \`bun run build.ts\` first (the runner half drives the BUILT runner)`)
  failures++
} else {
  const RUN_HOME = join(realpathSync(tmpdir()), `mercury-midturn-line-${process.pid}`)
  const CWD = join(RUN_HOME, 'repo')
  rmSync(RUN_HOME, { recursive: true, force: true })
  mkdirSync(CWD, { recursive: true })
  const PROBE_KEY = 'sk-ant-midturn-line-key'
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
  const runner = spawn('node', [DIST, '-p', '--input-format=stream-json', '--output-format=stream-json', '--replay-user-messages', '--model', 'claude-opus-4-8', '--permission-mode', 'bypassPermissions'], { cwd: CWD, env, stdio: ['pipe', 'pipe', 'pipe'] })
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
  type Wire = { kind: string; n: number; arm?: string; step?: number; ask?: string; at: number; system?: string; toolsDigest?: string; items?: Array<{ role: string; sha: string }>; last?: Array<{ type: string; text?: string; tool_use_id?: string }>; counts?: Record<string, number> }
  const wire = (): Wire[] =>
    readFileSync(captureFile, 'utf8')
      .split('\n')
      .filter(l => l.trim() !== '')
      .map(l => JSON.parse(l) as Wire)
  async function waitWire(label: string, test: (w: Wire) => boolean, timeoutMs: number): Promise<Wire | null> {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      const hit = wire().find(test)
      if (hit !== undefined) return hit
      await sleep(60)
    }
    console.log(`  [wait] ${label}: nothing on the wire within ${timeoutMs} ms`)
    return null
  }
  const send = (frame: Record<string, unknown>): void => {
    runner.stdin.write(`${JSON.stringify(frame)}\n`)
  }
  const user = (text: string, uuid: string, timestamp?: string): Record<string, unknown> => ({ type: 'user', message: { role: 'user', content: text }, uuid, session_id: '', ...(timestamp !== undefined ? { timestamp } : {}) })
  const control = (requestId: string, request: Record<string, unknown>): Record<string, unknown> => ({ type: 'control_request', request_id: requestId, request })
  const responseOf = (f: Record<string, unknown> | null): Record<string, unknown> => {
    const r = f?.response as { subtype?: string; response?: Record<string, unknown>; error?: string } | undefined
    return r?.response ?? (r?.error !== undefined ? { error: r.error } : {})
  }
  const isControlResponse = (id: string) => (f: Record<string, unknown>): boolean => f.type === 'control_response' && (f.response as { request_id?: string } | undefined)?.request_id === id
  const isResult = (f: Record<string, unknown>): boolean => f.type === 'result'
  const isInit = (f: Record<string, unknown>): boolean => f.type === 'system' && f.subtype === 'init'
  const isCompactingStatus = (f: Record<string, unknown>): boolean =>
    f.type === 'system' && f.subtype === 'status' && (f.status === 'compacting' || (f.status !== null && typeof f.status === 'object' && 'compacting' in (f.status as object)))
  const isTurnStarted = (f: Record<string, unknown>): boolean => f.type === 'system' && f.subtype === 'turn_started'
  const isReplayOf = (uuid: string) => (f: Record<string, unknown>): boolean => f.type === 'user' && f.is_replay === true && f.uuid === uuid
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
  const UT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const U1 = '11111111-1111-4111-8111-111111111111'
  const U2 = '22222222-2222-4222-8222-222222222222'
  const UC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const U3 = '33333333-3333-4333-8333-333333333333'
  const UL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const U4 = '44444444-4444-4444-8444-444444444444'
  const UF = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const U5 = '55555555-5555-4555-8555-555555555555'
  const remindersIn = (blocks: Array<{ type: string; text?: string }>, kinds: string[] = ['text', 'tool_result/text']): string[] => {
    const out: string[] = []
    for (const block of blocks) {
      if (!kinds.includes(block.type) || typeof block.text !== 'string') continue
      const re = /<system-reminder>\n([\s\S]*?)\n<\/system-reminder>/g
      for (let m = re.exec(block.text); m !== null; m = re.exec(block.text)) out.push(m[1]!)
    }
    return out
  }
  const wordsFor = (line: string): string => `${OPENING}\n${line}\n\nIMPORTANT: Read this message before taking your next action and respond according to its intent.\n\n${BULLETS.join('\n')}\n\n${OBJECTIVE}\n\n${ACCOUNTING}`

  section('R1 the runner is up')
  send(user('hello there', U0))
  const init = await waitFor('the init frame', isInit, TURN_MS)
  const first = await waitFor('the first turn', isResult, TURN_MS)
  check('the first turn answered', first !== null && init !== null, stderrText.split('\n').slice(-5).join(' | '))
  const sessionId = String(init?.session_id ?? '')

  section('R2 three tool rounds: lines sent between rounds land at the next boundary, once, in order, under the new words, with their send clocks')
  const beforeThree = lines.length
  const wireBefore = wire().length
  send(user(THREE_ROUNDS_ASK, UT))
  const r1 = await waitWire('round one', w => w.kind === 'request' && w.arm === 'three' && w.step === 0 && w.n > wireBefore, TURN_MS * 3 / 4)
  check("round one's request went out", r1 !== null, stderrText.split('\n').slice(-5).join(' | '))
  const T1 = new Date(Date.now() - 90_000).toISOString()
  const T2 = new Date(Date.parse(T1) + 1_000).toISOString()
  send(user(LINE1, U1, T1))
  send(user(LINE2, U2, T2))
  send(user(SLASH, UC))
  await sleep(300)
  const duringRoundOne = await queueOf('facts-round-one')
  check("the runner's queue holds the two lines and the slash command, in the order sent, while round one's tool runs", j(duringRoundOne.map(q => q.uuid)) === j([U1, U2, UC]), j(duringRoundOne))
  const r2 = await waitWire('round two', w => w.kind === 'request' && w.arm === 'three' && w.step === 1 && w.n > (r1?.n ?? 0), TURN_MS * 3 / 4)
  check("round two's request went out after the boundary", r2 !== null)
  const sentAt3 = Date.now()
  send(user(LINE3, U3))
  const afterBoundaryOne = await queueOf('facts-after-boundary-one')
  check('past the boundary the queue holds the slash command (waiting for the turn to end) and the third line, and the two lines are gone', j(afterBoundaryOne.map(q => q.uuid)) === j([UC, U3]), j(afterBoundaryOne))
  const r3 = await waitWire('round three', w => w.kind === 'request' && w.arm === 'three' && w.step === 2 && w.n > (r2?.n ?? 0), TURN_MS * 3 / 4)
  check("round three's request went out", r3 !== null)
  const r4 = await waitWire('the final request', w => w.kind === 'request' && w.arm === 'three' && w.step === 3 && w.n > (r3?.n ?? 0), TURN_MS * 3 / 4)
  check('the final request went out', r4 !== null)
  const threeResult = await waitFor('the tool turn', isResult, TURN_MS, beforeThree)
  check("the tool turn answered with the fixture's final text", threeResult !== null && String(threeResult.result ?? '').startsWith('done: three tool rounds'), j(threeResult?.result))
  const afterThree = threeResult === null ? lines.length : lines.indexOf(threeResult) + 1
  const slashResult = await waitFor("the slash command's own turn after the tool turn", isResult, 25_000, afterThree)
  check("the slash command ran after the turn's end (its own result frame)", slashResult !== null)
  check('the queue is empty once the slash command ran', (await queueOf('facts-after-slash')).length === 0)

  const last2 = r2?.last ?? []
  const rem2 = remindersIn(last2)
  check("round two's request folds the two lines into the tool-result message, as two system-reminders, first before second", last2[0]?.type === 'tool_result' && rem2.length === 2 && rem2[0]!.includes(LINE1) && rem2[1]!.includes(LINE2), j(last2.map(b => [b.type, (b.text ?? '').slice(0, 60)])))
  check("the reminders ride inside the tool_result's content, after the tool's own text (the wire shape stands as it is)", remindersIn(last2, ['tool_result/text']).length === 2 && remindersIn(last2, ['text']).length === 0, j(last2.map(b => b.type)))
  check('the first line rides under the new words, exactly', rem2[0] === wordsFor(LINE1), j(rem2[0]?.slice(0, 200)))
  check('the second line rides under the new words, exactly', rem2[1] === wordsFor(LINE2), j(rem2[1]?.slice(0, 200)))
  check('round one carried neither line; round two carries each once; round three still carries each once (the history keeps them, nothing doubles)', (r1?.counts?.[LINE1] ?? -1) === 0 && (r1?.counts?.[LINE2] ?? -1) === 0 && r2?.counts?.[LINE1] === 1 && r2?.counts?.[LINE2] === 1 && r3?.counts?.[LINE1] === 1 && r3?.counts?.[LINE2] === 1 && r4?.counts?.[LINE1] === 1, j([r1?.counts, r2?.counts, r3?.counts, r4?.counts]))
  const rem3 = remindersIn(r3?.last ?? [])
  check("the third line, sent between rounds two and three, rides round three's request under the new words, once", rem3.length === 1 && rem3[0] === wordsFor(LINE3) && r3?.counts?.[LINE3] === 1 && (r2?.counts?.[LINE3] ?? -1) === 0, j(rem3.map(r => r.slice(0, 80))))
  check("none of the tool turn's requests carried the slash command", [r1, r2, r3, r4].every(w => (w?.counts?.[SLASH] ?? 1) === 0), j([r1, r2, r3, r4].map(w => [w?.n, w?.counts?.[SLASH]])))
  const prefixHolds = (a: Wire | null, b: Wire | null): boolean => {
    if (a === null || b === null || a.items === undefined || b.items === undefined) return false
    if (b.items.length < a.items.length) return false
    return a.items.every((it, i) => b.items![i]!.sha === it.sha && b.items![i]!.role === it.role) && a.system === b.system && a.toolsDigest === b.toolsDigest
  }
  check("round two's request begins with round one's request byte for byte (system, tools, every message) — the delivery is an append, no prefix move", prefixHolds(r1, r2), j([r1?.items?.length, r2?.items?.length]))
  check('round three and the final request extend their predecessors the same way', prefixHolds(r2, r3) && prefixHolds(r3, r4), j([r2?.items?.length, r3?.items?.length, r4?.items?.length]))

  type Row = { type?: string; uuid?: string; timestamp?: string; message?: { role?: string; content?: unknown }; attachment?: { type?: string; source_uuid?: string; sentAt?: string; prompt?: unknown } }
  const findTranscript = (dir: string): string | null => {
    if (!existsSync(dir)) return null
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) {
        const hit = findTranscript(p)
        if (hit !== null) return hit
      } else if (name === `${sessionId}.jsonl`) return p
    }
    return null
  }
  const reader = await import(join(SRC, 'utils/sessionStorage/transcriptReader.ts'))
  const transcriptPath = findTranscript(join(RUN_HOME, 'projects'))
  const rows: Row[] = transcriptPath === null ? [] : (((await reader.readTranscriptChainSince(transcriptPath, null)) as { rows: Row[] }).rows ?? [])
  check("the runner's transcript is on disk", transcriptPath !== null && rows.length > 0, `${transcriptPath} rows=${rows.length}`)
  const rowOf = (uuid: string): Row | undefined => rows.find(r => r.type === 'attachment' && r.attachment?.type === 'queued_command' && r.attachment.source_uuid === uuid)
  const indexOf = (pred: (r: Row) => boolean): number => rows.findIndex(pred)
  const hasBlock = (r: Row, pred: (b: { type?: string; id?: string; tool_use_id?: string }) => boolean): boolean => Array.isArray(r.message?.content) && (r.message!.content as Array<{ type?: string; id?: string; tool_use_id?: string }>).some(pred)
  const idxResultOne = indexOf(r => r.type === 'user' && hasBlock(r, b => b.type === 'tool_result' && b.tool_use_id === `toolu_r1_c${r1?.n}`))
  const idxUseTwo = indexOf(r => r.type === 'assistant' && hasBlock(r, b => b.type === 'tool_use' && b.id === `toolu_r2_c${r2?.n}`))
  const idx1 = indexOf(r => r === rowOf(U1))
  const idx2 = indexOf(r => r === rowOf(U2))
  const idx3 = indexOf(r => r === rowOf(U3))
  check("the two lines' rows land between round one's tool result and round two's tool call, first before second", idxResultOne >= 0 && idxUseTwo > idxResultOne && idx1 > idxResultOne && idx2 > idx1 && idx2 < idxUseTwo, j({ idxResultOne, idx1, idx2, idxUseTwo }))
  check("the third line's row lands after round two's tool call", idx3 > idxUseTwo, j({ idx3, idxUseTwo }))
  const row1 = rowOf(U1)
  const row2 = rowOf(U2)
  const row3 = rowOf(U3)
  check("the first line's row carries the clock the frame was sent with, not the boundary's", row1?.timestamp === T1, j({ row: row1?.timestamp, sent: T1, boundaryAt: new Date(r2?.at ?? 0).toISOString() }))
  check("the second line's row carries its own send clock", row2?.timestamp === T2, j({ row: row2?.timestamp, sent: T2 }))
  const row3At = Date.parse(row3?.timestamp ?? '')
  check("a frame with no timestamp lands with its arrival clock — after the send, well before the boundary that delivered it", Number.isFinite(row3At) && row3At >= sentAt3 - 100 && row3At <= sentAt3 + 1_500 && row3At < (r3?.at ?? 0) - 1_000, j({ row: row3?.timestamp, sentAtMs: sentAt3, boundaryAt: r3?.at }))
  const replay1 = lines.find(isReplayOf(U1))
  check('the stream-json replay of the first line carries the same clock for the headless reader', replay1 !== undefined && replay1.timestamp === T1, j(replay1 === undefined ? null : { uuid: replay1.uuid, timestamp: replay1.timestamp }))

  section('R3 escape with a line queued: the interrupt ends the turn and the line runs as the next turn')
  const beforeLong = lines.length
  send(user(LONG_ROUND_ASK, UL))
  const rl = await waitWire('the long round', w => w.kind === 'request' && w.arm === 'long' && w.step === 0, TURN_MS * 3 / 4)
  check("the long round's request went out (a 30 s tool runs)", rl !== null)
  const T4 = new Date(Date.now() - 30_000).toISOString()
  send(user(LINE4, U4, T4))
  await sleep(400)
  check('the line waits in the queue while the tool runs', j((await queueOf('facts-before-escape')).map(q => q.uuid)) === j([U4]))
  const pressedAt = Date.now()
  send(control('esc-1', { subtype: 'interrupt' }))
  const interrupted = await waitFor('the interrupted turn', isResult, 20_000, beforeLong)
  check('the interrupt ended the turn well before the tool would have', interrupted !== null && Date.now() - pressedAt < 15_000, j(interrupted?.result))
  const afterInterrupt = interrupted === null ? lines.length : lines.indexOf(interrupted) + 1
  const lineTurn = lines.slice(beforeLong).filter(isTurnStarted).find(f => j(f.uuids).includes(U4)) ?? (await waitFor("the queued line's own turn", f => isTurnStarted(f) && j(f.uuids).includes(U4), 20_000, afterInterrupt))
  check('the queued line opens the next turn under its own identity', lineTurn !== null && j(lineTurn.uuids) === j([U4]), j(lineTurn?.uuids))
  const lineResult = await waitFor("the queued line's answer", f => isResult(f) && f !== interrupted, 30_000, afterInterrupt)
  check('the line was answered', lineResult !== null && String(lineResult.result ?? '').startsWith(`heard: ${LINE4}`), j(lineResult?.result))
  const carrying4 = wire().filter(w => w.kind === 'request' && (w.counts?.[LINE4] ?? 0) > 0)
  check("the first request carrying the line opens on it, after the interrupt, as the turn's own prompt (the between-turns road), once", carrying4.length >= 1 && carrying4[0]!.n > (rl?.n ?? 0) && carrying4[0]!.ask === LINE4 && carrying4[0]!.counts?.[LINE4] === 1, j(carrying4.map(w => [w.n, w.ask, w.counts?.[LINE4]])))

  section('R4 a line sent during a compaction is held until the fold lands')
  const beforeFold = lines.length
  send(user('/compact', UF))
  const compacting = await waitFor("the runner's compacting word", isCompactingStatus, 20_000, beforeFold)
  check("the runner stamps 'compacting' as the fold begins", compacting !== null)
  send(user(LINE5, U5, new Date().toISOString()))
  await sleep(400)
  check('the line waits in the queue while the fold runs, and no boundary takes it (no result yet)', j((await queueOf('facts-during-fold')).map(q => q.uuid)) === j([U5]) && lines.slice(beforeFold).find(isResult) === undefined)
  const foldResult = await waitFor("the fold's own turn", isResult, TURN_MS, beforeFold)
  check('the fold landed', foldResult !== null && String(foldResult.result ?? '').startsWith('Compacted'), j(foldResult?.result))
  const afterFold = foldResult === null ? lines.length : lines.indexOf(foldResult) + 1
  const heldTurn = lines.slice(beforeFold).filter(isTurnStarted).find(f => j(f.uuids).includes(U5)) ?? (await waitFor('the held line opens the next turn', f => isTurnStarted(f) && j(f.uuids).includes(U5), 20_000, afterFold))
  check('the held line opens the turn after the fold', heldTurn !== null && j(heldTurn.uuids) === j([U5]), j(heldTurn?.uuids))
  const heldResult = await waitFor('the held line answered', f => isResult(f) && f !== foldResult, 30_000, afterFold)
  check('the held line was answered once the fold landed', heldResult !== null && String(heldResult.result ?? '').startsWith(`heard: ${LINE5}`), j(heldResult?.result))
  const foldLanded = wire().find(w => w.kind === 'fold-landed')
  const carrying5 = wire().filter(w => w.kind === 'request' && (w.counts?.[LINE5] ?? 0) > 0)
  check('the wire carries the held line only after the fold landed, opening on it once', foldLanded !== undefined && carrying5.length >= 1 && carrying5[0]!.at > foldLanded.at && carrying5[0]!.ask === LINE5 && carrying5[0]!.counts?.[LINE5] === 1, j(carrying5.map(w => [w.n, w.ask, w.at - (foldLanded?.at ?? 0)])))
  await reap()

  for (const w of wire()) if (w.kind === 'request') console.log(`  #${w.n} ${w.arm} step=${w.step} ask=${j((w.ask ?? '').slice(0, 30))} items=${w.items?.length} counts=${j(w.counts)}`)
  if (failures === 0) rmSync(RUN_HOME, { recursive: true, force: true })
  else {
    console.log(`[forensics] world kept: ${RUN_HOME}`)
    console.log(stderrText.split('\n').slice(-20).join('\n'))
  }
}

console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-midturn-line: ALL LAWS HOLD' : `prove-midturn-line: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
