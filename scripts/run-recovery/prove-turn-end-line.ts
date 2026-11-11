#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { handoffTurn, isHandoffRequest, startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const nodeBin = Bun.which('node')
if (!existsSync(DIST) || !nodeBin) {
  console.log(!existsSync(DIST) ? '❌ dist/mercury.mjs absent — build first (the pooled gate prebuilds it)' : '❌ no node binary on PATH')
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'turn-end-line-'))
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
const { applyTranscriptEntry, emptyFoldState } = await import('../../src/utils/sessionStorage/fold.ts')
const sdk = await import('../../sdk/src/index.ts')
const acp = await import('@agentclientprotocol/sdk')
import type { Message } from '../../src/types/message.ts'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const j = (value: unknown): string => JSON.stringify(value) ?? ''

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the turn-end proof exceeded 420s')
  process.exit(1)
}, 420_000)
guard.unref?.()

const CONTINUATION = getResumePrompt()
const MODEL = 'claude-opus-4-8'
const SYSTEM_PATH = process.platform === 'win32' ? (process.env.PATH ?? '') : '/usr/bin:/bin'

type Arena = { home: string; cwd: string; env: Record<string, string> }
function makeArena(name: string, fixture: FixtureApi): Arena {
  const home = join(scratch, name, 'home')
  const cwd = join(scratch, name, 'cwd')
  mkdirSync(join(home, '.mercury'), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  return {
    home,
    cwd,
    env: {
      HOME: home,
      PATH: [SYSTEM_PATH, dirname(nodeBin!)].filter(part => part !== '').join(delimiter),
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
function transcriptsOf(arena: Arena): string[] {
  const found: string[] = []
  const stack = [join(arena.home, '.mercury', 'projects')]
  while (stack.length > 0) {
    const dir = stack.pop()!
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.name.endsWith('.jsonl') && !entry.name.startsWith('agent-')) found.push(path)
    }
  }
  return found
}
const transcriptOf = (arena: Arena, sessionId: string): string => transcriptsOf(arena).find(path => path.endsWith(`${sessionId}.jsonl`)) ?? ''

type Line = { kind: string; metaKind?: string; fields?: Record<string, unknown> }
const CONVERSATION_KINDS = new Set(['input', 'output'])
function linesOf(text: string): Line[] {
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      const payload = ((JSON.parse(line) as { payload?: Record<string, unknown> }).payload ?? {}) as Record<string, unknown>
      return { kind: String(payload.kind), ...(typeof payload.metaKind === 'string' ? { metaKind: payload.metaKind } : {}), ...(payload.fields !== undefined ? { fields: payload.fields as Record<string, unknown> } : {}) }
    })
}
const fileLines = (file: string): Line[] => (file === '' ? [] : linesOf(readFileSync(file, 'utf8')))
const isTurnEnd = (line: Line): boolean => line.kind === 'session-meta' && line.metaKind === 'turn-end'
const turnEndsOf = (lines: Line[]): Array<Record<string, unknown>> => lines.filter(isTurnEnd).map(line => line.fields ?? {})
const conversationBehindLastEnd = (lines: Line[]): number => lines.slice(lines.findLastIndex(isTurnEnd) + 1).filter(line => CONVERSATION_KINDS.has(line.kind)).length

type StoredRow = Record<string, unknown> & { type: string; uuid: string }
async function recordOf(file: string): Promise<StoredRow[]> {
  if (file === '') return []
  const loaded = await loadTranscriptFile(file, { keepAllLeaves: true })
  return [...loaded.messages.values()] as unknown as StoredRow[]
}
type Verdict = { state: string; sentence: number; chain: string[] }
async function loaderOn(file: string, sessionId: string): Promise<Verdict> {
  const loaded = file === '' ? null : await loadConversationForResume(sessionId, file)
  const messages = (loaded?.messages ?? []) as Message[]
  return {
    state: loaded?.turnInterruptionState.kind ?? 'nothing loaded',
    sentence: messages.filter(row => (row.type === 'user' || row.type === 'assistant') && j(row.message.content).includes(CONTINUATION)).length,
    chain: messages.map(row => row.uuid),
  }
}
let variant = 0
async function asAnOlderBuildLeftIt(file: string, sessionId: string): Promise<Verdict> {
  const dir = join(scratch, 'older', String(++variant))
  mkdirSync(dir, { recursive: true })
  const copy = join(dir, `${sessionId}.jsonl`)
  writeFileSync(copy, (await recordOf(file)).map(row => encodeTranscriptLine(copy, row).line).join(''))
  return loaderOn(copy, sessionId)
}
const rowsOf = (stdout: string): Array<Record<string, unknown>> =>
  stdout
    .split('\n')
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line) as Record<string, unknown>)
const outcomesOf = (stdout: string): Array<Record<string, unknown>> => rowsOf(stdout).filter(row => row.type === 'outcome')
const wireSays = (request: { body: unknown } | undefined, words: string): boolean => j(((request?.body ?? {}) as { messages?: unknown }).messages ?? []).includes(words)
const lastRequest = (fixture: FixtureApi): { body: unknown } | undefined => fixture.messageRequests().filter(request => !isHandoffRequest(request)).at(-1)

