#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-catalogue-expand.ts — the /model CATALOGUE DOOR on the
//  BUILT bundle, in a real PTY, for BOTH live-catalogue families (OpenRouter
//  · Hugging Face), fed by ONE loopback fixture serving 30 rows each — past
//  the picker's 24-row bound, with a deep NEEDLE row at index 27.
//
//  The door's index in the picker comes from the SAME composition the
//  product runs (getModelOptions over the fixture catalogues, on a twin of
//  the seeded home) — never a hand-counted walk that a first-party row
//  change would silently break. That composition runs in a SUBPROCESS of
//  this file (the --compose mode below): importing the product into the
//  driving process mutated its environment and loaded the box right as the
//  children booted, and the picker then failed to open on ↵.
//
//  Per family, ONE boot on a seeded scratch home with the fixture credential:
//    open /model · Home · walk to the door (the id line says 'catalogue
//    door') · ↵ expands: the header line is on screen and the AVAILABLE
//    count grows by the six rows past the bound · type the needle: the
//    header carries the filter, the deep row is focused, the footer says
//    'esc clear' · esc clears the filter (the group is whole again, the
//    count holds) · esc collapses (the door row is focused, the count is
//    back, its copy says what ↵ does) · esc closes the picker (the outer
//    close is unchanged) · re-open, expand, filter, ↵ selects the deep row:
//    the receipt names it and the id persists in the scratch home · re-open:
//    the door opens at mount (the current model lives behind it) and the
//    CURRENT dot lands on the deep row.
// ============================================================================
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

// ── --compose mode: the product's own composition, in its own process ──────
//  argv: --compose <fixture port> <twin home>. Prints one JSON line:
//  { total, orDoor, hfDoor, orRows, hfRows, orFamily, hfFamily, orTotal, hfTotal }.
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
  const { getModelOptions } = await import('../../src/utils/model/modelOptions.ts')
  const options = getModelOptions()
  const orDoor = options.findIndex(o => o.value === or.OPENROUTER_EXPAND_OPTION_VALUE)
  const hfDoor = options.findIndex(o => o.value === hf.HUGGINGFACE_EXPAND_OPTION_VALUE)
  console.log(
    JSON.stringify({
      total: options.length,
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

// ── the fixture: one process, both catalogues ───────────────────────────────
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

/** The child's environment: a seeded scratch home, the file credential
 *  store, both fixture credentials on loopback bases, every other provider
 *  key gone, the first-party base dead, no local probes. */
function childEnv(home: string, tag: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_OPERATOR: 'sam',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    // One daemon dir per BOOT: a retried boot never meets the first boot's daemon.
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

// ── §0 the door's index, from the product's own composition (a subprocess) ──
console.log('[0] the composed catalogue over the fixture (the product\'s composition, a twin home, its own process)')
const indexHome = seededHome('home-index')
const composeRun = spawnSync(process.execPath, ['run', import.meta.path, '--compose', String(port), indexHome], {
  encoding: 'utf-8',
  env: childEnv(indexHome, 'compose'),
  cwd: ROOT,
  timeout: 120_000,
})
const composeLine = (composeRun.stdout ?? '').split('\n').filter(l => l.startsWith('{')).pop() ?? '{}'
const composed = JSON.parse(composeLine) as { total?: number; orDoor?: number; hfDoor?: number; orRows?: number; hfRows?: number; orError?: string | null; hfError?: string | null; orFamily?: string | null; hfFamily?: string | null; orTotal?: number | null; hfTotal?: number | null }
check('the composition subprocess answered (both fixture catalogues landed there, 30 rows each)', composeRun.status === 0 && composed.orRows === 30 && composed.hfRows === 30, `status ${composeRun.status}: ${composeLine} ${(composeRun.stderr ?? '').slice(-300)}`)
const options = { length: composed.total ?? 0 }
const orDoor = composed.orDoor ?? -1
const hfDoor = composed.hfDoor ?? -1
check('both doors sit in the composed catalogue, each past its family\'s 24 rows', orDoor >= 24 && hfDoor > orDoor + 24, composeLine)
check('each door carries its family word and the live count of 30', composed.orFamily === 'OpenRouter' && composed.orTotal === 30 && composed.hfFamily === 'Hugging Face' && composed.hfTotal === 30, composeLine)

// ── the PTY drive helper (per-mark grids) ───────────────────────────────────
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

const availableOf = (screen: string): number => {
  const m = /CHOOSE A MODEL · (\d+) AVAILABLE/.exec(screen)
  return m ? Number(m[1]) : -1
}
const lines = (screen: string, needle: string): string => screen.split('\n').filter(l => l.includes(needle)).join(' · ')

/** Every file under `dir` whose bytes carry `needle` (the persisted-id scan:
 *  the settings file for an in-process chat, the session record for a
 *  daemon-hosted one — whichever wrote it, the id must be on disk). */
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
          /* unreadable — not a record */
        }
      }
    }
  }
  walk(dir)
  return out
}

/** On a pre-picker stall: the tails of the home's log files (the product
 *  writes its debug log under the config home) — the mechanism, on record. */
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
        /* skip */
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

