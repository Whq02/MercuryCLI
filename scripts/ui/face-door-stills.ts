#!/usr/bin/env bun
// ============================================================================
// scripts/ui/face-door-stills.ts — the FACE-DOOR STILL FRAMES (the
//  operator's face-native Health + Resume entrances, written as bytes): the
//  boot face's health screen at the 64×12 product floor, the classic tier
//  (80×24) and the wide tier (120×40) — plus the ↵ evidence layer and the
//  fix consent card — composed by the SAME pure owners the screen composes
//  with (BootHealthScreen's exported entry/detail/summary/legend/status
//  composers over composeBootMenu), nocolor so the stills read as text.
//  `--write` regenerates scripts/ui/fixtures/face-doors/*.txt;
//  prove-face-doors.ts byte-compares the live composition against them (the
//  regen-wrapper pattern: a drifted still reds the gate until re-written on
//  purpose). The real-boot look is the operator's drive (never a PTY here).
//  The resume screen's frames compose through the REAL C2 projection
//  (projectSessionPickerRows over fixture logs at a frozen clock), so a
//  still can never drift from the pipeline that feeds the live screen.
// ============================================================================
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSplashCore } from '../../assets/splash/splash-core.mjs'
import {
  healthDetailLines,
  healthEntryOf,
  healthFixCardLines,
  healthLegendOf,
  healthNextEntries,
  healthStatusLine,
  healthSummaryRows,
  healthTrailEntries,
  type HealthEntry,
  type HealthFixFlow,
} from '../../src/components/BootHealthScreen.js'
import { formatAge } from '../../src/utils/healthCertCore.js'
import type { HealthCertificate } from '../../src/utils/healthReport.js'
import {
  pruneCardLines,
  pruneLegendOf,
  pruneReceiptLines,
  pruneScopeLabelOf,
  resumeCrewDetailLines,
  resumeCrewEntryOf,
  resumeDetailLines,
  resumeElsewhereEntry,
  resumeEmptyDetailLines,
  resumeEntryOf,
  resumeLegendOf,
  resumeStatusLine,
  resumeSummaryRows,
  type ResumeEntry,
} from '../../src/components/BootResumeScreen.js'
import { projectSessionPickerRows, type SessionScope } from '../../src/components/mercury-ui/screens/sessionPickerModel.js'
import type { LogOption } from '../../src/types/logs.js'
import { buildPruneOffer, type PruneReceipt } from '../../src/utils/sessionStorage/transcriptPruneDoor.js'

export const STILLS_DIR = join(import.meta.dir, 'fixtures', 'face-doors')

const core = createSplashCore({ nocolor: true, truecolor: false, accent: 'crimson' })

/** The kit stills' environment spellings — one fixed panel for every frame. */
export const STILL_ENVIRONMENT = {
  model: 'Opus 5',
  critter: 'Octopus',
  critterHue: '#B07BE0',
  dirBase: 'orchard-src',
  dirTail: '',
}

/** The frozen clock the ages compose against (the nowMs proof seam). */
export const FIXED_NOW = Date.parse('2026-08-29T12:00:00Z')

/** A settled CAUTION certificate wearing every status word the meta knows
 *  except fail (fail would rightly turn the verdict FAULT): the still shows
 *  each value register, the NEXT ranking, a fixable row's trail and a
 *  destructive remedy's consent card. Sections are ARBITRARY here by design
 *  — the screen renders whatever the certificate carries (the generic-
 *  sections law; a sibling lane's new doctor rows appear for free). */
