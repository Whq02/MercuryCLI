#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const fixtures: FixtureApi[] = []
async function fixture(turns: ScriptedTurn[]): Promise<FixtureApi> {
  const fx = await startFixtureApi(turns)
  fixtures.push(fx)
  return fx
}

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

if (!existsSync(DIST)) {
  console.log('❌ dist/mercury.mjs absent — build first (the pooled gate prebuilds it)')
  process.exit(1)
}
const nodeBin = Bun.which('node')
if (!nodeBin) {
  console.log('❌ no node binary on PATH')
  process.exit(1)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — machine-output contract exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

function interactiveBytes(s: string): string | null {
  // eslint-disable-next-line no-control-regex
  const m = s.match(/\x1b\[[^m]*[A-Za-ln-z]|\x1b\]|\x1b\(|\x1b\[\?/)
  return m ? JSON.stringify(m[0]) : null
}

interface Capture {
  stdout: string
  stderr: string
  exit: number | null
}

async function runDist(
  argv: string[],
  opts: { baseUrl?: string; stdinText?: string; extraEnv?: Record<string, string>; timeoutMs?: number; dropKeys?: string[] } = {},
): Promise<Capture> {
  const home = mkdtempSync(join(tmpdir(), 'lucid-mo-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'lucid-mo-cwd-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  const env: Record<string, string> = {
    HOME: home,
    PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
    TERM: 'dumb',
    MERCURY_CONFIG_DIR: join(home, '.claude'),
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    ...opts.extraEnv,
  }
  if (opts.baseUrl) env.ANTHROPIC_BASE_URL = opts.baseUrl
  for (const key of opts.dropKeys ?? []) delete env[key]
  const child = spawn(nodeBin!, [DIST, ...argv], { cwd, env })
  const killer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 120_000)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', d => (stdout += d))
  child.stderr.on('data', d => (stderr += d))
  if (opts.stdinText !== undefined) child.stdin.write(opts.stdinText)
  child.stdin.end()
  const exit = await new Promise<number | null>(res =>
    child.on('close', c => {
      clearTimeout(killer)
      res(c)
    }),
  )
  return { stdout, stderr, exit }
}

function assertClean(label: string, cap: Capture): void {
  const outHit = interactiveBytes(cap.stdout)
  const errHit = interactiveBytes(cap.stderr)
  check(`${label}: zero interactive bytes on stdout`, outHit === null, outHit ?? '')
  check(`${label}: zero interactive bytes on stderr`, errHit === null, errHit ?? '')
}

section('L1 — plain success: stdout = result + newline exactly')
{
  const fx = await fixture([{ kind: 'text', text: 'PROOF-PLAIN-OK.' }])
  const cap = await runDist(['-p', 'say the phrase'], { baseUrl: fx.url })
  check('stdout is the result plus one trailing newline', cap.stdout === 'PROOF-PLAIN-OK.\n', JSON.stringify(cap.stdout))
  check('stderr is empty', cap.stderr === '', JSON.stringify(cap.stderr.slice(0, 200)))
  check('exit 0', cap.exit === 0, String(cap.exit))
  assertClean('L1', cap)
}

section('L2 — piped stdin: same contract')
{
  const fx = await fixture([{ kind: 'text', text: 'PROOF-STDIN-OK.' }])
  const cap = await runDist(['-p'], { baseUrl: fx.url, stdinText: 'hello from a pipe\n' })
  check('stdout is the result plus one trailing newline', cap.stdout === 'PROOF-STDIN-OK.\n', JSON.stringify(cap.stdout))
  check('stderr is empty', cap.stderr === '', JSON.stringify(cap.stderr.slice(0, 200)))
  check('exit 0', cap.exit === 0, String(cap.exit))
  assertClean('L2', cap)
}

section('L3 — §8-10 preservation: internal-looking model content passes byte-exact')
{
  const preserve =
    'Operator content: MERCURY_FABLE=1 [object Object] at file:///tmp/x.ts:1:1 {{UNRESOLVED}} Error: fake\n    at stack (bundle.mjs:9:9)'
  const fx = await fixture([{ kind: 'text', text: preserve }])
  const cap = await runDist(['-p', 'echo it back'], { baseUrl: fx.url })
  check('stdout preserves the content byte-exact (plus trailing newline)', cap.stdout === preserve + '\n', JSON.stringify(cap.stdout.slice(0, 200)))
  check('exit 0', cap.exit === 0, String(cap.exit))
  assertClean('L3', cap)
}

section('L4 — plain failure (API 400): stderr + newline; stdout ZERO bytes; exit 1')
{
  const fx = await fixture([
    { kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'lucid-fixture-bad-request' },
  ])
  const cap = await runDist(['-p', 'hello'], { baseUrl: fx.url })
  check('stdout carries zero bytes', cap.stdout === '', JSON.stringify(cap.stdout.slice(0, 200)))
  check('stderr carries the failure text', cap.stderr.includes('lucid-fixture-bad-request'), JSON.stringify(cap.stderr.slice(0, 200)))
  check('stderr ends with a newline', cap.stderr.endsWith('\n'), JSON.stringify(cap.stderr.slice(-20)))
  check('exit 1', cap.exit === 1, String(cap.exit))
  assertClean('L4', cap)
}

section('L5 — plain failure subtype (max turns): stderr + newline; stdout empty; exit 1')
{
  const fx = await fixture([
    { kind: 'tool_use', name: 'Glob', input: { pattern: '*.md' } },
    { kind: 'tool_use', name: 'Glob', input: { pattern: '*.ts' } },
    { kind: 'text', text: 'never reached' },
  ])
  const cap = await runDist(['-p', 'list things', '--max-turns', '1'], { baseUrl: fx.url })
  check('stdout carries zero bytes', cap.stdout === '', JSON.stringify(cap.stdout.slice(0, 200)))
  check('stderr names the max-turns consequence', /max(imum number of)? turns/i.test(cap.stderr), JSON.stringify(cap.stderr.slice(0, 200)))
  check('stderr ends with a newline', cap.stderr.endsWith('\n'), JSON.stringify(cap.stderr.slice(-20)))
  check('exit 1', cap.exit === 1, String(cap.exit))
  assertClean('L5', cap)
}

section('L6 — tool-use round: no tool chatter on the protocol boundary')
{
  const fx = await fixture([
    { kind: 'tool_use', name: 'Glob', input: { pattern: '*.zzz-none' } },
    { kind: 'text', text: 'PROOF-TOOL-DONE.' },
  ])
  const cap = await runDist(['-p', 'glob then answer'], { baseUrl: fx.url })
  check('stdout is the final result only', cap.stdout === 'PROOF-TOOL-DONE.\n', JSON.stringify(cap.stdout.slice(0, 200)))
  check('stderr is empty', cap.stderr === '', JSON.stringify(cap.stderr.slice(0, 200)))
  check('exit 0', cap.exit === 0, String(cap.exit))
  assertClean('L6', cap)
}

function parseLines(cap: Capture): { parsed: Record<string, unknown>[]; bad: string[] } {
  const parsed: Record<string, unknown>[] = []
  const bad: string[] = []
  for (const line of cap.stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      parsed.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      bad.push(line)
    }
  }
  return { parsed, bad }
}

section('L7 — stream-json success: every stdout line parses; typed result envelope')
{
  const fx = await fixture([{ kind: 'text', text: 'PROOF-SJ-OK.' }])
  const cap = await runDist(['-p', 'hello', '--output-format', 'stream-json'], { baseUrl: fx.url })
  const { parsed, bad } = parseLines(cap)
  check('every stdout line individually JSON-parses', bad.length === 0, bad[0]?.slice(0, 120) ?? '')
  check('the feed opens with the init event, with no option asked for', parsed[0]?.type === 'system' && parsed[0]?.subtype === 'init', JSON.stringify(parsed[0] ?? {}).slice(0, 120))
  const result = parsed.find(e => e.type === 'result') as { is_error?: boolean } | undefined
  check('a typed result envelope is present', !!result)
  check('the result is not an error', result?.is_error === false, JSON.stringify(result ?? {}).slice(0, 200))
  check('exit 0', cap.exit === 0, String(cap.exit))
  assertClean('L7', cap)
}

section('L8 — stream-json failure: framing holds; the typed error record rides the schema')
{
  const fx = await fixture([
    { kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'lucid-sj-bad-request' },
  ])
  const cap = await runDist(['-p', 'hello', '--output-format', 'stream-json'], { baseUrl: fx.url })
  const { parsed, bad } = parseLines(cap)
  check('every stdout line individually JSON-parses', bad.length === 0, bad[0]?.slice(0, 120) ?? '')
  const result = parsed.find(e => e.type === 'result') as { is_error?: boolean; subtype?: string; errors?: string[] } | undefined
  check('the result envelope carries is_error', result?.is_error === true, JSON.stringify(result ?? {}).slice(0, 200))
  check(
    'the error text rides the typed record, not a free-form line',
    result?.subtype === 'error_during_execution' &&
      Array.isArray(result?.errors) &&
      result.errors.some(e => typeof e === 'string' && e.includes('lucid-sj-bad-request')),
    JSON.stringify(result ?? {}).slice(0, 200),
  )
  check('exit 1', cap.exit === 1, String(cap.exit))
  assertClean('L8', cap)
}

section('L9 — --verbose is not an option: the plain format answers the unknown-option refusal')
{
  const cap = await runDist(['-p', 'hello', '--verbose'])
  const control = await runDist(['-p', 'hello', '--zzz-not-an-option'])
  check("stderr names the unknown option", cap.stderr.includes("unknown option '--verbose'"), cap.stderr.slice(0, 120))
  check('stdout carries zero bytes', cap.stdout.length === 0, cap.stdout.slice(0, 80))
  check('the exit code is the one every unknown option answers', cap.exit !== 0 && cap.exit === control.exit, `exit=${cap.exit} control=${control.exit}`)
  check('a usage error exits 2', cap.exit === 2, String(cap.exit))
  assertClean('L9', cap)
}

async function driveDist(
  baseUrl: string,
  script: (send: (frame: unknown) => void, settled: () => Promise<void>) => Promise<void>,
): Promise<{ frames: Record<string, unknown>[]; exit: number | null; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), 'lucid-mo-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'lucid-mo-cwd-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  const env: Record<string, string> = {
    HOME: home,
    PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
    TERM: 'dumb',
    MERCURY_CONFIG_DIR: join(home, '.claude'),
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: baseUrl,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
  }
  const child = spawn(nodeBin!, [DIST, '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--permission-channel', 'stdio'], { cwd, env })
  const killer = setTimeout(() => child.kill('SIGKILL'), 120_000)
  const frames: Record<string, unknown>[] = []
  const waiters: Array<() => void> = []
  let buffer = ''
  let stderr = ''
  const send = (frame: unknown): void => {
    child.stdin.write(JSON.stringify(frame) + '\n')
  }
  child.stdout.on('data', chunk => {
    buffer += chunk
    let at: number
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (!line.trim()) continue
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(line) as Record<string, unknown>
      } catch {
        frames.push({ unparsed: line })
        continue
      }
      frames.push(frame)
      if (frame.type === 'control_request') {
        const request = frame.request as Record<string, unknown>
        if (request.subtype === 'can_use_tool') {
          send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { behavior: 'allow', updated_input: request.input } } })
        }
      }
      if (frame.type === 'result' || frame.type === 'control_response') waiters.shift()?.()
    }
  })
  child.stderr.on('data', chunk => (stderr += chunk))
  const settled = (): Promise<void> => Promise.race([new Promise<void>(resolve => waiters.push(resolve)), new Promise<void>(resolve => setTimeout(resolve, 45_000))])
  await script(send, settled)
  child.stdin.end()
  const exit = await new Promise<number | null>(resolve =>
    child.on('close', code => {
      clearTimeout(killer)
      resolve(code)
    }),
  )
  return { frames, exit, stderr }
}

