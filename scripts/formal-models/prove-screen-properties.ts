#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import figures from 'figures'
import stripAnsi from 'strip-ansi'
import { checker } from '../engine-durability/harness.ts'

const previousCwd = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'mercury-screen-props-'))
const configHome = join(scratch, 'config')
const fixtureRoot = join(scratch, 'project')
mkdirSync(configHome, { recursive: true })
mkdirSync(fixtureRoot, { recursive: true })

process.chdir(fixtureRoot)
process.env.MERCURY_CONFIG_DIR = configHome
process.env.HOME = configHome
process.env.USERPROFILE = configHome
process.env.MERCURY_CLIPBOARD_FILE = join(configHome, 'clipboard.txt')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_RECESS = '0'
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_CRITTER_SLEEP = '0'
process.env.MERCURY_FULLSCREEN = '0'
process.env.FORCE_COLOR = '0'
process.env.BROWSER = '/usr/bin/true'
for (const name of Object.keys(process.env)) {
  if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|HF_TOKEN|GH_TOKEN)$/.test(name)) {
    delete process.env[name]
  }
}
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { mock } = await import('bun:test')
const React = await import('react')
const h = React.createElement

type SessionListing = import('../../src/sessions/transcripts/transcriptEntries.js').SessionListing

let activeLogs: SessionListing[] = []
let resumedCalls: Array<{ sessionId: string; fullPath?: string; title?: string }> = []
let faultRewriteId: ((sessionId: string) => string) | null = null

const realLogs = await import('../../src/sessions/transcripts/sessionListings.ts')
mock.module('../../src/sessions/transcripts/sessionListings.ts', () => ({
  ...realLogs,
  listRepoSessionsProgressive: async () => ({
    logs: activeLogs,
    allStatLogs: activeLogs,
    nextIndex: activeLogs.length,
  }),
  listSessionsAcrossProjectsProgressive: async () => ({
    logs: activeLogs,
    allStatLogs: activeLogs,
    nextIndex: activeLogs.length,
  }),
}))

const realHop = await import('../../src/daemon/switchboard/hopIntoSession.ts')
mock.module('../../src/daemon/switchboard/hopIntoSession.ts', () => ({
  ...realHop,
  focusResumedSession: async (
    sessionId: string,
    fullPath?: string,
    opts?: { title?: string },
  ) => {
    const delivered = faultRewriteId ? faultRewriteId(sessionId) : sessionId
    resumedCalls.push({ sessionId: delivered, fullPath, title: opts?.title })
    return { ok: false as const, reason: 'property-harness-capture' }
  },
}))

const realGit = await import('../../src/platform/git/git.ts')
mock.module('../../src/platform/git/git.ts', () => ({
  ...realGit,
  getBranch: async () => null,
}))

const realWorktrees = await import('../../src/platform/git/worktree/worktreePaths.ts')
mock.module('../../src/platform/git/worktree/worktreePaths.ts', () => ({
  ...realWorktrees,
  getWorktreePaths: async () => [fixtureRoot],
}))

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()