export const FIXED_CERT: HealthCertificate = {
  verdict: 'caution',
  ranAt: '2026-08-29T11:58:00Z',
  head: { sha: 'abcdef1234567890', branch: 'main', dirty: false },
  version: '1.0.0-beta.1',
  durationMs: 830,
  depth: 'fast',
  sections: [
    {
      id: 'runtime',
      title: 'RUNTIME',
      checks: [
        { id: 'node', label: 'Node runtime', status: 'ok', evidence: 'node 24.20.1 inside >=24.20.0 <25' },
        { id: 'bundle', label: 'Bundle integrity', status: 'ok', evidence: 'manifest sha matches dist/mercury.mjs' },
        {
          id: 'keybindings',
          label: 'Keybindings file',
          status: 'warn',
          evidence: '~/.mercury/keybindings.json holds 2 unknown actions',
          detail: 'Unknown actions are ignored at load; the file keeps working.',
          fix: 'remove the unknown rows, or re-run the keybindings doctor',
          remedy: { class: 'safe', plan: 'rewrite keybindings.json without the 2 unknown action rows (a .bak copy is left beside it)' },
        },
      ],
    },
    {
      id: 'providers',
      title: 'PROVIDERS',
      checks: [
        {
          id: 'auth',
          label: 'Anthropic credential',
          status: 'stale',
          evidence: 'last verified 26h ago',
          fix: 'open /logins to re-verify',
          link: '/logins',
          remedy: { class: 'destructive', plan: 'drop the cached credential snapshot and force a fresh verification round-trip' },
        },
        { id: 'router', label: 'Model route', status: 'info', evidence: 'main model routes to the Anthropic family' },
      ],
    },
    {
      id: 'estate',
      title: 'ESTATE',
      checks: [
        { id: 'daemon', label: 'Daemon reachability', status: 'unknown', evidence: 'no probe ran at fast depth — d runs it' },
        { id: 'cert-store', label: 'Certificate store', status: 'off', evidence: 'MERCURY_DOCTOR_CERT=0 gates persistence' },
      ],
    },
  ],
}

/** The screen's menuM, assembled from the SAME pure owners (the kit stills'
 *  composeManager pattern — a still can never drift from the screen's own
 *  composers). `view` picks the frame: the list (cursor on `sel`, counted
 *  over CHECK rows), the ↵ trail layer, or the fix card. */
export function composeHealth(
  cols: number,
  rows: number,
  opts: { view: 'list' | 'trail' | 'fix'; sel?: number; cert?: HealthCertificate } = { view: 'list' },
): string[] {
  const cert = opts.cert ?? FIXED_CERT
  const checkRows = cert.sections.flatMap(s => s.checks.map(check => ({ check, sectionTitle: s.title })))
  const sel = Math.min(opts.sel ?? 0, checkRows.length - 1)
  const selected = checkRows[sel]!
  const statusRight = healthStatusLine({
    kind: 'settled',
    verdict: cert.verdict,
    checks: checkRows.length,
    issuedAgo: formatAge(FIXED_NOW - Date.parse(cert.ranAt)),
    durationMs: cert.durationMs,
  })
  const summaryRows = healthSummaryRows(cert, FIXED_NOW)
  const base = {
    title: 'health check',
    summaryTitle: 'CERTIFICATE',
    summaryRows,
    environment: STILL_ENVIRONMENT,
    statusRight,
  }
  let m: Record<string, unknown>
  if (opts.view === 'trail') {
    m = {
      ...base,
      entries: healthTrailEntries(selected.check),
      selIdx: -1,
      legend: healthLegendOf({ fixable: false, trailOpen: true, fixPhase: null }),
      detailOverride: healthDetailLines(selected.check),
    }
  } else if (opts.view === 'fix') {
    const flow: HealthFixFlow = { phase: 'confirm', check: selected.check }
    const entries: HealthEntry[] = [...healthNextEntries(cert), ...checkRows.map(r => healthEntryOf(r.check, r.sectionTitle))]
    m = {
      ...base,
      entries,
      selIdx: healthNextEntries(cert).length + sel,
      legend: healthLegendOf({ fixable: true, trailOpen: false, fixPhase: 'confirm' }),
      detailOverride: healthFixCardLines(flow),
    }
  } else {
    const entries: HealthEntry[] = [...healthNextEntries(cert), ...checkRows.map(r => healthEntryOf(r.check, r.sectionTitle))]
    m = {
      ...base,
      entries,
      selIdx: healthNextEntries(cert).length + sel,
      moreHint: '… (↵ opens the full trail)',
      legend: healthLegendOf({ fixable: false, trailOpen: false, fixPhase: null }),
      detailOverride: healthDetailLines(selected.check),
    }
  }
  const menu = core.composeBootMenu(cols, rows, m) as { lines: string[] }
  const { placed } = core.placeBlock(menu.lines, rows) as { placed: string[] }
  return placed
}

// ── the resume screen's frames (C3) ─────────────────────────────────────────

