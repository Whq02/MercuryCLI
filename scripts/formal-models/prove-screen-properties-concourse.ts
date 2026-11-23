#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import stripAnsi from 'strip-ansi'
import { checker } from '../engine-durability/harness.ts'

const previousCwd = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'mercury-screen-concourse-'))
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

const React = await import('react')
const h = React.createElement

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { recordCapacityDecision } = await import('../../src/daemon/switchboard-capacity/capacityCheck.ts')
await recordCapacityDecision(false)

const { default: ScreenInstance } = await import('../../src/screen/renderer/screenInstance.js')
const { default: instances } = await import('../../src/screen/renderer/instances.js')
const { default: reconciler } = await import('../../src/screen/renderer/reconciler.js')
const { disposeKeybindingWatcher } = await import('../../src/screen/keys/loadUserBindings.js')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { TerminalSizeContext } = await import('../../src/screen/renderer/elements/TerminalSizeContext.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { useRegisterOverlay } = await import('../../src/screen/overlays/overlayHooks.tsx')
const { useElevatedSurface } = await import('../../src/screen/widgets/useElevatedSurface.ts')
const { ConcourseScreen, _resetConcourseCapsuleForTesting } = await import('../../src/screen/concourse/ConcourseScreen.tsx')

function ConcourseHost({
  snapshot,
  callbacks,
}: {
  snapshot: import('../../src/screen/concourse/contracts.ts').ConcourseSnapshotV1
  callbacks: import('../../src/screen/concourse/contracts.ts').ConcourseCallbacks
}): React.ReactNode {
  const elevatedRef = useElevatedSurface()
  useRegisterOverlay('surface:concourse', true, { ownsPageKeys: true })
  return h(
    Box,
    { ref: elevatedRef, width: COLS, height: ROWS, flexDirection: 'column' },
    h(ConcourseScreen, { snapshot, callbacks }),
  )
}

type ConcourseCallbacks = import('../../src/screen/concourse/contracts.ts').ConcourseCallbacks
type ConcourseRowV1 = import('../../src/screen/concourse/contracts.ts').ConcourseRowV1
type ConcourseSnapshotV1 = import('../../src/screen/concourse/contracts.ts').ConcourseSnapshotV1

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
  enter: '\x1b[13u',
  esc: '\x1b[27u',
} as const

type RowSpec = {
  group: 'working' | 'ready-to-review' | 'parked'
  project: 'alpha' | 'beta'
}

type KeyStep =
  | { kind: 'nav'; key: 'down' | 'up' }
  | { kind: 'filter'; query: string; clear: boolean }

type Scenario = {
  sessions: RowSpec[]
  steps: KeyStep[]
  ending: 'enter' | 'esc-leave'
}

type BuiltRow = {
  marker: string
  sessionId: string
  title: string
  projectLabel: string
  state: RowSpec['group']
  row: ConcourseRowV1
}

const COLS = 136
const ROWS = 34

