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

}

section('§4 the mode word: --mode strategy is an unknown value, the lists and schemas carry Apollo as the planning mode')
{
  const control = await run(['run', '--mode', 'frobnicate', 'hello'])
  check('control: an unknown --mode value is the parser\'s own error on stderr, exit 2', control.code === 2 && control.out === '' && control.err.startsWith("error: option '--mode <mode>' argument 'frobnicate' is invalid."), JSON.stringify(control))
  const probe = await run(['run', '--mode', 'strategy', 'hello'])
  check('--mode strategy answers exactly as --mode frobnicate does', sameAnswer(control, probe, 'frobnicate', 'strategy'), JSON.stringify({ control, probe }))
  check('the allowed-choices list the parser prints names apollo and no other planning station', /Allowed choices are [^\n]*\bapollo\b/.test(control.err) && !/strateg/.test(control.err), control.err)

  const vocab = await import('../../src/types/permissions.ts')
  const pm = await import('../../src/utils/permissions/PermissionMode.ts')
  const lists = [...vocab.PERMISSION_MODES, ...vocab.EXTERNAL_PERMISSION_MODES, ...vocab.INTERNAL_PERMISSION_MODES]
  check('no mode list carries a planning station other than apollo', lists.includes('apollo') && !lists.some(m => /strateg/.test(m)), lists.join(','))
  check('the carousel never reaches a planning stop other than apollo from any mode', (vocab.PERMISSION_MODES as readonly string[]).every(mode => {
    const { getNextPermissionMode } = require('../../src/utils/permissions/getNextPermissionMode.ts') as typeof import('../../src/utils/permissions/getNextPermissionMode.ts')
    for (const bypass of [false, true]) {
      const next = getNextPermissionMode({ mode, isBypassPermissionsModeAvailable: bypass, isFlowAvailable: false } as never)
      if (/strateg/.test(next)) return false
    }
    return true
  }))
  check('an unknown stored mode word resolves to the default mode', pm.permissionModeFromString('strategy') === 'default' && pm.permissionModeFromString('frobnicate') === 'default')
  check('the external permission-mode schema refuses the word as it refuses any unknown word', !pm.externalPermissionModeSchema().safeParse('strategy').success && !pm.externalPermissionModeSchema().safeParse('frobnicate').success && pm.externalPermissionModeSchema().safeParse('implement').success)
  const headless = await import('../../src/daemon/headlessRun.ts')
  check('the daemon child postures carry no planning station', !(headless.HEADLESS_PERMISSION_MODES as readonly string[]).some(m => /strateg/.test(m)))
}

section('§5 a saved chat that was in a mode this build does not know opens in default')
{
  const recovery = await import('../../src/utils/conversationRecovery.ts')
  const row = (mode: string) => ({ type: 'user', uuid: '11111111-1111-4111-8111-111111111111', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'saved prompt' }, permissionMode: mode }) as never
  const userRow = (rows: unknown[]): { permissionMode?: string } | undefined => (rows as Array<{ type: string; permissionMode?: string }>).find(r => r.type === 'user')
  const restored = userRow(recovery.deserializeMessages([row('strategy')]))
  check('the stored mode word is not carried into the resumed session (it reads as default)', restored !== undefined && restored.permissionMode === undefined, JSON.stringify(restored))
  const kept = userRow(recovery.deserializeMessages([row('implement')]))
  check('control: a mode this build knows is kept', kept?.permissionMode === 'implement')
}

await api.close?.()
rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ apollo-plans: ${failures} FAILED`)
  process.exit(1)
}
console.log('✅ apollo-plans: all checks pass')
