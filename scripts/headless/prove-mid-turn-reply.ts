#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostRunner } from '../lib/runnerHost.ts'

const REPO = join(import.meta.dir, '..', '..')
const SRC = join(REPO, 'src')
const distArg = process.argv.indexOf('--dist')
const DIST = distArg >= 0 && process.argv[distArg + 1] !== undefined ? process.argv[distArg + 1]! : join(REPO, 'dist', 'mercury.mjs')
const FIXTURE = join(import.meta.dir, 'mid-turn-reply-fixture-server.ts')
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

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.MERCURY_HOME

const TWO_ROUNDS_ASK = 'two tool rounds then a summary'
const SILENT_ROUNDS_ASK = 'two tool rounds, the second silent, then a summary'
const LONG_ROUND_ASK = 'answer then a long tool'
const HEARD_LEAD = 'heard mid-turn: '
const LINE_A = 'how long will this take?'
const LINE_B = 'is the second step the slow one?'
const LINE_C = 'did you see this one?'
const U0 = '00000000-0000-4000-8000-000000000000'
const UT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const UA = '11111111-1111-4111-8111-111111111111'
const UL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const UB = '22222222-2222-4222-8222-222222222222'
const US = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const UC = '33333333-3333-4333-8333-333333333333'

section('P the pure laws: which drained row earns a mark, which envelope is the reply, the mark is spent once')
{
  const drain = await import(join(SRC, 'run-core/attachment-drain.ts'))
  const { createAssistantMessage, createAssistantAPIErrorMessage } = await import(join(SRC, 'utils/messages/factories.ts'))
  const row = (attachment: Record<string, unknown>, timestamp = '2026-10-14T23:12:00.000Z') => ({ timestamp, attachment })
  const operator = row({ type: 'queued_command', prompt: 'x', source_uuid: UA, commandMode: 'prompt' })
  check('an operator prompt drained mid-turn earns a mark: its uuid and the row\'s clock', j(drain.replyMarkOf(operator)) === j({ uuid: UA, at: '2026-10-14T23:12:00.000Z' }), j(drain.replyMarkOf(operator)))
  check("an explicit human origin earns the same mark", drain.replyMarkOf(row({ type: 'queued_command', prompt: 'x', source_uuid: UA, commandMode: 'prompt', origin: { kind: 'human' } }))?.uuid === UA)
  check('a task notification earns none (not the operator\'s words)', drain.replyMarkOf(row({ type: 'queued_command', prompt: 'x', source_uuid: UA, commandMode: 'task-notification', origin: { kind: 'task-notification' } })) === null)
  check("a coordinator's or an advisor's note earns none", drain.replyMarkOf(row({ type: 'queued_command', prompt: 'x', source_uuid: UA, origin: { kind: 'coordinator' }, isMeta: true })) === null && drain.replyMarkOf(row({ type: 'queued_command', prompt: 'x', source_uuid: UA, origin: { kind: 'advisor', model: 'm' } })) === null)
  check('a hidden row or a row without identity earns none', drain.replyMarkOf(row({ type: 'queued_command', prompt: 'x', source_uuid: UA, isMeta: true })) === null && drain.replyMarkOf(row({ type: 'queued_command', prompt: 'x' })) === null && drain.replyMarkOf(row({ type: 'file', filename: 'a' })) === null)
  check('a text envelope is a reply; a tool-only, an empty and an API-error envelope are not', drain.isReplyText(createAssistantMessage({ content: 'the answer' })) === true && drain.isReplyText(createAssistantMessage({ content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] })) === false && drain.isReplyText(createAssistantMessage({ content: '' })) === false && drain.isReplyText(createAssistantAPIErrorMessage({ content: 'boom' })) === false)
  const awaiting = [{ uuid: UA, at: 'A' }, { uuid: UB, at: 'B' }]
  const apiError = drain.stampReply(createAssistantAPIErrorMessage({ content: 'boom' }), awaiting)
  check('an API-error envelope is not the model\'s message: it carries no mark and leaves the marks waiting', apiError.inReplyTo === undefined && awaiting.length === 2)
  const reply = drain.stampReply(createAssistantMessage({ content: 'the answer' }), awaiting)
  check('the first text envelope takes every waiting mark, in order, and the list is spent', j(reply.inReplyTo) === j([{ uuid: UA, at: 'A' }, { uuid: UB, at: 'B' }]) && awaiting.length === 0, j(reply.inReplyTo))
  const later = drain.stampReply(createAssistantMessage({ content: 'more text' }), awaiting)
  check('a later text envelope carries no mark (the address was spent)', later.inReplyTo === undefined)
  const expiring = [{ uuid: UA, at: 'A' }]
  const toolOnly = drain.stampReply(createAssistantMessage({ content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }] }), expiring)
  check('a tool-only first envelope carries no mark and the marks expire with it (the list is spent)', toolOnly.inReplyTo === undefined && expiring.length === 0)
  const afterToolOnly = drain.stampReply(createAssistantMessage({ content: 'text after the silent round' }), expiring)
  check('the text after a tool-only first envelope carries no mark', afterToolOnly.inReplyTo === undefined)
}