function buildSnapshot(specs: readonly RowSpec[]): {
  rows: BuiltRow[]
  byMarker: Map<string, BuiltRow>
  snapshot: ConcourseSnapshotV1
} {
  const rows: BuiltRow[] = specs.map((spec, idx) => {
    const n = idx + 1
    const tag = String(n).padStart(2, '0')
    const marker = `[C${tag}]`
    const sessionId = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    const title = `${marker} task-${tag}`
    const row: ConcourseRowV1 = {
      sessionId,
      title,
      state: spec.group,
      projectLabel: spec.project,
      ownerLabel: 'Mercury',
      ageLabel: `${n}m`,
      seats: spec.group === 'parked' ? null : { held: 1, ceiling: 4 },
      nowLabel: spec.group === 'working' ? 'running checks' : null,
    }
    return { marker, sessionId, title, projectLabel: spec.project, state: spec.group, row }
  })

  const groupOrder: Array<{ id: 'working' | 'ready-to-review' | 'parked'; label: string }> = [
    { id: 'working', label: 'WORKING' },
    { id: 'ready-to-review', label: 'READY TO REVIEW' },
    { id: 'parked', label: 'PARKED' },
  ]
  const groups = groupOrder
    .map(g => ({
      id: g.id,
      label: g.label,
      rows: rows.filter(r => r.state === g.id).map(r => r.row),
    }))
    .filter(g => g.rows.length > 0)

  const orderedRows = groups.flatMap(g => g.rows.map(r => rows.find(x => x.sessionId === r.sessionId)!))
  const byMarker = new Map(orderedRows.map(r => [r.marker, r]))
  const workingCount = orderedRows.filter(r => r.state === 'working').length
  const liveCount = orderedRows.filter(r => r.state !== 'parked').length

  const snapshot: ConcourseSnapshotV1 = {
    schema: 1,
    revision: 1,
    clock: '12:00',
    context: { projectLabel: 'project', operatorHandle: 'operator' },
    breadcrumb: { active: 'concourse' },
    focusedChat: {
      kind: 'non-model-controller',
      counted: false,
      submission: 'disabled-while-parked',
      reachedBy: 'esc',
    },
    counts: {
      live: liveCount,
      needsYou: 0,
      working: workingCount,
      queued: 0,
      seatsDenominator: 4,
      admission: 'auto-balanced',
    },
    needsYou: [],
    groups,
    peek: orderedRows[0]
      ? {
          sessionId: orderedRows[0].sessionId,
          title: orderedRows[0].title,
          state: orderedRows[0].state,
          projectLabel: orderedRows[0].projectLabel,
          agentLabel: 'Mercury',
          modelLabel: 'fixture-model',
          seats: orderedRows[0].row.seats === 'waits' ? null : orderedRows[0].row.seats,
          timeline: [],
          scope: { kind: 'clear' },
          actions: ['enter-full-session'],
          residentState: 'settled',
        }
      : null,
    newSession: {
      seeds: {
        projectLabel: 'project',
        agentLabel: 'Mercury',
        modelLabel: 'fixture-model',
        modelId: 'fixture-model',
        modelIsDefault: true,
        effortLevel: 'high',
        effortIsDefault: true,
        isolation: 'isolated-worktree',
        seatsMax: 2,
      },
      draft: '',
    },
  }
  return { rows: orderedRows, byMarker, snapshot }
}

function focusedMarkers(frame: string): string[] {
  const out: string[] = []
  for (const line of frame.split('\n')) {
    if (!line.includes('▸')) continue
    const found = line.match(/\[C\d{2}\]/g)
    if (found) out.push(...found)
  }
  return out
}

const stdout = new FakeStdout(COLS, ROWS)
const stdin = new FakeStdin()
const ink = new ScreenInstance({
  stdout: stdout as never,
  stdin: stdin as never,
  stderr: new FakeStdout(COLS, ROWS) as never,
  exitOnCtrlC: false,
  patchConsole: false,
})
instances.set(stdout as never, ink)
ink.setAltScreenActive(true, true)

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

let runSeq = 0
let enteredCalls: string[] = []
let exitCalls = 0
const readExitCalls = (): number => exitCalls
let faultRewriteEnter: ((id: string) => string) | null = null

async function mountConcourse(snapshot: ConcourseSnapshotV1): Promise<string> {
  _resetConcourseCapsuleForTesting()
  enteredCalls = []
  exitCalls = 0
  runSeq++
  const callbacks: ConcourseCallbacks = {
    enterSession: sessionId => {
      enteredCalls.push(faultRewriteEnter ? faultRewriteEnter(sessionId) : sessionId)
    },
    peekSession: () => {},
    answerObligation: () => {},
    openObligation: () => {},
    claimObligation: () => {},
    withdrawObligation: () => {},
    pauseAfterTurn: () => {},
    resumeSession: () => {},
    redirectSession: () => {},
    startSessionDraft: () => {},
    setDraftSeed: () => {},
    submitSessionDraft: () => {},
    enterBootSettings: () => true,
    exitToChat: () => {
      exitCalls++
    },
  }
  ink.render(
    h(
      ThemeProvider as never,
      {},
      h(
        AppStateProvider as never,
        {},
        h(
          TerminalSizeContext.Provider,
          { value: { columns: COLS, rows: ROWS } },
          h(
            KeybindingSetup as never,
            {},
            h(
              ConcourseHost,
              {
                key: `concourse-run-${runSeq}`,
                snapshot,
                callbacks,
              },
            ),
          ),
        ),
      ),
    ),
  )
  return settleFrame()
}