const SNAKE = /^[a-z0-9]+(_[a-z0-9]+)*$/
const RIDING_PATHS = new Set(['message', 'event', 'usage', 'input', 'tool_use_result', 'permission_suggestions', 'updated_permissions', 'config', 'effective', 'sources', 'provenance', 'models'])
const NAME_KEYED = new Set(['model_usage', 'extensions', 'skill_states', 'errors', 'headers', 'env'])
function oddKeys(value: unknown, path: string, out: string[], namesAreData = false): void {
  if (Array.isArray(value)) {
    for (const item of value) oddKeys(item, `${path}[]`, out)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const here = `${path}.${key}`
    if (!namesAreData && !SNAKE.test(key)) out.push(here)
    if (RIDING_PATHS.has(key)) continue
    oddKeys(inner, here, out, NAME_KEYED.has(key))
  }
}

section('L10 — the one spelling: every driven frame is a declared type with snake_case keys')
{
  const fx = await fixture([
    { kind: 'tool_use', name: 'Glob', input: { pattern: '*.zzz-none' } },
    { kind: 'text', text: 'PROOF-SPELLING-DONE.' },
  ])
  let seq = 0
  const controlIds: string[] = []
  const run = await driveDist(fx.url, async (send, settled) => {
    const control = async (request: Record<string, unknown>): Promise<void> => {
      const id = `spelling-${++seq}`
      controlIds.push(id)
      const done = settled()
      send({ type: 'control_request', request_id: id, request })
      await done
    }
    await control({ subtype: 'initialize', hooks: {}, host_mcp_servers: [] })
    const turn = settled()
    send({ type: 'user', message: { role: 'user', content: 'glob then answer' } })
    await turn
    await control({ subtype: 'session_facts' })
    await control({ subtype: 'mcp_status' })
    await control({ subtype: 'get_settings' })
    await control({ subtype: 'get_context_usage' })
    await control({ subtype: 'set_effort', effort: 'high' })
    await control({ subtype: 'channel_enable', server_name: 'x' })
    await control({ subtype: 'remote_control', enabled: true })
    await control({ subtype: 'claude_authenticate' })
    await control({ subtype: 'no_such_subtype_probe' })
  })
  const declaredTypes = new Set(['assistant', 'user', 'result', 'system', 'stream_event', 'tool_progress', 'tool_use_summary', 'rate_limit_event', 'prompt_suggestion', 'control_response', 'control_request', 'control_cancel_request'])
  const declaredSystem = new Set(['init', 'compact_boundary', 'model_transition', 'status', 'turn_started', 'mission_updated', 'api_retry', 'hook_started', 'hook_progress', 'hook_response', 'task_notification', 'task_started', 'session_state_changed', 'task_progress', 'elicitation_complete'])
  const unparsed = run.frames.filter(f => 'unparsed' in f)
  check('every stdout line parses', unparsed.length === 0, JSON.stringify(unparsed[0] ?? '').slice(0, 120))
  const undeclared = run.frames.filter(f => !declaredTypes.has(String(f.type)) || (f.type === 'system' && !declaredSystem.has(String(f.subtype))))
  check('every frame is a declared type', undeclared.length === 0, JSON.stringify(undeclared.map(f => `${String(f.type)}/${String(f.subtype ?? '')}`)))
  const odd: string[] = []
  for (const frame of run.frames) oddKeys(frame, `${String(frame.type)}${frame.subtype ? `/${String(frame.subtype)}` : ''}`, odd)
  check('every key the feed defines is snake_case at every depth', odd.length === 0, JSON.stringify([...new Set(odd)].slice(0, 30)))
  const init = run.frames.find(f => f.type === 'system' && f.subtype === 'init') as Record<string, unknown> | undefined
  check('the init frame carries permission_mode, skills and extensions and no credential-source word', init !== undefined && typeof init.permission_mode === 'string' && Array.isArray(init.skills) && Array.isArray(init.extensions) && !('apiKeySource' in init) && !('permissionMode' in init), JSON.stringify(Object.keys(init ?? {})))
  const result = run.frames.find(f => f.type === 'result') as Record<string, unknown> | undefined
  check('the result frame carries model_usage keyed by model id with snake_case rows', result !== undefined && typeof result.model_usage === 'object' && !('modelUsage' in result), JSON.stringify(result?.model_usage ?? null).slice(0, 200))
  const answers = new Map<string, Record<string, unknown>>()
  for (const frame of run.frames) {
    if (frame.type !== 'control_response') continue
    const response = frame.response as { request_id?: string; subtype?: string; response?: Record<string, unknown>; error?: string }
    if (response?.request_id) answers.set(response.request_id, response as Record<string, unknown>)
  }
  const facts = answers.get('spelling-2')?.response as Record<string, unknown> | undefined
  check('the facts answer spells its sections snake_case', facts !== undefined && 'permission_mode' in facts && typeof (facts.usage as Record<string, unknown> | undefined)?.total_cost_usd === 'number' && 'first_party_api' in ((facts.identity as Record<string, unknown> | undefined) ?? {}), JSON.stringify(Object.keys(facts ?? {})))
  const status = answers.get('spelling-3')?.response as Record<string, unknown> | undefined
  check('the MCP status answer lists mcp_servers rows with server_info', status !== undefined && Array.isArray(status.mcp_servers) && (status.mcp_servers as Record<string, unknown>[]).every(row => !('serverInfo' in row) && !('capabilities' in row)), JSON.stringify(status ?? null).slice(0, 200))
  const settings = answers.get('spelling-4')?.response as Record<string, unknown> | undefined
  check('the settings answer spells applied.effort_requested', settings !== undefined && 'effort_requested' in ((settings.applied as Record<string, unknown> | undefined) ?? {}), JSON.stringify(settings?.applied ?? null))
  const contextUsage = answers.get('spelling-5')?.response as Record<string, unknown> | undefined
  check('the context usage answer spells total_tokens and grid_rows', contextUsage !== undefined && 'total_tokens' in contextUsage && 'grid_rows' in contextUsage, JSON.stringify(Object.keys(contextUsage ?? {})))
  check('exit 0', run.exit === 0, `${String(run.exit)} ${run.stderr.slice(0, 200)}`)

  section('L11 — a retired control subtype gets the generic unsupported-subtype answer')
  for (const [id, word] of [['spelling-7', 'channel_enable'], ['spelling-8', 'remote_control'], ['spelling-9', 'claude_authenticate'], ['spelling-10', 'no_such_subtype_probe']] as const) {
    const answer = answers.get(id)
    check(`${word} → unsupported control request subtype`, answer?.subtype === 'error' && String(answer.error) === `unsupported control request subtype: ${word}`, JSON.stringify(answer ?? null))
  }
}

