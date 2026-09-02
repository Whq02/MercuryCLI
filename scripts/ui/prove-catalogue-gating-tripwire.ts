#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-catalogue-gating-tripwire.ts — the
//  catalogue-gating law proved on the BUILT bundle with a zero-network
//  tripwire: model-catalogue traffic happens ONLY with a live credential,
//  and MERCURY_DISABLE_NONESSENTIAL_TRAFFIC stops it outright.
//
//  Method (the retired no-vendor-sources prover's pattern, loopback-passing):
//  every child runs under a --require hook that LOGS and REFUSES every
//  non-loopback TCP connect / http(s).request / fetch — loopback passes (the
//  fixture must be reachable, and refused-by-construction traffic must be
//  provable absent, not merely broken). POISON CONTROLS come first: a child
//  that does reach out must be SEEN tripping, and a loopback GET must be
//  SEEN passing, or every silence below proves nothing.
//
//  The four verdicts, each a REAL boot of dist/mercury.mjs in a PTY on a
//  seeded scratch home:
//    §A plain boot, signed out            → 0 catalogue requests
//    §B /model open, signed out           → 0 catalogue requests; the screen
//       carries the ruled row ("connect Hugging Face to browse its models")
//    §C fixture HF credential             → the catalogue fetch happens
//       against the loopback fixture (request ledger ≥1) and the fixture
//       rows RENDER in the picker
//    §D credential + MERCURY_DISABLE_NONESSENTIAL_TRAFFIC → 0 catalogue
//       requests; the screen names the switch
//
//  Catalogue needles are composed from parts — the tracked text never
//  spells a vendor catalogue host whole.
// ============================================================================
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const VSHOT = join(import.meta.dir, 'vshot.py')
const FIXTURE = join(import.meta.dir, 'huggingface-catalogue-fixture-server.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 300) : ''}`)
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`no POSIX pty capture driver on this host (${driver.kind}) — the tripwire drives cannot run here`)
  process.exit(1)
}
if (!existsSync(DIST)) {
  console.error('dist/mercury.mjs missing — bun run build.ts first')
  process.exit(1)
}

// ── the catalogue needles, composed from parts ──────────────────────────────
const J = (...parts: string[]): string => parts.join('')
const HF_ROUTER_HOST = J('router.', 'huggingface', '.co')
const OPENROUTER_HOST = J('open', 'router', '.ai')
const GEMINI_HOST = J('generative', 'language', '.googleapis', '.com')
const OPENAI_HOST = J('api.', 'openai', '.com')
const CATALOGUE_HOSTS = [HF_ROUTER_HOST, OPENROUTER_HOST, GEMINI_HOST, OPENAI_HOST]

const scratch = mkdtempSync(join(tmpdir(), 'catalogue-gating-tripwire-'))
const shimDir = join(scratch, 'bin')
const shimLog = join(scratch, 'shim.log')
mkdirSync(shimDir, { recursive: true })
for (const exe of ['git', 'ssh']) {
  const path = join(shimDir, exe)
  writeFileSync(path, `#!/bin/sh\necho "${exe} $*" >> "$SHIM_LOG"\nexit 128\n`)
  chmodSync(path, 0o755)
}

