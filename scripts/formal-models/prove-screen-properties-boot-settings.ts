#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import stripAnsi from 'strip-ansi'
import { checker } from '../engine-durability/harness.ts'

const previousCwd = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'mercury-screen-boot-'))
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

type BootCardFacts = ReturnType<typeof import('../../src/screen/boot-face/bootCardFacts.ts').scanBootCardFacts>

let activeFacts: BootCardFacts = {
  cwdProject: null,
  recentLast: null,
  projects: [],
  recentProjects: [],
  totalSessions: 0,
  totalProjects: 0,
}
let bornCalls: Array<{ workspaceDir?: string }> = []
let resumedCalls: Array<{ sessionId: string; fullPath?: string }> = []
let faultForceNew = false

const realBootFacts = await import('../../src/screen/boot-face/bootCardFacts.ts')
mock.module('../../src/screen/boot-face/bootCardFacts.ts', () => ({
  ...realBootFacts,
  scanBootCardFacts: () => activeFacts,
}))

const realBorn = await import('../../src/daemon/switchboard/bornSession.ts')
mock.module('../../src/daemon/switchboard/bornSession.ts', () => ({
  ...realBorn,
  bornSession: async (opts: { workspaceDir?: string } = {}) => {
    bornCalls.push(opts)
    return { ok: true as const, sessionId: '00000000-0000-4000-8000-000000000001' }
  },
}))

const realHop = await import('../../src/daemon/switchboard/hopIntoSession.ts')
mock.module('../../src/daemon/switchboard/hopIntoSession.ts', () => ({
  ...realHop,
  focusResumedSession: async (sessionId: string, fullPath?: string) => {
    if (faultForceNew) {
      bornCalls.push({ workspaceDir: fixtureRoot })
      return { ok: true as const }
    }
    resumedCalls.push({ sessionId, fullPath })
    return { ok: true as const }
  },
}))

const realWorkers = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
mock.module('../../src/daemon/concourse-workers/concourseWorkers.ts', () => ({
  ...realWorkers,
  countLiveConcourseWorkers: () => 0,
}))

const realActivity = await import('../../src/screen/concourse-model/projectActivity.ts')
mock.module('../../src/screen/concourse-model/projectActivity.ts', () => ({
  ...realActivity,
  runningByProjectKey: async () => new Map<string, number>(),
}))

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()

const surfaceRoute = await import('../../src/screen/routes/surfaceRoute.ts')
const { default: ScreenInstance } = await import('../../src/screen/renderer/screenInstance.js')
const { default: instances } = await import('../../src/screen/renderer/instances.js')
const { default: reconciler } = await import('../../src/screen/renderer/reconciler.js')
const { disposeKeybindingWatcher } = await import('../../src/screen/keys/loadUserBindings.js')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { TerminalSizeContext } = await import('../../src/screen/renderer/elements/TerminalSizeContext.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { BootSplashScreen } = await import('../../src/screen/boot-face/BootSplashScreen.tsx')

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
  home: '\x1b[H',
  end: '\x1b[F',
  enter: '\x1b[13u',
  esc: '\x1b[27u',
} as const

type HistoryMode = 'none' | 'cwd' | 'cross'
type NavKey = 'down' | 'up' | 'home' | 'end'

type Scenario = {
  history: HistoryMode
  concourseLive: boolean
  compact: boolean
  steps: NavKey[]
  ending: 'enter' | 'esc-leave' | 'esc-clear-then-enter'
}

const ROW_LABELS = [
  'New Session',
  'Continue Last Session',
  'Logins/Keys',
  'Session Manager (Concourse)',
  'Boot Menu',
] as const

type RowLabel = (typeof ROW_LABELS)[number]