if (!existsSync(DIST)) {
  console.log(`\nFAIL ${DIST} missing — run \`bun run build.ts\` first (the drive runs the BUILT runner)`)
  process.exit(1)
}

const RUN_HOME = join(realpathSync(tmpdir()), `mercury-mid-turn-reply-${process.pid}`)
const CWD = join(RUN_HOME, 'repo')
rmSync(RUN_HOME, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })
const PROBE_KEY = 'sk-ant-mid-turn-reply-key'
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
type Frame = Record<string, unknown>
const lines: Frame[] = []
const waiters: Array<{ test: (f: Frame) => boolean; resolve: (f: Frame) => void }> = []
let stderrText = ''
const host = hostRunner({
  node: 'node',
  dist: DIST,
  argv: ['--model', 'claude-opus-4-8', '--mode', 'sovereign'],
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
function waitFor(label: string, test: (f: Frame) => boolean, timeoutMs: number, after = 0): Promise<Frame | null> {
  const seen = lines.slice(after).find(test)
  if (seen !== undefined) return Promise.resolve(seen)
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      const at = waiters.findIndex(w => w.resolve === done)
      if (at >= 0) waiters.splice(at, 1)
      console.log(`  [wait] ${label}: nothing within ${timeoutMs} ms`)
      resolve(null)
    }, timeoutMs)
    const done = (f: Frame): void => {
      clearTimeout(timer)
      resolve(f)
    }
    waiters.push({ test, resolve: done })
  })
}
type Wire = { kind: string; n: number; arm?: string; step?: number; lines?: string[]; at: number }
const wire = (): Wire[] =>
  readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .flatMap(l => {
      try {
        return [JSON.parse(l) as Wire]
      } catch {
        return []
      }
    })
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
const send = (text: string, id: string, sentAt?: string): Promise<boolean> => host.prompt(text, { id, ...(sentAt !== undefined ? { sent_at: sentAt } : {}) }).then(() => true, () => false)
const isResult = (f: Frame): boolean => f.type === 'outcome'
const isInit = (f: Frame): boolean => f.type === 'session'
const isHeardText = (f: Frame): boolean => f.type === 'text' && typeof f.text === 'string' && f.text.startsWith(HEARD_LEAD)
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
type ReplyMark = { uuid?: string; at?: string }
type Row = {
  type?: string
  uuid?: string
  timestamp?: string
  inReplyTo?: ReplyMark[]
  message?: { role?: string; content?: unknown }
  attachment?: { type?: string; source_uuid?: string; sentAt?: string; prompt?: unknown }
}
const textOf = (row: Row): string => {
  const content = row.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(b => (typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n')
}
const hasBlock = (r: Row, pred: (b: { type?: string; id?: string; tool_use_id?: string }) => boolean): boolean =>
  Array.isArray(r.message?.content) && (r.message!.content as Array<{ type?: string; id?: string; tool_use_id?: string }>).some(pred)
const findTranscript = (dir: string, sessionId: string): string | null => {
  if (!existsSync(dir)) return null
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      const hit = findTranscript(p, sessionId)
      if (hit !== null) return hit
    } else if (name === `${sessionId}.jsonl`) return p
  }
  return null
}
const reader = await import(join(SRC, 'utils/sessionStorage/transcriptReader.ts'))
const transcriptRows = async (sessionId: string): Promise<Row[]> => {
  const path = findTranscript(join(RUN_HOME, 'projects'), sessionId)
  if (path === null) return []
  return (((await reader.readTranscriptChainSince(path, null)) as { rows: Row[] }).rows ?? [])
}
const settledRows = async (sessionId: string, settled: (rows: Row[]) => boolean, timeoutMs: number): Promise<Row[]> => {
  const t0 = Date.now()
  let rows: Row[] = []
  while (Date.now() - t0 < timeoutMs) {
    rows = await transcriptRows(sessionId)
    if (settled(rows)) return rows
    await sleep(100)
  }
  return rows
}
const marksOf = (row: Row | undefined): ReplyMark[] => (Array.isArray(row?.inReplyTo) ? row!.inReplyTo : [])
const rowMarksOf = (frame: Frame | null): Array<{ id?: string; at?: string }> => (Array.isArray(frame?.in_reply_to) ? (frame!.in_reply_to as Array<{ id?: string; at?: string }>) : [])

