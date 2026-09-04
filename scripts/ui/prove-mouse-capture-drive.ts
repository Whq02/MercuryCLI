#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-mousecap-')))
const TEMPLATE = join(SCRATCH, 'home-template')
const FOLDER = join(SCRATCH, 'folder')
mkdirSync(TEMPLATE, { recursive: true })
mkdirSync(FOLDER, { recursive: true })
writeFileSync(join(FOLDER, 'README.md'), '# folder\n')
process.env.MERCURY_CONFIG_DIR = TEMPLATE
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_DAEMON_DIR
delete process.env.MERCURY_CONCOURSE

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { resolveCaptureDriver } = await import('../lib/captureDriver.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-mouse-capture-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

seedFirstRun(TEMPLATE, [FOLDER])

const READY_LINE = '↵ start  ·  m menu  ·  ↑↓ choose'
const COMPOSER = 'Type a prompt'
const CHIP = 'mouse off — native copy sweeps rails'
const WARM_TICKS = 25
const MOUSE_SETS = ['\x1b[?1000h', '\x1b[?1002h', '\x1b[?1003h', '\x1b[?1006h']

type Send = Record<string, unknown>
type Capture = { text: string; lines: string[]; status: number; tail: string; wire: string }

function freshHome(id: string, mouseCapture: boolean | null): string {
  const home = join(SCRATCH, `home-${id}`)
  cpSync(TEMPLATE, home, { recursive: true })
  if (mouseCapture !== null) {
    const cfgPath = join(home, '.mercury.json')
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
    cfg.mouseCapture = mouseCapture
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  }
  return home
}

function wireOf(path: string): string {
  if (!existsSync(path)) return ''
  const buf = readFileSync(path)
  const parts: string[] = []
  let i = 0
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4)
    parts.push(buf.subarray(i + 8, i + 8 + len).toString('latin1'))
    i += 8 + len
  }
  return parts.join('')
}

function reapHome(home: string): void {
  for (const rec of Object.values(readSessionWorkers(join(home, 'daemon')))) {
    if (rec.pid !== undefined) {
      try {
        process.kill(rec.pid, 'SIGTERM')
      } catch {
      }
    }
  }
  try {
    const pidFile = join(home, 'daemon', 'daemon.pid')
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM')
    }
  } catch {
  }
}

async function capture(opts: { id: string; home: string; sends: Send[]; ready: string; total?: number }): Promise<Capture> {
  const api = await startFixtureApi([{ kind: 'text', text: 'Spare.' }, { kind: 'text', text: 'Spare.' }])
  const cfgPath = join(SCRATCH, `cfg-${opts.id}.json`)
  const outPath = join(SCRATCH, `grid-${opts.id}.json`)
  const teePath = join(SCRATCH, `tee-${opts.id}.bin`)
  writeFileSync(
    cfgPath,
    JSON.stringify({
      argv: ['node', BIN, '--model', 'claude-sonnet-5'],
      cwd: FOLDER,
      cols: 120,
      rows: 40,
      sends: opts.sends,
      readyText: opts.ready,
      readySettleTicks: 3,
      total: opts.total ?? 200,
      out: outPath,
    }),
  )
  const child = spawn(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], {
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: opts.home,
      MERCURY_LIVE_GLYPHS: '0',
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: api.url,
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
      VSHOT_TEE: teePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const result = await new Promise<Capture>(resolvePromise => {
    let tail = ''
    child.stdout.on('data', d => (tail = (tail + String(d)).slice(-600)))
    child.stderr.on('data', d => (tail = (tail + String(d)).slice(-600)))
    child.on('close', status => {
      let text = ''
      let lines: string[] = []
      try {
        const payload = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown>
        const grid = payload.grid as Array<Array<{ c: string }>>
        lines = grid.map(row => row.map(cell => cell.c).join(''))
        text = lines.join('\n')
      } catch {
      }
      resolvePromise({ text, lines, status: status ?? 1, tail, wire: wireOf(teePath) })
    })
  })
  try {
    await api.close()
  } catch {
  }
  reapHome(opts.home)
  return result
}

const g = (needle: string, data: string, extra: Send = {}): Send => ({ atTick: 999, requireAwait: true, awaitText: needle, minTick: 5, awaitSettleTicks: 2, data, ...extra })
const INTO_THE_CHAT: Send[] = [g(READY_LINE, ''), { afterPrevTicks: WARM_TICKS, data: '\r' }, g(COMPOSER, '', { awaitSettleTicks: 4 })]

function printFrame(id: string, lines: string[]): void {
  console.log(`\n┌── ${id} ──`)
  for (const l of lines) console.log(`│${l.replace(/\s+$/, '')}`)
  console.log('└──')
}

const setsOn = (wire: string): string[] => MOUSE_SETS.filter(s => wire.includes(s)).map(s => s.slice(2))

console.log('M1 — mouseCapture: false boots the face and the chat with no mouse DECSET bytes and the amber chip')
{
  const c = await capture({ id: 'm1-capture-off', home: freshHome('off', false), sends: INTO_THE_CHAT, ready: COMPOSER })
  printFrame('m1 (the chat, capture off)', c.lines)
  check('M1 the chat is on screen', c.text.includes(COMPOSER), c.tail.slice(-200))
  check('M1 the wire carries bytes', c.wire.length > 0, `${c.wire.length} bytes`)
  check('M1 zero mouse-tracking DECSET bytes on the wire (1000 · 1002 · 1003 · 1006)', setsOn(c.wire).length === 0, setsOn(c.wire).join(' '))
  check('M1 the status bar paints the amber chip', c.text.includes(CHIP), c.lines.filter(l => l.includes('mouse')).join(' | ').slice(0, 200))
}

console.log('\nM2 — the same boot without the key arms tracking (the control)')
{
  const c = await capture({ id: 'm2-default', home: freshHome('default', null), sends: INTO_THE_CHAT, ready: COMPOSER })
  printFrame('m2 (the chat, the default)', c.lines)
  check('M2 the chat is on screen', c.text.includes(COMPOSER), c.tail.slice(-200))
  check('M2 every mouse-tracking DECSET rides the wire', setsOn(c.wire).length === MOUSE_SETS.length, setsOn(c.wire).join(' '))
  check('M2 no chip on the status bar', !c.text.includes(CHIP))
}

try {
  rmSync(SCRATCH, { recursive: true, force: true })
} catch {
}
if (failures > 0) {
  console.log(`\nmouse capture drive: RED (${failures} check(s) failed)`)
  process.exit(1)
}
console.log('\nmouse capture drive: green')
process.exit(0)