// ── the family drive ────────────────────────────────────────────────────────
// The walk rides the arrow keys in bursts (proved over 60+ rows) and never
// depends on where the cursor opened (the current row): down past the end
// (clamped at the last row), then up to the door by count. Home/End are not
// used — a lone ESC parse would close the picker mid-walk — and the Emacs
// aliases (ctrl+p/ctrl+n) do not reach the picker at all.
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const ESC = '\x1b'
const TO_END = DOWN.repeat(options.length + 4)
const walkTo = (door: number): string => TO_END + UP.repeat(options.length - 1 - door)

type FamilySpec = { family: 'openrouter' | 'huggingface'; word: string; door: number; needleId: string; needleLabel: string; firstRow: string }

/** One family's journey, as vshot sends. `settle` is the wait before the
 *  command is typed: a COLD boot (the first after a build, or after the
 *  composition subprocess) lands its session seat late, and a command
 *  submitted before the seat lands is lost — so the first boot waits, and
 *  a retried boot waits longer. */
function familySends(spec: FamilySpec, settle: { atTick: number; settleTicks: number }): unknown[] {
  return [
      // THE LANDING RULE: a bare boot lands on the Boot face — ↵ on New
      // Session enters the chat first.
      { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      // The composer paints its placeholder before it takes input: the
      // command is typed a settle after the paint and the ECHO ('❯ /model')
      // is required on screen before ↵ (a swallowed keystroke is a loud
      // undelivered send, never a silent empty drive).
      { atTick: settle.atTick, data: '/model', awaitText: 'Type a prompt', minTick: 5, awaitSettleTicks: settle.settleTicks },
      { requireAwait: true, awaitText: '❯ /model', awaitStableTicks: 2, data: '' },
      { afterPrevTicks: 2, data: '\r' },
      { requireAwait: true, awaitText: 'CHOOSE A MODEL', awaitStableTicks: 3, mark: 'open', data: '' },
      // The walk to the door: its index from the product's own composition.
      { afterPrevTicks: 3, data: walkTo(spec.door) },
      { afterPrevTicks: 4, mark: 'walked', data: '' },
      { requireAwait: true, awaitText: 'catalogue door', awaitStableTicks: 2, mark: 'door', data: '\r' },
      { requireAwait: true, awaitText: 'esc collapse', awaitStableTicks: 2, mark: 'expanded', data: 'needle' },
      { requireAwait: true, awaitText: 'filter: needle', awaitStableTicks: 2, mark: 'filtered', data: ESC },
      { afterPrevTicks: 5, mark: 'cleared', data: ESC },
      { requireAwait: true, awaitText: 'catalogue door', awaitStableTicks: 2, mark: 'collapsed', data: ESC },
      { requireAwait: true, awaitText: 'Kept model as', awaitStableTicks: 2, mark: 'closed', data: '' },
      { afterPrevTicks: 6, data: '/model' },
      { requireAwait: true, awaitText: '❯ /model', awaitStableTicks: 2, data: '' },
      { afterPrevTicks: 2, data: '\r' },
      { requireAwait: true, awaitText: 'CHOOSE A MODEL', awaitStableTicks: 3, data: '' },
      { afterPrevTicks: 3, data: walkTo(spec.door) },
      { requireAwait: true, awaitText: 'catalogue door', awaitStableTicks: 2, data: '\r' },
      { requireAwait: true, awaitText: 'esc collapse', awaitStableTicks: 2, data: 'needle' },
      { requireAwait: true, awaitText: 'filter: needle', awaitStableTicks: 2, mark: 'refiltered', data: '\r' },
      { requireAwait: true, awaitText: 'Set model to', awaitStableTicks: 3, mark: 'selected', data: '' },
      // Re-open: the current model lives behind the door, so the door opens
      // at mount and the CURRENT dot lands on the deep row.
      { afterPrevTicks: 6, data: '/model' },
      { requireAwait: true, awaitText: '❯ /model', awaitStableTicks: 2, data: '' },
      { afterPrevTicks: 2, data: '\r' },
      { requireAwait: true, awaitText: 'CHOOSE A MODEL', awaitStableTicks: 3, mark: 'reopened', data: '' },
      { afterPrevTicks: 4, data: '' },
  ]
}

function familyDrive(spec: FamilySpec): void {
  console.log(`[${spec.family}] the door: expand · filter · esc clears · esc collapses · esc closes · select a deep row`)
  // A boot whose picker never opens (the command echoed, ↵ went nowhere: a
  // session-layer stall BEFORE any door assertion) is driven once more on
  // a fresh home; a stall past the picker is never retried.
  let home = seededHome(`home-${spec.family}`)
  let res = drive(spec.family, home, familySends(spec, { atTick: 130, settleTicks: 15 }), 460)
  if (res.status !== 0 && /first stuck: '(CHOOSE A MODEL|❯ \/model|Type a prompt|↑↓ choose)'/.test(res.stderr)) {
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
  const filtered = res.marks.get('filtered') ?? ''
  const cleared = res.marks.get('cleared') ?? ''
  const collapsed = res.marks.get('collapsed') ?? ''
  const closed = res.marks.get('closed') ?? ''
  const selected = res.marks.get('selected') ?? ''
  const reopened = res.marks.get('reopened') ?? ''
  const before = availableOf(open)
  check(`${spec.family}: the picker opened with an AVAILABLE count`, before > 0, lines(open, 'CHOOSE'))
  // The door row, focused: its copy says what ↵ does; the footer says ↵ expand.
  check(`${spec.family}: the focused door row carries "${spec.word} — 30 models live" and the copy "↵ expand · 30 live · type to filter"`, door.includes(`${spec.word} — 30 models live`) && door.includes('↵ expand · 30 live · type to filter'), lines(door, spec.word))
  check(`${spec.family}: the footer advertises ↵ expand on the door`, door.includes('↵ expand') && door.includes('esc close'), lines(door, '↑↓ select'))
  // Expanded: the header line, the count grown by the six rows past the bound, the first live row focused.
  check(`${spec.family}: the expanded group paints the header "${spec.word} — 30 live · filter:" with "esc collapse"`, expanded.includes(`${spec.word} — 30 live · filter:`) && expanded.includes('esc collapse'), lines(expanded, spec.word))
  check(`${spec.family}: the AVAILABLE count grows by the 6 rows past the bound (${before} → ${before + 6})`, availableOf(expanded) === before + 6, lines(expanded, 'CHOOSE'))
  // (the id line truncates at the panel edge — the id and the promise's head are the pin)
  check(`${spec.family}: the first live row is focused inside the open group (its id on the id line)`, expanded.includes(`${spec.firstRow} · model IDs are`), lines(expanded, 'model IDs'))
  check(`${spec.family}: the footer names the filter while the group is open`, expanded.includes('type to filter') && expanded.includes('esc collapse'), lines(expanded, '↑↓ select'))
  // Filtered: the header carries the text, the deep row is the focus, the footer says esc clear.
  check(`${spec.family}: typing narrows the group — the header reads "filter: needle" and the deep row is focused`, filtered.includes('filter: needle') && filtered.includes(`${spec.needleId} · model IDs are real`), lines(filtered, 'needle'))
  check(`${spec.family}: the footer says esc clear while a filter stands`, filtered.includes('esc clear'), lines(filtered, '↑↓ select'))
  check(`${spec.family}: the rows past the bound are gone from the narrowed group (no "${spec.firstRow}" on screen)`, !filtered.includes(spec.firstRow), lines(filtered, 'expand-model'))
  // Cleared: esc emptied the filter; the group is whole again.
  check(`${spec.family}: esc clears the filter — the header is empty again and the group is whole (count ${before + 6})`, !cleared.includes('filter: needle') && cleared.includes('esc collapse') && availableOf(cleared) === before + 6, lines(cleared, spec.word))
  // Collapsed: back to top-24 + the door, the door focused, the count back.
  check(`${spec.family}: esc on an empty filter collapses — the door row is focused again and the count is back (${before})`, collapsed.includes('catalogue door') && collapsed.includes(`${spec.word} — 30 models live`) && availableOf(collapsed) === before, lines(collapsed, spec.word))
  check(`${spec.family}: the collapsed screen paints no header line`, !collapsed.includes('esc collapse'))
  // Closed: the outer esc is unchanged.
  check(`${spec.family}: esc with nothing open closes the picker (the receipt line)`, closed.includes('Kept model as'), lines(closed, 'Kept'))
  // Selected: the deep row applied through the same door as a listed row.
  check(`${spec.family}: ↵ on the filtered deep row selects it — the receipt names the row`, selected.includes(`Set model to ${spec.needleLabel}`), lines(selected, 'Set model'))
  check(`${spec.family}: re-opening the picker opens the door at mount (the current model lives behind it) with the deep row focused and marked current`, reopened.includes(`${spec.word} — 30 live · filter:`) && reopened.includes(`${spec.needleId} · model IDs are real`) && lines(reopened, spec.needleLabel).includes('current'), lines(reopened, spec.needleLabel) + ' || ' + lines(reopened, spec.word))
  const carriers = filesCarrying(home, spec.needleId).concat(filesCarrying(join(scratch, `daemon-${spec.family}`), spec.needleId), filesCarrying(join(scratch, `daemon-${spec.family}-2`), spec.needleId))
  check(`${spec.family}: the persisted model is the deep row's id (${spec.needleId}) — on disk in the scratch home`, carriers.length >= 1, `files: ${carriers.join(', ') || 'none'} · settings: ${existsSync(join(home, 'settings.json')) ? readFileSync(join(home, 'settings.json'), 'utf8').slice(0, 300) : 'absent'}`)
  if (failures !== failuresBefore) {
    // The evidence for a red: every mark's screen, whole (the scratch is
    // removed at exit, so the log carries them).
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
  needleId: 'openrouter/deepvendor/needle-model',
  needleLabel: 'Needle Model',
  firstRow: 'openrouter/fixture-vendor/expand-model-0',
})
familyDrive({
  family: 'huggingface',
  word: 'Hugging Face',
  door: hfDoor,
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
