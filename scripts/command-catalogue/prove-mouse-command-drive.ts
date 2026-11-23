import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..', '..')
const BIN = process.env.MERCURY_PROOF_DIST ?? join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(BIN)) {
  console.error(`prove-mouse-command-drive: ${BIN} is absent — run \`bun run build.ts\` first`)
  process.exit(1)
}

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-mouse-cmd-')))
const HOME = join(SCRATCH, 'home')
const FOLDER = join(SCRATCH, 'folder')
mkdirSync(HOME, { recursive: true })
mkdirSync(FOLDER, { recursive: true })
writeFileSync(join(FOLDER, 'README.md'), '# mouse command fixture\n')
process.env.MERCURY_CONFIG_DIR = HOME
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_DAEMON_DIR
delete process.env.MERCURY_CONCOURSE

const { resolveCaptureDriver } = await import('../lib/captureDriver.ts')
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { readSessionWorkers } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-mouse-command-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}
const PYTHON = driver.python

seedFirstRun(HOME, [FOLDER])

const READY_LINE = 'New Session'
const COMPOSER = 'Type a prompt'
const WARM_TICKS = 25
const MOUSE_SETS = ['\x1b[?1000h', '\x1b[?1002h', '\x1b[?1003h', '\x1b[?1006h']
const ENABLE_MOUSE = MOUSE_SETS.join('')
const DISABLE_MOUSE = '\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l'

type Send = Record<string, unknown>
type Capture = { text: string; lines: string[]; status: number; tail: string; wire: string }

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')

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

async function capture(opts: { id: string; sends: Send[]; ready: string; total?: number }): Promise<Capture> {
  const api = await startFixtureApi([{ kind: 'text', text: 'Spare.' }])
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
      total: opts.total ?? 250,
      out: outPath,
    }),
  )
  const child = spawn(PYTHON, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], {
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: HOME,
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
    child.stdout.on('data', chunk => (tail = (tail + String(chunk)).slice(-600)))
    child.stderr.on('data', chunk => (tail = (tail + String(chunk)).slice(-600)))
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
  reapHome(HOME)
  return result
}

const g = (needle: string, data: string, extra: Send = {}): Send => ({
  atTick: 999,
  requireAwait: true,
  awaitText: needle,
  minTick: 5,
  awaitSettleTicks: 2,
  data,
  ...extra,
})

const readConfig = (): Record<string, unknown> => JSON.parse(readFileSync(join(HOME, '.mercury.json'), 'utf8')) as Record<string, unknown>

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

try {
  const off = await capture({
    id: 'mouse-off',
    sends: [
      g(READY_LINE, '\r', { awaitSettleTicks: WARM_TICKS }),
      g(COMPOSER, '/mouse off', { awaitSettleTicks: 4 }),
      g('❯ /mouse off', '\r', { awaitSettleTicks: 6 }),
      g('mouse capture OFF', '/mouse off', { awaitSettleTicks: 4 }),
      g('❯ /mouse off', '\r', { awaitPattern: 'mouse capture OFF[\\s\\S]*❯ /mouse off', awaitSettleTicks: 6 }),
      g('mouse capture already off', '', { awaitSettleTicks: 4 }),
    ],
    ready: 'mouse capture already off',
  })
  const enableIdx = off.wire.indexOf(ENABLE_MOUSE)
  const disableIdx = off.wire.indexOf(DISABLE_MOUSE)
  const afterDisablePlain = disableIdx >= 0 ? stripAnsi(off.wire.slice(disableIdx + DISABLE_MOUSE.length)) : ''
  check('/mouse off renders OFF receipt', off.text.includes('mouse capture OFF: native terminal select/copy works now'), off.tail.slice(-200))
  check('second /mouse off reports already off', off.text.includes('mouse capture already off'))
  check(
    '/mouse off sends DISABLE_MOUSE_TRACKING before painting the receipt and follow-up command',
    enableIdx >= 0 && disableIdx > enableIdx && afterDisablePlain.includes('OFF') && afterDisablePlain.includes('already'),
    `enable=${enableIdx} disable=${disableIdx} wireLen=${off.wire.length}`,
  )
  const cfgAfterOff = readConfig()
  check('/mouse off persists mouseCapture: false in config', cfgAfterOff.mouseCapture === false, JSON.stringify(cfgAfterOff.mouseCapture))

  const on = await capture({
    id: 'mouse-on',
    sends: [
      g(READY_LINE, '\r', { awaitSettleTicks: WARM_TICKS }),
      g(COMPOSER, '/mouse on', { awaitSettleTicks: 4 }),
      g('❯ /mouse on', '\r', { awaitSettleTicks: 6 }),
      g('mouse capture ON', '', { awaitSettleTicks: 4 }),
    ],
    ready: 'mouse capture ON',
  })
  const composerIdx = on.wire.indexOf(COMPOSER)
  const beforeComposer = composerIdx >= 0 ? on.wire.slice(0, composerIdx) : on.wire
  const reEnableIdx = on.wire.indexOf(ENABLE_MOUSE)
  const afterEnablePlain = reEnableIdx >= 0 ? stripAnsi(on.wire.slice(reEnableIdx + ENABLE_MOUSE.length)) : ''
  const bootMouseSets = MOUSE_SETS.filter(seq => beforeComposer.includes(seq)).map(seq => seq.slice(2))
  check('boot after /mouse off emits zero mouse DECSET bytes before composer', composerIdx >= 0 && bootMouseSets.length === 0, bootMouseSets.join(' '))
  check('/mouse on renders ON receipt', on.text.includes('mouse capture ON'), on.tail.slice(-200))
  check(
    '/mouse on sends ENABLE_MOUSE_TRACKING after boot and before painting ON receipt',
    composerIdx >= 0 && reEnableIdx > composerIdx && afterEnablePlain.includes('ON'),
    `composer=${composerIdx} reEnable=${reEnableIdx}`,
  )
  const cfgAfterOn = readConfig()
  check('/mouse on persists mouseCapture: true in config', cfgAfterOn.mouseCapture === true, JSON.stringify(cfgAfterOn.mouseCapture))
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? 'MOUSE COMMAND DRIVE GREEN' : `MOUSE COMMAND DRIVE RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