section('L12 — every refusal of the feed is one envelope: one field set, one usage shape')
{
  const a = await runDist(['-p', 'hello', '--output-format', 'stream-json', '--max-turns', '0'])
  const b = await runDist(['-p', '--resume', '', 'hello', '--output-format', 'stream-json'])
  const frame = (cap: Capture): Record<string, unknown> | null => {
    try {
      return JSON.parse(cap.stdout.trim().split('\n')[0] ?? '') as Record<string, unknown>
    } catch {
      return null
    }
  }
  const keys = (f: unknown): string => (f && typeof f === 'object' ? Object.keys(f as object).sort().join(',') : '')
  const fa = frame(a)
  const fb = frame(b)
  check('an option refusal rides one parseable result envelope', fa !== null && fa.type === 'result' && fa.subtype === 'error_during_execution' && fa.is_error === true, a.stdout.slice(0, 120))
  check('a load refusal rides the same envelope', fb !== null && fb.type === 'result' && fb.subtype === 'error_during_execution' && fb.is_error === true, b.stdout.slice(0, 120))
  check('the two refusals carry one field set', fa !== null && fb !== null && keys(fa) === keys(fb), `${keys(fa)} vs ${keys(fb)}`)
  check('an option refusal (a usage error) exits 2 and a load refusal exits 1', a.exit === 2 && b.exit === 1, `option=${a.exit} load=${b.exit}`)
  check('the two refusals carry one usage shape', fa !== null && fb !== null && keys(fa.usage) === keys(fb.usage) && keys(fa.usage).length > 0, `${keys(fa?.usage)} vs ${keys(fb?.usage)}`)
}

