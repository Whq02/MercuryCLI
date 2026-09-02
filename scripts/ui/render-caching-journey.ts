#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = resolve(import.meta.dir, '../..')
const DIST = join(ROOT, 'dist/mercury.mjs')
const VSHOT = join(ROOT, 'scripts/ui/vshot.py')
const DEAD = 'http://127.0.0.1:9'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

if (!existsSync(DIST)) {
  console.error('render-caching-journey: dist/mercury.mjs missing — run the build first')
  process.exit(1)
}

type Send = {
  data: string
  requireAwait?: boolean
  awaitText?: string
  awaitSettleTicks?: number
  afterPrevTicks?: number
}

const FAMILY_NAMES = [
  'Anthropic',
  'OpenAI',
  'Gemini',
  'DeepSeek',
  'Moonshot',
  'Z.AI',
  'OpenRouter',
  'Custom endpoint',
  'Hugging Face',
  'Local models',
]

const TRUTH_STRINGS = [
  'adaptive',
  '1,024 tokens',
  '30m TTL',
  'context caching',
  'cache-hit input pricing',
  'nothing to adjust',
]

async function drive(args: {
  cols: number
  theme: 'dark' | 'true-black'
  dial: boolean
}): Promise<void> {
  const label = `${args.cols}-col ${args.theme}${args.dial ? ' +dial' : ''}`
  const home = mkdtempSync(join(realpathSync(tmpdir()), `caching-journey-`))
  const cwd = join(home, 'workspace')
  mkdirSync(cwd, { recursive: true })
  const configHome = join(home, 'confighome')
  seedFirstRun(configHome, [cwd])
  const cfgFile = join(configHome, '.mercury.json')
  try {
    const cfg = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>
    cfg['theme'] = args.theme
    writeFileSync(cfgFile, JSON.stringify(cfg))
  } catch {
    writeFileSync(cfgFile, JSON.stringify({ theme: args.theme }))
  }
  const out = join(home, 'grid.json')
  const cfgPath = join(home, 'cfg.json')
  const sends: Send[] = [
    { requireAwait: true, awaitText: '? for shortcuts', awaitSettleTicks: 4, data: '/caching\r' },
    ...(args.dial
      ? ([
          { requireAwait: true, awaitText: 'prompt-caching truth', awaitSettleTicks: 3, data: '\r' },
          { requireAwait: true, awaitText: 'future defaults', awaitSettleTicks: 2, data: '\r' },
        ] satisfies Send[])
      : []),
  ]
  writeFileSync(
    cfgPath,
    JSON.stringify({
      argv: ['node', DIST],
      cwd,
      sends,
      readyText: args.dial ? ['revision 2'] : ['prompt-caching truth'],
      readySettleTicks: 4,
      stableTicks: 4,
      total: 300,
      cols: args.cols,
      rows: 44,
      out,
    }),
  )
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: configHome,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    BROWSER: 'true',
    TERM_PROGRAM: 'vscode',
    MERCURY_IDE_SKIP_AUTO_INSTALL: '1',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_DECK_COMPANION: '0',
    MERCURY_TABULA_MINERVA: '0',
    MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor-state'),
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_HOME: join(home, 'proof-home'),
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
  }
  for (const key of [
    'NODE_ENV', 'IS_DEMO',
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'MERCURY_OAUTH_TOKEN', 'MERCURY_API_KEY_FILE_DESCRIPTOR',
    'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
    'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN',
    'MERCURY_CACHE_TTL', 'MERCURY_CACHE_TTL',
    'CURSOR_TRACE_ID', 'VSCODE_GIT_ASKPASS_MAIN', '__CFBundleIdentifier', 'VisualStudioVersion', 'TERMINAL_EMULATOR',
  ]) {
    delete env[key]
  }

  const run = await new Promise<{ code: number | null; output: string }>(resolveRun => {
    const child = spawn('/usr/bin/python3', [VSHOT, cfgPath], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    const killer = setTimeout(() => child.kill('SIGKILL'), 150000)
    child.on('close', code => {
      clearTimeout(killer)
      resolveRun({ code, output })
    })
  })
  let grid = ''
  try {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>> }
    grid = payload.grid.map(row => row.map(cell => cell.c || ' ').join('')).join('\n')
  } catch {
  }
  if (run.code !== 0) {
    check(`${label}: drive completed`, false, run.output.split('\n').filter(Boolean).slice(-3).join(' · ').slice(0, 280))
    if (grid !== '') console.error('── the stalled frame ──\n' + grid.split('\n').slice(0, 26).join('\n'))
    rmSync(home, { recursive: true, force: true })
    return
  }
  check(`${label}: drive completed`, true)
  for (const name of FAMILY_NAMES) {
    check(`${label}: paints ${name}`, grid.includes(name))
  }
  for (const truth of TRUTH_STRINGS) {
    check(`${label}: carries "${truth}"`, grid.includes(truth))
  }
  if (args.dial) {
    check(`${label}: the profile receipt painted (future defaults · revision 2)`,
      grid.includes('future defaults') && grid.includes('revision 2'))
    check(`${label}: the 1h consent line paints beside the live 1h choice`,
      grid.includes('doubles every cache write'))
    try {
      const bootEnv = JSON.parse(
        readFileSync(join(configHome, 'boot-env.json'), 'utf8'),
      ) as { version?: number; revision?: number; env?: Record<string, string>; receipt?: string }
      check(`${label}: boot-env.json holds the 1h choice, both spellings paired`,
        bootEnv.version === 1 && bootEnv.env?.MERCURY_CACHE_TTL === '1h' && bootEnv.env?.MERCURY_CACHE_TTL === '1h')
      check(`${label}: the committed revision is 2 (two dial turns, monotonic)`, bootEnv.revision === 2)
      check(`${label}: the stored receipt speaks new-session application`,
        (bootEnv.receipt ?? '').includes('applies to sessions created after revision 2'))
    } catch (e) {
      check(`${label}: boot-env.json readable`, false, String(e).slice(0, 120))
    }
  }
  const keep = process.env.CACHING_CAPTURE_DIR
  if (keep) {
    mkdirSync(keep, { recursive: true })
    writeFileSync(join(keep, `caching-${args.cols}-${args.theme}${args.dial ? '-dial' : ''}.txt`), grid)
  }
  rmSync(home, { recursive: true, force: true })
}

console.log('============================================================')
console.log(' /caching — the surface driven on the built dist')
console.log('============================================================')
await drive({ cols: 100, theme: 'dark', dial: true })
await drive({ cols: 120, theme: 'dark', dial: false })
await drive({ cols: 100, theme: 'true-black', dial: false })
await drive({ cols: 120, theme: 'true-black', dial: false })

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ THE /caching SURFACE PROVES OUT ON THE BUILT DIST')
