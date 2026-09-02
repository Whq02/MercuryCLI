// ============================================================================
//  scripts/golden-journeys/journeyLib.ts — the shared J1–J5 golden-journey harness
//
//
//  The frozen measurement substrate for the five golden journeys: a hermetic
//  config home + a deterministic fixture repository + seeded sessions in the
//  REAL persisted shapes + run sidecars folded through the REAL run kernel
//  reducer + a seeded task ledger — driven through the BUILT artifact in a
//  real PTY (vshot), with pyte-COMPOSED grids as the only text oracle (the
//  oracle law: raw-byte scans are blind to on-screen text).
//
//  Measurement contract (the census §3): journeys measure NAVIGATION,
//  VISIBILITY and IDENTITY — deterministic step counts, never wall-clock.
//  Each journey emits a JourneyReport JSON; score.ts aggregates. The SAME
//  fixtures + probes evaluate the before and after states — probes try
//  at-glance first, then the journey's declared navigation routes, so an
//  improvement moves the metric mechanically, never by re-tuning needles.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import {
  emptyRunSnapshot,
  reduceRunEvent,
  type RunEvent,
  type RunSnapshot,
} from '../../src/services/run/runKernel.ts'
import { makeOwnerKey, type OwnerKey } from '../../src/services/run/ownerKey.ts'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

export const REPO = path.resolve(import.meta.dir, '../..')
export const DIST = path.join(REPO, 'dist/mercury.mjs')
const VSHOT = path.join(REPO, 'scripts/ui/vshot.py')

// ── the hermetic world ────────────────────

