#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const childHome = process.argv[2] === '--scratch-home' ? process.argv[3] : undefined
const WORLD = childHome !== undefined ? dirname(childHome) : realpathSync(mkdtempSync(join(process.env.MERCURY_TMPDIR ?? tmpdir(), 'workflow-removed-')))
const OS_HOME = childHome ?? join(WORLD, 'os-home')
if (childHome === undefined) {
  mkdirSync(OS_HOME, { recursive: true })
  let status = 1
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--scratch-home', OS_HOME], { env: { ...process.env, HOME: OS_HOME, USERPROFILE: OS_HOME }, stdio: 'inherit' })
    status = child.status ?? 1
  } finally {
    rmSync(WORLD, { recursive: true, force: true })
  }
  process.exit(status)
}
if (realpathSync(homedir()) !== realpathSync(OS_HOME)) throw new Error('this proof reads the product under a scratch home, and os.homedir() is not that folder')

const CFG = join(OS_HOME, '.mercury')
const PROJECT = join(WORLD, 'project')
mkdirSync(join(CFG, 'tmp'), { recursive: true })
mkdirSync(PROJECT, { recursive: true })
writeFileSync(join(PROJECT, 'README.md'), '# a project that used workflows\n')
for (const name of ['MERCURY_HOME', 'MERCURY_WORKFLOWS', 'MERCURY_SESSION_WORKFLOWS']) delete process.env[name]
process.env.MERCURY_CONFIG_DIR = CFG
process.env.MERCURY_TMPDIR = join(CFG, 'tmp')
process.env.MERCURY_DAEMON_DIR = join(OS_HOME, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.length > 700 ? `${detail.slice(0, 700)}…` : detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the removal proof exceeded 420s')
  process.exit(1)
}, 420_000)
watchdog.unref?.()

const TOOL = 'Workflow'
const COMMAND = 'workflows'
const FLAGS = ['MERCURY_WORKFLOWS', 'MERCURY_SESSION_WORKFLOWS'] as const
const flagsAt = (value: string): Record<string, string> => Object.fromEntries(FLAGS.map(name => [name, value]))
const SETTINGS: Array<[string, Record<string, string>]> = [['neither flag set', {}], ['both flags set to 1', flagsAt('1')], ['both flags set to 0', flagsAt('0')]]

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
bootstrap.setOriginalCwd(PROJECT)
bootstrap.setCwdState(PROJECT)
process.chdir(PROJECT)
const { getAllBaseTools } = await import('../../src/tools.ts')
const { ALL_AGENT_DISALLOWED_TOOLS } = await import('../../src/constants/tools.ts')
const { getCommands, builtinCommands } = await import('../../src/commands.ts')
const { unknownCommandLine } = await import('../../src/utils/processUserInput/processSlashCommand.tsx')
const { parseSettingsFile } = await import('../../src/utils/settings/settings.ts')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { distBuildInputs } = await import('../lib/distProvenance.ts')

type Named = { name: string; aliases?: readonly string[] }
const names = (list: readonly Named[], word: string): boolean => list.some(item => item.name === word || (item.aliases ?? []).includes(word))

section('§1 the catalogue: no tool of that name, with either flag at any value')
{
  check('the base roster every road draws from holds no Workflow tool', !names(getAllBaseTools() as readonly Named[], TOOL), (getAllBaseTools() as readonly Named[]).map(tool => tool.name).join(', '))
  for (const value of ['1', '0']) {
    for (const name of FLAGS) process.env[name] = value
    check(`…and none with both flags set to ${value}`, !names(getAllBaseTools() as readonly Named[], TOOL))
    for (const name of FLAGS) delete process.env[name]
  }
  check("a crewmate's barred list names no tool the catalogue does not have", !ALL_AGENT_DISALLOWED_TOOLS.has(TOOL), [...ALL_AGENT_DISALLOWED_TOOLS].join(', '))
}

