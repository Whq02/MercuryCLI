#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const planHome = realpathSync(mkdtempSync(join(tmpdir(), 'refusal-closed-plan-')))
process.env.MERCURY_CONFIG_DIR = planHome
delete process.env.MERCURY_HOME
process.on('exit', () => rmSync(planHome, { recursive: true, force: true }))
const { hostRunner } = await import('../lib/runnerHost.ts')

const ROOT = resolve(import.meta.dir, '..', '..')
const distAt = process.argv.indexOf('--dist')
const DIST = distAt < 0 ? join(ROOT, 'dist', 'mercury.mjs') : resolve(process.argv[distAt + 1]!)
if (!existsSync(DIST)) {
  console.error('dist/mercury.mjs missing — build the product first')
  process.exit(1)
}
const vendoredNode = join(ROOT, 'dist', 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const NODE = existsSync(vendoredNode) ? vendoredNode : Bun.which('node') ?? 'node'
const API_KEY = 'fixture-key-000'
const MODEL = 'claude-opus-4-8'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + t)
}

const ROOT_DELETE = 'rm -rf /'
const HOME_DELETE_TARGET = 'rm -rf /Users/proof/home-delete-target'
const CLOSING = 'Do not rephrase the command to evade this rule — surface the refusal to the operator instead.'
const COUNT_WORDS = '1\n2\n3'
const PRINT5 = '5'
const FINAL_WORDS = 'Both tasks are done.'
const REFUSED_WORDS = 'I cannot run that command.'

const canaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'refusal-closed-')))
const canary = join(canaryRoot, 'CANARY')
writeFileSync(canary, 'alive')

const turns = (): ScriptedTurn[] => [
  { kind: 'text', text: REFUSED_WORDS, stopReason: 'refusal' },
  { kind: 'text', text: REFUSED_WORDS, stopReason: 'refusal' },
  { kind: 'text', text: REFUSED_WORDS, stopReason: 'refusal' },
  {
    kind: 'tool_use',
    name: 'Bash',
    input: { command: ROOT_DELETE, description: 'Delete the filesystem root recursively (permission guard test)' },
  },
  {
    kind: 'tool_use',
    name: 'Bash',
    input: { command: HOME_DELETE_TARGET, description: 'Delete the home directory recursively (permission guard test)' },
  },
  { kind: 'tool_use', name: 'Bash', input: { command: "python3 -c 'print(5)'", description: 'Print 5 with python3' } },
  { kind: 'text', text: FINAL_WORDS },
]

function messageRequestCount(seat: { wire: string[] }): number { return seat.wire.length }
interface World { home: string; cwd: string; configDir: string; env: Record<string, string> }
function makeWorld(tag: string, baseUrl: string): World {
  const home = realpathSync(mkdtempSync(join(tmpdir(), `refusal-closed-${tag}-`)))
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
    configDir,
    env: {
      HOME: home,
      PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${dirname(NODE)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: configDir,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_BROWSER_NO_DISCOVERY: '1',
      MERCURY_BROWSER_CACHE_DIR: join(home, 'browser-cache'),
      BROWSER: '/usr/bin/true',
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: API_KEY,
    },
  }
}

