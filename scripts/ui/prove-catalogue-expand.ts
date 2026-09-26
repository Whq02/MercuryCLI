#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const VSHOT = join(import.meta.dir, 'vshot.py')
const FIXTURE = join(import.meta.dir, 'catalogue-expand-fixture-server.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 400) : ''}`)
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`no POSIX pty capture driver on this host (${driver.kind}) — the door drives cannot run here`)
  process.exit(1)
}
if (!existsSync(DIST)) {
  console.error('dist/mercury.mjs missing — bun run build.ts first')
  process.exit(1)
}

const DEAD = 'http://127.0.0.1:9'
const OPENROUTER_KEY = 'sk-or-v1-fixture-expand-key-000001'
const HF_KEY = 'hf_fixture_expand_token_000001'

if (process.argv[2] === '--compose') {
  const port = Number(process.argv[3])
  const home = process.argv[4]!
  process.env.MERCURY_CONFIG_DIR = home
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  process.env.OPENROUTER_API_KEY = OPENROUTER_KEY
  process.env.MERCURY_OPENROUTER_API_BASE = `http://127.0.0.1:${port}/or/v1`
  process.env.HF_TOKEN = HF_KEY
  process.env.MERCURY_HUGGINGFACE_API_BASE = `http://127.0.0.1:${port}/hf/v1`
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const or = await import('../../src/services/providers/openrouter/openrouterCatalogue.ts')
  const hf = await import('../../src/services/providers/huggingface/huggingfaceCatalogue.ts')
  const orSnapshot = await or.refreshOpenrouterCatalogue('env', { force: true })
  const hfSnapshot = await hf.refreshHuggingfaceCatalogue({ force: true })
  const { getModelOptions, ANTHROPIC_MODEL_GROUP, isProviderActionRow } = await import('../../src/utils/model/modelOptions.ts')
  const picker = await import('../../src/utils/model/modelPickerGroups.ts')
  const options = getModelOptions()
  const orDoor = options.findIndex(o => o.value === or.OPENROUTER_EXPAND_OPTION_VALUE)
  const hfDoor = options.findIndex(o => o.value === hf.HUGGINGFACE_EXPAND_OPTION_VALUE)
  const rows = options.map(o => ({
    id: o.value,
    name: o.label,
    tag: o.description,
    group: o.group ?? ANTHROPIC_MODEL_GROUP,
    ...(isProviderActionRow(o.value) ? { action: true } : {}),
    ...(o.unavailable !== undefined ? { gated: true } : {}),
    ...(o.catalogueDoor ? { expand: { group: o.group ?? ANTHROPIC_MODEL_GROUP, family: o.catalogueDoor.family, total: o.catalogueDoor.total } } : {}),
  }))
  const { getMainLoopModel } = await import('../../src/utils/model/model.ts')
  const { providerFamilyOfSetting } = await import('../../src/utils/model/modelTransition.ts')
  const served = getMainLoopModel()
  const seatFamily = providerFamilyOfSetting(served)
  const seatGroup = rows.find(row => row.id === served)?.group ?? (seatFamily === 'openrouter' ? or.OPENROUTER_MODEL_GROUP : seatFamily === 'huggingface' ? hf.HUGGINGFACE_MODEL_GROUP : ANTHROPIC_MODEL_GROUP)
  const groups = picker.orderPickerGroups(picker.groupPickerRows(rows), { top: seatGroup })
  const folds = picker.initialPickerFolds(groups, seatGroup, served)
  const stops = picker.composePickerLines(groups, folds, '', () => undefined).filter(line => picker.isCursorStop(line))
  const stopOf = (group: string | undefined): number => stops.findIndex(line => line.kind === 'heading' && line.group === group)
  console.log(
    JSON.stringify({
      total: options.length,
      stops: stops.length,
      seatGroup,
      orStop: stopOf(options[orDoor]?.group),
      hfStop: stopOf(options[hfDoor]?.group),
      orFold: folds[options[orDoor]?.group ?? ''] ?? null,
      hfFold: folds[options[hfDoor]?.group ?? ''] ?? null,
      orDoor,
      hfDoor,
      orRows: orSnapshot?.models.length ?? -1,
      hfRows: hfSnapshot?.models.length ?? -1,
      orError: orSnapshot?.lastError ?? null,
      hfError: hfSnapshot?.lastError ?? null,
      orFamily: options[orDoor]?.catalogueDoor?.family ?? null,
      hfFamily: options[hfDoor]?.catalogueDoor?.family ?? null,
      orTotal: options[orDoor]?.catalogueDoor?.total ?? null,
      hfTotal: options[hfDoor]?.catalogueDoor?.total ?? null,
    }),
  )
  process.exit(0)
}

