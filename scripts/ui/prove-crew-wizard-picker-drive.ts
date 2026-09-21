#!/usr/bin/env bun
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const ROOT = resolve(import.meta.dir, '../..')
const DIST = resolve(arg('--dist') ?? join(ROOT, 'dist/mercury.mjs'))
const FRAMES = arg('--frames')
const SIZES = (arg('--sizes') ?? '178x51,120x40').split(',').map(size => size.split('x').map(Number) as [number, number])
const KEEP = arg('--keep') === '1'
const KEY = 'proof-key-ci-gate-not-a-real-key'
const NAME = 'atlas'
if (!existsSync(DIST)) {
  console.error(`${DIST} missing — bun run build.ts first, or name a bundle with --dist`)
  process.exit(1)
}
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') throw new Error(driver.remedy)
const vendoredNode = join(dirname(DIST), 'vendor/node', process.platform === 'win32' ? 'node.exe' : join('bin', 'node'))
const NODE = existsSync(vendoredNode) ? vendoredNode : 'node'
process.env.ANTHROPIC_API_KEY = KEY
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const SCRATCH = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'crew-wizard-picker-')))
if (FRAMES !== undefined) mkdirSync(FRAMES, { recursive: true })

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}

const DEAD = 'http://127.0.0.1:9'
function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_API_KEY: KEY,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_HOME: join(home, 'proof-home'),
    MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor-state'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_IDE_SKIP_AUTO_INSTALL: '1',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_DECK_COMPANION: '0',
    MERCURY_UPDATE_NOTICE: '0',
    MERCURY_CRITTER: 'clam',
    TERM_PROGRAM: 'vscode',
    BROWSER: '/usr/bin/true',
    ANTHROPIC_BASE_URL: DEAD,
    MERCURY_OPENAI_API_BASE: DEAD,
    MERCURY_OPENAI_CHATGPT_BASE: DEAD,
    MERCURY_OPENAI_AUTH_BASE: DEAD,
    MERCURY_OPENROUTER_API_BASE: DEAD,
    MERCURY_OPENROUTER_AUTH_BASE: DEAD,
    MERCURY_GEMINI_API_BASE: DEAD,
    MERCURY_GEMINI_OAUTH_AUTH_BASE: DEAD,
    MERCURY_GEMINI_OAUTH_TOKEN_BASE: DEAD,
    MERCURY_HUGGINGFACE_API_BASE: `${DEAD}/v1`,
    MERCURY_HUGGINGFACE_HUB_BASE: DEAD,
    MERCURY_MOONSHOT_API_BASE: `${DEAD}/v1`,
    MERCURY_MOONSHOT_OAUTH_BASE: DEAD,
    MERCURY_MOONSHOT_CODING_BASE: `${DEAD}/v1`,
    MERCURY_ZAI_API_BASE: `${DEAD}/v4`,
    MERCURY_DEEPSEEK_API_BASE: DEAD,
    MERCURY_CUSTOM_OAUTH_URL: 'http://127.0.0.1:1',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    COLORTERM: 'truecolor',
  }
  for (const key of [
    'NODE_ENV', 'MERCURY_DEMO', 'MERCURY_FULLSCREEN', 'MERCURY_ALT_HELD', 'MERCURY_MODEL', 'MERCURY_THEME_PIN',
    'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
    'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'MERCURY_MOONSHOT_OAUTH_CLIENT_ID',
    'MERCURY_DEFAULT_FABLE_MODEL', 'MERCURY_DEFAULT_OPUS_MODEL', 'MERCURY_DEFAULT_SONNET_MODEL',
    'CURSOR_TRACE_ID', 'VSCODE_GIT_ASKPASS_MAIN', '__CFBundleIdentifier', 'VisualStudioVersion', 'TERMINAL_EMULATOR',
  ]) {
    delete env[key]
  }
  return env
}

type Cell = { c?: string }
type Grid = Cell[][]
type Payload = { grid: Grid; marks?: { label: string; grid: Grid }[]; sendReceipts?: { ts: number }[]; endReason?: string }
const text = (grid: Grid): string => grid.map(row => row.map(cell => cell.c ?? ' ').join('').trimEnd()).join('\n')
const rowWith = (frame: string, needle: string): string => frame.split('\n').find(l => l.includes(needle))?.trim() ?? ''

function crewTeamModels(home: string): string[] {
  const teamsDir = join(home, 'teams')
  const out: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name)
      if (name.isDirectory()) walk(full)
      else if (name.name.endsWith('.json')) {
        try {
          const parsed = JSON.parse(readFileSync(full, 'utf8')) as { members?: Array<{ name?: string; model?: string }> }
          for (const member of parsed.members ?? []) if (member.name === NAME && typeof member.model === 'string') out.push(member.model)
        } catch {
          continue
        }
      }
    }
  }
  walk(teamsDir)
  return out
}

console.log('============================================================')
console.log(" the crew wizard's model step opens the live-list picker; a pick spawns the exact id")
console.log(`   bundle: ${DIST}`)
console.log('============================================================')

