#!/usr/bin/env bun
// ============================================================================
//  scripts/mcp/prove-no-registry-phonehome.ts — Mercury asks no vendor which
//  MCP servers are "official": a plain boot of the BUILT binary makes no
//  request to the vendor's MCP registry, and the binary spells its path
//  nowhere.
//
//  Method (the zero-network tripwire): every child is booted with a
//  --require hook that logs AND refuses every TCP connect, every
//  http(s).request/get and every fetch; PATH shims log any git/ssh spawn.
//  Poison controls fire first — a tripwire never seen firing proves nothing
//  by its silence.
//
//  §1 controls: http.get · https.get spelling the registry path · a raw TLS
//     connect · fetch — each lands in the request log and is refused.
//  §2 an EMPTY config home (no config file at all), booted headless (`-p`).
//  §3 a SEEDED home (onboarded, cwd trusted, env key approved): the plain
//     headless boot runs through MCP connect and the deferred prefetches to
//     the operator's own model call — the headless runner's API error (the
//     refused model call) is the marker that the boot passed the prefetch
//     stage; the model route is whatever the home's default model resolves
//     to, never pinned here.
//  §4 a home with MCP servers CONFIGURED at user scope (http · sse · stdio):
//     the same boot; the configured servers are the only MCP-related
//     connects.
//  §5 the built binary spells neither the registry host+path nor its
//     versioned path.
//  §6 (optional control) MERCURY_PROOF_REGISTRY_BASE_DIST names a build
//     that still carries the prefetch: the same drive on it MUST show the
//     registry request — the method's own A/B.
//
//  Every boot prints its outbound census (each connect the boot ATTEMPTED,
//  deduplicated with counts) and its spawn census: the residue beyond the
// operator's own model call is the phone-home census. A
//  refused first connect can end a boot's later requests, so the census
//  is a lower bound on a live boot's request list, never an upper one.
//  Local git spawns in the cwd (rev-parse, read-tree) are reported, not
//  refused; the spawn assertion covers ssh and git's network verbs.
//  The registry needles are composed from parts: this file never spells
//  them. §2–§6 skip loudly when dist/mercury.mjs is absent (the gate
//  prebuilds it); MERCURY_PROOF_DIST points the drives at another build.
// ============================================================================

import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = process.env.MERCURY_PROOF_DIST ?? join(ROOT, 'dist', 'mercury.mjs')
const BASE_DIST = process.env.MERCURY_PROOF_REGISTRY_BASE_DIST

// ── the registry needles, composed ──────────────────────────────────────────
const J = (...parts: string[]): string => parts.join('')
const VENDOR_API_HOST = J('api.', 'anthropic', '.com')
const REGISTRY_SEGMENT = J('mcp-', 'registry')
const REGISTRY_HOSTPATH = J(VENDOR_API_HOST, '/', REGISTRY_SEGMENT)
const REGISTRY_VERSIONED = J(REGISTRY_SEGMENT, '/v0')
const REGISTRY_URL = J('https://', REGISTRY_HOSTPATH, '/v0/servers?version=latest&visibility=commercial')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

// ── scratch: homes, a cwd, PATH shims, the request log, the tripwire ────────
const scratch = mkdtempSync(join(tmpdir(), 'mercury-no-registry-phonehome-'))
const cwd = join(scratch, 'cwd')
const shimDir = join(scratch, 'bin')
const shimLog = join(scratch, 'shim.log')
const netlog = join(scratch, 'net.log')
const preload = join(scratch, 'tripwire.cjs')
mkdirSync(cwd, { recursive: true })
mkdirSync(shimDir, { recursive: true })
for (const exe of ['git', 'ssh']) {
  const path = join(shimDir, exe)
  writeFileSync(path, `#!/bin/sh\necho "${exe} $*" >> "$SHIM_LOG"\nexit 128\n`)
  chmodSync(path, 0o755)
}
const shimHits = (): string => (existsSync(shimLog) ? readFileSync(shimLog, 'utf8').trim() : '')
const netLines = (): string[] =>
  existsSync(netlog) ? readFileSync(netlog, 'utf8').split('\n').filter(line => line !== '') : []