section('R1 the runner is up')
await host.initialize().catch(() => undefined)
void send('hello there', U0)
const init = await waitFor('the session row', isInit, TURN_MS)
const first = await waitFor('the first turn', isResult, TURN_MS)
check('the first turn answered', first !== null && init !== null, stderrText.split('\n').slice(-5).join(' | '))
const sessionId = String(init?.session_id ?? '')

section('R2 a question sent while a tool runs: the answer in the next text carries the reply mark, on the transcript and on the headless row')
const beforeTwo = lines.length
void send(TWO_ROUNDS_ASK, UT)
const r1 = await waitWire('round one', w => w.kind === 'request' && w.arm === 'two' && w.step === 0, TURN_MS)
check("round one's request went out (a 4 s tool runs)", r1 !== null, stderrText.split('\n').slice(-5).join(' | '))
const TA = new Date(Date.now() - 60_000).toISOString()
await send(LINE_A, UA, TA)
const r2 = await waitWire('round two', w => w.kind === 'request' && w.arm === 'two' && w.step === 1 && w.n > (r1?.n ?? 0), TURN_MS)
check('round two carried the line to the model (the drain at the tool boundary)', r2 !== null && j(r2.lines) === j([LINE_A]), j(r2?.lines))
const heardRow = await waitFor('the heard text row', f => isHeardText(f) && lines.indexOf(f) >= beforeTwo, TURN_MS, beforeTwo)
check("the model's next text is the answer to the line (the fixture echoes it)", heardRow !== null && String(heardRow.text) === `${HEARD_LEAD}${LINE_A}`, j(heardRow?.text))
const twoResult = await waitFor('the tool turn', isResult, TURN_MS, beforeTwo)
check("the turn ended on the fixture's summary", twoResult !== null && String(twoResult.answer ?? '').startsWith('done: '), j(twoResult?.answer))

