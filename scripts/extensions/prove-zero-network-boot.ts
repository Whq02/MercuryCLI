#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

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
  if (process.platform === 'win32') {
    const script = join(scratch, `${exe}-shim.mjs`)
    writeFileSync(script, `import { appendFileSync } from 'node:fs'\nappendFileSync(process.env.SHIM_LOG, '${exe} ' + process.argv.slice(2).join(' ') + '\\n')\nprocess.exit(128)\n`)
    const built = spawnSync(process.execPath, ['build', '--compile', script, '--outfile', join(shimDir, `${exe}.exe`)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    if (built.status !== 0) throw new Error(`the ${exe} shim did not compile: ${(built.stderr || built.stdout).trim()}`)
    continue
  }
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
process.env.PATH = `${shimDir}${delimiter}${process.env.PATH ?? ''}`
process.chdir(cwd)

const netHits: string[] = []
globalThis.fetch = ((input: unknown) => {
  const target = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input)
  netHits.push(`fetch ${target}`)
  throw new Error(`tripwire: fetch ${target}`)
}) as typeof fetch

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const records = await import('../../src/integrations/extensions/records.ts')
const rosterMod = await import('../../src/integrations/extensions/roster.ts')
const sourcesMod = await import('../../src/integrations/extensions/sources.ts')
const paths = await import('../../src/integrations/extensions/paths.ts')

console.log('============================================================')
console.log(' zero network — boot never fetches; no source without an act')
console.log('============================================================')

console.log('[1] a fresh home: four bundled extensions, no added source or request')
{
  const roster = rosterMod.computeRoster({ cwd })
  check('the three Craft bundles and disabled media bundle are present', JSON.stringify(roster.entries.map(e => e.name).sort()) === JSON.stringify(['filmcraft', 'lightcraft', 'mercury-media', 'photocraft']) && roster.entries.every(e => e.home === 'bundled') && roster.problems.length === 0, 'a fresh home must list exactly filmcraft, lightcraft, mercury-media and photocraft, all bundled, with no problems; fix computeRoster in src/integrations/extensions/roster.ts; entries: ' + JSON.stringify(roster.entries.map(e => [e.name, e.home])) + ' problems: ' + JSON.stringify(roster.problems))
  check('the media engine stays off', roster.entries.find(e => e.name === 'mercury-media')?.switchedOn === false && !existsSync(join(home, 'media', 'runtime.json')), 'mercury-media must stay switched off and boot must not write media/runtime.json in the config home; see computeRoster in src/integrations/extensions/roster.ts')
  check('no source exists', sourcesMod.listSources().length === 0, 'a fresh home must hold no source; find what adds one at boot, see listSources and addSource in src/integrations/extensions/sources.ts')
  check('only bundled approval records were created', !existsSync(paths.getSourcesFile()) && Object.values(records.installedOrEmpty()).every(r => r.label === 'mercury'), 'boot may write only approval records labelled mercury and must not create sources.json; see installedOrEmpty and updateSources in src/integrations/extensions/records.ts and getSourcesFile in src/integrations/extensions/paths.ts')
  check('no application runtime exists at boot', roster.entries.every(e => !existsSync(join(paths.getExtensionDataDir(e.id), 'runtime'))), 'boot must not create a runtime folder under any extension data dir; see getExtensionDataDir in src/integrations/extensions/paths.ts and remove the code that creates it at boot')
  check('no request left the process', netHits.length === 0, netHits.join(' · ') + ' — computeRoster and the extension load path must not fetch; remove the call named here (src/integrations/extensions/roster.ts)')
  check('no git/ssh spawned', shimHits() === '', shimHits() + ' — computeRoster and the extension load path must not spawn git or ssh; remove the call named here (src/integrations/extensions/roster.ts)')
}

console.log('[2] the built binary, headless, on a populated home: disk only')
if (!existsSync(DIST)) {
  console.log('  – dist/mercury.mjs absent — SKIP §2/§3 (build first: bun run build.ts)')
} else {
  const FIXTURE = join(import.meta.dir, 'fixtures', 'fixture-source')
  const folderSource = join(scratch, 'folder-source')
  cpSync(FIXTURE, folderSource, { recursive: true })
  const install = await import('../../src/integrations/extensions/install.ts')
  const added = await sourcesMod.addSource(folderSource, { label: 'fixture-source' })
  check('the populated home: source added (an operator act)', added.ok, 'addSource in src/integrations/extensions/sources.ts refused the folder copied from scripts/extensions/fixtures/fixture-source: ' + JSON.stringify(added))
  const installed = await install.installFromSource('fixture-source', 'kitchen-sink')
  check('the populated home: extension installed + approved', installed.ok && install.approve('kitchen-sink@fixture-source').ok, 'installFromSource or approve in src/integrations/extensions/install.ts failed for kitchen-sink@fixture-source: ' + JSON.stringify(installed))
  records.updateSources(current => ({
    ...current,
    'stale-remote': { kind: 'archive', where: 'http://203.0.113.7/crew.zip', ref: null, addedAt: '2026-01-01T00:00:00Z', checkedAt: '2026-01-01T00:00:00Z', commit: null, lastError: null },
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
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH')),
    PATH: process.env.PATH ?? '',
    SHIM_LOG: shimLog,
    PROOF_NETLOG: netlog,
    NODE_OPTIONS: `--require ${preload}`,
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    BROWSER: 'true',
  }
  {
    let poisoned = false
    try {
      execFileSync('node', ['-e', "require('node:http').get('http://203.0.113.1:80/')"], { env, cwd, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      poisoned = true
    }
    const seen = existsSync(netlog) ? readFileSync(netlog, 'utf8') : ''
    check('control: the child tripwire fires on a poisoned request', poisoned && seen.includes('http.get'), seen.trim() + ' — the control is broken, not the product; fix the tripwire.cjs preload text or the NODE_OPTIONS env in this script')
    try {
      execFileSync('git', ['--version'], { env, cwd, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
    }
    check('control: the git shim logs a spawn', shimHits().includes('git --version'), shimHits() + ' — the control is broken, not the product; fix the git shim or the PATH order set at the top of this script')
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
  check('the binary exits 0', code === 0, `exit ${code}; node dist/mercury.mjs extensions list --json must exit 0 on a populated home with the network blocked; read the child stderr line above and rebuild with bun run build.ts if dist is stale`)
  const parsed = JSON.parse(stdout.slice(stdout.indexOf('{'))) as { extensions: Array<{ id: string; trust: string }> }
  check('the roster answers from disk (the installed row is on)', parsed.extensions.some(e => e.id === 'kitchen-sink@fixture-source' && e.trust === 'on'), JSON.stringify(parsed.extensions) + ' — extensions list --json must read the installed row from disk; check how the list command reads installed.json (getInstalledFile in src/integrations/extensions/paths.ts)')
  const { Client, StdioClientTransport } = await import('../../src/integrations/mcp-shapes/sdk.ts')
  for (const entry of rosterMod.computeRoster({ cwd }).entries.filter(e => e.home === 'bundled' && ['filmcraft', 'lightcraft', 'photocraft'].includes(e.name))) {
    const client = new Client({ name: 'craft-zero-network', version: '1.0.0' })
    await client.connect(new StdioClientTransport({ command: 'node', args: [join(entry.root!, 'server', 'bridge.mjs')], env: { ...env, MERCURY_EXTENSION_DATA: paths.getExtensionDataDir(entry.id) } as Record<string, string>, stderr: 'pipe' }))
    try {
      const tools = await client.listTools()
      check(`${entry.name}: discovery exposes status/install/connect only`, JSON.stringify(tools.tools.map(t => t.name)) === JSON.stringify(['craft_status', 'craft_install', 'craft_connect']), 'a bundled Craft bridge must list only craft_status, craft_install and craft_connect before an install; fix the tool list of that extension server/bridge.mjs under src/integrations/extensions/bundled; got ' + JSON.stringify(tools.tools.map(t => t.name)))
      const status = await client.callTool({ name: 'craft_status', arguments: {} })
      check(`${entry.name}: status remains absent without an install`, !status.isError && JSON.stringify(status).includes('absent'), 'craft_status must answer absent without an error when nothing is installed; fix that extension server/bridge.mjs under src/integrations/extensions/bundled; got ' + JSON.stringify(status))
    } finally { await client.close() }
    check(`${entry.name}: discovery wrote no application runtime`, !existsSync(join(paths.getExtensionDataDir(entry.id), 'runtime')), 'discovery through the bridge must not create a runtime folder in the extension data dir; fix that extension server/bridge.mjs under src/integrations/extensions/bundled')
  }
  const net = existsSync(netlog) ? readFileSync(netlog, 'utf8').trim() : ''
  check('the boot made no outbound connection and no request (request log EMPTY)', net === '', net + ' — the built binary connected or requested during extensions list or bridge discovery; the logged line names it; remove that call from the boot path (src/integrations/extensions/boot.ts, roster.ts) and rebuild')
  check('the boot spawned no git/ssh', shimHits() === '', shimHits() + ' — the built binary spawned git or ssh during extensions list; remove that call from the boot path (src/integrations/extensions/boot.ts, roster.ts) and rebuild')
  check('sources.json is byte-identical after the boot', readFileSync(paths.getSourcesFile(), 'utf8') === sourcesBefore, 'extensions list and boot must not rewrite sources.json; find the updateSources call (src/integrations/extensions/records.ts) reached at boot, for example a checkedAt refresh')
  check('installed.json is byte-identical after the boot', readFileSync(paths.getInstalledFile(), 'utf8') === installedBefore, 'extensions list and boot must not rewrite installed.json; find the write reached at boot in src/integrations/extensions/records.ts or install.ts')

  console.log('[3] the built binary spells no vendor source')
  const dist = readFileSync(DIST, 'utf8')
  for (const [label, needle] of [
    ['the vendor store id (official)', VENDOR_MKT],
    ['the vendor store id (directory)', VENDOR_DIR_MKT],
    ['vendor org repository path', VENDOR_REPO],
    ['vendor mirror host', VENDOR_MIRROR],
    ['vendor statistics host path', VENDOR_STATS],
  ] as const) {
    check(`dist: no ${label}`, !dist.includes(needle), 'the built dist/mercury.mjs spells a vendor source; remove that string from src/ and rebuild with bun run build.ts')
  }
}

removeScratch(scratch)
console.log(failures === 0 ? '\n ✅ ZERO NETWORK — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