section('L13 — no credentials: an operational error, exit 1, the refusal where the format puts it')
{
  const noKey = { dropKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'], extraEnv: { MERCURY_CREDENTIAL_STORE: 'file' } }
  const text = await runDist(['-p', 'hello', '--max-turns', '1'], noKey)
  check('text: exit 1', text.exit === 1, String(text.exit))
  check('text: the refusal rides stderr and names the sign-in', /Not logged in/.test(text.stderr), text.stderr.slice(0, 120))
  check('text: stdout carries zero bytes', text.stdout.length === 0, text.stdout.slice(0, 80))
  const json = await runDist(['-p', 'hello', '--max-turns', '1', '--output-format', 'json'], noKey)
  let parsed: { type?: string; is_error?: boolean; errors?: string[] } | null = null
  try {
    parsed = JSON.parse(json.stdout.trim()) as typeof parsed
  } catch {
    parsed = null
  }
  check('json: exit 1', json.exit === 1, String(json.exit))
  check('json: stdout is one error object naming the sign-in', parsed !== null && parsed.type === 'result' && parsed.is_error === true && (parsed.errors ?? []).some(e => /Not logged in/.test(e)), json.stdout.slice(0, 160))
  const sj = await runDist(['-p', 'hello', '--max-turns', '1', '--output-format', 'stream-json'], noKey)
  const { parsed: frames, bad } = parseLines(sj)
  const result = frames.find(f => f.type === 'result') as { is_error?: boolean } | undefined
  check('stream-json: exit 1', sj.exit === 1, String(sj.exit))
  check('stream-json: every line parses and the result envelope carries is_error', bad.length === 0 && result?.is_error === true, bad[0]?.slice(0, 80) ?? '')
  assertClean('L13 text', text)
  assertClean('L13 json', json)
}

section('L14 — --help carries none of the retired option spellings and every kept one')
{
  const cap = await runDist(['--help'])
  check('--help exits 0', cap.exit === 0, String(cap.exit))
  const retired = ['--include-hook-events', '--mcp-debug', '--file ', '--allowedTools', '--disallowedTools', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--enable-auth-status', '--max-thinking-tokens', '--deep-link', '--verbose', 'setup-token']
  for (const spelling of retired) check(`--help does not carry ${spelling.trim()}`, !cap.stdout.includes(spelling))
  const kept = ['--allowed-tools', '--disallowed-tools', '--dangerously-bypass-permissions', '--allow-dangerously-bypass-permissions', '--betas', '--bare', '--replay-user-messages', '--no-session-persistence']
  for (const spelling of kept) check(`--help carries ${spelling}`, cap.stdout.includes(spelling))
}

console.log('\n' + '═'.repeat(76))
await Promise.all(fixtures.map(f => f.close().catch(() => {})))
if (failures > 0) {
  console.log(`❌ machine-output contract: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ machine-output contract: all legs green')
process.exit(0)