// ── the child tripwire: log everything, refuse everything non-loopback ──────
const preload = join(scratch, 'tripwire.cjs')
writeFileSync(
  preload,
  `'use strict'
const fs = require('node:fs')
const net = require('node:net')
const tls = require('node:tls')
const LOG = process.env.PROOF_NETLOG
const log = line => { try { fs.appendFileSync(LOG, line + '\\n') } catch {} }
const isLocal = host => host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === undefined || host === ''
const origConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const opts = typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], host: args[1] }
  if (opts.path) return origConnect.apply(this, args)
  const host = opts.host || 'localhost'
  if (isLocal(host)) { log('tcp-local ' + host + ':' + opts.port); return origConnect.apply(this, args) }
  log('tcp ' + host + ':' + opts.port)
  throw new Error('tripwire: tcp ' + host + ':' + opts.port)
}
const origTls = tls.connect
tls.connect = function (...args) {
  const opts = typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], host: args[1] }
  const host = opts.host || opts.servername || 'localhost'
  if (isLocal(host)) { log('tls-local ' + host + ':' + (opts.port ?? '')); return origTls.apply(this, args) }
  log('tls ' + host + ':' + (opts.port ?? ''))
  throw new Error('tripwire: tls ' + host)
}
for (const name of ['http', 'https']) {
  const m = require('node:' + name)
  for (const fn of ['request', 'get']) {
    const orig = m[fn].bind(m)
    m[fn] = (...args) => {
      const first = args[0]
      const target = typeof first === 'string' ? first : (first instanceof URL ? first.href : JSON.stringify({ host: first && first.host, hostname: first && first.hostname, path: first && first.path }))
      let host = ''
      try { host = typeof first === 'string' || first instanceof URL ? new URL(String(first)).hostname : String((first && (first.hostname || first.host)) || '') } catch {}
      if (isLocal(host.replace(/:.*$/, ''))) { log(name + '-local.' + fn + ' ' + target); return orig(...args) }
      log(name + '.' + fn + ' ' + target)
      throw new Error('tripwire: ' + name + '.' + fn + ' ' + target)
    }
  }
}
try { require('node:module').syncBuiltinESMExports() } catch {}
const origFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const target = typeof input === 'string' ? input : String((input && input.url) || input)
  let host = ''
  try { host = new URL(target).hostname } catch {}
  if (isLocal(host)) { log('fetch-local ' + target); return origFetch(input, init) }
  log('fetch ' + target)
  return Promise.reject(new Error('tripwire: fetch ' + target))
}
`,
)

