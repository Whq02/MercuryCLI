#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at < 0 ? undefined : process.argv[at + 1]
}
const BIN = argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
const FRAMES = argAfter('--frames')
const VSHOT = join(import.meta.dir, 'vshot.py')
const FIXTURE = join(import.meta.dir, 'openrouter-catalogue-fixture-server.ts')
const KEY = 'proof-key-ci-gate-not-a-real-key'
const OPENROUTER_KEY = 'sk-or-v1-fixture0000000000000000'
const DEAD = 'http://127.0.0.1:9'
const ESC = '\x1b'
const LEFT = `${ESC}[D`
const RIGHT = `${ESC}[C`
const SHIFT_RIGHT = `${ESC}[1;2C`
const SHIFT_LEFT = `${ESC}[1;2D`
const TAB = '\t'
const LLAMA_ID = 'openrouter/meta-llama/llama-5-405b-instruct'
const LLAMA_STEM = 'openrouter/meta-llama/llama-5'
const LLAMA_NAME = 'Meta: Llama 5 405B Instruct'
const GROWN_ID = 'nvidia/nemotron-3-ultra:free'
const CHANGED_NOTICE = 'OpenRouter — the live list changed; rows updated'
const DRAFT = 'the quick brown fox'
const PICKER_CHORD = '\x18j'
const CLICK_OUTSIDE = '\x1b[<0;90;43M\x1b[<0;90;43m'
const KEEP = process.env.MODEL_PICKER_GROUPS_KEEP === '1'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

process.env.ANTHROPIC_API_KEY = KEY
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'model-picker-groups-')))
const CWD = join(ROOT, 'fixture-cwd')
mkdirSync(join(CWD, '.mercury'), { recursive: true })
writeFileSync(join(CWD, 'README.md'), 'a fixture folder\n')
const NODE = existsSync(join(dirname(BIN), 'vendor', 'node', 'bin', 'node')) ? join(dirname(BIN), 'vendor', 'node', 'bin', 'node') : 'node'

function childEnv(home: string, openrouterBase: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_API_KEY: KEY,
    OPENROUTER_API_KEY: OPENROUTER_KEY,
    MERCURY_CRITTER: 'clam',
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    BROWSER: 'true',
    TERM_PROGRAM: 'vscode',
    MERCURY_IDE_SKIP_AUTO_INSTALL: '1',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor-state'),
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_HOME: join(home, 'proof-home'),
    ANTHROPIC_BASE_URL: DEAD,
    MERCURY_OPENAI_API_BASE: DEAD,
    MERCURY_OPENAI_CHATGPT_BASE: DEAD,
    MERCURY_OPENAI_AUTH_BASE: DEAD,
    MERCURY_OPENROUTER_API_BASE: openrouterBase,
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
  }
  for (const k of [
    'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
    'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'MERCURY_OAUTH_TOKEN', 'NODE_ENV', 'MERCURY_DEMO', 'TERMINAL_EMULATOR',
    '__CFBundleIdentifier', 'MERCURY_MODEL', 'MERCURY_DEFAULT_FABLE_MODEL', 'MERCURY_DEFAULT_OPUS_MODEL', 'MERCURY_DEFAULT_SONNET_MODEL',
  ]) {
    delete env[k]
  }
  return env
}

function seededHome(tag: string): string {
  const home = join(ROOT, `home-${tag}`)
  seedFirstRun(home, [CWD])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ prefersReducedMotion: true, spinnerTipsEnabled: false }))
  writeFileSync(join(home, 'keybindings.json'), JSON.stringify({ bindings: [{ context: 'Global', bindings: { 'ctrl+x j': 'command:model' } }] }))
  writeFileSync(
    join(home, 'critter-profile.json'),
    JSON.stringify({ v: 1, seed: '00000000-0000-4000-8000-00000000c0de', createdAt: 1787600000000, milestones: { settles: 0, recoveries: 0 }, quiet: true, seenTips: {}, openedSurfaces: [] }),
  )
  return home
}

type Send = Record<string, unknown>
type Grid = Array<Array<{ c: string }>>
type Capture = { status: number | null; stderr: string; lines: string[]; marks: Map<string, string[]> }

const driver = resolveCaptureDriver()
const textOf = (grid: Grid): string[] => grid.map(row => row.map(cell => cell.c).join(''))