let serial = 0
const sid = (): string => `facef00d-0000-4000-8000-${String(0xe0000000 + ++serial).padStart(12, '0')}`

type Ending = { tag: string; says: string; turns: ScriptedTurn[]; prepare?: (arena: Arena) => void; args?: string[]; status: string; olderBuildReads: 'finished' | 'cut, the sentence once' | 'an unanswered line of the record, no sentence'; resume?: boolean }
const OLDER_READING = { finished: { state: 'none', sentence: 0 }, 'cut, the sentence once': { state: 'interrupted_prompt', sentence: 1 }, 'an unanswered line of the record, no sentence': { state: 'interrupted_prompt', sentence: 0 } } as const
async function ending(scene: Ending): Promise<{ file: string; SID: string }> {
  const SID = sid()
  const fixture = await startFixtureApi([handoffTurn(), ...scene.turns, { kind: 'text', text: `${scene.tag}-SECOND-REPLY.` }])
  const arena = makeArena(scene.tag.toLowerCase(), fixture)
  scene.prepare?.(arena)
  try {
    const first = await run(arena, ['run', `${scene.tag} first prompt.`, '--model', MODEL, '--session-id', SID, '--format', 'rows', ...(scene.args ?? [])])
    const outcome = outcomesOf(first.stdout).at(-1)
    const file = transcriptOf(arena, SID)
    const lines = fileLines(file)
    const ends = turnEndsOf(lines)
    check(`${scene.tag}: ${scene.says} — the outcome row says ${scene.status}`, outcome?.status === scene.status, `exit=${first.exit} ${j({ status: outcome?.status, error: outcome?.error })} ${first.stderr.slice(-200)}`)
    check(`${scene.tag}: the record holds one turn-end line, with the outcome's status and turn id, and no conversation row behind it`, ends.length === 1 && ends[0]!.status === outcome?.status && ends[0]!.turnId === outcome?.turn_id && ends[0]!.sessionId === SID && conversationBehindLastEnd(lines) === 0, j({ ends, behind: conversationBehindLastEnd(lines), kinds: lines.slice(-6).map(line => line.metaKind ?? line.kind) }))
    const read = await loaderOn(file, SID)
    check(`${scene.tag}: the loader reads a turn the run ended — no cut-off sentence`, read.state === 'none' && read.sentence === 0, j({ state: read.state, sentence: read.sentence }))
    const older = await asAnOlderBuildLeftIt(file, SID)
    check(`${scene.tag}: the same conversation with no line (the record an older build leaves) is read by the rules that judge its last rows — ${scene.olderBuildReads}`, older.state === OLDER_READING[scene.olderBuildReads].state && older.sentence === OLDER_READING[scene.olderBuildReads].sentence, j({ state: older.state, sentence: older.sentence }))
    if (scene.resume === true) {
      const second = await run(arena, ['run', `${scene.tag} second prompt.`, '--model', MODEL, '--resume', SID, '--format', 'rows'])
      check(`${scene.tag}: a second process resumes by id, answers, and its request does not tell the model the run was stopped from outside`, second.exit === 0 && second.stdout.includes(`${scene.tag}-SECOND-REPLY.`) && !wireSays(lastRequest(fixture), CONTINUATION), `exit=${second.exit} ${second.stderr.slice(-200)}`)
      const after = turnEndsOf(fileLines(file))
      check(`${scene.tag}: …and leaves its own line: two turns, two lines`, after.length === 2 && after[1]!.status === 'completed' && after[1]!.turnId === outcomesOf(second.stdout).at(-1)?.turn_id, j(after))
    }
    return { file, SID }
  } finally {
    await fixture.close()
  }
}

console.log('============================================================')
console.log(' the run states how its turn ended: one line a turn')
console.log('============================================================')

