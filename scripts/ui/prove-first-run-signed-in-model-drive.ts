#!/usr/bin/env bun
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const ROOT = resolve(import.meta.dir, '../..')
const DIST = resolve(arg('--dist') ?? join(ROOT, 'dist/mercury.mjs'))
const FRAMES = arg('--frames')
const SIZES = (arg('--sizes') ?? '178x51,120x40').split(',').map(size => size.split('x').map(Number) as [number, number])
const KEEP = arg('--keep') === '1'
const FAIL_FIRST = arg('--fail-first-models') === '1'
const CLAUDE_REMNANT = arg('--claude-remnant') === '1'
const NEWEST = 'GPT-6 Astra'
const NEWEST_ID = 'gpt-6-astra'
if (!existsSync(DIST)) {
  console.error(`${DIST} missing — bun run build.ts first, or name a bundle with --dist`)
  process.exit(1)
}
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') throw new Error(driver.remedy)
const vendoredNode = join(dirname(DIST), 'vendor/node', process.platform === 'win32' ? 'node.exe' : join('bin', 'node'))
const NODE = existsSync(vendoredNode) ? vendoredNode : 'node'
const SCRATCH = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'first-run-signed-in-')))
if (FRAMES !== undefined) mkdirSync(FRAMES, { recursive: true })

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}

const DEAD = 'http://127.0.0.1:9'
function childEnv(home: string, base: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
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
    MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
    MERCURY_OPENAI_CHATGPT_BASE: `${base}/chatgpt`,
    MERCURY_OPENAI_AUTH_BASE: `${base}/auth`,
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
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'MERCURY_OAUTH_TOKEN', 'MERCURY_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_TOKEN',
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
type Wire = { kind: string; at: number; model?: string }
const text = (grid: Grid): string => grid.map(row => row.map(cell => cell.c ?? ' ').join('').trimEnd()).join('\n')
const rowWith = (frame: string, needle: string): string => frame.split('\n').find(l => l.includes(needle))?.trim() ?? ''
const gpt = (id: string, display_name: string, priority: number) => ({ id, display_name, priority, visibility: 'public', supported_in_api: true, supported_reasoning_levels: ['low', 'medium', 'high'], default_reasoning_level: 'medium', context_window: 400_000, input_modalities: ['text', 'image'] })

async function startFixture(captureFile: string, catalogueFile: string): Promise<{ base: string; stop: () => void }> {
  const fixture = spawn(NODE, [join(ROOT, 'scripts/ui/first-run-signin-fixture-server.ts'), captureFile, catalogueFile], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(FAIL_FIRST ? { FIXTURE_FAIL_FIRST_MODELS: '1' } : {}) } })
  const port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error('the sign-in fixture did not print PORT')), vshotBudgetMs(15_000))
    let output = ''
    fixture.stdout!.on('data', chunk => {
      output += String(chunk)
      const match = /PORT (\d+)/.exec(output)
      if (match) {
        clearTimeout(timer)
        resolvePort(Number(match[1]))
      }
    })
    fixture.on('exit', code => {
      clearTimeout(timer)
      reject(new Error(`the sign-in fixture exited ${code}`))
    })
  })
  return { base: `http://127.0.0.1:${port}`, stop: () => fixture.kill('SIGTERM') }
}

console.log('============================================================')
console.log(' a fresh install that signs in with a ChatGPT subscription lands on that account\'s newest usable row')
console.log(`   bundle: ${DIST}`)
console.log('============================================================')