function capture(id: string, env: NodeJS.ProcessEnv, sends: Send[], opts: { total: number; ready: string[] }): Capture {
  if (driver.kind !== 'posix-pty') throw new Error(`no POSIX pty capture driver on this host (${driver.kind})`)
  const out = join(ROOT, `${id}.json`)
  const cfgPath = join(ROOT, `${id}.cfg.json`)
  writeFileSync(
    cfgPath,
    JSON.stringify({ argv: [NODE, BIN], cwd: CWD, cols: 178, rows: 51, total: opts.total, readySettleTicks: 4, stableTicks: 3, sends, readyText: opts.ready, out }),
  )
  const res = spawnSync(driver.python, [VSHOT, cfgPath], { encoding: 'utf-8', env, timeout: vshotBudgetMs(opts.total * 200 + 90_000) })
  const marks = new Map<string, string[]>()
  let lines: string[] = []
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid?: Grid; marks?: Array<{ label: string; grid: Grid }> }
    if (payload.grid) lines = textOf(payload.grid)
    for (const m of payload.marks ?? []) marks.set(m.label, textOf(m.grid))
  }
  if (res.status !== 0) {
    console.log(`  ── ${id}: vshot exit ${res.status} ──`)
    for (const row of lines) console.log('  │' + row.replace(/\s+$/, ''))
    console.log((res.stderr ?? '').trim().split('\n').slice(-8).join('\n'))
  }
  return { status: res.status, stderr: res.stderr ?? '', lines, marks }
}

const innerOf = (line: string): string => line.replace(/^.*?│ ?/, '').replace(/\s*│\s*$/, '').trim()
const headingOf = (lines: string[], name: string): string => innerOf(lines.find(l => new RegExp(`[▾▸❯] ${name} · `).test(l)) ?? '')
const headingRow = (lines: string[], name: string): number => lines.findIndex(l => new RegExp(`[▾▸❯] ${name} · `).test(l))
const boxedRow = (lines: string[]): string => innerOf(lines.find(l => l.includes('│ │ ')) ?? '')
const rowOf = (lines: string[], id: string): string => innerOf(lines.find(l => l.includes(`  ${id}  `) || l.includes(`  ${id}`)) ?? '')

if (!existsSync(BIN)) {
  console.error(`  ${BIN} missing — bun run build.ts first (or pass --dist <bundle>)`)
  process.exit(1)
}

