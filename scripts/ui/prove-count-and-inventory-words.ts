import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { REREAD_ASK, REREAD_END, startRereadFixture } from '../stop-policy/prove-no-stagnation-governor.ts'

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const root = resolve(import.meta.dir, '../..')
const dist = resolve(arg('--dist') ?? join(root, 'dist/mercury.mjs'))
const output = resolve(arg('--output') ?? mkdtempSync(join(tmpdir(), 'inventory-words-')))
const geometries = (arg('--sizes') ?? '80x21,80x14,82x17,120x40').split(',').map(size => size.split('x').map(Number))
const scenes = (arg('--scenes') ?? 'reads,kit,kit-refused').split(',')
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') throw new Error(driver.remedy)
const vendoredNode = join(dirname(dist), 'vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const node = existsSync(vendoredNode) ? vendoredNode : 'node'
const key = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_API_KEY = key
mkdirSync(output, { recursive: true })
let failures = 0
const check = (label: string, pass: boolean): void => {
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}`)
  if (!pass) failures++
}
type Cell = { c: string }
type Grid = { cols: number; rows: number; grid: Cell[][]; marks?: Array<{ label: string; grid: Cell[][] }> }

for (const [cols, rows] of geometries) {
  for (const scene of scenes) {
    const name = `${scene}-${cols}x${rows}`
    const home = mkdtempSync(join(arg('--scratch-root') ?? tmpdir(), `${name}-world-`))
    const cwd = join(home, 'work')
    const config = join(home, 'config')
    mkdirSync(cwd)
    seedFirstRun(config, [cwd])
    writeFileSync(join(config, 'settings.json'), '{}\n')
    if (scene === 'kit-refused') {
      const skill = join(cwd, '.mercury/skills/broken')
      mkdirSync(skill, { recursive: true })
      writeFileSync(join(skill, 'SKILL.md'), '')
    }
    const notes = join(cwd, 'notes.txt')
    const fixture = await startRereadFixture(notes, 20, false)
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, 'xdg'),
      TMPDIR: tmpdir(),
      TMP: tmpdir(),
      TEMP: tmpdir(),
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ANTHROPIC_API_KEY: key,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${fixture.port}`,
      OPENAI_BASE_URL: 'http://127.0.0.1:1',
      OPENAI_API_BASE: 'http://127.0.0.1:1',
      GEMINI_BASE_URL: 'http://127.0.0.1:1',
      ZAI_BASE_URL: 'http://127.0.0.1:1',
      MERCURY_CONFIG_DIR: config,
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_TEAMS_DIR: join(home, 'teams'),
      MERCURY_TABULA_DIR: join(home, 'tabula'),
      MERCURY_HOME: join(home, 'product-home'),
      MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor'),
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_BOOT_PREFLIGHT: '0',
      MERCURY_TURN_RECEIPT: '1',
      MERCURY_VERIFY_EVIDENCE: '0',
      MERCURY_TERMINAL_TITLE: '0',
      MERCURY_CRITTER_IDLE: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_CRITTER_SLEEP: '0',
      MERCURY_LIVE_CLOCK: '0',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_OPERATOR: 'sam',
      BROWSER: '/usr/bin/true',
    }
    const cfg = {
      argv: [node, dist, '--model', 'claude-opus-4-8', ...(scene === 'reads' ? ['--allowed-tools', 'Read,Write', '--', REREAD_ASK] : [])],
      cwd,
      cols,
      rows,
      out: join(output, `${name}.json`),
      sends: scene === 'reads' ? [] : [
        { data: '\u001b[B', awaitText: 'MCPs & Skills', requireAwait: true, awaitSettleTicks: 4 },
        { data: '\u001b[B', afterPrevTicks: 2 },
        { data: '\r', afterPrevTicks: 2 },
      ],
      readyText: scene === 'reads' ? REREAD_END : '.mercury/skills/',
      readySettleTicks: 5,
      total: 500,
    }
    const cfgPath = join(output, `${name}.capture.json`)
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
    const proc = spawn(driver.python, [captureEngineEntry(driver, root), cfgPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', chunk => { stdout += String(chunk) })
    proc.stderr.on('data', chunk => { stderr += String(chunk) })
    const watchdog = setTimeout(() => proc.kill('SIGTERM'), vshotBudgetMs(120000))
    const exit = await new Promise<number | null>((done, reject) => { proc.once('exit', done); proc.once('error', reject) })
    clearTimeout(watchdog)
    await fixture.close()
    writeFileSync(join(output, `${name}.stdout.txt`), stdout)
    writeFileSync(join(output, `${name}.stderr.txt`), stderr)
    writeFileSync(join(output, `${name}.wire.json`), JSON.stringify(fixture.hits, null, 2) + '\n')
    const grid: Grid | null = existsSync(cfg.out) ? JSON.parse(readFileSync(cfg.out, 'utf8')) : null
    const text = grid?.grid.map(line => line.map(cell => cell.c).join('')).join('\n') ?? ''
    writeFileSync(join(output, `${name}.txt`), text + '\n')
    check(`${name}: the built product reached the requested screen`, exit === 0 && grid !== null)
    if (scene === 'reads') {
      check(`${name}: twenty Read calls on one unchanged path settled successfully`, fixture.hits.filter(hit => hit.arm === 'read').length === 20 && fixture.hits.some(hit => hit.arm === 'end') && fixture.hits.every(hit => !hit.refused) && existsSync(notes) && readFileSync(notes, 'utf8') === 'line 0\n')
      check(`${name}: the receipt names reads, not distinct files`, /\b20 reads\b/.test(text) && !/\b20 files read\b/.test(text))
    } else {
      check(`${name}: empty sections name added entries rather than session capabilities`, text.includes('no added MCPs') && text.includes('no added skills'))
      check(`${name}: built-in servers and bundled skills are explicitly outside this list`, text.includes('mercury / ide not listed') && text.includes('bundled skills load in sessions; MCP skills on connection'))
      check(`${name}: the menu did not request a provider response`, fixture.hits.length === 0)
      if (scene === 'kit-refused') check(`${name}: the malformed skill remains visible without scrolling inert rows`, text.includes('refused: .mercury/skills/broken/SKILL.md'))
    }
    console.log(JSON.stringify({ name, exit, home, dist, output, stderr }))
  }
}
console.log(`${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
