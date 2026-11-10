#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi, handoffTurn, isHandoffRequest, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { hostRunner, scratchHome } from '../lib/runnerHost.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL run bundle exists: ${dist}`); process.exit(1) }

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => { checks++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !detail ? '' : `: ${detail}`}`); if (!ok) failures++ }
const head = (text: string): string => JSON.stringify(text.slice(0, 160))

const AGENT_BRIEF = 'AGENT_BRIEF_MARKER: answer as the fixture agent and name the file you would open first.'
const OTHER_BRIEF = 'OPERATOR_BRIEF_MARKER: answer in one line.'
const AGENT_OPENING = 'AGENT_OPENING_MARKER: list the project.'
const definitions = (extra: Record<string, unknown> = {}): string => JSON.stringify({ fixture: { description: 'A fixture agent with a prompt of its own', prompt: AGENT_BRIEF, ...extra } })

type Seen = { code: number | null; err: string; status: string | undefined; system: string; said: string; requests: number }

const home = realpathSync(mkdtempSync(join(tmpdir(), 'agent-prompt-')))
const cwd = join(home, 'project')
mkdirSync(cwd, { recursive: true })
mkdirSync(join(home, 'tmp'), { recursive: true })
seedFirstRun(home, [cwd])

async function run(args: string[]): Promise<Seen> {
  const turns: ScriptedTurn[] = [{ kind: 'text', text: 'FIXTURE_ANSWER' }, handoffTurn(), handoffTurn(), handoffTurn()]
  const api = await startFixtureApi(turns)
  try {
    const child = spawn('node', [dist, 'run', '--format', 'json', '--model', 'claude-opus-4-8', ...args], {
      cwd,
      env: {
        HOME: home, PATH: process.env.PATH ?? '', TMPDIR: join(home, 'tmp'), MERCURY_TMPDIR: join(home, 'tmp'), MERCURY_CONFIG_DIR: home, MERCURY_HOME: home, MERCURY_CREDENTIAL_STORE: 'file',
        MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: FIXTURE_API_KEY, ANTHROPIC_BASE_URL: api.url,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', d => { out += String(d) })
    child.stderr.on('data', d => { err += String(d) })
    const guard = setTimeout(() => child.kill('SIGKILL'), 120_000)
    const code = await new Promise<number | null>(done => child.on('close', exit => { clearTimeout(guard); done(exit) }))
    const asked = api.requests.filter(request => request.path.includes('/v1/messages') && !request.path.includes('count_tokens') && !isHandoffRequest(request))
    const body = (asked[0]?.body ?? {}) as { system?: unknown; messages?: unknown }
    const blocks = Array.isArray(body.system) ? body.system as Array<{ text?: string }> : [{ text: typeof body.system === 'string' ? body.system : '' }]
    let status: string | undefined
    try { status = (JSON.parse(out) as { status?: string }).status } catch { status = undefined }
    return { code, err, status, system: blocks.map(block => block.text ?? '').at(-1) ?? '', said: JSON.stringify(body.messages ?? []), requests: asked.length }
  } finally {
    await api.close()
  }
}

try {
  console.log('§1 what a run rides without an agent: the default brief, and an operator brief in its place')
  const plain = await run(['PLAIN_PROMPT'])
  const briefed = await run(['--brief', OTHER_BRIEF, 'BRIEFED_PROMPT'])
  check('the scene: both runs complete and each asks the model once', plain.code === 0 && briefed.code === 0 && plain.status === 'completed' && briefed.status === 'completed' && plain.requests === 1 && briefed.requests === 1, `plain rc ${plain.code} ${plain.status} · briefed rc ${briefed.code} ${briefed.status} · ${plain.err.slice(0, 200)}`)
  check('the operator brief rides the system prompt and the default brief does not', briefed.system.includes(OTHER_BRIEF) && !plain.system.includes(OTHER_BRIEF) && briefed.system !== plain.system, head(briefed.system))

  console.log('\n§2 --agent: the agent the operator chose brings its prompt on the first run')
  const session = randomUUID()
  const chosen = await run(['--agent-defs', definitions(), '--agent', 'fixture', '--session-id', session, 'AGENT_PROMPT'])
  check('the run completes', chosen.code === 0 && chosen.status === 'completed' && chosen.requests === 1, `rc ${chosen.code} ${chosen.status} · ${chosen.err.slice(0, 300)}`)
  check("the request's system prompt carries the agent's prompt", chosen.system.includes(AGENT_BRIEF), head(chosen.system))
  check('it rides where an operator brief rides: the same system prompt with the one text for the other', chosen.system.split(AGENT_BRIEF).join(OTHER_BRIEF) === briefed.system, `agent ${chosen.system.length} chars ${head(chosen.system)} · brief ${briefed.system.length} chars ${head(briefed.system)}`)
  check('the default brief is not sent beside it', chosen.system !== plain.system && chosen.system.length < plain.system.length + AGENT_BRIEF.length, `${chosen.system.length} against the default's ${plain.system.length}`)

  console.log('\n§3 the same session resumed without the flag keeps the same prompt')
  const resumed = await run(['--agent-defs', definitions(), '--resume', session, 'RESUMED_PROMPT'])
  check('the resumed run completes and its system prompt carries the agent prompt', resumed.code === 0 && resumed.status === 'completed' && resumed.system.includes(AGENT_BRIEF), `rc ${resumed.code} ${resumed.status} · ${head(resumed.system)} · ${resumed.err.slice(0, 200)}`)
  check('the first run and the resumed run ride one system prompt', resumed.system === chosen.system, `first ${chosen.system.length} chars · resumed ${resumed.system.length} chars`)

  console.log("\n§4 an operator brief beside --agent is the operator's: the brief rides, the agent's prompt does not")
  const both = await run(['--agent-defs', definitions(), '--agent', 'fixture', '--brief', OTHER_BRIEF, 'BOTH_PROMPT'])
  check('the brief is sent and the agent prompt is not', both.code === 0 && both.system.includes(OTHER_BRIEF) && !both.system.includes(AGENT_BRIEF), `rc ${both.code} · ${head(both.system)}`)

  console.log("\n§5 an agent's opening prompt still opens the run, under the agent's own prompt")
  const opened = await run(['--agent-defs', definitions({ initialPrompt: AGENT_OPENING }), '--agent', 'fixture'])
  check('with no prompt given the opening prompt is what the model is asked', opened.code === 0 && opened.said.includes(AGENT_OPENING), `rc ${opened.code} · ${opened.err.slice(0, 200)}`)
  check("…and the system prompt carries the agent's prompt", opened.system.includes(AGENT_BRIEF), head(opened.system))

  console.log('\n§6 the agent named by settings.engine.agent brings its prompt the same way')
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ engine: { agent: 'fixture' } }))
  const settled = await run(['--agent-defs', definitions(), 'SETTINGS_PROMPT'])
  check('the run completes and its system prompt carries the agent prompt', settled.code === 0 && settled.status === 'completed' && settled.system.includes(AGENT_BRIEF), `rc ${settled.code} ${settled.status} · ${head(settled.system)} · ${settled.err.slice(0, 200)}`)

  console.log("\n§7 the runner door, which a window's session runs behind, takes the same flag the same way")
  const node = Bun.which('node')
  const api = await startFixtureApi([{ kind: 'text', text: 'FIXTURE_ANSWER' }, handoffTurn(), handoffTurn()])
  const scratch = scratchHome('agent-prompt-runner-')
  mkdirSync(join(scratch.home, 'tmp'), { recursive: true })
  const host = hostRunner({ dist, node: node ?? 'node', cwd: scratch.cwd, home: scratch.home, env: { ...scratch.env, TMPDIR: join(scratch.home, 'tmp'), MERCURY_TMPDIR: join(scratch.home, 'tmp'), ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: FIXTURE_API_KEY }, argv: ['--model', 'claude-opus-4-8', '--agent-defs', definitions(), '--agent', 'fixture'] })
  try {
    await host.initialize({}, 90_000)
    await host.prompt('RUNNER_PROMPT')
    const outcome = await host.waitFor('the first outcome', row => row.type === 'outcome', 90_000) as { status?: string }
    const asked = api.requests.filter(request => request.path.includes('/v1/messages') && !request.path.includes('count_tokens') && !isHandoffRequest(request))
    const system = ((asked[0]?.body ?? {}) as { system?: Array<{ text?: string }> }).system?.map(block => block.text ?? '').at(-1) ?? ''
    check("the turn completes and its request's system prompt carries the agent's prompt", outcome.status === 'completed' && system.includes(AGENT_BRIEF), `${outcome.status} · ${head(system)}`)
  } finally {
    await host.stop()
    await api.close()
    rmSync(scratch.home, { recursive: true, force: true })
    rmSync(scratch.cwd, { recursive: true, force: true })
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`\n${failures ? 'FAIL' : 'PASS'} agent-flag-carries-its-prompt: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
