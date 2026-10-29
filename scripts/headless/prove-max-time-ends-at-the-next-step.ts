#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi, handoffTurn, isHandoffRequest, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { timeSpanMsOf } from '../../src/utils/deadline.ts'
import { ERROR_CLASSES, OUTCOME_SENTENCES, OUTCOME_STATUSES } from '../../src/rows/vocabulary.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL run bundle exists: ${dist}`); process.exit(1) }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }
const j = (value: unknown): string => JSON.stringify(value)?.slice(0, 400) ?? ''

type Run = { code: number | null; out: string; err: string }
type Outcome = { status?: string; steps?: number; answer?: string; wall_ms?: number; error?: { message?: string; class?: string } }

function spawnDist(args: string[], cwd: string, env: Record<string, string>, budgetMs: number): Promise<Run> {
  const child = spawn('node', [dist, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', d => { out += String(d) })
  child.stderr.on('data', d => { err += String(d) })
  const guard = setTimeout(() => child.kill('SIGKILL'), budgetMs)
  return new Promise<Run>(done => child.on('close', code => { clearTimeout(guard); done({ code, out, err }) }))
}

type Driven = Run & { outcome: Outcome | undefined; rows: Array<Record<string, unknown>>; modelCalls: number; firstRequest: Record<string, unknown> | undefined; home: string }
async function mercuryRun(args: string[], turns: ScriptedTurn[], reuse?: { home: string }): Promise<Driven> {
  const home = reuse?.home ?? realpathSync(mkdtempSync(join(tmpdir(), 'max-time-')))
  const cwd = join(home, 'project')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'note.txt'), 'hello\n')
  seedFirstRun(home, [cwd])
  const api = await startFixtureApi(turns)
  try {
    const run = await spawnDist(['run', ...args], cwd, {
      HOME: home, PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_HOME: home, MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: FIXTURE_API_KEY, ANTHROPIC_BASE_URL: api.url,
    }, 120_000)
    const rows = run.out.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) as Record<string, unknown> } catch { return null } }).filter((row): row is Record<string, unknown> => row !== null)
    const outcome = rows.filter(row => row.type === 'outcome').at(-1) as Outcome | undefined
    const modelRequests = api.messageRequests().filter(request => !isHandoffRequest(request))
    return { ...run, rows, outcome, modelCalls: modelRequests.length, firstRequest: modelRequests[0]?.body as Record<string, unknown> | undefined, home }
  } finally {
    await api.close()
    if (reuse === undefined) rmSync(home, { recursive: true, force: true })
  }
}

const readNote: ScriptedTurn = { kind: 'paced_tool_use', preDeltas: Array.from({ length: 40 }, () => 'Reading the note. '), gapMs: 50, tools: [{ name: 'Read', input: { file_path: 'note.txt' } }] }
const sleepTwo: ScriptedTurn = { kind: 'tool_use', name: 'Bash', input: { command: 'sleep 2' } }
const answer: ScriptedTurn = { kind: 'text', text: 'The note says hello.' }
const timeLimitSentence = (ms: number): string => OUTCOME_SENTENCES.time_limit({ maxTimeMs: ms })

console.log('§1 the vocabulary carries the time limit')
check('time_limit is an outcome status', (OUTCOME_STATUSES as readonly string[]).includes('time_limit'))
check('time_limit is an error class', (ERROR_CLASSES as readonly string[]).includes('time_limit'))
check('the sentence names the limit in the span grammar', timeLimitSentence(600_000) === 'Reached the maximum run time (10m)' && timeLimitSentence(90_000) === 'Reached the maximum run time (1m30s)', timeLimitSentence(600_000))

