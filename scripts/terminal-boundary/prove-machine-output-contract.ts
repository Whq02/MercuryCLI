#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { hostRunner, type HostedRunner } from '../lib/runnerHost.ts'
import { answeredWith } from '../lib/rows.ts'
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
  const cap = await runDist(['run', 'say the phrase'], { baseUrl: fx.url })
  check('stdout is the result plus one trailing newline', cap.stdout === 'PROOF-PLAIN-OK.\n', JSON.stringify(cap.stdout))
  check('stderr is empty', cap.stderr === '', JSON.stringify(cap.stderr.slice(0, 200)))
  check('exit 0', cap.exit === 0, String(cap.exit))
  assertClean('L1', cap)
}

section('L2 — piped stdin: same contract')
{
  const fx = await fixture([{ kind: 'text', text: 'PROOF-STDIN-OK.' }])
  const cap = await runDist(['run'], { baseUrl: fx.url, stdinText: 'hello from a pipe\n' })
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
  const cap = await runDist(['run', 'echo it back'], { baseUrl: fx.url })
  check('stdout preserves the content byte-exact (plus trailing newline)', cap.stdout === preserve + '\n', JSON.stringify(cap.stdout.slice(0, 200)))
  check('exit 0', cap.exit === 0, String(cap.exit))
  assertClean('L3', cap)
}

section('L4 — plain failure (API 400): stderr + newline; stdout ZERO bytes; exit 1')
{
  const fx = await fixture([
    { kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'lucid-fixture-bad-request' },
  ])
  const cap = await runDist(['run', 'hello'], { baseUrl: fx.url })
  check('stdout carries zero bytes', cap.stdout === '', JSON.stringify(cap.stdout.slice(0, 200)))
  check('stderr carries the failure text', cap.stderr.includes('lucid-fixture-bad-request'), JSON.stringify(cap.stderr.slice(0, 200)))
  check('stderr ends with a newline', cap.stderr.endsWith('\n'), JSON.stringify(cap.stderr.slice(-20)))
  check('exit 1', cap.exit === 1, String(cap.exit))
  assertClean('L4', cap)
}