// realpath: macOS tmpdir is a /var → /private/var symlink; the product keys
// trust + the session slug on the RESOLVED boot cwd, so the fixture world
// must live at the resolved path or every seed misses.
export const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-momentum-${process.pid}`)
export const FIXTURE_CWD = path.join(RUN_HOME, 'fixture-repo')
// ALWAYS synthetic (M6 hermeticity, logic finding C8): the operator's real
// key must never enter a journey world — a fixture that can bill is a fixture
// that can leak. The seeded approval matches this exact tail.
export const PROBE_KEY = 'sk-ant-momentum-journey-probe'

/** Stable per-journey session ids (hermetic home ⇒ no pid suffix needed). */
export const SIDS = {
  J1: '00000000-aaaa-bbbb-eee1-000000000001',
  J2: '00000000-aaaa-bbbb-eee2-000000000002',
  J3: '00000000-aaaa-bbbb-eee3-000000000003',
  J4: '00000000-aaaa-bbbb-eee4-000000000004',
  J5: '00000000-aaaa-bbbb-eee5-000000000005',
} as const

const PROJECT_DIR = () => path.join(RUN_HOME, 'projects', sanitizePath(FIXTURE_CWD))

let exitCleanupArmed = false

export function seedWorld(): void {
  // Leak guard (M6, logic finding C9): a throwing journey must still reap its
  // scratch world — cleanupWorld() on the success path, this hook otherwise.
  if (!exitCleanupArmed) {
    exitCleanupArmed = true
    process.on('exit', () => {
      try {
        rmSync(RUN_HOME, { recursive: true, force: true })
      } catch {
        /* scratch reap is best-effort */
      }
    })
  }
  rmSync(RUN_HOME, { recursive: true, force: true })
  mkdirSync(FIXTURE_CWD, { recursive: true })
  // The onboarded home: trust for the fixture repo + the approved key tail,
  // written to the ONE global config the product reads (`<home>/.mercury.json`
  // — getGlobalMercuryFile); any other spelling is never adopted and the boot
  // lands on the trust gate instead of the composer.
  writeFileSync(
    path.join(RUN_HOME, '.mercury.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: 'dark',
      projects: { [FIXTURE_CWD]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
    }),
  )
  writeFileSync(path.join(RUN_HOME, 'settings.json'), JSON.stringify({}))
  mkdirSync(PROJECT_DIR(), { recursive: true })

  // The fixture repository: one committed baseline + one uncommitted working
  // change, so git facts (branch/dirty) and the /diff sources are REAL.
  // Global/system git config stays OUT of the fixture (M6 hermeticity, C8):
  // an operator core.hooksPath would otherwise run their hooks inside it.
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', FIXTURE_CWD, ...args], { stdio: 'pipe', env: gitEnv })
  execFileSync('git', ['init', '-q', '-b', 'main', FIXTURE_CWD], { stdio: 'pipe', env: gitEnv })
  git('config', 'user.email', 'momentum@fixture.local')
  git('config', 'user.name', 'Momentum Fixture')
  mkdirSync(path.join(FIXTURE_CWD, 'src'), { recursive: true })
  writeFileSync(
    path.join(FIXTURE_CWD, 'src/greet.ts'),
    'export function greet(name: string) {\n  return `hello`\n}\n',
  )
  writeFileSync(
    path.join(FIXTURE_CWD, 'check.sh'),
    '#!/bin/sh\ngrep -q "hello, ${1:-world}" src/greet.ts && echo PASS || echo FAIL\n',
  )
  writeFileSync(path.join(FIXTURE_CWD, 'README.md'), '# fixture demo\n')
  git('add', '-A')
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture baseline')
  // The uncommitted "work" the seeded sessions describe.
  writeFileSync(
    path.join(FIXTURE_CWD, 'src/greet.ts'),
    'export function greet(name: string) {\n  return `hello, ${name}`\n}\n',
  )
}

export function cleanupWorld(): void {
  rmSync(RUN_HOME, { recursive: true, force: true })
}

// ── seeded sessions (the REAL persisted shapes — renderScenarios lineage) ────

type Row = Record<string, unknown>

export function rowBase(sid: string, extra: Row): Row {
  return {
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd: FIXTURE_CWD,
    sessionId: sid,
    version: '1.0.0-beta.1',
    gitBranch: 'main',
    ...extra,
  }
}

let rowN = 0
const uid = () => `00000000-0000-4000-8000-${String(++rowN).padStart(12, '0')}`

/** user ask → [tool rounds] → final assistant text, correctly parent-linked. */
export function conversationRows(
  sid: string,
  ask: string,
  rounds: Array<{ toolUse: Row; toolResult: Row }>,
  finalText: string,
  t0 = Date.parse('2026-07-20T12:00:00.000Z'),
): Row[] {
  const rows: Row[] = []
  let parent: string | null = null
  let t = t0
  const push = (extra: Row): string => {
    const u = uid()
    rows.push(rowBase(sid, { parentUuid: parent, uuid: u, timestamp: new Date((t += 1000)).toISOString(), ...extra }))
    parent = u
    return u
  }
  push({ type: 'user', message: { role: 'user', content: ask } })
  for (const [i, round] of rounds.entries()) {
    push({
      type: 'assistant',
      requestId: `req_momentum_${sid.slice(-2)}_${i}`,
      message: {
        id: `msg_momentum_${sid.slice(-2)}_${i}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [round.toolUse],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    const { toolUseResult, content } = round.toolResult as {
      toolUseResult: unknown
      content: unknown
    }
    push({ type: 'user', message: { role: 'user', content }, toolUseResult })
  }
  push({
    type: 'assistant',
    requestId: `req_momentum_${sid.slice(-2)}_final`,
    message: {
      id: `msg_momentum_${sid.slice(-2)}_final`,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: finalText }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  })
  return rows
}

/** The seeded session in the REAL persisted shape: record lines through the
 *  codec — the shape the built artifact opens on --resume. */
export function writeSession(sid: string, rows: Row[]): void {
  writeFileSync(
    path.join(PROJECT_DIR(), `${sid}.jsonl`),
    encodeSeedTranscript(rows as unknown as Record<string, unknown>[], sid),
  )
}

export function sessionPath(sid: string): string {
  return path.join(PROJECT_DIR(), `${sid}.jsonl`)
}

/** Remove a session's DURABLE composer draft (renderScenarios lineage): a
 *  draft typed in one capture is restored on the next boot, where it would
 *  swallow a scripted slash command as draft text. */
export function purgeDraft(sid: string): void {
  const draftsDir = path.join(RUN_HOME, 'drafts')
  if (!existsSync(draftsDir)) return
  for (const f of readdirSync(draftsDir)) {
    if (!f.endsWith('.json')) continue
    const fp = path.join(draftsDir, f)
    try {
      const parsed = JSON.parse(readFileSync(fp, 'utf8')) as Record<string, unknown>
      if (sid in parsed) {
        delete parsed[sid]
        writeFileSync(fp, JSON.stringify(parsed, null, 2) + '\n')
      }
    } catch {
      /* unreadable draft store — leave it */
    }
  }
}

