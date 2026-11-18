#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { nodeBinPath } from '../lib/nodeBin.ts'
import { hostRunner } from '../lib/runnerHost.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const distAt = process.argv.indexOf('--dist')
const DIST = distAt === -1 ? join(ROOT, 'dist', 'mercury.mjs') : resolve(process.argv[distAt + 1]!)
const KEEP = process.argv.includes('--keep')
const MODEL = 'claude-opus-4-8'
const ASK = 'profile-environment-probe'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const COMMAND = [
  'echo "path=$PATH"',
  'echo "export=${LOGIN_EXPORT:-unset}"',
  'echo "zshenv=${FROM_ZSHENV:-unset}"',
  'echo "shell=${BASH_VERSION:+bash}${ZSH_VERSION:+zsh}"',
  'login-only-tool',
  'from_bashrc_alias',
  'from_bashrc_fn',
  'from_profile_fn',
  'if type from_zshrc_alias > /dev/null 2>&1; then echo zsh-alias=carried; else echo zsh-alias=absent; fi',
  'if type from_zshrc_fn > /dev/null 2>&1; then echo zsh-fn=carried; else echo zsh-fn=absent; fi',
].join('\n')

const TURNS: ScriptedTurn[] = [
  { kind: 'tool_use', name: 'Bash', id: 'toolu_profile_probe', input: { command: COMMAND, description: 'what a command sees of the login shell' } },
  { kind: 'text', text: 'profile probe done' },
]

type World = { root: string; cwd: string; launchPath: string; exported: string; env: Record<string, string> }

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'profile-environment-')))
const INHERITED = /^(?:TMPDIR|NODE_COMPILE_CACHE|MERCURY_UPDATE_API_BASE_URL|MERCURY_[A-Z0-9_]+_BASE)$/

function world(name: string, api: FixtureApi): World {
  const root = join(scratch, name)
  const userHome = join(root, 'user-home')
  const config = join(root, 'config-home')
  const cwd = join(root, 'work')
  const bin = join(root, 'login-bin')
  for (const dir of [userHome, config, cwd, bin]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(userHome, '.bash_profile'), 'from_profile_fn() { echo fn-from-bash-profile; }\n')
  writeFileSync(join(userHome, '.bashrc'), "alias from_bashrc_alias='echo alias-from-bashrc'\nfrom_bashrc_fn() { echo fn-from-bashrc; }\n")
  writeFileSync(join(userHome, '.zshenv'), 'export FROM_ZSHENV=1\n')
  writeFileSync(join(userHome, '.zshrc'), "alias from_zshrc_alias='echo alias-from-zshrc'\nfrom_zshrc_fn() { echo fn-from-zshrc }\n")
  writeFileSync(join(bin, 'login-only-tool'), '#!/bin/sh\necho tool-on-the-login-path\n')
  chmodSync(join(bin, 'login-only-tool'), 0o755)
  seedFirstRun(config, [cwd])
  const launchPath = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`
  const exported = `exported-by-the-login-shell-for-${name}`
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => INHERITED.test(entry[0]) && entry[1] !== undefined))
  return {
    root,
    cwd,
    launchPath,
    exported,
    env: {
      ...inherited,
      HOME: userHome,
      SHELL: '/bin/zsh',
      TERM: 'dumb',
      PATH: launchPath,
      LOGIN_EXPORT: exported,
      MERCURY_CONFIG_DIR: config,
      MERCURY_DAEMON_DIR: join(config, 'daemon'),
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      ANTHROPIC_API_KEY: FIXTURE_API_KEY,
      ANTHROPIC_BASE_URL: api.url,
    },
  }
}

function resultOf(api: FixtureApi): string {
  for (const request of api.messageRequests()) {
    const messages = (request.body as { messages?: Array<{ role?: string; content?: unknown }> } | null)?.messages ?? []
    for (const message of messages) {
      if (message.role !== 'user' || !Array.isArray(message.content)) continue
      for (const part of message.content as Array<{ type?: string; content?: unknown }>) {
        if (part.type !== 'tool_result') continue
        if (typeof part.content === 'string') return part.content
        if (Array.isArray(part.content)) return (part.content as Array<{ type?: string; text?: string }>).map(inner => (inner.type === 'text' ? (inner.text ?? '') : '')).join('')
      }
    }
  }
  return ''
}

function judge(situation: string, w: World, result: string, why: string): void {
  const lines = result.split('\n').map(line => line.trim())
  const value = (name: string): string => lines.find(line => line.startsWith(`${name}=`))?.slice(name.length + 1) ?? ''
  const brief = `${why} · ${JSON.stringify(result.slice(0, 500))}`
  check(`${situation}: the command ran in bash, though the launcher's $SHELL named zsh`, value('shell') === 'bash', brief)
  const seen = value('path').split(':')
  const want = w.launchPath.split(':')
  let at = 0
  for (const entry of seen) if (entry === want[at]) at++
  check(`${situation}: PATH reaches the command with the launcher's first folder first and every folder in its order`, seen[0] === want[0] && at === want.length, `launcher ${w.launchPath} · command ${value('path')}`)
  check(`${situation}: a program only the launcher's PATH holds runs by its bare name`, lines.includes('tool-on-the-login-path'), brief)
  check(`${situation}: a variable the launcher exported reaches the command`, value('export') === w.exported, brief)
  check(`${situation}: an alias from ~/.bashrc is carried`, lines.includes('alias-from-bashrc'), brief)
  check(`${situation}: a function from ~/.bashrc is carried`, lines.includes('fn-from-bashrc'), brief)
  check(`${situation}: a function from ~/.bash_profile is carried (the login files are read)`, lines.includes('fn-from-bash-profile'), brief)
  check(`${situation}: what the user wrote for zsh is not read — no alias or function of ~/.zshrc, no variable of ~/.zshenv`, value('zsh-alias') === 'absent' && value('zsh-fn') === 'absent' && value('zshenv') === 'unset', brief)
}