const scratch = mkdtempSync(join(tmpdir(), 'catalogue-expand-'))

const ledger = join(scratch, 'fixture-ledger.log')
const fixture = spawn(process.execPath, ['run', FIXTURE, ledger], { stdio: ['ignore', 'pipe', 'pipe'] })
const port = await new Promise<number>((resolvePort, reject) => {
  const killer = setTimeout(() => reject(new Error('fixture never printed PORT')), 15_000)
  fixture.stdout.on('data', (chunk: Buffer) => {
    const m = /PORT (\d+)/.exec(chunk.toString())
    if (m) {
      clearTimeout(killer)
      resolvePort(Number(m[1]))
    }
  })
})
const OR_BASE = `http://127.0.0.1:${port}/or/v1`
const HF_BASE = `http://127.0.0.1:${port}/hf/v1`

function childEnv(home: string, tag: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_OPERATOR: 'sam',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_DAEMON_DIR: join(scratch, `daemon-${tag}`),
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    ANTHROPIC_BASE_URL: DEAD,
    BROWSER: 'true',
    OPENROUTER_API_KEY: OPENROUTER_KEY,
    MERCURY_OPENROUTER_API_BASE: OR_BASE,
    HF_TOKEN: HF_KEY,
    MERCURY_HUGGINGFACE_API_BASE: HF_BASE,
  }
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'ZAI_API_KEY',
    'MOONSHOT_API_KEY',
    'DEEPSEEK_API_KEY',
    'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC',
    'NODE_ENV',
    'CI',
  ]) {
    delete env[key]
  }
  return env
}

const seededHome = (name: string): string => {
  const home = join(scratch, name)
  seedFirstRun(home, [ROOT])
  return home
}

console.log('============================================================')
console.log(' the catalogue door — both families, on the bundle, in a PTY')
console.log('============================================================')

console.log('[0] the composed catalogue over the fixture (the product\'s composition, a twin home, its own process)')
const indexHome = seededHome('home-index')
const composeRun = spawnSync(process.execPath, ['run', import.meta.path, '--compose', String(port), indexHome], {
  encoding: 'utf-8',
  env: childEnv(indexHome, 'compose'),
  cwd: ROOT,
  timeout: 120_000,
})
const composeLine = (composeRun.stdout ?? '').split('\n').filter(l => l.startsWith('{')).pop() ?? '{}'
const composed = JSON.parse(composeLine) as { total?: number; stops?: number; seatGroup?: string; orStop?: number; hfStop?: number; orFold?: string | null; hfFold?: string | null; orDoor?: number; hfDoor?: number; orRows?: number; hfRows?: number; orError?: string | null; hfError?: string | null; orFamily?: string | null; hfFamily?: string | null; orTotal?: number | null; hfTotal?: number | null }
check('the composition subprocess answered (both fixture catalogues landed there, 30 rows each)', composeRun.status === 0 && composed.orRows === 30 && composed.hfRows === 30, `status ${composeRun.status}: ${composeLine} ${(composeRun.stderr ?? '').slice(-300)}`)
const options = { length: composed.stops ?? 0 }
const orDoor = composed.orStop ?? -1
const hfDoor = composed.hfStop ?? -1
check('both families sit in the composed picker as folded headings (each holds a door past its listed rows)', orDoor >= 1 && hfDoor >= 1 && hfDoor !== orDoor && (composed.orDoor ?? -1) >= 24 && (composed.hfDoor ?? -1) >= 24, composeLine)
check('each door carries its family word and the live count of 30', composed.orFamily === 'OpenRouter' && composed.orTotal === 30 && composed.hfFamily === 'Hugging Face' && composed.hfTotal === 30, composeLine)

