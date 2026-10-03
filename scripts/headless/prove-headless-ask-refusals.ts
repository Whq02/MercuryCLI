#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { parseFrame, spawnRunnerDoor } from '../lib/rows.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('dist/mercury.mjs missing — build the product first')
  process.exit(1)
}
const vendoredNode = join(ROOT, 'dist', 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const NODE = existsSync(vendoredNode) ? vendoredNode : Bun.which('node') ?? 'node'
const API_KEY = 'fixture-key-000'
const MODEL = 'claude-opus-4-8'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + t)

const done: ScriptedTurn = { kind: 'text', text: 'Done.' }
const askQuestion: ScriptedTurn = { kind: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Which one?', header: 'Pick', options: [{ label: 'a', description: 'first' }, { label: 'b', description: 'second' }], multiSelect: false }] } }
const openBrowser: ScriptedTurn = { kind: 'tool_use', name: 'Browser', input: { op: 'open', url: 'http://127.0.0.1:9/' } }

interface World { home: string; cwd: string; env: Record<string, string> }
function makeWorld(tag: string, baseUrl: string): World {
  const home = realpathSync(mkdtempSync(join(tmpdir(), `ask-refusals-${tag}-`)))
  const cwd = join(home, 'project')
  const configDir = join(home, '.mercury')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(cwd, 'README.md'), '# fixture\n')
  writeFileSync(join(configDir, '.config.json'), JSON.stringify({
    theme: 'dark',
    hasCompletedOnboarding: true,
    customApiKeyResponses: { approved: [API_KEY.slice(-20)] },
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }))
  return {
    home,
    cwd,
    env: {
      HOME: home,
      PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${dirname(NODE)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: configDir,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_CREWS_DIR: join(home, 'crews'),
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_BROWSER_NO_DISCOVERY: '1',
      MERCURY_BROWSER_CACHE_DIR: join(home, 'browser-cache'),
      BROWSER: '/usr/bin/true',
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: API_KEY,
    },
  }
}

interface Captured { results: Array<{ tool_use_id: string; is_error?: boolean; text: string }>; system: string; tools: string[]; toolDescriptions: Record<string, string> }
function capture(requests: Array<{ body: unknown }>): Captured {
  const results: Captured['results'] = []
  let system = ''
  let tools: string[] = []
  const toolDescriptions: Record<string, string> = {}
  for (const request of requests) {
    const body = request.body as { system?: unknown; tools?: Array<{ name: string; description?: string }>; messages?: Array<{ role: string; content: unknown }> }
    if (tools.length === 0 && Array.isArray(body.tools)) {
      tools = body.tools.map(tool => tool.name)
      for (const tool of body.tools) toolDescriptions[tool.name] = tool.description ?? ''
    }
    if (system === '') system = typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? body.system.map(part => (part as { text?: string }).text ?? '').join('\n') : ''
    for (const message of body.messages ?? []) {
      if (message.role !== 'user' || !Array.isArray(message.content)) continue
      for (const block of message.content as Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }>) {
        if (block.type !== 'tool_result') continue
        const content = block.content
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => (part as { text?: string }).text ?? '').join('\n') : JSON.stringify(content)
        if (!results.some(row => row.tool_use_id === block.tool_use_id)) results.push({ tool_use_id: block.tool_use_id ?? '', is_error: block.is_error, text })
      }
    }
  }
  return { results, system, tools, toolDescriptions }
}

async function runOneShot(tag: string, turns: ScriptedTurn[], extraArgs: string[] = []): Promise<Captured & { code: number | null; stderr: string }> {
  const fixture = await startFixtureApi(turns)
  const world = makeWorld(tag, fixture.url)
  const result = await new Promise<{ code: number | null; stderr: string }>(resolveRun => {
    const child = spawn(NODE, [DIST, 'run', `probe ${tag}`, '--model', MODEL, ...extraArgs], { cwd: world.cwd, env: world.env })
    let stderr = ''
    child.stderr.on('data', chunk => (stderr += chunk))
    child.stdout.on('data', () => {})
    const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.on('close', code => { clearTimeout(killer); resolveRun({ code, stderr }) })
  })
  const captured = capture(fixture.messageRequests())
  await fixture.close()
  rmSync(world.home, { recursive: true, force: true })
  return { ...captured, ...result }
}

