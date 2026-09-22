#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const REPO = join(import.meta.dir, '..', '..')
const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const BIN = arg('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
const FRAMES = arg('--frames')
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'board-signin-')))
const CWD = join(ROOT, 'project')
mkdirSync(CWD)
const NODE = existsSync(join(dirname(BIN), 'vendor/node/bin/node')) ? join(dirname(BIN), 'vendor/node/bin/node') : 'node'
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') throw new Error(`capture unavailable: ${driver.kind}`)
const ESC = '\x1b'
const SHIFT_RIGHT = `${ESC}[1;2C`
const SHIFT_LEFT = `${ESC}[1;2D`
const click = `${ESC}[<0;{X};{Y}M${ESC}[<0;{X};{Y}m`
type Send = Record<string, unknown>
type Grid = Array<Array<{ c: string }>>
const textOf = (grid: Grid): string => grid.map(row => row.map(cell => cell.c).join('')).join('\n')
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` ${detail}` : ''}`)
}
function gate(awaitText: string, data: string, mark?: string): Send {
  return { requireAwait: true, awaitText, awaitSettleTicks: 3, data, ...(mark ? { mark } : {}) }
}
try {
  console.log(`bundle ${BIN}; scratch ${ROOT}`)
  for (const [cols, rows] of [[120, 40], [178, 51]]) {
    for (const kind of ['default', 'session', 'face']) {
      const id = `${kind}-${cols}x${rows}`
      const home = join(ROOT, id)
      seedFirstRun(home, [CWD])
      writeFileSync(join(home, 'settings.json'), JSON.stringify({ prefersReducedMotion: true, spinnerTipsEnabled: false, availableModels: ['claude-opus-5'] }))
      const env = { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true', MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_TEAMS_DIR: join(home, 'teams'), MERCURY_TABULA_DIR: join(home, 'tabula'), MERCURY_HOME: join(home, 'home'), MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor'), MERCURY_BOOT_PREFLIGHT: '0', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_LIVE_GLYPHS: '0', MERCURY_LIVE_CLOCK: '0', MERCURY_CRITTER_GAZE: '0', MERCURY_CRITTER_IDLE: '0', MERCURY_CRITTER_SLEEP: '0', TERM_PROGRAM: 'vscode', MERCURY_IDE_SKIP_AUTO_INSTALL: '1' }
      for (const k of ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_MODEL', 'NODE_ENV']) delete (env as Record<string, unknown>)[k]
      const sends: Send[] = kind === 'face' ? [gate('↑↓ choose', 'm')] : [gate('↑↓ choose', SHIFT_RIGHT), gate('coordinator model', '\t'), gate('n new session', kind === 'session' ? 'n' : 'm')]
      if (kind === 'session') sends.push(gate('contract?', ESC), gate('← back', SHIFT_LEFT), gate('STATUS & TITLE', 'm'))
      sends.push(gate('GPT — sign in', click, 'picker'))
      sends[sends.length - 1]!.targetText = 'GPT — sign in'
      sends.push({ afterPrevTicks: 4, data: '\r', mark: 'selected' }, { afterPrevTicks: 12, data: '', mark: 'landed' })
      const out = join(ROOT, `${id}.json`)
      const cfg = join(ROOT, `${id}.cfg.json`)
      writeFileSync(cfg, JSON.stringify({ argv: [NODE, BIN], cwd: CWD, cols, rows, total: 360, sends, stableTicks: 3, out }))
      const result = spawnSync(driver.python, [join(import.meta.dir, 'vshot.py'), cfg], { env, encoding: 'utf8', timeout: vshotBudgetMs(180_000) })
      const captured = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) as { grid: Grid; marks: Array<{ label: string; grid: Grid }> } : null
      const marks = new Map(captured?.marks.map(m => [m.label, textOf(m.grid)]) ?? [])
      const landed = marks.get('landed') ?? ''
      check(`${id}: every send delivered`, result.status === 0, result.stderr.slice(-600))
      check(`${id}: connect row selected in the model picker`, (marks.get('selected') ?? '').includes('GPT — sign in') && (marks.get('picker') ?? '').includes('Mercury — model'))
      check(`${id}: the sign-in layer is open`, landed.includes('LOGINS') && landed.includes('Families'), landed.split('\n').filter(l => l.trim()).slice(0, 8).join('\n'))
      if (FRAMES) {
        mkdirSync(FRAMES, { recursive: true })
        if (captured) writeFileSync(join(FRAMES, `${id}.json`), JSON.stringify(captured))
        for (const [mark, text] of marks) writeFileSync(join(FRAMES, `${id}-${mark}.txt`), text + '\n')
      }
    }
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}
console.log(`${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
