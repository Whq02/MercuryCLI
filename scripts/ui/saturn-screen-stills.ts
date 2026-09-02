#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/saturn-screen-stills.ts — the SATURN scheduler screen's STILL
// FRAMES (the lane), written as bytes: the board at the
//  64×12 product floor, the classic tier (80×24) and the wide tier
//  (120×40), plus the held-row detail and the empty board — composed by the
//  SAME pure owners the screen composes with (BootSaturnScreen's exported
//  entry/detail/summary/legend/status composers over composeBootMenu),
//  nocolor so the stills read as text. `--write` regenerates
//  scripts/ui/fixtures/saturn-screen/*.txt; prove-saturn-screen.ts
//  byte-compares the live composition against them (the regen-wrapper
//  pattern: a drifted still reds the gate until re-written on purpose).
//
//  TZ-FREE BY CONSTRUCTION: every fixture row is an 'at' one-shot (fixed
//  epoch deltas) or a PAUSED recurring row (next fire null), and the rows
//  reach the composers through THE REAL PROJECTION (saturnFactsOf at the
//  frozen clock) — recurring cron arithmetic is local-clock and lives in
//  the prover's pure pins instead, so a regen composes the same bytes in
//  every timezone. The real-boot look is the operator's drive (never a
//  PTY here).
// ============================================================================
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSplashCore } from '../../assets/splash/splash-core.mjs'
import {
  freshSaturnForm,
  saturnDetailLines,
  saturnEmptyDetailLines,
  saturnEntryOf,
  saturnFormDetailLines,
  saturnFormEntries,
  saturnFormLegendOf,
  saturnLegendOf,
  saturnStatusLine,
  saturnSummaryRows,
  sortForBoard,
  type SaturnFormPreflightV1,
  type SaturnFormStateV1,
  type SaturnScreenFactsV1,
  type SaturnScreenRowV1,
} from '../../src/components/BootSaturnScreen.js'
import { compileWhenSpelling } from '../../src/services/saturn/whenSpelling.js'
import { saturnFactsOf, type HeldFireV1, type SaturnScheduleV1 } from '../../src/daemon/saturn.js'
import type { SessionReceiptEntry } from '../../src/services/switchboard/sessionReceipts.js'

export const STILLS_DIR = join(import.meta.dir, 'fixtures', 'saturn-screen')

const core = createSplashCore({ nocolor: true, truecolor: false, accent: 'crimson' })

/** The kit stills' environment spellings — one fixed panel for every frame. */
export const STILL_ENVIRONMENT = {
  model: 'Opus 5',
  critter: 'Octopus',
  critterHue: '#B07BE0',
  dirBase: 'orchard-src',
  dirTail: '',
}

/** The frozen clock every age and delta composes against. */
export const FIXED_NOW = Date.parse('2026-08-29T12:00:00Z')
const MIN = 60_000
const HOUR = 60 * MIN

function sched(
  over: Partial<SaturnScheduleV1> & Pick<SaturnScheduleV1, 'id' | 'when' | 'action'>,
): SaturnScheduleV1 {
  return {
    schema: 1,
    account: { family: 'anthropic', source: 'oauth', identity: 'op@example.com' },
    modelKey: 'claude-opus-5',
    createdAt: FIXED_NOW - 24 * HOUR,
    createdBy: 'operator:test',
    preflightAtWrite: { state: 'ready' },
    ...over,
  }
}

// ── the fixture estate: two session records + the box tier, every row shape
//    the screen knows, THROUGH the real projection ──────────────────────────

const JOURNEY_SCHEDULES: SaturnScheduleV1[] = [
  sched({
    id: 'aaaa1111',
    when: { kind: 'at', atMs: FIXED_NOW + 2 * HOUR, spelling: 'in 2h' },
    action: { kind: 'fire', prompt: 'run the nightly summary' },
    lastFiredAt: FIXED_NOW - 22 * HOUR,
    note: 'the standing summary',
  }),
  sched({
    id: 'bbbb2222',
    when: { kind: 'at', atMs: FIXED_NOW + 26 * HOUR, spelling: 'tomorrow 07:30' },
    action: {
      kind: 'birth',
      birth: {
        workspaceDir: '/Users/op/Developer/orchard-src',
        modelKey: 'claude-opus-5',
        presence: 'screen-present',
        kitPreset: 'review-kit',
        opening: 'sweep the overnight issues and brief me',
        contract: null,
        title: 'morning sweep',
      },
    },
  }),
]

