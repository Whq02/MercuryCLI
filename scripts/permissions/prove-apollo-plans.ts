#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const distAt = argv.indexOf('--dist')
const DIST = resolve(distAt >= 0 ? argv[distAt + 1]! : join(import.meta.dir, '../../dist/mercury.mjs'))
if (!existsSync(DIST)) {
  console.error(`FAIL the bundle exists: ${DIST}`)
  process.exit(1)
}

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'apollo-plans-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'fixture-key-apollo-plans'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi(Array.from({ length: 16 }, () => ({ kind: 'text' as const, text: 'The run answered.' })))
const KEY = 'fixture-key-apollo-plans'
const env = {
  HOME,
  PATH: process.env.PATH,
  MERCURY_CONFIG_DIR: HOME,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_DAEMON_DIR: join(HOME, 'daemon'),
  ANTHROPIC_BASE_URL: api.url,
  ANTHROPIC_API_KEY: KEY,
  TMPDIR: tmpdir(),
}
writeFileSync(
  join(HOME, '.config.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    theme: 'dark',
    customApiKeyResponses: { approved: [KEY.slice(-20)] },
    projects: { [HOME]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }),
)

type Run = { code: number | null; out: string; err: string }
async function run(args: string[]): Promise<Run> {
  const child = spawn('node', [DIST, ...args], { cwd: HOME, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { err += d })
  child.stdin.end()
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  return await new Promise(r => child.on('close', code => { clearTimeout(timer); r({ code, out, err }) }))
}
const sameAnswer = (control: Run, probe: Run, controlWord: string, probeWord: string): boolean =>
  probe.code === control.code &&
  probe.out === control.out.replaceAll(controlWord, probeWord) &&
  probe.err === control.err.replaceAll(controlWord, probeWord)

section('§1 the command roster: an unregistered planning word answers as any unknown name')
{
  const control = await run(['run', '/frobnicate'])
  check('control: the headless door answers an unregistered name with its unknown-name sentence', control.code === 0 && /frobnicate/.test(control.out + control.err), JSON.stringify(control))
  for (const word of ['strategy', 'plan']) {
    const probe = await run(['run', `/${word}`])
    check(`/${word} answers exactly as /frobnicate does (same words, same exit code)`, sameAnswer(control, probe, 'frobnicate', word), JSON.stringify({ control, probe }))
  }
  check('the probes made no model request', api.messageRequests().length === 0, String(api.messageRequests().length))

  const { builtinCommands } = await import('../../src/commands.ts')
  const { resolveUnknownSlashName } = await import('../../src/utils/processUserInput/processSlashCommand.tsx')
  type Named = { name: string; aliases?: string[] }
  const roster = builtinCommands() as unknown as Named[]
  const names = new Set(roster.flatMap(c => [c.name, ...(c.aliases ?? [])]))
  check('the roster registers no planning command under either word', !names.has('strategy') && !names.has('plan'), [...names].filter(n => /strateg|^plan$/.test(n)).join(','))
  check('the unknown-name resolver resolves both words (the screen will answer "Unknown command")', resolveUnknownSlashName('/strategy', roster as never) === 'strategy' && resolveUnknownSlashName('/plan', roster as never) === 'plan')
  check('control: a registered name never resolves as unknown', resolveUnknownSlashName('/help', roster as never) === undefined)
}

section('§2 the tool roster: the planning tools the model is offered are Apollo\'s alone')
{
  const before = api.messageRequests().length
  const run2 = await run(['run', 'hello'])
  check('control: a plain run reaches the fixture provider once', run2.code === 0 && api.messageRequests().length === before + 1, JSON.stringify(run2))
  const request = api.messageRequests()[before] as { body?: { tools?: Array<{ name: string }> } } | undefined
  const offered = (request?.body?.tools ?? []).map(t => t.name)
  check('the wire carries a tool roster', offered.length > 5, offered.join(','))
  const planning = offered.filter(name => /Strategy|PlanMode/.test(name))
  check('no tool on the wire enters or exits a planning mode', planning.length === 0, planning.join(','))
  check('the Apollo review stays the one mode-moving tool the roster declares', offered.includes('ApolloReview'), offered.join(','))

  const { getAllBaseTools } = await import('../../src/tools.ts')
  const names = getAllBaseTools().map(t => t.name)
  check('the base tool registry agrees', !names.some(name => /Strategy|PlanMode/.test(name)) && names.includes('ApolloReview'), names.filter(name => /Strategy|PlanMode|Apollo/.test(name)).join(','))
}

section('§3 the crew wire: a crewmate spawns in the ordinary posture and no message approves a plan')
{
  const request = api.messageRequests().at(-1) as { body?: { tools?: Array<{ name: string; input_schema?: { properties?: Record<string, unknown> } }> } } | undefined
  const tools = request?.body?.tools ?? []
  const agent = tools.find(t => t.name === 'Agent')
  check('the Agent tool rides the wire', agent !== undefined, tools.map(t => t.name).join(','))
  const agentProps = Object.keys(agent?.input_schema?.properties ?? {})
  check('the Agent tool offers no permission posture for a spawned crewmate', !agentProps.includes('mode') && !agentProps.includes('plan_mode_required'), agentProps.join(','))
  const sendMessage = tools.find(t => t.name === 'SendMessage')
  check('the SendMessage tool rides the wire', sendMessage !== undefined)
  check('no SendMessage variant approves or rejects a plan', !JSON.stringify(sendMessage?.input_schema ?? {}).includes('plan_approval'))

  const live = await import('../../src/services/crew/liveMessages.ts')
  check('the live-message protocol recognises no plan-approval kind', !live.isStructuredProtocolMessage(JSON.stringify({ type: 'plan_approval_request', from: 'a', timestamp: 't', planFilePath: 'p', planContent: 'c', requestId: 'r' })) && !live.isStructuredProtocolMessage(JSON.stringify({ type: 'plan_approval_response', requestId: 'r', approved: true, timestamp: 't' })))
  check('control: a shutdown request is still a protocol message', live.isStructuredProtocolMessage(JSON.stringify({ type: 'shutdown_request', from: 'a', requestId: 'r', timestamp: 't' })))
}

await api.close?.()
rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ apollo-plans: ${failures} FAILED`)
  process.exit(1)
}
console.log('✅ apollo-plans: all checks pass')