console.log('§2 the span grammar: a bare number is seconds, units s m h, junk refused')
for (const [raw, ms] of [['600', 600_000], ['90s', 90_000], ['10m', 600_000], ['1h', 3_600_000], ['1h30m', 5_400_000], ['1.5h', 5_400_000], ['2M', 120_000], ['45 s', 45_000]] as const) {
  check(`${raw} reads as ${ms} ms`, timeSpanMsOf(raw) === ms, String(timeSpanMsOf(raw)))
}
for (const raw of ['0', '-5', 'abc', '10x', '100ms', '', '1h-30m', 'm']) check(`'${raw}' is refused`, timeSpanMsOf(raw) === null, String(timeSpanMsOf(raw)))

console.log('§3 the door: --max-time is in the run grammar and junk is a usage error')
{
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'max-time-door-')))
  const env = { HOME: home, PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_HOME: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon') }
  try {
    const help = await spawnDist(['run', '--help'], home, env, 60_000)
    check('--max-time appears in run --help', help.code === 0 && /^\s*--max-time <time>/m.test(help.out), help.out.slice(0, 200))
    const junk = await spawnDist(['run', '--max-time', 'soon', 'hello'], home, env, 60_000)
    check('a junk span exits 2 and names the flag and the grammar', junk.code === 2 && junk.err.includes('--max-time must be a span of time') && junk.err.includes("got 'soon'"), j(junk))
    const zero = await spawnDist(['run', '--max-time', '0', 'hello'], home, env, 60_000)
    check('a zero span is refused the same way', zero.code === 2 && zero.err.includes('--max-time must be a span of time'), j(zero))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

console.log('§4 the limit cuts a reply streaming past the deadline: the stream ends at the deadline, the tool call it was composing never arrives, no tool runs')
{
  const run = await mercuryRun(['read note.txt', '--format', 'rows', '--max-time', '1s', '--allowed-tools', 'Read'], [readNote, answer, handoffTurn()])
  check('the outcome is time_limit', run.outcome?.status === 'time_limit', j(run.outcome))
  check('the error class is time_limit and the message states the limit', run.outcome?.error?.class === 'time_limit' && run.outcome?.error?.message === timeLimitSentence(1_000), j(run.outcome?.error))
  check('one step was taken', run.outcome?.steps === 1, j(run.outcome?.steps))
  check('the stream was cut before the tool call arrived: no tool_call row, no tool_result row', !run.rows.some(row => row.type === 'tool_call') && !run.rows.some(row => row.type === 'tool_result'), j(run.rows.map(row => row.type)))
  check('no second model call was made', run.modelCalls === 1, String(run.modelCalls))
  check('the run exits 1', run.code === 1, String(run.code))
}

console.log('§5 the limit cuts a tool running past the deadline: the shell is stopped at the deadline, its result row is the cut, no second model call')
{
  const run = await mercuryRun(['wait two seconds', '--format', 'rows', '--max-time', '1s', '--allowed-tools', 'Bash(sleep *)'], [sleepTwo, answer, handoffTurn()])
  check('the outcome is time_limit', run.outcome?.status === 'time_limit', j(run.outcome))
  check('the message states the limit', run.outcome?.error?.message === timeLimitSentence(1_000), j(run.outcome?.error))
  const result = run.rows.find(row => row.type === 'tool_result') as { status?: string; output?: string } | undefined
  check('the tool was stopped at the deadline: its result row is an error, the two-second sleep never finished (the turn ended under two seconds)', result?.status === 'error' && typeof run.outcome?.wall_ms === 'number' && (run.outcome.wall_ms as number) < 2_000, j({ result, wall: run.outcome?.wall_ms }))
  check('no second model call was made', run.modelCalls === 1, String(run.modelCalls))
  check('the run exits 1', run.code === 1, String(run.code))
}

console.log('§6 the text format says the reason on stderr')
{
  const run = await mercuryRun(['read note.txt', '--format', 'text', '--max-time', '1s', '--allowed-tools', 'Read'], [readNote, answer, handoffTurn()])
  check('stderr carries the sentence', run.err.includes(timeLimitSentence(1_000)), j(run.err))
  check('stdout carries no answer', run.out.trim() === '', j(run.out))
  check('the run exits 1', run.code === 1, String(run.code))
}

console.log('§7 the control: a limit that is not reached changes nothing')
{
  const run = await mercuryRun(['read note.txt', '--format', 'rows', '--max-time', '10m', '--allowed-tools', 'Read'], [readNote, answer, handoffTurn()])
  check('the outcome is completed with the answer', run.outcome?.status === 'completed' && run.outcome?.answer === 'The note says hello.', j(run.outcome))
  check('both model calls were made', run.modelCalls === 2, String(run.modelCalls))
  check('the run exits 0', run.code === 0, String(run.code))
}

console.log('refusals: the limit never reaches the model, it holds in every permission mode, and a value that is no span is refused at the door')
{
  {
    const withLimit = await mercuryRun(['read note.txt', '--format', 'rows', '--max-time', '10m', '--allowed-tools', 'Read'], [readNote, answer, handoffTurn()])
    const without = await mercuryRun(['read note.txt', '--format', 'rows', '--allowed-tools', 'Read'], [readNote, answer, handoffTurn()])
    const prompt = (run: Driven): string =>
      JSON.stringify({ system: run.firstRequest?.system, tools: run.firstRequest?.tools, messages: run.firstRequest?.messages })
        .split(run.home).join('<HOME>')
        .split(run.home.slice(run.home.lastIndexOf('/') + 1)).join('<HOME-NAME>')
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<ID>')
    const differenceAt = (a: string, b: string): string => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return `${a.length} vs ${b.length} bytes, first difference at ${i}: ${JSON.stringify(a.slice(Math.max(0, i - 80), i + 120))}` }
    check('the first request\'s system prompt, tools and messages are byte-identical with and without the flag (the scratch home\'s name and the session id aside)', withLimit.firstRequest !== undefined && prompt(withLimit) === prompt(without), differenceAt(prompt(withLimit), prompt(without)))
    const whole = JSON.stringify(withLimit.firstRequest).split(withLimit.home).join('<HOME>')
    const needle = ['--max-time', 'time_limit'].find(word => whole.includes(word))
    check('the limit never appears in the request', needle === undefined, needle === undefined ? '' : JSON.stringify(whole.slice(Math.max(0, whole.indexOf(needle) - 200), whole.indexOf(needle) + 100)))
  }
  const sovereign = await mercuryRun(['read note.txt', '--format', 'rows', '--max-time', '1s', '--mode', 'sovereign'], [readNote, answer, handoffTurn()])
  check('the limit holds in sovereign mode (no ask, no exemption): time_limit, one model call, exit 1', sovereign.outcome?.status === 'time_limit' && sovereign.modelCalls === 1 && sovereign.code === 1, j(sovereign.outcome))
  const implement = await mercuryRun(['read note.txt', '--format', 'rows', '--max-time', '1s', '--mode', 'implement'], [readNote, answer, handoffTurn()])
  check('and in implement mode', implement.outcome?.status === 'time_limit' && implement.code === 1, j(implement.outcome))
  const home2 = realpathSync(mkdtempSync(join(tmpdir(), 'max-time-door-2-')))
  const env2 = { HOME: home2, PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home2, MERCURY_HOME: home2, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home2, 'daemon') }
  try {
    for (const bad of ['-5', '1e3', 'Infinity', '100ms', '10 minutes', '1h-30m', '']) {
      const refused = await spawnDist(['run', '--max-time', bad, 'hello'], home2, env2, 60_000)
      check(`'${bad}' is refused at the door with exit 2 and no run`, refused.code === 2 && refused.err.includes('--max-time must be a span of time') && refused.out === '', j(refused))
    }
    const rowsDoor = await spawnDist(['run', '--format', 'rows', '--max-time', 'soon', 'hello'], home2, env2, 60_000)
    check('on the rows road the refusal is one refused outcome row', rowsDoor.code === 2 && rowsDoor.out.includes('"status":"refused"') && rowsDoor.out.includes('--max-time must be a span of time'), j(rowsDoor))
  } finally {
    rmSync(home2, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