const rowsTwo = await settledRows(sessionId, rows => rows.some(r => r.type === 'assistant' && textOf(r).startsWith('done: ')), 10_000)
check("the runner's transcript is on disk", rowsTwo.length > 0, `rows=${rowsTwo.length}`)
const idxLineA = rowsTwo.findIndex(r => r.type === 'attachment' && r.attachment?.type === 'queued_command' && r.attachment.source_uuid === UA)
const idxResultOne = rowsTwo.findIndex(r => r.type === 'user' && hasBlock(r, b => b.type === 'tool_result' && b.tool_use_id === `toolu_two_r1_c${r1?.n}`))
const idxUseTwo = rowsTwo.findIndex(r => r.type === 'assistant' && hasBlock(r, b => b.type === 'tool_use' && b.id === `toolu_two_r2_c${r2?.n}`))
const idxHeard = rowsTwo.findIndex(r => r.type === 'assistant' && textOf(r).startsWith(HEARD_LEAD))
check("TODAY'S SHAPE: the line's row lands after round one's result; the answer row follows it, before round two's tool call", idxLineA > idxResultOne && idxResultOne >= 0 && idxHeard > idxLineA && idxUseTwo > idxHeard, j({ idxResultOne, idxLineA, idxHeard, idxUseTwo }))
const lineRow = rowsTwo[idxLineA]
check("the line's row carries the send clock the frame was sent with", lineRow?.timestamp === TA, j({ row: lineRow?.timestamp, sent: TA }))
const heardRecord = rowsTwo[idxHeard]
const marks = marksOf(heardRecord)
check('THE MARK ON THE TRANSCRIPT: the answer row names the line it answers (inReplyTo = the line\'s uuid, stamped with its clock)', marks.length === 1 && marks[0]!.uuid === UA && marks[0]!.at === TA, j({ inReplyTo: heardRecord?.inReplyTo }))
check('no other assistant row of the turn carries a mark (one answer, one address)', rowsTwo.filter(r => r.type === 'assistant' && r !== heardRecord && marksOf(r).length > 0).length === 0, j(rowsTwo.filter(r => r.type === 'assistant' && marksOf(r).length > 0).map(r => textOf(r).slice(0, 30))))
const heardMarks = rowMarksOf(heardRow)
check('THE MARK ON THE HEADLESS ROW: the text row carries in_reply_to with the prompt\'s own id and clock', heardMarks.length === 1 && heardMarks[0]!.id === UA && heardMarks[0]!.at === TA, j({ in_reply_to: heardRow?.in_reply_to }))
const otherTexts = lines.slice(beforeTwo).filter(f => f.type === 'text' && f !== heardRow)
check('no other text row of the turn carries the mark', otherTexts.every(f => rowMarksOf(f).length === 0), j(otherTexts.map(f => [String(f.text).slice(0, 30), f.in_reply_to])))
const doneRow = lines.slice(beforeTwo).find(f => f.type === 'text' && String(f.text).startsWith('done: '))
check("the turn's closing text (after the answer) is unmarked — the mark is the answer's alone", doneRow !== undefined && rowMarksOf(doneRow).length === 0, j(doneRow?.in_reply_to))
{
  const { jsonlConciseRows } = await import(join(SRC, 'services/resources/adapters/transcript.ts'))
  const { formatClock, REPLY_ADDRESS_LEAD } = await import(join(SRC, 'utils/messages/replyAddress.ts'))
  const concise = jsonlConciseRows(findTranscript(join(RUN_HOME, 'projects'), sessionId) ?? '') as string[]
  const answerLine = concise.find(row => row.startsWith(`assistant: ${HEARD_LEAD}`))
  check(`THE MARK ON THE mercury://transcript READER: the answer row ends "· ${REPLY_ADDRESS_LEAD} ${formatClock(TA)} message"`, answerLine !== undefined && answerLine.endsWith(` · ${REPLY_ADDRESS_LEAD} ${formatClock(TA)} message`), j(answerLine))
  check('no other assistant row of the reader carries the address', concise.filter(row => row.startsWith('assistant:') && row.includes(REPLY_ADDRESS_LEAD)).length === 1, j(concise.filter(row => row.includes(REPLY_ADDRESS_LEAD))))
}