// Inside the child: every TCP connect (every http/https/fetch/websocket
// path ends here — tls.connect included, it is a net.Socket) and every
// http(s).request/get and globalThis.fetch is logged with its target and
// refused; unix-socket connects (a local daemon) pass. Request targets are
// described from the url/options shape, never JSON-stringified (an agent-
// bearing options object must never abort the log line).
writeFileSync(
  preload,
  `'use strict'
const fs = require('node:fs')
const net = require('node:net')
const LOG = process.env.PROOF_NETLOG
const log = line => { try { fs.appendFileSync(LOG, line + '\\n') } catch {} }
function describe(a0, a1) {
  try {
    const opts = (a1 && typeof a1 === 'object') ? a1 : (a0 && typeof a0 === 'object' && !(a0 instanceof URL) ? a0 : null)
    let base = ''
    if (typeof a0 === 'string') base = a0
    else if (a0 instanceof URL) base = a0.href
    else if (opts) {
      const proto = opts.protocol || (opts.port === 443 ? 'https:' : 'http:')
      const host = opts.hostname || opts.host || 'localhost'
      const port = opts.port ? ':' + opts.port : ''
      base = proto + '//' + host + port + (opts.path || '/')
    }
    if (base === '') base = String(a0)
    const method = opts && opts.method ? ' ' + String(opts.method).toUpperCase() : ''
    return base + method
  } catch { return '?' }
}
const origConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]
  const opts = typeof first === 'object' && first !== null ? first : { port: args[0], host: args[1] }
  if (opts.path) return origConnect.apply(this, args)
  const target = 'tcp ' + (opts.host || 'localhost') + ':' + opts.port
  log(target)
  throw new Error('tripwire: ' + target)
}
for (const name of ['http', 'https']) {
  const m = require('node:' + name)
  for (const fn of ['request', 'get']) {
    m[fn] = (...args) => { const t = name + '.' + fn + ' ' + describe(args[0], args[1]); log(t); throw new Error('tripwire: ' + t) }
  }
}
try { require('node:module').syncBuiltinESMExports() } catch {}
globalThis.fetch = (input, init) => {
  const t = 'fetch ' + describe(typeof input === 'string' || input instanceof URL ? input : String(input && input.url || input), init)
  log(t)
  return Promise.reject(new Error('tripwire: ' + t))
}
`,
)

// The child posture: every read resolves through a scratch home; the shims
// sit first on PATH; the provider base URL is a dead loopback port so the
// operator's own model call is the ONE expected outbound target; retries
// are off so a refused call ends the boot at once.
const DEAD = 'http://127.0.0.1:9'
const PROOF_KEY = 'sk-ant-api03-proof-no-registry-phonehome-0000000000000000'
delete process.env.NODE_ENV
delete process.env.CI
process.env.ANTHROPIC_API_KEY = PROOF_KEY // seedFirstRun records the approval from the seeding process's env
const childEnv = (home: string): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: `${shimDir}:${process.env.PATH ?? ''}`,
  SHIM_LOG: shimLog,
  PROOF_NETLOG: netlog,
  NODE_OPTIONS: `--require ${preload}`,
  MERCURY_CONFIG_DIR: home,
  MERCURY_HOME: join(scratch, 'proof-home'),
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_DOCTOR_STATE_DIR: join(scratch, 'doctor-state'),
  MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
  MERCURY_TEAMS_DIR: join(scratch, 'teams'),
  MERCURY_TABULA_DIR: join(scratch, 'tabula'),
  MERCURY_MAX_RETRIES: '0',
  ANTHROPIC_API_KEY: PROOF_KEY,
  ANTHROPIC_BASE_URL: DEAD,
  BROWSER: 'true',
})

const PROMPT = 'Reply with the single word pong.'
type Boot = { code: number; signal: string | null; stdout: string; stderr: string; lines: string[]; leftovers: string }

function boot(dist: string, home: string): Boot {
  rmSync(netlog, { force: true })
  rmSync(shimLog, { force: true })
  let code = 0
  let signal: string | null = null
  let stdout = ''
  let stderr = ''
  try {
    stdout = execFileSync('node', [dist, '-p', PROMPT], {
      encoding: 'utf8',
      env: childEnv(home),
      cwd,
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const failed = error as { status?: number | null; signal?: string | null; stdout?: string; stderr?: string }
    code = failed.status ?? -1
    signal = failed.signal ?? null
    stdout = failed.stdout ?? ''
    stderr = failed.stderr ?? ''
  }
  // Anything the boot left running under the scratch posture is swept and
  // named: a lingering child would be a background engage of its own.
  let leftovers = ''
  try {
    leftovers = execFileSync('pgrep', ['-lf', scratch], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    leftovers = ''
  }
  for (const row of leftovers.split('\n')) {
    const pid = Number.parseInt(row, 10)
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // already gone
      }
    }
  }
  return { code, signal, stdout, stderr, lines: netLines(), leftovers }
}

function census(label: string, lines: string[]): void {
  const counts = new Map<string, number>()
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1)
  console.log(`     census — ${label}: ${counts.size} distinct target(s), ${lines.length} attempt(s)`)
  if (counts.size === 0) console.log('       (no outbound connect attempted)')
  for (const [target, n] of counts) console.log(`       ${n}× ${target}`)
}