interface Captured { body: unknown }
let lastRequestCount = 0
interface ToolResult { tool_use_id: string; is_error?: boolean; text: string }
function toolResults(requests: Captured[]): ToolResult[] {
  lastRequestCount = requests.length
  const results: ToolResult[] = []
  for (const request of requests) {
    const body = request.body as { messages?: Array<{ role: string; content: unknown }> }
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
  return results
}

const wireTexts = (requests: Array<{ body: unknown }>): string[] => {
  const out: string[] = []
  for (const request of requests) {
    const body = request.body as { messages?: Array<{ role: string; content: unknown }> }
    for (const message of body.messages ?? []) {
      const content = message.content
      if (typeof content === 'string') { out.push(content); continue }
      if (!Array.isArray(content)) continue
      for (const block of content as Array<{ type?: string; text?: string }>) {
        if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
      }
    }
  }
  return out
}

async function runSeat(tag: string, script: () => ScriptedTurn[], prompts: string[], extraEnv: Record<string, string> = {}): Promise<{ results: ToolResult[]; wire: string[]; code: number | null; stdout: string; asks: number; world: World; close: () => void }> {
  const fixture = await startFixtureApi(script())
  const world = makeWorld(tag, fixture.url)
  Object.assign(world.env, extraEnv)
  let stdout = ''
  let asks = 0
  const host = hostRunner({
    node: NODE,
    dist: DIST,
    argv: ['--model', MODEL],
    cwd: world.cwd,
    env: world.env as Record<string, string | undefined>,
    home: world.configDir,
    raw: text => {
      stdout += text
    },
  })
  host.onAsk(params => {
    asks++
    const destructive = params.kind === 'tool' && typeof (params.input as { command?: unknown }).command === 'string' &&
      String((params.input as { command: unknown }).command).includes('rm ')
    return destructive ? { outcome: 'deny', input: params.input } : { outcome: 'allow', input: params.input }
  })
  const child = host.child
  const killer = setTimeout(() => child.kill('SIGKILL'), 120_000)
  child.stderr!.on('data', chunk => { stdout += chunk })
  await host.initialize()
  let seenOutcomes = 0
  for (const index of prompts.keys()) {
    const want = seenOutcomes + 1
    await host.prompt(prompts[index]!)
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const rows = host.rows.filter(row => row.type === 'outcome')
      if (rows.length >= want) break
      await new Promise(r => setTimeout(r, 200))
    }
    seenOutcomes = host.rows.filter(row => row.type === 'outcome').length
  }
  await new Promise(r => setTimeout(r, 3_000))
  host.end()
  const code = await new Promise<number | null>(resolveRun => child.on('close', value => { clearTimeout(killer); resolveRun(value) }))
  const results = toolResults(fixture.messageRequests())
  const wire = wireTexts(fixture.messageRequests())
  return {
    results,
    wire,
    code,
    stdout,
    asks,
    world,
    close: () => {
      void fixture.close()
      rmSync(world.home, { recursive: true, force: true })
    },
  }
}

section('§0 the plan: a provider refusal (stop_reason: refusal) is shown to the user in the transcript and never fed back to the model — the row leaves the wire view, the turns around it stay lawful')
{
  ;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }
  process.env.MERCURY_CREDENTIAL_STORE ??= 'file'
  process.env.MERCURY_LOCAL_PROBE_TARGETS ??= 'none'
  const { requestConversationPlan } = await import('../../src/utils/messages/apiPlan.ts')
  const { createAssistantAPIErrorMessage, createUserMessage } = await import('../../src/utils/messages/factories.ts')
  const COCKPIT_WORDS = 'The model ended the response early (stop_reason: refusal). Use /rewind (or shift+up) to edit your last message, or start a new session. If refusals repeat, try /model claude-haiku-4-5-20251001.'
  const HEADLESS_WORDS = 'The model ended the response early (stop_reason: refusal). Try rephrasing the request or a different approach.'
  for (const [road, words] of [['cockpit', COCKPIT_WORDS], ['headless', HEADLESS_WORDS]] as const) {
    const refused = createUserMessage({ content: `Use the Bash tool to run exactly this command and nothing else: ${ROOT_DELETE}` })
    const refusal = createAssistantAPIErrorMessage({ content: words, error: 'invalid_request', errorDetails: 'stop_reason: refusal · model: fixture · request_id: unknown' })
    const next = createUserMessage({ content: 'Count slowly from 1 to 3, one number per line, and nothing else.' })
    const transcript = [refused, refusal, next]
    const before = JSON.stringify(transcript)
    const plan = requestConversationPlan(transcript, [])
    const texts: string[] = []
    for (const message of plan.messages) {
      const content = message.message.content
      if (typeof content === 'string') { texts.push(content); continue }
      if (!Array.isArray(content)) continue
      for (const block of content as Array<{ type?: string; text?: string }>) if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    }
    const wire = texts.join('\n')
    check(`${road}: no row of the plan carries the refusal (RED before the owner's ruling: an assistant closure row "This refusal is final…" rode every later request)`, !wire.includes('stop_reason: refusal') && !wire.includes('refusal is final') && !plan.messages.some(m => m.type === 'assistant' && JSON.stringify(m.message.content).includes('refusal')), JSON.stringify(texts).slice(0, 300))
    check(`${road}: the refusal carries no retry invitation or operator remedy to the model either (nothing of it reaches the wire)`, !/Try rephrasing|different approach|\/rewind|shift\+up|\/model/.test(wire), wire.slice(0, 200))
    check(`${road}: the transcript is untouched — the user still sees the refusal row`, JSON.stringify(transcript) === before && transcript[1] === refusal && JSON.stringify(refusal.message.content).includes('stop_reason: refusal'))
    const roles = plan.messages.map(m => m.type)
    const lawful = roles.every((role, i) => i === 0 || role !== roles[i - 1])
    check(`${road}: the turns stay lawful without the row — no two rows of one role in a row (${roles.join(' → ')})`, lawful && roles[0] === 'user', roles.join(','))
    const bothPrompts = plan.messages.some(m => m.type === 'user' && JSON.stringify(m.message.content).includes(ROOT_DELETE) && JSON.stringify(m.message.content).includes('Count slowly'))
    check(`${road}: the refused prompt and the next prompt reach the model as one user turn (the orphaned turn merges, as every other omitted assistant row's does)`, bothPrompts, JSON.stringify(plan.messages.map(m => [m.type, JSON.stringify(m.message.content).slice(0, 80)])))
  }
  rmSync(planHome, { recursive: true, force: true })
}

