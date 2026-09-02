#!/usr/bin/env bun
// ============================================================================
//  scripts/extensions/prove-zero-network-boot.ts — boot never touches the
//  network for extensions, and no source is ever added without an operator
//  act. The permanent tripwire.
//
//  §1 a fresh config home: the roster reads empty, reading adds no source
//     and writes no record, and no request leaves the process (in-process
//     fetch tripwire + git/ssh PATH shims).
//  §2 the built binary, headless, on a POPULATED home (a source + an
//     installed extension + a stale archive source): `extensions list
//     --json` answers from disk alone — no outbound TCP, no http(s)
//     request, no git/ssh spawn (tripwires inside the child; PATH shims) —
//     and the records are byte-identical after the boot.
//  §3 the built binary spells no vendor source: the other vendor's store
//     ids, org path, mirror host and statistics host ship nowhere
//     (composed needles).
// ============================================================================
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

// ── the vendor needles, composed ────────────────────────────────────────────
const J = (...parts: string[]): string => parts.join('')
const VENDOR_ORG = J('anthrop', 'ics')
const VENDOR_MKT = J('claude', '-plug', 'ins-', 'official')
const VENDOR_DIR_MKT = J('claude', '-plug', 'in-', 'directory')
const VENDOR_REPO = `${VENDOR_ORG}/${VENDOR_MKT}`
const VENDOR_MIRROR = J('downloads.', 'claude', '.ai')
const VENDOR_STATS = J('raw.githubusercontent.com/', VENDOR_ORG, '/')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

const scratch = mkdtempSync(join(tmpdir(), 'mercury-ext-zeronet-'))
const home = join(scratch, 'home')
const cwd = join(scratch, 'cwd')
const shimDir = join(scratch, 'bin')
const shimLog = join(scratch, 'shim.log')
mkdirSync(home, { recursive: true })
mkdirSync(cwd, { recursive: true })
mkdirSync(shimDir, { recursive: true })
for (const exe of ['git', 'ssh']) {
  const path = join(shimDir, exe)
  writeFileSync(path, `#!/bin/sh\necho "${exe} $*" >> "$SHIM_LOG"\nexit 128\n`)
  chmodSync(path, 0o755)
}
const shimHits = (): string => (existsSync(shimLog) ? readFileSync(shimLog, 'utf8').trim() : '')

delete process.env.NODE_ENV
delete process.env.CI
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.SHIM_LOG = shimLog
process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`
process.chdir(cwd)

// In-process network tripwire.
const netHits: string[] = []
globalThis.fetch = ((input: unknown) => {
  const target = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input)
  netHits.push(`fetch ${target}`)
  throw new Error(`tripwire: fetch ${target}`)
}) as typeof fetch

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const records = await import('../../src/extensions/records.ts')
const rosterMod = await import('../../src/extensions/roster.ts')
const sourcesMod = await import('../../src/extensions/sources.ts')
const paths = await import('../../src/extensions/paths.ts')

console.log('============================================================')
console.log(' zero network — boot never fetches; no source without an act')
console.log('============================================================')

// ── §1 a fresh home in-process ──────────────────────────────────────────────
console.log('[1] a fresh home: empty roster, nothing added, no request')
{
  const roster = rosterMod.computeRoster({ cwd })
  check('the roster reads empty', roster.entries.length === 0 && roster.problems.length === 0)
  check('no source exists', sourcesMod.listSources().length === 0)
  check('reading created no records file', !existsSync(paths.getSourcesFile()) && !existsSync(paths.getInstalledFile()))
  check('no request left the process', netHits.length === 0, netHits.join(' · '))
  check('no git/ssh spawned', shimHits() === '', shimHits())
}

// ── §2 the built binary on a populated home ─────────────────────────────────
console.log('[2] the built binary, headless, on a populated home: disk only')
if (!existsSync(DIST)) {
  console.log('  – dist/mercury.mjs absent — SKIP §2/§3 (build first: bun run build.ts)')
} else {
  // Populate: a folder source + an installed, approved extension + a stale
  // remote-archive source whose URL would be fetched by any silent updater.
  const FIXTURE = join(import.meta.dir, 'fixtures', 'fixture-source')
  const folderSource = join(scratch, 'folder-source')
  cpSync(FIXTURE, folderSource, { recursive: true })
  const install = await import('../../src/extensions/install.ts')
  const added = await sourcesMod.addSource(folderSource, { label: 'fixture-source' })
  check('the populated home: source added (an operator act)', added.ok)
  const installed = await install.installFromSource('fixture-source', 'kitchen-sink')
  check('the populated home: extension installed + approved', installed.ok && install.approve('kitchen-sink@fixture-source').ok)
  records.updateSources(current => ({
    ...current,
    'stale-remote': { kind: 'archive', where: 'http://203.0.113.7/team.zip', ref: null, addedAt: '2026-01-01T00:00:00Z', checkedAt: '2026-01-01T00:00:00Z', commit: null, lastError: null },
  }))

  const netlog = join(scratch, 'net.log')
  const preload = join(scratch, 'tripwire.cjs')
  writeFileSync(
    preload,
    `'use strict'