section('§2 the command: /workflows is a name Mercury does not have')
const commands = await getCommands(PROJECT)
const ordinary = unknownCommandLine('zzznothing', commands).replace('zzznothing', COMMAND)
{
  check('no command of the session is named or aliased workflows', !names(commands as readonly Named[], COMMAND))
  check('…and none of the built-in set', !names([...builtinCommands()] as readonly Named[], COMMAND))
  check(`typed by habit it reads the sentence any unknown name reads — "${ordinary}"`, unknownCommandLine(COMMAND, commands) === ordinary && ordinary.startsWith(`Unknown command: /${COMMAND}`), unknownCommandLine(COMMAND, commands))
}

section('§3 a managed policy that carries disableWorkflows is still read')
{
  const policy = join(WORLD, 'managed-settings.json')
  writeFileSync(policy, JSON.stringify({ disableWorkflows: true, guardrails: { deny: ['Bash(rm *)'] } }))
  const read = parseSettingsFile(policy) as { settings: { guardrails?: { deny?: string[] } } | null; errors: Array<{ severity?: string; unknownKeys?: string[]; message: string }> }
  check('its other keys are in force', read.settings?.guardrails?.deny?.[0] === 'Bash(rm *)', JSON.stringify(read.settings))
  check('the key reads as any key the schema does not know: one warning line that names it, no error', read.errors.length === 1 && read.errors[0]!.severity === 'warning' && JSON.stringify(read.errors[0]!.unknownKeys) === JSON.stringify(['disableWorkflows']), JSON.stringify(read.errors))
}

const vendored = join(dirname(DIST), 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(vendored) ? vendored : (Bun.which('node') ?? 'node')
type Captured = { body: { tools?: Array<{ name?: string }>; messages?: Array<{ role: string; content: unknown }> } }
type Run = { code: number | null; out: string; err: string; requests: Captured[] }
type Script = Parameters<typeof startFixtureApi>[0]
async function run(args: string[], script: Script, extra: Record<string, string> = {}): Promise<Run> {
  const fixture = await startFixtureApi(script)
  const env = { PATH: `/usr/bin:/bin:${dirname(NODE)}`, HOME: OS_HOME, USERPROFILE: OS_HOME, TERM: 'dumb', MERCURY_CONFIG_DIR: CFG, MERCURY_TMPDIR: join(CFG, 'tmp'), MERCURY_DAEMON_DIR: join(OS_HOME, 'daemon'), MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_CREDENTIAL_STORE: 'file', ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: fixture.url, ...extra }
  const child = spawn(NODE, [DIST, 'run', '--model', 'claude-opus-4-8', '--format', 'json', ...args], { cwd: PROJECT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', chunk => { out += String(chunk) })
  child.stderr.on('data', chunk => { err += String(chunk) })
  const code = await new Promise<number | null>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.on('close', status => { clearTimeout(timer); resolve(status) })
  })
  const requests = fixture.messageRequests() as Captured[]
  await fixture.close()
  return { code, out, err, requests }
}
type Outcome = { status?: string; answer?: string; error?: { message?: string; class?: string } }
const outcomeOf = (out: string): Outcome => {
  for (const line of out.split('\n').reverse()) {
    try {
      const row = JSON.parse(line) as Outcome & { type?: string }
      if (row.type === 'outcome') return row
    } catch {
    }
  }
  return {}
}
const toolNames = (request: Captured | undefined): string[] => (request?.body.tools ?? []).map(tool => String(tool.name))
async function served(extra: Record<string, string>): Promise<string[] | null> {
  const env = { PATH: `/usr/bin:/bin:${dirname(NODE)}`, HOME: OS_HOME, USERPROFILE: OS_HOME, TERM: 'dumb', MERCURY_CONFIG_DIR: CFG, MERCURY_TMPDIR: join(CFG, 'tmp'), MERCURY_DAEMON_DIR: join(OS_HOME, 'daemon'), MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_CREDENTIAL_STORE: 'file', ...extra }
  const child = spawn(NODE, [DIST, 'mcp', 'serve'], { cwd: PROJECT, env, stdio: ['pipe', 'pipe', 'ignore'] })
  let buffer = ''
  let tools: string[] | null = null
  child.stdout.on('data', chunk => {
    buffer += String(chunk)
    for (const line of buffer.split('\n').slice(0, -1)) {
      try {
        const parsed = JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name?: string }> } }
        if (parsed.id === 2 && parsed.result?.tools) tools = parsed.result.tools.map(tool => String(tool.name))
      } catch {
      }
    }
  })
  const send = (message: unknown): void => void child.stdin.write(`${JSON.stringify(message)}\n`)
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'proof', version: '0' } } })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && tools === null) await new Promise(resolve => setTimeout(resolve, 100))
  child.kill()
  return tools
}