section('R2b a question answered first by a tool call alone: the mark expires, no later text of the turn is labelled with it')
const beforeSilent = lines.length
void send(SILENT_ROUNDS_ASK, US)
const s1 = await waitWire('the silent arm, round one', w => w.kind === 'request' && w.arm === 'silent' && w.step === 0, TURN_MS)
check("round one's request went out", s1 !== null, stderrText.split('\n').slice(-5).join(' | '))
const TC = new Date(Date.now() - 45_000).toISOString()
await send(LINE_C, UC, TC)
const s2 = await waitWire('the silent arm, round two', w => w.kind === 'request' && w.arm === 'silent' && w.step === 1 && w.n > (s1?.n ?? 0), TURN_MS)
check('round two carried the line to the model', s2 !== null && j(s2.lines) === j([LINE_C]), j(s2?.lines))
const silentResult = await waitFor('the silent turn', isResult, TURN_MS, beforeSilent)
check("the turn ended on the fixture's summary", silentResult !== null && String(silentResult.answer ?? '').startsWith('done: '), j(silentResult?.answer))
const rowsSilent = await settledRows(sessionId, rows => rows.some(r => r.type === 'assistant' && textOf(r).startsWith(`done: ${SILENT_ROUNDS_ASK}`)), 10_000)
const idxLineC = rowsSilent.findIndex(r => r.type === 'attachment' && r.attachment?.type === 'queued_command' && r.attachment.source_uuid === UC)
const idxUseSilent = rowsSilent.findIndex(r => r.type === 'assistant' && hasBlock(r, b => b.type === 'tool_use' && b.id === `toolu_silent_r2_c${s2?.n}`))
check("the line's row lands on the transcript and the model's next message is the tool call alone", idxLineC >= 0 && idxUseSilent > idxLineC && textOf(rowsSilent[idxUseSilent]!).trim() === '', j({ idxLineC, idxUseSilent }))
check('NO ROW OF THE TURN CARRIES THE MARK: the tool-only message spent it', rowsSilent.filter(r => r.type === 'assistant' && marksOf(r).some(m => m.uuid === UC)).length === 0, j(rowsSilent.filter(r => r.type === 'assistant' && marksOf(r).length > 0).map(r => [textOf(r).slice(0, 30), r.inReplyTo])))
const silentTexts = lines.slice(beforeSilent).filter(f => f.type === 'text')
check('no headless text row of the turn carries in_reply_to', silentTexts.length > 0 && silentTexts.every(f => rowMarksOf(f).length === 0), j(silentTexts.map(f => [String(f.text).slice(0, 30), f.in_reply_to])))
{
  const { jsonlConciseRows } = await import(join(SRC, 'services/resources/adapters/transcript.ts'))
  const { formatClock, REPLY_ADDRESS_LEAD } = await import(join(SRC, 'utils/messages/replyAddress.ts'))
  const concise = jsonlConciseRows(findTranscript(join(RUN_HOME, 'projects'), sessionId) ?? '') as string[]
  check('the transcript reader shows no address for the line', !concise.some(row => row.includes(`${REPLY_ADDRESS_LEAD} ${formatClock(TC)} message`)), j(concise.filter(row => row.includes(REPLY_ADDRESS_LEAD))))
}

