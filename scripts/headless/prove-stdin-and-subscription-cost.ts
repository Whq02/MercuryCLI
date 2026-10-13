#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi, handoffTurn, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL run bundle exists: ${dist}`); process.exit(1) }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }
const j = (value: unknown): string => JSON.stringify(value)?.slice(0, 500) ?? ''
const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

type Outcome = { status?: string; cost_usd?: number; usage?: Record<string, number>; models?: Record<string, Record<string, unknown>> }
type World = { home: string; cwd: string; env: Record<string, string> }

async function deadPort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => { const address = probe.address(); probe.close(() => done(typeof address === 'object' && address !== null ? address.port : 0)) })
  })
}

function world(tag: string, apiUrl: string, signIn: 'key' | 'subscription', deadOauthPort: number): World {
  const home = realpathSync(mkdtempSync(join(tmpdir(), `${tag}-`)))
  const cwd = join(home, 'project')
  mkdirSync(cwd, { recursive: true })
  seedFirstRun(home, [cwd])
  if (signIn === 'subscription') {
    writeFileSync(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fx-claude-access', refreshToken: 'fx-claude-refresh', expiresAt: Date.now() + 86_400_000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } }), { mode: 0o600 })
  }
  const env: Record<string, string> = {
    HOME: home, PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_HOME: home, MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_BASE_URL: apiUrl, MERCURY_ANTHROPIC_OAUTH_BASE: `http://127.0.0.1:${deadOauthPort}`,
    ...(signIn === 'key' ? { ANTHROPIC_API_KEY: FIXTURE_API_KEY } : {}),
  }
  return { home, cwd, env }
}

type Child = { code: number | null; out: string; err: string }
function start(args: string[], w: World, budgetMs = 120_000): { child: ReturnType<typeof spawn>; done: Promise<Child> } {
  const child = spawn('node', [dist, 'run', ...args], { cwd: w.cwd, env: w.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout!.on('data', d => { out += String(d) })
  child.stderr!.on('data', d => { err += String(d) })
  child.stdin!.on('error', () => {})
  const guard = setTimeout(() => child.kill('SIGKILL'), budgetMs)
  const done = new Promise<Child>(resolveChild => child.on('close', code => { clearTimeout(guard); resolveChild({ code, out, err }) }))
  return { child, done }
}
const outcomeOf = (out: string): Outcome | undefined => out.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) as Record<string, unknown> } catch { return null } }).filter((row): row is Record<string, unknown> => row !== null && row.type === 'outcome').at(-1) as Outcome | undefined

const oauthDead = await deadPort()
const answer: ScriptedTurn = { kind: 'text', text: 'The run answered.', usage: { input_tokens: 1000, output_tokens: 50 } }