// Tool fixture shapes (sampled lineage: scripts/ui/renderScenarios.ts — the
// FULL output shapes; a partial toolUseResult fails zod and cards never paint).
export function editRound(file: string, oldS: string, newS: string, id: string) {
  const filePath = path.join(FIXTURE_CWD, file)
  return {
    toolUse: {
      type: 'tool_use',
      id,
      name: 'Edit',
      input: { file_path: filePath, old_string: oldS, new_string: newS },
    },
    toolResult: {
      content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
      toolUseResult: {
        filePath,
        oldString: oldS,
        newString: newS,
        originalFile: `${oldS}\n`,
        structuredPatch: [
          { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: [`-  ${oldS}`, `+  ${newS}`] },
        ],
        userModified: false,
        replaceAll: false,
      },
    },
  }
}

export function bashRound(command: string, description: string, stdout: string, id: string) {
  return {
    toolUse: { type: 'tool_use', id, name: 'Bash', input: { command, description } },
    toolResult: {
      content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: stdout }] }],
      toolUseResult: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
    },
  }
}

// ── run sidecar seeding (folded through the REAL reducer) ────────────────────

export function ownerFor(sid: string): OwnerKey {
  return makeOwnerKey({ workspace: FIXTURE_CWD, sessionId: sid, lane: 'main' })
}

export function foldRun(
  sid: string,
  runId: string,
  objective: string,
  events: RunEvent[],
  t0 = Date.parse('2026-07-20T12:00:00.000Z'),
): RunSnapshot {
  let snap = emptyRunSnapshot({ runId, owner: ownerFor(sid), objective, rootMessageId: null, at: t0 })
  for (const e of events) snap = reduceRunEvent(snap, e)
  return snap
}

export function writeRunSidecar(sid: string, snapshot: RunSnapshot, writeSeq = 3): void {
  writeFileSync(
    path.join(PROJECT_DIR(), `${sid}.run.json`),
    JSON.stringify(
      {
        schema: 1,
        writeSeq,
        operationId: `00000000-0000-4000-9000-00000000000${writeSeq}`,
        committedAt: '2026-07-20T12:30:00.000Z',
        snapshot,
      },
      null,
      2,
    ),
  )
}

export function readRunSidecar(sid: string): { writeSeq: number; snapshot: RunSnapshot } {
  return JSON.parse(readFileSync(path.join(PROJECT_DIR(), `${sid}.run.json`), 'utf8')) as {
    writeSeq: number
    snapshot: RunSnapshot
  }
}

// ── task ledger seeding (utils/tasks.ts on-disk shape; list id = session) ────

export interface SeedTask {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  blockedBy?: string[]
}

export function seedTasks(sid: string, tasks: SeedTask[]): void {
  const dir = path.join(RUN_HOME, 'tasks', sid.replace(/[^a-zA-Z0-9_-]/g, '-'))
  mkdirSync(dir, { recursive: true })
  for (const t of tasks) {
    writeFileSync(
      path.join(dir, `${t.id}.json`),
      JSON.stringify({
        id: t.id,
        subject: t.subject,
        description: t.subject,
        status: t.status,
        blocks: [],
        blockedBy: t.blockedBy ?? [],
        epoch: 0,
      }),
    )
  }
}

// ── PTY capture (vshot; grid-composed oracle; bounded retries) ───────────────

export interface Send {
  data: string
  atTick?: number
  minTick?: number
  awaitRaw?: string
  awaitText?: string
  awaitSettleTicks?: number
  awaitStableTicks?: number
  afterPrevTicks?: number
}

export interface CaptureOpts {
  sid: string
  tag: string
  sends?: Send[]
  total?: number
  stableTicks?: number
  cols?: number
  rows?: number
  /** Sendless captures gate readiness on this SETTLED-phase chrome alongside
   *  the composer '❯' (default 'resumed clean' — the resume recap card, the
   *  async settle product every journey world paints: the unified screen
   *  paints the transcript first and the recap rides the resume path behind
   *  it). Override for a world that does not resume a clean seeded session. */
  settledText?: string
}

