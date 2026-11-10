#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { handoffTurn, isHandoffRequest, startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const nodeBin = Bun.which('node')
if (!existsSync(DIST) || !nodeBin) {
  console.log(!existsSync(DIST) ? '❌ dist/mercury.mjs absent — build first (the pooled gate prebuilds it)' : '❌ no node binary on PATH')
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'tool-round-record-'))
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
const { ENDED_RUN_TOOL_RESULT } = await import('../../src/utils/messages/rejectionText.ts')
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
  console.log('\n❌ TIMEOUT — the tool-round record proof exceeded 300s')
  process.exit(1)
}, 300_000)
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
type Block = Record<string, unknown> & { type?: string }
const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : [{ type: 'text', text: String(content ?? '') }])
async function recordOf(file: string): Promise<StoredRow[]> {
  if (file === '') return []
  const loaded = await loadTranscriptFile(file, { keepAllLeaves: true })
  return [...loaded.messages.values()] as unknown as StoredRow[]
}
const rowBlocks = (rows: ReadonlyArray<{ type: string; message?: unknown }>): Block[] => rows.flatMap(row => (row.type === 'user' || row.type === 'assistant' ? blocksOf((row.message as { content?: unknown } | undefined)?.content) : []))
const wireBlocks = (request: { body: unknown } | undefined): Block[] => (((request?.body ?? {}) as { messages?: Array<{ content: unknown }> }).messages ?? []).flatMap(message => blocksOf(message.content))
const callsOf = (blocks: Block[], id: string): Block[] => blocks.filter(block => block.type === 'tool_use' && block.id === id)
const resultsOf = (blocks: Block[], id: string): Block[] => blocks.filter(block => block.type === 'tool_result' && block.tool_use_id === id)
const textsOf = (blocks: Block[]): string => j(blocks.filter(block => block.type === 'text').map(block => block.text))

type Scene = {
  name: string
  sessionId: string
  call: Extract<ScriptedTurn, { kind: 'tool_use' }>
  mode: string
  prepare: (arena: Arena) => void
  effect: (arena: Arena) => { file: string; words: string }
  resultSays: string
}