const DEAD = 'http://127.0.0.1:9'
function childEnv(home: string, netlog: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${shimDir}:${process.env.PATH ?? ''}`,
    SHIM_LOG: shimLog,
    PROOF_NETLOG: netlog,
    NODE_OPTIONS: `--require ${preload}`,
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
    // The display animations every capture pins still (the critter's sway
    // and blink, its gaze and sleep, the header's live seconds, the live
    // glyphs): a settle gate reads the whole grid, and a recorded frame
    // must never land on an arbitrary animation phase.
    MERCURY_CRITTER_IDLE: '0',    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',   MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    ANTHROPIC_BASE_URL: DEAD,
    BROWSER: 'true',
  }
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'HF_TOKEN',
    'ZAI_API_KEY',
    'MOONSHOT_API_KEY',
    'DEEPSEEK_API_KEY',
    'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC',
    'NODE_ENV',
    'CI',
  ]) {
    delete env[key]
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

const netlines = (netlog: string): string[] =>
  existsSync(netlog) ? readFileSync(netlog, 'utf8').split('\n').filter(l => l.trim() !== '') : []
/** Catalogue-shaped traffic: any non-loopback line naming a catalogue host,
 *  or any line (loopback included) whose target carries /models or /key —
 *  except the legs where the loopback fixture IS the catalogue, counted
 *  separately via the fixture's own ledger. */
const catalogueLines = (lines: string[], opts?: { allowLoopbackModels?: boolean }): string[] =>
  lines.filter(line => {
    const local = line.startsWith('tcp-local') || line.startsWith('tls-local') || line.includes('-local.') || line.startsWith('fetch-local')
    if (CATALOGUE_HOSTS.some(h => line.includes(h))) return true
    if (/\/(v1\/)?models(\?|\s|$)/.test(line) || /\/key(\?|\s|$)/.test(line)) {
      return local ? !(opts?.allowLoopbackModels ?? false) : true
    }
    return false
  })

console.log('============================================================')
console.log(' catalogue gating — the zero-network tripwire on the bundle')
console.log('============================================================')

// ── §0 poison controls: the tripwire must be seen working, both ways ────────
console.log('[0] poison controls — the tripwire trips, and loopback passes')
{
  const netlog = join(scratch, 'poison-net.log')
  const env = childEnv(join(scratch, 'poison-home'), netlog)
  let httpTripped = false
  try {
    execFileSync('node', ['-e', "require('node:http').get('http://203.0.113.1:80/')"], { env, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    httpTripped = true
  }
  let fetchTripped = false
  try {
    execFileSync('node', ['-e', "fetch('http://203.0.113.9:80/v1/models').then(() => process.exit(0), () => process.exit(3))"], { env, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    fetchTripped = true
  }
  let tlsTripped = false
  try {
    execFileSync('node', ['-e', "require('node:tls').connect({ host: '203.0.113.5', port: 443 })"], { env, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    tlsTripped = true
  }
  const seen = netlines(netlog)
  check('control: http.get to a poison host trips and logs', httpTripped && seen.some(l => l.startsWith('http.get')), seen.join(' · '))
  check('control: fetch to a poison host trips and logs (a /models spelling counts as catalogue)', fetchTripped && seen.some(l => l.startsWith('fetch ')) && catalogueLines(seen).length > 0, seen.join(' · '))
  check('control: raw TLS to a poison host trips and logs', tlsTripped && seen.some(l => l.startsWith('tls ')), seen.join(' · '))
  // The pass-through control: a loopback GET must SUCCEED under the preload.
  const fixture = spawn(process.execPath, ['run', FIXTURE, '0', join(scratch, 'poison-ledger.log')], { stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolvePort, reject) => {
    const killer = setTimeout(() => reject(new Error('fixture never printed PORT')), 15_000)
    fixture.stdout.on('data', (chunk: Buffer) => {
      const m = /PORT (\d+)/.exec(chunk.toString())
      if (m) {
        clearTimeout(killer)
        resolvePort(Number(m[1]))
      }
    })
  })
  let loopbackOk = false
  try {
    const out = execFileSync(
      'node',
      ['-e', `fetch('http://127.0.0.1:${port}/v1/models').then(r => r.json()).then(j => { console.log(j.data.length) ; process.exit(0) }, e => { console.error(String(e)); process.exit(3) })`],
      { env, timeout: 20_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    loopbackOk = out.trim().endsWith('2')
  } catch {
    loopbackOk = false
  }
  check('control: a loopback GET passes the tripwire and answers (2 rows)', loopbackOk)
  fixture.kill('SIGTERM')
  rmSync(netlog, { force: true })
  rmSync(shimLog, { force: true })
}

// ── the PTY drive helper ────────────────────────────────────────────────────
interface DriveResult {
  status: number | null
  gridText: string
  stderr: string
}
function drive(tag: string, home: string, netlog: string, sends: unknown[], total: number, extraEnv: Record<string, string | undefined>): DriveResult {
  const grid = join(scratch, `${tag}-grid.json`)
  const cfgPath = join(scratch, `${tag}-vshot.json`)
  // CATGATE_DEBUG_FILE=<path> hands the child the product's own debug log
  // (--debug --debug-file=<path>.<tag>.log): a drive whose screen shows
  // nothing is read from what the product logged while it showed nothing.
  const debugFile = process.env.CATGATE_DEBUG_FILE
  const argv = debugFile ? ['node', DIST, '--debug', `--debug-file=${debugFile}.${tag}.log`] : ['node', DIST]
  writeFileSync(cfgPath, JSON.stringify({ argv, sends, total, cols: 120, rows: 40, out: grid, title: tag }))
  const res = spawnSync(driver.python, [VSHOT, cfgPath], {
    encoding: 'utf-8',
    env: childEnv(home, netlog, extraEnv),
    cwd: ROOT,
    timeout: vshotBudgetMs(120_000),
  })
  let gridText = ''
  if (existsSync(grid)) {
    const payload = JSON.parse(readFileSync(grid, 'utf8')) as {
      grid?: Array<Array<{ c: string }>>
      marks?: Array<{ label: string; grid: Array<Array<{ c: string }>> }>
    }
    const text = (g: Array<Array<{ c: string }>>): string => g.map(row => row.map(c => c.c).join('')).join('\n')
    gridText = [...(payload.marks ?? []).map(m => text(m.grid)), payload.grid ? text(payload.grid) : ''].join('\n')
  }
  // A refused drive still wrote the grid it ended on: print that frame's
  // tail beside the refusal, so a red leg says what the screen held.
  if (res.status !== 0 && gridText !== '') {
    // Every mark's tail first (the moment each send landed), then the
    // final frame — a refusal is read as a sequence, not one still.
    if (existsSync(grid)) {
      const payload = JSON.parse(readFileSync(grid, 'utf8')) as { marks?: Array<{ label: string; grid: Array<Array<{ c: string }>> }> }
      for (const m of payload.marks ?? []) {
        const rows = m.grid.map(row => row.map(c => c.c).join('').trimEnd()).filter(r => r.length > 0)
        console.log(`  mark '${m.label}' (last ${Math.min(8, rows.length)} non-empty rows):`)
        for (const row of rows.slice(-8)) console.log(`    ${row.slice(0, 116)}`)
      }
    }
    const rows = gridText.split('\n').map(r => r.trimEnd()).filter(r => r.length > 0)
    console.log(`  the frame the drive ended on (last ${Math.min(14, rows.length)} non-empty rows):`)
    for (const row of rows.slice(-14)) console.log(`    ${row.slice(0, 116)}`)
  }
  return { status: res.status, gridText, stderr: (res.stderr ?? '').trim() }
}
const seededHome = (name: string): string => {
  const home = join(scratch, name)
  seedFirstRun(home, [ROOT])
  return home
}

// ── §A plain boot, signed out ───────────────────────────────────────────────
console.log('[A] plain boot on a fresh scratch home, signed out — zero catalogue requests')
{
  const netlog = join(scratch, 'boot-net.log')
  const res = drive(
    'plain-boot',
    seededHome('home-a'),
    netlog,
    [
      { atTick: 25, awaitText: '❯', minTick: 5, data: '' },
      { afterPrevTicks: 20, data: '' },
    ],
    55,
    {},
  )
  check('the boot reached the composer (a real boot, not a crash)', res.status === 0 && res.gridText.includes('❯'), `vshot ${res.status}: ${res.stderr.slice(-200)}`)
  const lines = netlines(netlog)
  const catalogue = catalogueLines(lines)
  check('ZERO catalogue requests at boot (count 0)', catalogue.length === 0, catalogue.join(' · '))
  check('zero non-loopback requests of any kind at boot', lines.every(l => l.startsWith('tcp-local') || l.startsWith('tls-local') || l.includes('-local.') || l.startsWith('fetch-local')), lines.filter(l => !(l.startsWith('tcp-local') || l.startsWith('tls-local') || l.includes('-local.') || l.startsWith('fetch-local'))).join(' · '))
}

// ── §B /model open, signed out ──────────────────────────────────────────────
console.log('[B] the /model picker opened signed out — zero catalogue requests, the ruled row')
{
  const netlog = join(scratch, 'picker-net.log')
  const res = drive(
    'signed-out-picker',
    seededHome('home-b'),
    netlog,
    [
      // THE LANDING RULE: a bare
      // boot lands on the Boot face — ↵ on New Session enters the chat first.
      { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { atTick: 60, data: '/model', awaitText: 'Type a prompt', minTick: 5, requireAwait: true },
      // Two moments a refusal is read from: the typed line in the composer,
      // and the screen the ↵ left behind.
      { afterPrevTicks: 2, mark: 'typed', data: '' },
      { afterPrevTicks: 2, data: '\r' },
      { afterPrevTicks: 3, mark: 'entered', data: '' },
      // The picker's lockup line paints in EVERY form of the picker — the
      // compact tier (under ~20 rows) sheds the CHOOSE A MODEL banner with
      // the rest of its decoration, the lockup stays — so it is the one
      // honest "opened" needle.
      { requireAwait: true, awaitText: 'Mercury — model', awaitStableTicks: 3, mark: 'open', data: '' },
      // The Hugging Face group sits below the fold: walk the list in
      // strides of FOUR with a mark after each, and read every mark's grid.
      // The picker opens with its window centred on the current model, and
      // that window holds about eight ENTRIES once the group headings, the
      // frontier lines and the detail lines are counted — a stride longer
      // than the window's entry count lands the next window past rows the
      // last one never showed (strides of ten skipped the one-row Hugging
      // Face group between Gemini's window and Z.AI's). Four keeps every
      // consecutive pair of windows overlapping; the list clamps at its
      // last row, so a long walk never overshoots into nothing.
      { afterPrevTicks: 4, data: '\x1b[B'.repeat(4) },
      { afterPrevTicks: 3, mark: 'walk-1', data: '' },
      { afterPrevTicks: 1, data: '\x1b[B'.repeat(4) },
      { afterPrevTicks: 3, mark: 'walk-2', data: '' },
      { afterPrevTicks: 1, data: '\x1b[B'.repeat(4) },
      { afterPrevTicks: 3, mark: 'walk-3', data: '' },
      { afterPrevTicks: 1, data: '\x1b[B'.repeat(4) },
      { afterPrevTicks: 3, mark: 'walk-4', data: '' },
      { afterPrevTicks: 1, data: '\x1b[B'.repeat(4) },
      { afterPrevTicks: 3, mark: 'walk-5', data: '' },
      { afterPrevTicks: 1, data: '\x1b[B'.repeat(4) },
      { afterPrevTicks: 3, mark: 'walk-6', data: '' },
      { afterPrevTicks: 1, data: '\x1b[B'.repeat(4) },
      { afterPrevTicks: 4, mark: 'settled', data: '' },
    ],
    130,
    {},
  )
  check('the picker opened (a real drive)', res.status === 0 && res.gridText.includes('Mercury — model'), `vshot ${res.status}: ${res.stderr.slice(-200)}`)
  const lines = netlines(netlog)
  const catalogue = catalogueLines(lines)
  check('ZERO catalogue requests from the signed-out picker (count 0)', catalogue.length === 0, catalogue.join(' · '))
  // A miss names the rows the walk did paint for the group, so a moved
  // spelling or a group out of the read is told from a group absent.
  const rowsOf = (needle: string): string => [...new Set(res.gridText.split('\n').filter(l => l.toLowerCase().includes(needle)).map(l => l.replace(/[│╭╮╰╯─]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90)))].join(' | ') || '(no row)'
  const hfOnScreen = res.gridText.includes('connect Hugging Face to browse its models')
  if (!hfOnScreen) {
    // The whole walk, distinct rows in order: a group the walk never showed
    // reads as absent from these lines, a moved spelling reads as present.
    const seen = [...new Set(res.gridText.split('\n').map(l => l.replace(/[│╭╮╰╯─]/g, '').replace(/\s+/g, ' ').trim()).filter(l => l.length > 0))]
    console.log(`  the walk's rows (${seen.length} distinct):`)
    for (const row of seen) console.log(`    ${row.slice(0, 110)}`)
  }
  check('the ruled Hugging Face row is on the screen', hfOnScreen, `${rowsOf('hugging')} · headings seen: ${rowsOf('mercury —')}`)
  check('the ruled OpenRouter row is on the screen', res.gridText.includes('connect OpenRouter to browse its models'), rowsOf('openrouter'))
}