async function runScenario(scenario: Scenario): Promise<void> {
  const { rows, byMarker, snapshot } = buildSnapshot(scenario.sessions)
  let frame = await mountConcourse(snapshot)
  let activeFilter = ''

  const matchingRows = (): BuiltRow[] => {
    const q = activeFilter.trim().toLowerCase()
    if (q.length === 0) return rows
    return rows.filter(r => r.title.toLowerCase().includes(q) || r.projectLabel.toLowerCase().includes(q))
  }

  const assertBoardFrame = (phase: string, current: string): BuiltRow | null => {
    if (enteredCalls.length > 0) {
      throw new Error(`${phase}: entered session before Enter (${enteredCalls[0]})`)
    }
    if (readExitCalls() > 0) {
      throw new Error(`${phase}: exited concourse before Esc`)
    }
    const allowed = new Set(matchingRows().map(r => r.marker))
    for (const line of current.split('\n')) {
      if (!line.includes('▸')) continue
      const found = line.match(/\[C\d{2}\]/g) ?? []
      for (const m of found) {
        if (!allowed.has(m)) {
          throw new Error(`${phase}: highlighted marker ${m} does not match filter "${activeFilter}" (allowed=${[...allowed].join(',')})`)
        }
      }
    }
    if (allowed.size === 0) {
      const focused = focusedMarkers(current)
      if (focused.length !== 0) {
        throw new Error(`${phase}: empty filter painted highlighted marker ${JSON.stringify(focused)}:\n${current}`)
      }
      return null
    }
    const focused = focusedMarkers(current)
    if (focused.length !== 1) {
      throw new Error(`${phase}: expected 1 highlighted concourse row, got ${JSON.stringify(focused)}:\n${current}`)
    }
    const target = byMarker.get(focused[0]!)
    if (!target || !allowed.has(target.marker)) {
      throw new Error(`${phase}: highlighted marker ${focused[0]} invalid for filter "${activeFilter}"`)
    }
    return target
  }

  let focused = assertBoardFrame('mount', frame)

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i]!
    if (step.kind === 'nav') {
      frame = await sendKey(KEYS[step.key])
      focused = assertBoardFrame(`step[${i}]:${step.key}`, frame)
    } else {
      frame = await sendKey('/')
      for (const ch of step.query) frame = await sendKey(ch)
      if (step.clear) {
        frame = await sendKey(KEYS.esc)
        activeFilter = ''
      } else {
        frame = await sendKey(KEYS.enter)
        activeFilter = `${activeFilter}${step.query}`
      }
      focused = assertBoardFrame(`step[${i}]:filter(${step.query},${step.clear ? 'clear' : 'apply'})`, frame)
    }
  }

  if (scenario.ending === 'esc-leave') {
    if (activeFilter !== '') {
      frame = await sendKey(KEYS.esc)
      activeFilter = ''
      if (readExitCalls() !== 0) {
        throw new Error(`Esc with active filter exited concourse instead of clearing filter`)
      }
      assertBoardFrame('after-esc-clear-filter', frame)
    }
    await sendKey(KEYS.esc)
    if (enteredCalls.length !== 0) {
      throw new Error(`Esc triggered enterSession(${enteredCalls[0]})`)
    }
    if (readExitCalls() !== 1) {
      throw new Error(`Esc on concourse expected exitCalls=1, got ${readExitCalls()}`)
    }
    return
  }

  if (focused === null) {
    await sendKey(KEYS.enter)
    if (enteredCalls.length !== 0 || readExitCalls() !== 0) {
      throw new Error(`Enter on empty filtered concourse triggered side effect (entered=${enteredCalls.length}, exits=${readExitCalls()})`)
    }
    frame = await sendKey(KEYS.esc)
    activeFilter = ''
    assertBoardFrame('empty-filter-esc-clear', frame)
    await sendKey(KEYS.esc)
    if (readExitCalls() !== 1) {
      throw new Error(`Esc after clearing empty filter expected exitCalls=1, got ${readExitCalls()}`)
    }
    return
  }

  frame = await sendKey(KEYS.enter)
  if (focused.state !== 'parked' && enteredCalls.length === 0) {
    frame = await sendKey(KEYS.enter)
  }
  if (readExitCalls() !== 0) {
    throw new Error(`Enter on ${focused.marker} triggered exitToChat instead of enterSession`)
  }
  if (enteredCalls.length !== 1) {
    throw new Error(`Enter on ${focused.marker} produced ${enteredCalls.length} enterSession calls, expected 1`)
  }
  if (enteredCalls[0] !== focused.sessionId) {
    throw new Error(
      `wrong concourse session entered: painted row ${focused.marker} (${focused.sessionId}) != entered (${enteredCalls[0]}) [sessions=${rows.length}]`,
    )
  }
}