const registryHits = (lines: string[]): string[] => lines.filter(line => line.includes(REGISTRY_SEGMENT))
const vendorHostHits = (lines: string[]): string[] => lines.filter(line => line.includes(VENDOR_API_HOST))
// The headless runner reports the refused model call as an API error on
// stderr (whatever route the home's default model takes); a connect to the
// dead base URL is the same marker for an Anthropic-routed model.
const reachedModelCall = (result: Boot): boolean =>
  /API Error/.test(result.stderr) || result.lines.some(line => line.includes('127.0.0.1:9'))
// ssh and git's network verbs are the spawns that could reach out; every
// other spawn (git rev-parse / read-tree in the cwd) is local and reported.
const NETWORK_SPAWN = /^(ssh\b|git (fetch|pull|clone|ls-remote|push|remote|submodule)\b)/m
const networkSpawns = (): string => shimHits().split('\n').filter(row => NETWORK_SPAWN.test(row)).join(' · ')
function spawnCensus(label: string): void {
  const rows = shimHits().split('\n').filter(row => row !== '')
  console.log(`     spawns — ${label}: ${rows.length} git/ssh spawn(s)${rows.length ? ': ' + rows.join(' · ') : ''}`)
}

console.log('============================================================')
console.log(' no MCP-registry phone-home — a plain boot asks no vendor')
console.log('============================================================')

if (!existsSync(DIST)) {
  console.log(`  – ${DIST} absent — SKIP §1–§6 (build first: bun run build.ts)`)
  rmSync(scratch, { recursive: true, force: true })
  console.log('\n ⚠ NOT RUN (no dist)')
  process.exit(1)
}