const SESSION = 'c0ffee00-0000-4000-8000-0000000f10e5'
const RUN_ID = 'wf_0f10e5aa-001'
const TASK_ID = `local_workflow_${RUN_ID}`
const USER_FLOW = "export const meta = { name: 'user-flow', description: 'a user workflow with one crewmate', phases: [{ title: 'Ask' }] }\nphase('Ask')\nconst word = await agent('Say the word ready and nothing else.', { label: 'asker' })\nreturn { word }\n"
const PROJECT_FLOW = "export const meta = { name: 'project-flow', description: 'a project workflow with two crewmates', phases: [{ title: 'Pair' }] }\nphase('Pair')\nconst words = await parallel([() => agent('Say left.'), () => agent('Say right.')])\nreturn { words, args }\n"
function seedUsedHome(): string[] {
  seedFirstRun(CFG, [PROJECT])
  const store = getProjectDir(PROJECT)
  const runDir = join(store, 'workflows', 'runs', RUN_ID)
  const agentDir = join(store, SESSION, 'subagents', 'workflows', RUN_ID)
  const files: Array<[string, string]> = [
    [join(CFG, 'workflows', 'user-flow.js'), USER_FLOW],
    [join(PROJECT, '.mercury', 'workflows', 'project-flow.js'), PROJECT_FLOW],
    [join(PROJECT, '.mercury', 'settings.local.json'), `${JSON.stringify({ guardrails: { allow: ['Workflow(user-flow)'], ask: ['Workflow(project-flow)'], deny: ['Workflow(danger-flow)'] } }, null, 2)}\n`],
    [join(runDir, 'workflow.js'), USER_FLOW],
    [join(runDir, 'args.json'), '{"why":"the reading"}\n'],
    [join(runDir, 'claim.json'), `${JSON.stringify({ runId: RUN_ID, sessionId: SESSION, pid: 4242, claimedAt: '2026-06-19T12:00:02.000Z' })}\n`],
    [join(runDir, 'journal.jsonl'), `${JSON.stringify({ type: 'workflow_phase', index: 0, title: 'Ask' })}\n${JSON.stringify({ type: 'workflow_agent', index: 0, label: 'asker', state: 'done', agentId: 'a0f10e5aa01' })}\n`],
    [join(runDir, 'run.json'), `${JSON.stringify({ runId: RUN_ID, sessionId: SESSION, workflowName: 'user-flow', status: 'completed', startedAt: '2026-06-19T12:00:02.000Z', endedAt: '2026-06-19T12:00:09.000Z', phases: [{ title: 'Ask' }], agents: [{ index: 0, label: 'asker', state: 'done', agentId: 'a0f10e5aa01' }], result: { word: 'ready' } }, null, 2)}\n`],
    [join(agentDir, 'agent-a0f10e5aa01.jsonl'), encodeSeedTranscript([{ isSidechain: true, agentId: 'a0f10e5aa01', entrypoint: 'cli', cwd: PROJECT, sessionId: SESSION, version: '1.0.10', gitBranch: 'main', parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-0000000000a1', message: { role: 'user', content: 'Say the word ready and nothing else.' }, timestamp: '2026-06-19T12:00:03.000Z' }], SESSION)],
    [join(agentDir, 'agent-a0f10e5aa01.meta.json'), `${JSON.stringify({ agentType: 'mercury-crew', description: 'asker' })}\n`],
  ]
  const row = (extra: Record<string, unknown>): Record<string, unknown> => ({ isSidechain: false, entrypoint: 'cli', cwd: PROJECT, sessionId: SESSION, version: '1.0.10', gitBranch: 'main', ...extra })
  const notice = `<task-notification>\n<task-id>${TASK_ID}</task-id>\n<status>completed</status>\n<summary>Workflow "user-flow" completed</summary>\n<result>{"word":"ready"}</result>\n</task-notification>`
  files.push([join(store, `${SESSION}.jsonl`), encodeSeedTranscript([
    row({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001', message: { role: 'user', content: 'run the user workflow' }, timestamp: '2026-06-19T12:00:01.000Z' }),
    row({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'assistant', uuid: '00000000-0000-4000-8000-000000000002', requestId: 'req_stored_1', message: { id: 'msg_stored_1', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', id: 'toolu_stored_wf1', name: TOOL, input: { name: 'user-flow' } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, timestamp: '2026-06-19T12:00:02.000Z' }),
    row({ parentUuid: '00000000-0000-4000-8000-000000000002', type: 'user', uuid: '00000000-0000-4000-8000-000000000003', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_stored_wf1', content: [{ type: 'text', text: `Workflow launched in background. Task ID: ${TASK_ID}` }] }] }, toolUseResult: { status: 'async_launched', taskId: TASK_ID, taskType: 'local_workflow', workflowName: 'user-flow', runId: RUN_ID, summary: 'a user workflow with one crewmate' }, timestamp: '2026-06-19T12:00:03.000Z' }),
    row({ parentUuid: '00000000-0000-4000-8000-000000000003', type: 'assistant', uuid: '00000000-0000-4000-8000-000000000004', requestId: 'req_stored_2', message: { id: 'msg_stored_2', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Launched.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, timestamp: '2026-06-19T12:00:04.000Z' }),
    row({ parentUuid: '00000000-0000-4000-8000-000000000004', type: 'user', uuid: '00000000-0000-4000-8000-000000000005', message: { role: 'user', content: notice }, timestamp: '2026-06-19T12:00:09.000Z' }),
    row({ parentUuid: '00000000-0000-4000-8000-000000000005', type: 'assistant', uuid: '00000000-0000-4000-8000-000000000006', requestId: 'req_stored_3', message: { id: 'msg_stored_3', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'The workflow finished.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, timestamp: '2026-06-19T12:00:10.000Z' }),
  ], SESSION)])
  for (const [path, text] of files) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  return files.map(([path]) => path)
}
const digest = (path: string): string => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'gone')

if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the gate prebuilds it)', false, DIST)
} else {
  const bundle = distBuildInputs(ROOT)
  console.log(`\nBUNDLE ${bundle.line}`)
  if (bundle.stale && process.env.MERCURY_GATE_PREBUILT !== '1' && process.env.MERCURY_STALE_DIST_OK !== '1') {
    check('the bundle is the tree under proof (rebuild, or set MERCURY_STALE_DIST_OK=1 to read an older bundle on purpose)', false, bundle.line)
  } else {
    const estate = seedUsedHome()
    const before = new Map(estate.map(path => [path, digest(path)]))
    const session = join(getProjectDir(PROJECT), `${SESSION}.jsonl`)
    const stored = readFileSync(session, 'utf8')
    const moved = (): string[] => estate.filter(path => path !== session && digest(path) !== before.get(path)).map(path => path.replace(WORLD, ''))

    section('§4 the roads of the built product: a home that used workflows starts clean, and no tool list holds the tool')
    let plain: string[] | null = null
    let list: string[] | null = null
    for (const [label, flags] of SETTINGS) {
      const turn = await run(['say ready'], [{ kind: 'text', text: 'Ready.' }], flags)
      const tools = toolNames(turn.requests[0])
      check(`${label}: mercury run answers and ends 0, with nothing on stderr`, turn.code === 0 && outcomeOf(turn.out).status === 'completed' && outcomeOf(turn.out).answer === 'Ready.' && turn.err === '', `exit ${turn.code} · ${turn.out.slice(0, 300)} · stderr ${turn.err.slice(0, 300)}`)
      check(`${label}: its request offers tools, and none is the Workflow tool`, tools.length > 0 && !tools.includes(TOOL), tools.join(', '))
      plain ??= tools
      check(`${label}: the tools offered are the ones offered with neither flag set`, JSON.stringify(tools) === JSON.stringify(plain))
      check(`${label}: the run says nothing of workflows`, !/workflow/i.test(turn.out) && !/workflow/i.test(turn.err), `${turn.out.slice(0, 300)} ${turn.err.slice(0, 300)}`)
      const offered = await served(flags)
      check(`${label}: mcp serve lists tools, and none is the Workflow tool`, offered !== null && offered.length > 0 && !offered.includes(TOOL), offered === null ? 'no list' : offered.join(', '))
      list ??= offered
      check(`${label}: its list is the one served with neither flag set`, JSON.stringify(offered) === JSON.stringify(list))
      check(`${label}: every workflow script, run file and rule of the home is byte for byte as it was`, moved().length === 0, moved().join(', '))
    }

    section('§5 the built product answers /workflows as a command it does not have')
    for (const typed of [`/${COMMAND}`, `/${COMMAND} on`]) {
      const turn = await run([typed], [{ kind: 'text', text: 'Unreached.' }])
      const outcome = outcomeOf(turn.out)
      check(`"${typed}": refused as a command, in the ordinary sentence, with no request sent`, outcome.status === 'refused' && outcome.error?.class === 'command' && outcome.error.message === ordinary && turn.requests.length === 0, `${turn.out.slice(0, 300)} · ${turn.requests.length} request(s)`)
    }

    section('§6 a stored session whose record holds a Workflow call and a workflow task resumes and goes on')
    {
      const turn = await run(['--resume', SESSION, 'say that you are resumed'], [{ kind: 'text', text: 'Resumed.' }])
      check('it resumes: the answer lands and the run ends 0, with nothing on stderr', turn.code === 0 && outcomeOf(turn.out).answer === 'Resumed.' && turn.err === '', `exit ${turn.code} · ${turn.out.slice(0, 300)} · stderr ${turn.err.slice(0, 300)}`)
      const sent = JSON.stringify(turn.requests[0]?.body.messages ?? [])
      check('the stored call and its result ride the request as they were stored', sent.includes('"toolu_stored_wf1"') && sent.includes(`"name":"${TOOL}"`) && sent.includes(`Workflow launched in background. Task ID: ${TASK_ID}`), sent.slice(0, 400))
      check("the stored task's notice rides it too", sent.includes(`<task-id>${TASK_ID}</task-id>`))
      check('the record keeps every stored row and grows by the new turn', readFileSync(session, 'utf8').startsWith(stored) && readFileSync(session, 'utf8').length > stored.length)
      console.log(`  the resumed request's tool list holds a Workflow definition: ${toolNames(turn.requests[0]).includes(TOOL)}`)
    }
    {
      const turn = await run(['--resume', SESSION, 'run it again'], [{ kind: 'tool_use', preText: 'Calling it.\n', name: TOOL, input: { name: 'user-flow' } }, { kind: 'text', text: 'Went on.' }])
      const last = (turn.requests[1]?.body.messages ?? []).at(-1)
      const results = (Array.isArray(last?.content) ? (last!.content as Array<{ type?: string; is_error?: boolean; content?: unknown }>) : []).filter(block => block.type === 'tool_result')
      const said = JSON.stringify(results[0]?.content ?? '')
      check('a Workflow call the model makes there is answered as a tool the session does not have', results.length === 1 && results[0]!.is_error === true && said.includes(`No such tool available: ${TOOL}`), said.slice(0, 400))
      check('…and the turn goes on to its answer, ending 0', turn.code === 0 && outcomeOf(turn.out).answer === 'Went on.', `exit ${turn.code} · ${turn.out.slice(0, 300)}`)
      check('…with the home\'s workflow files still byte for byte as they were', moved().length === 0, moved().join(', '))
    }
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} workflow-removed: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
