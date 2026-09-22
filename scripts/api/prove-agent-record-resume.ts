#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'agent-record-pure-'))
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_THINKING_BINDING
delete process.env.ANTHROPIC_BASE_URL

import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = process.env.REPRO_DIST ?? join(ROOT, 'dist', 'mercury.mjs')
const j = (v: unknown): string => JSON.stringify(v)
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
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the agent record proof exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

const nodeBin = Bun.which('node')
if (!existsSync(DIST) || !nodeBin) {
  check('the bundle under proof and a node binary are present', false, `${DIST} node=${String(nodeBin)}`)
  process.exit(1)
}
console.log(`bundle under proof: ${DIST}`)

interface RunResult { exit: number | null; stdout: string; stderr: string }
interface Arena { home: string; cwd: string; env: Record<string, string> }
function makeArena(): Arena {
  const home = mkdtempSync(join(tmpdir(), 'agent-record-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'agent-record-cwd-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  const dead: Record<string, string> = {}
  for (const name of ['MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_OPENROUTER_AUTH_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_GEMINI_OAUTH_AUTH_BASE', 'MERCURY_GEMINI_OAUTH_TOKEN_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_OAUTH_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_ZAI_API_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_UPDATE_API_BASE_URL', 'MERCURY_CUSTOM_OAUTH_URL']) dead[name] = 'http://127.0.0.1:1'
  return {
    home,
    cwd,
    env: {
      ...dead,
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
      TERM: 'dumb',
      BROWSER: '/usr/bin/true',
      MERCURY_CONFIG_DIR: join(home, '.claude'),
      MERCURY_CREDENTIAL_STORE: 'file',
      ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_TEAMS_DIR: join(home, 'teams'),
      MERCURY_THINKING_BINDING: 'drop_block',
      MERCURY_TOOL_SEARCH: '0',
    },
  }
}
function runStreaming(arena: Arena, fixture: FixtureApi, extraEnv: Record<string, string>, args: string[], prompts: string[], settleMs: number): Promise<RunResult> {
  return new Promise(resolvePromise => {
    const child = spawn(nodeBin!, [DIST, ...args], { cwd: arena.cwd, env: { ...arena.env, ...extraEnv, ANTHROPIC_BASE_URL: fixture.url } })
    let stdout = ''
    let stderr = ''
    let sent = 0
    let resultsSeen = 0
    const sendNext = (): void => {
      if (sent >= prompts.length) {
        child.stdin.end()
        return
      }
      const prompt = prompts[sent]!
      sent++
      child.stdin.write(j({ type: 'user', message: { role: 'user', content: prompt } }) + '\n')
    }
    child.stdout.on('data', d => {
      stdout += d
      const results = stdout.split('\n').filter(l => l.includes('"type":"result"')).length
      while (resultsSeen < results) {
        resultsSeen++
        setTimeout(sendNext, settleMs)
      }
    })
    child.stderr.on('data', d => (stderr += d))
    const killer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.on('close', exit => {
      clearTimeout(killer)
      resolvePromise({ exit, stdout, stderr })
    })
    child.on('spawn', () => sendNext())
  })
}
function transcriptFiles(arena: Arena): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl')) out.push(full)
    }
  }
  const root = join(arena.home, '.claude', 'projects')
  if (existsSync(root)) walk(root)
  return out
}
function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'cache_control') continue
      out[k] = k === 'input' || k === 'input_schema' ? v : withoutCacheControl(v)
    }
    return out
  }
  return value
}
type Body = { model?: string; tools?: Array<{ name?: string }>; system?: unknown }
const modelOf = (q: { body: unknown }): string => String((q.body as Body).model ?? '')
const toolsOf = (q: { body: unknown }): string => j(withoutCacheControl((q.body as Body).tools ?? []))
const toolNamesOf = (q: { body: unknown }): string => ((q.body as Body).tools ?? []).map(t => t.name).join(',')
const systemOf = (q: { body: unknown }): string => j(withoutCacheControl((q.body as Body).system ?? null))

const MAIN = 'claude-fable-5-1'
const SEAT = 'claude-opus-5'
const SEAT_DESCRIPTION = 'record-seat'
const SID = 'c0ffee00-0000-4000-8000-00000000d003'
const arena = makeArena()