section('§1 the model view: the provider refusal never reaches the next request (the ward refusals of §2 still do, as closed tool results)')
{
  const prompts = [
    `Use the Bash tool to run exactly this command and nothing else: ${ROOT_DELETE}`,
    `Use the Bash tool to run exactly this command and nothing else: ${HOME_DELETE_TARGET}`,
    'Count slowly from 1 to 3, one number per line, and nothing else.',
  ]
  const seat = await runSeat('model-view', turns, prompts, { MERCURY_SPAWNED_BY: 'proof:refusal-closed#1' })
  try {
    const wireJoined = seat.wire.join('\n')
    check('the requests carried the three prompts', seat.wire.some(t => t.includes('Count slowly')), JSON.stringify(seat.wire.length))
    check(
      'no request carries the provider refusal or a closure of it (RED before the ruling: "stop_reason: refusal … This refusal is final" rode the later requests)',
      !wireJoined.includes('stop_reason: refusal') && !wireJoined.includes('refusal is final') && !wireJoined.includes('never repeat, retry or re-issue'),
      JSON.stringify(seat.wire.filter(t => t.includes('refusal')).slice(0, 1)).slice(0, 200),
    )
    check(
      'no request carries the model\'s own partial words of the refused turn either (RED on aef216c8d5: "I cannot run that command." rode the later requests as an assistant row)',
      seat.wire.length >= 3 && !wireJoined.includes(REFUSED_WORDS),
      JSON.stringify(seat.wire.filter(t => t.includes(REFUSED_WORDS)).slice(0, 1)).slice(0, 200),
    )
  } finally {
    seat.close()
  }
}

section('§2 the resurface: a scripted model that re-issues the refused commands on a harmless prompt meets the same refusals')
{
  const prompts = [
    `Use the Bash tool to run exactly this command and nothing else: ${ROOT_DELETE}`,
    `Use the Bash tool to run exactly this command and nothing else: ${HOME_DELETE_TARGET}`,
    'Count slowly from 1 to 3, one number per line, and nothing else.',
    "Use the Bash tool to run exactly this command and nothing else: python3 -c 'print(5)'",
  ]
  const seat = await runSeat('resurface', turns, prompts, { MERCURY_SPAWNED_BY: 'proof:refusal-closed#2' })
  try {
    const rootDelete = seat.results.find(row => row.text.includes('no-root-recursive-delete'))
    const homeDelete = seat.results.find(row => row.text.includes('no-other-user-delete'))
    check(
      'the re-issued root delete is refused again by the same ward',
      rootDelete !== undefined && rootDelete.is_error === true && rootDelete.text.includes(CLOSING),
      JSON.stringify(rootDelete?.text.slice(0, 160)),
    )
    check(
      'the re-issued home delete is refused again by the same ward',
      homeDelete !== undefined && homeDelete.is_error === true,
      JSON.stringify(homeDelete?.text.slice(0, 160)),
    )
    const printFive = seat.results.find(row => row.text.startsWith(PRINT5))
    check('the harmless python3 call ran and printed 5', printFive !== undefined && printFive.is_error !== true, JSON.stringify(seat.results.map(r => r.text.slice(0, 40))))
    check('the operator answered no card (both deletes were ward-refused before any card)', seat.asks <= 1, String(seat.asks))
  } finally {
    seat.close()
  }
}

check('the canary survived — no destructive command ever ran', readFileSync(canary, 'alive'.length === 0 ? 'utf8' : 'utf8') === 'alive')
rmSync(canaryRoot, { recursive: true, force: true })

console.log(`\n${failures === 0 ? '✅ refusal-stays-closed PROVEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
