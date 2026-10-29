#!/usr/bin/env bun

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'

const at = process.argv.indexOf('--dist')
const distArg = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
const dist = distArg.endsWith('.mjs') ? distArg : join(distArg, 'mercury.mjs')
if (!existsSync(dist)) { console.error(`FAIL run bundle exists: ${dist}`); process.exit(1) }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }

type Run = { code: number | null; signal: NodeJS.Signals | null; out: string; err: string; requests: number; sessions: string[]; ms: number }

async function mercury(args: string[]): Promise<Run> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'plain-cmd-')))
  const cwd = join(home, 'project')
  mkdirSync(cwd)
  seedFirstRun(home, [cwd])
  const api = await startFixtureApi([])
  const started = Date.now()
  const child = spawn('node', [dist, ...args], {
    cwd,
    env: {
      HOME: home,
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
      TERM: 'xterm-256color',
      COLUMNS: '200',
      NO_COLOR: '1',
      BROWSER: '/usr/bin/true',
      MERCURY_CONFIG_DIR: home,
      MERCURY_HOME: home,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      ANTHROPIC_API_KEY: FIXTURE_API_KEY,
      ANTHROPIC_BASE_URL: api.url,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout.on('data', chunk => { out += String(chunk) })
  child.stderr.on('data', chunk => { err += String(chunk) })
  const guard = setTimeout(() => child.kill('SIGKILL'), 90_000)
  try {
    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveClose => {
      child.on('close', (code, signal) => resolveClose({ code, signal }))
    })
    const sessions = existsSync(join(home, 'projects')) ? readdirSync(join(home, 'projects')) : []
    return { code, signal, out, err, requests: api.messageRequests().length, sessions, ms: Date.now() - started }
  } finally {
    clearTimeout(guard)
    await api.close()
    rmSync(home, { recursive: true, force: true })
  }
}

const brief = (run: Run): string => JSON.stringify({ code: run.code, signal: run.signal, requests: run.requests, sessions: run.sessions, ms: run.ms, out: run.out.slice(0, 160), err: run.err.slice(0, 200) })

console.log('§1 a command that only prints makes no model request and leaves no session')
const printing: Array<{ road: string[]; same: string[] }> = [
  { road: ['version'], same: ['--version'] },
  { road: ['help'], same: ['--help'] },
  { road: ['help', 'run'], same: ['run', '--help'] },
  { road: ['help', 'update'], same: ['update', '--help'] },
  { road: ['help', 'mcp', 'serve'], same: ['mcp', 'serve', '--help'] },
]
for (const { road, same } of printing) {
  const spelled = `mercury ${road.join(' ')}`
  const [typed, flagged] = await Promise.all([mercury(road), mercury(same)])
  check(`${spelled} makes no model request`, typed.requests === 0, brief(typed))
  check(`${spelled} leaves no session behind (nothing under projects/)`, typed.sessions.length === 0, brief(typed))
  check(`${spelled} exits 0 with nothing on stderr`, typed.code === 0 && typed.err === '', brief(typed))
  check(`${spelled} prints what mercury ${same.join(' ')} prints, byte for byte`, typed.out.length > 0 && typed.out === flagged.out, `${brief(typed)} ≠ ${brief(flagged)}`)
}
const version = await mercury(['version'])
check('mercury version prints the one version line', /^Mercury \d+\.\d+\.\d+\S*\n$/.test(version.out), brief(version))

console.log('§2 help names an unknown command in one line and exits as every usage error does')
const unknown = await mercury(['help', 'frobnicate-verb'])
check('mercury help frobnicate-verb makes no model request and leaves no session', unknown.requests === 0 && unknown.sessions.length === 0, brief(unknown))
check('…exits 2 (a usage error), nothing on stdout', unknown.code === 2 && unknown.out === '', brief(unknown))
check('…one stderr line naming the word and pointing at --help', unknown.err === 'unknown command: frobnicate-verb — mercury --help lists every command\n', brief(unknown))

console.log('§3 the help page lists both verbs and the launchers boot them straight')
const page = await mercury(['--help'])
check('the Commands block carries help [command...]', /^  help \[command\.\.\.\]\s+Show help/m.test(page.out), page.out.slice(0, 400))
check('the Commands block carries version', /^  version\s+Print the version/m.test(page.out), page.out.slice(0, 400))
check('no page says "display help for command" (commander\'s own words)', !page.out.includes('display help for command'))
const { SPLASH_SKIP_VERBS } = await import('../release/launcherTemplates.mjs') as { SPLASH_SKIP_VERBS: string[] }
check('the launchers\' straight-boot verb list carries help and version (a terminal `mercury version` never meets the enter screen)', SPLASH_SKIP_VERBS.includes('help') && SPLASH_SKIP_VERBS.includes('version'), SPLASH_SKIP_VERBS.join(' '))

console.log('\n============================================================')
console.log(failures === 0 ? ' ✅ PLAIN COMMANDS NO TURN GREEN' : ` ❌ PLAIN COMMANDS NO TURN RED (${failures} failed)`)
process.exit(failures === 0 ? 0 : 1)
