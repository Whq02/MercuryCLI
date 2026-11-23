import { execFileSync, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { sessionFactsFromWire } from '../../src/engine/connector/seatWire.ts'
import type { SessionFactsAnswerV1 } from '../../src/engine/connector/seatProjections.ts'
import { FLAG_REGISTRY } from '../../src/platform/substrate/flagRegistry.ts'
import { distBuildInputs } from './distProvenance.ts'
import { startFixtureApi, type FixtureApi, type ScriptedTurn } from './fixtureApi.ts'
import { nodeBinPath } from './nodeBin.ts'
import { endProcessGroup, spawnInOwnGroup } from './processGroup.ts'
import { removeScratch } from './removeScratch.ts'
import { featureTraceEnv, hostRunner, scratchHome, type HostedRunner } from './runnerHost.ts'

const TREE = resolve(import.meta.dir, '..', '..')

type Verdict = { dist: string } | { refusal: string }
const verdicts = new Map<string, Verdict>()

function judged(tree: string | undefined): Verdict {
  const pinned = tree === undefined ? process.env.MERCURY_PROOF_DIST : undefined
  if (pinned !== undefined) return existsSync(pinned) ? { dist: pinned } : { refusal: `${pinned} is absent: MERCURY_PROOF_DIST names no bundle; unset it or point it at a built mercury.mjs, then run this proof again` }
  const root = tree ?? TREE
  const dist = join(root, 'dist', 'mercury.mjs')
  if (!existsSync(dist)) return { refusal: `${dist} is absent: run \`bun run build.ts\` in ${root}, then run this proof again` }
  const inputs = distBuildInputs(root)
  return inputs.stale ? { refusal: `${inputs.line}: build first (\`bun run build.ts\` in ${root}), then run this proof again` } : { dist }
}

function bundle(tree?: string): string {
  const key = tree ?? process.env.MERCURY_PROOF_DIST ?? TREE
  let verdict = verdicts.get(key)
  if (verdict === undefined) {
    verdict = judged(tree)
    verdicts.set(key, verdict)
    if ('refusal' in verdict) process.stderr.write(`${verdict.refusal}\n`)
  }
  if ('refusal' in verdict) throw new Error(verdict.refusal)
  return verdict.dist
}

type Env = Record<string, string | undefined>
type Scratch = ReturnType<typeof scratchHome>
type Drive = { env?: Env; tree?: string }

const KEPT = /^(?:TMPDIR|NODE_COMPILE_CACHE)$/
const BASE = /^(?:MERCURY_UPDATE_API_BASE_URL|MERCURY_[A-Z0-9_]+_BASE)$/
const DEAD_ADDRESS = 'http://127.0.0.1:1'

function deadBases(): Env {
  return Object.fromEntries(['ANTHROPIC_BASE_URL', ...FLAG_REGISTRY.map(row => row.env).filter(name => BASE.test(name))].map(name => [name, DEAD_ADDRESS]))
}

function scratchEnv(scratch: Scratch, extra: Env = {}): Env {
  const kept = Object.fromEntries(Object.entries(process.env).filter(([name]) => KEPT.test(name)))
  return { ...deadBases(), ...kept, ...featureTraceEnv(), ...scratch.env, MERCURY_CREDENTIAL_STORE: 'file', ...extra }
}

function cliEnv(scratch: Scratch, extra: Env = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, ...scratchEnv(scratch, extra) } as NodeJS.ProcessEnv
}

const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const
const live = new Map<ChildProcess, string | null>()
let parent: string | null = null
let watching = false

function reap(): void {
  for (const [child, entry] of live) {
    endProcessGroup(child)
    if (entry !== null) rmSync(entry, { force: true })
  }
  live.clear()
  if (parent === null) return
  const folder = parent
  parent = null
  try {
    removeScratch(folder)
  } catch (error) {
    process.stderr.write(`built product scratch left behind: ${folder}: ${(error as Error).message}\n`)
  }
}

function watch(): void {
  if (watching) return
  watching = true
  process.on('exit', reap)
  for (const signal of SIGNALS) {
    const onSignal = (): void => {
      reap()
      process.removeListener(signal, onSignal)
      process.kill(process.pid, signal)
    }
    process.on(signal, onSignal)
  }
}

function scratch(kind: string): Scratch {
  if (parent === null) {
    parent = mkdtempSync(join(tmpdir(), 'built-product-'))
    watch()
  }
  return scratchHome(join(relative(tmpdir(), parent), `${kind}-`))
}

function dropScratch(made: Scratch): void {
  for (const dir of [made.home, made.cwd]) {
    try {
      removeScratch(dir)
    } catch {
      continue
    }
  }
}

function startedAt(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, windowsHide: true }).trim() || '?'
  } catch {
    return '?'
  }
}

function track(child: ChildProcess, cwd: string): void {
  const ledger = process.env.MERCURY_PROCESS_LEDGER_DIR
  if (!ledger || child.pid === undefined) {
    live.set(child, null)
    return
  }
  const entry = join(ledger, `${child.pid}.entry`)
  try {
    mkdirSync(ledger, { recursive: true })
    writeFileSync(entry, `${[child.pid, process.env.MERCURY_SUITE_RUNNER_PID || process.pid, startedAt(child.pid), cwd, child.spawnargs.join(' ').replace(/\s+/g, ' ')].join('\t')}\n`)
    live.set(child, entry)
  } catch {
    live.set(child, null)
  }
}

