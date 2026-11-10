#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { handoffTurn, isHandoffRequest, startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const nodeBin = Bun.which('node')
if (!existsSync(DIST) || !nodeBin) {
  console.log(!existsSync(DIST) ? '❌ dist/mercury.mjs absent — build first (the pooled gate prebuilds it)' : '❌ no node binary on PATH')
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'finished-run-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
process.env.ANTHROPIC_API_KEY = 'fixture-key'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_EFFORT_LEVEL

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
const loaderCwd = join(scratch, 'loader-cwd')
mkdirSync(loaderCwd, { recursive: true })
bootstrap.setOriginalCwd(loaderCwd)
bootstrap.setProjectRoot(loaderCwd)
const { loadConversationForResume, getResumePrompt } = await import('../../src/utils/conversationRecovery.ts')
const { loadTranscriptFile } = await import('../../src/utils/sessionStorage.ts')
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
const { ENDED_RUN_TOOL_RESULT, NO_RESPONSE_REQUESTED } = await import('../../src/utils/messages/rejectionText.ts')
import type { Message } from '../../src/types/message.ts'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const j = (value: unknown): string => JSON.stringify(value) ?? ''

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the finished-run proof exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

const CONTINUATION = getResumePrompt()
const MODEL = 'claude-opus-4-8'

type Arena = { home: string; cwd: string; env: Record<string, string> }
function makeArena(name: string, fixture: FixtureApi, settings?: Record<string, unknown>): Arena {
  const home = join(scratch, name, 'home')
  const cwd = join(scratch, name, 'cwd')
  mkdirSync(join(home, '.mercury'), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  if (settings !== undefined) writeFileSync(join(home, '.mercury', 'settings.json'), JSON.stringify(settings))
  return {
    home,
    cwd,
    env: {
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(home, '.mercury'),
      ANTHROPIC_BASE_URL: fixture.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_VERIFY_EVIDENCE: '0',
      MERCURY_TRUST_DIALOG_ACCEPTED: '1',
    },
  }
}
function run(arena: Arena, args: string[]): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(nodeBin!, [DIST, ...args], { cwd: arena.cwd, env: arena.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += String(chunk)))
    child.stderr.on('data', chunk => (stderr += String(chunk)))
    const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.on('close', exit => {
      clearTimeout(killer)
      resolve({ exit, stdout, stderr })
    })
  })
}
function transcriptOf(arena: Arena, sessionId: string): string {
  const stack = [join(arena.home, '.mercury', 'projects')]
  while (stack.length > 0) {
    const dir = stack.pop()!
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.name === `${sessionId}.jsonl`) return path
    }
  }
  return ''
}
type StoredRow = Record<string, unknown> & { type: string; uuid: string }
async function recordOf(file: string): Promise<StoredRow[]> {
  const loaded = await loadTranscriptFile(file, { keepAllLeaves: true })
  return [...loaded.messages.values()] as unknown as StoredRow[]
}
const blocksOf = (content: unknown): Array<Record<string, unknown>> => (Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [{ type: 'text', text: String(content ?? '') }])
const kindOf = (row: StoredRow): string => {
  if (row.type === 'attachment') return `attachment:${String((row.attachment as { type?: unknown } | undefined)?.type)}`
  if (row.type === 'system') return `system:${String(row.subtype)}`
  const blocks = blocksOf((row.message as { content?: unknown } | undefined)?.content)
  return `${row.type}(${blocks.map(block => String(block.type)).join('+')})`
}
const wireOf = (request: { body: unknown } | undefined): Array<{ role: string; texts: string[] }> =>
  (((request?.body ?? {}) as { messages?: Array<{ role: string; content: unknown }> }).messages ?? []).map(message => ({
    role: message.role,
    texts: blocksOf(message.content).map(block => (block.type === 'text' ? String(block.text) : block.type === 'tool_result' ? `result:${j(block.content)}` : String(block.type))),
  }))
const says = (wire: Array<{ role: string; texts: string[] }>, words: string): number => wire.filter(message => message.texts.some(text => text.includes(words))).length
const recordSays = (rows: StoredRow[], words: string): number => rows.filter(row => (row.type === 'user' || row.type === 'assistant') && j((row.message as { content?: unknown } | undefined)?.content).includes(words)).length