const bounded = async <T,>(promise: Promise<T>, label: string, ms = 120_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms / 1000}s`)), ms) })])
  } finally {
    clearTimeout(timer)
  }
}

async function fromATerminal(): Promise<void> {
  const api = await startFixtureApi(TURNS)
  const w = world('terminal', api)
  let why = ''
  try {
    const child = spawn(nodeBinPath(), [DIST, 'run', '--mode', 'sovereign', '--model', MODEL, '--format', 'text', ASK], { cwd: w.cwd, env: w.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.stdout.resume()
    const code = await bounded(new Promise<number | null>(done => { child.once('close', exit => done(exit)); child.once('error', () => done(null)) }), 'the run').catch(error => { child.kill('SIGKILL'); return String(error) })
    why = `exit ${String(code)} · stderr ${JSON.stringify(stderr.slice(-300))}`
  } finally {
    await api.close()
  }
  judge('started from a terminal (mercury run)', w, resultOf(api), why)
}

async function byTheDaemon(): Promise<void> {
  const api = await startFixtureApi(TURNS)
  const w = world('daemon', api)
  let why = ''
  const runner = hostRunner({ dist: DIST, node: nodeBinPath(), cwd: w.cwd, home: w.root, env: w.env, argv: ['--model', MODEL], report: () => {} })
  try {
    runner.onAsk(params => (params.kind === 'tool' ? { outcome: 'allow', input: params.input } : { outcome: 'allow' }))
    await bounded(runner.initialize(), 'the runner start')
    await runner.prompt(ASK)
    await bounded(runner.waitFor('the turn ends', row => row.type === 'outcome', 120_000), 'the hosted turn')
  } catch (error) {
    why = `${error instanceof Error ? error.message : String(error)} · stderr ${JSON.stringify(runner.stderr().slice(-300))}`
  } finally {
    await runner.stop()
    await api.close()
  }
  judge('started by the daemon (the hosted runner)', w, resultOf(api), why)
}

const TWO_COMMANDS: ScriptedTurn[] = [
  { kind: 'tool_use', name: 'Bash', id: 'toolu_first', input: { command: 'echo first-ran; from_profile_fn', description: 'the first command' } },
  { kind: 'tool_use', name: 'Bash', id: 'toolu_second', input: { command: 'echo second-ran', description: 'the second command' } },
  { kind: 'text', text: 'two commands done' },
]

type Part = { type?: string; tool_use_id?: string; content?: unknown; text?: string }

function askedOfTheModel(api: FixtureApi): { results: Map<string, string>; description: string } {
  const results = new Map<string, string>()
  let description = ''
  for (const request of api.messageRequests()) {
    const body = request.body as { tools?: Array<{ name?: string; description?: string }>; messages?: Array<{ role?: string; content?: unknown }> } | null
    const bash = body?.tools?.find(tool => tool.name === 'Bash')
    if (description === '' && typeof bash?.description === 'string') description = bash.description
    for (const message of body?.messages ?? []) {
      if (message.role !== 'user' || !Array.isArray(message.content)) continue
      for (const part of message.content as Part[]) {
        if (part.type !== 'tool_result' || part.tool_use_id === undefined) continue
        results.set(part.tool_use_id, typeof part.content === 'string' ? part.content : Array.isArray(part.content) ? (part.content as Part[]).map(inner => (inner.type === 'text' ? (inner.text ?? '') : '')).join('') : '')
      }
    }
  }
  return { results, description }
}

async function whereNothingIsCarried(): Promise<void> {
  const situation = 'a login file that ends the shell'
  const api = await startFixtureApi(TWO_COMMANDS)
  const w = world('ends-the-shell', api)
  writeFileSync(join(w.root, 'user-home', '.bash_profile'), 'from_profile_fn() { echo fn-from-bash-profile; }\nexit 0\n')
  let why = ''
  try {
    const child = spawn(nodeBinPath(), [DIST, 'run', '--mode', 'sovereign', '--model', MODEL, '--format', 'text', ASK], { cwd: w.cwd, env: w.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.stdout.resume()
    const code = await bounded(new Promise<number | null>(done => { child.once('close', exit => done(exit)); child.once('error', () => done(null)) }), 'the run').catch(error => { child.kill('SIGKILL'); return String(error) })
    why = `exit ${String(code)} · stderr ${JSON.stringify(stderr.slice(-300))}`
  } finally {
    await api.close()
  }
  const { results, description } = askedOfTheModel(api)
  const first = results.get('toolu_first') ?? ''
  const second = results.get('toolu_second') ?? ''
  const LINE = 'Nothing your bash login files define is carried in this session: '
  const sentence = description.split('\n\n').find(part => part.startsWith('In the main conversation')) ?? ''
  const brief = `${why} · first ${JSON.stringify(first.slice(0, 700))} · second ${JSON.stringify(second.slice(0, 200))}`
  check(`${situation}: the commands run, without what the file defines`, first.includes('first-ran') && !first.includes('fn-from-bash-profile') && second.includes('second-ran'), brief)
  check(
    `${situation}: the description the model is sent with its first request does not say a call starts from your profile`,
    sentence !== '' && !sentence.includes('starts from your profile') && sentence.endsWith('and no call carries the aliases, functions or options of your profile (bash) in this session.'),
    JSON.stringify(sentence),
  )
  check(
    `${situation}: the first result carries one line that says the login files are not carried, why, and what to change`,
    first.split('\n').filter(line => line.startsWith(LINE)).length === 1 && first.split(LINE).length === 2 && /a login file ended the shell or handed it to another program\. Find the line in the files bash reads at login/.test(first) && first.includes('only in an interactive shell') && first.includes('then restart Mercury.'),
    brief,
  )
  check(`${situation}: the second result does not carry it`, second.includes('second-ran') && !/login files|login run/.test(second), brief)
  const snapshots = join(w.env.MERCURY_CONFIG_DIR!, 'shell-snapshots')
  const before = existsSync(snapshots) ? readdirSync(snapshots).length : 0
  const health = spawnSync(nodeBinPath(), [DIST, 'health', '--json'], { cwd: w.cwd, env: w.env, encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024 })
  let row: { status?: string; evidence?: string; fix?: string } | undefined
  try {
    row = (JSON.parse(health.stdout) as { sections?: Array<{ checks: Array<{ id: string; status?: string; evidence?: string; fix?: string }> }> }).sections?.flatMap(part => part.checks).find(check => check.id === 'shell')
  } catch {
    row = undefined
  }
  check(
    `${situation}: mercury health, run by itself in that home, warns on the Bash tool shell row with the reason, and its fix says what to change`,
    row !== undefined && row.status === 'warn' && (row.evidence ?? '').includes('nothing the bash login files define is carried: ') && /a login file ended the shell or handed it to another program/.test(row.evidence ?? '') && (row.fix ?? '').includes('only in an interactive shell'),
    `${JSON.stringify(row)} · exit ${String(health.status)} · ${String(health.stderr ?? '').slice(-200)}`,
  )
  check(`${situation}: that health run keeps no file of its login run in the config home`, (existsSync(snapshots) ? readdirSync(snapshots).length : 0) === before, `${before} before, ${existsSync(snapshots) ? readdirSync(snapshots).join(' ') : 'no folder'} after`)
}

type EditorTerminal = 'not offered' | 'starts what it is asked' | 'starts nothing'
type Asked = { command: string; args: string[] | null; shell: string | null }

async function byAnEditor(name: string, situation: string, terminal: EditorTerminal): Promise<void> {
  const api = await startFixtureApi(TURNS)
  const w = world(name, api)
  let why = ''
  const child = spawn(nodeBinPath(), [DIST, 'acp'], { cwd: w.cwd, env: w.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const exited = new Promise<void>(done => child.once('close', () => done()))
  const asked: Asked[] = []
  const terminals = new Map<string, { output: string; exit: Promise<number | null> }>()
  const of = (params: unknown): { output: string; exit: Promise<number | null> } => terminals.get((params as { terminalId: string }).terminalId) ?? { output: '', exit: Promise.resolve(1) }
  const app = acp.client({ name: 'profile-environment-proof' })
    .onNotification('session/update', () => {})
    .onRequest('terminal/create', ctx => {
      const params = ctx.params as { command: string; args?: string[]; cwd?: string | null; env?: Array<{ name: string; value: string }> }
      asked.push({ command: params.command, args: params.args ?? null, shell: params.env?.find(entry => entry.name === 'SHELL')?.value ?? null })
      const terminalId = `terminal-${asked.length}`
      if (terminal !== 'starts what it is asked') {
        terminals.set(terminalId, { output: 'the editor started nothing\n', exit: Promise.resolve(0) })
        return { terminalId }
      }
      const started = spawn(params.command, params.args ?? [], { cwd: params.cwd ?? w.cwd, env: Object.fromEntries((params.env ?? []).map(entry => [entry.name, entry.value])), stdio: ['ignore', 'pipe', 'pipe'] })
      const row = { output: '', exit: new Promise<number | null>(done => { started.once('close', code => done(code)); started.once('error', () => done(127)) }) }
      started.stdout.on('data', chunk => { row.output += String(chunk) })
      started.stderr.on('data', chunk => { row.output += String(chunk) })
      terminals.set(terminalId, row)
      return { terminalId }
    })
    .onRequest('terminal/output', ctx => ({ output: of(ctx.params).output, truncated: false }))
    .onRequest('terminal/wait_for_exit', async ctx => ({ exitCode: await of(ctx.params).exit }))
    .onRequest('terminal/kill', () => ({}))
    .onRequest('terminal/release', () => ({}))
    .onRequest('session/request_permission', ctx => {
      const options = (ctx.params as { options?: Array<{ optionId: string; kind?: string }> }).options ?? []
      const allow = options.find(option => option.kind === 'allow_once') ?? options.find(option => option.optionId.startsWith('allow')) ?? options[0]
      return { outcome: { outcome: 'selected' as const, optionId: allow?.optionId ?? 'allow' } }
    })
  const conn = app.connect(acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>))
  try {
    await bounded(conn.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: terminal === 'not offered' ? {} : { terminal: true } } as never), 'the editor handshake')
    const created = await bounded(conn.agent.request('session/new', { cwd: w.cwd, mcpServers: [] }), 'the editor session')
    const turn = await bounded(conn.agent.request('session/prompt', { sessionId: created.sessionId, prompt: [{ type: 'text', text: ASK }] }), 'the editor turn')
    why = `stop ${String(turn.stopReason)}`
  } catch (error) {
    why = `${error instanceof Error ? error.message : String(error)} · stderr ${JSON.stringify(stderr.slice(-300))}`
  } finally {
    child.stdin.end()
    child.kill('SIGTERM')
    await Promise.race([exited, new Promise(done => setTimeout(done, 5_000))])
    await api.close()
  }
  const result = resultOf(api)
  judge(situation, w, result, why)
  if (terminal === 'not offered') return
  const told = JSON.stringify(asked.map(row => ({ command: row.command, args: row.args?.map(arg => arg.slice(0, 90)) ?? null, shell: row.shell }))).slice(0, 900)
  const shipped = join(dirname(DIST), 'vendor', 'bash', `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`, 'bash')
  const byPath = (row: Asked): boolean => isAbsolute(row.command) && basename(row.command) === 'bash' && (!existsSync(shipped) || row.command === shipped) && row.args !== null && row.args.length === 2 && row.args[0] === '-c'
  check(`${situation}: every terminal/create names the shell by its path, with -c and one line as its arguments, and none hands over the raw command`, asked.length > 0 && asked.every(byPath) && asked.every(row => row.command !== COMMAND), told)
  check(`${situation}: the first thing asked of the editor is that shell on a harmless line, to see that the editor starts it`, /^printf '%s\\n' mercury-shell-[0-9a-f]+$/.test(asked[0]?.args?.[1] ?? ''), told)
  check(`${situation}: the editor's terminal is handed the SHELL the launcher had`, asked.length > 0 && asked.every(row => row.shell === w.env.SHELL), told)
  if (terminal === 'starts what it is asked') {
    check(`${situation}: the second thing asked is the command, inside the line the local road builds (eval and the quoted text)`, asked.length === 2 && (asked[1]?.args?.[1] ?? '').includes("eval 'echo \"path=$PATH\"") && result.includes('ran in the editor terminal'), `${told} · ${JSON.stringify(result.slice(-200))}`)
  } else {
    check(`${situation}: an editor whose terminal does not start the shell is asked once and not again, and the result says in one sentence that the command ran in the local shell`, asked.length === 1 && /The editor's terminal could not start Mercury's shell \(.*\); this command ran in the local shell, and so will the rest of this session's\./.test(result), `${told} · ${JSON.stringify(result.slice(-300))}`)
  }
}

console.log('============================================================')
console.log(' What a command sees: the launcher\'s environment and the user\'s bash files, in three launch situations and through an editor\'s terminal')
console.log('============================================================')
console.log(`build under proof: ${DIST}`)

try {
  if (!existsSync(DIST)) check('the built bundle is present', false, `${DIST} is absent: run bun run build.ts, then this proof again`)
  else if (process.platform === 'win32') console.log('  [SKIP] this proof drives the macOS and Linux road; the Windows road has its own proofs')
  else {
    await fromATerminal()
    await byTheDaemon()
    await byAnEditor('editor', 'started by an editor (mercury acp)', 'not offered')
    await byAnEditor('editor-terminal', 'started by an editor that offers its terminal and starts what it is asked', 'starts what it is asked')
    await byAnEditor('editor-nothing', 'started by an editor whose terminal starts nothing', 'starts nothing')
    await whereNothingIsCarried()
  }
} finally {
  if (KEEP) console.log(`world kept: ${scratch}`)
  else rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-profile-environment: ALL LAWS HOLD' : `\nprove-profile-environment: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