section('L5 — plain failure status (max turns): stderr + newline; stdout empty; exit 1')
{
  const fx = await fixture([
    { kind: 'tool_use', name: 'Glob', input: { pattern: '*.md' } },
    { kind: 'tool_use', name: 'Glob', input: { pattern: '*.ts' } },
    { kind: 'text', text: 'never reached' },
  ])
  const cap = await runDist(['run', 'list things', '--max-turns', '1'], { baseUrl: fx.url })
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
  const cap = await runDist(['run', 'glob then answer'], { baseUrl: fx.url })
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

section('L7 — rows success: every stdout line parses; the typed outcome row')
{
  const fx = await fixture([{ kind: 'text', text: 'PROOF-SJ-OK.' }])
  const cap = await runDist(['run', 'hello', '--format', 'rows'], { baseUrl: fx.url })
  const { parsed, bad } = parseLines(cap)
  check('every stdout line individually JSON-parses', bad.length === 0, bad[0]?.slice(0, 120) ?? '')
  check('the feed opens with the session row, with no option asked for', parsed[0]?.type === 'session', JSON.stringify(parsed[0] ?? {}).slice(0, 120))
  const result = parsed.find(e => e.type === 'outcome') as { status?: string } | undefined
  check('a typed outcome row is present', !!result)
  check('the outcome is completed', result?.status === 'completed', JSON.stringify(result ?? {}).slice(0, 200))
  check('the shared reader reads the answer off the completed outcome row', answeredWith(cap.stdout, 'PROOF-SJ-OK.'))
  check('the shared reader refuses a line that merely carries the words: no outcome row, a failed outcome, an unknown row shape', !answeredWith('{"type":"result","is_error":true,"result":"PROOF-SJ-OK."}\n', 'PROOF-SJ-OK.') && !answeredWith('{"type":"outcome","status":"failed","error":{"message":"PROOF-SJ-OK."}}\n', 'PROOF-SJ-OK.') && !answeredWith('PROOF-SJ-OK.\n', 'PROOF-SJ-OK.'))
  check('exit 0', cap.exit === 0, String(cap.exit))
  assertClean('L7', cap)
}

section('L8 — rows failure: framing holds; the typed error rides the outcome')
{
  const fx = await fixture([
    { kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'lucid-sj-bad-request' },
  ])
  const cap = await runDist(['run', 'hello', '--format', 'rows'], { baseUrl: fx.url })
  const { parsed, bad } = parseLines(cap)
  check('every stdout line individually JSON-parses', bad.length === 0, bad[0]?.slice(0, 120) ?? '')
  const result = parsed.find(e => e.type === 'outcome') as { status?: string; error?: { message?: string; class?: string } } | undefined
  check('the outcome reads failed', result?.status === 'failed', JSON.stringify(result ?? {}).slice(0, 200))
  check(
    'the error text rides the typed record, not a free-form line',
    typeof result?.error?.class === 'string' && String(result?.error?.message).includes('lucid-sj-bad-request'),
    JSON.stringify(result ?? {}).slice(0, 200),
  )
  check('exit 1', cap.exit === 1, String(cap.exit))
  assertClean('L8', cap)
}

section('L9 — --verbose is not an option: the plain format answers the unknown-option refusal')
{
  const cap = await runDist(['run', 'hello', '--verbose'])
  const control = await runDist(['run', 'hello', '--zzz-not-an-option'])
  check("stderr names the unknown option", cap.stderr.includes("unknown option '--verbose'"), cap.stderr.slice(0, 120))
  check('stdout carries zero bytes', cap.stdout.length === 0, cap.stdout.slice(0, 80))
  check('the exit code is the one every unknown option answers', cap.exit !== 0 && cap.exit === control.exit, `exit=${cap.exit} control=${control.exit}`)
  check('a usage error exits 2', cap.exit === 2, String(cap.exit))
  assertClean('L9', cap)
}

async function driveDist(
  baseUrl: string,
  script: (host: HostedRunner, settled: () => Promise<void>) => Promise<void>,
): Promise<{ frames: Record<string, unknown>[]; lines: string[]; exit: number | null; stderr: string }> {
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
  }
  const frames: Record<string, unknown>[] = []
  const lines: string[] = []
  const waiters: Array<() => void> = []
  let pending = ''
  const host = hostRunner({
    node: nodeBin!,
    dist: DIST,
    argv: [],
    cwd,
    env,
    home,
    raw: text => {
      pending += text
      let at: number
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at)
        pending = pending.slice(at + 1)
        if (line.trim() !== '') lines.push(line)
      }
    },
    onRow: row => {
      frames.push(row)
      if (row.type === 'outcome') waiters.shift()?.()
    },
  })
  host.onAsk(params => (params.kind === 'tool' ? { outcome: 'allow', input: params.input } : { outcome: 'allow' }))
  const killer = setTimeout(() => host.child.kill('SIGKILL'), 120_000)
  const settled = (): Promise<void> => Promise.race([new Promise<void>(resolve => waiters.push(resolve)), new Promise<void>(resolve => setTimeout(resolve, 45_000))])
  await script(host, settled)
  host.end()
  const exit = await host.exited
  clearTimeout(killer)
  return { frames, lines, exit, stderr: host.stderr() }
}

const SNAKE = /^[a-z0-9]+(_[a-z0-9]+)*$/
const RIDING_PATHS = new Set(['input', 'structured', 'tool_use_result', 'permission_suggestions', 'updated_permissions', 'config', 'effective', 'sources', 'provenance'])
const NAME_KEYED = new Set(['models', 'extensions', 'skill_states', 'errors', 'headers', 'env'])
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