function buildFacts(mode: HistoryMode): { facts: BootCardFacts; expectedSessionId: string | null } {
  if (mode === 'none') {
    return {
      facts: {
        cwdProject: null,
        recentLast: null,
        projects: [],
        recentProjects: [],
        totalSessions: 0,
        totalProjects: 0,
      },
      expectedSessionId: null,
    }
  }
  const sessionId = '00000000-0000-4000-8000-000000000042'
  const transcriptPath = join(fixtureRoot, `${sessionId}.jsonl`)
  const proj = {
    dir: mode === 'cwd' ? fixtureRoot : join(scratch, 'other-repo'),
    base: mode === 'cwd' ? 'project' : 'other-repo',
    sessionId,
    firstSessionId: sessionId,
    transcriptPath,
    sessionCount: 1,
    ageMs: 120_000,
    mtimeMs: Date.now() - 120_000,
  }
  if (mode === 'cwd') {
    return {
      facts: {
        cwdProject: proj,
        recentLast: proj,
        projects: [proj],
        recentProjects: [proj],
        totalSessions: 1,
        totalProjects: 1,
      },
      expectedSessionId: sessionId,
    }
  }
  return {
    facts: {
      cwdProject: null,
      recentLast: proj,
      projects: [proj],
      recentProjects: [proj],
      totalSessions: 1,
      totalProjects: 1,
    },
    expectedSessionId: sessionId,
  }
}

function focusedRowLabels(frame: string): RowLabel[] {
  const found: RowLabel[] = []
  for (const line of frame.split('\n')) {
    if (!line.includes('❯')) continue
    for (const label of ROW_LABELS) {
      if (line.includes(label)) found.push(label)
    }
  }
  return found
}