section('R3 esc after the answer is composed: the reply stays on the transcript, the cut row follows it')
const beforeLong = lines.length
void send(LONG_ROUND_ASK, UL)
const rl1 = await waitWire('the long arm, round one', w => w.kind === 'request' && w.arm === 'long' && w.step === 0, TURN_MS)
check("round one's request went out", rl1 !== null)
const TB = new Date(Date.now() - 30_000).toISOString()
await send(LINE_B, UB, TB)
const rl2 = await waitWire('the long arm, round two', w => w.kind === 'request' && w.arm === 'long' && w.step === 1 && w.n > (rl1?.n ?? 0), TURN_MS)
check('round two carried the line', rl2 !== null && j(rl2.lines) === j([LINE_B]), j(rl2?.lines))
const heardB = await waitFor('the composed answer (its text row)', f => isHeardText(f) && String(f.text) === `${HEARD_LEAD}${LINE_B}`, TURN_MS, beforeLong)
check('the answer to the line was composed and reached the host while the 30 s tool runs', heardB !== null, j(lines.slice(beforeLong).map(f => f.type)))
const toolCall = await waitFor('the long tool call row', f => f.type === 'tool_call' && f.call_id === `toolu_long_r2_c${rl2?.n}`, 10_000, beforeLong)
check('the 30 s tool call opened after the answer', toolCall !== null)
await sleep(500)
const pressedAt = Date.now()
void host.request('turn/interrupt', {}).catch(() => undefined)
const interrupted = await waitFor('the interrupted turn', isResult, 20_000, beforeLong)
check('esc ended the turn well before the tool would have', interrupted !== null && Date.now() - pressedAt < 15_000 && interrupted.status === 'interrupted', j({ status: interrupted?.status, ms: Date.now() - pressedAt }))
const rowsLong = await settledRows(sessionId, rows => rows.some(r => r.type === 'user' && textOf(r).startsWith('[Request interrupted by user')), 10_000)
const idxLineB = rowsLong.findIndex(r => r.type === 'attachment' && r.attachment?.type === 'queued_command' && r.attachment.source_uuid === UB)
const idxHeardB = rowsLong.findIndex(r => r.type === 'assistant' && textOf(r) === `${HEARD_LEAD}${LINE_B}`)
const idxCut = rowsLong.findIndex(r => r.type === 'user' && textOf(r).startsWith('[Request interrupted by user') && rowsLong.indexOf(r) > idxLineB)
const idxLongCall = rowsLong.findIndex(r => r.type === 'assistant' && hasBlock(r, b => b.type === 'tool_use' && b.id === `toolu_long_r2_c${rl2?.n}`))
const idxLongResult = rowsLong.findIndex(r => r.type === 'user' && hasBlock(r, b => b.type === 'tool_result' && b.tool_use_id === `toolu_long_r2_c${rl2?.n}`))
check('THE COMPOSED REPLY SURVIVES THE CUT: the answer row is on the transcript after the line, before the cut row', idxHeardB > idxLineB && idxLineB >= 0 && idxCut > idxHeardB, j({ idxLineB, idxHeardB, idxLongCall, idxLongResult, idxCut }))
check("the cut tool's call and its synthetic result sit between the answer and the cut row (the pairing law)", idxLongCall > idxHeardB && idxLongResult > idxLongCall && idxCut > idxLongResult, j({ idxHeardB, idxLongCall, idxLongResult, idxCut }))
const heardBRecord = rowsLong[idxHeardB]
const marksB = marksOf(heardBRecord)
check('the surviving answer carries its reply mark too', marksB.length === 1 && marksB[0]!.uuid === UB && marksB[0]!.at === TB, j({ inReplyTo: heardBRecord?.inReplyTo }))
const heardBMarks = rowMarksOf(heardB)
check("the headless row of the composed answer carried the mark before esc landed", heardBMarks.length === 1 && heardBMarks[0]!.id === UB, j(heardB?.in_reply_to))
await reap()

for (const w of wire()) if (w.kind === 'request') console.log(`  #${w.n} ${w.arm} step=${w.step} lines=${j(w.lines)}`)
if (failures === 0) rmSync(RUN_HOME, { recursive: true, force: true })
else {
  console.log(`[forensics] world kept: ${RUN_HOME}`)
  console.log(stderrText.split('\n').slice(-20).join('\n'))
}

console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-mid-turn-reply: ALL LAWS HOLD' : `prove-mid-turn-reply: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
