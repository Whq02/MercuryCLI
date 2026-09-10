import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs, type AvailableCaptureDriver } from '../lib/captureDriver.ts'
import { describeCapturePreflight, preflightCaptureDriver } from '../lib/capturePreflight.ts'
import { resolveExecutionProfile } from '../lib/executionProfile.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

export const ROOT = resolve(import.meta.dir, '..', '..')
export const DIST = join(ROOT, 'dist', 'mercury.mjs')
export const ADMITTED = ' · ready'
const VENDORED_NODE = join(ROOT, 'dist', 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
export function productNode(): string {
  return existsSync(VENDORED_NODE) ? VENDORED_NODE : (Bun.which('node') ?? 'node')
}
export const FACE_READY = '↑↓ choose'
export const SIZES: ReadonlyArray<{ cols: number; rows: number }> = [
  { cols: 80, rows: 24 },
  { cols: 120, rows: 40 },
]

let failures = 0
let checks = 0
export function check(label: string, cond: boolean, detail = ''): void {
  checks += 1
  if (!cond) failures += 1
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
export function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}`)
}
export function finish(name: string): never {
  console.log(`\n${name}: ${checks} checks, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

export function requireCaptureDriver(suite: string): AvailableCaptureDriver {
  const driver = resolveCaptureDriver()
  const hosted = resolveExecutionProfile(ROOT).kind === 'hosted-gate'
  const refuse = (reason: string): never => {
    if (hosted) {
      console.error(`  [FAIL] the hosted gate cannot capture — ${reason}`)
      process.exit(1)
    }
    console.log(`__SUITE_SKIPPED ${suite}: ${reason}`)
    process.exit(0)
  }
  if (driver.kind === 'unavailable') return refuse(`${driver.reason} (${driver.remedy})`)
  if (driver.kind !== 'posix-pty') return refuse(`the ${driver.kind} capture driver is not driven by this suite`)
  const preflight = preflightCaptureDriver(driver, ROOT)
  if (!preflight.ok) return refuse(describeCapturePreflight(preflight))
  if (!existsSync(DIST)) {
    console.error('dist/mercury.mjs missing — build first')
    process.exit(1)
  }
  return driver
}

export const scratch = mkdtempSync(join(tmpdir(), 'computer-drive-'))
const shimDir = join(scratch, 'bin')
mkdirSync(shimDir, { recursive: true })
for (const exe of ['git', 'ssh']) {
  const path = join(shimDir, exe)
  writeFileSync(path, '#!/bin/sh\nexit 128\n')
  chmodSync(path, 0o755)
}

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
  const head = Array.isArray(args[0]) ? args[0][0] : args[0]
  const opts = typeof head === 'object' && head !== null ? head : { port: head, host: args[1] }
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

export interface Leg {
  tag: string
  home: string
  fixture: FixtureApi
  scene: string | null
  log: string
  netlog: string
}

export function seededHome(name: string): string {
  const home = join(scratch, name)
  seedFirstRun(home, [ROOT])
  return home
}

export function writeScene(name: string, scene: Record<string, unknown>): string {
  const path = join(scratch, `${name}.json`)
  writeFileSync(path, JSON.stringify(scene))
  return path
}

export async function startLeg(tag: string, turns: ScriptedTurn[], scene: Record<string, unknown> | null): Promise<Leg> {
  const scripted = turns.map(turn => (turn.whenModel === undefined ? { ...turn, whenModel: 'opus' } : turn))
  const fixture = await startFixtureApi(scripted)
  return {
    tag,
    home: seededHome(`home-${tag}`),
    fixture,
    scene: scene === null ? null : writeScene(`scene-${tag}`, scene),
    log: join(scratch, `${tag}-acts.jsonl`),
    netlog: join(scratch, `${tag}-net.log`),
  }
}

export async function endLeg(leg: Leg): Promise<void> {
  await leg.fixture.close()
}

export function childEnv(leg: Leg, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}`,
    PROOF_NETLOG: leg.netlog,
    NODE_OPTIONS: `--require ${preload}`,
    MERCURY_CONFIG_DIR: leg.home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_OPERATOR: 'sam',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_DAEMON_DIR: join(leg.home, 'daemon'),
    MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_UPDATE_NOTICE: '0',
    ANTHROPIC_BASE_URL: leg.fixture.url,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    BROWSER: '/usr/bin/true',
    MERCURY_COMPUTER_USE: '1',
    MERCURY_DESKTOP_DRIVER: 'fake',
    MERCURY_DESKTOP_FAKE_LOG: leg.log,
    ...(leg.scene === null ? {} : { MERCURY_DESKTOP_FAKE_SCENE: leg.scene }),
  }
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'MERCURY_DESKTOP_PACK_DIR', 'MERCURY_CONCOURSE', 'MERCURY_CONCOURSE_FIXTURE', 'NODE_ENV', 'CI']) {
    delete env[key]
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

export interface DriveResult {
  status: number | null
  marks: Record<string, string[]>
  final: string[]
  stderr: string
  endReason: string
}

export function drive(driver: AvailableCaptureDriver, leg: Leg, size: { cols: number; rows: number }, sends: unknown[], total: number, extra: Record<string, string | undefined> = {}): DriveResult {
  const tag = `${leg.tag}-${size.cols}x${size.rows}`
  const grid = join(scratch, `${tag}-grid.json`)
  const cfgPath = join(scratch, `${tag}-vshot.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: [productNode(), DIST, '--chat'], sends, total, cols: size.cols, rows: size.rows, out: grid, title: tag }))
  const res = spawnSync(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], {
    encoding: 'utf-8',
    env: childEnv(leg, extra),
    cwd: ROOT,
    timeout: vshotBudgetMs(total * 200 + 60_000),
  })
  const marks: Record<string, string[]> = {}
  let final: string[] = []
  let endReason = ''
  if (existsSync(grid)) {
    const payload = JSON.parse(readFileSync(grid, 'utf8')) as {
      grid?: Array<Array<{ c: string }>>
      marks?: Array<{ label: string; grid: Array<Array<{ c: string }>> }>
      endReason?: string
    }
    const rows = (g: Array<Array<{ c: string }>>): string[] => g.map(row => row.map(c => c.c).join('').replace(/\s+$/, ''))
    for (const m of payload.marks ?? []) marks[m.label] = rows(m.grid)
    final = payload.grid ? rows(payload.grid) : []
    endReason = payload.endReason ?? ''
  }
  return { status: res.status, marks, final, stderr: (res.stderr ?? '').trim(), endReason }
}