/** A fixture session log — titled, so the substance filter keeps it. */
function fixtureLog(over: Partial<LogOption> & { sessionId: string; modifiedMs: number; title?: string }): LogOption {
  const { modifiedMs, title, ...rest } = over
  return {
    date: new Date(modifiedMs).toISOString(),
    messages: [],
    fullPath: `/store/${over.sessionId}.jsonl`,
    value: 0,
    created: new Date(modifiedMs),
    modified: new Date(modifiedMs),
    firstPrompt: 'a real prompt',
    messageCount: 3,
    isSidechain: false,
    customTitle: title ?? `chat ${over.sessionId}`,
    projectPath: '/repo/orchard-src',
    fileSize: 9000,
    ...rest,
  } as LogOption
}

const MIN = 60_000
/** The fixture store: two projects, a cleared chat, a crew seat — every row
 *  shape the picker knows, THROUGH the real C2 projection (a still can
 *  never drift from the pipeline). */
export const RESUME_FIXTURE_LOGS: LogOption[] = [
  fixtureLog({ sessionId: 'a1', modifiedMs: FIXED_NOW - 2 * MIN, title: 'the tool-loop fold' }),
  fixtureLog({ sessionId: 'a2', modifiedMs: FIXED_NOW - 3 * 60 * MIN, title: 'concourse polish' }),
  fixtureLog({ sessionId: 'b1', modifiedMs: FIXED_NOW - 26 * 60 * MIN, title: 'moodle groundwork', projectPath: '/repo/moodle' }),
  fixtureLog({ sessionId: 'a3', modifiedMs: FIXED_NOW - 2 * 24 * 60 * MIN, title: 'splash ripple study' }),
  fixtureLog({
    sessionId: 'crew1',
    modifiedMs: FIXED_NOW - 40 * MIN,
    title: 'lane KITDOOR census',
    isTeammate: true,
    teamName: 'party',
    agentName: 'dps1',
  } as Partial<LogOption> & { sessionId: string; modifiedMs: number; title: string }),
]

export function resumeModelOf(scope: SessionScope, opts: { cleared?: string[]; logs?: LogOption[] } = {}): ReturnType<typeof projectSessionPickerRows> {
  return projectSessionPickerRows(opts.logs ?? RESUME_FIXTURE_LOGS, {
    scope,
    projectDir: '/repo/orchard-src',
    boardHomed: new Set(),
    isCleared: id => (opts.cleared ?? ['a2']).includes(id ?? ''),
    nowMs: FIXED_NOW,
  })
}

/** The prune frames' store: the picker fixtures plus two chats aged past
 *  the 30-day window the still freezes its offer over. */
export const PRUNE_FIXTURE_LOGS: LogOption[] = [
  ...RESUME_FIXTURE_LOGS,
  fixtureLog({ sessionId: 'old1', modifiedMs: FIXED_NOW - 40 * 24 * 60 * MIN, title: 'forty-day spike', fileSize: 120_000 }),
  fixtureLog({ sessionId: 'old2', modifiedMs: FIXED_NOW - 90 * 24 * 60 * MIN, title: 'ninety-day archive', fileSize: 48_000 }),
]

/** The resume screen's menuM, assembled from the SAME pure owners (the
 *  screen's composers over the C2 projection). `sel` counts SELECTABLE rows
 *  (sessions then crew — the inert elsewhere line sits between them). */
