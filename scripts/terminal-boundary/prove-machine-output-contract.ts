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
  opts: { baseUrl?: string; stdinText?: string; extraEnv?: Record<string, string>; timeoutMs?: number } = {},
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
  assertClean('L9', cap)
}

section('L10 — every refusal of the feed is one envelope: one field set, one usage shape')
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
  check('the two refusals carry one usage shape', fa !== null && fb !== null && keys(fa.usage) === keys(fb.usage) && keys(fa.usage).length > 0, `${keys(fa?.usage)} vs ${keys(fb?.usage)}`)
}

console.log('\n' + '═'.repeat(76))
await Promise.all(fixtures.map(f => f.close().catch(() => {})))
if (failures > 0) {
  console.log(`❌ machine-output contract: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ machine-output contract: all legs green')
process.exit(0)