const rowSpecArb: fc.Arbitrary<RowSpec> = fc.record({
  group: fc.constantFrom('working' as const, 'ready-to-review' as const, 'parked' as const),
  project: fc.constantFrom('alpha' as const, 'beta' as const),
})

const stepArb: fc.Arbitrary<KeyStep> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('nav' as const), key: fc.constantFrom('down' as const, 'up' as const) }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('filter' as const),
      query: fc.constantFrom('alpha', 'beta', 'c01', 'c02', 'zzz'),
      clear: fc.boolean(),
    }),
  },
)

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  sessions: fc.array(rowSpecArb, { minLength: 1, maxLength: 10 }),
  steps: fc.array(stepArb, { minLength: 0, maxLength: 10 }),
  ending: fc.constantFrom('enter' as const, 'esc-leave' as const),
})

const t = checker()
const SEED_MAIN = 20261151
const SEED_EMPTY_FILTER = 20261152
const SEED_FAULT = 20261153

try {
  t.section('§1 — ConcourseScreen: filtered rows match data, highlighted row is what Enter opens, Esc leaves')
  {
    const result = await fc.check(
      fc.asyncProperty(scenarioArb, async scenario => {
        await runScenario(scenario)
      }),
      { numRuns: 50, seed: SEED_MAIN },
    )
    t.check(
      `50 generated concourse scenarios held row-data, Enter-target, and Esc-leave laws (seed ${SEED_MAIN})`,
      !result.failed,
      result.failed ? `path=${result.counterexamplePath} error=${String(result.errorInstance)}` : '',
    )
  }

  t.section('§2 — ConcourseScreen: an applied filter matching nothing stays safe on Enter and leaves on Esc')
  {
    const emptyFilterArb = fc.record({
      sessions: fc.array(rowSpecArb, { minLength: 1, maxLength: 8 }),
      query: fc.constantFrom('zzz', 'nomatch', 'qqq9'),
    })
    const result = await fc.check(
      fc.asyncProperty(emptyFilterArb, async ({ sessions, query }) => {
        const { snapshot } = buildSnapshot(sessions)
        let frame = await mountConcourse(snapshot)
        frame = await sendKey('/')
        for (const ch of query) frame = await sendKey(ch)
        frame = await sendKey(KEYS.enter)
        if (focusedMarkers(frame).length !== 0) {
          throw new Error(`non-matching filter "${query}" left highlighted marker painted:\n${frame}`)
        }
        await sendKey(KEYS.enter)
        if (enteredCalls.length !== 0 || readExitCalls() !== 0) {
          throw new Error(`Enter on empty filter "${query}" triggered side effect`)
        }
        frame = await sendKey(KEYS.esc)
        if (readExitCalls() !== 0 || focusedMarkers(frame).length !== 1) {
          throw new Error(`first Esc on empty filter "${query}" did not clear filter and restore focus:\n${frame}`)
        }
        await sendKey(KEYS.esc)
        if (readExitCalls() !== 1 || enteredCalls.length !== 0) {
          throw new Error(`second Esc after empty filter "${query}" did not leave concourse (exits=${readExitCalls()})`)
        }
      }),
      { numRuns: 25, seed: SEED_EMPTY_FILTER },
    )
    t.check(
      `25 generated empty-filter scenarios stayed safe on Enter and left cleanly on Esc (seed ${SEED_EMPTY_FILTER})`,
      !result.failed,
      result.failed ? `path=${result.counterexamplePath} error=${String(result.errorInstance)}` : '',
    )
  }

  t.section('§3 — Fault replay: wrong Enter sessionId shrinks and replays identically with seed and path')
  {
    const faultArb: fc.Arbitrary<Scenario> = fc.record({
      sessions: fc.array(rowSpecArb, { minLength: 2, maxLength: 8 }),
      steps: fc.array(
        fc.record({ kind: fc.constant('nav' as const), key: fc.constantFrom('down' as const, 'up' as const) }),
        { minLength: 1, maxLength: 6 },
      ),
      ending: fc.constant('enter' as const),
    })
    const faultyProp = fc.asyncProperty(faultArb, async scenario => {
      const { rows } = buildSnapshot(scenario.sessions)
      const firstId = rows[0]!.sessionId
      faultRewriteEnter = () => firstId
      try {
        await runScenario(scenario)
      } finally {
        faultRewriteEnter = null
      }
    })
    const caught = await fc.check(faultyProp, { numRuns: 30, seed: SEED_FAULT })
    const shrinkPath = caught.counterexamplePath ?? ''
    t.check(
      `fault-injected wrong concourse session failed with seed ${SEED_FAULT} and shrink path`,
      caught.failed && caught.seed === SEED_FAULT && shrinkPath.length > 0,
      `failed=${caught.failed} path=${shrinkPath}`,
    )
    const minimized = caught.counterexample?.[0]
    t.check(
      'shrunk counterexample is short (<= 3 sessions, <= 3 steps)',
      minimized !== undefined && minimized.sessions.length <= 3 && minimized.steps.length <= 3,
      minimized ? `sessions=${minimized.sessions.length} steps=${minimized.steps.length} shrinks=${caught.numShrinks}` : 'none',
    )
    const replay = await fc.check(faultyProp, { seed: caught.seed, path: shrinkPath, endOnFailure: true })
    t.check(
      `replaying seed=${caught.seed} path=${shrinkPath} reproduced identical counterexample`,
      replay.failed &&
        JSON.stringify(replay.counterexample) === JSON.stringify(caught.counterexample) &&
        String(replay.errorInstance).includes('wrong concourse session entered:'),
      `replay.failed=${replay.failed} err=${String(replay.errorInstance).slice(0, 140)}`,
    )
    const cleanReplay = await fc.check(
      fc.asyncProperty(faultArb, async scenario => {
        await runScenario(scenario)
      }),
      { seed: caught.seed, path: shrinkPath, endOnFailure: true },
    )
    t.check(
      `unmodified ConcourseScreen passed exact counterexample replay (seed=${caught.seed} path=${shrinkPath})`,
      !cleanReplay.failed,
      cleanReplay.failed ? String(cleanReplay.errorInstance) : '',
    )
  }
} finally {
  faultRewriteEnter = null
  _resetConcourseCapsuleForTesting()
  ink.unmount()
  instances.delete(stdout as never)
  disposeKeybindingWatcher()
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}

t.finish('screen-properties-concourse')