const stdout = new FakeStdout(120, 34)
const stdin = new FakeStdin()
const ink = new ScreenInstance({
  stdout: stdout as never,
  stdin: stdin as never,
  stderr: new FakeStdout(120, 34) as never,
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

let runSeq = 0

async function mountBootFace(scenario: Pick<Scenario, 'history' | 'concourseLive' | 'compact'>): Promise<{
  frame: string
  expectedSessionId: string | null
  expectedRows: RowLabel[]
  disabledRows: Set<RowLabel>
}> {
  const { facts, expectedSessionId } = buildFacts(scenario.history)
  activeFacts = facts
  bornCalls = []
  resumedCalls = []
  surfaceRoute._resetSurfaceRouteForTesting()
  surfaceRoute.registerChatPresence({ present: () => true, subscribe: () => () => {} })
  surfaceRoute.registerRouteSurface('boot-settings', { render: () => null })
  if (scenario.concourseLive) {
    surfaceRoute.registerRouteSurface('concourse', { render: () => null })
  }
  surfaceRoute.initializeSurfaceRoute({ kind: 'boot-settings' })

  const cols = scenario.compact ? 84 : 120
  const rows = scenario.compact ? 24 : 34
  stdout.columns = cols
  stdout.rows = rows
  runSeq++
  ink.render(
    h(
      ThemeProvider as never,
      {},
      h(
        AppStateProvider as never,
        {},
        h(
          TerminalSizeContext.Provider,
          { value: { columns: cols, rows } },
          h(
            KeybindingSetup as never,
            {},
            h(
              Box,
              { width: cols, height: rows, flexDirection: 'column' },
              h(BootSplashScreen, { key: `boot-run-${runSeq}` }),
            ),
          ),
        ),
      ),
    ),
  )
  const frame = await settleFrame()
  const expectedRows: RowLabel[] =
    scenario.history === 'none'
      ? ['New Session', 'Logins/Keys', 'Session Manager (Concourse)', 'Boot Menu']
      : ['New Session', 'Continue Last Session', 'Logins/Keys', 'Session Manager (Concourse)', 'Boot Menu']
  const disabledRows = new Set<RowLabel>()
  if (!scenario.concourseLive) disabledRows.add('Session Manager (Concourse)')
  return { frame, expectedSessionId, expectedRows, disabledRows }
}

async function runScenario(
  scenario: Scenario,
  faultMisroute?: (label: RowLabel) => RowLabel,
): Promise<void> {
  const { frame: initial, expectedSessionId, expectedRows, disabledRows } = await mountBootFace(scenario)
  let frame = initial

  const assertBootFrame = (phase: string, current: string): RowLabel => {
    if (surfaceRoute.currentSurfaceRoute().kind !== 'boot-settings') {
      throw new Error(`${phase}: left boot-settings early (route=${surfaceRoute.currentSurfaceRoute().kind})`)
    }
    if (bornCalls.length > 0 || resumedCalls.length > 0) {
      throw new Error(`${phase}: launched session before Enter (born=${bornCalls.length}, resumed=${resumedCalls.length})`)
    }
    for (const label of expectedRows) {
      if (!current.includes(label)) {
        throw new Error(`${phase}: expected boot row "${label}" missing from frame:\n${current}`)
      }
    }
    if (scenario.history === 'none' && current.includes('Continue Last Session')) {
      throw new Error(`${phase}: painted Continue Last Session with no history:\n${current}`)
    }
    const focused = focusedRowLabels(current)
    if (focused.length !== 1) {
      throw new Error(`${phase}: expected 1 focused boot row, got ${JSON.stringify(focused)}:\n${current}`)
    }
    if (disabledRows.has(focused[0]!)) {
      throw new Error(`${phase}: disabled boot row "${focused[0]}" was focused`)
    }
    return focused[0]!
  }

  let focused = assertBootFrame('mount', frame)
  for (let i = 0; i < scenario.steps.length; i++) {
    frame = await sendKey(KEYS[scenario.steps[i]!])
    focused = assertBootFrame(`step[${i}]:${scenario.steps[i]}`, frame)
  }

  if (scenario.ending === 'esc-leave') {
    frame = await sendKey(KEYS.esc)
    if (surfaceRoute.currentSurfaceRoute().kind !== 'boot-settings') {
      throw new Error(`first Esc left boot-settings instead of clearing highlight`)
    }
    if (focusedRowLabels(frame).length !== 0) {
      throw new Error(`first Esc did not clear painted pointer:\n${frame}`)
    }
    await sendKey(KEYS.esc)
    if (surfaceRoute.currentSurfaceRoute().kind !== 'repl') {
      throw new Error(`second Esc did not leave boot-settings to repl (got ${surfaceRoute.currentSurfaceRoute().kind})`)
    }
    return
  }

  if (scenario.ending === 'esc-clear-then-enter') {
    frame = await sendKey(KEYS.esc)
    if (focusedRowLabels(frame).length !== 0) {
      throw new Error(`Esc did not clear highlight before Enter`)
    }
    await sendKey(KEYS.enter)
    await settleFrame()
    if (bornCalls.length !== 1 || surfaceRoute.currentSurfaceRoute().kind !== 'repl') {
      throw new Error(`Enter after Esc-clear must start New Session (born=${bornCalls.length}, route=${surfaceRoute.currentSurfaceRoute().kind})`)
    }
    return
  }

  const expected = faultMisroute ? faultMisroute(focused) : focused
  frame = await sendKey(KEYS.enter)
  await settleFrame()

  if (expected === 'New Session') {
    if (bornCalls.length !== 1 || surfaceRoute.currentSurfaceRoute().kind !== 'repl') {
      throw new Error(`wrong boot action on Enter: expected New Session (born=1, route=repl), got born=${bornCalls.length} resumed=${resumedCalls.length} route=${surfaceRoute.currentSurfaceRoute().kind}`)
    }
  } else if (expected === 'Continue Last Session') {
    if (resumedCalls.length !== 1 || resumedCalls[0]!.sessionId !== expectedSessionId || surfaceRoute.currentSurfaceRoute().kind !== 'repl') {
      throw new Error(`wrong boot action on Enter: expected Continue Last Session (${expectedSessionId}), got born=${bornCalls.length} resumed=${JSON.stringify(resumedCalls)} route=${surfaceRoute.currentSurfaceRoute().kind}`)
    }
  } else if (expected === 'Session Manager (Concourse)') {
    if (surfaceRoute.currentSurfaceRoute().kind !== 'concourse') {
      throw new Error(`wrong boot action on Enter: expected route=concourse, got ${surfaceRoute.currentSurfaceRoute().kind}`)
    }
  } else if (expected === 'Logins/Keys') {
    if (!frame.includes('logins') && !frame.includes('LOGINS')) {
      throw new Error(`wrong boot action on Enter: expected BootLoginsScreen, got:\n${frame}`)
    }
    frame = await sendKey(KEYS.esc)
    assertBootFrame('after-logins-esc', frame)
  } else if (expected === 'Boot Menu') {
    if (!frame.includes('BOOT') && !frame.includes('boot')) {
      throw new Error(`wrong boot action on Enter: expected BootSettingsScreen, got:\n${frame}`)
    }
    frame = await sendKey(KEYS.esc)
    assertBootFrame('after-boot-menu-esc', frame)
  }
}

const navKeyArb: fc.Arbitrary<NavKey> = fc.constantFrom('down', 'up', 'home', 'end')
const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  history: fc.constantFrom('none' as const, 'cwd' as const, 'cross' as const),
  concourseLive: fc.boolean(),
  compact: fc.boolean(),
  steps: fc.array(navKeyArb, { minLength: 0, maxLength: 10 }),
  ending: fc.constantFrom('enter' as const, 'esc-leave' as const, 'esc-clear-then-enter' as const),
})

