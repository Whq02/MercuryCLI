#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi, type ScriptedTurn, isHandoffRequest, handoffTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const proofHome = mkdtempSync(join(tmpdir(), 'blocked-run-home-'))
process.env.MERCURY_CONFIG_DIR = proofHome
delete process.env.MERCURY_HOME
process.on('exit', () => rmSync(proofHome, { recursive: true, force: true }))
const vocabulary = await import('../../src/rows/vocabulary.ts')
const project = await import('../../src/rows/project.ts')
const asks = await import('../../src/services/run/unansweredAsk.ts')
const sdkRows = existsSync(join(ROOT, 'sdk', 'src', 'rows.ts')) ? await import('../../sdk/src/rows.ts') : null
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

const ACCOUNT_TEXT = [
  'fizz.py was not created and nothing was run. My write to `/tmp/headless/fizz.py` was auto-denied: this headless run has no pre-approved Write permission and nobody to approve it ("Permission to write to … has not been granted"). So I have no real output to show you yet.',
  '',
  'verified: target directory exists and is empty (Read) · Write denied · no file created · nothing executed',
  '',
  'Which do you want: a relaunch with `--allowed-tools` covering Write and Bash, or a `--mode` that allows both?',
].join('\n')

const OLD_GRAMMAR_TEXT = [
  'The migration cannot start without the staging credentials.',
  '',
  'BLOCKED ON OPERATOR: the staging database password for the migration run.',
  'RESUME WHEN: the password is in the environment and the run is launched again.',
].join('\n')

const QUESTION = 'Which database holds the orders: staging or the replica?'
const askTurn: ScriptedTurn = {
  kind: 'tool_use',
  name: 'AskUserQuestion',
  input: { questions: [{ question: QUESTION, header: 'Database', options: [{ label: 'staging', description: 'the staging database' }, { label: 'replica', description: 'the read replica' }], multiSelect: false }] },
  preText: 'I need one answer before the migration.',
}

section('§1 THE VOCABULARY — blocked is an outcome status with exit 1, a sentence and an error class; the SDK table agrees')
{
  const statuses = vocabulary.OUTCOME_STATUSES as readonly string[]
  check('blocked is an outcome status', statuses.includes('blocked'), j(statuses))
  check('a blocked outcome exits 1 (never 0)', (vocabulary.exitCodeOf as (s: string) => number)('blocked') === 1)
  check('blocked has a sentence for the text road', typeof (vocabulary.OUTCOME_SENTENCES as Record<string, unknown>).blocked === 'function')
  check('blocked is an error class, so the outcome names its reason', (vocabulary.ERROR_CLASSES as readonly string[]).includes('blocked'))
  if (sdkRows === null) console.log('  [skip] the SDK is parked and not on this tree (the published lineage carries no sdk/): its generated table is read where it stands')
  else check('the SDK generated table carries blocked with exit 1', (sdkRows.OUTCOME_STATUSES as readonly string[]).includes('blocked') && (sdkRows.OUTCOME_EXIT_CODES as Record<string, number>).blocked === 1, j(sdkRows.OUTCOME_EXIT_CODES))
  const scope = { session_id: 'sess-1', turn: 1 }
  const usage = { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }
  const row = project.outcomeRow(scope, {
    turnId: 't-1',
    status: 'blocked' as never,
    stopReason: 'end_turn',
    answer: ACCOUNT_TEXT,
    error: { message: 'Blocked on the operator: a permission', class: 'blocked' as never, detail: ['resume when: it is granted'] },
    steps: 2,
    wallMs: 10,
    usage,
    models: {},
    denials: [{ tool: 'Write', call_id: 'toolu_1', input: { file_path: '/tmp/fizz.py' } }],
  })
  check('a blocked outcome row carries the answer (the account a user reads first) beside the error', (row as { answer?: string }).answer === ACCOUNT_TEXT && (row as { error?: { class?: string } }).error?.class === 'blocked')
  const parsed = vocabulary.RowSchema().safeParse({ ...row, seq: 1, timestamp: '2026-10-05T00:00:00.000Z' })
  check('the row parses through the vocabulary', parsed.success, parsed.success ? '' : j(parsed.error.issues.slice(0, 2)))
}

