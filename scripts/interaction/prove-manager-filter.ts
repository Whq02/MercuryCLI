#!/usr/bin/env bun
// ============================================================================
//  scripts/interaction/prove-manager-filter.ts — manager-search lane
// the /manager search row's grammar and its esc law.
//
//  The surface (src/components/mercury-ui/ManagerView.tsx) replaced its
//  duplicated title line with a quiet filter row. The laws under proof:
//
//  PURE legs (src/components/mercury-ui/managerFilter.ts — table-proved):
//   P1  filter-by-name, filter-by-description-keyword, leading-slash match
//   P2  token-AND across name+description ('agent launch' needs both words)
//   P3  case-insensitive substring floor
//   P4  empty/whitespace queries produce NO tokens (the no-filter identity
//       branch — the resting view keeps the original rows array)
//   P5  meta-count truth: the resting line is byte-identical to the
//       pre-search meta; the filtering line is 'N of M match · ↵ opens for
//       real' and always holds one row at 80 columns
//
//  FIXTURE legs (the self-spawn idiom: the child mounts the REAL ManagerView
//  over the REAL command registry under ink; vshot drives the PTY):
//   F1  a no-match query paints the honest zero state ('No surfaces match',
//       '0 of N match') with the query echoed on the search row
//   F2  esc-clears-then-closes: the first esc on a non-empty query clears it
//       and the CLEARED frame is byte-identical to the RESTING frame (the
//       empty-search capture-stability contract, proved on rendered text);
//       the next esc closes the surface (the fixture paints MANAGER-CLOSED)
//   F3  while filtering, the focused ▸ row is the FIRST painted command row
//       (the first-match focus law) and ↵ opens exactly that row for real
//       (the fixture paints PICKED:/<name>)
// ============================================================================
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const SELF = fileURLToPath(import.meta.url)
const VSHOT = join(dirname(SELF), '../ui/vshot.py')
const ESC = String.fromCharCode(27)

