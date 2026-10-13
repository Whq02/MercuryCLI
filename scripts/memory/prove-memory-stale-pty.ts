import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log('SKIP real terminal memory capture: POSIX PTY is not available')
  process.exit(0)
}
const root = mkdtempSync(join(tmpdir(), 'memory-stale-pty-'))
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
process.env.BROWSER = '/usr/bin/true'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
const { scenario, cleanupScenario, RUNTIME_CWD, CONFIG_HOME } = await import('../ui/renderScenarios.ts')
const { emptyDoc } = await import('../../src/mneme/mnemeTopicDocs.ts')
const { writeDoc } = await import('../../src/mneme/mnemeLibrary.ts')
const { pinFact } = await import('../../src/mneme/mnemeUsage.ts')
const library = join(root, 'memory', 'library')
const stamp = new Date(Date.now() - 120 * 86400000).toISOString()
const doc = emptyDoc('checksum', 'checksum facts', stamp)
doc.sections = [{ heading: 'notes', entries: [
  { seq: 1, text: 'The backup uses the checksum catalog.', time: stamp, source: 'proof' },
  { seq: 2, text: 'Always keep the checksum rule verbatim.', time: stamp, source: 'proof' },
] }]
writeDoc(doc, library)
pinFact(2, library, new Date(), { asked: true })
const config = scenario('memory', 120, 44)
const settings = join(CONFIG_HOME, 'settings.json')
let prior = {}
try { prior = JSON.parse(readFileSync(settings, 'utf8')) } catch {}
writeFileSync(settings, JSON.stringify({ ...prior, memory: { directory: join(root, 'memory'), journal: false } }))
const grid = join(root, 'grid.json')
const cfg = join(root, 'capture.json')
writeFileSync(cfg, JSON.stringify({ ...config, cwd: RUNTIME_CWD, out: grid, total: 150, stableTicks: 4, readyText: 'stale · The backup uses', sends: [
  { awaitText: '❯', atTick: 50, data: '/memory' },
  { afterPrevTicks: 3, data: '\r' },
  { awaitText: 'facts and decisions', atTick: 100, data: '\r' },
] }))
try {
  const capture = spawnSync(driver.python, [join(import.meta.dir, '../ui/vshot.py'), cfg], { cwd: RUNTIME_CWD, env: process.env, encoding: 'utf8', timeout: vshotBudgetMs(120000) })
  assert.equal(capture.status, 0, capture.stderr)
  const frame = JSON.parse(readFileSync(grid, 'utf8'))
  const text = frame.grid.map((row: { c: string }[]) => row.map(c => c.c).join('')).join('\n')
  assert(text.includes('memory › facts'), text)
  assert(text.includes('stale · The backup uses'), text)
  assert(text.includes('pinned · Always keep'), text)
  const at = process.argv.indexOf('--frames')
  if (at >= 0 && process.argv[at + 1]) {
    const out = process.argv[at + 1]!
    mkdirSync(out, { recursive: true })
    copyFileSync(grid, join(out, 'stale-pty.json'))
    const { gridToPng } = await import('../ui/gridToPng.ts')
    await gridToPng(grid, join(out, 'stale-pty.png'))
  }
  console.log('PASS the real terminal memory centre shows stale and exempt pinned rows')
} finally {
  cleanupScenario('memory')
  rmSync(root, { recursive: true, force: true })
}
process.exit(0)
