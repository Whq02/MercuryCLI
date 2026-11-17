import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { sessionFactsFromWire } from '../../src/services/engine-connector/seatWire.ts'
import type { SessionFactsAnswerV1 } from '../../src/services/engine-connector/seatProjections.ts'
import { startFixtureApi, type FixtureApi, type ScriptedTurn } from './fixtureApi.ts'
import { nodeBinPath } from './nodeBin.ts'
import { removeScratch } from './removeScratch.ts'
import { hostRunner, scratchHome, type HostedRunner } from './runnerHost.ts'

function bundle(): string {
  const dist = process.env.MERCURY_PROOF_DIST ?? resolve(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
  if (!existsSync(dist)) throw new Error(`${dist} is absent: run \`bun run build.ts\`, then run this proof again`)
  return dist
}

type Env = Record<string, string | undefined>
type Scratch = ReturnType<typeof scratchHome>

const INHERITED = /^(?:TMPDIR|NODE_COMPILE_CACHE|ANTHROPIC_BASE_URL|MERCURY_UPDATE_API_BASE_URL|MERCURY_[A-Z0-9_]+_BASE)$/

function scratchEnv(scratch: Scratch, extra: Env = {}): Env {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => INHERITED.test(name)))
  return { ...inherited, ...scratch.env, MERCURY_CREDENTIAL_STORE: 'file', ...extra }
}

function cliEnv(scratch: Scratch, extra: Env = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, ...scratchEnv(scratch, extra) } as NodeJS.ProcessEnv
}

function dropScratch(scratch: Scratch): void {
  for (const dir of [scratch.home, scratch.cwd]) {
    try {
      removeScratch(dir)
    } catch {
      continue
    }
  }
}

export const FIXTURE_MODEL = 'claude-opus-4-8'

function fixtureEnv(api: FixtureApi, extra: Env = {}): Env {
  return { ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: api.url, ...extra }
}

type BuiltCliAnswer = { status: number | null; stdout: string; stderr: string }

export function builtCli(args: readonly string[], opts: { env?: Env; timeoutMs?: number } = {}): BuiltCliAnswer {
  const dist = bundle()
  const scratch = scratchHome('built-cli-')
  try {
    const ran = spawnSync(nodeBinPath(), [dist, ...args], { cwd: scratch.cwd, env: cliEnv(scratch, opts.env), input: '', encoding: 'utf8', timeout: opts.timeoutMs ?? 120_000, windowsHide: true })
    return { status: ran.status, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '' }
  } finally {
    dropScratch(scratch)
  }
}

export function builtHelp(...path: string[]): string {
  const answer = builtCli([...path, '--help'])
  return `${answer.stdout}${answer.stderr}`.replace(/\s+/g, ' ')
}

export async function fixtureCli(turns: ScriptedTurn[], args: readonly string[], opts: { env?: Env; timeoutMs?: number } = {}): Promise<BuiltCliAnswer & { api: FixtureApi }> {
  const dist = bundle()
  const api = await startFixtureApi(turns)
  const scratch = scratchHome('fixture-cli-')
  try {
    const child = spawn(nodeBinPath(), [dist, ...args], { cwd: scratch.cwd, env: cliEnv(scratch, fixtureEnv(api, opts.env)), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += String(chunk)))
    child.stderr.on('data', chunk => (stderr += String(chunk)))
    const ceiling = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 120_000)
    const status = await new Promise<number | null>(done => {
      child.once('close', code => done(code))
      child.once('error', () => done(null))
    })
    clearTimeout(ceiling)
    return { status, stdout, stderr, api }
  } finally {
    await api.close()
    dropScratch(scratch)
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

export async function withLiveRunner<T>(use: (runner: HostedRunner) => Promise<T>, opts: { argv?: string[]; env?: Env; initialize?: boolean } = {}): Promise<T> {
  const dist = bundle()
  const scratch = scratchHome('live-runner-')
  const runner = hostRunner({ dist, node: nodeBinPath(), cwd: scratch.cwd, home: scratch.home, env: scratchEnv(scratch, opts.env), argv: opts.argv ?? [], report: () => {} })
  try {
    if (opts.initialize !== false) await runner.initialize()
    return await use(runner)
  } finally {
    await runner.stop()
    dropScratch(scratch)
  }
}

export async function liveFactsOf(runner: HostedRunner): Promise<SessionFactsAnswerV1> {
  const facts = sessionFactsFromWire(await runner.request('session/facts', {}, 30_000))
  if (facts === null) throw new Error('the live runner answered session/facts with a row the seat wire does not decode')
  return facts
}

export async function withFixtureRunner<T>(turns: ScriptedTurn[], use: (runner: HostedRunner, api: FixtureApi) => Promise<T>, opts: { model?: string | null; argv?: string[]; env?: Env } = {}): Promise<T> {
  const api = await startFixtureApi(turns)
  try {
    return await withLiveRunner(runner => use(runner, api), { argv: [...(opts.model === null ? [] : ['--model', opts.model ?? FIXTURE_MODEL]), ...(opts.argv ?? [])], env: fixtureEnv(api, opts.env) })
  } finally {
    await api.close()
  }
}
