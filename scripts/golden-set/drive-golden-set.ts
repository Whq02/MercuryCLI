#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureSnapshot, judgeGoldenTask, type GoldenToolCall } from './judge.ts'
import { compareBaselines, markdownOf, type Baseline, type RunRow } from './report.ts'
import { judgeSelfCheck } from './self-check.ts'
import { GOLDEN_TASKS, type GoldenTask } from './tasks.ts'

if ('bun' in process.versions) throw new Error('Run this drive with Node 24.20+; Bun builds the artifact but does not host the drive.')

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const MW = '/private/tmp/mw'
const args = process.argv.slice(2)
const value = (flag: string): string | undefined => {
  const at = args.indexOf(flag)
  if (at < 0) return undefined
  if (!args[at + 1] || args[at + 1]!.startsWith('--')) throw new Error(`${flag} needs a value`)
  return args[at + 1]
}
const values = (flag: string): string[] => args.flatMap((arg, i) => arg === flag ? [args[i + 1] ?? ''] : [])
const positiveInt = (flag: string, fallback: number): number => {
  const number = Number(value(flag) ?? fallback)
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${flag} must be a positive integer`)
  return number
}

if (args.includes('--compare')) {
  const at = args.indexOf('--compare')
  if (!args[at + 1] || !args[at + 2]) throw new Error('--compare needs two results.json paths')
  console.log(compareBaselines(resolve(args[at + 1]!), resolve(args[at + 2]!)))
  process.exit(0)
}
if (args.includes('--help')) {
  console.log('node scripts/golden-set/drive-golden-set.ts --home <scratch-directory> [--model <id> ...] [--defer-model <id> ...] [--tree <checkout>] [--runs 2] [--run N] [--tasks T1,T2] [--output <directory>] [--markdown <path>] [--self-check] [--skip-build] [--jobs 1] [--max-time 150] [--max-turns 8] [--budget 0.75]')
  process.exit(0)
}
const knownFlags = new Set(['--home', '--model', '--defer-model', '--tree', '--runs', '--run', '--tasks', '--output', '--markdown', '--self-check', '--skip-build', '--jobs', '--max-time', '--max-turns', '--budget'])
for (const arg of args.filter(arg => arg.startsWith('--'))) if (!knownFlags.has(arg)) throw new Error(`unknown flag ${arg}`)
const rawHome = value('--home')
if (!rawHome) throw new Error('--home must name a scratch directory; the drive never uses the owner config home')
const HOME = resolve(rawHome)
const TREE = resolve(value('--tree') ?? join(SCRIPT_DIR, '../..'))
const under = (path: string, parent: string): boolean => path === parent || (!relative(parent, path).startsWith('..') && !relative(parent, path).startsWith('/'))
if (under(HOME, homedir()) || under(HOME, TREE) || HOME === '/' || HOME === '/private/tmp' || HOME === '/tmp') throw new Error('--home must be a dedicated scratch directory outside the owner home and checkout')
mkdirSync(HOME, { recursive: true, mode: 0o700 })
mkdirSync(MW, { recursive: true })
const MODELS = values('--model').length ? values('--model') : ['local/qwen3.5:9b']
const DEFERRED = values('--defer-model')
if (MODELS.some(model => !model || model.startsWith('--')) || DEFERRED.some(model => !model || model.startsWith('--'))) throw new Error('model flags need model ids')
const TASKS = (value('--tasks') ?? GOLDEN_TASKS.map(task => task.id).join(',')).split(',')
if (TASKS.some(id => !GOLDEN_TASKS.some(task => task.id === id)) || new Set(TASKS).size !== TASKS.length) throw new Error('--tasks must contain distinct golden task ids')
const RUNS = positiveInt('--runs', 2)
const RUN = value('--run') ? positiveInt('--run', 1) : undefined
const JOBS = positiveInt('--jobs', 1)
const LIMITS = { maxTime: positiveInt('--max-time', 150), maxTurns: positiveInt('--max-turns', 8), budget: Number(value('--budget') ?? '0.75'), effort: 'low' }
if (!Number.isFinite(LIMITS.budget) || LIMITS.budget <= 0) throw new Error('--budget must be positive')
const OUTPUT = resolve(value('--output') ?? join(SCRIPT_DIR, 'results', `golden-${new Date().toISOString().replaceAll(':', '-')}`))
const MARKDOWN = value('--markdown') ? resolve(value('--markdown')!) : undefined
const hash = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2) + '\n')
  renameSync(`${path}.tmp`, path)
}

const selfCheck = judgeSelfCheck(HOME)
for (const line of selfCheck.checks) console.log(line)
if (!selfCheck.passed) process.exit(1)
if (args.includes('--self-check')) process.exit(0)
const git = (ref: string): string => {
  const result = spawnSync('git', ['rev-parse', ref], { cwd: TREE, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
const COMMIT = git('HEAD')
const SRC_TREE = git('HEAD:src')
if (!args.includes('--skip-build')) {
  const buildHome = join(HOME, 'build-config')
  mkdirSync(buildHome, { recursive: true })
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: MW, MERCURY_CONFIG_DIR: buildHome }
  delete env.MERCURY_HOME
  delete env.MERCURY_CRITTER
  console.log(`BUILD ${TREE} @ ${COMMIT}`)
  const build = spawnSync('bun', ['run', 'build.ts'], { cwd: TREE, env, stdio: 'inherit' })
  rmSync(buildHome, { recursive: true, force: true })
  if (build.status !== 0) process.exit(build.status ?? 1)
}
const DIST = join(TREE, 'dist/mercury.mjs')
if (!existsSync(DIST)) throw new Error('dist/mercury.mjs is absent; run without --skip-build')
mkdirSync(OUTPUT, { recursive: true })
const metadata: Omit<Baseline, 'rows'> = {
  schema: 1, commit: COMMIT, src_tree: SRC_TREE, bundle_sha256: hash(readFileSync(DIST)),
  fixture_sha256: hash(JSON.stringify(fixtureSnapshot(join(SCRIPT_DIR, 'fixtures')))),
  task_sha256: hash(JSON.stringify(GOLDEN_TASKS)), created_at: new Date().toISOString(), limits: LIMITS,
}
const resultPath = join(OUTPUT, 'results.json')
let baseline: Baseline = { ...metadata, rows: [] }
if (existsSync(resultPath)) {
  baseline = JSON.parse(readFileSync(resultPath, 'utf8')) as Baseline
  for (const key of ['commit', 'src_tree', 'bundle_sha256', 'fixture_sha256', 'task_sha256'] as const) if (baseline[key] !== metadata[key]) throw new Error(`cannot resume: ${key} changed; choose a fresh --output`)
  if (JSON.stringify(baseline.limits) !== JSON.stringify(LIMITS)) throw new Error('cannot resume: run limits changed; choose a fresh --output')
}
const keyOf = (task: string, model: string, run: number): string => `${task}-${model.replaceAll(/[^a-zA-Z0-9._-]/g, '_')}-run${run}`
const save = (): void => {
  baseline.rows.sort((a, b) => a.task.localeCompare(b.task, undefined, { numeric: true }) || a.model.localeCompare(b.model) || a.run - b.run)
  writeJson(resultPath, baseline)
  writeFileSync(join(OUTPUT, 'baseline.md'), markdownOf(baseline))
}
const hasRow = (task: string, model: string, run: number): boolean => baseline.rows.some(row => row.task === task && row.model === model && row.run === run)
const runNumbers = RUN === undefined ? Array.from({ length: RUNS }, (_, i) => i + 1) : [RUN]
for (const model of DEFERRED) for (const task of GOLDEN_TASKS.filter(task => TASKS.includes(task.id))) for (const run of runNumbers) {
  if (hasRow(task.id, model, run)) continue
  baseline.rows.push({
    task: task.id, name: task.name, model, run, state: 'deferred', completed: null,
    wrong_tool_calls: null, wrong_tools: [], calls: null, repeated_identical_calls: null, tokens_in: null, tokens_out: null, seconds: null,
    commit: COMMIT, transcript: null, stderr: null, fixture_evidence: null, exit_code: null, outcome: 'deferred', answer: '',
    reasons: ['lead runs from the main loop'], change_tools: [], changed_files: [], sentence_under_test: task.sentenceUnderTest,
  })
}
writeJson(join(OUTPUT, 'self-check.json'), selfCheck)
save()

function framesOf(text: string): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = []
  for (const line of text.split('\n')) {
    try {
      const value: unknown = JSON.parse(line)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) frames.push(value as Record<string, unknown>)
    } catch {}
  }
  return frames
}
function callsOf(frames: readonly Record<string, unknown>[]): GoldenToolCall[] {
  return frames.flatMap((frame, index) => {
    if (frame.type !== 'tool_call' || typeof frame.tool !== 'string') return []
    const resultIndex = frames.findIndex(result => result.type === 'tool_result' && result.call_id === frame.call_id)
    const result = frames[resultIndex]
    return [{
      tool: frame.tool, input: frame.input && typeof frame.input === 'object' ? frame.input as Record<string, unknown> : {}, index,
      ...(result ? { output: typeof result.output === 'string' ? result.output : JSON.stringify(result.output), resultIndex, failed: result.status === 'error' } : {}),
    }]
  })
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)]))
  return value
}
function repeatedCalls(calls: readonly GoldenToolCall[]): number {
  const seen = new Set<string>()
  let repeated = 0
  for (const call of calls) {
    const key = JSON.stringify(canonical({ tool: call.tool, input: call.input }))
    if (seen.has(key)) repeated++
    seen.add(key)
  }
  return repeated
}
interface ProcessResult { code: number | null; hardTimedOut: boolean }
interface Started { pid?: number; cwd: string; home: string; started_at: string }
function runProcess(cwd: string, home: string, model: string, task: GoldenTask, transcript: string, stderr: string, journal: string): Promise<ProcessResult> {
  return new Promise(resolvePromise => {
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME: home, TMPDIR: MW, MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_CREW_DIR: join(home, 'crew'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_TERMINAL_TITLE: '0', NO_COLOR: '1',
    }
    delete env.MERCURY_HOME
    delete env.MERCURY_CRITTER
    const child = spawn(process.execPath, [
      DIST, 'run', '--format', 'rows', '--model', model, '--effort', LIMITS.effort, '--mode', 'sovereign',
      '--max-turns', String(LIMITS.maxTurns), '--max-time', `${LIMITS.maxTime}s`, '--budget', String(LIMITS.budget),
      '--title', `golden-${task.id}`, '--', task.prompt,
    ], { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    writeJson(journal, { pid: child.pid, cwd, home, started_at: new Date().toISOString() } satisfies Started)
    let hardTimedOut = false
    const killGroup = (): void => {
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGKILL') } catch {}
      } else child.kill('SIGKILL')
    }
    const timer = setTimeout(() => { hardTimedOut = true; killGroup() }, (LIMITS.maxTime + 30) * 1000)
    child.stdout.on('data', chunk => appendFileSync(transcript, chunk))
    child.stderr.on('data', chunk => appendFileSync(stderr, chunk))
    child.on('error', error => appendFileSync(stderr, `\n${String(error)}`))
    child.on('close', code => { clearTimeout(timer); killGroup(); resolvePromise({ code, hardTimedOut }) })
  })
}

async function driveOne(task: GoldenTask, model: string, run: number): Promise<RunRow> {
  const key = keyOf(task.id, model, run)
  const transcript = join(OUTPUT, `${key}.rows.jsonl`)
  const stderr = join(OUTPUT, `${key}.stderr.txt`)
  const fixtureEvidence = join(OUTPUT, `${key}.fixture.json`)
  const journal = join(OUTPUT, `${key}.started.json`)
  const rowPath = join(OUTPUT, `${key}.result.json`)
  if (existsSync(rowPath)) return JSON.parse(readFileSync(rowPath, 'utf8')) as RunRow
  const cwd = join(HOME, `${key}-fixture`)
  const home = join(HOME, `${key}-config`)
  const hadHome = existsSync(home)
  let seconds = 0
  let processResult: ProcessResult = { code: null, hardTimedOut: false }
  let interrupted = false
  if (existsSync(journal)) {
    const started = JSON.parse(readFileSync(journal, 'utf8')) as Started
    if (started.pid !== undefined) {
      let alive = false
      try { process.kill(started.pid, 0); alive = true } catch {}
      if (alive) throw new Error(`${key} still has a live process; wait for its bounded run before resuming`)
    }
    interrupted = true
    seconds = Math.max(0, (Date.now() - Date.parse(started.started_at)) / 1000)
  }
  let failure: string | undefined
  if (!interrupted) {
    if (existsSync(cwd)) throw new Error(`${cwd} already exists without a run journal; refusing to overwrite it`)
    cpSync(join(SCRIPT_DIR, 'fixtures'), cwd, { recursive: true })
    mkdirSync(home, { recursive: true, mode: 0o700 })
    if (!existsSync(join(home, '.mercury.json'))) writeFileSync(join(home, '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: {} }) + '\n')
    writeFileSync(transcript, '')
    writeFileSync(stderr, '')
    const start = Date.now()
    processResult = await runProcess(cwd, home, model, task, transcript, stderr, journal)
    seconds = (Date.now() - start) / 1000
  }
  const frames = framesOf(existsSync(transcript) ? readFileSync(transcript, 'utf8') : '')
  const calls = callsOf(frames)
  const outcome = frames.filter(frame => frame.type === 'outcome').at(-1)
  const answer = typeof outcome?.answer === 'string' ? outcome.answer : ''
  const outcomeStatus = interrupted ? 'interrupted' : processResult.hardTimedOut ? 'driver_timeout' : String(outcome?.status ?? 'missing')
  let verdict = { completed: false, reasons: [] as string[], wrongToolCalls: [] as string[], changedFiles: [] as string[] }
  try {
    verdict = judgeGoldenTask({ task, cwd, configHome: home, answer, calls, seconds, outcomeStatus })
    writeJson(fixtureEvidence, { hashes: fixtureSnapshot(cwd), changedFiles: verdict.changedFiles, verdict })
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    verdict.reasons.push(`judge could not inspect the final fixture: ${failure}`)
  }
  const usages = outcome?.usage ? [outcome.usage] : frames.filter(frame => frame.type === 'step').map(frame => frame.usage)
  let tokensIn = 0, tokensOut = 0
  for (const usage of usages) {
    const values = (usage && typeof usage === 'object' ? usage : {}) as Record<string, unknown>
    const number = (name: string): number => typeof values[name] === 'number' ? values[name] as number : 0
    tokensIn += number('input_tokens') + number('cached_input_tokens') + number('cache_write_input_tokens')
    tokensOut += number('output_tokens')
  }
  const row: RunRow = {
    task: task.id, name: task.name, model, run, state: 'measured', completed: verdict.completed,
    wrong_tool_calls: verdict.wrongToolCalls.length, wrong_tools: verdict.wrongToolCalls, calls: calls.length,
    repeated_identical_calls: repeatedCalls(calls), tokens_in: tokensIn, tokens_out: tokensOut, seconds: Number(seconds.toFixed(3)),
    commit: COMMIT, transcript, stderr, fixture_evidence: existsSync(fixtureEvidence) ? fixtureEvidence : null,
    exit_code: processResult.code, outcome: outcomeStatus, answer, reasons: verdict.reasons,
    change_tools: task.id === 'T3' ? [...new Set(calls.filter(call => ['ChangeSet', 'Edit', 'Write', 'Bash', 'Eval', 'LspRename', 'AstEdit', 'Structure'].includes(call.tool)).map(call => call.tool))] : [],
    changed_files: verdict.changedFiles, sentence_under_test: task.sentenceUnderTest,
  }
  writeJson(rowPath, row)
  rmSync(cwd, { recursive: true, force: true })
  if (!hadHome) rmSync(home, { recursive: true, force: true })
  return row
}

const work: Array<{ task: GoldenTask; model: string; run: number }> = []
for (const model of MODELS) for (const task of GOLDEN_TASKS.filter(task => TASKS.includes(task.id))) for (const run of runNumbers) {
  const previous = baseline.rows.find(row => row.task === task.id && row.model === model && row.run === run)
  if (previous?.state === 'measured') continue
  if (previous) baseline.rows.splice(baseline.rows.indexOf(previous), 1)
  work.push({ task, model, run })
}
let cursor = 0
async function worker(): Promise<void> {
  while (cursor < work.length) {
    const item = work[cursor++]!
    console.log(`START ${item.task.id} ${item.model} run ${item.run}`)
    const row = await driveOne(item.task, item.model, item.run)
    baseline.rows.push(row)
    save()
    console.log(`ROW ${row.task} ${row.model} run ${row.run}: completed=${row.completed} wrong=${row.wrong_tool_calls} calls=${row.calls} repeated=${row.repeated_identical_calls} tokens=${row.tokens_in}/${row.tokens_out} seconds=${row.seconds} outcome=${row.outcome}`)
  }
}
await Promise.all(Array.from({ length: Math.min(JOBS, work.length) }, () => worker()))
save()
if (MARKDOWN) {
  mkdirSync(dirname(MARKDOWN), { recursive: true })
  writeFileSync(MARKDOWN, markdownOf(baseline))
}
console.log(`DONE ${baseline.rows.filter(row => row.state === 'measured').length} measured rows; ${baseline.rows.filter(row => row.state === 'deferred').length} deferred rows. ${resultPath}`)
console.log(`TABLE ${MARKDOWN ?? join(OUTPUT, 'baseline.md')}`)
