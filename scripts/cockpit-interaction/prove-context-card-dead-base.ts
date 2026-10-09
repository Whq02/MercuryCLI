#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { CONTEXT_CARD_WORDS } from '../../src/commands/context/context.tsx'

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const ROOT = resolve(import.meta.dir, '../..')
const DIST = resolve(arg('--dist') ?? join(ROOT, 'dist/mercury.mjs'))
const FRAMES = arg('--frames')
if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first, or name a bundle with --dist`)
  process.exit(1)
}
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') throw new Error(driver.remedy)
const vendoredNode = join(dirname(DIST), 'vendor/node', process.platform === 'win32' ? 'node.exe' : join('bin', 'node'))
const node = existsSync(vendoredNode) ? vendoredNode : 'node'
const WORLD_ROOT = existsSync('/private/tmp/mw') ? '/private/tmp/mw' : realpathSync(tmpdir())
const SCRATCH = realpathSync(mkdtempSync(join(WORLD_ROOT, 'context-dead-')))
const work = join(SCRATCH, 'work')
const home = join(SCRATCH, 'home')
mkdirSync(work, { recursive: true })
mkdirSync(home, { recursive: true })
writeFileSync(join(work, 'README.md'), '# context card fixture\n')
seedFirstRun(home, [work])
if (FRAMES !== undefined) mkdirSync(FRAMES, { recursive: true })

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const DEAD = 'http://127.0.0.1:9'
const env: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: join(home, 'daemon'),
  MERCURY_HOME: join(home, 'proof-home'),
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_UPDATE_NOTICE: '0',
  MERCURY_CRITTER: 'jellyfish',
  TERM_PROGRAM: 'vscode',
  BROWSER: '/usr/bin/true',
  ANTHROPIC_API_KEY: FIXTURE_API_KEY,
  ANTHROPIC_BASE_URL: DEAD,
  MERCURY_ANTHROPIC_OAUTH_BASE: 'http://127.0.0.1:1',
  TERM: 'xterm-256color',
  LANG: 'en_US.UTF-8',
  COLORTERM: 'truecolor',
}
for (const key of ['NODE_ENV', 'MERCURY_DEMO', 'MERCURY_FULLSCREEN', 'MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN']) delete env[key]

type Cell = { c: string }
type Grid = Cell[][]
const gridText = (grid: Grid): string => grid.map(row => row.map(cell => cell.c || ' ').join('').trimEnd()).join('\n')

console.log('/context on a chat whose provider base cannot answer: the card paints at once with its counting words, and the chart lands with its honest-absence line inside the count’s own budget — never minutes of nothing (the built product in a PTY)')
const cols = 120
const rows = 40
const sends = [
  { requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
  { requireAwait: true, awaitText: 'Type a prompt', minTick: 5, awaitSettleTicks: 3, data: '/context' },
  { afterPrevTicks: 2, data: '\r' },
  { requireAwait: true, awaitText: 'counting the context window', awaitSettleTicks: 1, mark: 'card', data: '' },
]
const cfgPath = join(SCRATCH, 'cfg.json')
const outPath = join(SCRATCH, 'grid.json')
writeFileSync(cfgPath, JSON.stringify({ argv: [node, DIST], cwd: work, cols, rows, total: 450, sends, readyText: ['category sizes not measured on this source'], readySettleTicks: 3, stableTicks: 4, out: outPath }))
const t0 = Date.now()
const refusal = await new Promise<string | null>((resolveRun, rejectRun) => {
  execFile(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], { env, cwd: work, timeout: vshotBudgetMs(120_000), maxBuffer: 1 << 26 }, (error, _stdout, stderr) => {
    if (error && !existsSync(outPath)) rejectRun(new Error(`${String(error)}\n${stderr}`))
    else resolveRun(error ? String(stderr).split('\n').find(line => line.includes('[vshot]')) ?? String(error) : null)
  })
})
const elapsedS = Math.round((Date.now() - t0) / 1000)
await new Promise<void>(done => {
  execFile(node, [DIST, 'daemon', 'stop'], { env, cwd: work, timeout: 30_000 }, () => done())
})
try {
  if (refusal !== null) {
    check('the card paints at once and the chart lands inside the count’s budget', false, refusal.slice(0, 300))
  } else {
    const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; marks?: Array<{ label: string; grid: Grid; atTick?: number }> }
    const card = payload.marks?.find(m => m.label === 'card')
    const cardText = card === undefined ? '' : gridText(card.grid)
    const final = gridText(payload.grid)
    if (FRAMES !== undefined) {
      writeFileSync(join(FRAMES, `context-card-${cols}x${rows}.txt`), `${cardText}\n`)
      writeFileSync(join(FRAMES, `context-chart-${cols}x${rows}.txt`), `${final}\n`)
    }
    check('the card painted at once, pending: the context lockup and the counting words', card !== undefined && cardText.includes('— context') && cardText.includes(CONTEXT_CARD_WORDS.counting), cardText.split('\n').filter(l => l.includes('context')).join(' | ').slice(0, 300))
    check(`the chart landed with the honest-absence line inside the count’s budget (${elapsedS} s for the whole capture)`, final.includes('category sizes not measured on this source') && final.includes('Breakdown') && final.includes('Free space'), final.split('\n').filter(l => l.includes('Breakdown') || l.includes('measured')).join(' | ').slice(0, 300))
    check('the composer is back and ready after the chart', final.includes('Type a prompt') && !final.includes(CONTEXT_CARD_WORDS.counting))
  }
} finally {
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}
console.log(failures === 0 ? '\nprove-context-card-dead-base: ALL LAWS HOLD' : `\nprove-context-card-dead-base: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
