#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { resolveProofHome } from '../lib/proofHome.ts'
import { BOOT_FACE_READY } from '../lib/bootFace.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(import.meta.dir, 'vshot.py')

const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-frontier-members-'))
process.env.MERCURY_CONFIG_DIR = SCRATCH
for (const k of [
  'ANTHROPIC_API_KEY',
  'MERCURY_MODEL',
  'MERCURY_DEFAULT_FABLE_MODEL',
  'MERCURY_DEFAULT_OPUS_MODEL',
  'MERCURY_DEFAULT_SONNET_MODEL',
  'MERCURY_DISABLE_1M_CONTEXT',
]) {
  delete process.env[k]
}
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const FIXTURE_CREDS = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'fixture-access-token-000000000001',
    refreshToken: 'fixture-refresh-token-00000000001',
    expiresAt: 4102444800000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    rateLimitTier: null,
  },
})

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' /model — the frontier family\'s generations: the family row and its previous generation beside it')
console.log('============================================================')

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()

section('the rows: the alias row and the previous generation\'s literal row are adjacent, named, undescribed')
{
  const { getModelOptions } = await import('../../src/models/catalogue/modelOptions.ts')
  const { FAMILY_GENERATIONS, previousGenerationKeys } = await import('../../src/models/facts/builtInModelTable.ts')
  const { getPinnedModelIds } = await import('../../src/models/facts/pinnedModelIds.ts')
  const { renderModelName } = await import('../../src/models/catalogue/engineModel.ts')
  const strings = getPinnedModelIds()
  const newestId = strings[FAMILY_GENERATIONS.fable[0]]
  const previousId = strings[previousGenerationKeys('fable')[0]!]
  const rows = getModelOptions({ anthropicCredentialed: () => true })
  const family = rows.findIndex(o => o.value === newestId)
  const member = rows.findIndex(o => o.value === previousId)
  check('the family full-id row is present', family >= 0, 'getModelOptions in src/models/catalogue/modelOptions.ts must list a row whose value is the newest fable id from FAMILY_GENERATIONS in src/models/facts/builtInModelTable.ts')
  check("the previous generation's literal row is present", member >= 0, 'getModelOptions in src/models/catalogue/modelOptions.ts must list a row for the previous fable generation (previousGenerationKeys in src/models/facts/builtInModelTable.ts)')
  check('the previous row sits immediately after the family row', member === family + 1, `put the previous generation row directly after the family row in getModelOptions (src/models/catalogue/modelOptions.ts); family index / previous index: ${family} / ${member}`)
  check("the one display owner labels them through the table ('Fable 5.2' / 'Fable 5.1')", rows[family]?.label === renderModelName(newestId) && rows[family]?.label === 'Fable 5.2' && rows[member]?.label === renderModelName(previousId) && rows[member]?.label === 'Fable 5.1', `row labels must come from renderModelName (src/models/catalogue/engineModel.ts) and its generation table; got ${rows[family]?.label} / ${rows[member]?.label}`)
  check('both rows carry an empty description (the neutrality ruling)', rows[family]?.description === '' && rows[member]?.description === '', `both rows must have description '' in getModelOptions (src/models/catalogue/modelOptions.ts); got '${rows[family]?.description}' / '${rows[member]?.description}'`)
  check('neither row is refused for a credentialed account', rows[family]?.unavailable === undefined && rows[member]?.unavailable === undefined, `getModelOptions (src/models/catalogue/modelOptions.ts) must not mark these rows unavailable when anthropicCredentialed is true; got ${JSON.stringify(rows[family]?.unavailable)} / ${JSON.stringify(rows[member]?.unavailable)}`)
}