for (const [cols, rows] of SIZES) {
  const tag = `${cols}x${rows}`
  console.log(`\n── ${tag} · the walk: theme → OpenAI subscription (device code) → guardrails → terminal → trust → the Boot face → the chat`)
  const home = join(SCRATCH, `home-${tag}`)
  const cwd = join(home, 'work')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'README.md'), '# a fixture folder\n')
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ prefersReducedMotion: true, spinnerTipsEnabled: false }))
  writeFileSync(
    join(home, 'critter-profile.json'),
    JSON.stringify({ v: 1, seed: '00000000-0000-4000-8000-00000000c0de', createdAt: 1787600000000, milestones: { settles: 0, recoveries: 0 }, quiet: true, seenTips: {}, openedSurfaces: [] }),
  )
  if (CLAUDE_REMNANT) {
    writeFileSync(
      join(home, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'fx-claude-access', refreshToken: 'fx-claude-refresh', expiresAt: Date.now() + 86_400_000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } }),
      { mode: 0o600 },
    )
  }
  const captureFile = join(home, 'wire.jsonl')
  const catalogueFile = join(home, 'models.json')
  writeFileSync(captureFile, '')
  writeFileSync(catalogueFile, JSON.stringify({ models: [gpt(NEWEST_ID, NEWEST, 1), gpt('gpt-5.6-sol', 'GPT-5.6 Sol', 2)] }))
  const fixture = await startFixture(captureFile, catalogueFile)
  const env = childEnv(home, fixture.base)
  try {
    const out = join(home, 'grid.json')
    const cfg = join(home, 'cfg.json')
    const sends = [
      { requireAwait: true, awaitText: 'Choose your theme', minTick: 3, awaitSettleTicks: 3, awaitStableTicks: 3, mark: 'theme', data: '\r' },
      { requireAwait: true, awaitText: 'Sign in later', awaitSettleTicks: 3, awaitStableTicks: 3, mark: 'provider', data: CLAUDE_REMNANT ? '\x1b[A' : '' },
      { requireAwait: true, awaitText: '❯ 1.  OpenAI', awaitSettleTicks: 2, awaitStableTicks: 2, data: '\r' },
      { requireAwait: true, awaitText: 'browser sign-in', awaitSettleTicks: 2, awaitStableTicks: 2, mark: 'arm', data: '\r' },
      { requireAwait: true, awaitText: 'd device code', awaitSettleTicks: 2, mark: 'browser', data: 'd' },
      { requireAwait: true, awaitText: 'FX-CODE', awaitSettleTicks: 1, mark: 'device', data: '' },
      { requireAwait: true, awaitText: 'Guardrails', awaitSettleTicks: 3, awaitStableTicks: 3, mark: 'guardrails', data: '\r' },
      { requireAwait: true, awaitText: 'Terminal keys', awaitSettleTicks: 3, awaitStableTicks: 3, mark: 'terminal', data: '\x1b[B' },
      { afterPrevTicks: 2, data: '\r' },
      { requireAwait: true, awaitText: 'I trust this folder', awaitSettleTicks: 3, awaitStableTicks: 3, mark: 'trust', data: '\r' },
      { requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 4, awaitStableTicks: 4, mark: 'face', data: '\r' },
      { requireAwait: true, awaitText: '← back', minTick: 5, awaitSettleTicks: 4, awaitStableTicks: 4, mark: 'chat', data: '' },
    ]
    writeFileSync(cfg, JSON.stringify({ argv: [NODE, DIST], cwd, cols, rows, total: 600, readySettleTicks: 3, stableTicks: 3, sends, readyText: ['← back'], out }))
    const status = await new Promise<number>((resolveCapture, reject) => {
      execFile(driver.python, [captureEngineEntry(driver, ROOT), cfg], { env, cwd, timeout: vshotBudgetMs(240_000) }, (error, _stdout, stderr) => {
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
      for (const label of ['theme', 'provider', 'arm', 'browser', 'device', 'guardrails', 'terminal', 'trust', 'face', 'chat']) {
        const frame = frameOf(label)
        if (frame !== '') writeFileSync(join(FRAMES, `${tag}-${label}.txt`), `${frame}\n`)
      }
      writeFileSync(join(FRAMES, `${tag}-grid.json`), JSON.stringify(payload))
      writeFileSync(join(FRAMES, `${tag}-wire.jsonl`), readFileSync(captureFile))
    }
    const wire = readFileSync(captureFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Wire)
    const face = frameOf('face')
    const chat = frameOf('chat')
    check(`${tag}: the drive delivered every send (exit 0)`, status === 0 && payload.sendReceipts?.length === sends.length, `${payload.sendReceipts?.length}/${sends.length}; ${payload.endReason}; exit ${status}`)
    check(`${tag}: the walk's sign-in landed through the device code (usercode, polls, the token exchange)`, wire.some(e => e.kind === 'usercode') && wire.some(e => e.kind === 'token'), wire.map(e => e.kind).join(','))
    check(`${tag}: the account's live list was read after the sign-in`, wire.some(e => e.kind === 'models'), wire.map(e => e.kind).join(','))
    const modelRow = rowWith(face, 'Model ')
    if (cols >= 160) {
      check(`${tag}: the Boot face's model line names the signed-in account's newest usable row (${NEWEST})`, modelRow.includes(NEWEST), modelRow)
      check(`${tag}: the Boot face's model line names no Claude row`, modelRow !== '' && !/Opus|Sonnet|Fable|Haiku/.test(modelRow), modelRow)
      const acctRow = rowWith(face, 'Acct')
      check(`${tag}: the Boot face's account line names the ChatGPT sign-in`, /sam@example\.test|ChatGPT/.test(acctRow), acctRow)
    } else {
      check(`${tag}: the Boot face paints no Claude row as the model`, face !== '' && !/Model (Opus|Sonnet|Fable|Haiku)/.test(face), rowWith(face, 'Model '))
    }
    check(`${tag}: the chat's first frame names ${NEWEST} and no Claude row as its model`, (chat.includes(NEWEST) || chat.includes(NEWEST_ID)) && !/Opus 5|Fable 5|Sonnet 5/.test(chat), chat.split('\n').filter(l => /Opus|Fable|Sonnet|GPT|gpt-/.test(l)).map(l => l.trim()).join(' | '))
  } finally {
    await new Promise<void>(done => {
      execFile(NODE, [DIST, 'daemon', 'stop'], { env, cwd, timeout: 30_000 }, () => done())
    })
    fixture.stop()
  }
}

if (failures === 0 && !KEEP) rmSync(SCRATCH, { recursive: true, force: true })
else console.log(`\n  worlds kept: ${SCRATCH}`)
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
