#!/usr/bin/env bun

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { handoffTurn, isHandoffRequest, startFixtureApi } from '../lib/fixtureApi.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'

const at = process.argv.indexOf('--dist')
const distArg = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
const dist = distArg.endsWith('.mjs') ? distArg : join(distArg, 'mercury.mjs')
if (!existsSync(dist)) {
  console.error(`FAIL run bundle exists: ${dist}`)
  process.exit(1)
}

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`)
  if (!ok) failures++
}

const TERMINAL_LINE = 'Mercury needs a terminal: stdin is not one, so a chat cannot take your keys; for scripts use mercury run -- "<prompt>"'
const TYPO_LINE = 'unknown command: orient — mercury --help lists every command; to send it as a prompt: mercury run -- "orient"'
const HANG_BOUND_MS = 20_000

type Run = { code: number | null; signal: string | null; out: string; err: string; requests: number; sessions: string[]; ms: number; killed: boolean }

async function withHome<T>(work: (home: string, cwd: string, env: NodeJS.ProcessEnv, requests: () => number) => Promise<T>): Promise<T> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'boot-tty-')))
  const cwd = join(home, 'project')
  mkdirSync(cwd)
  seedFirstRun(home, [cwd])
  const api = await startFixtureApi([{ kind: 'text', text: 'hello from the fixture' }, { kind: 'text', text: 'and once more' }, handoffTurn(), handoffTurn()])
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: process.env.PATH,
    TMPDIR: tmpdir(),
    TERM: 'xterm-256color',
    COLUMNS: '120',
    LINES: '40',
    NO_COLOR: '1',
    BROWSER: '/usr/bin/true',
    MERCURY_CONFIG_DIR: home,
    MERCURY_HOME: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_CRITTER: '0',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    ANTHROPIC_BASE_URL: api.url,
  }
  try {
    return await work(home, cwd, env, () => api.messageRequests().filter(request => !isHandoffRequest(request)).length)
  } finally {
    await api.close()
    rmSync(home, { recursive: true, force: true })
  }
}

function piped(args: string[]): Promise<Run> {
  return withHome((home, cwd, env, requests) => {
    const started = Date.now()
    const child = spawn('node', [dist, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let killed = false
    child.stdout.on('data', chunk => {
      out += String(chunk)
    })
    child.stderr.on('data', chunk => {
      err += String(chunk)
    })
    const guard = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, HANG_BOUND_MS)
    return new Promise<Run>(resolveRun => {
      child.on('close', (code, signal) => {
        clearTimeout(guard)
        const sessions = existsSync(join(home, 'projects')) ? readdirSync(join(home, 'projects')) : []
        resolveRun({ code, signal, out, err, requests: requests(), sessions, ms: Date.now() - started, killed })
      })
    })
  })
}

const stripControl = (text: string): string =>
  text
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/\u001b[()][A-Za-z0-9]/g, '')
    .replace(/\r/g, '')
    .replace(/\^D/g, '')

function underPty(args: string[]): Promise<Run> | null {
  if (process.platform === 'win32') return null
  const script = spawnSync('which', ['script'], { encoding: 'utf8' }).stdout.trim()
  if (!script) return null
  return withHome((home, cwd, env, requests) => {
    const started = Date.now()
    const inner = join(home, 'under-pty.sh')
    writeFileSync(inner, `cd ${JSON.stringify(cwd)} && node ${JSON.stringify(dist)} ${args.map(a => JSON.stringify(a)).join(' ')} < /dev/null; echo "EXIT=$?"\n`)
    const argv = process.platform === 'darwin' ? ['-q', '/dev/null', 'bash', inner] : ['-q', '-e', '-c', `bash ${JSON.stringify(inner)}`, '/dev/null']
    const child = spawn('script', argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let killed = false
    child.stdout.on('data', chunk => {
      out += String(chunk)
    })
    child.stderr.on('data', chunk => {
      out += String(chunk)
    })
    const guard = setTimeout(() => {
      killed = true
      spawnSync('pkill', ['-P', String(child.pid)])
      child.kill('SIGKILL')
    }, HANG_BOUND_MS)
    return new Promise<Run>(resolveRun => {
      child.on('close', (code, signal) => {
        clearTimeout(guard)
        const text = stripControl(out)
        const exit = /EXIT=(\d+)/.exec(text)
        const sessions = existsSync(join(home, 'projects')) ? readdirSync(join(home, 'projects')) : []
        resolveRun({ code: exit ? Number(exit[1]) : code, signal, out: text, err: '', requests: requests(), sessions, ms: Date.now() - started, killed })
      })
    })
  })
}

const brief = (run: Run): string => JSON.stringify({ code: run.code, killed: run.killed, requests: run.requests, sessions: run.sessions, ms: run.ms, out: run.out.slice(0, 200), err: run.err.slice(0, 240) })

console.log('§1 a boot that needs a terminal (stdout a terminal, stdin not one) refuses at once with the one line — never a silent wait')
const ptyRun = underPty(['orient'])
if (ptyRun === null) {
  console.log('  [SKIP — LOUD] the pseudo-terminal leg needs script(1) on a POSIX host; §2 holds the inferred-run law here')
} else {
  const run = await ptyRun
  console.log(`  pty: ${brief(run)}`)
  check('mercury orient with stdin from /dev/null and a terminal stdout exits 2', run.code === 2 && !run.killed, brief(run))
  check(`…within ${HANG_BOUND_MS / 1000}s (the base ran until killed) — measured ${run.ms}ms`, !run.killed && run.ms < HANG_BOUND_MS, brief(run))
  check('…with the one line naming the fix', run.out.includes(TERMINAL_LINE), brief(run))
  check('…no model request, no session left behind', run.requests === 0 && run.sessions.length === 0, brief(run))
}

console.log('§2 a single bare word that is no command, with stdin not a terminal, is a probable typo: the boot says so instead of sending it to the model')
const typo = await piped(['orient'])
check('mercury orient (stdout piped, stdin not a terminal) exits 2', typo.code === 2 && !typo.killed, brief(typo))
check('…one stderr line: unknown command, the help door, the run spelling', typo.err === `${TYPO_LINE}\n`, brief(typo))
check('…nothing on stdout, no model request, no session left behind', typo.out === '' && typo.requests === 0 && typo.sessions.length === 0, brief(typo))

console.log('§3 a real prompt and an explicit run keep their roads')
const sentence = await piped(['say hello to the fixture'])
check('a prompt of several words with stdout piped is the inferred run: the model is asked (the closing ask set aside), exit 0', sentence.requests >= 1 && sentence.code === 0, brief(sentence))
const explicit = await piped(['run', 'orient'])
check('mercury run orient sends the one word as the prompt: the model is asked (the closing ask set aside), exit 0', explicit.requests >= 1 && explicit.code === 0, brief(explicit))

console.log('§4 a printing command never meets the terminal check')
const version = await piped(['version'])
check('mercury version with stdin not a terminal prints the version line and exits 0', version.code === 0 && /^Mercury \d+\.\d+\.\d+\S*\n$/.test(version.out) && version.err === '', brief(version))

console.log('\n============================================================')
console.log(failures === 0 ? ' ✅ BOOT NEEDS TERMINAL GREEN' : ` ❌ BOOT NEEDS TERMINAL RED (${failures} failed)`)
process.exit(failures === 0 ? 0 : 1)