section('THE SCREEN: picker → inline set → reopened, three moments of one run (120x40)')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`  no POSIX pty capture driver on this host (${driver.kind}) — the screen leg cannot run here`)
  failures++
} else if (!existsSync(BIN)) {
  console.error(`  dist/mercury.mjs missing — bun run build.ts first`)
  failures++
} else {
  const home = resolveProofHome([REPO])
  writeFileSync(join(home, '.credentials.json'), FIXTURE_CREDS)
  const grid = join(SCRATCH, 'frontier-members-120x40.json')
  const cfgPath = join(SCRATCH, 'vshot.json')
  const { getModelOptions } = await import('../../src/models/catalogue/modelOptions.ts')
  if (!getModelOptions({ anthropicCredentialed: () => true }).some(row => row.group === undefined)) throw new Error('The Anthropic section is absent from the catalogue')
  writeFileSync(
    cfgPath,
    JSON.stringify({
      argv: ['node', BIN],
      sends: [
        { atTick: 40, awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, minTick: 3, awaitSettleTicks: 2, data: '\r' },
        { atTick: 60, data: '/model', awaitText: 'Type a prompt', minTick: 5, requireAwait: true, awaitSettleTicks: 2 },
        { afterPrevTicks: 4, data: '\r' },
        { requireAwait: true, awaitText: 'Mercury · model', awaitSettleTicks: 3, data: '\u001b[H' },
        { requireAwait: true, awaitText: 'Fable 5.2', awaitStableTicks: 3, mark: 'picker', data: '' },
        { afterPrevTicks: 2, data: '\x1b' },
        { afterPrevTicks: 4, data: '/model fable52', awaitText: 'Type a prompt', requireAwait: true, awaitSettleTicks: 2 },
        { afterPrevTicks: 3, data: '\r' },
        { requireAwait: true, awaitText: 'Model set to Fable 5.2', awaitStableTicks: 2, mark: 'set', data: '' },
        { afterPrevTicks: 3, data: '/model', awaitText: 'Type a prompt', requireAwait: true, awaitSettleTicks: 2 },
        { afterPrevTicks: 3, data: '\r' },
        { requireAwait: true, awaitText: 'Mercury · model', awaitStableTicks: 3, mark: 'reopened', data: '' },
        { afterPrevTicks: 3, data: '\x1b' },
      ],
      total: 170,
      cols: 120,
      rows: 40,
      out: grid,
      title: 'frontier members @120x40',
    }),
  )
  const res = spawnSync(driver.python, [VSHOT, cfgPath], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: home,
      MERCURY_CRITTER_IDLE: '0',    MERCURY_CRITTER_GAZE: '0',
      MERCURY_CRITTER_SLEEP: '0',   MERCURY_LIVE_CLOCK: '0',
      MERCURY_LIVE_GLYPHS: '0',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      MERCURY_ANTHROPIC_OAUTH_BASE: 'http://127.0.0.1:9',
    },
    timeout: vshotBudgetMs(120_000),
  })
  check('the drive delivered every send (exit 0)', res.status === 0, `exit ${res.status}: ${(res.stderr ?? '').trim().slice(-300)}`)
  if (res.status !== 0) {
    console.log('  ── the final screen (vshot stdout) ──')
    for (const row of (res.stdout ?? '').split('\n')) console.log('  │' + row.replace(/\s+$/, ''))
    if (existsSync(grid)) {
      const dump = JSON.parse(readFileSync(grid, 'utf8')) as {
        endReason?: string
        endedAtTick?: number
        marks?: Array<{ label: string; atTick: number; grid: Array<Array<{ c: string }>> }>
      }
      console.log(`  ── capture ended: ${dump.endReason ?? '?'} @tick ${dump.endedAtTick ?? '?'} ──`)
      for (const m of dump.marks ?? []) {
        console.log(`  ── frame '${m.label}' @tick ${m.atTick} ──`)
        for (const row of m.grid) console.log('  │' + row.map(c => c.c).join('').replace(/\s+$/, ''))
      }
    }
    console.log('  ── vshot stderr (tail) ──')
    console.log((res.stderr ?? '').trim().split('\n').slice(-12).join('\n'))
  }
  if (existsSync(grid)) {
    const payload = JSON.parse(readFileSync(grid, 'utf8')) as {
      marks?: Array<{ label: string; atTick: number; grid: Array<Array<{ c: string }>> }>
    }
    const lines = (g: Array<Array<{ c: string }>>): string[] => g.map(row => row.map(c => c.c).join(''))
    const at = (label: string) => payload.marks?.find(m => m.label === label)
    const picker = at('picker')
    const set = at('set')
    const reopened = at('reopened')
    check('the picker moment was observed', picker !== undefined, 'the drive never saw Fable 5.2 on the /model picker screen; read the frames printed above or run scripts/ui/vshot.py by hand')
    check('the set moment was observed', set !== undefined, 'the drive never saw Model set to Fable 5.2 after /model fable52; read the frames printed above and src/commands/model/model.tsx')
    check('the reopened moment was observed', reopened !== undefined, 'the drive never saw the picker reopen after the inline set; read the frames printed above or run scripts/ui/vshot.py by hand')
    const newestRow = (ls: string[]): number => ls.findIndex(l => /\bFable 5\.2 {2,}/.test(l) && !l.includes('frontier:'))
    const previousRow = (ls: string[]): number => ls.findIndex(l => /\bFable 5\.1 {2,}/.test(l) && !l.includes('frontier:'))
    if (picker) {
      const ls = lines(picker.grid)
      const n = newestRow(ls)
      const p = previousRow(ls)
      check('picker: the family row and the previous row are both painted', n >= 0 && p >= 0, `the picker must paint both Fable rows with a name column; check getModelOptions (src/models/catalogue/modelOptions.ts) and the picker under src/commands/model/picker; family row / previous row line index: ${n} / ${p}`)
      check('picker: the previous row sits directly under the family row', p === n + 1, `the picker must draw the previous row on the line right under the family row; row order comes from getModelOptions (src/models/catalogue/modelOptions.ts); family row / previous row line index: ${n} / ${p}`)
      check("picker: neither row reads 'current' yet (the state column is calm)", !/\bcurrent\b/.test(ls[n] ?? '') && !/\bcurrent\b/.test(ls[p] ?? '') && /\bFable 5\.2 {2,}claude-fable-5-2 {2,}/.test(ls[n] ?? ''), `before any /model set neither row may show current, and the family row must read name then id; got ${(ls[n] ?? '').trim()} | ${(ls[p] ?? '').trim()}`)
      check('picker: the newest row carries its 1M ctx column', /1M ctx/.test(ls[n] ?? ''), `the newest Fable row must show its 1M ctx column in the picker; got ${(ls[n] ?? '').trim()}`)
    }
    if (set) {
      const text = lines(set.grid).join('\n')
      check("set: the inline door answered 'Model set to Fable 5.2'", text.includes('Model set to Fable 5.2'), 'the /model fable52 inline set must answer Model set to Fable 5.2; check the inline-set reply in src/commands/model/model.tsx')
    }
    if (reopened) {
      const ls = lines(reopened.grid)
      const n = newestRow(ls)
      const p = previousRow(ls)
      check("reopened: the newest row reads 'current' (the exact-generation alias set the row the family word resolves to)", n >= 0 && /\bcurrent\b/.test(ls[n] ?? ''), `after /model fable52 the reopened picker must mark the newest Fable row current; check src/commands/model/model.tsx and the picker under src/commands/model/picker; got ${(ls[n] ?? '').trim()}`)
      check("reopened: the previous row still carries no state word", p >= 0 && !/\bcurrent\b/.test(ls[p] ?? ''), `only the newest Fable row may read current after the set; got ${(ls[p] ?? '').trim()}`)
      const paneStart = Math.max(0, (ls.find(l => l.includes('╭')) ?? '').indexOf('╭'))
      const under = (ls[n + 1] ?? '').slice(paneStart).replace(/[╭╮╰╯─│┃┏┓┗┛━\s]/g, '')
      check('reopened: no description line under the selected newest row (a blank, then the previous row)', n >= 0 && under === '' && (p === n + 1 || p === n + 2), `remove the description line under the selected newest row in the picker (src/commands/model/picker) and keep getModelOptions descriptions empty; line under it, family / previous index: "${(ls[n + 1] ?? '').trim()}" ${n} / ${p}`)
      check('reopened: both moments belong to one product run (the picker header is back)', ls.join('\n').includes('Mercury · model') && reopened.atTick > (picker?.atTick ?? 0), 'the reopened frame must carry the Mercury · model header (MODEL_PICKER_TITLE in src/models/facts/modelPickerGroups.ts) and come after the picker frame')
    }
  } else {
    check('the capture wrote its grid', false, 'vshot.py wrote no grid file; run scripts/ui/vshot.py by hand with the config and read its stderr')
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ the frontier family\'s generations ride the picker: the family row and its previous generation beside it' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
