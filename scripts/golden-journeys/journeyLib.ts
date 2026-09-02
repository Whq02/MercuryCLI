
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


export const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-momentum-${process.pid}`)
export const FIXTURE_CWD = path.join(RUN_HOME, 'fixture-repo')
export const PROBE_KEY = 'sk-ant-momentum-journey-probe'

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
  if (!exitCleanupArmed) {
    exitCleanupArmed = true
    process.on('exit', () => {
      try {
        rmSync(RUN_HOME, { recursive: true, force: true })
      } catch {
      }
    })
  }
  rmSync(RUN_HOME, { recursive: true, force: true })
  mkdirSync(FIXTURE_CWD, { recursive: true })
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
  writeFileSync(
    path.join(FIXTURE_CWD, 'src/greet.ts'),
    'export function greet(name: string) {\n  return `hello, ${name}`\n}\n',
  )
}

export function cleanupWorld(): void {
  rmSync(RUN_HOME, { recursive: true, force: true })
}


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

export function writeSession(sid: string, rows: Row[]): void {
  writeFileSync(
    path.join(PROJECT_DIR(), `${sid}.jsonl`),
    encodeSeedTranscript(rows as unknown as Record<string, unknown>[], sid),
  )
}

export function sessionPath(sid: string): string {
  return path.join(PROJECT_DIR(), `${sid}.jsonl`)
}

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
    }
  }
}

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
  settledText?: string
}

export const journeyChildEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: RUN_HOME,
    ANTHROPIC_API_KEY: PROBE_KEY,
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
  delete env.NODE_ENV
  return env
}

export interface Capture {
  text: string
  ok: boolean
}

export function hasProse(c: Capture | string, needle: string): boolean {
  const text = typeof c === 'string' ? c : c.text
  const squeeze = (t: string): string =>
    t.replace(/[│╭╮╰╯─═║▔┃┆]/g, ' ').replace(/\s+/g, ' ')
  if (squeeze(text).includes(needle)) return true
  const lines = text.split('\n')
  const column = (from: number, to?: number): string =>
    squeeze(lines.map(line => line.slice(from, to)).join(' '))
  return column(0, 20).includes(needle) || column(20).includes(needle)
}

export function capture(opts: CaptureOpts): Capture {
  const out = path.join(RUN_HOME, `grid-${opts.tag}.json`)
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

export function slashSends(cmd: string, extra: Send[] = []): Send[] {
  return [
    { atTick: 55, minTick: 5, awaitRaw: '\x1b[?2004h', data: cmd },
    { afterPrevTicks: 6, data: '\r' },
    ...extra,
  ]
}


export type Visibility = 'at-glance' | 'after-navigation' | 'not-visible'

export interface NavRoute {
  cmd: string
  extra?: Send[]
}

export interface FactResult {
  fact: string
  needle: string
  visibility: Visibility
  transitions: number
  route: string | null
}

export class JourneyWalker {
  private navCache = new Map<string, Capture>()
  readonly captures: string[] = []
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