try {
  section('A — every ending the run decides writes its line (mercury run, the built bundle)')
  writeFileSync(join(scratch, 'outside-note.txt'), 'A-NOTE-OUTSIDE-THE-PROJECT\n')
  const readInside: Extract<ScriptedTurn, { kind: 'tool_use' }> = { kind: 'tool_use', name: 'Read', id: 'toolu_a_empty', input: {} }
  const paused = (text: string): ScriptedTurn => ({ kind: 'text', text, stopReason: 'pause_turn' })
  const failing = (n: number): ScriptedTurn => ({ kind: 'tool_use', name: 'Read', id: `toolu_a_loop_${n}`, input: { unrecognized: 'not a valid Read input' } })
  await ending({ tag: 'COMPLETED', says: 'a reply that ends its turn', turns: [{ kind: 'text', text: 'COMPLETED-FIRST-REPLY.' }], status: 'completed', olderBuildReads: 'finished', resume: true })
  await ending({ tag: 'REFUSAL', says: 'the model refuses', turns: [{ kind: 'text', text: 'REFUSAL: the fixture refuses.', stopReason: 'refusal' }], status: 'failed', olderBuildReads: 'finished' })
  await ending({ tag: 'TURNLIMIT', says: 'the turn limit met on a reply the provider paused', turns: [paused('TURNLIMIT-PAUSED-REPLY, the work still going.')], args: ['--max-turns', '1'], status: 'turn_limit', olderBuildReads: 'cut, the sentence once', resume: true })
  await ending({ tag: 'BUDGET', says: 'the budget met by a reply', turns: [{ kind: 'text', text: 'BUDGET-REPLY.', usage: { input_tokens: 2000, output_tokens: 1000 } }], args: ['--budget', '0.000001'], status: 'budget_limit', olderBuildReads: 'finished' })
  await ending({ tag: 'TIMELIMIT', says: 'the time limit met while a reply streams', turns: [{ kind: 'hang', deltas: ['TIMELIMIT visible before the deadline.'] }], args: ['--max-time', '1s'], status: 'time_limit', olderBuildReads: 'an unanswered line of the record, no sentence' })
  await ending({ tag: 'LOOPGUARD', says: 'the loop guard stops three failed calls with the same arguments', turns: [failing(1), failing(2), failing(3)], status: 'loop_stopped', olderBuildReads: 'finished' })
  await ending({ tag: 'PAUSELIMIT', says: 'nine paused replies in a row', turns: Array.from({ length: 9 }, (_, n) => paused(`PAUSELIMIT-INSTALMENT-${n + 1}.`)), status: 'completed', olderBuildReads: 'finished' })
  await ending({ tag: 'BLOCKED', says: 'a call asks for an answer nobody can give, and the model closes', turns: [{ kind: 'tool_use', name: 'Read', id: 'toolu_a_blocked', input: { file_path: join(scratch, 'outside-note.txt') } }, { kind: 'text', text: 'BLOCKED-CLOSING-REPLY.' }], args: ['--mode', 'implement'], status: 'blocked', olderBuildReads: 'finished' })
  await ending({
    tag: 'EMPTY',
    says: 'a tool round, then a reply with nothing said',
    turns: [readInside, { kind: 'text', text: '' }],
    prepare: arena => {
      writeFileSync(join(arena.cwd, 'note.txt'), 'EMPTY-NOTE-CONTENT\n')
      readInside.input = { file_path: join(arena.cwd, 'note.txt') }
    },
    args: ['--mode', 'implement'],
    status: 'completed',
    olderBuildReads: 'cut, the sentence once',
  })
  await ending({ tag: 'FAILED', says: 'the provider refuses the request outright', turns: [{ kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'The fixture refuses this request.' }], status: 'failed', olderBuildReads: 'cut, the sentence once', resume: true })

  section('B — a process stopped from outside writes none: that absence, behind rows that ask for more, is what cut means')
  {
    const SID = sid()
    const fixture = await startFixtureApi([handoffTurn(), { kind: 'text', text: 'KILLED-FIRST-REPLY.' }, { kind: 'die', settled: ['KILLED-SETTLED-BLOCK of a reply that never ended.'], deltas: ['half', ' of a', ' second block'], gapMs: 4000 }, { kind: 'text', text: 'KILLED-RESUMED-REPLY.' }])
    const arena = makeArena('killed', fixture)
    try {
      const first = await run(arena, ['run', 'KILLED first prompt.', '--model', MODEL, '--session-id', SID, '--format', 'rows'])
      const file = transcriptOf(arena, SID)
      const child = spawn(nodeBin!, [DIST, 'run', 'KILLED second prompt.', '--model', MODEL, '--resume', SID, '--format', 'rows'], { cwd: arena.cwd, env: arena.env })
      child.stdout.on('data', () => {})
      child.stderr.on('data', () => {})
      const exited = new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
      const until = Date.now() + 15_000
      while (Date.now() < until && !readFileSync(file, 'utf8').includes('KILLED-SETTLED-BLOCK')) await new Promise(tick => setTimeout(tick, 100))
      await new Promise(tick => setTimeout(tick, 400))
      child.kill('SIGKILL')
      await exited
      const lines = fileLines(file)
      check('B: the first run completed and left its line; the second, stopped by signal 9 inside its reply, left none — one line, with conversation rows behind it', first.exit === 0 && turnEndsOf(lines).length === 1 && conversationBehindLastEnd(lines) >= 2, j({ exit: first.exit, ends: turnEndsOf(lines).length, behind: conversationBehindLastEnd(lines) }))
      const read = await loaderOn(file, SID)
      check('B: the loader reads the turn as cut — the sentence once (the earlier turn\'s line does not speak for the rows written after it)', read.state === 'interrupted_prompt' && read.sentence === 1, j({ state: read.state, sentence: read.sentence }))
      const third = await run(arena, ['run', 'KILLED third prompt.', '--model', MODEL, '--resume', SID, '--format', 'rows'])
      check('B: a third process answers, and its request tells the model once that the previous run ended before its turn finished', third.exit === 0 && third.stdout.includes('KILLED-RESUMED-REPLY.') && wireSays(lastRequest(fixture), CONTINUATION), `exit=${third.exit}`)
    } finally {
      await fixture.close()
    }
  }

  section('C — the line is on disk before the outcome is spoken: the record is read at the instant the outcome row arrives, then the process is stopped')
  {
    const SID = sid()
    const fixture = await startFixtureApi([handoffTurn(), { kind: 'text', text: 'SPOKEN-PAUSED-REPLY, the work still going.', stopReason: 'pause_turn' }, { kind: 'text', text: 'SPOKEN-SECOND-REPLY.' }])
    const arena = makeArena('spoken', fixture)
    try {
      const child = spawn(nodeBin!, [DIST, 'run', 'SPOKEN first prompt.', '--model', MODEL, '--session-id', SID, '--max-turns', '1', '--format', 'rows'], { cwd: arena.cwd, env: arena.env })
      let stdout = ''
      let atTheOutcome: Line[] | null = null
      child.stdout.on('data', chunk => {
        stdout += String(chunk)
        if (atTheOutcome === null && stdout.includes('"type":"outcome"')) {
          atTheOutcome = fileLines(transcriptOf(arena, SID))
          child.kill('SIGKILL')
        }
      })
      child.stderr.on('data', () => {})
      await new Promise<void>(resolve => child.on('close', () => resolve()))
      const outcome = outcomesOf(stdout).at(-1)
      const seen = (atTheOutcome ?? []) as Line[]
      check('C: when the outcome row (turn_limit) reached the reader, the record already held that turn\'s line', outcome?.status === 'turn_limit' && turnEndsOf(seen).length === 1 && turnEndsOf(seen)[0]!.turnId === outcome.turn_id && turnEndsOf(seen)[0]!.status === 'turn_limit', j({ status: outcome?.status, ends: turnEndsOf(seen), kinds: seen.slice(-4).map(line => line.metaKind ?? line.kind) }))
      const file = transcriptOf(arena, SID)
      const read = await loaderOn(file, SID)
      check('C: the process was stopped right after it; the loader reads a turn the run ended — no cut-off sentence', read.state === 'none' && read.sentence === 0, j({ state: read.state, sentence: read.sentence }))
      const second = await run(arena, ['run', 'SPOKEN second prompt.', '--model', MODEL, '--resume', SID, '--format', 'rows'])
      check('C: a second process answers, and its request does not tell the model the run was stopped from outside', second.exit === 0 && second.stdout.includes('SPOKEN-SECOND-REPLY.') && !wireSays(lastRequest(fixture), CONTINUATION), `exit=${second.exit} ${second.stderr.slice(-200)}`)
    } finally {
      await fixture.close()
    }
  }

  section('D — one line a turn and nothing more: three prompts in one process, then a resume')
  {
    const SID = sid()
    const fixture = await startFixtureApi([handoffTurn(), { kind: 'text', text: 'GROWTH-REPLY-1.' }, { kind: 'text', text: 'GROWTH-REPLY-2.' }, { kind: 'text', text: 'GROWTH-REPLY-3.' }, { kind: 'text', text: 'GROWTH-REPLY-4.' }])
    const arena = makeArena('growth', fixture)
    try {
      const child = spawn(nodeBin!, [DIST, 'run', '--input', 'rows', '--format', 'rows', '--model', MODEL, '--session-id', SID], { cwd: arena.cwd, env: arena.env, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      child.stdout!.on('data', chunk => (stdout += String(chunk)))
      child.stderr!.on('data', () => {})
      const exited = new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
      for (let n = 1; n <= 3; n++) {
        child.stdin!.write(JSON.stringify({ type: 'prompt', content: `GROWTH prompt ${n}.` }) + '\n')
        const until = Date.now() + 60_000
        while (Date.now() < until && outcomesOf(stdout).length < n) await new Promise(tick => setTimeout(tick, 20))
      }
      child.stdin!.end()
      const killer = setTimeout(() => child.kill('SIGKILL'), 30_000)
      await exited
      clearTimeout(killer)
      const file = transcriptOf(arena, SID)
      const ends = turnEndsOf(fileLines(file))
      const turnIds = outcomesOf(stdout).map(row => row.turn_id)
      check('D: three turns, three lines, each with its own turn\'s id, in order', turnIds.length === 3 && j(ends.map(end => end.turnId)) === j(turnIds) && ends.every(end => end.status === 'completed'), j({ turnIds, ends }))
      const before = fileLines(file).length
      const loadedOnly = await loaderOn(file, SID)
      check('D: loading the record writes nothing to it', loadedOnly.state === 'none' && fileLines(file).length === before, j({ state: loadedOnly.state, before, after: fileLines(file).length }))
      const fourth = await run(arena, ['run', 'GROWTH prompt 4.', '--model', MODEL, '--resume', SID, '--format', 'rows'])
      check('D: a resumed process adds one line for its one turn', fourth.exit === 0 && turnEndsOf(fileLines(file)).length === 4, `exit=${fourth.exit} lines=${turnEndsOf(fileLines(file)).length}`)
    } finally {
      await fixture.close()
    }
  }

  section('E — the other roads that end a turn: the published package\'s run door, the runner door, ACP')
  {
    const fixture = await startFixtureApi([handoffTurn(), handoffTurn(), handoffTurn(), { kind: 'text', text: 'ROADS-REPLY-1.' }, { kind: 'text', text: 'ROADS-REPLY-2.' }, { kind: 'text', text: 'ROADS-REPLY-3.' }])
    const mercury = [nodeBin!, DIST] as const
    try {
      const viaRun = makeArena('road-run', fixture)
      const task = sdk.run({ prompt: 'ROADS through the run door.', mercury, cwd: viaRun.cwd, env: viaRun.env, model: MODEL })
      const outcome = await task.outcome
      await task.exit
      const ends = transcriptsOf(viaRun).flatMap(file => turnEndsOf(fileLines(file)))
      check('E: the package\'s run door — the outcome resolves completed and the session\'s record holds its line', outcome.status === 'completed' && ends.length === 1 && ends[0]!.turnId === outcome.turn_id && ends[0]!.status === 'completed', j({ status: outcome.status, ends }))

      const viaRunner = makeArena('road-runner', fixture)
      const session = await sdk.connect({ mercury, cwd: viaRunner.cwd, env: viaRunner.env, model: MODEL })
      let spoken: { status: string; turn_id: string } | null = null
      try {
        spoken = await session.prompt('ROADS through the runner door.')
      } finally {
        await session.close()
      }
      const runnerEnds = transcriptsOf(viaRunner).flatMap(file => turnEndsOf(fileLines(file)))
      check('E: the runner door — the prompt\'s outcome resolves completed and the session\'s record holds its line', spoken?.status === 'completed' && runnerEnds.length === 1 && runnerEnds[0]!.turnId === spoken.turn_id && runnerEnds[0]!.status === 'completed', j({ status: spoken?.status, ends: runnerEnds }))

      const viaAcp = makeArena('road-acp', fixture)
      const server: ChildProcess = spawn(nodeBin!, [DIST, 'acp'], { cwd: viaAcp.cwd, env: viaAcp.env, stdio: ['pipe', 'pipe', 'pipe'] })
      server.stderr!.on('data', () => {})
      let stopReason = ''
      try {
        const conn = acp
          .client({ name: 'turn-end-line' })
          .onNotification('session/update', () => {})
          .onRequest('session/request_permission', () => ({ outcome: { outcome: 'selected' as const, optionId: 'allow' } }))
          .connect(acp.ndJsonStream(Writable.toWeb(server.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(server.stdout!) as ReadableStream<Uint8Array>))
        const deadline = <T>(work: Promise<T>): Promise<T> => Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('the ACP server did not answer within 60 s')), 60_000).unref?.())])
        await deadline(conn.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }))
        const created = await deadline(conn.agent.request('session/new', { cwd: viaAcp.cwd, mcpServers: [] }))
        const answered = await deadline(conn.agent.request('session/prompt', { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'ROADS through ACP.' }] }))
        stopReason = String(answered.stopReason)
        conn.close()
      } finally {
        server.kill('SIGTERM')
        await new Promise<void>(resolve => {
          const hard = setTimeout(() => server.kill('SIGKILL'), 10_000)
          server.on('close', () => {
            clearTimeout(hard)
            resolve()
          })
        })
      }
      const acpEnds = transcriptsOf(viaAcp).flatMap(file => turnEndsOf(fileLines(file)))
      check('E: ACP — the prompt answers end_turn and the session\'s record holds its line', stopReason === 'end_turn' && acpEnds.length === 1 && acpEnds[0]!.status === 'completed', j({ stopReason, ends: acpEnds }))
    } finally {
      await fixture.close()
    }
  }

  section('F — a reader that does not know the row: it is a session row beside the conversation, never a row of it')
  {
    const SID = sid()
    const fixture = await startFixtureApi([handoffTurn(), { kind: 'text', text: 'BESIDE-REPLY-1.' }, { kind: 'text', text: 'BESIDE-REPLY-2.' }])
    const arena = makeArena('beside', fixture)
    try {
      await run(arena, ['run', 'BESIDE first prompt.', '--model', MODEL, '--session-id', SID, '--format', 'rows'])
      await run(arena, ['run', 'BESIDE second prompt.', '--model', MODEL, '--resume', SID, '--format', 'rows'])
      const file = transcriptOf(arena, SID)
      const text = readFileSync(file, 'utf8')
      const raw = text.split('\n').filter(line => line.trim() !== '')
      const ends = raw.filter(line => isTurnEnd(linesOf(line)[0]!))
      check('F: each line is a session-meta record named turn-end, carrying the session, the turn and its status and nothing else', ends.length === 2 && ends.every(line => j(Object.keys((JSON.parse(line) as { payload: { fields: Record<string, unknown> } }).payload.fields).sort()) === j(['sessionId', 'status', 'turnId'])), j(ends.map(line => (JSON.parse(line) as { payload: unknown }).payload)))
      const dir = join(scratch, 'beside-without')
      mkdirSync(dir, { recursive: true })
      const without = join(dir, `${SID}.jsonl`)
      writeFileSync(without, raw.filter(line => !ends.includes(line)).join('\n') + '\n')
      const whole = await loaderOn(file, SID)
      const stripped = await loaderOn(without, SID)
      check('F: with the lines taken out of the file the loader builds the same conversation, row for row — a reader that skips them loses no row', whole.chain.length > 3 && j(whole.chain) === j(stripped.chain) && stripped.state === 'none', j({ whole: whole.chain.length, stripped: stripped.chain.length, state: stripped.state }))
    } finally {
      await fixture.close()
    }
  }

  section('G — a store that fails before the turn ends: no line can be written, and the record that stops in mid-turn is read as it stands')
  {
    const SID = sid()
    const fixture = await startFixtureApi([handoffTurn(), { kind: 'tool_use', name: 'Bash', id: 'toolu_g_shell', input: { command: 'node g-work.mjs', description: 'Does the slow work' } }, { kind: 'text', text: 'UNWRITABLE-REPLY.' }])
    const arena = makeArena('unwritable', fixture)
    writeFileSync(join(arena.cwd, 'g-work.mjs'), "setTimeout(() => console.log('G-WORK-DONE'), 1500)\n")
    try {
      const child = spawn(nodeBin!, [DIST, 'run', 'UNWRITABLE first prompt.', '--model', MODEL, '--session-id', SID, '--mode', 'sovereign', '--format', 'rows'], { cwd: arena.cwd, env: arena.env })
      let stdout = ''
      child.stdout.on('data', chunk => (stdout += String(chunk)))
      child.stderr.on('data', () => {})
      const exited = new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
      await Promise.race([fixture.messageRequestStarted(1), exited])
      await new Promise(tick => setTimeout(tick, 500))
      const file = transcriptOf(arena, SID)
      const swapped = file !== '' && !stdout.includes('"type":"tool_result"')
      if (swapped) {
        renameSync(file, `${file}.aside`)
        mkdirSync(file)
      }
      const killer = setTimeout(() => child.kill('SIGKILL'), 60_000)
      await exited
      clearTimeout(killer)
      if (swapped) {
        rmSync(file, { recursive: true, force: true })
        renameSync(`${file}.aside`, file)
      }
      check('G: the record\'s file was swapped for a folder while the tool ran, and the turn still reached its reply', swapped && stdout.includes('UNWRITABLE-REPLY.'), j({ swapped, tail: stdout.slice(-200) }))
      check('G: the record holds no line for that turn — nothing could be written once the store failed', turnEndsOf(fileLines(file)).length === 0, j(turnEndsOf(fileLines(file))))
      const read = await loaderOn(file, SID)
      check('G: …so a resume reads the record as it stands, a turn that stops in mid-work — the sentence once (the safe side: what was not recorded is not claimed)', read.state === 'interrupted_prompt' && read.sentence === 1, j({ state: read.state, sentence: read.sentence }))
    } finally {
      await fixture.close()
    }
  }

  section('H — rows written behind the line: only one that asks for a reply reopens the turn')
  {
    const base = await ending({ tag: 'BEHIND', says: 'the turn limit on a paused reply, kept for the rows written behind its line', turns: [paused('BEHIND-PAUSED-REPLY, the work still going.')], args: ['--max-turns', '1'], status: 'turn_limit', olderBuildReads: 'cut, the sentence once' })
    const record = await recordOf(base.file)
    const prompt = record.find(row => row.type === 'user')!
    const reply = record.findLast(row => row.type === 'assistant')!
    const silent = record.find(row => row.type === 'attachment' && (row.attachment as { type?: string }).type === 'bound_prefix')
    const { message: _prompted, ...envelope } = prompt
    const behind = (n: number, row: Record<string, unknown>): StoredRow => ({ ...envelope, ...row, uuid: `00000000-0000-4000-8000-0000000be${String(n).padStart(3, '0')}`, parentUuid: reply.uuid, timestamp: new Date(Date.parse(String(reply.timestamp)) + 60_000 + n * 1000).toISOString() }) as StoredRow
    const withBehind = async (tag: string, rows: StoredRow[]): Promise<Verdict> => {
      const dir = join(scratch, 'behind', tag)
      mkdirSync(dir, { recursive: true })
      const copy = join(dir, `${base.SID}.jsonl`)
      copyFileSync(base.file, copy)
      for (const row of rows) appendFileSync(copy, encodeTranscriptLine(copy, row).line)
      return loaderOn(copy, base.SID)
    }
    const untouched = await withBehind('untouched', [])
    check('H control: a copy of the record with nothing added reads as the record does — a turn the run ended', untouched.state === 'none' && untouched.sentence === 0, j({ state: untouched.state, sentence: untouched.sentence }))
    const noticed = await withBehind('notice', [behind(1, { type: 'system', subtype: 'informational', level: 'info', content: 'a background task finished after the turn ended' })])
    check('H: a notice row behind the line (a task that finished after the turn ended) leaves the turn ended', noticed.state === 'none' && noticed.sentence === 0, j({ state: noticed.state, sentence: noticed.sentence }))
    const quiet = await withBehind('silent', silent === undefined ? [] : [behind(2, { type: 'attachment', attachment: silent.attachment })])
    check('H: an attachment behind the line that puts nothing before the model leaves the turn ended', silent !== undefined && quiet.state === 'none' && quiet.sentence === 0, j({ found: silent !== undefined, state: quiet.state, sentence: quiet.sentence }))
    const queued = await withBehind('queued', [behind(3, { type: 'attachment', attachment: { type: 'queued_command', prompt: 'BEHIND a message that arrived after the turn ended.' } })])
    check('H: a message queued behind the line (a row that asks for a reply) reopens it — the record is read by its last rows again, as cut', queued.state === 'interrupted_prompt' && queued.sentence === 1, j({ state: queued.state, sentence: queued.sentence }))
    const typed = await withBehind('prompt', [behind(4, { type: 'user', message: { role: 'user', content: 'BEHIND a prompt typed after the turn ended.' } })])
    check('H: a prompt behind the line is an unanswered prompt — the line of the turn before it does not answer for it', typed.state === 'interrupted_prompt' && typed.sentence === 0, j({ state: typed.state, sentence: typed.sentence }))
  }

  section('I — the real late notice: a background task that outlives its turn, in a process that stays up; the notice arrives behind the line as a prompt of its own')
  {
    const SID = sid()
    const fixture = await startFixtureApi([
      handoffTurn(),
      { kind: 'tool_use', name: 'Bash', id: 'toolu_i_background', input: { command: 'node i-background.mjs', description: 'Runs in the background', run_in_background: true } },
      { kind: 'text', text: 'LATE-CLOSING-REPLY, the task still runs.' },
      { kind: 'hang', deltas: ['thinking about the notice'] },
    ])
    const arena = makeArena('late', fixture)
    writeFileSync(join(arena.cwd, 'i-background.mjs'), "setTimeout(() => console.log('I-BACKGROUND-WORK-DONE'), 2500)\n")
    try {
      const child = spawn(nodeBin!, [DIST, 'run', '--input', 'rows', '--format', 'rows', '--model', MODEL, '--session-id', SID, '--mode', 'sovereign'], { cwd: arena.cwd, env: arena.env, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let whileTheTaskRan: string | null = null
      child.stdout!.on('data', chunk => {
        stdout += String(chunk)
        if (whileTheTaskRan === null && stdout.includes('"type":"outcome"')) whileTheTaskRan = readFileSync(transcriptOf(arena, SID), 'utf8')
      })
      child.stderr!.on('data', () => {})
      const exited = new Promise<'exited'>(resolve => child.on('close', () => resolve('exited')))
      child.stdin!.write(JSON.stringify({ type: 'prompt', content: 'LATE start the background work and close your turn.' }) + '\n')
      const reached = await Promise.race([fixture.messageRequestStarted(3).then(() => 'the notice rode a request' as const), exited, new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 40_000))])
      await new Promise(tick => setTimeout(tick, 300))
      child.kill('SIGKILL')
      await exited
      const during = linesOf(whileTheTaskRan ?? '')
      const dir = join(scratch, 'late-during')
      mkdirSync(dir, { recursive: true })
      const snapshot = join(dir, `${SID}.jsonl`)
      writeFileSync(snapshot, whileTheTaskRan ?? '')
      const ended = await loaderOn(snapshot, SID)
      check('I: when the turn\'s outcome row arrived the task was still running, the record held the turn\'s line with nothing behind it, and it reads as a turn the run ended', outcomesOf(stdout)[0]?.status === 'completed' && turnEndsOf(during).length === 1 && conversationBehindLastEnd(during) === 0 && ended.state === 'none' && ended.sentence === 0, j({ status: outcomesOf(stdout)[0]?.status, ends: turnEndsOf(during).length, behind: conversationBehindLastEnd(during), state: ended.state }))
      const file = transcriptOf(arena, SID)
      const lines = fileLines(file)
      const noticed = wireSays(lastRequest(fixture), '<task-notification>') && wireSays(lastRequest(fixture), 'toolu_i_background')
      check('I: the task then finished; its notice was queued, began a turn of its own and rode a request, and the process was stopped there — one line, the notice\'s row behind it', reached === 'the notice rode a request' && noticed && turnEndsOf(lines).length === 1 && conversationBehindLastEnd(lines) >= 1, j({ reached, noticed, ends: turnEndsOf(lines).length, behind: conversationBehindLastEnd(lines) }))
      const read = await loaderOn(file, SID)
      check('I: the earlier turn\'s line does not answer for the notice: the record is read by its last rows, an unanswered prompt', read.state === 'interrupted_prompt', j({ state: read.state, sentence: read.sentence }))
    } finally {
      await fixture.close()
    }
  }

  section('J — the fold\'s rule, row by row: what written behind a line lets it stand')
  {
    const SESSION = '00000000-0000-4000-8000-00000000f01d'
    const OTHER = '00000000-0000-4000-8000-00000000f02d'
    const row = (n: number, type: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({ type, uuid: `00000000-0000-4000-8000-0000000f0${String(n).padStart(3, '0')}`, parentUuid: null, isSidechain: false, sessionId: SESSION, timestamp: new Date(Date.UTC(2026, 10, 10, 9, 0, n)).toISOString(), ...(type === 'user' || type === 'assistant' ? { message: { role: type, content: [{ type: 'text', text: `row ${n}` }] } } : {}), ...more })
    const line = (turnId: string, status = 'completed', sessionId = SESSION): Record<string, unknown> => ({ type: 'turn-end', sessionId, turnId, status })
    const folded = (rows: Array<Record<string, unknown>>): { turnId: string; status: string; trailing: string[] } | undefined => {
      const state = emptyFoldState()
      for (const entry of rows) applyTranscriptEntry(state, entry as never)
      return (state as { turnEnds?: Map<string, { turnId: string; status: string; trailing: string[] }> }).turnEnds?.get(SESSION)
    }
    const turn = [row(1, 'user'), row(2, 'assistant')]
    check('J: a line behind its turn\'s rows is the session\'s fact, with its turn and status', j(folded([...turn, line('turn-a', 'turn_limit')])) === j({ turnId: 'turn-a', status: 'turn_limit', trailing: [] }), j(folded([...turn, line('turn-a', 'turn_limit')])))
    check('J: a system row behind it changes nothing', j(folded([...turn, line('turn-a'), row(3, 'system', { subtype: 'informational', level: 'info', content: 'a notice' })])?.trailing) === j([]), j(folded([...turn, line('turn-a'), row(3, 'system')])))
    check('J: an attachment behind it is remembered for the loader to judge', j(folded([...turn, line('turn-a'), row(4, 'attachment', { attachment: { type: 'queued_command', prompt: 'later' } })])?.trailing) === j([row(4, 'attachment').uuid]), j(folded([...turn, line('turn-a'), row(4, 'attachment')])))
    check('J: a user row behind it ends the fact — another turn began', folded([...turn, line('turn-a'), row(5, 'user')]) === undefined, j(folded([...turn, line('turn-a'), row(5, 'user')])))
    check('J: so does a reply', folded([...turn, line('turn-a'), row(6, 'assistant')]) === undefined, j(folded([...turn, line('turn-a'), row(6, 'assistant')])))
    check('J: an API-error row behind it does not (the run ended that turn too, and says so in the row)', folded([...turn, line('turn-a'), row(7, 'assistant', { isApiErrorMessage: true })])?.turnId === 'turn-a', j(folded([...turn, line('turn-a'), row(7, 'assistant', { isApiErrorMessage: true })])))
    check('J: a line that settles a row written before the line (the same row again) does not', folded([...turn, line('turn-a'), { ...row(2, 'assistant'), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'row 2' }] } }])?.turnId === 'turn-a', j(folded([...turn, line('turn-a'), row(2, 'assistant')])))
    check('J: a crewmate\'s row and another session\'s row do not', folded([...turn, line('turn-a'), row(8, 'user', { isSidechain: true }), row(9, 'user', { sessionId: OTHER })])?.turnId === 'turn-a', j(folded([...turn, line('turn-a'), row(8, 'user', { isSidechain: true }), row(9, 'user', { sessionId: OTHER })])))
    check('J: the next turn\'s line replaces the fact, and the rows remembered behind the earlier one go with it', j(folded([...turn, line('turn-a'), row(4, 'attachment', { attachment: { type: 'queued_command', prompt: 'later' } }), row(5, 'user'), row(6, 'assistant'), line('turn-b')])) === j({ turnId: 'turn-b', status: 'completed', trailing: [] }), j(folded([...turn, line('turn-a'), row(5, 'user'), row(6, 'assistant'), line('turn-b')])))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n============================================================')
console.log(failures === 0 ? ` ✅ TURN-END LINE (${checks} checks)` : ` ❌ ${failures} of ${checks} TURN-END CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
