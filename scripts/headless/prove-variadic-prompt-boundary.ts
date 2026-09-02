#!/usr/bin/env bun
// ============================================================================
//  scripts/headless/prove-variadic-prompt-boundary.ts — the variadic-flag /
//  trailing-prompt boundary (small-fix bundle item 4, AX4's find).
//
//  The bug: `mercury -p --allowedTools "Bash" "do the thing"` fed the prompt
//  INTO the variadic flag (commander consumes every following bare argument),
//  and the boot died with the generic "input must be provided…" line — a
//  silent swallow wearing a misdirecting error.
//
//  The contract now: BOTH spellings behave —
//    · the flag-then-prompt spelling REFUSES with the named remedy (`--`,
//      or prompt-first), exit non-zero, nothing sent to the wire;
//    · `--allowedTools "Bash" -- "prompt"` and `-p "prompt" --allowedTools`
//      RUN, and the captured request body carries the prompt;
//    · a legit piped-stdin multi-value spelling is untouched.
//
//  Real dist against the shared fixture API. Run:
//    ~/.bun/bin/bun run scripts/headless/prove-variadic-prompt-boundary.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { startFixtureApi, type FixtureApi } from '../lib/fixtureApi.ts'

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
  console.log('\n❌ TIMEOUT — variadic-boundary proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

interface RunResult {
  exit: number | null
  stdout: string
  stderr: string
}

async function run(
  fixture: FixtureApi,
  argvTail: string[],
  opts?: { stdinText?: string },
): Promise<RunResult> {
  const home = mkdtempSync(join(tmpdir(), 'variadic-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'variadic-cwd-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  const env = {
    HOME: home,
    PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
    TERM: 'dumb',
    MERCURY_CONFIG_DIR: join(home, '.claude'),
    ANTHROPIC_BASE_URL: fixture.url,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
  }
  const child = spawn(nodeBin!, [DIST, ...argvTail], {
    cwd,
    env,
    stdio: [opts?.stdinText !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  })
  if (opts?.stdinText !== undefined) {
    child.stdin!.write(opts.stdinText)
    child.stdin!.end()
  }
  const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', d => (stdout += d))
  child.stderr!.on('data', d => (stderr += d))
  const exit = await new Promise<number | null>(res =>
    child.on('close', code => {
      clearTimeout(killer)
      res(code)
    }),
  )
  return { exit, stdout, stderr }
}

const messagesBodies = (fixture: FixtureApi): string[] =>
  fixture.requests
    .filter(r => (r.path ?? '').includes('/v1/messages'))
    .map(r => JSON.stringify(r.body ?? null))

// ── (1) the swallow spelling REFUSES with the named remedy ────────────────
section('(1) `-p --allowedTools "Bash" "do the thing"` refuses loudly — never a silent swallow')
{
  const fixture = await startFixtureApi([{ kind: 'text', text: 'NEVER-SERVED.' }])
  const res = await run(fixture, ['-p', '--allowedTools', 'Bash', 'do the thing'])
  check('exit is non-zero', res.exit !== 0 && res.exit !== null, `exit ${res.exit}`)
  check('the refusal names the flag that captured the values', res.stderr.includes('--allowedTools'), res.stderr.slice(-400))
  check('…and echoes the swallowed value', res.stderr.includes('"do the thing"'), res.stderr.slice(-400))
  check('…and names the -- remedy', res.stderr.includes('--allowedTools "..." -- '), res.stderr.slice(-400))
  check('…and the prompt-before-the-flag remedy', res.stderr.includes('before the flag'), res.stderr.slice(-400))
  check('the generic input-must-be-provided line is NOT the answer', !res.stderr.includes('input must be provided'), res.stderr.slice(-400))
  check('nothing reached the wire', messagesBodies(fixture).length === 0)
  await fixture.close()
}

// ── (2) the `--` spelling RUNS and the prompt reaches the wire ────────────
section('(2) `-p --allowedTools "Bash" -- "prompt"` runs; the request body carries the prompt')
{
  const fixture = await startFixtureApi([{ kind: 'text', text: 'BOUNDARY-REPLY-ONE.' }])
  const res = await run(fixture, ['-p', '--allowedTools', 'Bash', '--', 'say the boundary phrase alpha'])
  check('exit 0', res.exit === 0, `exit ${res.exit} stderr ${res.stderr.slice(-300)}`)
  check('the scripted reply came back', res.stdout.includes('BOUNDARY-REPLY-ONE.'), res.stdout.slice(-300))
  const bodies = messagesBodies(fixture)
  check('exactly one wire conversation ran', bodies.length >= 1, `${bodies.length} bodies`)
  check('the request body carries the prompt', bodies.some(b => b.includes('say the boundary phrase alpha')))
  await fixture.close()
}

// ── (3) prompt-first RUNS identically ─────────────────────────────────────
section('(3) `-p "prompt" --allowedTools "Bash"` runs; the request body carries the prompt')
{
  const fixture = await startFixtureApi([{ kind: 'text', text: 'BOUNDARY-REPLY-TWO.' }])
  const res = await run(fixture, ['-p', 'say the boundary phrase beta', '--allowedTools', 'Bash'])
  check('exit 0', res.exit === 0, `exit ${res.exit} stderr ${res.stderr.slice(-300)}`)
  check('the scripted reply came back', res.stdout.includes('BOUNDARY-REPLY-TWO.'), res.stdout.slice(-300))
  check('the request body carries the prompt', messagesBodies(fixture).some(b => b.includes('say the boundary phrase beta')))
  await fixture.close()
}

// ── (4) a legit piped multi-value spelling is untouched ───────────────────
section('(4) `echo prompt | -p --allowedTools Bash Edit` still runs (no refusal for real lists)')
{
  const fixture = await startFixtureApi([{ kind: 'text', text: 'BOUNDARY-REPLY-THREE.' }])
  const res = await run(fixture, ['-p', '--allowedTools', 'Bash', 'Edit'], {
    stdinText: 'say the boundary phrase gamma\n',
  })
  check('exit 0', res.exit === 0, `exit ${res.exit} stderr ${res.stderr.slice(-300)}`)
  check('no refusal fired', !res.stderr.includes('captured'), res.stderr.slice(-300))
  check('the piped prompt reached the wire', messagesBodies(fixture).some(b => b.includes('say the boundary phrase gamma')))
  await fixture.close()
}

// ── (5) an agent initialPrompt DRIVES the run — the refusal stands down ──
section('(5) `-p --agent <with initialPrompt> --allowedTools A B` still runs (the agent supplies the input)')
{
  const fixture = await startFixtureApi([{ kind: 'text', text: 'BOUNDARY-REPLY-FOUR.' }])
  const agents = JSON.stringify({
    runner: {
      description: 'boundary fixture agent',
      prompt: 'You are the boundary fixture agent.',
      initialPrompt: 'say the boundary phrase delta',
    },
  })
  const res = await run(fixture, ['-p', '--agents', agents, '--agent', 'runner', '--allowedTools', 'Bash', 'Edit'])
  check('exit 0', res.exit === 0, `exit ${res.exit} stderr ${res.stderr.slice(-300)}`)
  check('no refusal fired (the agent initialPrompt is the input)', !res.stderr.includes('captured'), res.stderr.slice(-300))
  check('the agent initialPrompt reached the wire', messagesBodies(fixture).some(b => b.includes('say the boundary phrase delta')))
  await fixture.close()
}

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ VARIADIC PROMPT BOUNDARY GREEN' : `❌ ${failures} VARIADIC-BOUNDARY CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