interface DriveResult {
  status: number | null
  marks: Map<string, string>
  final: string
  stderr: string
}
function drive(tag: string, home: string, sends: unknown[], total: number): DriveResult {
  const grid = join(scratch, `${tag}-grid.json`)
  const cfgPath = join(scratch, `${tag}-vshot.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', DIST], sends, total, cols: 120, rows: 40, out: grid, title: tag }))
  const res = spawnSync(driver.python, [VSHOT, cfgPath], {
    encoding: 'utf-8',
    env: childEnv(home, tag),
    cwd: ROOT,
    timeout: vshotBudgetMs(180_000),
  })
  const marks = new Map<string, string>()
  let final = ''
  if (existsSync(grid)) {
    const payload = JSON.parse(readFileSync(grid, 'utf8')) as {
      grid?: Array<Array<{ c: string }>>
      marks?: Array<{ label: string; grid: Array<Array<{ c: string }>> }>
    }
    const text = (g: Array<Array<{ c: string }>>): string => g.map(row => row.map(c => c.c).join('')).join('\n')
    for (const m of payload.marks ?? []) marks.set(m.label, text(m.grid))
    final = payload.grid ? text(payload.grid) : ''
  }
  return { status: res.status, marks, final, stderr: (res.stderr ?? '').trim() }
}

const headingOf = (screen: string, word: string): string => (screen.split('\n').find(l => new RegExp(`[▾▸❯] ${word.toUpperCase()} · `).test(l)) ?? '').replace(/^.*?│ ?/, '').replace(/\s*│\s*$/, '').trim()
const rowCount = (screen: string, prefix: string): number => screen.split('\n').filter(l => l.includes(prefix)).length
const lines = (screen: string, needle: string): string => screen.split('\n').filter(l => l.includes(needle)).join(' · ')

function filesCarrying(dir: string, needle: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    let entries: string[] = []
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const name of entries) {
      const p = join(d, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(p)
      else if (st.isFile() && st.size < 8 * 1024 * 1024) {
        try {
          if (readFileSync(p, 'utf8').includes(needle)) out.push(p)
        } catch {
        }
      }
    }
  }
  walk(dir)
  return out
}

function dumpHomeLogs(home: string): void {
  const logs: string[] = []
  const walk = (d: string): void => {
    let entries: string[] = []
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const name of entries) {
      const p = join(d, name)
      try {
        const st = statSync(p)
        if (st.isDirectory()) walk(p)
        else if (/\.(log|txt|jsonl)$/.test(name) || /debug|log/i.test(name)) logs.push(p)
      } catch {
      }
    }
  }
  walk(home)
  for (const p of logs.slice(0, 6)) {
    let text = ''
    try {
      text = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    const tail = text.split('\n').filter(l => l.trim() !== '').slice(-25)
    console.log(`\n──── log tail · ${p.replace(home, '<home>')} ────`)
    console.log(tail.map(l => l.slice(0, 300)).join('\n'))
  }
  if (logs.length === 0) console.log(`\n──── no log files under ${home} ────`)
}

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const ESC = '\x1b'
const TO_END = DOWN.repeat(options.length + 4)
const walkTo = (stop: number): string => TO_END + UP.repeat(options.length - 1 - stop)

type FamilySpec = { family: 'openrouter' | 'huggingface'; word: string; door: number; fold: 'folded' | 'top'; needleId: string; needleLabel: string; firstRow: string }

function familySends(spec: FamilySpec, settle: { atTick: number; settleTicks: number }): unknown[] {
  return [
      { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { atTick: settle.atTick, data: '/model', awaitText: 'Type a prompt', minTick: 5, awaitSettleTicks: settle.settleTicks },
      { requireAwait: true, awaitText: '❯ /model', awaitStableTicks: 2, data: '' },
      { afterPrevTicks: 2, data: '\r' },
      { requireAwait: true, awaitText: 'Mercury · model', awaitStableTicks: 3, mark: 'open', data: '' },
      { afterPrevTicks: 3, data: walkTo(spec.door) },
      { afterPrevTicks: 4, mark: 'walked', data: '' },
      ...(spec.fold === 'folded'
        ? [
            { requireAwait: true, awaitText: '↵ unfold', awaitStableTicks: 2, mark: 'door', data: '\x1b[C' },
            { requireAwait: true, awaitText: '→ unfolds the rest', awaitStableTicks: 2, mark: 'expanded', data: '\x1b[C' },
          ]
        : [
            { requireAwait: true, awaitText: '↵ fold', awaitStableTicks: 2, mark: 'door', data: '' },
            { requireAwait: true, awaitText: '→ unfolds the rest', awaitStableTicks: 2, mark: 'expanded', data: '\x1b[C' },
          ]),
      { afterPrevTicks: 5, mark: 'unfolded', data: '/' },
      { requireAwait: true, awaitText: 'type to filter', awaitStableTicks: 2, data: 'needle' },
      { requireAwait: true, awaitText: '/ needle', awaitStableTicks: 2, mark: 'filtered', data: ESC },
      { requireAwait: true, awaitText: 'filter by name or id', awaitStableTicks: 2, mark: 'cleared', data: ESC },
      { requireAwait: true, awaitText: 'Kept model as', awaitStableTicks: 2, mark: 'closed', data: '' },
      { afterPrevTicks: 6, data: '/model' },
      { requireAwait: true, awaitText: '❯ /model', awaitStableTicks: 2, data: '' },
      { afterPrevTicks: 2, data: '\r' },
      { requireAwait: true, awaitText: 'Mercury · model', awaitStableTicks: 3, data: '/' },
      { requireAwait: true, awaitText: 'type to filter', awaitStableTicks: 2, data: 'needle' },
      { requireAwait: true, awaitText: '/ needle', awaitStableTicks: 2, mark: 'refiltered', data: '\r' },
      { requireAwait: true, awaitText: 'Set model to', awaitStableTicks: 3, mark: 'selected', data: '' },
      { afterPrevTicks: 6, data: '/model' },
      { requireAwait: true, awaitText: '❯ /model', awaitStableTicks: 2, data: '' },
      { afterPrevTicks: 2, data: '\r' },
      { requireAwait: true, awaitText: 'Mercury · model', awaitStableTicks: 3, mark: 'reopened', data: '' },
      { afterPrevTicks: 4, data: '' },
  ]
}

function familyDrive(spec: FamilySpec): void {
  console.log(`[${spec.family}] the door: expand · filter · esc clears · esc collapses · esc closes · select a deep row`)
  let home = seededHome(`home-${spec.family}`)
  let res = drive(spec.family, home, familySends(spec, { atTick: 130, settleTicks: 15 }), 460)
  if (res.status !== 0 && /first stuck: '(Mercury · model|❯ \/model|Type a prompt|↑↓ choose)'/.test(res.stderr)) {
    console.log(`  (the picker never opened on the first boot — ${/first stuck: '[^']*'/.exec(res.stderr)?.[0] ?? ''}; one more boot)`)
    dumpHomeLogs(home)
    home = seededHome(`home-${spec.family}-2`)
    res = drive(`${spec.family}-2`, home, familySends(spec, { atTick: 220, settleTicks: 25 }), 520)
    if (res.status !== 0) dumpHomeLogs(home)
  }
  const failuresBefore = failures
  check(`${spec.family}: the drive delivered every awaited screen (a real boot; every ↵/esc landed)`, res.status === 0, `vshot ${res.status}: ${res.stderr.slice(-400)}`)
  const open = res.marks.get('open') ?? ''
  const door = res.marks.get('door') ?? ''
  const expanded = res.marks.get('expanded') ?? ''
  const unfolded = res.marks.get('unfolded') ?? ''
  const filtered = res.marks.get('filtered') ?? ''
  const cleared = res.marks.get('cleared') ?? ''
  const closed = res.marks.get('closed') ?? ''
  const selected = res.marks.get('selected') ?? ''
  const reopened = res.marks.get('reopened') ?? ''
  const headingWords = (screen: string): string => headingOf(screen, spec.word)
  if (spec.fold === 'folded') check(`${spec.family}: the picker opened with the family folded: its heading counts 30 live and shows no row`, /^▸ .* · 30 live$/.test(headingWords(open)) && rowCount(open, spec.firstRow) === 0, headingWords(open))
  else check(`${spec.family}: the picker opened with the family partly shown (the seat's own group): its heading counts 30 live and the rest is named`, /^[▾❯] .* · 30 live$/.test(headingWords(open)) && /↓ \d+ more · → unfolds the rest/.test(open), headingWords(open))
  check(`${spec.family}: the walk lands on the family heading (❯, 30 live) and the hint says ${spec.fold === 'folded' ? '↵ unfold' : '↵ fold'}`, /^❯ .* · 30 live$/.test(headingWords(door)) && door.includes(spec.fold === 'folded' ? '↵ unfold' : '↵ fold') && door.includes('esc or click outside closes'), `${headingWords(door)} · ${lines(door, '↑↓ select')}`)
  check(`${spec.family}: → opens the family partly — the first listed row paints and the rest is named`, rowCount(expanded, spec.firstRow) === 1 && /↓ \d+ more · → unfolds the rest/.test(expanded) && !expanded.includes(spec.needleId), lines(expanded, 'more'))
  check(`${spec.family}: → again unfolds the rest — no more line, the heading open (▾ or ❯)`, !unfolded.includes('→ unfolds the rest') && /^[▾❯] .* · 30 live$/.test(headingWords(unfolded)), headingWords(unfolded) + ' · ' + lines(unfolded, 'more'))
  check(`${spec.family}: typing narrows every group — the header reads N of M match and the deep row is focused`, /Mercury · model · \d+ of \d+ match/.test(filtered) && new RegExp(`│ │ (?:—|\\S[^│]*?)\\s{2,}${spec.needleId.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(filtered), lines(filtered, 'needle'))
  check(`${spec.family}: the hint says esc clears the filter while a filter stands`, filtered.includes('esc clears the filter'), lines(filtered, '↑↓ select'))
  check(`${spec.family}: the rows the filter does not match are gone (no "${spec.firstRow}" on screen)`, !filtered.includes(spec.firstRow), lines(filtered, 'expand-model'))
  check(`${spec.family}: esc clears the filter — the plain header is back and the picker stays`, !cleared.includes('/ needle') && cleared.includes('filter by name or id') && !cleared.includes(' match') && cleared.includes('Mercury · model'), lines(cleared, 'Mercury'))
  check(`${spec.family}: esc with no filter closes the picker (the receipt line)`, closed.includes('Kept model as'), lines(closed, 'Kept'))
  check(`${spec.family}: ↵ on the filtered deep row selects it — the receipt names the row`, selected.includes(`Set model to ${spec.needleLabel}`), lines(selected, 'Set model'))
  check(`${spec.family}: re-opening the picker opens the family whole at mount (the current model lives past its listed rows) with the deep row focused and marked current`, /^[▾❯] .* · 30 live$/.test(headingWords(reopened)) && new RegExp(`│ │ (?:—|\\S[^│]*?)\\s{2,}${spec.needleId.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\S*\\s{2,}current`).test(reopened), lines(reopened, spec.needleLabel) + ' || ' + headingWords(reopened))
  const carriers = filesCarrying(home, spec.needleId).concat(filesCarrying(join(scratch, `daemon-${spec.family}`), spec.needleId), filesCarrying(join(scratch, `daemon-${spec.family}-2`), spec.needleId))
  check(`${spec.family}: the persisted model is the deep row's id (${spec.needleId}) — on disk in the scratch home`, carriers.length >= 1, `files: ${carriers.join(', ') || 'none'} · settings: ${existsSync(join(home, 'settings.json')) ? readFileSync(join(home, 'settings.json'), 'utf8').slice(0, 300) : 'absent'}`)
  if (failures !== failuresBefore) {
    for (const [label, screen] of res.marks) {
      console.log(`\n──── ${spec.family} · mark "${label}" ────`)
      console.log(screen.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l !== '').join('\n'))
    }
    console.log(`\n──── ${spec.family} · final ────`)
    console.log(res.final.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l !== '').join('\n'))
  }
}

familyDrive({
  family: 'openrouter',
  word: 'OpenRouter',
  door: orDoor,
  fold: composed.orFold === 'top' ? 'top' : 'folded',
  needleId: 'openrouter/deepvendor/needle-model',
  needleLabel: 'Needle Model',
  firstRow: 'openrouter/fixture-vendor/expand-model-0',
})
familyDrive({
  family: 'huggingface',
  word: 'Hugging Face',
  door: hfDoor,
  fold: composed.hfFold === 'top' ? 'top' : 'folded',
  needleId: 'huggingface/deeporg/needle-model',
  needleLabel: 'needle-model',
  firstRow: 'huggingface/fixture-org/expand-model-0',
})

const served = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(l => l.includes('/models')) : []
check('the fixture served the catalogue fetches (both families, this process and the drives)', served.some(l => l.includes('/or/v1/models')) && served.some(l => l.includes('/hf/v1/models')), `served ${served.length}`)

fixture.kill('SIGTERM')
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ CATALOGUE DOOR — BOTH FAMILIES GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
