#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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
const CASE = argAfter('--case')
const VSHOT = join(import.meta.dir, 'vshot.py')
const KEY = 'proof-key-ci-gate-not-a-real-key'
const DEAD = 'http://127.0.0.1:9'
const ESC = '\x1b'
const DOWN = `${ESC}[B`
const RIGHT = `${ESC}[C`
const AGENT_ROW = 'Sub-agent default model'
const TEAMMATE_ROW = 'Default teammate model'
const SIZES: Array<[number, number]> = [[178, 51], [120, 40], [80, 21], [82, 17], [80, 14]]

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
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'config-model-doors-')))
const CWD = join(ROOT, 'fixture-cwd')
mkdirSync(join(CWD, '.mercury'), { recursive: true })
writeFileSync(join(CWD, 'README.md'), 'a fixture folder\n')
const NODE = existsSync(join(dirname(BIN), 'vendor', 'node', 'bin', 'node')) ? join(dirname(BIN), 'vendor', 'node', 'bin', 'node') : 'node'

function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_API_KEY: KEY,
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
  }
  for (const k of [
    'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
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

function capture(id: string, home: string, cols: number, rows: number, sends: Send[], opts: { total: number; ready: string[]; env?: NodeJS.ProcessEnv }): Capture {
  if (driver.kind !== 'posix-pty') throw new Error(`no POSIX pty capture driver on this host (${driver.kind})`)
  const out = join(ROOT, `${id}.json`)
  const cfgPath = join(ROOT, `${id}.cfg.json`)
  writeFileSync(
    cfgPath,
    JSON.stringify({ argv: [NODE, BIN], cwd: CWD, cols, rows, total: opts.total, readySettleTicks: 4, stableTicks: 3, sends, readyText: opts.ready, out }),
  )
  const res = spawnSync(driver.python, [VSHOT, cfgPath], { encoding: 'utf-8', env: { ...childEnv(home), ...opts.env }, timeout: vshotBudgetMs(opts.total * 200 + 90_000) })
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

const rowWith = (lines: string[], needle: string): string => lines.find(l => l.includes(needle)) ?? ''
const settingRow = (lines: string[], label: string): string =>
  lines.find(l => l.includes(`› ${label}`)) ?? lines.filter(l => l.includes(label) && !l.includes(`/ ${label}`)).at(-1) ?? ''
const valueOf = (lines: string[], label: string): string => {
  const row = settingRow(lines, label)
  const rest = row.slice(row.indexOf(label) + label.length)
  const border = rest.indexOf('│')
  return (border < 0 ? rest : rest.slice(0, border)).trim()
}
const configOf = (home: string): { agents?: { defaultModel?: string }; teammateDefaultModel?: string | null } =>
  JSON.parse(readFileSync(join(home, '.mercury.json'), 'utf8')) as { agents?: { defaultModel?: string }; teammateDefaultModel?: string | null }

console.log('============================================================')
console.log(' the two /config model doors open the live-list picker')
console.log(`   bundle: ${BIN}`)
console.log('============================================================')
if (!existsSync(BIN)) {
  console.error('  dist/mercury.mjs missing — bun run build.ts first')
  process.exit(1)
}

const READY = ['esc or click outside closes']
function openConfig(cols: number): Send[] {
  return [
    { atTick: 999, requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { atTick: 999, requireAwait: true, awaitText: cols < 100 ? '1 session on' : '← back', minTick: 5, awaitSettleTicks: 4, awaitStableTicks: 3, data: '' },
    { afterPrevTicks: 1, data: '/config' },
    { afterPrevTicks: 2, data: '\r' },
  ]
}

if (CASE === undefined) {
for (const [cols, rows] of SIZES) {
  section(`§1 ${cols}×${rows} · the sub-agent default model row: a picker door, every family live, the pick written as an exact id`)
  const home = seededHome(`agent-${cols}x${rows}`)
  const c = capture(`agent-${cols}x${rows}`, home, cols, rows, [
    ...openConfig(cols),
    { requireAwait: true, awaitText: 'Auto-compact', awaitSettleTicks: 4, data: 'Sub-agent default model' },
    { requireAwait: true, awaitText: AGENT_ROW, awaitSettleTicks: 3, awaitStableTicks: 3, data: '\r' },
    { afterPrevTicks: 3, data: '', mark: 'row-before' },
    { afterPrevTicks: 1, data: RIGHT },
    { requireAwait: true, awaitText: 'Inherit', awaitSettleTicks: 3, awaitStableTicks: 3, mark: 'picker', data: DOWN },
    { afterPrevTicks: 2, data: DOWN },
    { afterPrevTicks: 3, data: '', mark: 'focused' },
    { afterPrevTicks: 1, data: '\r' },
    { requireAwait: true, awaitText: AGENT_ROW, awaitSettleTicks: 4, awaitStableTicks: 3, mark: 'row-after', data: '' },
  ], { total: 420, ready: READY })
  check('the drive delivered every send (exit 0)', c.status === 0, `exit ${c.status}`)
  const before = c.marks.get('row-before') ?? []
  const picker = c.marks.get('picker') ?? []
  const after = c.marks.get('row-after') ?? []
  check("the row reads Inherit before any pick", valueOf(before, AGENT_ROW).startsWith('Inherit'), valueOf(before, AGENT_ROW))
  check('the door opens the model picker with the Inherit row leading', rowWith(picker, 'Inherit') !== '' && (cols < 100 || rowWith(picker, 'CHOOSE A MODEL') !== ''), picker.slice(0, 12).join(' | '))
  const footer = picker.find(l => /a choice, not a model|model IDs are real|not selectable|connect action/.test(l))
  check('the footer under the Inherit row names a choice, never a model id (the compact picker paints no footer)', footer === undefined || /a choice, not a model/.test(footer), footer ?? '')
  check('the picker lists more than one family group', cols < 100 || picker.filter(l => /MERCURY — .* MODELS/.test(l)).length >= 2, picker.filter(l => /MODELS/.test(l)).join(' | '))
  check('no picker row walks an alias list (no sonnet/opus/fable alias words as rows)', !picker.some(l => /^\s*[│❯]?\s*(sonnet|opus|fable|fable51)\s+/.test(l)), picker.filter(l => /\b(sonnet|opus|fable51)\b/.test(l)).join(' | '))
  const saved = configOf(home)
  check("a pick writes agents.defaultModel as the picked row's exact id, never a family word", typeof saved.agents?.defaultModel === 'string' && /[-/]/.test(saved.agents.defaultModel) && !['inherit', 'fable', 'opus', 'sonnet', 'haiku', 'fable51'].includes(saved.agents.defaultModel), JSON.stringify(saved.agents))
  const label = valueOf(after, AGENT_ROW)
  const focused = c.marks.get('focused') ?? []
  check("the row's value words are the picker's own row name for the pick (the row focused when ↵ was pressed)", label.length > 0 && !label.startsWith('Inherit') && !/^claude-/.test(label) && focused.some(l => l.includes(label)), label)
  writeFileSync(join(ROOT, `frame-agent-${cols}x${rows}-focused.txt`), (c.marks.get('focused') ?? []).join('\n'))
  writeFileSync(join(ROOT, `frame-agent-${cols}x${rows}-before.txt`), before.join('\n'))
  writeFileSync(join(ROOT, `frame-agent-${cols}x${rows}-picker.txt`), picker.join('\n'))
  writeFileSync(join(ROOT, `frame-agent-${cols}x${rows}-after.txt`), after.join('\n'))
}

for (const [cols, rows] of SIZES.slice(0, 1)) {
  section(`§2 ${cols}×${rows} · the teammate default model row: Default and Leader's model lead, every family after, a named model written`)
  const home = seededHome(`teammate-${cols}x${rows}`)
  const c = capture(`teammate-${cols}x${rows}`, home, cols, rows, [
    ...openConfig(cols),
    { requireAwait: true, awaitText: 'Auto-compact', awaitSettleTicks: 4, data: 'Default teammate model' },
    { requireAwait: true, awaitText: TEAMMATE_ROW, awaitSettleTicks: 3, awaitStableTicks: 3, data: '\r' },
    { afterPrevTicks: 3, data: '', mark: 'row-before' },
    { afterPrevTicks: 1, data: RIGHT },
    { requireAwait: true, awaitText: "Leader's model", awaitSettleTicks: 3, awaitStableTicks: 3, mark: 'picker', data: DOWN },
    { afterPrevTicks: 2, data: DOWN },
    { afterPrevTicks: 2, data: DOWN },
    { afterPrevTicks: 3, data: '', mark: 'focused' },
    { afterPrevTicks: 1, data: '\r' },
    { requireAwait: true, awaitText: TEAMMATE_ROW, awaitSettleTicks: 4, awaitStableTicks: 3, mark: 'row-after', data: '' },
  ], { total: 420, ready: READY })
  check('the drive delivered every send (exit 0)', c.status === 0, `exit ${c.status}`)
  const before = c.marks.get('row-before') ?? []
  const picker = c.marks.get('picker') ?? []
  const after = c.marks.get('row-after') ?? []
  check('the row reads Default before any pick', valueOf(before, TEAMMATE_ROW).startsWith('Default'), valueOf(before, TEAMMATE_ROW))
  check("the door opens the model picker with Default and Leader's model leading", rowWith(picker, 'Default') !== '' && rowWith(picker, "Leader's model") !== '' && rowWith(picker, 'CHOOSE A MODEL') !== '', picker.slice(0, 12).join(' | '))
  check('the picker lists more than one family group', picker.filter(l => /MERCURY — .* MODELS/.test(l)).length >= 2, picker.filter(l => /MODELS/.test(l)).join(' | '))
  const saved = configOf(home)
  check("a pick writes teammateDefaultModel as the picked row's exact id, never a family word", typeof saved.teammateDefaultModel === 'string' && /[-/]/.test(saved.teammateDefaultModel) && !['default', 'leader', 'fable', 'opus', 'sonnet', 'haiku', 'fable51'].includes(saved.teammateDefaultModel), JSON.stringify(saved.teammateDefaultModel))
  const label = valueOf(after, TEAMMATE_ROW)
  const focused = c.marks.get('focused') ?? []
  check("the row's value words are the picker's own row name for the pick (the row focused when ↵ was pressed)", label.length > 0 && !label.startsWith('Default') && !label.startsWith("Leader") && !/^claude-/.test(label) && focused.some(l => l.includes(label)), label)
  writeFileSync(join(ROOT, `frame-teammate-${cols}x${rows}-focused.txt`), (c.marks.get('focused') ?? []).join('\n'))
  writeFileSync(join(ROOT, `frame-teammate-${cols}x${rows}-before.txt`), before.join('\n'))
  writeFileSync(join(ROOT, `frame-teammate-${cols}x${rows}-picker.txt`), picker.join('\n'))
  writeFileSync(join(ROOT, `frame-teammate-${cols}x${rows}-after.txt`), after.join('\n'))
}

}

if (CASE === undefined || CASE === 'cold-catalogue') {
  section('a cold Config model door requests its live GPT list without a model turn')
  for (const [tag, rowLabel, leading] of [['agent', AGENT_ROW, 'Inherit'], ['teammate', TEAMMATE_ROW, "Leader's model"]]) {
    const home = seededHome(`cold-${tag}`)
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ model: 'opus', prefersReducedMotion: true, spinnerTipsEnabled: false }))
    writeFileSync(join(home, '.openai-auth.json'), JSON.stringify({ version: 1, tokens: { idToken: 'fixture-id', accessToken: 'fixture-access', refreshToken: 'fixture-refresh', accountId: 'acct_fixture', planType: 'plus', email: 'sam@example.test', accessTokenExpiresAtMs: Date.now() + 86_400_000 } }), { mode: 0o600 })
    const wireFile = join(home, 'wire.jsonl')
    const catalogueFile = join(home, 'models.json')
    writeFileSync(wireFile, '')
    const gpt = (id: string, display_name: string, priority: number) => ({ id, display_name, priority, visibility: 'public', supported_in_api: true, supported_reasoning_levels: ['low', 'medium', 'high'], default_reasoning_level: 'medium', context_window: 400_000, input_modalities: ['text', 'image'] })
    writeFileSync(catalogueFile, JSON.stringify({ models: [gpt('gpt-5.6-sol', 'GPT-5.6 Sol', 1), gpt('gpt-5.6-terra', 'GPT-5.6 Terra', 2)], afterTurn: [], delayMs: 0 }))
    const fixture = spawn(NODE, [join(REPO, 'scripts/journey/cap-offer-fixture-server.ts'), wireFile, catalogueFile], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      const port = await new Promise<number>((resolvePort, reject) => {
        const timer = setTimeout(() => reject(new Error('the catalogue fixture did not print PORT')), vshotBudgetMs(15_000))
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
          reject(new Error(`the catalogue fixture exited ${code}`))
        })
      })
      const base = `http://127.0.0.1:${port}`
      const c = capture(`cold-${tag}`, home, 120, 40, [
        ...openConfig(120),
        { requireAwait: true, awaitText: 'Auto-compact', awaitSettleTicks: 4, data: rowLabel },
        { requireAwait: true, awaitText: rowLabel, awaitSettleTicks: 3, data: '\r' },
        { afterPrevTicks: 3, data: RIGHT },
        { requireAwait: true, awaitText: leading, awaitSettleTicks: 4, data: `${ESC}[H` },
        { afterPrevTicks: 3, data: DOWN.repeat(5) },
        { afterPrevTicks: 25, data: '', mark: 'picker' },
      ], { total: 420, ready: ['CHOOSE A MODEL'], env: { MERCURY_OPENAI_CHATGPT_BASE: `${base}/chatgpt`, MERCURY_OPENAI_API_BASE: `${base}/openai/v1` } })
      const picker = c.marks.get('picker') ?? []
      const wire = readFileSync(wireFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string })
      check(`${tag}: the drive delivered every send`, c.status === 0, `exit ${c.status}`)
      check(`${tag}: exactly one live models request reached the fixture`, wire.filter(e => e.kind === 'models').length === 1, wire.map(e => e.kind).join(',') || 'no requests')
      check(`${tag}: the fetched GPT rows replaced the connecting row`, picker.some(l => l.includes('GPT-5.6 Sol')) && picker.some(l => l.includes('GPT-5.6 Terra')) && !picker.some(l => l.includes('GPT — connecting')), picker.filter(l => /GPT|connecting/.test(l)).join(' | '))
      check(`${tag}: fetching the list sent no model turn`, !wire.some(e => e.kind === 'openai'))
      if (FRAMES !== undefined) {
        mkdirSync(FRAMES, { recursive: true })
        writeFileSync(join(FRAMES, `config-cold-${tag}-120x40.json`), readFileSync(join(ROOT, `cold-${tag}.json`)))
        writeFileSync(join(FRAMES, `config-cold-${tag}-120x40.txt`), picker.join('\n') + '\n')
        writeFileSync(join(FRAMES, `config-cold-${tag}-wire.jsonl`), readFileSync(wireFile))
      }
    } finally {
      fixture.kill('SIGTERM')
    }
  }
}

console.log(`\nframes under ${ROOT}`)
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
