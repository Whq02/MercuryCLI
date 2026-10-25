#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) {
  console.error(`FAIL run bundle exists: ${dist}`)
  process.exit(1)
}
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`)
  if (!ok) failures++
}
type Outcome = { status?: string; error?: { message?: string; class?: string } }
const DEAD = 'http://127.0.0.1:9'

async function wall(localTargets: string): Promise<{ code: number | null; outcome: Outcome | undefined; out: string; err: string }> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'no-sign-in-local-road-')))
  const cwd = join(home, 'project')
  mkdirSync(cwd, { recursive: true })
  seedFirstRun(home, [cwd])
  const env: Record<string, string> = {
    HOME: home,
    PATH: process.env.PATH ?? '',
    TMPDIR: tmpdir(),
    MERCURY_CONFIG_DIR: home,
    MERCURY_HOME: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: localTargets,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    ANTHROPIC_BASE_URL: DEAD,
    BROWSER: '/usr/bin/true',
  }
  const child = spawn('node', [dist, 'run', '--format', 'rows', '--', 'say ok'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', d => {
    out += String(d)
  })
  child.stderr.on('data', d => {
    err += String(d)
  })
  const guard = setTimeout(() => child.kill('SIGKILL'), 90_000)
  const code = await new Promise<number | null>(done => child.on('close', c => {
    clearTimeout(guard)
    done(c)
  }))
  rmSync(home, { recursive: true, force: true })
  const rows = out.split('\n').filter(Boolean).map(line => {
    try {
      return JSON.parse(line) as Record<string, unknown>
    } catch {
      return null
    }
  }).filter((row): row is Record<string, unknown> => row !== null)
  return { code, outcome: rows.filter(row => row.type === 'outcome').at(-1) as Outcome | undefined, out, err }
}

console.log('§1 no sign-in, no local server: the headless refusal names the sign-in AND the local road a script user can take')
{
  const run = await wall('none')
  const message = run.outcome?.error?.message ?? ''
  check('the turn fails on the auth class', run.outcome?.status === 'failed' && run.outcome.error?.class === 'auth', JSON.stringify(run.outcome ?? run.err.slice(-400)))
  check('the message leads with the model door (choose a model · /model) — the keyless default is the "choose a model" entry', message.startsWith('choose a model · /model, '), message)
  check('…and names the local road: /localsetup sets one up (Ollama, LM Studio, vLLM, llama.cpp)', message.includes('or run a local model — /localsetup sets one up (Ollama, LM Studio, vLLM, llama.cpp)'), message)
  check('the message is one line', !message.includes('\n'), message)
}

console.log('§2 no sign-in, a local server answering with models: the refusal names --model local/<name> and the server')
{
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/api/tags') return Response.json({ models: ['qwen3.5:9b', 'qwen3.6:27b-coding'].map(name => ({ name, model: name, size: 6_600_000_000, details: { family: 'qwen35' } })) })
      if (path === '/api/version') return Response.json({ version: '0.40.5' })
      if (path === '/api/ps') return Response.json({ models: [] })
      if (path === '/api/show') return Response.json({ parameters: '', model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 262144 }, capabilities: ['completion', 'tools'] })
      return new Response('{}', { status: 404 })
    },
  })
  const run = await wall(`ollama=http://127.0.0.1:${server.port}`)
  server.stop(true)
  const message = run.outcome?.error?.message ?? ''
  check('the turn still fails on the auth class (the default model is a hosted one)', run.outcome?.status === 'failed' && run.outcome.error?.class === 'auth', JSON.stringify(run.outcome ?? run.err.slice(-400)))
  check('the message names the switch a script user can make: --model local/<name>, with the server and its model count', message.startsWith('choose a model · /model, ') && message.includes('or run a local model with --model local/<name> (Ollama 0.40.5 (2))'), message)
}

console.log('§3 the words have one owner')
{
  const { localRoadBesideSignIn, LOCAL_SETUP_WORDS } = await import('../../src/services/providers/local/localAccounts.ts')
  const turnSource = await Bun.file(join(import.meta.dir, '../../src/rows/turn.ts')).text()
  check('rows/turn.ts reads the clause from localAccounts, beside the pinned constants', turnSource.includes('if (message === INVALID_API_KEY_ERROR_MESSAGE || message === CHOOSE_A_MODEL_DOOR) message = `${message}, ${localRoadBesideSignIn()}`'))
  check('the clause without a server is the /localsetup words the sign-in wall\'s readiness row uses', localRoadBesideSignIn(undefined) === `or run a local model — ${LOCAL_SETUP_WORDS}`)
}

console.log(failures === 0 ? '\nprove-no-sign-in-names-local-road: ALL GREEN' : `\nprove-no-sign-in-names-local-road: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