const OPS_SCHEDULES: SaturnScheduleV1[] = [
  sched({
    id: 'cccc3333',
    when: { kind: 'every', cron: '0 9 * * *', spelling: 'every day 09:00' },
    action: { kind: 'fire', prompt: 'stand-up notes' },
    paused: true,
  }),
  sched({
    id: 'dddd4444',
    when: { kind: 'at', atMs: FIXED_NOW - 5 * MIN, spelling: 'in 20m' },
    action: { kind: 'fire', prompt: 'rotate the logs', onParked: 'queue' },
    preflightAtWrite: { state: 'expiring', expiresAt: FIXED_NOW - 10 * MIN, beforeFire: true },
  }),
]

const OPS_HELD: HeldFireV1[] = [
  {
    scheduleId: 'dddd4444',
    dueAt: FIXED_NOW - 65 * MIN,
    reason: 'sign-in-expired',
    envelope: { scheduleId: 'dddd4444', kind: 'fire', dueAt: FIXED_NOW - 65 * MIN, prompt: 'rotate the logs' },
    heldAt: FIXED_NOW - 64 * MIN,
  },
  {
    scheduleId: 'dddd4444',
    dueAt: FIXED_NOW - 5 * MIN,
    reason: 'sign-in-expired',
    envelope: { scheduleId: 'dddd4444', kind: 'fire', dueAt: FIXED_NOW - 5 * MIN, prompt: 'rotate the logs' },
    heldAt: FIXED_NOW - 4 * MIN,
  },
]

const BOX_SCHEDULES: SaturnScheduleV1[] = [
  sched({
    id: 'eeee5555',
    when: { kind: 'at', atMs: FIXED_NOW + 6 * HOUR, spelling: 'in 6h' },
    action: {
      kind: 'birth',
      birth: {
        workspaceDir: '/Users/op/Developer/orchard-src',
        modelKey: 'claude-opus-5',
        presence: 'headless',
        opening: 'run the audit and leave receipts',
      },
    },
  }),
]

function rowsOf(
  sessionTitle: string,
  sessionId: string,
  parked: boolean,
  schedules: SaturnScheduleV1[],
  held: HeldFireV1[],
  box?: true,
): SaturnScreenRowV1[] {
  const facts = saturnFactsOf({ schedules, heldFires: held.length > 0 ? held : undefined }, FIXED_NOW)
  return (facts.schedules ?? []).map(f => ({
    sessionTitle,
    sessionId: box === true ? `box:${f.id}` : sessionId,
    workspaceId: '/Users/op/Developer/orchard-src',
    parked,
    ...(box === true ? { box: true as const } : {}),
    facts: f,
    schedule: schedules.find(s => s.id === f.id)!,
    held: held.filter(h => h.scheduleId === f.id),
  }))
}

/** The fixture board — sorted soonest-first like the live collect. */
export const FIXTURE_FACTS: SaturnScreenFactsV1 = (() => {
  const rows = sortForBoard([
    ...rowsOf('journey session', 'sess-journey-1', false, JOURNEY_SCHEDULES, []),
    ...rowsOf('ops', 'sess-ops-2', true, OPS_SCHEDULES, OPS_HELD),
    ...rowsOf('box', 'box', false, BOX_SCHEDULES, [], true),
  ])
  return { rows, heldTotal: OPS_HELD.length, sessions: 2, daemonReadable: true }
})()

export const EMPTY_FACTS: SaturnScreenFactsV1 = { rows: [], heldTotal: 0, sessions: 2, daemonReadable: true }

/** The held row's receipt tail — the fired-late/missed honesty the detail
 *  panel keeps visible (fixture rows wear the ticker's own summary shapes). */
export function fixtureReceiptsOf(row: SaturnScreenRowV1): SessionReceiptEntry[] {
  if (row.facts.id !== 'dddd4444') return []
  return [
    {
      at: new Date(FIXED_NOW - 64 * MIN).toISOString(),
      by: 'saturn:dddd4444',
      kind: 'schedule-held',
      summary: 'held: sign-in expired — /logins releases 1 held fire',
      details: { scheduleId: 'dddd4444' },
    },
    {
      at: new Date(FIXED_NOW - 30 * MIN).toISOString(),
      by: 'saturn:dddd4444',
      kind: 'schedule-fire',
      summary: 'missed — ~430m late, beyond the 360m catch-up window; not fired (re-armed forward)',
      details: { scheduleId: 'dddd4444', outcome: 'missed-expired' },
    },
  ]
}

/** The screen's menuM, assembled from the SAME pure owners — a still can
 *  never drift from the screen's own composers. */