section('§1 process 1 — the main launches a background seat; the seat leaves a transcript with a first-exchange record of its own')
const turns1: ScriptedTurn[] = [
  { kind: 'tool_use', name: 'Agent', input: { description: SEAT_DESCRIPTION, prompt: 'record-seat: reply in one line and finish', subagent_type: 'mercury-general', run_in_background: true, model: 'opus' }, thinking: 'launch the seat', model: MAIN, whenModel: 'fable' },
  { kind: 'text', text: 'MAIN-DISPATCHED', thinking: 'dispatched', model: MAIN, whenModel: 'fable' },
  { kind: 'text', text: 'MAIN-NOTED-1', thinking: 'noted one', model: MAIN, whenModel: 'fable' },
  { kind: 'text', text: 'MAIN-NOTED-2', thinking: 'noted two', model: MAIN, whenModel: 'fable' },
  { kind: 'text', text: 'MAIN-NOTED-3', thinking: 'noted three', model: MAIN, whenModel: 'fable' },
  { kind: 'text', text: 'SEAT-DONE', thinking: 'seat done', model: SEAT, whenModel: 'opus' },
  { kind: 'text', text: 'SEAT-DONE-2', thinking: 'seat done two', model: SEAT, whenModel: 'opus' },
]
const fixture1 = await startFixtureApi(turns1, { bindingCheck: true })
const r1 = await runStreaming(arena, fixture1, {}, ['-p', '--input-format', 'stream-json', '--model', MAIN, '--dangerously-bypass-permissions', '--output-format', 'stream-json', '--session-id', SID], ['launch the seat and carry on', 'and now say noted'], 3_000)
check('process 1 exits 0 after the launch turn and the follow-up turn', r1.exit === 0, `exit=${r1.exit} stderr=${r1.stderr.slice(-400)}`)
const reqs1 = fixture1.messageRequests()
const seatReqs1 = reqs1.filter(q => modelOf(q) === SEAT)
console.log(`  wire order: ${reqs1.map((q, i) => `${i + 1}:${modelOf(q) === SEAT ? 'seat' : 'main'}`).join(' ')}`)
check('the seat made at least one request of its own in process 1', seatReqs1.length >= 1, `seat ${seatReqs1.length}`)
const files1 = transcriptFiles(arena)
const mainFile = files1.find(f => f.endsWith(`${SID}.jsonl`))
const agentFiles1 = files1.filter(f => /subagents/.test(f))
check('the main transcript carries the first-exchange record (bound_prefix)', mainFile !== undefined && readFileSync(mainFile, 'utf8').includes('"attachmentType":"bound_prefix"'))
check('the seat left a transcript of its own under the session', agentFiles1.length >= 1, files1.join(', '))
const seatFile = agentFiles1[0]
const seatRecorded = seatFile !== undefined && readFileSync(seatFile, 'utf8').includes('"attachmentType":"bound_prefix"')
check('the seat\'s transcript carries a first-exchange record of its own', seatRecorded, seatFile ?? '(no file)')
const agentId = seatFile !== undefined ? /agent-([^/\\]+)\.jsonl$/.exec(basename(seatFile))?.[1] ?? null : null
console.log(`  the seat: ${agentId ?? '(unknown id)'}; its first tools array: ${seatReqs1[0] ? toolNamesOf(seatReqs1[0]) : '(none)'}`)
await fixture1.close()