export const journeyChildEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: RUN_HOME,
    ANTHROPIC_API_KEY: PROBE_KEY,
    // The renderScenarios hermeticity class: ambient machine state must never
    // paint into a journey frame (each pin's rationale lives at the owner).
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_DECK_COMPANION: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_DOCTOR_STATE_DIR: path.join(RUN_HOME, 'doctor-state'),
    MERCURY_DAEMON_DIR: path.join(RUN_HOME, 'daemon'),
    MERCURY_TEAMS_DIR: path.join(RUN_HOME, 'teams'),
    MERCURY_TABULA_DIR: path.join(RUN_HOME, 'tabula'),
    MERCURY_TABULA_MINERVA: '0',
    MERCURY_HOME: path.join(RUN_HOME, 'proof-home'),
  }
  delete env.NODE_ENV // a SOURCE-prover pin, not a PTY-boot pin
  return env
}

export interface Capture {
  text: string
  ok: boolean
}

/** Whitespace-squeezed match for PROSE needles (the transcript wraps long
 *  sentences mid-phrase; grid text carries the break). Cell-exact needles
 *  (globs, counts, single words) keep using plain includes. */
export function hasProse(c: Capture | string, needle: string): boolean {
  const text = typeof c === 'string' ? c : c.text
  // Box-drawing glyphs sit between a wrapped phrase's halves when pane rows
  // join (`…now │ │reports…`) — strip the chrome, then squeeze whitespace.
  const squeeze = (t: string): string =>
    t.replace(/[│╭╮╰╯─═║▔┃┆]/g, ' ').replace(/\s+/g, ' ')
  if (squeeze(text).includes(needle)) return true
  // COLUMN-AWARE passes: the cockpit splits into a ~20-cell lanes rail and
  // the center transcript, and the grid joins ROW-MAJOR — each column's
  // wrapped phrases get the OTHER column's row interleaved between their
  // halves, so the row-major squeeze can't see what a human reading either
  // column top-to-bottom plainly reads. Reconstruct both columns (the fixed
  // 100-col capture geometry) and match each.
  const lines = text.split('\n')
  const column = (from: number, to?: number): string =>
    squeeze(lines.map(line => line.slice(from, to)).join(' '))
  return column(0, 20).includes(needle) || column(20).includes(needle)
}

export function capture(opts: CaptureOpts): Capture {
  const out = path.join(RUN_HOME, `grid-${opts.tag}.json`)
  // OBSERVED-READY for SENDLESS captures: with zero sends, a stability-only
  // gate can break on a blank grid before a slow runner's node paints at all,
  // and the cockpit's live clock repaints every second, so a whole-grid
  // stability window never holds — a stability gate here means every capture
  // burns its full budget. Sendless captures therefore gate on OBSERVED READY
  // TEXT alone: the composer chrome '❯' AND the settled-phase chrome (the
  // resume recap card by default — the async product of the unified resume
  // path, which paints the transcript first and the recap behind it), with a
  // settle grace after the text lands. Chrome only, never a measured fact
  // needle — that would bias the at-glance probes. total stays the loud hard
  // deadline; vshot exits NEVER-READY if the chrome never paints.
  // stableTicks: 0 opts out entirely (J4's torn-boot capture — the kill
  // timing IS its contract).
  const sends = opts.sends ?? []
  const stable = opts.stableTicks ?? 4
  const sendlessReady =
    sends.length === 0 && stable > 0
      ? { readyText: ['❯', opts.settledText ?? 'resumed clean'], readySettleTicks: 6 }
      : { stableTicks: stable }
  const cfg = {
    argv: ['node', DIST, '--resume', opts.sid],
    cwd: FIXTURE_CWD,
    sends,
    ...sendlessReady,
    total: opts.total ?? (sends.length ? 110 : 90),
    cols: opts.cols ?? 100,
    rows: opts.rows ?? 32,
    out,
  }
  const cfgPath = path.join(RUN_HOME, `cfg-${opts.tag}.json`)
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const painted = (t: string) => t.replace(/\s/g, '').length
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
      encoding: 'utf-8',
      timeout: vshotBudgetMs(120_000),
      cwd: FIXTURE_CWD,
      env: journeyChildEnv(),
    })
    if (res.status !== 0 || !existsSync(out)) continue
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>> }
    const text = payload.grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')
    if (painted(text) >= 40) return { text, ok: true }
  }
  return { text: '', ok: false }
}

