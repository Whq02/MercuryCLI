import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { resolveCaptureDriver } from '../lib/captureDriver.ts'
import { BASE, ROOT, argument, git, scratch } from './support.ts'

assert.equal(git('rev-parse', 'HEAD'), BASE, 'scenes are recorded only from the unchanged base')
assert.equal(git('diff', BASE, '--', 'src', 'assets'), '', 'product sources must still be at the base')
const out = argument('--out') ?? join(import.meta.dir, 'scenes')
for (const name of ['boot', 'chat', 'concourse']) assert.ok(!existsSync(join(out, `${name}.json`)), `${name} is write-once`)
const work = argument('--work-dir') ?? scratch('engine-scenes-')
const cwd = join(work, 'orchard')
const home = join(work, 'home')
mkdirSync(cwd, { recursive: true })
seedFirstRun(home, [cwd, realpathSync(cwd)])
writeFileSync(join(home, 'settings.json'), JSON.stringify({ view: { reducedMotion: true }, activity: { tips: { enabled: false } }, guardrails: { sovereignConsentSeen: true } }))
const cfg = join(work, 'capture.json')
const grid = join(work, 'capture-grid.json')
const wait = (text: string, mark: string, data = '') => ({ data, awaitText: text, requireAwait: true, minTick: 3, awaitSettleTicks: 6, mark })
writeFileSync(cfg, JSON.stringify({
  cwd, argv: [join(ROOT, 'dist/vendor/node/bin/node'), join(ROOT, 'dist/mercury.mjs')],
  cols: 177, rows: 49, total: 400, out: grid,
  sends: [wait('↑↓ choose', 'boot', '\r'), wait('Type a prompt', 'chat', '\u001b[1;2D'), wait('STATUS & TITLE', 'concourse')],
  readyText: 'STATUS & TITLE', readySettleTicks: 2,
}))
const driver = resolveCaptureDriver()
assert.equal(driver.kind, 'posix-pty')
if (driver.kind !== 'posix-pty') throw new Error('POSIX pty unavailable')
const env: NodeJS.ProcessEnv = {
  ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: join(home, 'daemon'),
  MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_DESKTOP_DRIVER: 'none', MERCURY_SPLASH: 'off',
  MERCURY_CRITTER_IDLE: '0', MERCURY_CRITTER_GAZE: '0', MERCURY_CRITTER_SLEEP: '0',
  MERCURY_LIVE_GLYPHS: '0', MERCURY_LIVE_CLOCK: '0', MERCURY_AWAY_SUMMARY: '0',
  MERCURY_OPERATOR: 'sam', MERCURY_THEME_PIN: 'dark', COLORFGBG: '15;0', COLORTERM: 'truecolor', TERM_PROGRAM: 'Apple_Terminal',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', VSHOT_SLOTS: '999',
}
for (const name of ['MERCURY_HOME', 'MERCURY_CRITTER', 'CI', 'NODE_ENV']) delete env[name]
const run = spawnSync(driver.python, [join(ROOT, 'scripts/ui/vshot.py'), cfg], { env, encoding: 'utf8', timeout: 120_000 })
writeFileSync(join(work, 'capture.log'), run.stdout + '\n' + run.stderr)
assert.equal(run.status, 0, `base capture refused; ${join(work, 'capture.log')}`)
type Cell = { c: string; fg: string; bg: string; bold?: boolean; dim?: boolean; rev?: boolean }
type Run = { text: string; fg: string | null; bg: string | null; bold: boolean; dim: boolean; inv: boolean }
const payload = JSON.parse(readFileSync(grid, 'utf8')) as { marks: Array<{ label: string; grid: Cell[][] }>; sendReceipts: unknown[] }
assert.equal(payload.sendReceipts.length, 3)
const color = (value: string): string | null => value === 'default' ? null : /^[0-9a-f]{6}$/i.test(value) ? `#${value}` : value
mkdirSync(out, { recursive: true })
for (const name of ['boot', 'chat', 'concourse']) {
  const cells = payload.marks.find(mark => mark.label === name)?.grid
  assert.ok(cells, `missing ${name} mark`)
  assert.equal(cells.length, 49)
  const lines = cells.map(row => {
    assert.equal(row.length, 177)
    const runs: Run[] = []
    for (const cell of row) {
      if (cell.c === '') continue
      const next = { text: cell.c, fg: color(cell.fg), bg: color(cell.bg), bold: !!cell.bold, dim: !!cell.dim, inv: !!cell.rev }
      const last = runs.at(-1)
      if (last && last.fg === next.fg && last.bg === next.bg && last.bold === next.bold && last.dim === next.dim && last.inv === next.inv) last.text += next.text
      else runs.push(next)
    }
    return runs
  })
  writeFileSync(join(out, `${name}.json`), JSON.stringify({ cols: 177, rows: 49, lines }, null, 1) + '\n', { flag: 'wx' })
  console.log(`[PASS] recorded ${name}: 177x49 from base ${BASE}`)
}
writeFileSync(join(out, 'source.json'), JSON.stringify({ source: BASE, build: JSON.parse(readFileSync(join(ROOT, 'dist/manifest.json'), 'utf8')).buildTree, capture: 'scripts/ui/vshot.py', cols: 177, rows: 49 }, null, 1) + '\n', { flag: 'wx' })
console.log(`[PASS] base scene records: ${grid}`)