let variant = 0
async function resumedFrom(rows: StoredRow[], sessionId: string): Promise<{ messages: Message[]; state: string; saysContinuation: number; saysSentinel: number; lastTalk: string }> {
  const dir = join(scratch, 'variants', String(++variant))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sessionId}.jsonl`)
  writeFileSync(file, rows.map(row => encodeTranscriptLine(file, row).line).join(''))
  const loaded = await loadConversationForResume(sessionId, file)
  const messages = (loaded?.messages ?? []) as Message[]
  const talk = messages.filter(row => row.type === 'user' || row.type === 'assistant')
  const textOf = (row: Message): string => (row.type === 'user' || row.type === 'assistant' ? j(row.message.content) : '')
  return {
    messages,
    state: loaded?.turnInterruptionState.kind ?? 'nothing loaded',
    saysContinuation: talk.filter(row => textOf(row).includes(CONTINUATION)).length,
    saysSentinel: talk.filter(row => textOf(row).includes(NO_RESPONSE_REQUESTED)).length,
    lastTalk: talk.at(-1) === undefined ? '' : `${talk.at(-1)!.type}:${textOf(talk.at(-1)!).slice(0, 200)}`,
  }
}

console.log('============================================================')
console.log(' a run whose turn finished resumes as finished')
console.log('============================================================')

try {
  section('F1 — the built bundle: one prompt, one reply, the process ends; a second and a third process resume the session')
  let firstRecord: StoredRow[] = []
  const SID1 = 'facef00d-0000-4000-8000-0000000f1a01'
  {
    const fixture = await startFixtureApi([handoffTurn(), { kind: 'text', text: 'F1-FIRST-REPLY.' }, { kind: 'text', text: 'F1-SECOND-REPLY.' }, { kind: 'text', text: 'F1-THIRD-REPLY.' }])
    const arena = makeArena('f1', fixture)
    try {
      const first = await run(arena, ['run', 'F1 first prompt.', '--model', MODEL, '--session-id', SID1, '--format', 'rows'])
      check('F1: the first run completed (exit 0, its outcome row says completed)', first.exit === 0 && first.stdout.includes('"status":"completed"') && first.stdout.includes('F1-FIRST-REPLY.'), `exit=${first.exit} ${first.stdout.slice(-300)} ${first.stderr.slice(-300)}`)
      const file = transcriptOf(arena, SID1)
      firstRecord = file === '' ? [] : await recordOf(file)
      const kinds = firstRecord.map(kindOf)
      const replyAt = kinds.lastIndexOf('assistant(text)')
      check('F1: its record ends on rows the reply left behind it (the bound-prefix record), not on the reply', replyAt !== -1 && replyAt < kinds.length - 1 && kinds.slice(replyAt + 1).every(kind => kind.startsWith('attachment:')), j(kinds))
      const second = await run(arena, ['run', 'F1 second prompt.', '--model', MODEL, '--resume', SID1, '--format', 'rows'])
      const requests = fixture.messageRequests().filter(request => !isHandoffRequest(request))
      const secondWire = wireOf(requests[1])
      check('F1: the second process answered', second.exit === 0 && second.stdout.includes('F1-SECOND-REPLY.'), `exit=${second.exit} ${second.stderr.slice(-300)}`)
      check('F1: its request does not tell the model the previous run ended before its turn finished', says(secondWire, CONTINUATION) === 0, j(secondWire.map(message => [message.role, message.texts.map(text => text.slice(0, 80))])))
      check('F1: …and carries no stand-in reply', says(secondWire, NO_RESPONSE_REQUESTED) === 0, j(secondWire.map(message => [message.role, message.texts.map(text => text.slice(0, 80))])))
      check('F1: the conversation it sends is the first prompt, the first reply, the second prompt', j(secondWire.map(message => message.role)) === j(['user', 'assistant', 'user']) && secondWire[0]!.texts.at(-1) === 'F1 first prompt.' && j(secondWire[1]!.texts) === j(['F1-FIRST-REPLY.']) && secondWire[2]!.texts.at(-1) === 'F1 second prompt.', j(secondWire.map(message => [message.role, message.texts.map(text => text.slice(0, 80))])))
      const third = await run(arena, ['run', 'F1 third prompt.', '--model', MODEL, '--resume', SID1, '--format', 'rows'])
      const thirdWire = wireOf(fixture.messageRequests().filter(request => !isHandoffRequest(request))[2])
      check('F1: the third process answered, and its request holds three prompts and two replies with nothing between them', third.exit === 0 && third.stdout.includes('F1-THIRD-REPLY.') && j(thirdWire.map(message => message.role)) === j(['user', 'assistant', 'user', 'assistant', 'user']) && says(thirdWire, CONTINUATION) === 0 && says(thirdWire, NO_RESPONSE_REQUESTED) === 0, j(thirdWire.map(message => [message.role, message.texts.map(text => text.slice(0, 80))])))
      const finalRecord = await recordOf(file)
      check('F1: the record holds neither the cut-off sentence nor a stand-in reply', recordSays(finalRecord, CONTINUATION) === 0 && recordSays(finalRecord, NO_RESPONSE_REQUESTED) === 0, j(finalRecord.map(kindOf)))
    } finally {
      await fixture.close()
    }
  }

  section('F2 — the built bundle with a turn.end hook that leaves its notice row after every reply')
  {
    const fixture = await startFixtureApi([handoffTurn(), { kind: 'text', text: 'F2-FIRST-REPLY.' }, { kind: 'text', text: 'F2-SECOND-REPLY.' }, { kind: 'text', text: 'F2-THIRD-REPLY.' }])
    const arena = makeArena('f2', fixture, { events: { hooks: { 'turn.end': [{ name: 'end note', run: `echo '${JSON.stringify({ notice: 'the end hook spoke' })}'` }] } } })
    const SID2 = 'facef00d-0000-4000-8000-0000000f2a01'
    try {
      const first = await run(arena, ['run', 'F2 first prompt.', '--model', MODEL, '--session-id', SID2, '--format', 'rows'])
      const second = await run(arena, ['run', 'F2 second prompt.', '--model', MODEL, '--resume', SID2, '--format', 'rows'])
      const file = transcriptOf(arena, SID2)
      const afterSecond = file === '' ? [] : await recordOf(file)
      const kinds = afterSecond.map(kindOf)
      check('F2: both runs completed and the record ends on the hook\'s row', first.exit === 0 && second.exit === 0 && second.stdout.includes('F2-SECOND-REPLY.') && kinds.at(-1) === 'attachment:hook', `exits ${first.exit} ${second.exit} ${j(kinds.slice(-6))} ${second.stderr.slice(-200)}`)
      const third = await run(arena, ['run', 'F2 third prompt.', '--model', MODEL, '--resume', SID2, '--format', 'rows'])
      const requests = fixture.messageRequests().filter(request => !isHandoffRequest(request))
      const secondWire = wireOf(requests[1])
      const thirdWire = wireOf(requests[2])
      check('F2: neither resumed request tells the model its previous run was cut, and neither carries a stand-in reply', third.exit === 0 && says(secondWire, CONTINUATION) === 0 && says(thirdWire, CONTINUATION) === 0 && says(secondWire, NO_RESPONSE_REQUESTED) === 0 && says(thirdWire, NO_RESPONSE_REQUESTED) === 0, j(thirdWire.map(message => [message.role, message.texts.map(text => text.slice(0, 80))])))
      check('F2: the third request holds three prompts and two replies', j(thirdWire.map(message => message.role)) === j(['user', 'assistant', 'user', 'assistant', 'user']), j(thirdWire.map(message => [message.role, message.texts.map(text => text.slice(0, 80))])))
    } finally {
      await fixture.close()
    }
  }

  section('F3 — the resume loader on F1\'s first record and on the same record cut where a stopped process would have left it')
  {
    const kinds = firstRecord.map(kindOf)
    const replyAt = kinds.lastIndexOf('assistant(text)')
    const whole = await resumedFrom(firstRecord, SID1)
    check('F3: the whole record reads as a finished turn: no cut-off sentence, no stand-in reply, the last word is the reply', whole.state === 'none' && whole.saysContinuation === 0 && whole.saysSentinel === 0 && whole.lastTalk.startsWith('assistant:') && whole.lastTalk.includes('F1-FIRST-REPLY.'), j({ state: whole.state, continuation: whole.saysContinuation, sentinel: whole.saysSentinel, last: whole.lastTalk }))
    check('F3: every row of the record is on the resumed list (the rows after the reply are kept, they only stop reading as a cut)', firstRecord.every(row => whole.messages.some(kept => kept.uuid === row.uuid)), j(firstRecord.filter(row => !whole.messages.some(kept => kept.uuid === row.uuid)).map(kindOf)))
    const beforeReply = await resumedFrom(firstRecord.slice(0, replyAt), SID1)
    check('F3 control: the prompt and its attachments with no reply after them (the process stopped before the reply was recorded) still read as cut — the sentence once, the stand-in after it', replyAt > 1 && beforeReply.state === 'interrupted_prompt' && beforeReply.saysContinuation === 1 && beforeReply.saysSentinel === 1, j({ kinds: kinds.slice(0, replyAt), state: beforeReply.state, continuation: beforeReply.saysContinuation, sentinel: beforeReply.saysSentinel }))
    const lastRow = firstRecord.at(-1)!
    const queuedBehind = { ...lastRow, uuid: '00000000-0000-4000-8000-0000000f3a01', parentUuid: lastRow.uuid, timestamp: new Date(Date.parse(String(lastRow.timestamp)) + 1000).toISOString(), attachment: { type: 'queued_command', prompt: 'F3 a message that arrived behind the reply.' } } as StoredRow
    const owed = await resumedFrom([...firstRecord, queuedBehind], SID1)
    check('F3 control: a message queued behind the reply (a row that puts words before the model) keeps the turn open — the sentence once', lastRow.type === 'attachment' && owed.state === 'interrupted_prompt' && owed.saysContinuation === 1, j({ state: owed.state, continuation: owed.saysContinuation, last: owed.lastTalk }))
    const promptAlone = await resumedFrom(firstRecord.slice(0, 1), SID1)
    check('F3 control: the prompt alone reads as an unanswered prompt, as before (no sentence, the stand-in after it)', kinds[0] === 'user(text)' && promptAlone.state === 'interrupted_prompt' && promptAlone.saysContinuation === 0 && promptAlone.saysSentinel === 1, j({ state: promptAlone.state, continuation: promptAlone.saysContinuation, sentinel: promptAlone.saysSentinel }))
  }

  section('F4 — a tool round the built bundle recorded, whole and cut at each place a stopped process leaves it')
  {
    const SID4 = 'facef00d-0000-4000-8000-0000000f4a01'
    const readTurn: ScriptedTurn = { kind: 'tool_use', name: 'Read', input: {} }
    const fixture = await startFixtureApi([handoffTurn(), readTurn, { kind: 'text', text: 'F4-CLOSING-REPLY.' }])
    const arena = makeArena('f4', fixture)
    const note = join(arena.cwd, 'note.txt')
    writeFileSync(note, 'F4-NOTE-CONTENT\n')
    ;(readTurn as Extract<ScriptedTurn, { kind: 'tool_use' }>).input = { file_path: note }
    try {
      const first = await run(arena, ['run', 'F4 read the note.', '--model', MODEL, '--session-id', SID4, '--mode', 'implement', '--format', 'rows'])
      const file = transcriptOf(arena, SID4)
      const record = file === '' ? [] : await recordOf(file)
      const kinds = record.map(kindOf)
      const callAt = kinds.findIndex(kind => kind.startsWith('assistant(') && kind.includes('tool_use'))
      const resultAt = kinds.findIndex(kind => kind === 'user(tool_result)')
      const closingAt = kinds.lastIndexOf('assistant(text)')
      check('F4: the run completed through one Read and the record holds the call, its result and the closing reply in that order', first.exit === 0 && first.stdout.includes('F4-CLOSING-REPLY.') && callAt !== -1 && resultAt > callAt && closingAt > resultAt, `exit=${first.exit} ${j(kinds)} ${first.stderr.slice(-300)}`)
      const whole = await resumedFrom(record, SID4)
      check('F4: the whole record reads as a finished turn', whole.state === 'none' && whole.saysContinuation === 0 && whole.saysSentinel === 0, j({ state: whole.state, continuation: whole.saysContinuation, sentinel: whole.saysSentinel, last: whole.lastTalk }))
      const afterResult = await resumedFrom(record.slice(0, closingAt), SID4)
      check('F4 control: cut after the result (and whatever rows followed it) and before the closing reply, the turn still reads as cut — the sentence once', afterResult.state === 'interrupted_prompt' && afterResult.saysContinuation === 1, j({ kinds: kinds.slice(0, closingAt), state: afterResult.state, continuation: afterResult.saysContinuation }))
      const afterCall = await resumedFrom(record.slice(0, resultAt), SID4)
      const settled = afterCall.messages.filter(row => row.type === 'user' && j(row.message.content).includes(ENDED_RUN_TOOL_RESULT)).length
      check('F4 control: cut after the call (and the rows the reply left behind it) and before its result, the call is answered by the ended-run sentence and the turn reads as cut — a row after a reply does not make an open call a finished turn', kinds.slice(callAt + 1, resultAt).some(kind => kind.startsWith('attachment:')) && settled === 1 && afterCall.state === 'interrupted_prompt' && afterCall.saysContinuation === 1, j({ between: kinds.slice(callAt, resultAt), settled, state: afterCall.state, continuation: afterCall.saysContinuation }))
    } finally {
      await fixture.close()
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n============================================================')
console.log(failures === 0 ? ` ✅ FINISHED RUN RESUMES FINISHED (${checks} checks)` : ` ❌ ${failures} of ${checks} FINISHED-RUN CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
