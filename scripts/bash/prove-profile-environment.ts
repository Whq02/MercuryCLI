#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

async function byAnEditor(): Promise<void> {
  const api = await startFixtureApi(TURNS)
  const w = world('editor', api)
  let why = ''
  const child = spawn(nodeBinPath(), [DIST, 'acp'], { cwd: w.cwd, env: w.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const exited = new Promise<void>(done => child.once('close', () => done()))
  const app = acp.client({ name: 'profile-environment-proof' })
    .onNotification('session/update', () => {})
    .onRequest('session/request_permission', ctx => {
      const options = (ctx.params as { options?: Array<{ optionId: string; kind?: string }> }).options ?? []
      const allow = options.find(option => option.kind === 'allow_once') ?? options.find(option => option.optionId.startsWith('allow')) ?? options[0]
      return { outcome: { outcome: 'selected' as const, optionId: allow?.optionId ?? 'allow' } }
    })
  const conn = app.connect(acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>))
  try {
    await bounded(conn.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} } as never), 'the editor handshake')
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
  judge('started by an editor (mercury acp)', w, resultOf(api), why)
}

console.log('============================================================')
console.log(' What a command sees: the launcher\'s environment and the user\'s bash files, in three launch situations')
console.log('============================================================')
console.log(`build under proof: ${DIST}`)

try {
  if (!existsSync(DIST)) check('the built bundle is present', false, `${DIST} is absent: run bun run build.ts, then this proof again`)
  else if (process.platform === 'win32') console.log('  [SKIP] this proof drives the macOS and Linux road; the Windows road has its own proofs')
  else {
    await fromATerminal()
    await byTheDaemon()
    await byAnEditor()
  }
} finally {
  if (KEEP) console.log(`world kept: ${scratch}`)
  else rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-profile-environment: ALL LAWS HOLD' : `\nprove-profile-environment: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