async function stoppedAtTheNextRequest(scene: Scene): Promise<void> {
  const callId = scene.call.id!
  const fixture = await startFixtureApi([handoffTurn(), scene.call, { kind: 'hang', deltas: ['thinking about the result'] }, { kind: 'text', text: `${scene.name}-RESUMED-REPLY.` }])
  const arena = makeArena(scene.name.toLowerCase(), fixture)
  scene.prepare(arena)
  const effect = scene.effect(arena)
  try {
    const child = spawn(nodeBin!, [DIST, 'run', `${scene.name} do the work.`, '--model', MODEL, '--session-id', scene.sessionId, '--mode', scene.mode, '--format', 'rows'], { cwd: arena.cwd, env: arena.env })
    child.stdout.on('data', () => {})
    child.stderr.on('data', () => {})
    const exited = new Promise<'exited'>(resolve => child.on('close', () => resolve('exited')))
    const reached = await Promise.race([fixture.messageRequestStarted(2).then(() => 'second request' as const), exited, new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 60_000))])
    child.kill('SIGKILL')
    await exited
    const sent = wireBlocks(fixture.messageRequests().filter(request => !isHandoffRequest(request))[1])
    const sentResult = resultsOf(sent, callId)[0]
    check(`${scene.name}: the tool ran, its result rode the next request, and the process was stopped by signal 9 as that request arrived`, reached === 'second request' && sentResult !== undefined && sentResult.is_error !== true && j(sentResult.content).includes(scene.resultSays), j({ reached, sentResult }))
    check(`${scene.name}: the work is done on disk`, existsSync(effect.file) && readFileSync(effect.file, 'utf8').includes(effect.words), effect.file)
    const record = await recordOf(transcriptOf(arena, scene.sessionId))
    const stored = rowBlocks(record)
    check(`${scene.name}: the record holds the call`, callsOf(stored, callId).length === 1, j(record.map(row => row.type)))
    const storedResult = resultsOf(stored, callId)[0]
    check(`${scene.name}: the record holds the result the model was sent — a request never leaves ahead of the rows it carries`, resultsOf(stored, callId).length === 1 && storedResult?.is_error !== true && j(storedResult?.content).includes(scene.resultSays), j({ rows: record.map(row => row.type), storedResult }))
    const loaded = await loadConversationForResume(scene.sessionId, transcriptOf(arena, scene.sessionId))
    const resumed = rowBlocks((loaded?.messages ?? []) as Message[])
    check(`${scene.name}: a resume reads the finished call with its own result, never with the sentence for a call whose outcome is unknown`, resultsOf(resumed, callId).length === 1 && j(resultsOf(resumed, callId)[0]?.content).includes(scene.resultSays) && !j(resumed).includes(ENDED_RUN_TOOL_RESULT), j(resultsOf(resumed, callId)))
    check(`${scene.name}: …and reads the turn as cut after that result — the cut-off sentence once`, loaded?.turnInterruptionState.kind === 'interrupted_prompt' && textsOf(resumed).split(CONTINUATION).length - 1 === 1, j({ state: loaded?.turnInterruptionState.kind }))
    const second = await new Promise<{ exit: number | null; stdout: string }>(resolve => {
      const next = spawn(nodeBin!, [DIST, 'run', `${scene.name} what happened?`, '--model', MODEL, '--resume', scene.sessionId, '--mode', scene.mode, '--format', 'rows'], { cwd: arena.cwd, env: arena.env })
      let stdout = ''
      next.stdout.on('data', chunk => (stdout += String(chunk)))
      next.stderr.on('data', () => {})
      const killer = setTimeout(() => next.kill('SIGKILL'), 90_000)
      next.on('close', exit => {
        clearTimeout(killer)
        resolve({ exit, stdout })
      })
    })
    const resumedWire = wireBlocks(fixture.messageRequests().filter(request => !isHandoffRequest(request)).at(-1))
    const resumedResult = resultsOf(resumedWire, callId)
    check(`${scene.name}: the second process answered, and its request carries the call once with the result the tool gave`, second.exit === 0 && second.stdout.includes(`${scene.name}-RESUMED-REPLY.`) && callsOf(resumedWire, callId).length === 1 && resumedResult.length === 1 && resumedResult[0]?.is_error !== true && j(resumedResult[0]?.content).includes(scene.resultSays), `exit=${second.exit} ${j(resumedResult)}`)
    check(`${scene.name}: …and nowhere says the call's outcome is unknown`, !j(resumedWire).includes(ENDED_RUN_TOOL_RESULT), j(resumedResult))
    check(`${scene.name}: the work on disk is as the first process left it`, readFileSync(effect.file, 'utf8').includes(effect.words))
  } finally {
    await fixture.close()
  }
}

console.log('============================================================')
console.log(' a tool round is on the record before the next request leaves')
console.log('============================================================')

