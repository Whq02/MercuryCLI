#!/usr/bin/env bun
// ============================================================================
//  prove-model-picker-frontier-members — the frontier family's second member
//  rides the /model picker beside the family row, selectable, no description.
//
//  Claude Fable 5.1 joined the catalogue as a LITERAL row beside the family
//  ALIAS row (the alias keeps carrying the family default). The laws proved:
//    · THE ROWS: the shared catalogue lists the 'fable' alias row and the
//      claude-fable-5-1 literal row adjacent, labelled by the one display
//      owner ('Fable 5' / 'Fable 5.1'), both with an empty description (the
//      neutrality ruling).
//    · THE SCREEN: the built binary, driven in a PTY against a scratch home
//      seeded with a fixture max-subscription credential and no wire (the
//      Anthropic base at a closed port; no turn is ever sent):
//        picker   — one /model open, the cursor walked to the top (the
//                   picker opens on the current row and the window
//                   follows it), paints the two rows adjacent, both
//                   'switch', the member on its 1M ctx column;
//        set      — the inline door `/model fable51` (the exact-generation
//                   alias) answers 'Model set to Fable 5.1';
//        reopened — the next /model open marks the 5.1 row 'current', the
//                   family row still 'switch', and the selected card paints
//                   NO description line under the name.
//      Three moments of one run; a moment that never comes is an undelivered
//      send (exit 4), never a silently different frame.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-model-picker-frontier-members.ts
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { resolveProofHome } from '../lib/proofHome.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(import.meta.dir, 'vshot.py')