for (const [cols, rows] of SIZES) {
  const tag = `${cols}x${rows}`
  console.log(`\n── ${tag} · New Session → /teammates → n → a name → the model step`)
  const home = join(SCRATCH, `home-${tag}`)
  const cwd = join(home, 'work')
  mkdirSync(join(cwd, '.mercury'), { recursive: true })
  writeFileSync(join(cwd, 'README.md'), '# a fixture folder\n')
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ prefersReducedMotion: true, spinnerTipsEnabled: false }))
  writeFileSync(
    join(home, 'critter-profile.json'),
    JSON.stringify({ v: 1, seed: '00000000-0000-4000-8000-00000000c0de', createdAt: 1787600000000, milestones: { settles: 0, recoveries: 0 }, quiet: true, seenTips: {}, openedSurfaces: [] }),
  )
  const env = childEnv(home)
  const ready = cols >= 100 && rows >= 26 ? '· ready' : '1 session on'
  try {
    const out = join(home, 'grid.json')
    const cfg = join(home, 'cfg.json')
    const sends = [
      { requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { requireAwait: true, awaitText: ready, minTick: 5, awaitSettleTicks: 4, awaitStableTicks: 3, data: '' },
      { afterPrevTicks: 1, data: '/teammates' },
      { afterPrevTicks: 2, data: '\r' },
      { requireAwait: true, awaitText: 'n new', awaitSettleTicks: 3, awaitStableTicks: 3, mark: 'crew', data: 'n' },
      { requireAwait: true, awaitText: 'new named agent', awaitSettleTicks: 2, awaitStableTicks: 2, mark: 'name', data: NAME },
      { afterPrevTicks: 2, data: '\r' },
      { requireAwait: true, awaitText: 'pick a model', awaitSettleTicks: 4, awaitStableTicks: 3, mark: 'picker', data: '\x1b[B' },
      { afterPrevTicks: 3, data: '', mark: 'focused' },
      { afterPrevTicks: 1, data: '\r' },
      { requireAwait: true, awaitText: 'spawn', awaitSettleTicks: 6, awaitStableTicks: 4, mark: 'after', data: '' },
    ]
    writeFileSync(cfg, JSON.stringify({ argv: [NODE, DIST], cwd, cols, rows, total: 420, readySettleTicks: 4, stableTicks: 3, sends, readyText: ['esc close'], out }))
    const status = await new Promise<number>((resolveCapture, reject) => {
      execFile(driver.python, [captureEngineEntry(driver, ROOT), cfg], { env, cwd, timeout: vshotBudgetMs(200_000) }, (error, _stdout, stderr) => {
        if (error && !existsSync(out)) reject(new Error(`${error}\n${stderr}`))
        else {
          if (error) console.log(stderr.split('\n').slice(-8).join('\n'))
          resolveCapture(error ? Number(error.code) || 1 : 0)
        }
      })
    })
    const payload = JSON.parse(readFileSync(out, 'utf8')) as Payload
    const frameOf = (label: string): string => {
      const mark = payload.marks?.find(m => m.label === label)
      return mark ? text(mark.grid) : ''
    }
    if (FRAMES !== undefined) {
      for (const label of ['crew', 'name', 'picker', 'focused', 'after']) {
        const frame = frameOf(label)
        if (frame !== '') writeFileSync(join(FRAMES, `${tag}-${label}.txt`), `${frame}\n`)
      }
      writeFileSync(join(FRAMES, `${tag}-grid.json`), JSON.stringify(payload))
    }
    const picker = frameOf('picker')
    const focused = frameOf('focused')
    const after = frameOf('after')
    check(`${tag}: the drive delivered every send (exit 0)`, status === 0 && payload.sendReceipts?.length === sends.length, `${payload.sendReceipts?.length}/${sends.length}; ${payload.endReason}; exit ${status}`)
    check(`${tag}: the model step names the agent and opens the model picker`, picker.includes(`@${NAME} · pick a model`) && (cols < 100 || picker.includes('CHOOSE A MODEL')), picker.split('\n').filter(l => /pick a model|CHOOSE/.test(l)).join(' | '))
    check(`${tag}: the picker lists the live rows by family group (more than one family heading)`, cols < 100 || picker.split('\n').filter(l => /MERCURY — .* MODELS/.test(l)).length >= 2, picker.split('\n').filter(l => /MODELS/.test(l)).join(' | '))
    check(`${tag}: no generation-key chips remain (no opus · sonnet · fable · fable51 chip row)`, !/│\s*opus\s+.*│\s*sonnet\s+/.test(picker) && !picker.includes('you pick the model per agent'), rowWith(picker, 'opus'))
    check(`${tag}: the footer names the picker's keys`, picker.includes('↑↓ move · ↵ spawn · esc back'), rowWith(picker, 'esc back'))
    const models = crewTeamModels(home)
    check(`${tag}: the pick spawns the row's exact id (the team file records it, never a family word)`, models.length > 0 && models.every(m => /[-/]/.test(m) && !['fable', 'opus', 'sonnet', 'haiku', 'fable51'].includes(m)), models.join(','))
    check(`${tag}: the board reports the spawn with the row's own words`, /spawning @atlas|@atlas spawned|spawn refused/.test(after), rowWith(after, '@atlas'))
    void focused
  } finally {
    await new Promise<void>(done => {
      execFile(NODE, [DIST, 'daemon', 'stop'], { env, cwd, timeout: 30_000 }, () => done())
    })
  }
}

if (failures === 0 && !KEEP) rmSync(SCRATCH, { recursive: true, force: true })
else console.log(`\n  worlds kept: ${SCRATCH}`)
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