const { default: Ink } = await import('../../src/screen/renderer/screenInstance.js')
const { default: instances } = await import('../../src/screen/renderer/instances.js')
const { default: reconciler } = await import('../../src/screen/renderer/reconciler.js')
const { disposeKeybindingWatcher } = await import('../../src/screen/keys/loadUserBindings.js')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { TerminalSizeContext } = await import('../../src/screen/renderer/elements/TerminalSizeContext.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { ResumeConversation } = await import('../../src/screen/chat/ResumeSession.tsx')

class FakeStdout extends EventEmitter {
  isTTY = true
  columns: number
  rows: number
  constructor(columns: number, rows: number) {
    super()
    this.columns = columns
    this.rows = rows
  }
  write(): boolean {
    return true
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true
  isRaw = false
  private chunks: string[] = []
  setEncoding(): this {
    return this
  }
  setRawMode(v: boolean): this {
    this.isRaw = v
    return this
  }
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
  pause(): this {
    return this
  }
  resume(): this {
    return this
  }
  read(): string | null {
    return this.chunks.shift() ?? null
  }
  get readableLength(): number {
    return this.chunks.reduce((n, c) => n + c.length, 0)
  }
  push(data: string): void {
    this.chunks.push(data)
    this.emit('readable')
  }
}

const KEYS = {
  down: '\x1b[B',
  up: '\x1b[A',
  pgdn: '\x1b[6~',
  pgup: '\x1b[5~',
  home: '\x1b[H',
  end: '\x1b[F',
  tab: '\t',
  shiftTab: '\x1b[Z',
  enter: '\x1b[13u',
  esc: '\x1b[27u',
} as const

type KeyStep =
  | { kind: 'nav'; key: 'down' | 'up' | 'pgdn' | 'pgup' | 'home' | 'end' | 'tab' | 'shiftTab' }
  | { kind: 'search'; query: string; clear: boolean }

type SessionSpec = {
  tag?: 'alpha' | 'beta'
  ageRank: number
}

type Scenario = {
  sessions: SessionSpec[]
  sidechains: number
  rows: number
  steps: KeyStep[]
  ending: 'select' | 'cancel'
}

type BuiltSession = {
  marker: string
  sessionId: string
  fullPath: string
  listing: SessionListing
}

const COLS = 100
const BASE_MS = Date.UTC(2026, 10, 1, 12, 0, 0)
const POINTER = figures.pointer

function buildSessions(specs: readonly SessionSpec[], sidechains: number): {
  primary: BuiltSession[]
  byMarker: Map<string, BuiltSession>
  listings: SessionListing[]
} {
  const primary: BuiltSession[] = specs.map((spec, idx) => {
    const n = idx + 1
    const tag = String(n).padStart(2, '0')
    const marker = `[S${tag}]`
    const sessionId = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    const fullPath = join(fixtureRoot, `${sessionId}.jsonl`)
    const ts = new Date(BASE_MS + spec.ageRank * 60_000 + n * 1000)
    const label = `${marker} ${spec.tag ?? 'plain'} topic-${tag}`
    const listing: SessionListing = {
      date: ts.toISOString(),
      value: idx,
      firstPrompt: label,
      customTitle: label,
      isSidechain: false,
      messages: [],
      created: ts,
      modified: ts,
      sessionId,
      fullPath,
      projectPath: fixtureRoot,
      tag: spec.tag,
    }
    return { marker, sessionId, fullPath, listing }
  })
  const sideListings: SessionListing[] = Array.from({ length: sidechains }, (_, j) => {
    const n = j + 1
    const tag = String(n).padStart(2, '0')
    const sessionId = `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`
    const ts = new Date(BASE_MS + (specs.length + n) * 60_000)
    const label = `[SIDE${tag}] hidden-sidechain`
    return {
      date: ts.toISOString(),
      value: primary.length + j,
      firstPrompt: label,
      customTitle: label,
      isSidechain: true,
      messages: [],
      created: ts,
      modified: ts,
      sessionId,
      fullPath: join(fixtureRoot, `${sessionId}.jsonl`),
      projectPath: fixtureRoot,
    }
  })
  const byMarker = new Map(primary.map(item => [item.marker, item]))
  return {
    primary,
    byMarker,
    listings: [...primary.map(item => item.listing), ...sideListings],
  }
}

function focusedMarkersOf(frame: string): { pointerLines: string[]; markers: string[] } {
  const pointerLines = frame.split('\n').filter(line => line.includes(POINTER))
  const markers: string[] = []
  for (const line of pointerLines) {
    const found = line.match(/\[S\d{2}\]/g)
    if (found) markers.push(...found)
  }
  return { pointerLines, markers }
}

const stdout = new FakeStdout(COLS, 28)
const stdin = new FakeStdin()
const ink = new Ink({
  stdout: stdout as never,
  stdin: stdin as never,
  stderr: new FakeStdout(COLS, 28) as never,
  exitOnCtrlC: false,
  patchConsole: false,
})
instances.set(stdout as never, ink)
ink.setAltScreenActive(true, false)

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

async function settleFrame(): Promise<string> {
  reconciler.flushSyncWork()
  await tick()
  reconciler.flushSyncWork()
  await tick()
  ink.onRender()
  return stripAnsi(ink.lastFrameText())
}

async function sendKey(seq: string): Promise<string> {
  stdin.push(seq)
  return settleFrame()
}

const realProcessExit = process.exit
let cancelExits: Array<number | string | null | undefined> = []
let exitTrapActive = false

process.exit = ((code?: number | string | null) => {
  if (exitTrapActive) {
    cancelExits.push(code)
    return undefined as never
  }
  return realProcessExit(code as never)
}) as typeof process.exit

let runSeq = 0

async function mountScenario(rows: number, listings: SessionListing[]): Promise<string> {
  activeLogs = listings
  resumedCalls = []
  cancelExits = []
  runSeq++
  ink.render(
    h(
      ThemeProvider,
      {},
      h(
        AppStateProvider,
        {},
        h(
          TerminalSizeContext.Provider,
          { value: { columns: COLS, rows } },
          h(
            KeybindingSetup,
            {},
            h(
              Box,
              { width: COLS, height: rows, flexDirection: 'column' },
              h(ResumeConversation, {
                key: `resume-run-${runSeq}`,
                commands: [],
                worktreePaths: [fixtureRoot],
                initialTools: [],
              }),
            ),
          ),
        ),
      ),
    ),
  )
  let frame = await settleFrame()
  for (let i = 0; i < 20 && frame.includes('Loading conversations'); i++) {
    frame = await settleFrame()
  }
  return frame
}

async function runScenario(scenario: Scenario): Promise<void> {
  const { primary, byMarker, listings } = buildSessions(scenario.sessions, scenario.sidechains)
  exitTrapActive = true
  try {
    let frame = await mountScenario(scenario.rows, listings)
    if (!frame.includes('Mercury · resume')) {
      throw new Error(`ResumeConversation did not paint chooser header:\n${frame}`)
    }
    const assertFrameInvariants = (phase: string, current: string): void => {
      if (/\[SIDE\d{2}\]/.test(current)) {
        throw new Error(`${phase}: sidechain session painted on ResumeConversation`)
      }
      if (resumedCalls.length > 0) {
        throw new Error(`${phase}: session resumed before Enter (${resumedCalls[0]!.sessionId})`)
      }
      if (cancelExits.length > 0) {
        throw new Error(`${phase}: chooser cancelled before Escape`)
      }
      const inSearch = current.includes('↵ to list')
      if (inSearch) {
        const { pointerLines } = focusedMarkersOf(current)
        if (pointerLines.length !== 0) {
          throw new Error(`${phase}: search mode painted ${pointerLines.length} list pointer(s):\n${current}`)
        }
      } else if (!current.includes('no sessions match')) {
        const { pointerLines, markers } = focusedMarkersOf(current)
        if (pointerLines.length !== 1 || markers.length !== 1) {
          throw new Error(
            `${phase}: expected 1 painted pointer row with 1 session marker, got ${pointerLines.length} lines / ${markers.length} markers:\n${current}`,
          )
        }
        if (!byMarker.has(markers[0]!)) {
          throw new Error(`${phase}: painted pointer marker ${markers[0]} is not in generated primary list`)
        }
      }
    }

    assertFrameInvariants('mount', frame)

    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i]!
      if (step.kind === 'nav') {
        if (frame.includes('↵ to list')) {
          frame = await sendKey(KEYS.enter)
        }
        frame = await sendKey(KEYS[step.key])
        assertFrameInvariants(`step[${i}]:${step.key}`, frame)
      } else {
        if (!frame.includes('↵ to list')) {
          frame = await sendKey('/')
        }
        for (const ch of step.query) {
          frame = await sendKey(ch)
        }
        if (step.clear) {
          frame = await sendKey(KEYS.esc)
          frame = await sendKey(KEYS.esc)
        } else {
          frame = await sendKey(KEYS.enter)
        }
        assertFrameInvariants(`step[${i}]:search(${step.query},${step.clear ? 'clear' : 'apply'})`, frame)
      }
    }

    if (frame.includes('↵ to list')) {
      frame = await sendKey(KEYS.enter)
      assertFrameInvariants('exit-search', frame)
    }

    if (scenario.ending === 'select') {
      if (frame.includes('no sessions match')) {
        await sendKey(KEYS.enter)
        if (resumedCalls.length !== 0 || cancelExits.length !== 0) {
          throw new Error(`Enter on empty filtered list triggered side effect (resumed=${resumedCalls.length}, cancelled=${cancelExits.length})`)
        }
        return
      }
      const { pointerLines, markers } = focusedMarkersOf(frame)
      if (pointerLines.length !== 1 || markers.length !== 1) {
        throw new Error(`before Enter: expected 1 painted focused row, got ${pointerLines.length}:\n${frame}`)
      }
      const marker = markers[0]!
      const expected = byMarker.get(marker)
      if (!expected) {
        throw new Error(`before Enter: painted marker ${marker} missing from generated sessions`)
      }
      if (!frame.includes(expected.marker)) {
        throw new Error(`before Enter: expected marker ${expected.marker} not visible in painted frame`)
      }
      await sendKey(KEYS.enter)
      if (cancelExits.length !== 0) {
        throw new Error(`Enter triggered cancellation instead of resume`)
      }
      if (resumedCalls.length !== 1) {
        throw new Error(`Enter produced ${resumedCalls.length} resume calls, expected 1 for ${expected.sessionId}`)
      }
      const got = resumedCalls[0]!
      if (got.sessionId !== expected.sessionId) {
        throw new Error(
          `wrong session resumed: painted row ${expected.marker} (${expected.sessionId}) != resumed (${got.sessionId}) [sessions=${primary.length}]`,
        )
      }
      if (got.fullPath !== expected.fullPath) {
        throw new Error(`wrong fullPath resumed: expected ${expected.fullPath}, got ${got.fullPath}`)
      }
    } else {
      await sendKey(KEYS.esc)
      if (resumedCalls.length !== 0) {
        throw new Error(`Escape triggered resume of ${resumedCalls[0]!.sessionId}`)
      }
      if (cancelExits.length !== 1 || cancelExits[0] !== 1) {
        throw new Error(`Escape cancel expected exit code [1], got ${JSON.stringify(cancelExits)}`)
      }
    }
  } finally {
    exitTrapActive = false
  }
}