section('§2 THE LAW — no grammar module, no words read: the blocker is composed from the asks nobody answered')
{
  check('RED ON THE BASE: the fixed-lines grammar module is gone from the tree', !existsSync(join(ROOT, 'src', 'services', 'run', 'blockerDeclaration.ts')))
  const question = asks.unansweredAsksBlocker([{ tool: 'AskUserQuestion', input: { questions: [{ question: QUESTION }] } }])
  check('RED ON THE BASE: an unanswered question is quoted on the error, class blocked', question.class === 'blocked' && question.message.includes(`«${QUESTION}»`) && question.message.includes('nobody could answer'), j(question))
  check('…and its detail says what resumes it (an answer, or a host that answers asks)', question.detail.some(line => line.startsWith('resume when:') && line.includes('the question is answered') && line.includes('mercury runner')), j(question.detail))
  const permission = asks.unansweredAsksBlocker([{ tool: 'Write', input: { file_path: 'fizz.py' } }])
  check('an unanswered permission names its tool and the --allowed-tools road', permission.message.includes('Write asked for an answer nobody could give') && permission.detail.some(line => line.includes('--allowed-tools Write')), j(permission))
  const both = asks.unansweredAsksBlocker([{ tool: 'Bash', input: { command: 'npm publish' } }, { tool: 'AskUserQuestion', input: { questions: [{ question: QUESTION }] } }])
  check('a question and a permission together: both on the message, one detail line each', both.message.includes(`«${QUESTION}»`) && both.message.includes('Bash asked for an answer') && both.detail.length === 2, j(both))
  const long = asks.unansweredAsksBlocker([{ tool: 'AskUserQuestion', input: { questions: [{ question: `${'word '.repeat(80)}?` }] } }])
  check('a long question is clamped on the row (bounded, never truncated mid-run)', long.message.length < 400 && long.message.includes('…»'), String(long.message.length))
}

type Door = { home: string; project: string; api: Awaited<ReturnType<typeof startFixtureApi>>; env: Record<string, string | undefined>; close: () => Promise<void> }
async function openDoor(turns: ScriptedTurn[]): Promise<Door> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'blocked-run-')))
  const projectDir = join(home, 'headless')
  mkdirSync(projectDir, { recursive: true })
  seedFirstRun(home, [projectDir])
  const api = await startFixtureApi([...turns, handoffTurn(), handoffTurn()])
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
type Outcome = { status?: string; answer?: string; error?: { message?: string; class?: string; detail?: string[] }; denials?: Array<{ tool: string }>; notices?: Array<{ text: string }> }
const outcomeOf = (stdout: string): { rows: Array<Record<string, unknown>>; outcome: Outcome | undefined } => {
  const rows = rowsOf(stdout)
  return { rows, outcome: rows.find(row => row.type === 'outcome') as Outcome | undefined }
}
const deniedWriteTurns = (): ScriptedTurn[] => [
  { kind: 'tool_use', name: 'Write', input: { file_path: 'fizz.py', content: 'print("FizzBuzz")\n' }, preText: 'Creating fizz.py.' },
  { kind: 'text', text: ACCOUNT_TEXT },
]

section('§3 THE DOOR (rows) — a run whose every write was auto-denied ends blocked from the denial alone: exit 1, the tool on the outcome row, the account kept')
{
  const door = await openDoor(deniedWriteTurns())
  try {
    const exit = await runDoor(door, ['--format', 'rows', '--', 'Create fizz.py and run it.'])
    const { rows, outcome } = outcomeOf(exit.stdout)
    check('the blocked run exits 1', exit.code === 1, j({ code: exit.code, stderr: exit.stderr.slice(-300) }))
    check('the outcome row says blocked', outcome?.status === 'blocked', j({ status: outcome?.status }))
    check('the Write was auto-denied and listed in denials', (outcome?.denials ?? []).some(denial => denial.tool === 'Write'), j(outcome?.denials))
    check('the outcome error names the ask nobody could answer (class blocked, the tool\'s name — not a word of the answer)', outcome?.error?.class === 'blocked' && (outcome?.error?.message ?? '').includes('Write asked for an answer nobody could give'), j(outcome?.error))
    check('the resume road rides the error detail (--allowed-tools Write)', (outcome?.error?.detail ?? []).some(line => line.includes('--allowed-tools Write')), j(outcome?.error?.detail))
    check('the answer (the model\'s account) still rides the blocked outcome', typeof outcome?.answer === 'string' && outcome.answer.includes('fizz.py was not created'), j({ answer: outcome?.answer?.slice(0, 80) }))
    check('the outcome is the last row', rows.at(-1)?.type === 'outcome')
    check('the fixture saw both requests (the denied write, then the account; the session\'s closing ask set aside)', door.api.messageRequests().filter(q => !isHandoffRequest(q)).length === 2, String(door.api.messageRequests().length))
  } finally {
    await door.close()
  }
}

section('§4 THE DOOR (text) — the same run prints the account, then the reason on stderr, and exits 1')
{
  const door = await openDoor(deniedWriteTurns())
  try {
    const exit = await runDoor(door, ['--', 'Create fizz.py and run it.'])
    check('exit 1 on the text road', exit.code === 1, j({ code: exit.code }))
    check('stdout carries the model\'s account, ending on its question', exit.stdout.includes('fizz.py was not created') && exit.stdout.trimEnd().endsWith('or a `--mode` that allows both?'), j(exit.stdout.slice(-200)))
    check('stderr carries the one-line reason, composed from the denial', /Blocked on the operator: Write asked for an answer nobody could give/.test(exit.stderr), j(exit.stderr.slice(-300)))
  } finally {
    await door.close()
  }
}

section('§5 THE DOOR (json) — the one JSON result says blocked')
{
  const door = await openDoor(deniedWriteTurns())
  try {
    const exit = await runDoor(door, ['--format', 'json', '--', 'Create fizz.py and run it.'])
    const result = JSON.parse(exit.stdout.trim()) as { status?: string; error?: { class?: string } }
    check('the JSON result reads blocked and exits 1', exit.code === 1 && result.status === 'blocked' && result.error?.class === 'blocked', j({ code: exit.code, status: result.status, error: result.error }))
  } finally {
    await door.close()
  }
}