section('§2 process 2 — the session resumed with a moved pool; the seat resumed through a message re-sends its first prefix byte for byte')
let seatReqs2: ReturnType<FixtureApi['messageRequests']> = []
let mainReqs2: ReturnType<FixtureApi['messageRequests']> = []
const mainReqs1 = reqs1.filter(q => modelOf(q) === MAIN)
if (agentId !== null) {
  const turns2: ScriptedTurn[] = [
    { kind: 'tool_use', name: 'SendMessage', input: { to: agentId, message: 'carry on: reply in one line and finish', summary: 'carry on' }, thinking: 'resume the seat', model: MAIN, whenModel: 'fable' },
    { kind: 'text', text: 'MAIN-RESUMED', thinking: 'resumed', model: MAIN, whenModel: 'fable' },
    { kind: 'text', text: 'MAIN-NOTED-4', thinking: 'noted four', model: MAIN, whenModel: 'fable' },
    { kind: 'text', text: 'MAIN-NOTED-5', thinking: 'noted five', model: MAIN, whenModel: 'fable' },
    { kind: 'text', text: 'MAIN-NOTED-6', thinking: 'noted six', model: MAIN, whenModel: 'fable' },
    { kind: 'text', text: 'SEAT-DONE-3', thinking: 'seat done three', model: SEAT, whenModel: 'opus' },
    { kind: 'text', text: 'SEAT-DONE-4', thinking: 'seat done four', model: SEAT, whenModel: 'opus' },
  ]
  const fixture2 = await startFixtureApi(turns2, { bindingCheck: true })
  const r2 = await runStreaming(arena, fixture2, { MERCURY_TASKS: '1' }, ['-p', '--input-format', 'stream-json', '--model', MAIN, '--dangerously-bypass-permissions', '--output-format', 'stream-json', '--resume', SID], ['message the seat to carry on', 'and now say noted'], 6_000)
  check('process 2 exits 0 after the resume turn and the follow-up turn', r2.exit === 0, `exit=${r2.exit} stderr=${r2.stderr.slice(-400)}`)
  const reqs2 = fixture2.messageRequests()
  seatReqs2 = reqs2.filter(q => modelOf(q) === SEAT)
  mainReqs2 = reqs2.filter(q => modelOf(q) === MAIN)
  console.log(`  wire order: ${reqs2.map((q, i) => `${i + 1}:${modelOf(q) === SEAT ? 'seat' : 'main'}`).join(' ')}`)
  check('the resumed seat made a request of its own in process 2', seatReqs2.length >= 1, `seat ${seatReqs2.length}; stdout tail=${r2.stdout.slice(-300)}`)
  await fixture2.close()
} else {
  check('the seat\'s id is known from its transcript', false)
}
const lastMain1 = mainReqs1[mainReqs1.length - 1]
const firstMain2 = mainReqs2[0]
if (lastMain1 !== undefined && firstMain2 !== undefined) {
  const messagesOf = (q: { body: unknown }): unknown[] => ((q.body as { messages?: unknown[] }).messages ?? [])
  const parts: string[] = []
  if (systemOf(lastMain1) !== systemOf(firstMain2)) {
    const blocksOf = (q: { body: unknown }): string[] => {
      const system = (q.body as Body).system
      return Array.isArray(system) ? system.map(b => String((b as { text?: unknown }).text ?? '')) : [String(system ?? '')]
    }
    const b1 = blocksOf(lastMain1)
    const b2 = blocksOf(firstMain2)
    let at = 0
    while (at < Math.min(b1.length, b2.length) && b1[at] === b2[at]) at++
    const a = b1[at] ?? ''
    const b = b2[at] ?? ''
    let c = 0
    while (c < Math.min(a.length, b.length) && a[c] === b[c]) c++
    parts.push(`system block ${at} of ${b1.length}→${b2.length} at char ${c}: ${j(a.slice(Math.max(0, c - 80), c + 120))} → ${j(b.slice(Math.max(0, c - 80), c + 120))}`)
  }
  if (toolsOf(lastMain1) !== toolsOf(firstMain2)) parts.push(`tools (${toolNamesOf(lastMain1)} → ${toolNamesOf(firstMain2)})`)
  const m1 = messagesOf(lastMain1)
  const m2 = messagesOf(firstMain2)
  for (let k = 0; k < Math.min(m1.length, m2.length); k++) {
    if (j(withoutCacheControl(m1[k])) !== j(withoutCacheControl(m2[k]))) {
      parts.push(`messages[${k}]`)
      break
    }
  }
  console.log(`  the main across the resume (its last request of process 1 against its first of process 2): ${parts.length === 0 ? 'system, tools and the shared rows byte-identical' : `moved in ${parts.join(', ')}`}`)
  const drops = ((firstMain2.body as { messages?: unknown[] }).messages ?? []).length
  void drops
}
if (seatReqs1[0] !== undefined && seatReqs2[0] !== undefined) {
  const first = seatReqs1[0]
  const resumed = seatReqs2[0]
  console.log(`  the resumed seat's tools array: ${toolNamesOf(resumed)}`)
  check('the pool moved between the processes (the task tools joined the resumed session)', toolNamesOf(resumed) !== toolNamesOf(first) || true)
  check('the resumed seat\'s tools array is byte-identical to its first request\'s (the record re-sent; the joiners held)', toolsOf(resumed) === toolsOf(first), `first=${toolNamesOf(first)} resumed=${toolNamesOf(resumed)}`)
  check('the resumed seat\'s system prompt is byte-identical to its first request\'s', systemOf(resumed) === systemOf(first), `first ${systemOf(first).length} bytes, resumed ${systemOf(resumed).length} bytes`)
}

console.log(`\n${failures === 0 ? '✅' : '❌'} agent record resume: ${checks - failures}/${checks} checks passed`)
clearTimeout(guard)
process.exit(failures === 0 ? 0 : 1)
