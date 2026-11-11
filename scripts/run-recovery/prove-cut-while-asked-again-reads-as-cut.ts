#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { handoffTurn, isHandoffRequest, startFixtureApi, type FixtureApi } from '../lib/fixtureApi.ts'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const nodeBin = Bun.which('node')
if (!existsSync(DIST) || !nodeBin) {
  console.log(!existsSync(DIST) ? '❌ dist/mercury.mjs absent — build first (the pooled gate prebuilds it)' : '❌ no node binary on PATH')
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'asked-again-cut-'))
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
  console.log('\n❌ TIMEOUT — the proof exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

const CONTINUATION = getResumePrompt()
const ASKED_AGAIN_WORDS = 'say it again, with feeling'
const MODEL = 'claude-opus-4-8'
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
function gateTheNextAnswerOnce(arena: Arena): void {
  const spent = join(arena.home, 'gate-spent')
  writeFileSync(join(arena.home, '.mercury', 'settings.json'), JSON.stringify({ events: { hooks: { 'turn.answer': [{ name: 'answer gate', run: `if [ ! -f ${quote(spent)} ]; then touch ${quote(spent)}; echo ${quote(ASKED_AGAIN_WORDS)} >&2; exit 2; fi; exit 0` }] } } }))
}

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
      PATH: ['/usr/bin:/bin', dirname(nodeBin!)].join(delimiter),
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
async function runUntilAskedAgainThenKill(arena: Arena, fixture: FixtureApi, args: string[], file: () => string): Promise<void> {
  const child = spawn(nodeBin!, [DIST, ...args], { cwd: arena.cwd, env: arena.env })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  const exited = new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
  const asked = (): boolean => fixture.messageRequests().some(request => !isHandoffRequest(request) && j(request.body).includes(ASKED_AGAIN_WORDS))
  const recorded = (): boolean => file() !== '' && readFileSync(file(), 'utf8').includes(ASKED_AGAIN_WORDS)
  const until = Date.now() + 30_000
  while (Date.now() < until && !(asked() && recorded())) await new Promise(tick => setTimeout(tick, 50))
  await new Promise(tick => setTimeout(tick, 300))
  child.kill('SIGKILL')
  await exited
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
  if (file === '') return []
  const loaded = await loadTranscriptFile(file, { keepAllLeaves: true })
  return [...loaded.messages.values()] as unknown as StoredRow[]
}
const turnEndLines = (file: string): number => file === '' ? 0 : readFileSync(file, 'utf8').split('\n').filter(line => line.includes('"metaKind":"turn-end"')).length
type Verdict = { state: string; sentence: number }
async function loaderOn(file: string, sessionId: string): Promise<Verdict> {
  const loaded = file === '' ? null : await loadConversationForResume(sessionId, file)
  const messages = (loaded?.messages ?? []) as Message[]
  return {
    state: loaded?.turnInterruptionState.kind ?? 'nothing loaded',
    sentence: messages.filter(row => (row.type === 'user' || row.type === 'assistant') && j(row.message.content).includes(CONTINUATION)).length,
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
const lastSpoken = (rows: StoredRow[]): StoredRow | undefined => rows.findLast(row => row.type === 'user' || row.type === 'assistant')
const isTheAskAgain = (row: StoredRow | undefined): boolean => row !== undefined && row.type === 'user' && row.isMeta === true && j((row.message as { content?: unknown } | undefined)?.content).includes(ASKED_AGAIN_WORDS)
const wireSays = (request: { body: unknown } | undefined, words: string): number => j(((request?.body ?? {}) as { messages?: unknown }).messages ?? []).split(JSON.stringify(words).slice(1, -1)).length - 1
const lastRequest = (fixture: FixtureApi): { body: unknown } | undefined => fixture.messageRequests().filter(request => !isHandoffRequest(request)).at(-1)
let serial = 0
const sid = (): string => `facef00d-0000-4000-8000-${String(0xa5000000 + ++serial).padStart(12, '0')}`

console.log('============================================================')
console.log(' a run stopped while the model is asked again reads as cut')
console.log('============================================================')

try {
  section("A — a later turn: a turn.answer hook blocks the reply, the run asks the model again with the hook's words, and the process is stopped by signal 9 while it waits")
  {
    const SID = sid()
    const fixture = await startFixtureApi([handoffTurn(), { kind: 'text', text: 'ASKED-FIRST-REPLY.' }, { kind: 'text', text: 'ASKED-SECOND-REPLY, which the hook blocks.' }, { kind: 'hang', deltas: [] }, { kind: 'text', text: 'ASKED-RESUMED-REPLY.' }])
    const arena = makeArena('later', fixture)
    try {
      const first = await run(arena, ['run', 'ASKED first prompt.', '--model', MODEL, '--session-id', SID, '--format', 'rows'])
      const file = transcriptOf(arena, SID)
      gateTheNextAnswerOnce(arena)
      await runUntilAskedAgainThenKill(arena, fixture, ['run', 'ASKED second prompt.', '--model', MODEL, '--resume', SID, '--format', 'rows'], () => file)
      const rows = await recordOf(file)
      check('A1 the scene: the first turn left its line, and the record ends on the row the run asked the model again with', first.exit === 0 && turnEndLines(file) === 1 && isTheAskAgain(lastSpoken(rows)), j({ exit: first.exit, lines: turnEndLines(file), last: lastSpoken(rows)?.type, meta: lastSpoken(rows)?.isMeta, text: j((lastSpoken(rows)?.message as { content?: unknown } | undefined)?.content).slice(0, 160) }))
      const read = await loaderOn(file, SID)
      check('A2 the loader reads the turn as cut, and says so once', read.state === 'interrupted_prompt' && read.sentence === 1, j(read))
      const older = await asAnOlderBuildLeftIt(file, SID)
      check('A3 control: the same conversation with no line anywhere (the record an older build leaves) is read as before, as a finished turn', older.state === 'none' && older.sentence === 0, j(older))
      const third = await run(arena, ['run', 'ASKED third prompt.', '--model', MODEL, '--resume', SID, '--format', 'rows'])
      check('A4 a third process answers, and its request tells the model once that the previous run ended before its turn finished', third.exit === 0 && third.stdout.includes('ASKED-RESUMED-REPLY.') && wireSays(lastRequest(fixture), CONTINUATION) === 1, `exit=${third.exit} said=${wireSays(lastRequest(fixture), CONTINUATION)} ${third.stderr.slice(-200)}`)
      check('A5 …and that turn leaves its own line: the record reads as finished again', turnEndLines(file) === 2 && (await loaderOn(file, SID)).state === 'none', j({ lines: turnEndLines(file), read: await loaderOn(file, SID) }))
    } finally {
      await fixture.close()
    }
  }

  section('B — control: the same ask-again, answered: the turn ends and nothing reads as cut')
  {
    const SID = sid()
    const fixture = await startFixtureApi([handoffTurn(), { kind: 'text', text: 'ANSWERED-FIRST-REPLY.' }, { kind: 'text', text: 'ANSWERED-SECOND-REPLY, which the hook blocks.' }, { kind: 'text', text: 'ANSWERED-AFTER-THE-ASK.' }])
    const arena = makeArena('answered', fixture)
    try {
      const first = await run(arena, ['run', 'ANSWERED first prompt.', '--model', MODEL, '--session-id', SID, '--format', 'rows'])
      gateTheNextAnswerOnce(arena)
      const second = await run(arena, ['run', 'ANSWERED second prompt.', '--model', MODEL, '--resume', SID, '--format', 'rows'])
      const file = transcriptOf(arena, SID)
      check('B1 the run asks again, is answered and ends its turn: two turns, two lines, the ask-again in the record', first.exit === 0 && second.exit === 0 && second.stdout.includes('ANSWERED-AFTER-THE-ASK.') && turnEndLines(file) === 2 && readFileSync(file, 'utf8').includes(ASKED_AGAIN_WORDS), j({ first: first.exit, second: second.exit, lines: turnEndLines(file), err: second.stderr.slice(-200) }))
      const read = await loaderOn(file, SID)
      check('B2 the loader reads a finished turn, no sentence', read.state === 'none' && read.sentence === 0, j(read))
    } finally {
      await fixture.close()
    }
  }

  section("C — the rule's limit: a session's first turn has no line before it")
  {
    const SID = sid()
    const fixture = await startFixtureApi([handoffTurn(), { kind: 'text', text: 'FIRST-TURN-REPLY, which the hook blocks.' }, { kind: 'hang', deltas: [] }])
    const arena = makeArena('first', fixture)
    try {
      gateTheNextAnswerOnce(arena)
      await runUntilAskedAgainThenKill(arena, fixture, ['run', 'FIRST-TURN prompt.', '--model', MODEL, '--session-id', SID, '--format', 'rows'], () => transcriptOf(arena, SID))
      const file = transcriptOf(arena, SID)
      const rows = await recordOf(file)
      const read = await loaderOn(file, SID)
      check('C1 the same cut inside the first turn of a session: no line stands in the record, and it reads as the record of an older build does', turnEndLines(file) === 0 && isTheAskAgain(lastSpoken(rows)) && read.state === 'none' && read.sentence === 0, j({ lines: turnEndLines(file), last: lastSpoken(rows)?.type, read }))
    } finally {
      await fixture.close()
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n============================================================')
console.log(failures === 0 ? ` ✅ ASKED AGAIN, THEN CUT (${checks} checks)` : ` ❌ ${failures} of ${checks} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