// ── §1 poison controls ──────────────────────────────────────────────────────
console.log('[1] controls: the tripwire is SEEN firing on every layer it guards')
{
  const controlHome = join(scratch, 'home-control')
  mkdirSync(controlHome, { recursive: true })
  const run = (script: string): void => {
    try {
      execFileSync('node', ['-e', script], { env: childEnv(controlHome), cwd, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      // refused by design
    }
  }
  rmSync(netlog, { force: true })
  run("require('node:http').get('http://203.0.113.1:80/')")
  check('control: http.get lands in the log', netLines().some(l => l.startsWith('http.get http://203.0.113.1')), netLines().join(' · '))
  rmSync(netlog, { force: true })
  run(`require('node:https').get(${JSON.stringify(REGISTRY_URL)})`)
  check(
    'control: https.get spelling the registry path lands in the log',
    netLines().some(l => l.startsWith('https.get ') && l.includes(REGISTRY_HOSTPATH)),
    netLines().join(' · '),
  )
  rmSync(netlog, { force: true })
  run("require('node:tls').connect({ host: '203.0.113.1', port: 443 })")
  check('control: a raw TLS connect lands in the log as tcp', netLines().some(l => l === 'tcp 203.0.113.1:443'), netLines().join(' · '))
  rmSync(netlog, { force: true })
  run("fetch('http://203.0.113.1/x').catch(() => {})")
  check('control: fetch lands in the log', netLines().some(l => l.startsWith('fetch http://203.0.113.1/x')), netLines().join(' · '))
  rmSync(netlog, { force: true })
  try {
    execFileSync('git', ['--version'], { env: childEnv(controlHome), cwd, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    // the shim exits 128 by design
  }
  check('control: the git shim logs a spawn', shimHits().includes('git --version'), shimHits())
  rmSync(shimLog, { force: true })
}

// ── §2 an empty home ────────────────────────────────────────────────────────
console.log('[2] an EMPTY config home, booted headless: no registry request')
{
  const home = join(scratch, 'home-empty')
  mkdirSync(home, { recursive: true })
  const result = boot(DIST, home)
  console.log(`     exit ${result.code}${result.signal ? ' signal ' + result.signal : ''}; stderr: ${result.stderr.trim().slice(0, 200).replace(/\n/g, ' ↵ ')}`)
  census('empty home', result.lines)
  spawnCensus('empty home')
  check('empty home: zero requests to the MCP registry', registryHits(result.lines).length === 0, registryHits(result.lines).join(' · '))
  check('empty home: zero requests to the vendor API host', vendorHostHits(result.lines).length === 0, vendorHostHits(result.lines).join(' · '))
  check('empty home: no ssh and no git network verb spawned', networkSpawns() === '', networkSpawns())
  check('empty home: nothing left running', result.leftovers === '', result.leftovers)
}

// ── §3 a seeded home ────────────────────────────────────────────────────────
console.log('[3] a SEEDED home (onboarded, trusted cwd, approved env key): the boot passes the prefetch stage, no registry request')
{
  const home = join(scratch, 'home-seeded')
  seedFirstRun(home, [cwd])
  const result = boot(DIST, home)
  console.log(`     exit ${result.code}${result.signal ? ' signal ' + result.signal : ''}; stderr: ${result.stderr.trim().slice(0, 200).replace(/\n/g, ' ↵ ')}`)
  census('seeded home', result.lines)
  spawnCensus('seeded home')
  check(
    'seeded home: the boot reached the operator\'s own model call (the prefetch stage is behind it)',
    reachedModelCall(result),
    (result.lines.join(' · ') || '(request log empty)') + ' | stderr: ' + result.stderr.trim().slice(0, 120),
  )
  check('seeded home: zero requests to the MCP registry', registryHits(result.lines).length === 0, registryHits(result.lines).join(' · '))
  check('seeded home: zero requests to the vendor API host', vendorHostHits(result.lines).length === 0, vendorHostHits(result.lines).join(' · '))
  check('seeded home: no ssh and no git network verb spawned', networkSpawns() === '', networkSpawns())
  check('seeded home: nothing left running', result.leftovers === '', result.leftovers)
}

// ── §4 a home with MCP servers configured ───────────────────────────────────
console.log('[4] a home with MCP servers CONFIGURED (http · sse · stdio at user scope): the configured servers are the only MCP connects')
{
  const home = join(scratch, 'home-mcp')
  seedFirstRun(home, [cwd])
  const configPath = join(home, '.mercury.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  config.mcpServers = {
    'fixture-http': { type: 'http', url: 'http://127.0.0.1:34017/mcp' },
    'fixture-sse': { type: 'sse', url: 'http://127.0.0.1:34018/sse' },
    'fixture-stdio': { type: 'stdio', command: 'node', args: ['-e', 'process.exit(0)'] },
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
  const result = boot(DIST, home)
  console.log(`     exit ${result.code}${result.signal ? ' signal ' + result.signal : ''}; stderr: ${result.stderr.trim().slice(0, 200).replace(/\n/g, ' ↵ ')}`)
  census('MCP-configured home', result.lines)
  spawnCensus('MCP-configured home')
  check(
    'MCP home: the boot reached the operator\'s own model call (MCP connect and the prefetch stage are behind it)',
    reachedModelCall(result),
    (result.lines.join(' · ') || '(request log empty)') + ' | stderr: ' + result.stderr.trim().slice(0, 120),
  )
  check(
    'MCP home: the configured http server is connected (the operator\'s own server, not a registry)',
    result.lines.some(l => l.includes('127.0.0.1:34017')),
    result.lines.join(' · '),
  )
  check('MCP home: zero requests to the MCP registry', registryHits(result.lines).length === 0, registryHits(result.lines).join(' · '))
  check('MCP home: zero requests to the vendor API host', vendorHostHits(result.lines).length === 0, vendorHostHits(result.lines).join(' · '))
  check('MCP home: no ssh and no git network verb spawned', networkSpawns() === '', networkSpawns())
  check('MCP home: nothing left running', result.leftovers === '', result.leftovers)
}

// ── §5 the dist spells no registry ──────────────────────────────────────────
console.log('[5] the built binary spells neither the registry host+path nor its versioned path')
{
  const dist = readFileSync(DIST, 'utf8')
  check(`dist: zero "${REGISTRY_HOSTPATH}"`, !dist.includes(REGISTRY_HOSTPATH))
  check(`dist: zero "${REGISTRY_VERSIONED}"`, !dist.includes(REGISTRY_VERSIONED))
}

// ── §6 the A/B control on a build that still phones home ────────────────────
console.log('[6] A/B control: a build that still carries the prefetch shows the registry request under the same drive')
if (!BASE_DIST) {
  console.log('  – MERCURY_PROOF_REGISTRY_BASE_DIST unset — SKIP (optional control; set it to a pre-removal build to run the A/B)')
} else if (!existsSync(BASE_DIST)) {
  check('control: the named base dist exists', false, BASE_DIST)
} else {
  const home = join(scratch, 'home-base')
  seedFirstRun(home, [cwd])
  const result = boot(BASE_DIST, home)
  census('base dist, seeded home', result.lines)
  check(
    'control: the pre-removal build DOES request the registry under this drive (the method sees the phone-home)',
    registryHits(result.lines).length >= 1,
    result.lines.join(' · ') || '(request log empty)',
  )
  check('control: nothing left running', result.leftovers === '', result.leftovers)
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ NO MCP-REGISTRY PHONE-HOME — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
