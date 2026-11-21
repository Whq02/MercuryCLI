#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, FRAMES, NODE, makeTally } from '../daemon/dupline-world.ts'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'

const VSHOT = join(import.meta.dir, 'vshot.py')
const tally = makeTally('prove-media-settings-picker-drive')
const KEEP = process.argv.includes('--keep')
const DEAD = 'http://127.0.0.1:9'
const ESC = '\x1b'
const DOWN = '\x1b[B'
const RIGHT = '\x1b[C'
const BACKSPACE = '\x7f'
const CONFIG_TITLE = 'Mercury · config'

const driver = resolveCaptureDriver()
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
  process.exit(0)
}
if (driver.kind !== 'posix-pty') {
  console.log(`  [SKIP] no POSIX pty capture driver on this host (${driver.kind})`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)
const PYTHON = driver.python

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'media-settings-picker-drive-')))

type Cell = string | { c?: string } | null
type Grid = Cell[][]
const cellGlyph = (cell: Cell | undefined): string => (typeof cell === 'object' && cell !== null ? (cell.c ?? ' ') : String(cell ?? ' '))
const gridText = (grid: Grid): string => grid.map(row => row.map(c => cellGlyph(c)).join('')).join('\n')
const rowsOf = (frame: string | undefined): string[] => (frame ?? '').split('\n')
const has = (frame: string | undefined, needle: string): boolean => (frame ?? '').includes(needle)

function popupRow(frame: string | undefined, mark: string): string {
  const row = rowsOf(frame).find(r => r.includes(mark))
  if (row === undefined) return ''
  const at = row.indexOf(mark)
  const end = row.indexOf('│', at)
  return row.slice(at, end < 0 ? undefined : end).trim()
}

function seedMediaWorld(name: string, withModels: boolean): { home: string; cwd: string; mediaInitial: string; mediaNext: string } {
  const base = join(scratch, `world-${name}`)
  const home = join(base, 'home')
  const cwd = join(base, 'cwd', 'fixture-cwd')
  const mediaInitial = join(base, 'media-a')
  const mediaNext = join(base, 'media-b')
  const engine = join(base, 'engine')
  const serverPath = join(engine, 'dist', 'server.js')

  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  mkdirSync(mediaInitial, { recursive: true })
  mkdirSync(mediaNext, { recursive: true })
  mkdirSync(join(engine, 'dist'), { recursive: true })

  const catalogue = {
    runtime: { tag: 'fixture-1', families: [], componentFamilies: [], platforms: { 'darwin-arm64': [{ variant: 'metal', binary: 'sd-server', files: [{ asset: 'fixture.zip', bytes: 64, sha256: 'a'.repeat(64) }] }] } },
    recipes: [],
    files: withModels
      ? [
          { path: 'image.gguf', bytes: 8, repo: 'fixture/images', source: 'image.gguf', sha256: 'b'.repeat(64) },
          { path: 'other.gguf', bytes: 4, repo: 'fixture/images', source: 'other.gguf', sha256: 'c'.repeat(64) },
          { path: 'video.gguf', bytes: 16, repo: 'fixture/videos', source: 'video.gguf', sha256: 'd'.repeat(64) },
          { path: 'video2.gguf', bytes: 12, repo: 'fixture/videos', source: 'video2.gguf', sha256: 'f'.repeat(64) },
          { path: 'encoder.gguf', bytes: 2, repo: 'fixture/shared', source: 'encoder.gguf', sha256: 'e'.repeat(64) },
        ]
      : [],
    models: withModels
      ? [
          { id: 'image-one', kind: 'image', license: 'Apache-2.0', steps: 9, multiple: 16, residentBytes: 6 * 1024 ** 3, secondsPerImage: 12, slots: { diffusion_model: 'image.gguf', llm: 'encoder.gguf' } },
          { id: 'image-two', kind: 'image', license: 'MIT', steps: 4, multiple: 16, residentBytes: 4 * 1024 ** 3, slots: { diffusion_model: 'other.gguf', llm: 'encoder.gguf' } },
          { id: 'video-one', kind: 'video', license: 'Apache-2.0', steps: 20, multiple: 32, residentBytes: 20 * 1024 ** 3, slots: { diffusion_model: 'video.gguf' } },
          { id: 'video-two', kind: 'video', license: 'BSD-3-Clause', steps: 16, multiple: 32, residentBytes: 18 * 1024 ** 3, slots: { diffusion_model: 'video2.gguf' } },
        ]
      : [],
  }
  writeFileSync(join(engine, 'catalog.json'), JSON.stringify(catalogue))
  writeFileSync(serverPath, 'throw new Error("Fixture server must not launch")\n')
  writeFileSync(join(engine, 'dist', 'config.js'), `import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
export async function readMediaConfig(root) { try { return JSON.parse(await readFile(join(root, 'config.json'), 'utf8')); } catch(e) { if(e.code !== 'ENOENT') throw e; return { imageModel: 'image-one', videoModel: 'video-one' }; } }
export async function writeMediaConfig(root, patch) { await mkdir(root, { recursive: true }); const next = { ...await readMediaConfig(root), ...patch }; await writeFile(join(root, 'config.json'), JSON.stringify(next)); return next; }
`)

  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({
    guardrails: { sovereignConsentSeen: true },
    view: { reducedMotion: true },
    activity: { tips: { enabled: false } },
    media: { root: mediaInitial, serverPath },
  }, null, 2))
  return { home, cwd, mediaInitial, mediaNext }
}

function driveEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_FULLSCREEN: '1',
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_HEALTH_STATE_DIR: join(home, 'health-state'),
    MERCURY_HOME: join(home, 'proof-home'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CRITTER: 'clam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
    MERCURY_JEV_BASE: 'http://127.0.0.1:1',
    MERCURY_ANTHROPIC_OAUTH_BASE: 'http://127.0.0.1:1',
    ANTHROPIC_BASE_URL: DEAD,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
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
    BROWSER: '/usr/bin/true',
    SHELL: existsSync('/bin/bash') ? '/bin/bash' : (process.env.SHELL ?? '/bin/sh'),
  }
  for (const key of ['NODE_ENV', 'MERCURY_DEMO', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_API_KEY_FILE_DESCRIPTOR', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'TYPESAFE_API_KEY', 'MEDIA_ROOT', 'MEDIA_CATALOG', 'MEDIA_IMAGE_MODEL', 'MEDIA_VIDEO_MODEL', 'MEDIA_OUTPUT_DIR', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'VSCODE_GIT_ASKPASS_MAIN', '__CFBundleIdentifier', 'TERMINAL_EMULATOR']) {
    delete env[key]
  }
  return env
}

type Capture = { marks: Record<string, string>; sends: number; receipts: number; stderr: string; endReason: string; status: number | null }
async function capture(name: string, cfg: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<Capture> {
  const cfgPath = join(scratch, `${name}.cfg.json`)
  const outPath = join(scratch, `${name}.grid.json`)
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  const status = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(PYTHON, [VSHOT, cfgPath], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(240_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(deadline)
      resolve(code)
    })
  })
  if (!existsSync(outPath)) throw new Error(`the capture wrote no grid: ${stderr.join('').slice(0, 400)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; sendReceipts?: unknown[]; marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
  const marks: Record<string, string> = {}
  for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
  marks.final = gridText(payload.grid)
  if (FRAMES) {
    mkdirSync(FRAMES, { recursive: true })
    for (const [label, frame] of Object.entries(marks)) writeFileSync(join(FRAMES, `${name}-${label}.txt`), `${frame}\n`)
  }
  return { marks, sends: (cfg.sends as unknown[]).length, receipts: payload.sendReceipts?.length ?? 0, stderr: stderr.join(''), endReason: payload.endReason ?? '', status }
}

const gated = (data: string, awaitText: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ data, atTick: 999, awaitText, requireAwait: true, minTick: 1, awaitSettleTicks: 3, ...extra })
const after = (data: string, ticks: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ data, afterPrevTicks: ticks, ...extra })
const boot = (): Array<Record<string, unknown>> => [
  gated('\r', 'New Session', { minTick: 5, awaitStableTicks: 6, awaitSettleTicks: 4 }),
  gated('\x1b[I', 'shortcuts', { minTick: 2, awaitSettleTicks: 6 }),
  gated('', 'ready ·', { awaitPattern: '(?:^|\\n) ready ·', minTick: 2, awaitSettleTicks: 6 }),
]
const dueDetail = (cap: Capture): string => `${cap.receipts}/${cap.sends} · status ${cap.status} · end ${cap.endReason} · ${cap.stderr.slice(-300)}`

async function pickAndSaveLeg(): Promise<void> {
  const { home, cwd, mediaInitial, mediaNext } = seedMediaWorld('pick-save', true)
  const clearInitial = BACKSPACE.repeat(mediaInitial.length + 10)
  const env = driveEnv(home)
  try {
    const cap = await capture('pick-save-140x40', {
      cols: 140,
      rows: 40,
      total: 550,
      cwd,
      argv: [NODE, DIST],
      sends: [
        ...boot(),
        after('/config', 2),
        after('\r', 3),
        gated('', CONFIG_TITLE, { awaitSettleTicks: 4, awaitStableTicks: 3 }),
        after('Media folder', 2),
        after(DOWN, 3),
        gated('', '› Media folder', { awaitSettleTicks: 3, awaitStableTicks: 2, mark: 'root-row' }),
        after(RIGHT, 2),
        gated('', 'Enter keeps the folder · esc back', { awaitSettleTicks: 3, awaitStableTicks: 2, mark: 'root-open' }),
        after(clearInitial, 2),
        after('/discarded/path', 2),
        after(ESC, 2),
        gated('', '› Media folder', { awaitSettleTicks: 3, awaitStableTicks: 2, mark: 'root-cancelled' }),
        after(RIGHT, 2),
        gated('', 'Enter keeps the folder · esc back', { awaitSettleTicks: 3, awaitStableTicks: 2 }),
        after(clearInitial, 2),
        after('relative/dir', 2),
        after('\r', 2),
        gated('', 'Media folder must be an absolute path.', { awaitSettleTicks: 3, awaitStableTicks: 2, mark: 'root-error' }),
        after(BACKSPACE.repeat(20), 2),
        after(mediaNext, 2),
        after('\r', 2),
        gated('', '› Media folder', { awaitSettleTicks: 4, awaitStableTicks: 2, mark: 'root-updated' }),
        after('/', 2),
        after(BACKSPACE.repeat(12), 2),
        after('Default image model', 2),
        after(DOWN, 3),
        gated('', '› Default image model', { awaitSettleTicks: 3, awaitStableTicks: 2, mark: 'image-row' }),
        after(RIGHT, 2),
        gated('', 'image-two · MIT', { awaitSettleTicks: 3, awaitStableTicks: 2, mark: 'image-open' }),
        after(DOWN, 2),
        after(ESC, 2),
        gated('', '› Default image model', { awaitSettleTicks: 3, awaitStableTicks: 2, mark: 'image-cancelled' }),
        after(RIGHT, 2),
        gated('', 'image-two · MIT', { awaitSettleTicks: 3, awaitStableTicks: 2 }),
        after(DOWN, 2),
        after('\r', 2),
        gated('', '› Default image model', { awaitPattern: '› Default image model\\s+image-two', awaitSettleTicks: 3, awaitStableTicks: 2, mark: 'image-picked' }),
        after('/', 2),
        after(BACKSPACE.repeat(19), 2),
        after('Default video model', 2),
        after(DOWN, 3),
        gated('', '› Default video model', { awaitSettleTicks: 3, awaitStableTicks: 2, mark: 'video-row' }),
        after(' ', 2),
        gated('', 'video-two · BSD-3-Clause', { awaitSettleTicks: 3, awaitStableTicks: 2, mark: 'video-open' }),
        after(DOWN, 2),
        after('\r', 2),
        gated('', '› Default video model', { awaitPattern: '› Default video model\\s+video-two', awaitSettleTicks: 3, awaitStableTicks: 2, mark: 'video-picked' }),
        after('\r', 2),
        gated('', '❯', { awaitPattern: `\\A(?![\\s\\S]*${CONFIG_TITLE})`, awaitStableTicks: 3, mark: 'closed' }),
      ],
      stableTicks: 4,
    }, env)
    const m = cap.marks
    tally.section('pick-save 140x40 · /config MediaConfigPicker covers folder esc/validation/submit, image & video selection, and disk save')
    tally.check('M1 every send became due', cap.receipts === cap.sends && cap.status === 0, dueDetail(cap))
    tally.check('M2 media-root picker opens with Media folder and hint', has(m['root-open'], 'Media folder') && has(m['root-open'], 'Enter keeps the folder · esc back'))
    tally.check('M3 esc inside media-root discards draft path and returns to config list', has(m['root-cancelled'], '› Media folder') && !has(m['root-cancelled'], '/discarded/path'), popupRow(m['root-cancelled'], '› Media folder'))
    tally.check('M4 relative path in media-root displays absolute-path error and keeps picker open', has(m['root-error'], 'Media folder must be an absolute path.') && has(m['root-error'], 'Enter keeps the folder · esc back'))
    tally.check('M5 image picker lists both fixture models and esc keeps image-one', has(m['image-open'], 'image-one · Apache-2.0') && has(m['image-open'], 'image-two · MIT') && popupRow(m['image-cancelled'], '› Default image model').endsWith('image-one'), popupRow(m['image-cancelled'], '› Default image model'))
    tally.check('M6 choosing image-two updates the Default image model row', popupRow(m['image-picked'], '› Default image model').endsWith('image-two'), popupRow(m['image-picked'], '› Default image model'))
    tally.check('M7 choosing video-two updates the Default video model row', has(m['video-open'], 'video-one · Apache-2.0') && has(m['video-open'], 'video-two · BSD-3-Clause') && popupRow(m['video-picked'], '› Default video model').endsWith('video-two'), popupRow(m['video-picked'], '› Default video model'))
    const savedSettings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as { media?: { root?: string } }
    const nextConfigPath = join(mediaNext, 'config.json')
    const savedConfig = existsSync(nextConfigPath) ? JSON.parse(readFileSync(nextConfigPath, 'utf8')) as { imageModel?: string; videoModel?: string } : null
    tally.check('M8 ↵ closes /config and persists media.root in settings.json', !has(m.closed, CONFIG_TITLE) && savedSettings.media?.root === mediaNext, JSON.stringify(savedSettings.media))
    tally.check('M9 ↵ writes chosen imageModel and videoModel into the new media folder config.json only', savedConfig?.imageModel === 'image-two' && savedConfig?.videoModel === 'video-two' && !existsSync(join(mediaInitial, 'config.json')), JSON.stringify(savedConfig))
  } finally {
    spawnSync(NODE, [DIST, 'daemon', 'stop'], { env, cwd, timeout: 20_000, stdio: 'pipe' })
  }
}

async function emptyCatalogueLeg(): Promise<void> {
  const { home, cwd } = seedMediaWorld('empty-cat', false)
  const env = driveEnv(home)
  try {
    const cap = await capture('empty-cat-140x40', {
      cols: 140,
      rows: 40,
      total: 400,
      cwd,
      argv: [NODE, DIST],
      sends: [
        ...boot(),
        after('/config', 2),
        after('\r', 3),
        gated('', CONFIG_TITLE, { awaitSettleTicks: 4, awaitStableTicks: 3 }),
        after('Default image model', 2),
        after(DOWN, 3),
        gated('', '› Default image model', { awaitSettleTicks: 3, awaitStableTicks: 2 }),
        after(RIGHT, 2),
        gated('', 'Open /imagesetup to choose a model.', { awaitSettleTicks: 3, awaitStableTicks: 2, mark: 'empty-open' }),
        after('\r', 2),
        gated('', '› Default image model', { awaitSettleTicks: 3, awaitStableTicks: 2, mark: 'empty-back' }),
        after(ESC, 2),
        gated('', '❯', { awaitPattern: `\\A(?![\\s\\S]*${CONFIG_TITLE})`, awaitStableTicks: 3, mark: 'closed' }),
      ],
      stableTicks: 4,
    }, env)
    const m = cap.marks
    tally.section('empty-cat 140x40 · MediaConfigPicker with an empty catalogue paints the /imagesetup fallback and Back closes it')
    tally.check('E1 every send became due', cap.receipts === cap.sends && cap.status === 0, dueDetail(cap))
    tally.check('E2 empty catalogue paints the /imagesetup guidance and Back option', has(m['empty-open'], 'Open /imagesetup to choose a model.') && has(m['empty-open'], 'Back'))
    tally.check('E3 ↵ on Back returns to the /config list and esc closes /config', has(m['empty-back'], '› Default image model') && !has(m.closed, CONFIG_TITLE))
  } finally {
    spawnSync(NODE, [DIST, 'daemon', 'stop'], { env, cwd, timeout: 20_000, stdio: 'pipe' })
  }
}

await pickAndSaveLeg()
await emptyCatalogueLeg()

if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`scratch kept: ${scratch}`)
tally.finish()