/** The standard slash-command journey sends: first key
 *  gates on the bracketed-paste arm; enter rides relative scheduling. */
export function slashSends(cmd: string, extra: Send[] = []): Send[] {
  return [
    { atTick: 55, minTick: 5, awaitRaw: '\x1b[?2004h', data: cmd },
    { afterPrevTicks: 6, data: '\r' },
    ...extra,
  ]
}

// ── fact probes + the journey report ─────────────────────────────────────────

export type Visibility = 'at-glance' | 'after-navigation' | 'not-visible'

export interface NavRoute {
  /** The slash command that opens the surface (a specialist command). */
  cmd: string
  /** Extra scripted keys after the surface mounts (drill-ins). */
  extra?: Send[]
}

export interface FactResult {
  fact: string
  needle: string
  visibility: Visibility
  /** Board visits needed (0 at glance). */
  transitions: number
  route: string | null
}

export class JourneyWalker {
  private navCache = new Map<string, Capture>()
  readonly captures: string[] = []
  /** Captures that never painted (M6, logic finding C3): a failed capture is
   *  a HARNESS failure, never silent 'not-visible' measurement. Journeys must
   *  fold this into their integrity checks. */
  readonly failedCaptures: string[] = []
  constructor(
    private readonly sid: string,
    private readonly journey: string,
  ) {}

  glance(tag = 'glance'): Capture {
    return this.cached(tag, () => capture({ sid: this.sid, tag: `${this.journey}-${tag}` }))
  }

  nav(route: NavRoute): Capture {
    return this.cached(`nav:${route.cmd}`, () =>
      capture({
        sid: this.sid,
        tag: `${this.journey}-nav-${route.cmd.replace(/\W/g, '')}`,
        sends: slashSends(route.cmd, route.extra ?? []),
      }),
    )
  }

  private cached(key: string, make: () => Capture): Capture {
    const hit = this.navCache.get(key)
    if (hit) return hit
    const made = make()
    if (!made.ok) this.failedCaptures.push(key)
    this.navCache.set(key, made)
    this.captures.push(key)
    return made
  }

  /** Probe one fact: at-glance on the plain resumed frame, else the declared
   *  navigation routes in order. Needles are distinctive SEEDED strings any
   *  faithful surface renders verbatim. */
  probeFact(fact: string, needle: string, routes: NavRoute[]): FactResult {
    if (hasProse(this.glance(), needle)) {
      return { fact, needle, visibility: 'at-glance', transitions: 0, route: null }
    }
    for (const route of routes) {
      if (hasProse(this.nav(route), needle)) {
        return { fact, needle, visibility: 'after-navigation', transitions: 1, route: route.cmd }
      }
    }
    return { fact, needle, visibility: 'not-visible', transitions: routes.length, route: null }
  }
}

export interface JourneyReport {
  journey: string
  completed: boolean
  integrityFailures: string[]
  facts: FactResult[]
  /** Unique specialist commands the journey REQUIRED (fact routes + steps). */
  specialistCommands: string[]
  surfaceTransitions: number
  stepsToFirstFeedback: number
  stepsToReviewedChange: number | null
  repeatedActions: number
  staleOrContradictoryFacts: number
  freshCheckAtClosure: boolean
}

export function reportPath(journey: string): string {
  return path.join(tmpdir(), `momentum-report-${journey}.json`)
}

export function writeReport(report: JourneyReport): void {
  writeFileSync(reportPath(report.journey), JSON.stringify(report, null, 2))
}

// ── shared check helper ──────────────────────────────────────────────────────

export function makeChecker(): {
  check: (name: string, ok: boolean, detail?: string) => void
  failures: () => string[]
} {
  const fails: string[] = []
  return {
    check(name, ok, detail) {
      if (ok) console.log(`  ok  ${name}`)
      else {
        fails.push(name)
        console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
      }
    },
    failures: () => fails,
  }
}

export function requireDist(): void {
  if (!existsSync(DIST)) {
    console.error('momentum journeys: dist/mercury.mjs missing — run the build first (the gate prebuilds it)')
    process.exit(1)
  }
}