// ── §C the fixture credential: the fetch happens and renders ────────────────
console.log('[C] a fixture HF credential — the catalogue fetch happens against the loopback fixture and renders')
{
  const netlog = join(scratch, 'credential-net.log')
  const ledger = join(scratch, 'credential-ledger.log')
  const fixture = spawn(process.execPath, ['run', FIXTURE, '0', ledger], { stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolvePort, reject) => {
    const killer = setTimeout(() => reject(new Error('fixture never printed PORT')), 15_000)
    fixture.stdout.on('data', (chunk: Buffer) => {
      const m = /PORT (\d+)/.exec(chunk.toString())
      if (m) {
        clearTimeout(killer)
        resolvePort(Number(m[1]))
      }
    })
  })
  const res = drive(
    'fixture-credential',
    seededHome('home-c'),
    netlog,
    [
      // THE LANDING RULE: a bare
      // boot lands on the Boot face — ↵ on New Session enters the chat first.
      { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { atTick: 60, data: '/model', awaitText: 'Type a prompt', minTick: 5, requireAwait: true },
      { afterPrevTicks: 4, data: '\r' },
      { requireAwait: true, awaitText: 'Mercury — model', awaitStableTicks: 3, mark: 'open', data: '' },
      // 14 steps bring the Hugging Face group into the viewport.
      { afterPrevTicks: 4, data: '\x1b[B'.repeat(14) },
      { requireAwait: true, awaitText: 'catgate', awaitStableTicks: 2, mark: 'landed', data: '' },
      { afterPrevTicks: 3, data: '' },
    ],
    90,
    {
      HF_TOKEN: 'hf_fixture_catgate_token_000001',
      MERCURY_HUGGINGFACE_API_BASE: `http://127.0.0.1:${port}/v1`,
    },
  )
  fixture.kill('SIGTERM')
  check('the drive delivered (picker opened, fixture rows landed)', res.status === 0, `vshot ${res.status}: ${res.stderr.slice(-250)}`)
  const served = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(l => l.includes('/models')) : []
  check('the fixture served the catalogue fetch (request count ≥ 1)', served.length >= 1, `served ${served.length}`)
  check('the fixture rows RENDER in the picker', res.gridText.includes('catgate'), res.gridText.split('\n').filter(l => l.includes('Hugging Face')).join(' · '))
  const lines = netlines(netlog)
  const nonLoopbackCatalogue = catalogueLines(lines, { allowLoopbackModels: true })
  check('no catalogue request left loopback (count 0 beyond the fixture)', nonLoopbackCatalogue.length === 0, nonLoopbackCatalogue.join(' · '))
}

// ── §D credential + the essential-traffic switch ────────────────────────────
console.log('[D] credential + MERCURY_DISABLE_NONESSENTIAL_TRAFFIC — zero catalogue requests, the named switch')
{
  const netlog = join(scratch, 'switch-net.log')
  const ledger = join(scratch, 'switch-ledger.log')
  const fixture = spawn(process.execPath, ['run', FIXTURE, '0', ledger], { stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolvePort, reject) => {
    const killer = setTimeout(() => reject(new Error('fixture never printed PORT')), 15_000)
    fixture.stdout.on('data', (chunk: Buffer) => {
      const m = /PORT (\d+)/.exec(chunk.toString())
      if (m) {
        clearTimeout(killer)
        resolvePort(Number(m[1]))
      }
    })
  })
  const res = drive(
    'switch-off',
    seededHome('home-d'),
    netlog,
    [
      // THE LANDING RULE: a bare
      // boot lands on the Boot face — ↵ on New Session enters the chat first.
      { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { atTick: 60, data: '/model', awaitText: 'Type a prompt', minTick: 5, requireAwait: true },
      { requireAwait: true, awaitText: '❯ /model', awaitStableTicks: 2, data: '' },
      { afterPrevTicks: 2, data: '\r' },
      { requireAwait: true, awaitText: 'Mercury — model', awaitStableTicks: 3, mark: 'open', data: '' },
      // 14 steps bring the Hugging Face group into the viewport.
      { afterPrevTicks: 4, data: '\x1b[B'.repeat(14) },
      { afterPrevTicks: 15, mark: 'settled', data: '' },
    ],
    80,
    {
      HF_TOKEN: 'hf_fixture_catgate_token_000001',
      MERCURY_HUGGINGFACE_API_BASE: `http://127.0.0.1:${port}/v1`,
      MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  )
  fixture.kill('SIGTERM')
  check('the drive delivered (picker opened under the switch)', res.status === 0, `vshot ${res.status}: ${res.stderr.slice(-250)}`)
  const served = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(l => l.trim() !== '') : []
  check('the fixture served NOTHING (request count 0, credential present)', served.length === 0, served.join(' · '))
  const lines = netlines(netlog)
  const catalogue = catalogueLines(lines)
  check('ZERO catalogue requests with the switch on (count 0)', catalogue.length === 0, catalogue.join(' · '))
  check('the screen carries the traffic-off row on the Hugging Face group', res.gridText.includes('Hugging Face — catalogue off'), res.gridText.split('\n').filter(l => l.includes('Hugging Face')).join(' · '))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ CATALOGUE GATING — TRIPWIRE GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