console.log('§1 RUN-07 — piped context beside a prompt argument is read until the pipe closes or falls silent; the help says so')
{
  const api = await startFixtureApi([answer, handoffTurn()])
  const w = world('stdin-stream', api.url, 'key', oauthDead)
  try {
    const chunks = ['codeword part ONE\n', 'codeword part TWO\n', 'codeword part THREE\n', 'codeword part FOUR\n', 'codeword part FIVE\n']
    const run = start(['--format', 'rows', 'What is the codeword in the piped text?'], w)
    for (const [index, chunk] of chunks.entries()) {
      if (index > 0) await sleep(600)
      run.child.stdin!.write(chunk)
    }
    run.child.stdin!.end()
    const result = await run.done
    const request = JSON.stringify(api.messageRequests()[0]?.body ?? null)
    check('a pipe that keeps delivering for 2.4 s is read to its end: every chunk reaches the prompt', chunks.every(chunk => request.includes(chunk.trim())), `${j({ code: result.code, err: result.err.slice(0, 200) })} chunks seen: ${chunks.filter(chunk => request.includes(chunk.trim())).length}/${chunks.length}`)
    check('the piped text is delimited after the argument', request.includes('What is the codeword in the piped text?\\n\\n<stdin>\\ncodeword part ONE\\n'), request.slice(0, 300))
    check('the run completed, exit 0', result.code === 0 && outcomeOf(result.out)?.status === 'completed', j({ code: result.code, err: result.err.slice(0, 200) }))
  } finally {
    await api.close()
    rmSync(w.home, { recursive: true, force: true })
  }
}
{
  const api = await startFixtureApi([answer, handoffTurn()])
  const w = world('stdin-held', api.url, 'key', oauthDead)
  try {
    const run = start(['--format', 'rows', 'hello'], w)
    run.child.stdin!.write('context on a held pipe\n')
    const started = api.messageRequestStarted(1).then(() => 'started' as const)
    const raced = await Promise.race([started, sleep(20_000).then(() => 'silent' as const)])
    check('a pipe that falls silent does not hold the run: the request left while the pipe was still open', raced === 'started', raced)
    const request = JSON.stringify(api.messageRequests()[0]?.body ?? null)
    check('…carrying what had arrived', request.includes('<stdin>\\ncontext on a held pipe\\n</stdin>'), request.slice(0, 300))
    run.child.stdin!.end()
    const result = await run.done
    check('the run completed, exit 0', result.code === 0, j({ code: result.code, err: result.err.slice(0, 200) }))
  } finally {
    await api.close()
    rmSync(w.home, { recursive: true, force: true })
  }
}
{
  const api = await startFixtureApi([answer, handoffTurn()])
  const w = world('stdin-dash', api.url, 'key', oauthDead)
  try {
    const run = start(['--format', 'rows', '-'], w)
    await sleep(2_500)
    run.child.stdin!.end('the whole prompt, late\n')
    const result = await run.done
    const request = JSON.stringify(api.messageRequests()[0]?.body ?? null)
    check('run - still waits for its producer: a prompt arriving after 2.5 s is the prompt', result.code === 0 && request.includes('the whole prompt, late'), j({ code: result.code, err: result.err.slice(0, 200) }))
  } finally {
    await api.close()
    rmSync(w.home, { recursive: true, force: true })
  }
}
{
  const help = spawnSync('node', [dist, 'run', '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: tmpdir(), MERCURY_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'stdin-help-')), MERCURY_LOCAL_PROBE_TARGETS: 'none' } })
  const words = help.stdout.replace(/\s+/g, ' ')
  check('the help words agree with the behaviour: the pipe is read until it closes or has been silent for 1 s', words.includes('the pipe is read until it closes or has been silent for 1 s'), words.slice(words.indexOf('prompt'), words.indexOf('prompt') + 300))
  check('…and no longer promise a 1 s window for everything piped in', !words.includes('anything piped in within 1 s'), words.slice(0, 300))
}

console.log('§2 RUN-09 — cost_usd is never a number on a Claude subscription sign-in; a key-billed run keeps it')
{
  const api = await startFixtureApi([answer, handoffTurn()])
  const w = world('subscription-cost', api.url, 'subscription', oauthDead)
  try {
    const run = start(['--format', 'rows', 'reply'], w)
    run.child.stdin!.end()
    const result = await run.done
    const outcome = outcomeOf(result.out)
    check('the run completed on the subscription sign-in', result.code === 0 && outcome?.status === 'completed', j({ code: result.code, err: result.err.slice(0, 300), status: outcome?.status }))
    check('the outcome row carries no cost_usd', outcome !== undefined && !('cost_usd' in outcome), j(outcome))
    check('…but its usage', (outcome?.usage?.input_tokens ?? 0) >= 1000 && (outcome?.usage?.output_tokens ?? 0) >= 50, j(outcome?.usage))
    const models = Object.values(outcome?.models ?? {})
    check('no per-model row prices the subscription', models.length > 0 && models.every(row => !('cost_usd' in row)), j(outcome?.models))
    check('the whole stream names no dollar figure', !/"cost_usd"/.test(result.out), result.out.slice(0, 300))
  } finally {
    await api.close()
    rmSync(w.home, { recursive: true, force: true })
  }
}
{
  const api = await startFixtureApi([answer, handoffTurn()])
  const w = world('key-cost', api.url, 'key', oauthDead)
  try {
    const run = start(['--format', 'rows', 'reply'], w)
    run.child.stdin!.end()
    const result = await run.done
    const outcome = outcomeOf(result.out)
    check('control: a key-billed run still reports cost_usd as a number', result.code === 0 && typeof outcome?.cost_usd === 'number' && outcome.cost_usd > 0, j(outcome))
    check('…and prices each model', Object.values(outcome?.models ?? {}).every(row => typeof row.cost_usd === 'number'), j(outcome?.models))
  } finally {
    await api.close()
    rmSync(w.home, { recursive: true, force: true })
  }
}
process.exit(failures === 0 ? 0 : 1)