const fs = require('node:fs')
const net = require('node:net')
const LOG = process.env.PROOF_NETLOG
const log = line => { try { fs.appendFileSync(LOG, line + '\\n') } catch {} }
const origConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const opts = typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], host: args[1] }
  if (opts.path) return origConnect.apply(this, args)
  log('tcp ' + (opts.host || 'localhost') + ':' + opts.port)
  throw new Error('tripwire: tcp ' + (opts.host || 'localhost') + ':' + opts.port)
}
for (const name of ['http', 'https']) {
  const m = require('node:' + name)
  for (const fn of ['request', 'get']) {
    m[fn] = (...args) => { const t = typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0]); log(name + '.' + fn + ' ' + t); throw new Error('tripwire: ' + name + '.' + fn) }
  }
}
try { require('node:module').syncBuiltinESMExports() } catch {}
globalThis.fetch = (input) => { const t = typeof input === 'string' ? input : String(input && input.url || input); log('fetch ' + t); return Promise.reject(new Error('tripwire: fetch ' + t)) }
`,
  )
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${shimDir}:${process.env.PATH ?? ''}`,
    SHIM_LOG: shimLog,
    PROOF_NETLOG: netlog,
    NODE_OPTIONS: `--require ${preload}`,
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    BROWSER: 'true',
  }
  // Poison controls first: silence below proves nothing until the wires are
  // SEEN firing on a child that does reach out.
  {
    let poisoned = false
    try {
      execFileSync('node', ['-e', "require('node:http').get('http://203.0.113.1:80/')"], { env, cwd, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      poisoned = true
    }
    const seen = existsSync(netlog) ? readFileSync(netlog, 'utf8') : ''
    check('control: the child tripwire fires on a poisoned request', poisoned && seen.includes('http.get'), seen.trim())
    try {
      execFileSync('git', ['--version'], { env, cwd, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      // the shim exits 128 by design
    }
    check('control: the git shim logs a spawn', shimHits().includes('git --version'), shimHits())
    rmSync(netlog, { force: true })
    rmSync(shimLog, { force: true })
  }

  const sourcesBefore = readFileSync(paths.getSourcesFile(), 'utf8')
  const installedBefore = readFileSync(paths.getInstalledFile(), 'utf8')
  let stdout = ''
  let code = 0
  try {
    stdout = execFileSync('node', [DIST, 'extensions', 'list', '--json'], { encoding: 'utf8', env, cwd, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const failed = error as { status?: number | null; stdout?: string; stderr?: string }
    code = failed.status ?? 1
    stdout = failed.stdout ?? ''
    console.log(`     child stderr: ${(failed.stderr ?? '').trim().slice(0, 300)}`)
  }
  check('the binary exits 0', code === 0, `exit ${code}`)
  const parsed = JSON.parse(stdout.slice(stdout.indexOf('{'))) as { extensions: Array<{ id: string; trust: string }> }
  check('the roster answers from disk (the installed row is on)', parsed.extensions.some(e => e.id === 'kitchen-sink@fixture-source' && e.trust === 'on'), JSON.stringify(parsed.extensions))
  const net = existsSync(netlog) ? readFileSync(netlog, 'utf8').trim() : ''
  check('the boot made no outbound connection and no request (request log EMPTY)', net === '', net)
  check('the boot spawned no git/ssh', shimHits() === '', shimHits())
  check('sources.json is byte-identical after the boot', readFileSync(paths.getSourcesFile(), 'utf8') === sourcesBefore)
  check('installed.json is byte-identical after the boot', readFileSync(paths.getInstalledFile(), 'utf8') === installedBefore)

  // ── §3 the vendor needles ─────────────────────────────────────────────────
  console.log('[3] the built binary spells no vendor source')
  const dist = readFileSync(DIST, 'utf8')
  for (const [label, needle] of [
    ['the vendor store id (official)', VENDOR_MKT],
    ['the vendor store id (directory)', VENDOR_DIR_MKT],
    ['vendor org repository path', VENDOR_REPO],
    ['vendor mirror host', VENDOR_MIRROR],
    ['vendor statistics host path', VENDOR_STATS],
  ] as const) {
    check(`dist: no ${label}`, !dist.includes(needle))
  }
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ ZERO NETWORK — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