// The scratch home is pinned BEFORE any src import: the account resolver
// reads stored auth from the config home, and a proof never reads the
// operator's. The credential is the honesty prover's fixture subscription.
const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-frontier-members-'))
process.env.MERCURY_CONFIG_DIR = SCRATCH
for (const k of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
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
console.log(' /model — the frontier family\'s second member beside the family row')
console.log('============================================================')

// The catalogue reads the global config: the boot seam is enabled first (the
// honesty prover's idiom) — a read before it throws 'Config accessed before
// allowed', which is the seam speaking, not the catalogue.
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

section('the rows: the alias row and the 5.1 literal row are adjacent, named, undescribed')
{
  const { getModelOptions } = await import('../../src/utils/model/modelOptions.ts')
  const rows = getModelOptions({ anthropicCredentialed: () => true })
  const family = rows.findIndex(o => o.value === 'fable')
  const member = rows.findIndex(o => o.value === 'claude-fable-5-1')
  check('the family alias row is present', family >= 0)
  check('the 5.1 literal row is present', member >= 0)
  check('the 5.1 row sits immediately after the family row', member === family + 1, `${family} / ${member}`)
  check("the one display owner labels them 'Fable 5' and 'Fable 5.1'", rows[family]?.label === 'Fable 5' && rows[member]?.label === 'Fable 5.1', `${rows[family]?.label} / ${rows[member]?.label}`)
  check('both rows carry an empty description (the neutrality ruling)', rows[family]?.description === '' && rows[member]?.description === '')
  check('neither row is refused for a credentialed account', rows[family]?.unavailable === undefined && rows[member]?.unavailable === undefined)
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
  writeFileSync(
    cfgPath,
    JSON.stringify({
      argv: ['node', BIN],
      sends: [
        // THE LANDING RULE: ↵ on the face's New Session first.
        { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
        // STRICT entry gate: the chat's own composer gates every command;
        // a world that never enters exits 4 honestly.
        { atTick: 60, data: '/model', awaitText: 'Type a prompt', minTick: 5, requireAwait: true, awaitSettleTicks: 2 },
        { afterPrevTicks: 4, data: '\r' },
        // THE WALK TO THE TOP: the picker opens on the CURRENT model's row and
        // the window follows the cursor. In this home the current model is the
        // built-in default (the fixture subscription is Max without the
        // confirmed 20x tier, so the frontier decision falls back to Opus 5),
        // whose explicit row is the LAST of the Anthropic group — the two
        // frontier rows sit above the fold ('↑ N more'). The cursor clamps at
        // the top (selectRow(Math.max(0, i - 1))), so sixteen ↑ park it on the
        // first row from any Anthropic row and the group paints from its head.
        { afterPrevTicks: 6, data: '\u001b[A'.repeat(16) },
        // The picker moment is gated on the 5.1 ROW's own text, not the header:
        // the header paints a tick before the catalogue rows land (the first
        // run captured a rowless picker). The deadline is hard: a row that
        // never paints is an undelivered send (exit 4), never a pass on absence.
        { requireAwait: true, awaitText: 'Fable 5.1', awaitStableTicks: 3, mark: 'picker', data: '' },
        { afterPrevTicks: 2, data: '\x1b' },
        // The inline door: the exact-generation alias sets the member.
        { afterPrevTicks: 4, data: '/model fable51', awaitText: 'Type a prompt', requireAwait: true, awaitSettleTicks: 2 },
        { afterPrevTicks: 3, data: '\r' },
        { requireAwait: true, awaitText: 'Model set to Fable 5.1', awaitStableTicks: 2, mark: 'set', data: '' },
        // The reopened picker marks the member current.
        { afterPrevTicks: 3, data: '/model', awaitText: 'Type a prompt', requireAwait: true, awaitSettleTicks: 2 },
        { afterPrevTicks: 3, data: '\r' },
        { requireAwait: true, awaitText: 'CHOOSE A MODEL', awaitStableTicks: 3, mark: 'reopened', data: '' },
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
      // The display animations every capture pins still (the critter's sway
      // and blink, its gaze and sleep, the header's live seconds, the live
      // glyphs): a settle gate reads the whole grid, and a recorded frame
      // must never land on an arbitrary animation phase.
      MERCURY_CRITTER_IDLE: '0',    MERCURY_CRITTER_GAZE: '0',
      MERCURY_CRITTER_SLEEP: '0',   MERCURY_LIVE_CLOCK: '0',
      MERCURY_LIVE_GLYPHS: '0',
      // No turn is ever sent; the Anthropic base points at a closed port so
      // nothing can leave the box.
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    },
    timeout: vshotBudgetMs(120_000),
  })
  check('the drive delivered every send (exit 0)', res.status === 0, `exit ${res.status}: ${(res.stderr ?? '').trim().slice(-300)}`)
  if (res.status !== 0) {
    // The stuck screen, in the log: vshot prints the FINAL screen on its
    // stdout whatever the exit (the grid is written before the verdict),
    // then every mark the drive did observe, then the verdict lines.
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
    check('the picker moment was observed', picker !== undefined)
    check('the set moment was observed', set !== undefined)
    check('the reopened moment was observed', reopened !== undefined)
    const familyRow = (ls: string[]): number => ls.findIndex(l => /\bFable 5 {2,}/.test(l))
    const memberRow = (ls: string[]): number => ls.findIndex(l => /\bFable 5\.1 /.test(l))
    if (picker) {
      const ls = lines(picker.grid)
      const f = familyRow(ls)
      const m = memberRow(ls)
      check('picker: the family row and the 5.1 row are both painted', f >= 0 && m >= 0, `${f} / ${m}`)
      check('picker: the 5.1 row sits directly under the family row', m === f + 1, `${f} / ${m}`)
      check("picker: both rows read 'switch' (neither is current yet)", /\bswitch\b/.test(ls[f] ?? '') && /\bswitch\b/.test(ls[m] ?? ''), `${(ls[f] ?? '').trim()} | ${(ls[m] ?? '').trim()}`)
      check('picker: the 5.1 row carries its 1M ctx column', /1M ctx/.test(ls[m] ?? ''), (ls[m] ?? '').trim())
    }
    if (set) {
      const text = lines(set.grid).join('\n')
      check("set: the inline door answered 'Model set to Fable 5.1'", text.includes('Model set to Fable 5.1'))
    }
    if (reopened) {
      const ls = lines(reopened.grid)
      const f = familyRow(ls)
      const m = memberRow(ls)
      check("reopened: the 5.1 row reads 'current'", m >= 0 && /\bcurrent\b/.test(ls[m] ?? ''), (ls[m] ?? '').trim())
      check("reopened: the family row still reads 'switch' (the family default never moved)", f >= 0 && /\bswitch\b/.test(ls[f] ?? ''), (ls[f] ?? '').trim())
      // The selected card paints its description under the name line; a
      // border or blank there is the empty description made visible.
      const under = (ls[m + 1] ?? '').replace(/[╭╮╰╯─│┃┏┓┗┛━\s]/g, '')
      check('reopened: no description line under the selected 5.1 row', m >= 0 && under === '', `"${(ls[m + 1] ?? '').trim()}"`)
      check('reopened: both moments belong to one product run (the picker header is back)', ls.join('\n').includes('CHOOSE A MODEL') && reopened.atTick > (picker?.atTick ?? 0))
    }
  } else {
    check('the capture wrote its grid', false)
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ the frontier family\'s second member rides the picker beside the family row' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