const sessionSpecArb: fc.Arbitrary<SessionSpec> = fc.record({
  tag: fc.constantFrom(undefined, 'alpha' as const, 'beta' as const),
  ageRank: fc.integer({ min: 0, max: 30 }),
})

const navKeyArb = fc.constantFrom(
  'down' as const,
  'up' as const,
  'pgdn' as const,
  'pgup' as const,
  'home' as const,
  'end' as const,
  'tab' as const,
  'shiftTab' as const,
)

const stepArb: fc.Arbitrary<KeyStep> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('nav' as const), key: navKeyArb }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('search' as const),
      query: fc.constantFrom('alpha', 'beta', 's01', 's02', 'topic', 'zzz'),
      clear: fc.boolean(),
    }),
  },
)

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  sessions: fc.array(sessionSpecArb, { minLength: 1, maxLength: 16 }),
  sidechains: fc.integer({ min: 0, max: 2 }),
  rows: fc.constantFrom(18, 22, 26),
  steps: fc.array(stepArb, { minLength: 0, maxLength: 14 }),
  ending: fc.constantFrom('select' as const, 'cancel' as const),
})

const t = checker()
const SEED_SELECT = 20261121
const SEED_SEARCH_ESC = 20261122
const SEED_FAULT = 20261123

try {
  t.section('§1 — ResumeConversation: painted focused row matches resumed sessionId and Esc cancels cleanly')
  {
    const result = await fc.check(
      fc.asyncProperty(scenarioArb, async scenario => {
        await runScenario(scenario)
      }),
      { numRuns: 60, seed: SEED_SELECT },
    )
    t.check(
      `60 generated session/key scenarios held painted-row identity & cancel laws (seed ${SEED_SELECT})`,
      !result.failed,
      result.failed ? `path=${result.counterexamplePath} error=${String(result.errorInstance)}` : '',
    )
  }

  t.section('§2 — ResumeConversation: Esc in search mode clears query, exits search, then cancels on list')
  {
    const searchEscArb = fc.record({
      sessions: fc.array(sessionSpecArb, { minLength: 2, maxLength: 10 }),
      query: fc.stringMatching(/^[a-z0-9]{1,5}$/),
      rows: fc.constantFrom(18, 22),
    })
    const result = await fc.check(
      fc.asyncProperty(searchEscArb, async ({ sessions, query, rows }) => {
        const { listings } = buildSessions(sessions, 0)
        exitTrapActive = true
        try {
          let frame = await mountScenario(rows, listings)
          frame = await sendKey('/')
          for (const ch of query) frame = await sendKey(ch)
          if (!frame.includes('esc clear') || cancelExits.length !== 0 || resumedCalls.length !== 0) {
            throw new Error(`typing search '${query}' did not stay in search mode with esc clear`)
          }
          frame = await sendKey(KEYS.esc)
          if (!frame.includes('esc back') || cancelExits.length !== 0 || resumedCalls.length !== 0) {
            throw new Error(`first Esc did not clear query without cancelling`)
          }
          frame = await sendKey(KEYS.esc)
          if (!frame.includes('↵ resume') || cancelExits.length !== 0 || resumedCalls.length !== 0) {
            throw new Error(`second Esc did not return to list mode without cancelling`)
          }
          await sendKey(KEYS.esc)
          if (cancelExits.length !== 1 || cancelExits[0] !== 1 || resumedCalls.length !== 0) {
            throw new Error(`third Esc from list mode did not cancel cleanly: ${JSON.stringify(cancelExits)}`)
          }
        } finally {
          exitTrapActive = false
        }
      }),
      { numRuns: 25, seed: SEED_SEARCH_ESC },
    )
    t.check(
      `25 generated search-escape sequences respected clear -> back -> cancel staging (seed ${SEED_SEARCH_ESC})`,
      !result.failed,
      result.failed ? `path=${result.counterexamplePath} error=${String(result.errorInstance)}` : '',
    )

    const { listings } = buildSessions([{ ageRank: 1 }, { ageRank: 2 }], 0)
    exitTrapActive = true
    let emptyEscClosed = false
    let emptyEscDetail = ''
    try {
      let frame = await mountScenario(22, listings)
      frame = await sendKey('/')
      for (const ch of 'zzz') frame = await sendKey(ch)
      frame = await sendKey(KEYS.enter)
      const emptyShown = frame.includes('no sessions match') && frame.includes('esc close')
      await sendKey(KEYS.esc)
      emptyEscClosed = emptyShown && cancelExits.length === 1 && cancelExits[0] === 1 && resumedCalls.length === 0
      emptyEscDetail = `emptyShown=${emptyShown} cancelExits=${JSON.stringify(cancelExits)} resumed=${resumedCalls.length}`
    } finally {
      exitTrapActive = false
    }
    t.check(
      'Esc closes ResumeConversation when an applied filter leaves no sessions match',
      emptyEscClosed,
      emptyEscDetail,
    )
  }

  t.section('§3 — Wrong selection produces a shrunk replayable counterexample with seed and path')
  {
    const faultScenarioArb: fc.Arbitrary<Scenario> = fc.record({
      sessions: fc.array(sessionSpecArb, { minLength: 2, maxLength: 10 }),
      sidechains: fc.constant(0),
      rows: fc.constantFrom(18, 22),
      steps: fc.array(
        fc.record({
          kind: fc.constant('nav' as const),
          key: fc.constantFrom('down' as const, 'up' as const, 'pgdn' as const, 'end' as const),
        }),
        { minLength: 1, maxLength: 8 },
      ),
      ending: fc.constant('select' as const),
    })

    const faultyProp = fc.asyncProperty(faultScenarioArb, async scenario => {
      const { primary } = buildSessions(scenario.sessions, 0)
      const sorted = [...primary].sort((a, b) => b.listing.modified.getTime() - a.listing.modified.getTime())
      const topId = sorted[0]!.sessionId
      faultRewriteId = () => topId
      try {
        await runScenario(scenario)
      } finally {
        faultRewriteId = null
      }
    })

    const caught = await fc.check(faultyProp, { numRuns: 40, seed: SEED_FAULT })
    const shrinkPath = caught.counterexamplePath ?? ''
    t.check(
      `fault-injected wrong selection failed with seed ${SEED_FAULT} and shrink path`,
      caught.failed && caught.seed === SEED_FAULT && shrinkPath.length > 0,
      `failed=${caught.failed} path=${shrinkPath}`,
    )

    const minimized = caught.counterexample?.[0]
    t.check(
      'shrunk counterexample is short (<= 3 sessions, <= 3 steps)',
      minimized !== undefined && minimized.sessions.length <= 3 && minimized.steps.length <= 3,
      minimized ? `sessions=${minimized.sessions.length} steps=${minimized.steps.length} shrinks=${caught.numShrinks}` : 'no counterexample',
    )

    const replay = await fc.check(faultyProp, {
      seed: caught.seed,
      path: shrinkPath,
      endOnFailure: true,
    })
    t.check(
      `replaying seed=${caught.seed} path=${shrinkPath} reproduced identical counterexample`,
      replay.failed &&
        JSON.stringify(replay.counterexample) === JSON.stringify(caught.counterexample) &&
        String(replay.errorInstance).includes('wrong session resumed:'),
      `replay.failed=${replay.failed} err=${String(replay.errorInstance).slice(0, 140)}`,
    )

    const cleanReplay = await fc.check(
      fc.asyncProperty(faultScenarioArb, async scenario => {
        await runScenario(scenario)
      }),
      { seed: caught.seed, path: shrinkPath, endOnFailure: true },
    )
    t.check(
      `unmodified ResumeConversation passed exact counterexample replay (seed=${caught.seed} path=${shrinkPath})`,
      !cleanReplay.failed,
      cleanReplay.failed ? String(cleanReplay.errorInstance) : '',
    )
  }
} finally {
  faultRewriteId = null
  exitTrapActive = false
  process.exit = realProcessExit
  ink.unmount()
  instances.delete(stdout as never)
  disposeKeybindingWatcher()
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}

t.finish('screen-properties')