if (process.env.MGRSEARCH_CHILD) {
  // ── child: the real ManagerView over the real registry ────────────────────
  process.env.NODE_ENV = 'test'
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '1.0.0',
    ISSUES_EXPLAINER: '',
    PACKAGE_URL: '',
    README_URL: '',
    IS_DEV: false,
    IS_DEMO: false,
  }
  const React = await import('react')
  const h = React.createElement
  const ink = (await import('../../src/ink.js')) as unknown as {
    render: (n: React.ReactNode) => Promise<unknown>
    Box: React.ComponentType<Record<string, unknown>>
    Text: React.ComponentType<Record<string, unknown>>
    useInput: (handler: () => void) => void
  }
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  const { ManagerView } = await import('../../src/components/mercury-ui/ManagerView.js')

  function Fixture(): React.ReactNode {
    const [outcome, setOutcome] = React.useState<string | null>(null)
    // A standing consumer keeps ink reading stdin in raw mode.
    ink.useInput(() => {})
    if (outcome) return h(ink.Text, {}, outcome)
    return h(ManagerView as React.ComponentType<Record<string, unknown>>, {
      onClose: () => setOutcome('MANAGER-CLOSED'),
      onPick: (name: string) => setOutcome(`PICKED:/${name}`),
    })
  }

  void ink.render(
    h(AppStateProvider as never, {}, h(ink.Box, { flexDirection: 'column' }, h(Fixture))),
  )
  setTimeout(() => process.exit(0), 30_000)
} else {
  // ── parent ────────────────────────────────────────────────────────────────
  const { managerMetaLine, matchesSurfaceQuery, surfaceQueryTokens } = await import(
    '../../src/components/mercury-ui/managerFilter.js'
  )
  const { CONFIG_HOME } = await import('../ui/renderScenarios.ts')

  let failures = 0
  const check = (name: string, ok: boolean, detail = ''): void => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
    if (!ok) failures++
  }
  const section = (name: string): void => {
    console.log(`\n== ${name} ==`)
  }

  // ── PURE legs ─────────────────────────────────────────────────────────────
  section('P1 — name, description, and slash matching')
  const agents = { name: 'agents', description: 'Agent studio — create, launch and manage agents' }
  const theme = { name: 'theme', description: 'Pick the terminal appearance family' }
  check('name substring matches', matchesSurfaceQuery(agents, surfaceQueryTokens('agent')))
  check('description keyword matches', matchesSurfaceQuery(agents, surfaceQueryTokens('studio')))
  check('leading-slash query matches as painted', matchesSurfaceQuery(agents, surfaceQueryTokens('/age')))
  check('a non-matching row is excluded', !matchesSurfaceQuery(theme, surfaceQueryTokens('agent')))

  section('P2 — token-AND across name+description')
  check("'agent launch' needs BOTH words (match)", matchesSurfaceQuery(agents, surfaceQueryTokens('agent launch')))
  check("'agent launch' excludes rows carrying only one", !matchesSurfaceQuery(theme, surfaceQueryTokens('theme launch')))
  check('token order is free', matchesSurfaceQuery(agents, surfaceQueryTokens('launch agent')))

  section('P3 — case-insensitive floor')
  check('upper-case query matches', matchesSurfaceQuery(agents, surfaceQueryTokens('AGENT Studio')))

  section('P4 — empty/whitespace queries filter nothing')
  check('empty query → no tokens', surfaceQueryTokens('').length === 0)
  check('whitespace query → no tokens', surfaceQueryTokens('   ').length === 0)
  check('no tokens matches every row', matchesSurfaceQuery(theme, []))

  section('P5 — meta-count truth')
  check(
    'resting meta is byte-identical to the pre-search line',
    managerMetaLine(116, 116, false) ===
      '116 surfaces · projected live from the command registry · ↵ opens for real',
    managerMetaLine(116, 116, false),
  )
  check(
    "filtering meta speaks 'N of M match'",
    managerMetaLine(12, 116, true) === '12 of 116 match · ↵ opens for real',
    managerMetaLine(12, 116, true),
  )
  check("zero matches stay truthful ('0 of M match')", managerMetaLine(0, 116, true).startsWith('0 of 116 match'))
  check(
    'the filtering meta holds one row at 80 columns (intro budget)',
    managerMetaLine(999, 999, true).length <= 76,
    String(managerMetaLine(999, 999, true).length),
  )

  // ── FIXTURE legs ──────────────────────────────────────────────────────────
  if (!existsSync(VSHOT)) {
    console.error('vshot.py missing — render-verify required')
    process.exit(1)
  }

  type Send = Record<string, unknown>
  type Mark = { label: string; atTick: number; grid: Array<Array<{ c: string }>> }
  type Payload = { grid: Array<Array<{ c: string }>>; endReason: string; marks?: Mark[] }
  const rowsOf = (grid: Array<Array<{ c: string }>>): string[] =>
    grid.map(r => r.map(c => c.c).join(''))
  const textOf = (grid: Array<Array<{ c: string }>>): string => rowsOf(grid).join('\n')
  const mark = (p: Payload, label: string): Mark | undefined =>
    p.marks?.find(m => m.label === label)

  function driveFixture(tag: string, sends: Send[], total: number, readyText: string): Payload | null {
    const gridPath = `/tmp/mgrsearch-${tag}-${process.pid}.json`
    const cfgPath = `/tmp/mgrsearch-${tag}-cfg-${process.pid}.json`
    writeFileSync(
      cfgPath,
      JSON.stringify({
        argv: [process.execPath, 'run', SELF],
        sends,
        total,
        readyText,
        stableTicks: 2,
        cols: 120,
        rows: 44,
        out: gridPath,
      }),
    )
    const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
      encoding: 'utf8',
      timeout: vshotBudgetMs(120_000),
      env: {
        ...process.env,
        MGRSEARCH_CHILD: '1',
        MERCURY_LIVE_GLYPHS: '0',
        MERCURY_CRITTER_GAZE: '0',
        MERCURY_CONFIG_DIR: CONFIG_HOME,
        // Registry SHAPE probe only (the prove-effective-catalogue idiom):
        // nothing here renders account-gated chrome.
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'sk-ant-mgrsearch-shape-probe',
      },
    })
    if (res.status !== 0) {
      check(`${tag}: fixture journey completed`, false, (res.stderr ?? '').slice(-300))
      return null
    }
    check(`${tag}: fixture journey completed`, true)
    return JSON.parse(readFileSync(gridPath, 'utf8')) as Payload
  }

  /** Command rows paint as '▸ /name' (focused) or ' /name'. */
  const commandRowRe = /(▸ | {2})\/([a-z0-9-]+)/
  const firstCommandRow = (rows: string[]): { focused: boolean; name: string } | null => {
    for (const r of rows) {
      if (/[↑↓] \d+ more/.test(r)) continue
      const m = commandRowRe.exec(r)
      if (m) return { focused: m[1] === '▸ ', name: m[2]! }
    }
    return null
  }

  section('F1/F2 — no-match honesty · esc clears (byte-identical) then closes')
  {
    const p = driveFixture('escgrammar', [
      { atTick: 90, minTick: 5, awaitText: 'type to filter', awaitSettleTicks: 3, data: 'zzzz', mark: 'resting' },
      { atTick: 150, minTick: 10, awaitText: 'No surfaces match', awaitSettleTicks: 2, data: ESC, mark: 'nomatch' },
      { atTick: 210, minTick: 15, awaitText: 'type to filter', awaitSettleTicks: 2, data: ESC, mark: 'cleared' },
    ], 260, 'MANAGER-CLOSED')
    if (p) {
      const resting = mark(p, 'resting')
      const nomatch = mark(p, 'nomatch')
      const cleared = mark(p, 'cleared')
      check('resting frame captured', resting !== undefined)
      check('no-match frame captured', nomatch !== undefined)
      check('cleared frame captured', cleared !== undefined)
      if (resting && nomatch && cleared) {
        const restingText = textOf(resting.grid)
        check(
          'resting: the search placeholder + live meta painted',
          restingText.includes('type to filter') && /\d+ surfaces · projected live/.test(restingText),
        )
        check('resting: a focused ▸ command row painted', firstCommandRow(rowsOf(resting.grid))?.focused === true)
        const nomatchText = textOf(nomatch.grid)
        check("no-match: the honest zero state ('No surfaces match')", nomatchText.includes('No surfaces match'))
        check("no-match: the meta stays truthful ('0 of N match')", /\b0 of \d+ match\b/.test(nomatchText))
        check('no-match: the query echoes on the search row', nomatchText.includes('zzzz'))
        check('no-match: no command row survives', firstCommandRow(rowsOf(nomatch.grid)) === null)
        check(
          'cleared: byte-identical to the resting frame (empty-search contract)',
          textOf(cleared.grid) === restingText,
        )
      }
      check(
        'the second esc closes the surface (clears-then-closes law)',
        textOf(p.grid).includes('MANAGER-CLOSED'),
      )
    }
  }

  section('F3 — first-match focus while filtering · ↵ opens the focused row for real')
  {
    const p = driveFixture('filterpick', [
      { atTick: 90, minTick: 5, awaitText: 'type to filter', awaitSettleTicks: 3, data: 'session' },
      { atTick: 150, minTick: 10, awaitText: 'match · ↵', awaitSettleTicks: 2, data: '\r', mark: 'filtered' },
    ], 220, 'PICKED:/')
    if (p) {
      const filtered = mark(p, 'filtered')
      check('filtered frame captured', filtered !== undefined)
      if (filtered) {
        const rows = rowsOf(filtered.grid)
        const text = textOf(filtered.grid)
        check("filtering meta speaks 'N of M match'", /\b[1-9]\d* of \d+ match\b/.test(text))
        const first = firstCommandRow(rows)
        check('the FIRST painted command row carries the ▸ focus', first?.focused === true, JSON.stringify(first))
        if (first) {
          check(
            '↵ opened exactly the focused row (real navigation)',
            textOf(p.grid).includes(`PICKED:/${first.name}`),
            textOf(p.grid).split('\n').find(l => l.includes('PICKED:')) ?? 'no PICKED line',
          )
        }
      }
    }
  }

  console.log('')
  if (failures > 0) {
    console.error(`prove-manager-filter: RED (${failures})`)
    process.exit(1)
  }
  console.log('prove-manager-filter: green')
  process.exit(0)
}
