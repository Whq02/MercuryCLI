#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
process.env.MERCURY_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'blocked-run-home-'))
const vocabulary = await import('../../src/rows/vocabulary.ts')
const project = await import('../../src/rows/project.ts')
const grammar = await import('../../src/services/run/blockerDeclaration.ts')
const sdkRows = await import('../../sdk/src/rows.ts')
const dist = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(dist)) {
  console.error(`FAIL run bundle exists: ${dist}`)
  process.exit(1)
}
const node = Bun.which('node')
if (node === null) {
  console.error('FAIL a node binary is on PATH')
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n${'─'.repeat(76)}\n${t}`)
}
const j = (v: unknown): string => JSON.stringify(v)

const AIR_FINAL_TEXT = [
  'fizz.py was not created and nothing was run. My write to `/tmp/headless/fizz.py` was auto-denied: this headless run has no pre-approved Write permission and nobody to approve it ("Permission to write to … has not been granted"). So I have no real output to show you yet.',
  '',
  'verified: target directory exists and is empty (Read) · Write denied · no file created · nothing executed',
  '',
  'BLOCKED ON OPERATOR: Permission for this run to create fizz.py and run `python3 fizz.py` (for example, relaunch with `--allowed-tools` covering Write and Bash, or with a `--mode` that allows both).',
  'RESUME WHEN: Write and Bash are pre-approved for the run; I will then create the file, run it once, and report the last three lines of its real output.',
].join('\n')

const QUOTED_MID_PROSE = [
  'The run protocol says a stuck run ends with "BLOCKED ON OPERATOR: what you need" and "RESUME WHEN: what unblocks you".',
  'Nothing is stuck here: the answer is 42.',
].join('\n')

section('§1 THE VOCABULARY — blocked is an outcome status with exit 1, a sentence and an error class; the SDK table agrees')
{
  const statuses = vocabulary.OUTCOME_STATUSES as readonly string[]
  check('blocked is an outcome status', statuses.includes('blocked'), j(statuses))
  check('a blocked outcome exits 1 (never 0)', (vocabulary.exitCodeOf as (s: string) => number)('blocked') === 1)
  check('blocked has a sentence for the text road', typeof (vocabulary.OUTCOME_SENTENCES as Record<string, unknown>).blocked === 'function')
  check('blocked is an error class, so the outcome names its reason', (vocabulary.ERROR_CLASSES as readonly string[]).includes('blocked'))
  check('the SDK generated table carries blocked with exit 1', (sdkRows.OUTCOME_STATUSES as readonly string[]).includes('blocked') && (sdkRows.OUTCOME_EXIT_CODES as Record<string, number>).blocked === 1, j(sdkRows.OUTCOME_EXIT_CODES))
  const scope = { session_id: 'sess-1', turn: 1 }
  const usage = { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }
  const row = project.outcomeRow(scope, {
    turnId: 't-1',
    status: 'blocked' as never,
    stopReason: 'end_turn',
    answer: AIR_FINAL_TEXT,
    error: { message: 'Blocked on the operator: a permission', class: 'blocked' as never, detail: ['resume when: it is granted'] },
    steps: 2,
    wallMs: 10,
    usage,
    models: {},
    denials: [{ tool: 'Write', call_id: 'toolu_1', input: { file_path: '/tmp/fizz.py' } }],
  })
  check('a blocked outcome row carries the answer (the account a user reads first) beside the error', (row as { answer?: string }).answer === AIR_FINAL_TEXT && (row as { error?: { class?: string } }).error?.class === 'blocked')
  const parsed = vocabulary.RowSchema().safeParse({ ...row, seq: 1, timestamp: '2026-10-05T00:00:00.000Z' })
  check('the row parses through the vocabulary', parsed.success, parsed.success ? '' : j(parsed.error.issues.slice(0, 2)))
}

section('§2 THE GRAMMAR — the Air\'s final text is a declared blocker; a quoted grammar mid-prose is not')
{
  const declared = grammar.parseBlockerDeclaration(AIR_FINAL_TEXT)
  check('the Air\'s final two lines parse as a declared blocker', declared.kind === 'declared' && declared.description.startsWith('Permission for this run'), j(declared))
  check('a message that quotes the grammar mid-prose declares nothing', grammar.parseBlockerDeclaration(QUOTED_MID_PROSE).kind === 'none')
}

type Door = { home: string; project: string; api: Awaited<ReturnType<typeof startFixtureApi>>; env: Record<string, string | undefined>; close: () => Promise<void> }
async function openDoor(turns: ScriptedTurn[]): Promise<Door> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'blocked-run-')))
  const projectDir = join(home, 'headless')
  mkdirSync(projectDir, { recursive: true })
  seedFirstRun(home, [projectDir])
  const api = await startFixtureApi(turns)
  const env = {
    HOME: home,
    PATH: process.env.PATH,
    TMPDIR: tmpdir(),
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: api.url,
  }
  return {
    home,
    project: projectDir,
    api,
    env,
    close: async () => {
      await api.close()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

type Exit = { code: number | null; stdout: string; stderr: string }
function runDoor(door: Door, args: string[]): Promise<Exit> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(node, [dist, 'run', ...args], { cwd: door.project, env: door.env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`the run did not settle within 120 s\nstdout: ${stdout.slice(-800)}\nstderr: ${stderr.slice(-800)}`))
    }, 120_000)
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      resolveExit({ code, stdout, stderr })
    })
  })
}
const rowsOf = (stdout: string): Array<Record<string, unknown>> =>
  stdout
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
const blockedTurns = (): ScriptedTurn[] => [
  { kind: 'tool_use', name: 'Write', input: { file_path: 'fizz.py', content: 'print("FizzBuzz")\n' }, preText: 'Creating fizz.py.' },
  { kind: 'text', text: AIR_FINAL_TEXT },
]

section('§3 THE DOOR (rows) — a run whose every write was auto-denied and whose final text declares the blocker ends blocked: exit 1, the reason on the outcome row')
{
  const door = await openDoor(blockedTurns())
  try {
    const exit = await runDoor(door, ['--format', 'rows', '--', 'Create fizz.py and run it.'])
    const rows = rowsOf(exit.stdout)
    const outcome = rows.find(row => row.type === 'outcome') as { status?: string; answer?: string; error?: { message?: string; class?: string; detail?: string[] }; denials?: Array<{ tool: string }> } | undefined
    check('RED ON THE BASE: the blocked run exits 1', exit.code === 1, j({ code: exit.code, stderr: exit.stderr.slice(-300) }))
    check('RED ON THE BASE: the outcome row says blocked', outcome?.status === 'blocked', j({ status: outcome?.status }))
    check('the Write was auto-denied and listed in denials', (outcome?.denials ?? []).some(denial => denial.tool === 'Write'), j(outcome?.denials))
    check('the outcome error names the blocker (class blocked, the declaration\'s words)', outcome?.error?.class === 'blocked' && (outcome?.error?.message ?? '').includes('Permission for this run to create fizz.py'), j(outcome?.error))
    check('the resume condition rides the error detail', (outcome?.error?.detail ?? []).some(line => line.includes('Write and Bash are pre-approved')), j(outcome?.error?.detail))
    check('the answer (the model\'s account) still rides the blocked outcome', typeof outcome?.answer === 'string' && outcome.answer.includes('fizz.py was not created'), j({ answer: outcome?.answer?.slice(0, 80) }))
    check('the outcome is the last row', rows.at(-1)?.type === 'outcome')
    check('the fixture saw both requests (the denied write, then the declaration)', door.api.messageRequests().length === 2, String(door.api.messageRequests().length))
  } finally {
    await door.close()
  }
}

section('§4 THE DOOR (text) — the same run prints the account, then the reason on stderr, and exits 1')
{
  const door = await openDoor(blockedTurns())
  try {
    const exit = await runDoor(door, ['--', 'Create fizz.py and run it.'])
    check('RED ON THE BASE: exit 1 on the text road', exit.code === 1, j({ code: exit.code }))
    check('stdout carries the model\'s account ending with the declaration', exit.stdout.includes('fizz.py was not created') && exit.stdout.trimEnd().endsWith('report the last three lines of its real output.'), j(exit.stdout.slice(-200)))
    check('stderr carries the one-line reason', /Blocked on the operator: Permission for this run to create fizz\.py/.test(exit.stderr), j(exit.stderr.slice(-300)))
  } finally {
    await door.close()
  }
}

section('§5 THE DOOR (json) — the one JSON result says blocked')
{
  const door = await openDoor(blockedTurns())
  try {
    const exit = await runDoor(door, ['--format', 'json', '--', 'Create fizz.py and run it.'])
    const result = JSON.parse(exit.stdout.trim()) as { status?: string; error?: { class?: string } }
    check('RED ON THE BASE: the JSON result reads blocked and exits 1', exit.code === 1 && result.status === 'blocked' && result.error?.class === 'blocked', j({ code: exit.code, status: result.status, error: result.error }))
  } finally {
    await door.close()
  }
}

section('§6 A RUN THAT DELIVERED STILL EXITS 0 — a denial alone never fails a completed turn; a quoted grammar mid-prose never blocks')
{
  const door = await openDoor([
    { kind: 'tool_use', name: 'Write', input: { file_path: 'fizz.py', content: 'print(1)\n' }, preText: 'Trying a write.' },
    { kind: 'text', text: QUOTED_MID_PROSE },
  ])
  try {
    const exit = await runDoor(door, ['--format', 'rows', '--', 'Answer me.'])
    const outcome = rowsOf(exit.stdout).find(row => row.type === 'outcome') as { status?: string; denials?: unknown[]; answer?: string } | undefined
    check('a completed turn with a denial and no declaration exits 0 and says completed', exit.code === 0 && outcome?.status === 'completed' && (outcome?.denials?.length ?? 0) === 1, j({ code: exit.code, status: outcome?.status, denials: outcome?.denials?.length }))
    check('its answer is the model\'s text', outcome?.answer === QUOTED_MID_PROSE)
  } finally {
    await door.close()
  }
  const plain = await openDoor([{ kind: 'text', text: 'Done: the answer is 42.' }])
  try {
    const exit = await runDoor(plain, ['--', 'Answer me.'])
    check('a plain delivered run exits 0 with its answer on stdout', exit.code === 0 && exit.stdout.trim() === 'Done: the answer is 42.' && exit.stderr === '', j({ code: exit.code, stdout: exit.stdout, stderr: exit.stderr }))
  } finally {
    await plain.close()
  }
}

console.log(`\n${'═'.repeat(76)}`)
if (failures > 0) {
  console.log(`❌ prove-blocked-run-exit: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ prove-blocked-run-exit: a headless run that ends blocked on the operator exits 1 with the reason on its outcome row; a run that delivered exits 0')