const t = checker()
const SEED_MAIN = 20261141
const SEED_FAULT = 20261142

try {
  t.section('§1 — BootSplashScreen (boot-settings): 4/5-row data parity, disabled-row skip, Enter target, Esc leave')
  {
    const result = await fc.check(
      fc.asyncProperty(scenarioArb, async scenario => {
        await runScenario(scenario)
      }),
      { numRuns: 50, seed: SEED_MAIN },
    )
    t.check(
      `50 generated boot-settings scenarios held row-data, disabled-skip, Enter-target, and Esc-leave laws (seed ${SEED_MAIN})`,
      !result.failed,
      result.failed ? `path=${result.counterexamplePath} error=${String(result.errorInstance)}` : '',
    )
  }

  t.section('§2 — Fault replay: Enter misrouting shrinks and replays identically with seed and path')
  {
    const faultArb: fc.Arbitrary<Scenario> = fc.record({
      history: fc.constant('cwd' as const),
      concourseLive: fc.constant(true),
      compact: fc.constant(false),
      steps: fc.array(fc.constantFrom('down' as const, 'up' as const), { minLength: 1, maxLength: 6 }),
      ending: fc.constant('enter' as const),
    })
    const faultyProp = fc.asyncProperty(faultArb, async scenario => {
      faultForceNew = true
      try {
        await runScenario(scenario)
      } finally {
        faultForceNew = false
      }
    })
    const caught = await fc.check(faultyProp, { numRuns: 30, seed: SEED_FAULT })
    const shrinkPath = caught.counterexamplePath ?? ''
    t.check(
      `fault-injected boot misroute failed with seed ${SEED_FAULT} and shrink path`,
      caught.failed && caught.seed === SEED_FAULT && shrinkPath.length > 0,
      `failed=${caught.failed} path=${shrinkPath}`,
    )
    const minimized = caught.counterexample?.[0]
    t.check(
      'shrunk counterexample is short (<= 2 steps)',
      minimized !== undefined && minimized.steps.length <= 2,
      minimized ? `steps=${minimized.steps.length} shrinks=${caught.numShrinks}` : 'none',
    )
    const replay = await fc.check(faultyProp, { seed: caught.seed, path: shrinkPath, endOnFailure: true })
    t.check(
      `replaying seed=${caught.seed} path=${shrinkPath} reproduced identical counterexample`,
      replay.failed &&
        JSON.stringify(replay.counterexample) === JSON.stringify(caught.counterexample) &&
        String(replay.errorInstance).includes('wrong boot action on Enter:'),
      `replay.failed=${replay.failed} err=${String(replay.errorInstance).slice(0, 140)}`,
    )
    const cleanReplay = await fc.check(
      fc.asyncProperty(faultArb, async scenario => {
        await runScenario(scenario)
      }),
      { seed: caught.seed, path: shrinkPath, endOnFailure: true },
    )
    t.check(
      `unmodified BootSplashScreen passed exact counterexample replay (seed=${caught.seed} path=${shrinkPath})`,
      !cleanReplay.failed,
      cleanReplay.failed ? String(cleanReplay.errorInstance) : '',
    )
  }

  t.section('§3 — Esc from Logins/Keys, Boot Menu, and Session Manager returns selection to the row you came from')
  {
    const remountBootFace = async (): Promise<string> => {
      const cols = 120
      const rows = 34
      stdout.columns = cols
      stdout.rows = rows
      runSeq++
      ink.render(
        h(
          ThemeProvider as never,
          {},
          h(
            AppStateProvider as never,
            {},
            h(
              TerminalSizeContext.Provider,
              { value: { columns: cols, rows } },
              h(
                KeybindingSetup as never,
                {},
                h(
                  Box,
                  { width: cols, height: rows, flexDirection: 'column' },
                  h(BootSplashScreen, { key: `boot-run-${runSeq}` }),
                ),
              ),
            ),
          ),
        ),
      )
      return settleFrame()
    }
    const hint = 'set initialId to "concourse" when returning from concourse in src/screen/boot-face/BootSplashScreen.tsx'
    for (const history of ['none', 'cross'] as const) {
      const { frame: initial } = await mountBootFace({ history, concourseLive: true, compact: false })
      t.check(`history=${history}: fresh boot selects New Session`, focusedRowLabels(initial)[0] === 'New Session', `got ${JSON.stringify(focusedRowLabels(initial))}`)
      let frame = await sendKey(KEYS.down)
      if (history === 'cross') {
        t.check(`history=${history}: down lands on Continue Last Session, the row of another project`, focusedRowLabels(frame)[0] === 'Continue Last Session', `got ${JSON.stringify(focusedRowLabels(frame))} — the continue row of another project is choosable in src/screen/boot-face/splash/rowActions.ts`)
        frame = await sendKey(KEYS.down)
      }
      t.check(`history=${history}: down lands on Logins/Keys`, focusedRowLabels(frame)[0] === 'Logins/Keys', `got ${JSON.stringify(focusedRowLabels(frame))}`)
      await sendKey(KEYS.enter)
      frame = await sendKey(KEYS.esc)
      t.check(`history=${history}: Esc from Logins/Keys keeps selection on Logins/Keys`, focusedRowLabels(frame)[0] === 'Logins/Keys', `got ${JSON.stringify(focusedRowLabels(frame))}`)

      frame = await sendKey(KEYS.down)
      t.check(`history=${history}: down lands on Session Manager (Concourse)`, focusedRowLabels(frame)[0] === 'Session Manager (Concourse)', `got ${JSON.stringify(focusedRowLabels(frame))}`)
      await sendKey(KEYS.enter)
      t.check(`history=${history}: Enter opens concourse route`, surfaceRoute.currentSurfaceRoute().kind === 'concourse', `route=${surfaceRoute.currentSurfaceRoute().kind}`)
      const returned = surfaceRoute.leaveCurrentSurface()
      frame = await remountBootFace()
      const backOnConcourse = returned.ok && surfaceRoute.currentSurfaceRoute().kind === 'boot-settings' && focusedRowLabels(frame)[0] === 'Session Manager (Concourse)'
      t.check(
        `history=${history}: Esc from Session Manager returns selection to Session Manager (Concourse)`,
        backOnConcourse,
        backOnConcourse ? '' : `got ${JSON.stringify(focusedRowLabels(frame))} — ${hint}`,
      )

      frame = await sendKey(KEYS.down)
      t.check(`history=${history}: down from Session Manager lands on Boot Menu`, focusedRowLabels(frame)[0] === 'Boot Menu', `got ${JSON.stringify(focusedRowLabels(frame))}`)
      await sendKey(KEYS.enter)
      frame = await sendKey(KEYS.esc)
      t.check(`history=${history}: Esc from Boot Menu keeps selection on Boot Menu`, focusedRowLabels(frame)[0] === 'Boot Menu', `got ${JSON.stringify(focusedRowLabels(frame))}`)
    }
    await mountBootFace({ history: 'none', concourseLive: true, compact: false })
    const prevFullscreen = process.env.MERCURY_FULLSCREEN
    process.env.MERCURY_FULLSCREEN = '1'
    surfaceRoute.enterRootChat()
    surfaceRoute.cycleSurface(1)
    const cycled = surfaceRoute.cycleSurface(1)
    if (prevFullscreen === undefined) delete process.env.MERCURY_FULLSCREEN
    else process.env.MERCURY_FULLSCREEN = prevFullscreen
    const stripFrame = await remountBootFace()
    const stripOnNew = cycled.ok && surfaceRoute.currentSurfaceRoute().kind === 'boot-settings' && focusedRowLabels(stripFrame)[0] === 'New Session'
    t.check(
      'strip cycle (Shift+Left from chat through concourse) keeps selection on New Session',
      stripOnNew,
      stripOnNew ? '' : `cycled=${JSON.stringify(cycled)} route=${surfaceRoute.currentSurfaceRoute().kind} got ${JSON.stringify(focusedRowLabels(stripFrame))} — check tr.verb === "RETURN" in src/screen/boot-face/BootSplashScreen.tsx`,
    )
  }
} finally {
  faultForceNew = false
  surfaceRoute._resetSurfaceRouteForTesting()
  ink.unmount()
  instances.delete(stdout as never)
  disposeKeybindingWatcher()
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}

t.finish('screen-properties-boot-settings')
