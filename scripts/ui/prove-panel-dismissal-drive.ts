import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const root = join(import.meta.dir, '..', '..')
const arg = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at < 0 ? undefined : process.argv[at + 1]
}
const dist = arg('--dist') ?? join(root, 'dist', 'mercury.mjs')
const frames = arg('--frames')
const scratch = mkdtempSync(join(realpathSync(arg('--worlds') ?? tmpdir()), 'panel-dismissal-'))
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty' || !existsSync(dist)) {
  rmSync(scratch, { recursive: true, force: true })
  throw new Error(driver.kind !== 'posix-pty' ? 'this drive needs a POSIX terminal' : 'build the product before this drive')
}
const vendoredNode = join(dist, '../vendor/node/bin/node')
const node = existsSync(vendoredNode) ? vendoredNode : 'node'
type Cell = { c: string; fg: string; bg: string; bold: boolean; rev: boolean }
type Grid = Cell[][]
type Mark = { label: string; grid: Grid }
type Capture = { grid: Grid; marks: Mark[]; endReason: string }
const text = (grid: Grid): string => grid.map(row => row.map(cell => cell.c).join('')).join('\n')
const click = (x: string | number, y: string | number): string => `\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`
let failures = 0
const index: string[] = []
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const deadProviders = Object.fromEntries([
  'MERCURY_CUSTOM_OAUTH_URL', 'ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENAI_CHATGPT_BASE',
  'MERCURY_OPENROUTER_API_BASE', 'MERCURY_OPENROUTER_AUTH_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_GEMINI_OAUTH_AUTH_BASE', 'MERCURY_GEMINI_OAUTH_TOKEN_BASE',
  'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_OAUTH_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_ZAI_API_BASE', 'MERCURY_DEEPSEEK_API_BASE',
  'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_UPDATE_API_BASE_URL',
].map(key => [key, 'http://127.0.0.1:1']))
try {
  for (const [cols, rows, noDim] of [[178, 51, false], [120, 40, false], [178, 51, true]] as const) {
    if (process.argv.includes('--no-dim-only') && !noDim) continue
    for (const panel of noDim ? ['teammates'] : ['teammates', 'tasks', 'model']) {
      const tag = `${panel}-${cols}x${rows}${noDim ? '-no-dim' : ''}`
      const world = join(scratch, tag)
      const cwd = join(world, 'cwd')
      const home = join(world, 'config')
      mkdirSync(cwd, { recursive: true })
      seedFirstRun(home, [cwd])
      writeFileSync(join(home, 'settings.json'), '{}')
      const out = join(world, 'capture.json')
      const config = join(world, 'capture-config.json')
      const needle = panel === 'teammates' ? 'Sub-agents' : `Mercury — ${panel}`
      const ready = { requireAwait: true, awaitText: 'ready ·', targetText: '⇧← back', awaitSettleTicks: 6 }
      const panelReady = { requireAwait: true, awaitText: needle, awaitSettleTicks: 8 }
      writeFileSync(config, JSON.stringify({ argv: [node, dist], cwd, cols, rows, out, total: 400, stableTicks: 4, sends: [
        { requireAwait: true, awaitText: '↑↓ choose', minTick: 35, awaitSettleTicks: 4, data: '\r' },
        { ...ready, data: `/${panel}\r`, mark: 'chat' },
        { ...panelReady, targetText: `Mercury — ${panel === 'teammates' ? 'crew' : panel}`, targetDx: -8, data: click('{X}', '{Y}'), mark: 'open' },
        { afterPrevTicks: 6, data: '\x1b[<0;1;1M', mark: 'edge' },
        { afterPrevTicks: 4, data: '\x1b[<32;2;1M\x1b[<0;2;1m', mark: 'pressed' },
        { afterPrevTicks: 6, data: '\x1b', mark: 'clicked' },
        { ...ready, data: `/${panel}\r`, mark: 'closed' },
        { ...panelReady, data: '\x1b', mark: 'reopened' },
        { ...ready, data: '', mark: 'escaped' },
      ] }))
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...deadProviders,
        TERM: 'xterm-256color', TERM_PROGRAM: 'vscode', BROWSER: '/usr/bin/true',
        MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', ANTHROPIC_API_KEY: 'fixture-key-000',
        MERCURY_DAEMON_DIR: join(world, 'daemon'), MERCURY_TEAMS_DIR: join(world, 'teams'), MERCURY_CREW_DIR: join(world, 'crew'),
        MERCURY_TABULA_DIR: join(world, 'tabula'), MERCURY_HOME: join(world, 'home'), MERCURY_DOCTOR_STATE_DIR: join(world, 'doctor'),
        MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_IDE_SKIP_AUTO_INSTALL: '1', MERCURY_BOOT_PREFLIGHT: '0',
        MERCURY_LIVE_GLYPHS: '0', MERCURY_LIVE_CLOCK: '0', MERCURY_CRITTER_GAZE: '0', MERCURY_CRITTER_IDLE: '0', MERCURY_CRITTER_SLEEP: '0',
        MERCURY_DECK_COMPANION: '0', MERCURY_AWAY_SUMMARY: '0', MERCURY_TURN_RECEIPT: '0', MERCURY_RECESS: noDim ? '0' : '1',
      }
      for (const key of ['NODE_ENV', 'MERCURY_DEMO', 'CI', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_API_KEY_FILE_DESCRIPTOR', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN']) delete env[key]
      const child = spawn(driver.python, [captureEngineEntry(driver, root), config], { env, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      const timer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(150_000))
      const code = await new Promise<number>((resolve, reject) => { child.on('close', code => resolve(code ?? 1)); child.on('error', reject) }).finally(() => clearTimeout(timer))
      check(`${tag}: the complete journey reaches its marks`, code === 0, stderr)
      if (!existsSync(out)) continue
      const capture = JSON.parse(readFileSync(out, 'utf8')) as Capture
      if (frames !== undefined) {
        mkdirSync(frames, { recursive: true })
        for (const mark of capture.marks ?? []) {
          const name = `${tag}-${mark.label}`
          writeFileSync(join(frames, `${name}.json`), JSON.stringify({ cols, rows, grid: mark.grid }))
          writeFileSync(join(frames, `${name}.txt`), text(mark.grid) + '\n')
          index.push(`${name}.txt — /${panel} at ${cols}×${rows}, ${mark.label}`)
        }
      }
      if (code !== 0) continue
      const marks = Object.fromEntries(capture.marks.map(mark => [mark.label, mark.grid]))
      if (noDim) check(`${tag}: the backdrop is a blank claim, not dimmed chat`, !text(marks.open!).includes('✶ VIEW'))
      check(`${tag}: clicking the frame edge does not close`, text(marks.edge!).includes(needle))
      check(`${tag}: the outside press closes the panel`, !text(marks.pressed!).includes(needle))
      check(`${tag}: its release is consumed`, text(marks.pressed!) === text(marks.clicked!))
      check(`${tag}: Escape still closes a freshly opened panel`, text(marks.reopened!).includes(needle) && !text(marks.escaped!).includes(needle))
      check(`${tag}: no text selection starts`, !marks.clicked!.some(row => row.some(cell => cell.rev)))
      check(`${tag}: the composer is empty after dismissal`, text(marks.clicked!).includes('Type a prompt') && !text(marks.clicked!).includes('❯ telemetry'))
      check(`${tag}: every chat cell matches the Escape close`, JSON.stringify(marks.clicked) === JSON.stringify(marks.escaped))
    }
  }
} finally {
  if (frames !== undefined) {
    mkdirSync(frames, { recursive: true })
    writeFileSync(join(frames, 'index.txt'), index.join('\n') + '\n')
  }
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`panel dismissal drive: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