export const rowsHaving = (rows: string[], needle: string): boolean => rows.some(r => r.includes(needle))
export const joined = (rows: string[]): string => rows.join(' ').replace(/\s+/g, ' ')
export const optionsRow = (rows: string[]): boolean => rows.some(r => /(?:❯\s*)?1\. Yes/.test(r))

export function printFrame(label: string, rows: string[]): void {
  console.log(`\n┌── ${label} ──`)
  for (const r of rows) console.log(`│${r}`)
  console.log('└──')
}

export function sessionFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sessionFiles(path))
    else if (name.endsWith('.jsonl')) out.push(path)
  }
  return out
}

export function netlines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(l => l.trim() !== '') : []
}
export function nonLoopback(lines: string[]): string[] {
  return lines.filter(l => !(l.startsWith('tcp-local') || l.startsWith('tls-local') || l.startsWith('fetch-local')))
}

export function actLog(path: string): Array<{ act: string; outcome: string; detail: Record<string, unknown> }> {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as { act: string; outcome: string; detail: Record<string, unknown> })
}

export const OPENING = (prompt: string): unknown[] => [
  { atTick: 40, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, data: '\r' },
  { atTick: 110, data: prompt, awaitText: ADMITTED, minTick: 5, awaitStableTicks: 2 },
  { afterPrevTicks: 3, data: '\r' },
]