section('L10 — the one spelling: every driven row is a declared type with snake_case keys')
{
  const fx = await fixture([
    { kind: 'tool_use', name: 'Glob', input: { pattern: '*.zzz-none' } },
    { kind: 'text', text: 'PROOF-SPELLING-DONE.' },
  ])
  const answers = new Map<string, { ok: boolean; result?: Record<string, unknown>; error?: { code: number; message: string } }>()
  const retiredIds = new Map<string, number>()
  let rawId = 9000
  const run = await driveDist(fx.url, async (host, settled) => {
    await host.initialize()
    const turn = settled()
    void host.prompt('glob then answer').catch(() => undefined)
    await turn
    const ask = async (label: string, method: 'session/facts' | 'session/set_effort', params: Record<string, unknown>): Promise<void> => {
      answers.set(label, await host.request(method, params as never).then(result => ({ ok: true, result: result as Record<string, unknown> }), (error: unknown) => ({ ok: false, error: { code: (error as { code?: number }).code ?? 0, message: error instanceof Error ? error.message : String(error) } })))
    }
    await ask('facts', 'session/facts', {})
    await ask('effort', 'session/set_effort', { effort: 'high' })
    for (const word of ['channel_enable', 'remote_control', 'claude_authenticate', 'no_such_subtype_probe', 'mcp_status', 'get_settings', 'get_context_usage']) {
      const id = ++rawId
      retiredIds.set(word, id)
      host.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: word, params: {} })}\n`)
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  })
  const { ROW_TYPES, PARTIAL_ROW_TYPES } = await import('../../src/rows/vocabulary.ts')
  const declaredTypes = new Set<string>([...ROW_TYPES, ...PARTIAL_ROW_TYPES])
  const unparsed = run.lines.filter(line => {
    try {
      JSON.parse(line)
      return false
    } catch {
      return true
    }
  })
  check('every stdout line parses', unparsed.length === 0, JSON.stringify(unparsed[0] ?? '').slice(0, 120))
  const messages = run.lines.map(line => JSON.parse(line) as Record<string, unknown>)
  check('every stdout line is a JSON-RPC 2.0 message (a row notification or an answer)', messages.every(m => m.jsonrpc === '2.0' && (m.method === 'row' || ('id' in m && ('result' in m || 'error' in m)) || typeof m.method === 'string')), JSON.stringify(messages.find(m => m.jsonrpc !== '2.0') ?? '').slice(0, 120))
  const undeclared = run.frames.filter(f => !declaredTypes.has(String(f.type)))
  check('every row is a declared type', undeclared.length === 0, JSON.stringify(undeclared.map(f => String(f.type))))
  const odd: string[] = []
  for (const frame of run.frames) oddKeys(frame, String(frame.type), odd)
  check('every key the feed defines is snake_case at every depth', odd.length === 0, JSON.stringify([...new Set(odd)].slice(0, 30)))
  const init = run.frames.find(f => f.type === 'session') as Record<string, unknown> | undefined
  check('the session row carries mode, skills and extensions and no credential-source word', init !== undefined && typeof init.mode === 'string' && Array.isArray(init.skills) && Array.isArray(init.extensions) && !('apiKeySource' in init) && !('permissionMode' in init), JSON.stringify(Object.keys(init ?? {})))
  const result = run.frames.find(f => f.type === 'outcome') as Record<string, unknown> | undefined
  check('the outcome row carries models keyed by model id with snake_case rows', result !== undefined && typeof result.models === 'object' && !('modelUsage' in result), JSON.stringify(result?.models ?? null).slice(0, 200))
  const facts = answers.get('facts')?.result
  check('the facts answer spells its sections snake_case', facts !== undefined && 'permission_mode' in facts && typeof (facts.usage as Record<string, unknown> | undefined)?.total_cost_usd === 'number' && 'first_party_api' in ((facts.identity as Record<string, unknown> | undefined) ?? {}), JSON.stringify(Object.keys(facts ?? {})))
  const effort = answers.get('effort')
  check('the effort verb answers the typed result (effort, at)', effort?.ok === true && effort.result?.effort === 'high' && typeof effort.result.at === 'string', JSON.stringify(effort ?? null))
  check('exit 0', run.exit === 0, `${String(run.exit)} ${run.stderr.slice(0, 200)}`)

  section('L11 — a retired control word is an unknown method: -32601, nothing else')
  const { RPC_METHOD_NOT_FOUND } = await import('../../src/runner/wire/errors.ts')
  for (const [word, id] of retiredIds) {
    const answer = messages.find(m => m.id === id) as { error?: { code?: number; message?: string } } | undefined
    check(`${word} → method not found`, answer?.error?.code === RPC_METHOD_NOT_FOUND && String(answer.error.message).includes(word), JSON.stringify(answer ?? null))
  }
}

section('L12 — every refusal of the feed is one envelope: one field set, one usage shape')
{
  const a = await runDist(['run', 'hello', '--format', 'rows', '--max-turns', '0'])
  const b = await runDist(['run', '--resume', randomUUID(), 'hello', '--format', 'rows'])
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
  check('an option refusal rides one parseable outcome row', fa !== null && fa.type === 'outcome' && fa.status === 'refused' && typeof (fa.error as { class?: unknown } | undefined)?.class === 'string', a.stdout.slice(0, 120))
  check('a load refusal rides the same row', fb !== null && fb.type === 'outcome' && fb.status === 'refused' && typeof (fb.error as { class?: unknown } | undefined)?.class === 'string', b.stdout.slice(0, 120))
  check('the two refusals carry one field set', fa !== null && fb !== null && keys(fa) === keys(fb), `${keys(fa)} vs ${keys(fb)}`)
  check('an option refusal (a usage error) exits 2 and a load refusal exits 1', a.exit === 2 && b.exit === 1, `option=${a.exit} load=${b.exit}`)
  check('the two refusals carry one usage shape', fa !== null && fb !== null && keys(fa.usage) === keys(fb.usage) && keys(fa.usage).length > 0, `${keys(fa?.usage)} vs ${keys(fb?.usage)}`)
}

section('L13 — no credentials: an operational error, exit 1, the refusal where the format puts it')
{
  const noKey = { dropKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'], extraEnv: { MERCURY_CREDENTIAL_STORE: 'file' } }
  const text = await runDist(['run', 'hello', '--max-turns', '1'], noKey)
  check('text: exit 1', text.exit === 1, String(text.exit))
  check('text: the refusal rides stderr and names the sign-in', /Not logged in/.test(text.stderr), text.stderr.slice(0, 120))
  check('text: stdout carries zero bytes', text.stdout.length === 0, text.stdout.slice(0, 80))
  const json = await runDist(['run', 'hello', '--max-turns', '1', '--format', 'json'], noKey)
  let parsed: { type?: string; status?: string; error?: { message?: string } } | null = null
  try {
    parsed = JSON.parse(json.stdout.trim()) as typeof parsed
  } catch {
    parsed = null
  }
  check('json: exit 1', json.exit === 1, String(json.exit))
  check('json: stdout is one outcome object naming the sign-in', parsed !== null && parsed.type === 'outcome' && parsed.status !== 'completed' && /Not logged in/.test(String(parsed.error?.message)), json.stdout.slice(0, 160))
  const sj = await runDist(['run', 'hello', '--max-turns', '1', '--format', 'rows'], noKey)
  const { parsed: frames, bad } = parseLines(sj)
  const result = frames.find(f => f.type === 'outcome') as { status?: string } | undefined
  check('rows: exit 1', sj.exit === 1, String(sj.exit))
  check('rows: every line parses and the outcome is not completed', bad.length === 0 && result !== undefined && result.status !== 'completed', bad[0]?.slice(0, 80) ?? '')
  assertClean('L13 text', text)
  assertClean('L13 json', json)
}

section('L14 — --help carries none of the retired option spellings and every kept one')
{
  const cap = await runDist(['--help'])
  check('--help exits 0', cap.exit === 0, String(cap.exit))
  const retired = ['--include-hook-events', '--mcp-debug', '--file ', '--allowedTools', '--disallowedTools', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--enable-auth-status', '--max-thinking-tokens', '--deep-link', '--verbose', 'setup-token', '--replay-user-messages', '--permission-channel']
  for (const spelling of retired) check(`--help does not carry ${spelling.trim()}`, !cap.stdout.includes(spelling))
  const kept = ['--allowed-tools', '--block-tools', '--sovereign', '--allow-sovereign', '--mode', '--format', '--input', '--partial', '--provider-preview', '--lean', '--ephemeral']
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
