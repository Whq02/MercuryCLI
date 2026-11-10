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
      MERCURY_TMPDIR: join(scratch, name, 'tmp'),
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

  section('F5 — the built bundle stopped hard inside its first reply: one text block settled, the stream still open, then signal 9; a second process resumes')
  {
    const SID5 = 'facef00d-0000-4000-8000-0000000f5a01'
    const fixture = await startFixtureApi([handoffTurn(), { kind: 'die', settled: ['F5-SETTLED-BLOCK of a reply that never ended.'], deltas: ['half', ' of a', ' second block'], gapMs: 4000 }, { kind: 'text', text: 'F5-RESUMED-REPLY.' }])
    const arena = makeArena('f5', fixture)
    try {
      const child = spawn(nodeBin!, [DIST, 'run', 'F5 first prompt.', '--model', MODEL, '--session-id', SID5, '--format', 'rows'], { cwd: arena.cwd, env: arena.env })
      child.stdout.on('data', () => {})
      child.stderr.on('data', () => {})
      const exited = new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
      let file = ''
      let kinds: string[] = []
      const until = Date.now() + 12_000
      while (Date.now() < until) {
        file = file === '' ? transcriptOf(arena, SID5) : file
        kinds = file === '' ? [] : (await recordOf(file)).map(kindOf)
        const blockAt = kinds.lastIndexOf('assistant(text)')
        if (blockAt !== -1 && blockAt < kinds.length - 1) break
        await new Promise(tick => setTimeout(tick, 100))
      }
      child.kill('SIGKILL')
      await exited
      const record = file === '' ? [] : await recordOf(file)
      kinds = record.map(kindOf)
      const blockAt = kinds.lastIndexOf('assistant(text)')
      const block = record[blockAt]
      const stopReason = (block?.message as { stop_reason?: unknown } | undefined)?.stop_reason ?? null
      check('F5: the record holds the settled block with no stop reason (its reply never ended) and ends on a row the block left behind it', block !== undefined && stopReason === null && blockAt < kinds.length - 1 && kinds.slice(blockAt + 1).every(kind => kind.startsWith('attachment:')), j({ kinds, stopReason }))
      const loaded = await resumedFrom(record, SID5)
      check('F5: the loader reads the turn as cut — the sentence once (rows after a reply that never ended do not make it a finished turn)', loaded.state === 'interrupted_prompt' && loaded.saysContinuation === 1, j({ state: loaded.state, continuation: loaded.saysContinuation, last: loaded.lastTalk }))
      const second = await run(arena, ['run', 'F5 second prompt.', '--model', MODEL, '--resume', SID5, '--format', 'rows'])
      const requests = fixture.messageRequests().filter(request => !isHandoffRequest(request))
      const resumedWire = wireOf(requests.at(-1))
      check('F5: the second process answered, and its request tells the model the previous run ended before its turn finished, once', second.exit === 0 && second.stdout.includes('F5-RESUMED-REPLY.') && says(resumedWire, CONTINUATION) === 1, `exit=${second.exit} ${j(resumedWire.map(message => [message.role, message.texts.map(text => text.slice(0, 80))]))}`)
    } finally {
      await fixture.close()
    }
  }

  section('F6 — the built bundle stopped hard inside a LATER reply: a finished first run, then a second process stopped by signal 9 after one block of its reply settled; nothing stands behind that block; a third process resumes')
  {
    const SID6 = 'facef00d-0000-4000-8000-0000000f6a01'
    const fixture = await startFixtureApi([handoffTurn(), { kind: 'text', text: 'F6-FIRST-REPLY.' }, { kind: 'die', settled: ['F6-SETTLED-BLOCK of a later reply that never ended.'], deltas: ['half', ' of a', ' second block'], gapMs: 4000 }, { kind: 'text', text: 'F6-RESUMED-REPLY.' }])
    const arena = makeArena('f6', fixture)
    try {
      const first = await run(arena, ['run', 'F6 first prompt.', '--model', MODEL, '--session-id', SID6, '--format', 'rows'])
      const child = spawn(nodeBin!, [DIST, 'run', 'F6 second prompt.', '--model', MODEL, '--resume', SID6, '--format', 'rows'], { cwd: arena.cwd, env: arena.env })
      child.stdout.on('data', () => {})
      child.stderr.on('data', () => {})
      const exited = new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
      const file = transcriptOf(arena, SID6)
      const until = Date.now() + 12_000
      while (Date.now() < until) {
        if (file !== '' && recordSays(await recordOf(file), 'F6-SETTLED-BLOCK') > 0) break
        await new Promise(tick => setTimeout(tick, 100))
      }
      await new Promise(tick => setTimeout(tick, 400))
      child.kill('SIGKILL')
      await exited
      const record = file === '' ? [] : await recordOf(file)
      const kinds = record.map(kindOf)
      const block = record.at(-1)
      const stopReason = (block?.message as { stop_reason?: unknown } | undefined)?.stop_reason ?? null
      check('F6: the first run completed, and the record ends on the settled block itself, with no stop reason and no row behind it', first.exit === 0 && kinds.at(-1) === 'assistant(text)' && j(block?.message).includes('F6-SETTLED-BLOCK') && stopReason === null, j({ exit: first.exit, tail: kinds.slice(-4), stopReason }))
      const loaded = await resumedFrom(record, SID6)
      check('F6: the loader reads the turn as cut — the sentence once, after the block', loaded.state === 'interrupted_prompt' && loaded.saysContinuation === 1, j({ state: loaded.state, continuation: loaded.saysContinuation, last: loaded.lastTalk }))
      const third = await run(arena, ['run', 'F6 third prompt.', '--model', MODEL, '--resume', SID6, '--format', 'rows'])
      const resumedWire = wireOf(fixture.messageRequests().filter(request => !isHandoffRequest(request)).at(-1))
      const blockAt = resumedWire.findIndex(message => message.role === 'assistant' && message.texts.some(text => text.includes('F6-SETTLED-BLOCK')))
      check('F6: the third process answered, and its request tells the model, right after the block, that the previous run ended before its turn finished', third.exit === 0 && third.stdout.includes('F6-RESUMED-REPLY.') && blockAt !== -1 && says(resumedWire, CONTINUATION) === 1 && resumedWire[blockAt + 1]?.texts.some(text => text.includes(CONTINUATION)) === true, `exit=${third.exit} ${j(resumedWire.map(message => [message.role, message.texts.map(text => text.slice(0, 80))]))}`)

      const whole = firstRecord.findLast(row => kindOf(row) === 'assistant(text)')!
      const upTo = firstRecord.slice(0, firstRecord.indexOf(whole))
      const after = (row: StoredRow, n: number, patch: Record<string, unknown>): StoredRow => ({ ...row, uuid: `00000000-0000-4000-8000-0000000f6c${String(n).padStart(2, '0')}`, parentUuid: row.uuid, timestamp: new Date(Date.parse(String(row.timestamp)) + n * 1000).toISOString(), ...patch }) as StoredRow
      const messageOf = (row: StoredRow): Record<string, unknown> => row.message as Record<string, unknown>
      const ended = await resumedFrom([...upTo, whole], SID1)
      check('F6 control: a record that ends on a whole reply (its stop reason on the row) reads as finished', (messageOf(whole).stop_reason ?? null) !== null && ended.state === 'none' && ended.saysContinuation === 0, j({ stop: messageOf(whole).stop_reason, state: ended.state }))
      const head = { ...whole, message: { ...messageOf(whole), stop_reason: null } } as StoredRow
      const blankTail = after(head, 1, { message: { ...messageOf(whole), content: [{ type: 'text', text: '\n\n' }] } })
      const filtered = await resumedFrom([...upTo, head, blankTail], SID1)
      check('F6 control: a whole reply whose last block the load drops (whitespace only) is judged by its reply, not by the block left standing — finished', filtered.state === 'none' && filtered.saysContinuation === 0 && !filtered.messages.some(row => row.uuid === blankTail.uuid), j({ state: filtered.state, continuation: filtered.saysContinuation, dropped: !filtered.messages.some(row => row.uuid === blankTail.uuid) }))
      const errorRow = (parent: StoredRow, n: number, cause: string, words: string): StoredRow => ({ ...whole, uuid: `00000000-0000-4000-8000-0000000f6e${String(n).padStart(2, '0')}`, parentUuid: parent.uuid, timestamp: new Date(Date.parse(String(parent.timestamp)) + n * 1000).toISOString(), isApiErrorMessage: true, apiError: cause, error: cause, message: { ...messageOf(whole), id: `msg_f6_error_${n}`, model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: words }] } }) as StoredRow
      const failed = await resumedFrom([...upTo, head, errorRow(head, 2, 'unknown', 'API Error: the fixture refused the request.')], SID1)
      check('F6 control: a reply with no stop reason followed by the error row its turn ended on is not read as stopped from outside — no sentence', failed.state === 'none' && failed.saysContinuation === 0, j({ state: failed.state, continuation: failed.saysContinuation, last: failed.lastTalk }))
      const trailing = firstRecord.slice(firstRecord.indexOf(whole) + 1)
      const stamped = (stop: string): StoredRow => ({ ...whole, message: { ...messageOf(whole), stop_reason: stop } }) as StoredRow
      const verdicts: Record<string, string> = {}
      for (const stop of ['end_turn', 'stop_sequence', 'refusal', 'pause_turn', 'max_tokens']) verdicts[stop] = (await resumedFrom([...upTo, stamped(stop), ...trailing], SID1)).state
      check('F6 control: with rows behind it, a reply reads as a finished turn only on a stop reason that ends a turn (end_turn, stop_sequence, refusal) — one the run goes on after (pause_turn, max_tokens) reads as cut, as before', trailing.length > 0 && j(verdicts) === j({ end_turn: 'none', stop_sequence: 'none', refusal: 'none', pause_turn: 'interrupted_prompt', max_tokens: 'interrupted_prompt' }), j(verdicts))
      const alone: Record<string, string> = {}
      for (const stop of ['end_turn', 'stop_sequence', 'refusal', 'pause_turn', 'max_tokens']) alone[stop] = (await resumedFrom([...upTo, stamped(stop)], SID1)).state
      check('F6: with nothing behind it the same rule — a reply the provider paused (pause_turn) or cut at the output cap on the road that asks again (max_tokens) was still in its turn when the record stops, and reads as cut', j(alone) === j({ end_turn: 'none', stop_sequence: 'none', refusal: 'none', pause_turn: 'interrupted_prompt', max_tokens: 'interrupted_prompt' }), j(alone))
      const capError = (parent: StoredRow): StoredRow => errorRow(parent, 3, 'max_output_tokens', 'API Error: the response exceeded the output token maximum.')
      const cappedForGood = await resumedFrom([...upTo, stamped('max_tokens'), capError(stamped('max_tokens'))], SID1)
      const cappedForGoodTrailed = await resumedFrom([...upTo, stamped('max_tokens'), ...trailing, capError(trailing.at(-1)!)], SID1)
      check('F6 control: the same capped reply with the output-cap error row its turn ended on — finished, with or without rows between them', cappedForGood.state === 'none' && cappedForGoodTrailed.state === 'none' && cappedForGood.saysContinuation === 0 && cappedForGoodTrailed.saysContinuation === 0, j({ alone: cappedForGood.state, trailed: cappedForGoodTrailed.state }))
      const otherRoads: Record<string, string> = {}
      for (const model of ['gpt-5.6-sol', 'local/qwen3.8-27b-32k:latest']) {
        const capped = { ...whole, message: { ...messageOf(whole), model, stop_reason: 'max_tokens' } } as StoredRow
        otherRoads[model] = `${(await resumedFrom([...upTo, capped], SID1)).state}/${(await resumedFrom([...upTo, capped, ...trailing], SID1)).state}`
      }
      check('F6 control: on a road where the output cap ends the turn (nothing asks again there) a capped reply reads as finished, alone and with rows behind it', j(otherRoads) === j({ 'gpt-5.6-sol': 'none/none', 'local/qwen3.8-27b-32k:latest': 'none/none' }), j(otherRoads))
      const seated: Record<string, string> = {}
      for (const [written, session] of [['gpt-5.6-sol', MODEL], [MODEL, 'gpt-5.6-sol']] as const) {
        bootstrap.setEngineModelOverride(session)
        try {
          seated[`${written} read under ${session}`] = (await resumedFrom([...upTo, { ...whole, message: { ...messageOf(whole), model: written, stop_reason: 'max_tokens' } } as StoredRow], SID1)).state
        } finally {
          bootstrap.setEngineModelOverride(undefined)
        }
      }
      check('F6 control: the capped reply is judged by the model stamped on its own row, not by the model the session is seated on when it resumes', j(seated) === j({ [`gpt-5.6-sol read under ${MODEL}`]: 'none', [`${MODEL} read under gpt-5.6-sol`]: 'interrupted_prompt' }), j(seated))
      const failedTrailed = await resumedFrom([...upTo, head, ...trailing.map((row, i) => (i === 0 ? { ...row, parentUuid: head.uuid } : row) as StoredRow), errorRow(trailing.at(-1)!, 4, 'unknown', 'API Error: the fixture refused the request.')], SID1)
      check('F6 control: a reply with no stop reason, its trailing rows, then the error row its turn ended on — no sentence (the record says how the turn ended)', failedTrailed.state === 'none' && failedTrailed.saysContinuation === 0, j({ state: failedTrailed.state, continuation: failedTrailed.saysContinuation }))
      const blankBeforeTrail = await resumedFrom([...upTo, head, blankTail, ...trailing.map((row, i) => (i === 0 ? { ...row, parentUuid: blankTail.uuid } : row) as StoredRow)], SID1)
      check('F6 control: the same blank last block with the reply\'s trailing rows behind it — finished', blankBeforeTrail.state === 'none' && blankBeforeTrail.saysContinuation === 0, j({ state: blankBeforeTrail.state, continuation: blankBeforeTrail.saysContinuation }))
      const { stop_reason: _unstated, ...unstatedMessage } = messageOf(whole)
      const unstated = await resumedFrom([...upTo, { ...whole, message: unstatedMessage } as StoredRow], SID1)
      check('F6 control: a reply row that states no stop reason at all (a record another writer made) reads as before — finished', unstated.state === 'none' && unstated.saysContinuation === 0, j({ state: unstated.state, continuation: unstated.saysContinuation }))
    } finally {
      await fixture.close()
    }
  }

  section('F7 — the built bundle, a whole reply whose last block is blank: two text blocks, the second only spaces, then the stream ends as usual; a second process resumes')
  {
    const SID7 = 'facef00d-0000-4000-8000-0000000f7a01'
    const fixture = await startFixtureApi([handoffTurn(), { kind: 'stream', blocks: [{ type: 'text', deltas: ['F7-FIRST-BLOCK of a whole reply.'] }, { type: 'text', deltas: ['   '] }], gapMs: 5 }, { kind: 'text', text: 'F7-SECOND-REPLY.' }])
    const arena = makeArena('f7', fixture)
    try {
      const first = await run(arena, ['run', 'F7 first prompt.', '--model', MODEL, '--session-id', SID7, '--format', 'rows'])
      const file = transcriptOf(arena, SID7)
      const record = file === '' ? [] : await recordOf(file)
      const replies = record.filter(row => row.type === 'assistant')
      const stops = replies.map(row => (row.message as { stop_reason?: unknown }).stop_reason ?? null)
      check('F7: the run completed and its record holds the reply as two rows — the words with no stop reason, the blank block with the stop reason', first.exit === 0 && first.stdout.includes('"status":"completed"') && replies.length === 2 && j(stops) === j([null, 'end_turn']) && j(replies[1]?.message).includes('"   "'), `exit=${first.exit} ${j({ kinds: record.map(kindOf), stops })}`)
      const loaded = await resumedFrom(record, SID7)
      check('F7: the loader reads the turn as finished (the reply ended, though the row that says so is dropped as blank) and does not bring the blank block back', loaded.state === 'none' && loaded.saysContinuation === 0 && loaded.saysSentinel === 0 && loaded.messages.filter(row => row.type === 'assistant').length === 1, j({ state: loaded.state, continuation: loaded.saysContinuation, sentinel: loaded.saysSentinel, replies: loaded.messages.filter(row => row.type === 'assistant').length }))
      const second = await run(arena, ['run', 'F7 second prompt.', '--model', MODEL, '--resume', SID7, '--format', 'rows'])
      const resumedWire = wireOf(fixture.messageRequests().filter(request => !isHandoffRequest(request)).at(-1))
      check('F7: the second process answered, and its request is the first prompt, the reply\'s words, the second prompt — no cut-off sentence, no stand-in reply', second.exit === 0 && second.stdout.includes('F7-SECOND-REPLY.') && j(resumedWire.map(message => message.role)) === j(['user', 'assistant', 'user']) && says(resumedWire, CONTINUATION) === 0 && says(resumedWire, NO_RESPONSE_REQUESTED) === 0, `exit=${second.exit} ${j(resumedWire.map(message => [message.role, message.texts.map(text => text.slice(0, 80))]))}`)
    } finally {
      await fixture.close()
    }
  }

  section('F8 — a record the shipped 1.0.8 left for a finished turn, in its on-disk form: the reply\'s row written with no stop reason while it streamed, then the line that settles the same row with end_turn; the bound-prefix record behind it')
  {
    const SID8 = 'facef00d-0000-4000-8000-0000000f8a01'
    const dir = join(scratch, 'old-build')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${SID8}.jsonl`)
    let clock = Date.parse('2026-11-09T09:00:00.000Z')
    let parent: string | null = null
    const uid = (n: number): string => `00000000-0000-4000-8000-${String(108000000000 + n).slice(0, 12)}`
    const chained = (row: Record<string, unknown>): Record<string, unknown> => {
      const out = { parentUuid: parent, isSidechain: false, cwd: dir, sessionId: SID8, version: '1.0.8', gitBranch: 'main', timestamp: new Date((clock += 1000)).toISOString(), ...row }
      parent = row.uuid as string
      return out
    }
    const replyRow = (uuid: string, id: string, text: string, stop: string | null): Record<string, unknown> => ({ uuid, type: 'assistant', requestId: `req_${id}`, message: { id, type: 'message', role: 'assistant', model: MODEL, stop_reason: stop, stop_sequence: null, content: [{ type: 'text', text }] } })
    const settledReply = (uuid: string, id: string, text: string): string => {
      const streamed = chained(replyRow(uuid, id, text, null))
      const published = encodeTranscriptLine(file, streamed)
      return published.line + encodeTranscriptLine(file, { ...streamed, ...replyRow(uuid, id, text, 'end_turn') }, { settleCreationOrdinal: String(published.record.creationOrdinal) }).line
    }
    const plain = (row: Record<string, unknown>): string => encodeTranscriptLine(file, chained(row)).line
    const firstTurn = plain({ uuid: uid(1), type: 'user', message: { role: 'user', content: 'F8 first prompt.' } }) + settledReply(uid(2), 'msg_f8_1', 'F8-FIRST-REPLY.') + plain({ uuid: uid(3), type: 'attachment', attachment: { type: 'bound_prefix', boundKey: 'f8', rosterEnabled: false, roster: [], sections: [], systemContext: {} } })
    writeFileSync(file, firstTurn)
    const onDisk = firstTurn.split('\n').filter(Boolean).map(line => JSON.parse(line) as { recordId?: string; updates?: string; payload?: { kind?: string; outcome?: { stopReason?: unknown } } }).filter(record => record.payload?.kind === 'output')
    check('F8: the file holds the reply as two lines of one record — published with no stop reason, then updated with end_turn', onDisk.length === 2 && onDisk[0]!.recordId === onDisk[1]!.recordId && onDisk[1]!.updates === onDisk[0]!.recordId && (onDisk[0]!.payload?.outcome?.stopReason ?? null) === null && onDisk[1]!.payload?.outcome?.stopReason === 'end_turn', j(onDisk.map(record => [record.updates ?? null, record.payload?.outcome ?? null])))
    const loaded = await loadConversationForResume(SID8, file)
    const talk = ((loaded?.messages ?? []) as Message[]).filter(row => row.type === 'user' || row.type === 'assistant')
    check('F8: the loader reads it as a finished turn — the prompt and the reply, no cut-off sentence, no stand-in reply', loaded?.turnInterruptionState.kind === 'none' && talk.length === 2 && !j(talk.map(row => (row.type === 'user' || row.type === 'assistant' ? row.message.content : null))).includes(CONTINUATION), j({ state: loaded?.turnInterruptionState.kind, talk: talk.length }))
    const secondTurn = plain({ uuid: uid(4), type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: CONTINUATION }] } }) + settledReply(uid(5), 'msg_f8_sentinel', NO_RESPONSE_REQUESTED) + plain({ uuid: uid(6), type: 'user', message: { role: 'user', content: 'F8 second prompt.' } }) + settledReply(uid(7), 'msg_f8_2', 'F8-SECOND-REPLY.')
    writeFileSync(file, firstTurn + secondTurn)
    const later = await loadConversationForResume(SID8, file)
    const laterTalk = ((later?.messages ?? []) as Message[]).filter(row => row.type === 'user' || row.type === 'assistant')
    check('F8: the same record after 1.0.8 resumed it once (its own cut-off sentence and stand-in reply are rows of the record) and finished a second turn — finished, nothing added to what the record holds', later?.turnInterruptionState.kind === 'none' && laterTalk.length === 6 && laterTalk.filter(row => j(row.type === 'user' || row.type === 'assistant' ? row.message.content : null).includes(CONTINUATION)).length === 1, j({ state: later?.turnInterruptionState.kind, talk: laterTalk.length }))
  }

  const stopOf = (row: StoredRow | undefined): unknown => (row?.message as { stop_reason?: unknown } | undefined)?.stop_reason ?? null
  const noticeSays = (row: StoredRow, words: string): boolean => row.type === 'system' && String(row.content ?? '').includes(words)
  async function stoppedOnceRecorded(arena: Arena, args: string[], sessionId: string, recorded: (rows: StoredRow[]) => boolean, inFlight: Promise<unknown>): Promise<StoredRow[]> {
    const child = spawn(nodeBin!, [DIST, ...args], { cwd: arena.cwd, env: arena.env })
    child.stdout.on('data', () => {})
    child.stderr.on('data', () => {})
    const exited = new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
    await Promise.race([inFlight, exited, new Promise(resolve => setTimeout(resolve, 30_000))])
    const until = Date.now() + 12_000
    while (Date.now() < until) {
      const file = transcriptOf(arena, sessionId)
      if (file !== '' && recorded(await recordOf(file))) break
      await new Promise(tick => setTimeout(tick, 100))
    }
    child.kill('SIGKILL')
    await exited
    const file = transcriptOf(arena, sessionId)
    return file === '' ? [] : await recordOf(file)
  }

  section('F9 — the built bundle at its own pause limit: the provider pauses nine replies in a row, the run sends eight back and then ends the turn itself; a second process resumes')
  {
    const SID9 = 'facef00d-0000-4000-8000-0000000f9a01'
    const paused = (n: number): ScriptedTurn => ({ kind: 'text', text: `F9-PAUSED-INSTALMENT-${n}.`, stopReason: 'pause_turn' })
    const fixture = await startFixtureApi([handoffTurn(), ...Array.from({ length: 9 }, (_, n) => paused(n + 1)), { kind: 'text', text: 'F9-SECOND-REPLY.' }])
    const arena = makeArena('f9', fixture)
    try {
      const first = await run(arena, ['run', 'F9 first prompt.', '--model', MODEL, '--session-id', SID9, '--format', 'rows'])
      const file = transcriptOf(arena, SID9)
      const record = file === '' ? [] : await recordOf(file)
      const replies = record.filter(row => row.type === 'assistant')
      const lastReply = replies.at(-1)
      const behind = lastReply === undefined ? [] : record.slice(record.indexOf(lastReply) + 1)
      const decision = behind.find(row => noticeSays(row, 'paused the turn 8 times in a row'))
      check('F9: the run ended its turn by its own rule (exit 0, completed) on the ninth paused reply, and the record holds that reply stamped pause_turn with the notice of the decision behind it', first.exit === 0 && first.stdout.includes('"status":"completed"') && replies.length === 9 && stopOf(lastReply) === 'pause_turn' && decision !== undefined && noticeSays(decision, 'the turn ends here'), `exit=${first.exit} ${j({ kinds: record.map(kindOf).slice(-6), stop: stopOf(lastReply), behind: behind.map(row => String(row.content ?? kindOf(row)).slice(0, 120)) })} ${first.stderr.slice(-200)}`)
      const loaded = await resumedFrom(record, SID9)
      check('F9: the loader reads the turn as finished — the run ended it, nothing stopped it from outside: no cut-off sentence, no stand-in reply', loaded.state === 'none' && loaded.saysContinuation === 0 && loaded.saysSentinel === 0, j({ state: loaded.state, continuation: loaded.saysContinuation, sentinel: loaded.saysSentinel, last: loaded.lastTalk }))
      const second = await run(arena, ['run', 'F9 second prompt.', '--model', MODEL, '--resume', SID9, '--format', 'rows'])
      const resumedWire = wireOf(fixture.messageRequests().filter(request => !isHandoffRequest(request)).at(-1))
      check('F9: the second process answered, and its request holds the nine instalments and then the second prompt, with no cut-off sentence and no stand-in reply between them', second.exit === 0 && second.stdout.includes('F9-SECOND-REPLY.') && says(resumedWire, CONTINUATION) === 0 && says(resumedWire, NO_RESPONSE_REQUESTED) === 0 && says(resumedWire, 'F9-PAUSED-INSTALMENT-9.') === 1 && resumedWire.at(-1)?.role === 'user' && resumedWire.at(-1)?.texts.at(-1) === 'F9 second prompt.', `exit=${second.exit} ${j(resumedWire.map(message => [message.role, message.texts.map(text => text.slice(0, 80))]))}`)
      const beforeDecision = decision === undefined ? [] : record.slice(0, record.indexOf(decision))
      const undecided = await resumedFrom(beforeDecision, SID9)
      check('F9 control: the same record stopped one row earlier — the ninth pause on record, the run\'s decision not — reads as cut: the sentence once', beforeDecision.at(-1) === lastReply && undecided.state === 'interrupted_prompt' && undecided.saysContinuation === 1, j({ last: beforeDecision.at(-1) === undefined ? null : kindOf(beforeDecision.at(-1)!), state: undecided.state, continuation: undecided.saysContinuation }))
      const sentBack = decision === undefined ? [] : record.map(row => (row === decision ? ({ ...decision, level: 'suggestion', content: 'the provider paused the turn mid-work — sending it back to continue (8 of 8); it counts as a turn' } as StoredRow) : row))
      const stillGoing = await resumedFrom(sentBack, SID9)
      check('F9 control: with a notice behind the paused reply that says the turn goes on (the line a continuation leaves) the turn reads as cut — a row behind the reply is not the decision, its words are', stillGoing.state === 'interrupted_prompt' && stillGoing.saysContinuation === 1, j({ state: stillGoing.state, continuation: stillGoing.saysContinuation }))
    } finally {
      await fixture.close()
    }
  }

  section('F9 — the built bundle stopped hard in mid-work: the provider pauses the first reply, the run sends it back, and signal 9 arrives while that continuation is in flight; a second process resumes')
  {
    const SID9K = 'facef00d-0000-4000-8000-0000000f9b01'
    const fixture = await startFixtureApi([handoffTurn(), { kind: 'text', text: 'F9K-PAUSED-REPLY, the work still going.', stopReason: 'pause_turn' }, { kind: 'hang', deltas: ['thinking'] }, { kind: 'text', text: 'F9K-RESUMED-REPLY.' }])
    const arena = makeArena('f9k', fixture)
    try {
      const record = await stoppedOnceRecorded(arena, ['run', 'F9K first prompt.', '--model', MODEL, '--session-id', SID9K, '--format', 'rows'], SID9K, rows => rows.some(row => row.type === 'assistant' && stopOf(row) === 'pause_turn'), fixture.messageRequestStarted(2))
      const reply = record.findLast(row => row.type === 'assistant')
      const behind = reply === undefined ? [] : record.slice(record.indexOf(reply) + 1)
      check('F9: the record holds the paused reply stamped pause_turn, and nothing behind it says the turn ends', stopOf(reply) === 'pause_turn' && j(reply?.message).includes('F9K-PAUSED-REPLY') && !behind.some(row => noticeSays(row, 'the turn ends here')), j({ kinds: record.map(kindOf), stop: stopOf(reply), behind: behind.map(row => String(row.content ?? kindOf(row)).slice(0, 120)) }))
      const loaded = await resumedFrom(record, SID9K)
      check('F9: the loader reads the turn as cut — the sentence once (a pause in mid-work is not a finished turn)', loaded.state === 'interrupted_prompt' && loaded.saysContinuation === 1, j({ state: loaded.state, continuation: loaded.saysContinuation, last: loaded.lastTalk }))
      const second = await run(arena, ['run', 'F9K second prompt.', '--model', MODEL, '--resume', SID9K, '--format', 'rows'])
      const resumedWire = wireOf(fixture.messageRequests().filter(request => !isHandoffRequest(request)).at(-1))
      const replyAt = resumedWire.findIndex(message => message.role === 'assistant' && message.texts.some(text => text.includes('F9K-PAUSED-REPLY')))
      check('F9: the second process answered, and its request tells the model, right after the paused reply, that the previous run ended before its turn finished', second.exit === 0 && second.stdout.includes('F9K-RESUMED-REPLY.') && replyAt !== -1 && says(resumedWire, CONTINUATION) === 1 && resumedWire[replyAt + 1]?.texts.some(text => text.includes(CONTINUATION)) === true, `exit=${second.exit} ${j(resumedWire.map(message => [message.role, message.texts.map(text => text.slice(0, 80))]))}`)
    } finally {
      await fixture.close()
    }
  }

  section('F10 — the built bundle at the output ceiling on the road that asks again: the reply is cut at the cap, the run asks the model to go on, the continuation repeats what stood and the run ends the turn itself; a second process resumes')
  {
    const SID10 = 'facef00d-0000-4000-8000-0000000fa001'
    const capped: ScriptedTurn = { kind: 'text', text: 'F10-CAPPED-REPLY that ran into the output ceiling', stopReason: 'max_tokens' }
    const fixture = await startFixtureApi([handoffTurn(), capped, capped, { kind: 'text', text: 'F10-SECOND-REPLY.' }])
    const arena = makeArena('f10', fixture)
    try {
      const first = await run(arena, ['run', 'F10 first prompt.', '--model', MODEL, '--session-id', SID10, '--format', 'rows'])
      const asked = fixture.messageRequests().filter(request => !isHandoffRequest(request)).length
      const file = transcriptOf(arena, SID10)
      const record = file === '' ? [] : await recordOf(file)
      const replies = record.filter(row => row.type === 'assistant' && row.isApiErrorMessage !== true)
      const lastReply = replies.at(-1)
      const behind = lastReply === undefined ? [] : record.slice(record.indexOf(lastReply) + 1)
      check('F10: the run asked twice, ended the turn itself and said so (its outcome row: failed, stop max_tokens); the record holds the capped reply stamped max_tokens, and behind it the notice that the turn ends here and the output-cap error row', asked === 2 && first.stdout.includes('"status":"failed"') && first.stdout.includes('"stop":"max_tokens"') && stopOf(lastReply) === 'max_tokens' && behind.some(row => noticeSays(row, 'the turn ends here')) && behind.some(row => row.type === 'assistant' && row.isApiErrorMessage === true), `exit=${first.exit} asked=${asked} ${j({ kinds: record.map(kindOf), stop: stopOf(lastReply), behind: behind.map(row => (row.type === 'assistant' ? `error-row:${String(row.apiError ?? row.error)}` : String(row.content ?? kindOf(row)).slice(0, 120))) })} ${first.stdout.slice(-300)}`)
      const loaded = await resumedFrom(record, SID10)
      check('F10: the loader reads the turn as finished — the record says how it ended: no cut-off sentence', loaded.state === 'none' && loaded.saysContinuation === 0, j({ state: loaded.state, continuation: loaded.saysContinuation, last: loaded.lastTalk }))
      const errorRows = behind.filter(row => row.type === 'assistant' && row.isApiErrorMessage === true)
      const noErrorRow = await resumedFrom(record.slice(0, record.length - (record.at(-1) !== undefined && errorRows.includes(record.at(-1)!) ? 1 : 0)), SID10)
      check('F10: the same record without the error row (the notice of the decision is the last row on record) still reads as finished', errorRows.length === 1 && record.at(-1) === errorRows[0] && noErrorRow.state === 'none' && noErrorRow.saysContinuation === 0, j({ tail: record.map(kindOf).slice(-3), state: noErrorRow.state, continuation: noErrorRow.saysContinuation }))
      const second = await run(arena, ['run', 'F10 second prompt.', '--model', MODEL, '--resume', SID10, '--format', 'rows'])
      const resumedWire = wireOf(fixture.messageRequests().filter(request => !isHandoffRequest(request)).at(-1))
      check('F10: the second process answered, and its request carries no cut-off sentence', second.exit === 0 && second.stdout.includes('F10-SECOND-REPLY.') && says(resumedWire, CONTINUATION) === 0 && resumedWire.at(-1)?.texts.at(-1) === 'F10 second prompt.', `exit=${second.exit} ${j(resumedWire.map(message => [message.role, message.texts.map(text => text.slice(0, 80))]))}`)
    } finally {
      await fixture.close()
    }
  }

  section('F10 — the built bundle stopped hard while it asks again after the output ceiling: signal 9 with the continuation in flight; a second process resumes')
  {
    const SID10K = 'facef00d-0000-4000-8000-0000000fb001'
    const fixture = await startFixtureApi([handoffTurn(), { kind: 'text', text: 'F10K-CAPPED-REPLY that ran into the output ceiling', stopReason: 'max_tokens' }, { kind: 'hang', deltas: ['thinking'] }, { kind: 'text', text: 'F10K-RESUMED-REPLY.' }])
    const arena = makeArena('f10k', fixture)
    try {
      const record = await stoppedOnceRecorded(arena, ['run', 'F10K first prompt.', '--model', MODEL, '--session-id', SID10K, '--format', 'rows'], SID10K, rows => rows.some(row => row.type === 'assistant' && stopOf(row) === 'max_tokens'), fixture.messageRequestStarted(2))
      const reply = record.findLast(row => row.type === 'assistant')
      const behind = reply === undefined ? [] : record.slice(record.indexOf(reply) + 1)
      check('F10: the record holds the capped reply stamped max_tokens, with no error row and no notice that the turn ends behind it', stopOf(reply) === 'max_tokens' && reply?.isApiErrorMessage !== true && !behind.some(row => noticeSays(row, 'the turn ends here') || row.type === 'assistant'), j({ kinds: record.map(kindOf), stop: stopOf(reply), behind: behind.map(row => String(row.content ?? kindOf(row)).slice(0, 120)) }))
      const loaded = await resumedFrom(record, SID10K)
      check('F10: the loader reads the turn as cut — the sentence once', loaded.state === 'interrupted_prompt' && loaded.saysContinuation === 1, j({ state: loaded.state, continuation: loaded.saysContinuation, last: loaded.lastTalk }))
      const second = await run(arena, ['run', 'F10K second prompt.', '--model', MODEL, '--resume', SID10K, '--format', 'rows'])
      const resumedWire = wireOf(fixture.messageRequests().filter(request => !isHandoffRequest(request)).at(-1))
      check('F10: the second process answered, and its request tells the model once that the previous run ended before its turn finished', second.exit === 0 && second.stdout.includes('F10K-RESUMED-REPLY.') && says(resumedWire, CONTINUATION) === 1, `exit=${second.exit} ${j(resumedWire.map(message => [message.role, message.texts.map(text => text.slice(0, 80))]))}`)
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