export function composeSaturn(
  cols: number,
  rows: number,
  opts: { sel?: number; facts?: SaturnScreenFactsV1 } = {},
): string[] {
  const facts = opts.facts ?? FIXTURE_FACTS
  const sel = facts.rows.length === 0 ? -1 : Math.min(opts.sel ?? 0, facts.rows.length - 1)
  const selected = sel >= 0 ? facts.rows[sel]! : null
  const m = {
    entries: facts.rows.map(r => saturnEntryOf(r, FIXED_NOW)),
    selIdx: sel,
    title: 'saturn scheduler',
    summaryTitle: 'SATURN',
    summaryRows: saturnSummaryRows(facts, FIXED_NOW),
    environment: STILL_ENVIRONMENT,
    statusRight: saturnStatusLine(facts),
    moreHint: '… (the trail continues — a taller terminal shows it whole)',
    legend: saturnLegendOf({ busy: false }),
    detailOverride:
      selected !== null ? saturnDetailLines(selected, FIXED_NOW, fixtureReceiptsOf(selected)) : saturnEmptyDetailLines(facts),
  }
  const menu = core.composeBootMenu(cols, rows, m) as { lines: string[] }
  const { placed } = core.placeBlock(menu.lines, rows) as { placed: string[] }
  return placed
}

const heldIdx = FIXTURE_FACTS.rows.findIndex(r => r.facts.id === 'dddd4444')

// ── the form's frames (the birth composer over the seven facts) ─────────────

/** A filled form — every fact set, the ready world. */
export const FIXTURE_FORM: SaturnFormStateV1 = {
  ...freshSaturnForm({ modelKey: 'claude-opus-5', workspaceDir: '/Users/op/Developer/orchard-src' }),
  when: 'in 2h',
  kitPreset: 'review-kit',
  opening: 'sweep the overnight issues and brief me',
  contract: { kind: 'none' },
  title: 'morning sweep',
}

export const READY_PREFLIGHT: SaturnFormPreflightV1 = {
  derivation: { ok: true, account: { family: 'anthropic', source: 'oauth', identity: 'op@example.com' } },
  verdict: { state: 'ready' },
}

export const EXPIRED_PREFLIGHT: SaturnFormPreflightV1 = {
  derivation: { ok: true, account: { family: 'openai', source: 'oauth', identity: 'op@example.com' } },
  verdict: { state: 'expired' },
}

/** The form's menuM through the SAME pure owners (the screen's own branch). */
export function composeSaturnForm(
  cols: number,
  rows: number,
  opts: { form?: SaturnFormStateV1; preflight?: SaturnFormPreflightV1; sel?: number } = {},
): string[] {
  const form = opts.form ?? FIXTURE_FORM
  const preflight = opts.preflight ?? READY_PREFLIGHT
  const compiled = form.when === '' ? null : compileWhenSpelling(form.when, FIXED_NOW)
  const m = {
    entries: saturnFormEntries(form),
    selIdx: opts.sel ?? 0,
    title: 'saturn scheduler',
    summaryTitle: 'SATURN',
    summaryRows: saturnSummaryRows(FIXTURE_FACTS, FIXED_NOW),
    environment: STILL_ENVIRONMENT,
    statusRight: 'the seven facts — ↵ edits a row',
    moreHint: '… (the trail continues — a taller terminal shows it whole)',
    legend: saturnFormLegendOf({ prompt: false, pick: false }),
    detailOverride: saturnFormDetailLines(form, compiled, preflight, FIXED_NOW),
  }
  const menu = core.composeBootMenu(cols, rows, m) as { lines: string[] }
  const { placed } = core.placeBlock(menu.lines, rows) as { placed: string[] }
  return placed
}

export const STILLS: Array<{ id: string; compose: () => string[] }> = [
  { id: 'saturn-120x40', compose: () => composeSaturn(120, 40, { sel: 0 }) },
  { id: 'saturn-80x24', compose: () => composeSaturn(80, 24, { sel: 0 }) },
  { id: 'saturn-64x12', compose: () => composeSaturn(64, 12, { sel: 0 }) },
  { id: 'saturn-120x40-held', compose: () => composeSaturn(120, 40, { sel: heldIdx }) },
  { id: 'saturn-120x40-empty', compose: () => composeSaturn(120, 40, { facts: EMPTY_FACTS }) },
  { id: 'saturn-120x40-form', compose: () => composeSaturnForm(120, 40) },
  { id: 'saturn-120x40-form-held', compose: () => composeSaturnForm(120, 40, { preflight: EXPIRED_PREFLIGHT }) },
]

export function stillPath(id: string): string {
  return join(STILLS_DIR, `${id}.txt`)
}

export function readStill(id: string): string | null {
  try {
    return readFileSync(stillPath(id), 'utf8')
  } catch {
    return null
  }
}

export function renderStill(lines: string[]): string {
  return lines.map(l => l.replace(/\s+$/, '')).join('\n') + '\n'
}

if (import.meta.main && process.argv.includes('--write')) {
  mkdirSync(STILLS_DIR, { recursive: true })
  for (const still of STILLS) {
    writeFileSync(stillPath(still.id), renderStill(still.compose()))
    console.log(`wrote ${stillPath(still.id)}`)
  }
}