export function composeResume(
  cols: number,
  rows: number,
  opts: {
    scope?: SessionScope
    sel?: number
    cleared?: string[]
    logs?: LogOption[]
    pendingMore?: number
    /** The prune door's stage for this frame: the frozen card (30-day
     *  window at the frozen clock) or a fixture receipt. */
    prune?: { answer: 'no' | 'yes' } | { receipt: PruneReceipt }
  } = {},
): string[] {
  const scope = opts.scope ?? 'all'
  const { flat, crew, elsewhereCount } = resumeModelOf(scope, opts)
  const pendingMore = opts.pendingMore ?? 0
  const entries: ResumeEntry[] = [
    ...flat.map(resumeEntryOf),
    ...(scope === 'project' && elsewhereCount > 0 ? [resumeElsewhereEntry(elsewhereCount)] : []),
    ...crew.map(resumeCrewEntryOf),
  ]
  const selectable = flat.length + crew.length
  const sel = selectable > 0 ? Math.min(opts.sel ?? 0, selectable - 1) : -1
  const entryIndexOf = (i: number): number =>
    i < flat.length ? i : i + (scope === 'project' && elsewhereCount > 0 ? 1 : 0)
  const pruneView =
    opts.prune === undefined
      ? null
      : 'receipt' in opts.prune
        ? { detailOverride: pruneReceiptLines(opts.prune.receipt, FIXED_NOW), legend: pruneLegendOf('receipt') }
        : (() => {
            const offer = buildPruneOffer(
              flat.map(f => f.row.log),
              { scopeLabel: pruneScopeLabelOf(scope), windowDays: 30, now: new Date(FIXED_NOW) },
            )
            return {
              detailOverride: pruneCardLines(offer, (opts.prune as { answer: 'no' | 'yes' }).answer, FIXED_NOW),
              legend: pruneLegendOf('card', offer.candidates.length > 0),
            }
          })()
  const m = {
    entries,
    selIdx: sel >= 0 ? entryIndexOf(sel) : -1,
    title: 'resume session',
    summaryTitle: 'SESSIONS',
    summaryRows: resumeSummaryRows({ scope, count: flat.length, crewCount: crew.length, elsewhereCount, pendingMore }),
    environment: STILL_ENVIRONMENT,
    statusRight: resumeStatusLine({ loading: false, count: flat.length, crewCount: crew.length, scope, pendingMore }),
    legend: resumeLegendOf(scope, selectable > 0),
    detailOverride:
      sel < 0
        ? resumeEmptyDetailLines(scope, elsewhereCount)
        : sel < flat.length
          ? resumeDetailLines(flat[sel]!)
          : resumeCrewDetailLines(crew[sel - flat.length]!),
    ...(pruneView ?? {}),
  }
  const menu = core.composeBootMenu(cols, rows, m) as { lines: string[] }
  const { placed } = core.placeBlock(menu.lines, rows) as { placed: string[] }
  return placed
}

export const STILLS: ReadonlyArray<{ id: string; compose: () => string[] }> = [
  // The three tiers of the ONE composition: wide (three-panel), classic,
  // and the 64×12 product floor — the floor frame carries the composer's
  // own warn line and keeps operating (WARN-NEVER-WALL; a wall here reds
  // prove-size-ladder's roster law).
  { id: 'health-120x40', compose: () => composeHealth(120, 40, { view: 'list', sel: 2 }) },
  { id: 'health-80x24', compose: () => composeHealth(80, 24, { view: 'list', sel: 2 }) },
  { id: 'health-64x12', compose: () => composeHealth(64, 12, { view: 'list', sel: 2 }) },
  // The ↵ evidence layer (the full trail at every tier) and the fix consent
  // card on the destructive row (the warning is part of the frame).
  { id: 'health-120x40-trail', compose: () => composeHealth(120, 40, { view: 'trail', sel: 2 }) },
  { id: 'health-80x24-trail', compose: () => composeHealth(80, 24, { view: 'trail', sel: 2 }) },
  { id: 'health-120x40-fix', compose: () => composeHealth(120, 40, { view: 'fix', sel: 3 }) },
  // The resume screen: the three tiers in the full-history scope (projects
  // interleaved, the cleared mark on its row, the crew section classed
  // apart), the project scope with its honest elsewhere line, and the
  // empty world's n-births-here detail.
  { id: 'resume-120x40', compose: () => composeResume(120, 40, { scope: 'all', sel: 1 }) },
  { id: 'resume-80x24', compose: () => composeResume(80, 24, { scope: 'all', sel: 1 }) },
  { id: 'resume-64x12', compose: () => composeResume(64, 12, { scope: 'all', sel: 1 }) },
  { id: 'resume-120x40-project', compose: () => composeResume(120, 40, { scope: 'project', sel: 0 }) },
  { id: 'resume-120x40-empty', compose: () => composeResume(120, 40, { scope: 'all', logs: [] }) },
  // The prune door on the face (the second named card of the one deleting
  // door): the frozen offer over the aged store — No leading and default —
  // and the typed receipt.
  { id: 'resume-120x40-prune-card', compose: () => composeResume(120, 40, { scope: 'all', logs: PRUNE_FIXTURE_LOGS, prune: { answer: 'no' } }) },
  {
    id: 'resume-120x40-prune-receipt',
    compose: () =>
      composeResume(120, 40, {
        scope: 'all',
        logs: PRUNE_FIXTURE_LOGS,
        prune: {
          receipt: {
            deleted: 2,
            failed: 0,
            bytesFreed: 168_000,
            at: new Date(FIXED_NOW - MIN),
            deletedSessionIds: ['old1', 'old2'],
            receiptsDeleted: 0,
            snapshotsDeleted: 1,
          },
        },
      }),
  },
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