section('the picker on the built product: open · filter · fold · switch · a second session sees the top group change')
const fixture = spawn(process.execPath, ['run', FIXTURE, '0', '2'], { stdio: ['ignore', 'pipe', 'pipe'] })
try {
  const port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error('the OpenRouter fixture did not print PORT')), vshotBudgetMs(15_000))
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
      reject(new Error(`the OpenRouter fixture exited ${code}`))
    })
  })
  const home = seededHome('two-sessions')
  const env = childEnv(home, `http://127.0.0.1:${port}/api/v1`)
  const birth: Send[] = [
    { requireAwait: true, awaitText: 'n new session', awaitStableTicks: 3, data: 'n' },
    { requireAwait: true, awaitText: 'contract?', awaitSettleTicks: 2, data: ESC },
    { requireAwait: true, awaitText: '← back', minTick: 5, awaitSettleTicks: 4, awaitStableTicks: 3, data: '' },
  ]
  const openPicker: Send[] = [
    { requireAwait: true, awaitText: 'Type a prompt', minTick: 2, awaitSettleTicks: 2, data: '/model' },
    { requireAwait: true, awaitText: '❯ /model', awaitStableTicks: 2, data: '\r' },
  ]
  const c = capture('two-sessions', env, [
    { atTick: 999, requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: SHIFT_RIGHT },
    { requireAwait: true, awaitText: 'coordinator model', awaitStableTicks: 3, data: TAB },
    ...birth,
    ...openPicker,
    { requireAwait: true, awaitText: 'Mercury · model', awaitStableTicks: 3, mark: 'open', data: '/' },
    { requireAwait: true, awaitText: 'type to filter', awaitStableTicks: 2, data: 'llama' },
    { requireAwait: true, awaitText: '/ llama', awaitStableTicks: 3, mark: 'filtered', data: ESC },
    { requireAwait: true, awaitText: 'filter by name or id', awaitStableTicks: 2, mark: 'cleared', data: LEFT },
    { afterPrevTicks: 3, data: LEFT },
    { afterPrevTicks: 4, mark: 'folded', data: RIGHT },
    { afterPrevTicks: 4, mark: 'unfolded', data: '/' },
    { requireAwait: true, awaitText: 'type to filter', awaitStableTicks: 2, data: 'llama' },
    { requireAwait: true, awaitText: '/ llama', awaitStableTicks: 3, data: '\r' },
    { requireAwait: true, awaitText: `Set model to ${LLAMA_NAME}`, awaitStableTicks: 3, mark: 'switched', data: '' },
    ...openPicker,
    { requireAwait: true, awaitText: 'Mercury · model', awaitStableTicks: 3, mark: 'reopened', data: '/' },
    { requireAwait: true, awaitText: 'type to filter', awaitStableTicks: 2, data: '(' },
    { requireAwait: true, awaitText: '/ (', awaitStableTicks: 3, mark: 'metacharacter', data: ESC },
    { requireAwait: true, awaitText: 'filter by name or id', awaitStableTicks: 2, data: ESC },
    { requireAwait: true, awaitText: 'Kept model as', awaitStableTicks: 2, data: DRAFT },
    { requireAwait: true, awaitText: DRAFT, awaitStableTicks: 2, data: PICKER_CHORD[0]! },
    { afterPrevTicks: 2, data: PICKER_CHORD[1]! },
    { requireAwait: true, awaitText: 'Mercury · model', awaitStableTicks: 3, mark: 'draft-open', data: CLICK_OUTSIDE },
    { afterPrevTicks: 12, mark: 'draft-closed', data: ESC },
    { afterPrevTicks: 2, data: ESC },
    { requireAwait: true, awaitText: 'Type a prompt', awaitStableTicks: 2, data: SHIFT_LEFT },
    { requireAwait: true, awaitText: 'STATUS & TITLE', awaitStableTicks: 3, data: '' },
    ...birth,
    ...openPicker,
    { requireAwait: true, awaitText: 'Mercury · model', awaitStableTicks: 3, mark: 'second', data: '' },
    { afterPrevTicks: 8, mark: 'refreshed', data: ESC },
    { afterPrevTicks: 4, data: '' },
  ], { total: 1100, ready: ['esc focused chat', 'Type a prompt'] })
  if (FRAMES !== undefined) {
    mkdirSync(FRAMES, { recursive: true })
    for (const [mark, lines] of c.marks) writeFileSync(join(FRAMES, `groups-178x51-${mark}.txt`), lines.join('\n') + '\n')
  }
  const open = c.marks.get('open') ?? []
  const filtered = c.marks.get('filtered') ?? []
  const cleared = c.marks.get('cleared') ?? []
  const folded = c.marks.get('folded') ?? []
  const unfolded = c.marks.get('unfolded') ?? []
  const switched = c.marks.get('switched') ?? []
  const reopened = c.marks.get('reopened') ?? []
  const metacharacter = c.marks.get('metacharacter') ?? []
  const draftOpen = c.marks.get('draft-open') ?? []
  const draftClosed = c.marks.get('draft-closed') ?? []
  const second = c.marks.get('second') ?? []
  const refreshed = c.marks.get('refreshed') ?? []
  check('the drive delivered every send (exit 0)', c.status === 0, `exit ${c.status}`)
  check('the picker opens with the plain title and no CHOOSE A MODEL line', open.some(l => innerOf(l) === 'Mercury · model') && !open.some(l => l.includes('CHOOSE A MODEL')), open.slice(2, 6).map(innerOf).join(' | '))
  check("the seat's own provider leads: ANTHROPIC · API key · its tail · N live, its current row boxed", /^▾ ANTHROPIC · API key · …\S+ · \d+ live$/.test(headingOf(open, 'ANTHROPIC')) && headingRow(open, 'ANTHROPIC') < headingRow(open, 'OPENROUTER') && /\S.* {2,}claude-\S+ {2,}current {2,}/.test(boxedRow(open)), `${headingOf(open, 'ANTHROPIC')} · ${boxedRow(open)}`)
  check('the OpenRouter heading reads the key door with the fixture count', /^[▾▸] OPENROUTER · API key · …\S+ · 5 live$/.test(headingOf(open, 'OPENROUTER')), headingOf(open, 'OPENROUTER'))
  check('no row reads switch and no ○ / ● glyph paints', !open.some(l => l.includes('○') || l.includes('●') || / switch {2,}/.test(l)))
  check('the hint row is the ratified line', open.some(l => innerOf(l) === '↑↓ select · ↵ switch · c context · → ← fold · / filter · esc or click outside closes'), open.filter(l => l.includes('↑↓ select')).map(innerOf).join(' | '))
  check('the filter narrows every group: the header counts the match, only OpenRouter stands, the llama row is boxed', /Mercury · model · 1 of \d+ match/.test(filtered.map(innerOf).join('\n')) && headingRow(filtered, 'ANTHROPIC') < 0 && headingRow(filtered, 'OPENROUTER') >= 0 && boxedRow(filtered).includes(LLAMA_STEM), `${filtered.slice(2, 8).map(innerOf).join(' | ')} · ${boxedRow(filtered)}`)
  check('the first esc clears the filter and keeps the picker (the placeholder is back, the header plain)', cleared.some(l => innerOf(l) === '/ filter by name or id') && cleared.some(l => innerOf(l) === 'Mercury · model') && headingRow(cleared, 'ANTHROPIC') >= 0, cleared.slice(2, 6).map(innerOf).join(' | '))
  check('← ← folds the provider the cursor was in: its heading alone, ▸ or ❯, no claude row', headingRow(folded, 'ANTHROPIC') >= 0 && !folded.some(l => /  claude-\S+ {2,}/.test(l)), `${headingOf(folded, 'ANTHROPIC')} · ${folded.filter(l => l.includes('claude-')).length} claude rows`)
  check('→ unfolds it again', unfolded.some(l => /  claude-\S+ {2,}/.test(l)), headingOf(unfolded, 'ANTHROPIC'))
  check('↵ on the filtered row switches the session: the receipt names the row', switched.some(l => l.includes(`Set model to ${LLAMA_NAME}`)), switched.filter(l => l.includes('Set model')).map(innerOf).join(' | '))
  check('re-opened from the session now on an OpenRouter model: OPENROUTER leads, its row current, ANTHROPIC after it', headingRow(reopened, 'OPENROUTER') >= 0 && headingRow(reopened, 'OPENROUTER') < headingRow(reopened, 'ANTHROPIC') && /\S.* {2,}openrouter\/meta-llama\/llama-5\S* {2,}current {2,}/.test(rowOf(reopened, LLAMA_STEM) || boxedRow(reopened)), `${headingOf(reopened, 'OPENROUTER')} · ${boxedRow(reopened)}`)
  check("a second session on the default: ANTHROPIC leads again (the seat's own), OPENROUTER next by most recent use, OPENAI after it in today's order", headingRow(second, 'ANTHROPIC') >= 0 && headingRow(second, 'ANTHROPIC') < headingRow(second, 'OPENROUTER') && headingRow(second, 'OPENROUTER') < headingRow(second, 'OPENAI'), `${headingRow(second, 'ANTHROPIC')} / ${headingRow(second, 'OPENROUTER')} / ${headingRow(second, 'OPENAI')}`)
  check('a regex metacharacter in the filter is text: "(" matches nothing and the header counts the whole reach, never 0 of 0', metacharacter.some(l => /Mercury · model · 0 of [1-9]\d* match/.test(l)) && !metacharacter.some(l => l.includes('0 of 0 match')) && metacharacter.some(l => innerOf(l) === '/ ('), metacharacter.filter(l => l.includes('Mercury · model') || l.includes('/ (')).map(innerOf).join(' | '))
  const composerOf = (lines: string[]): string => (lines.find(l => l.includes('│❯ ')) ?? '').replace(/^.*?│❯ /, '').replace(/\s*│?\s*$/, '').trim()
  check('the picker opened by the chord over a typed draft and the draft stays under it', draftOpen.some(l => innerOf(l) === 'Mercury · model') && composerOf(draftOpen).startsWith(DRAFT), `composer "${composerOf(draftOpen)}"`)
  check('a click outside the picker closes it and leaves the draft exactly as typed', !draftClosed.some(l => l.includes('Mercury · model')) && draftClosed.some(l => l.includes('Kept model as')) && composerOf(draftClosed) === DRAFT, `composer "${composerOf(draftClosed)}"`)
  const laterOpens = [reopened, metacharacter, draftOpen, second, refreshed]
  check('the refresh on a later open re-reads the list and repaints in place: the changed-list notice names OpenRouter on the open that first saw the grown list', laterOpens.some(frame => frame.some(l => l.includes(CHANGED_NOTICE))), laterOpens.map(frame => frame.filter(l => l.includes('live list')).map(innerOf).join(' | ') || '-').join(' / '))
  check('the last open lists the grown id as a row and its heading counts six', refreshed.some(l => l.includes(GROWN_ID)) && /^[▾▸❯] OPENROUTER · API key · …\S+ · 6 live$/.test(headingOf(refreshed, 'OPENROUTER')), `${headingOf(refreshed, 'OPENROUTER')} · ${refreshed.filter(l => l.includes(GROWN_ID)).map(innerOf).join(' | ')}`)
  const ledger = join(home, '.model-use.json')
  check('the use record landed under the config home and names the OpenRouter switch', existsSync(ledger) && (JSON.parse(readFileSync(ledger, 'utf8')) as { uses?: Record<string, { model?: string }> }).uses?.openrouter?.model === LLAMA_ID, existsSync(ledger) ? readFileSync(ledger, 'utf8').slice(0, 300) : 'absent')
} finally {
  fixture.kill('SIGTERM')
}

if (!KEEP) rmSync(ROOT, { recursive: true, force: true })
else console.log(`\n  kept: ${ROOT}`)
console.log(failures === 0 ? '\n✅ the model picker: provider groups that fold, a filter, the seat on top, the order following use' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