section('§6 THE QUESTION — a run that asks the operator through AskUserQuestion and ends there is blocked, with the question quoted on the outcome row')
{
  const door = await openDoor([askTurn, { kind: 'text', text: 'I cannot pick the database for you; tell me which one and I will run the migration.' }])
  try {
    const exit = await runDoor(door, ['--format', 'rows', '--', 'Run the orders migration.'])
    const { outcome } = outcomeOf(exit.stdout)
    check('the run exits 1 and the outcome says blocked', exit.code === 1 && outcome?.status === 'blocked', j({ code: exit.code, status: outcome?.status, stderr: exit.stderr.slice(-200) }))
    check('the unanswered question is listed in denials as AskUserQuestion', (outcome?.denials ?? []).some(denial => denial.tool === 'AskUserQuestion'), j(outcome?.denials))
    check('RED ON THE BASE: the error quotes the question itself (read from the ask, not from the answer)', outcome?.error?.class === 'blocked' && (outcome?.error?.message ?? '').includes(`«${QUESTION}»`), j(outcome?.error))
    check('…and the detail says an answer resumes it', (outcome?.error?.detail ?? []).some(line => line.includes('the question is answered')), j(outcome?.error?.detail))
    check('the answer rides the row', typeof outcome?.answer === 'string' && outcome.answer.includes('tell me which one'), j({ answer: outcome?.answer?.slice(0, 80) }))
  } finally {
    await door.close()
  }
}

section('§7 THE WORDS ARE NOT READ — a run that asked nothing is completed whatever its answer says, the retired grammar included')
{
  const door = await openDoor([{ kind: 'text', text: OLD_GRAMMAR_TEXT }])
  try {
    const exit = await runDoor(door, ['--format', 'rows', '--', 'Run the migration.'])
    const { outcome } = outcomeOf(exit.stdout)
    check('RED ON THE BASE: the old two lines in the answer mint no blocker — the run is completed and exits 0', exit.code === 0 && outcome?.status === 'completed' && outcome?.error === undefined, j({ code: exit.code, status: outcome?.status, error: outcome?.error }))
    check('the answer is the model\'s text, untouched', outcome?.answer === OLD_GRAMMAR_TEXT)
  } finally {
    await door.close()
  }
  const prose = await openDoor([{ kind: 'text', text: 'Two migrations are possible here. Which database holds the orders: staging or the replica?' }])
  try {
    const exit = await runDoor(prose, ['--', 'Run the orders migration.'])
    check('a question written only in the answer reads as done (exit 0, the text on stdout, nothing on stderr)', exit.code === 0 && exit.stdout.includes('Which database holds the orders') && exit.stderr === '', j({ code: exit.code, stderr: exit.stderr.slice(-200) }))
  } finally {
    await prose.close()
  }
}

section('§8 a refused tool with nothing delivered reports blocked and exits 1; a run that delivered after the refusal completes with a notice; a plain run exits 0')
{
  const door = await openDoor([
    { kind: 'tool_use', name: 'Write', input: { file_path: 'fizz.py', content: 'print(1)\n' }, preText: 'Trying a write.' },
    { kind: 'text', text: 'Nothing is stuck here: the answer is 42.' },
  ])
  try {
    const exit = await runDoor(door, ['--format', 'rows', '--', 'Answer me.'])
    const { outcome } = outcomeOf(exit.stdout)
    check('a turn whose only tool call was refused says blocked with the blocked class (the .34 ruling: the exit code tells the truth)', exit.code === 1 && outcome?.status === 'blocked' && outcome?.error?.class === 'blocked' && (outcome?.denials?.length ?? 0) === 1, j({ code: exit.code, status: outcome?.status, denials: outcome?.denials?.length }))
    check('its answer is the model\'s text', outcome?.answer === 'Nothing is stuck here: the answer is 42.')
  } finally {
    await door.close()
  }
  const recovered = await openDoor([
    { kind: 'tool_use', name: 'Write', input: { file_path: 'fizz.py', content: 'print(1)\n' }, preText: 'Trying a write.' },
    { kind: 'tool_use', name: 'Glob', input: { pattern: '*' }, preText: 'Listing the folder instead.' },
    { kind: 'text', text: 'The folder is empty; nothing to run.' },
  ])
  try {
    const exit = await runDoor(recovered, ['--format', 'rows', '--', 'Answer me.'])
    const { outcome } = outcomeOf(exit.stdout)
    check('a later tool call that succeeds recovers the turn: completed, exit 0, the refusal kept as a notice', exit.code === 0 && outcome?.status === 'completed' && (outcome?.notices ?? []).some(n => n.text.includes('Write') && n.text.includes('continued')), j({ code: exit.code, status: outcome?.status, notices: outcome?.notices }))
  } finally {
    await recovered.close()
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
console.log('✅ prove-blocked-run-exit: a headless run is blocked by the question nobody answered, never by the words of its answer; a run that delivered exits 0')