async function runStdioChannel(tag: string, turns: ScriptedTurn[], answer: (request: Record<string, unknown>) => Record<string, unknown>): Promise<Captured & { code: number | null; asks: Array<Record<string, unknown>> }> {
  const fixture = await startFixtureApi(turns)
  const world = makeWorld(tag, fixture.url)
  const asks: Array<Record<string, unknown>> = []
  let sawResult = false
  const door = spawnRunnerDoor({
    node: NODE,
    argv: [DIST, 'runner', '--model', MODEL],
    cwd: world.cwd,
    env: world.env,
    onLine: line => {
      const frame = parseFrame(line)
      if (frame === null) return
      if (frame.type === 'control_request') {
        const request = frame.request as Record<string, unknown>
        if (request.subtype === 'can_use_tool') {
          asks.push(request)
          door.send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: answer(request) } })
        }
      }
      if (frame.type === 'outcome' && !sawResult) {
        sawResult = true
        child.stdin!.end()
      }
    },
  })
  const child = door.child
  const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  child.stderr!.on('data', () => {})
  door.send({ type: 'user', message: { role: 'user', content: `probe ${tag}` } })
  const code = await new Promise<number | null>(resolveRun => child.on('close', value => { clearTimeout(killer); resolveRun(value) }))
  const captured = capture(fixture.messageRequests())
  await fixture.close()
  rmSync(world.home, { recursive: true, force: true })
  return { ...captured, code, asks }
}

const OPERATOR_LINE = /no operator can answer AskUserQuestion — the request was auto-denied and nothing was asked\. Choose the most reasonable option yourself, state the assumption in your reply, and continue; a host on the runner door/
const RECIPE_LINE = /pre-approve the tool at launch with --allowed-tools/

section('§1 a run with no host: the question tool is refused with the way out, never the pre-approve recipe')
{
  const run = await runOneShot('ask', [askQuestion, done])
  const row = run.results[0]
  check('the question call came back as an error result', row !== undefined && row.is_error === true, JSON.stringify(row?.text.slice(0, 200)))
  check('…naming that no operator can answer and what to do instead', row !== undefined && OPERATOR_LINE.test(row.text), row?.text.slice(0, 400))
  check('…and never the --allowed-tools recipe (it cannot give the tool an operator)', row !== undefined && !RECIPE_LINE.test(row.text), row?.text.slice(0, 400))
  check('the system prompt posture says no question can reach the operator', /no host to answer an ask/.test(run.system) && /no question can reach the operator/.test(run.system), run.system.match(/- Session:[^\n]{0,200}/)?.[0] ?? 'no posture line')
  check('the guidance section carries no "use AskUserQuestion to ask" hint', !/use AskUserQuestion to ask rather than guessing/.test(run.system))
  check('the tool stays offered (a connected client could answer it)', run.tools.includes('AskUserQuestion'), run.tools.join(','))
}

section('§2 the browser: an unapproved origin is refused with the way out; the description says so')
{
  const run = await runOneShot('browser', [openBrowser, done])
  const row = run.results[0]
  check('the first-visit ask is auto-denied with the pre-approve recipe (a permission ask, not an operator question)', row !== undefined && row.is_error === true && RECIPE_LINE.test(row.text) && /--allowed-tools "Browser"/.test(row.text), row?.text.slice(0, 400))
}

section('§3 pre-approved, the same headless run reaches the browser itself and meets its own typed line')
{
  const run = await runOneShot('browser-allowed', [openBrowser, done], ['--allowed-tools', 'Browser'])
  const row = run.results[0]
  check('the tool ran and refused for want of a browser, naming the way out', row !== undefined && row.is_error === true && /browser unavailable/.test(row.text) && /install/.test(row.text), row?.text.slice(0, 400))
}

section('§4 the runner door: the same asks reach the host and its answer stands')
{
  const run = await runStdioChannel('stdio-ask', [askQuestion, done], () => ({ behavior: 'deny', message: 'the client declined the question' }))
  check('the question tool asked through the door', run.asks.some(ask => ask.tool_name === 'AskUserQuestion'), run.asks.map(ask => String(ask.tool_name)).join(','))
  const row = run.results[0]
  check('the client answer is what the model reads (no headless auto-deny note)', row !== undefined && row.is_error === true && !OPERATOR_LINE.test(row.text) && !RECIPE_LINE.test(row.text), row?.text.slice(0, 300))
  check('the posture line names the host', /with a host that holds the asks/.test(run.system) && !/no host to answer/.test(run.system), run.system.match(/- Session:[^\n]{0,200}/)?.[0] ?? 'no posture line')
  check('the guidance keeps the AskUserQuestion hint (a client can answer)', /use AskUserQuestion to ask rather than guessing/.test(run.system))
}

console.log(failures === 0 ? '\nprove-headless-ask-refusals: ALL LAWS HOLD' : `\nprove-headless-ask-refusals: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