function settled(child: ChildProcess): void {
  const entry = live.get(child)
  if (entry) rmSync(entry, { force: true })
  live.delete(child)
}

export const FIXTURE_MODEL = 'claude-opus-4-8'

function fixtureEnv(api: FixtureApi, extra: Env = {}): Env {
  return { ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: api.url, ...extra }
}

type BuiltCliAnswer = { status: number | null; stdout: string; stderr: string }

export function builtCli(args: readonly string[], opts: Drive & { timeoutMs?: number } = {}): BuiltCliAnswer {
  const dist = bundle(opts.tree)
  const made = scratch('cli')
  try {
    const ran = spawnSync(nodeBinPath(), [dist, ...args], { cwd: made.cwd, env: cliEnv(made, opts.env), input: '', encoding: 'utf8', timeout: opts.timeoutMs ?? 120_000, windowsHide: true })
    return { status: ran.status, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '' }
  } finally {
    dropScratch(made)
  }
}

export function builtHelp(...path: string[]): string {
  const answer = builtCli([...path, '--help'])
  return `${answer.stdout}${answer.stderr}`.replace(/\s+/g, ' ')
}

export async function fixtureCli(turns: ScriptedTurn[], args: readonly string[], opts: Drive & { timeoutMs?: number } = {}): Promise<BuiltCliAnswer & { api: FixtureApi }> {
  const dist = bundle(opts.tree)
  const made = scratch('fix')
  const api = await startFixtureApi(turns)
  let started: ChildProcess | null = null
  try {
    const child = spawnInOwnGroup(nodeBinPath(), [dist, ...args], { cwd: made.cwd, env: cliEnv(made, fixtureEnv(api, opts.env)), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    started = child
    track(child, made.cwd)
    let stdout = ''
    let stderr = ''
    child.stdout!.on('data', chunk => (stdout += String(chunk)))
    child.stderr!.on('data', chunk => (stderr += String(chunk)))
    const ceiling = setTimeout(() => endProcessGroup(child), opts.timeoutMs ?? 120_000)
    const status = await new Promise<number | null>(done => {
      child.once('close', code => done(code))
      child.once('error', () => done(null))
    })
    clearTimeout(ceiling)
    return { status, stdout, stderr, api }
  } finally {
    if (started !== null) {
      endProcessGroup(started)
      settled(started)
    }
    await api.close()
    dropScratch(made)
  }
}

type RunnerRefusal = { code?: number; message: string; data?: { kind?: string } }

export async function refusalOf(answer: Promise<unknown>): Promise<RunnerRefusal | null> {
  try {
    await answer
    return null
  } catch (error) {
    return error as RunnerRefusal
  }
}

export async function withLiveRunner<T>(use: (runner: HostedRunner) => Promise<T>, opts: Drive & { argv?: string[]; initialize?: boolean } = {}): Promise<T> {
  const dist = bundle(opts.tree)
  const made = scratch('run')
  const runner = hostRunner({ dist, node: nodeBinPath(), cwd: made.cwd, home: made.home, env: scratchEnv(made, opts.env), argv: opts.argv ?? [], report: () => {} })
  track(runner.child, made.cwd)
  try {
    if (opts.initialize !== false) await runner.initialize()
    return await use(runner)
  } finally {
    await runner.stop()
    settled(runner.child)
    dropScratch(made)
  }
}

export async function liveFactsOf(runner: HostedRunner): Promise<SessionFactsAnswerV1> {
  const facts = sessionFactsFromWire(await runner.request('session/facts', {}, 30_000))
  if (facts === null) throw new Error('the live runner answered session/facts with a row the seat wire does not decode')
  return facts
}

export async function withFixtureRunner<T>(turns: ScriptedTurn[], use: (runner: HostedRunner, api: FixtureApi) => Promise<T>, opts: Drive & { model?: string | null; argv?: string[] } = {}): Promise<T> {
  const api = await startFixtureApi(turns)
  try {
    return await withLiveRunner(runner => use(runner, api), { argv: [...(opts.model === null ? [] : ['--model', opts.model ?? FIXTURE_MODEL]), ...(opts.argv ?? [])], env: fixtureEnv(api, opts.env), tree: opts.tree })
  } finally {
    await api.close()
  }
}

export function systemPromptOf(api: FixtureApi): string {
  const system = (api.messageRequests().find(request => !request.path.includes('count_tokens'))?.body as { system?: unknown } | undefined)?.system
  if (typeof system === 'string') return system
  return Array.isArray(system) ? system.map(block => String((block as { text?: unknown }).text ?? '')).join('\n') : ''
}

export function firstSystemPrompt(argv: string[] = [], env: Env = {}): Promise<string> {
  return withFixtureRunner(
    [{ kind: 'text', text: 'ok' }],
    async (runner, api) => {
      await runner.prompt('go')
      await runner.waitFor('the first turn ends', row => row.type === 'outcome')
      return systemPromptOf(api)
    },
    { argv, env },
  )
}