try {
  section('D1 — a writing tool that returns at once: the process is stopped as the request that carries its result arrives')
  await stoppedAtTheNextRequest({
    name: 'D1',
    sessionId: 'facef00d-0000-4000-8000-0000000d1a01',
    call: { kind: 'tool_use', name: 'Write', id: 'toolu_d1_write', input: {} },
    mode: 'implement',
    prepare(arena) {
      this.call.input = { file_path: join(arena.cwd, 'd1-effect.txt'), content: 'D1-EFFECT-ONCE' }
    },
    effect: arena => ({ file: join(arena.cwd, 'd1-effect.txt'), words: 'D1-EFFECT-ONCE' }),
    resultSays: 'd1-effect.txt',
  })

  section('D2 — a shell command that takes its time (the record is quiet when its result lands): the same stop')
  await stoppedAtTheNextRequest({
    name: 'D2',
    sessionId: 'facef00d-0000-4000-8000-0000000d2a01',
    call: { kind: 'tool_use', name: 'Bash', id: 'toolu_d2_shell', input: { command: 'node d2-work.mjs', description: 'Does the slow work' } },
    mode: 'sovereign',
    prepare(arena) {
      writeFileSync(join(arena.cwd, 'd2-work.mjs'), "import { writeFileSync } from 'node:fs'\nsetTimeout(() => {\n  writeFileSync('d2-effect.txt', 'D2-EFFECT-ONCE')\n  console.log('D2-SIDE-EFFECT-DONE')\n}, 600)\n")
    },
    effect: arena => ({ file: join(arena.cwd, 'd2-effect.txt'), words: 'D2-EFFECT-ONCE' }),
    resultSays: 'D2-SIDE-EFFECT-DONE',
  })

  section('D3 — a process that stays up between prompts: the second prompt of a warm process, stopped as the request that carries it arrives')
  {
    const SID3 = 'facef00d-0000-4000-8000-0000000d3a01'
    const fixture = await startFixtureApi([handoffTurn(), { kind: 'text', text: 'D3-FIRST-REPLY.' }, { kind: 'hang', deltas: ['thinking'] }, { kind: 'text', text: 'D3-RESUMED-REPLY.' }])
    const arena = makeArena('d3', fixture)
    try {
      const child = spawn(nodeBin!, [DIST, 'run', '--input', 'rows', '--format', 'rows', '--model', MODEL, '--session-id', SID3], { cwd: arena.cwd, env: arena.env, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      child.stdout!.on('data', chunk => (stdout += String(chunk)))
      child.stderr!.on('data', () => {})
      const exited = new Promise<'exited'>(resolve => child.on('close', () => resolve('exited')))
      const until = async (test: () => boolean, ms: number): Promise<boolean> => {
        const deadline = Date.now() + ms
        while (!test()) {
          if (Date.now() >= deadline) return false
          await new Promise(tick => setTimeout(tick, 20))
        }
        return true
      }
      child.stdin!.write(JSON.stringify({ type: 'prompt', content: 'D3 first prompt.' }) + '\n')
      const firstDone = await until(() => stdout.includes('"type":"outcome"'), 60_000)
      await new Promise(tick => setTimeout(tick, 600))
      child.stdin!.write(JSON.stringify({ type: 'prompt', content: 'D3 second prompt.' }) + '\n')
      const reached = await Promise.race([fixture.messageRequestStarted(2).then(() => 'second request' as const), exited, new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 60_000))])
      child.kill('SIGKILL')
      await exited
      const sent = wireBlocks(fixture.messageRequests().filter(request => !isHandoffRequest(request))[1])
      check('D3: the first turn completed, the second prompt rode a request, and the process was stopped by signal 9 as that request arrived', firstDone && reached === 'second request' && textsOf(sent).includes('D3 second prompt.'), j({ firstDone, reached }))
      const record = await recordOf(transcriptOf(arena, SID3))
      const prompts = record.filter(row => row.type === 'user').map(row => j((row.message as { content?: unknown } | undefined)?.content))
      check('D3: the record holds the second prompt — the operator\'s words are on disk before the request that carries them leaves', prompts.some(text => text.includes('D3 second prompt.')), j(prompts))
      const second = await new Promise<{ exit: number | null; stdout: string }>(resolve => {
        const next = spawn(nodeBin!, [DIST, 'run', 'D3 third prompt.', '--model', MODEL, '--resume', SID3, '--format', 'rows'], { cwd: arena.cwd, env: arena.env })
        let out = ''
        next.stdout.on('data', chunk => (out += String(chunk)))
        next.stderr.on('data', () => {})
        const killer = setTimeout(() => next.kill('SIGKILL'), 90_000)
        next.on('close', exit => {
          clearTimeout(killer)
          resolve({ exit, stdout: out })
        })
      })
      const resumedWire = wireBlocks(fixture.messageRequests().filter(request => !isHandoffRequest(request)).at(-1))
      check('D3: a process that resumes the session answers, and its request still carries the second prompt, once', second.exit === 0 && second.stdout.includes('D3-RESUMED-REPLY.') && textsOf(resumedWire).split('D3 second prompt.').length - 1 === 1, `exit=${second.exit} ${textsOf(resumedWire).slice(0, 400)}`)
    } finally {
      await fixture.close()
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n============================================================')
console.log(failures === 0 ? ` ✅ TOOL ROUND ON RECORD (${checks} checks)` : ` ❌ ${failures} of ${checks} TOOL-ROUND CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
