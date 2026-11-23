#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import stripAnsi from 'strip-ansi'
import { checker } from '../engine-durability/harness.ts'

const previousCwd = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'mercury-screen-props-sessions-'))
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
type SessionPickerFlatRow = import('../../src/screen/widgets/faces/sessionPickerModel.js').SessionPickerFlatRow
type BootProjectFact = import('../../src/screen/boot-face/bootCardFacts.js').BootProjectFact

let resumedCalls: Array<{ sessionId: string; fullPath?: string; title?: string }> = []
let bornCalls: Array<{ workspaceDir: string }> = []
let openedProjects: Array<{ dir: string; base: string }> = []
let pruneCalls = 0
let closeCalls = 0
let faultRewriteId: ((sessionId: string) => string) | null = null

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

const realBorn = await import('../../src/daemon/switchboard/bornSession.ts')
mock.module('../../src/daemon/switchboard/bornSession.ts', () => ({
  ...realBorn,
  bornSession: async (opts: { workspaceDir: string }) => {
    bornCalls.push({ workspaceDir: opts.workspaceDir })
    return { ok: false as const, reason: 'property-harness-capture' }
  },
}))

const realPrune = await import('../../src/daemon/switchboard/transcriptPruneDoor.ts')
mock.module('../../src/daemon/switchboard/transcriptPruneDoor.ts', () => ({
  ...realPrune,
  operatorPruneTranscripts: async () => {
    pruneCalls++
    return { deleted: 0, bytesFreed: 0, failed: 0, at: new Date(), deletedSessionIds: [] }
  },
}))

const realWorkers = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
mock.module('../../src/daemon/concourse-workers/concourseWorkers.ts', () => ({
  ...realWorkers,
  boardHomedSessionIds: () => new Set<string>(),
}))

const { registerBootDoors } = await import('../../src/boot/doors/registerDoors.ts')
registerBootDoors()
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { setCwdState, setOriginalCwd } = await import('../../src/boot/process-state/processState.ts')
setOriginalCwd(fixtureRoot)
setCwdState(fixtureRoot)

const { default: Ink } = await import('../../src/screen/renderer/screenInstance.js')
const { default: instances } = await import('../../src/screen/renderer/instances.js')
const { default: reconciler } = await import('../../src/screen/renderer/reconciler.js')
const { disposeKeybindingWatcher } = await import('../../src/screen/keys/loadUserBindings.js')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { BootResumeScreen } = await import('../../src/screen/boot-face/BootResumeScreen.tsx')

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
  tab: '\t',
  enter: '\x1b[13u',
  esc: '\x1b[27u',
  left: '\x1b[D',
} as const

type NavKey = 'down' | 'up' | 'tab' | 'a'

type SessionSpec = {
  projectIdx: number
  cleared: boolean
  oldDays: number
}

type Scenario = {
  sessions: SessionSpec[]
  projectCount: number
  elsewhereCount: number
  initialScope: 'all' | 'project'
  size: 'wide' | 'classic'
  steps: NavKey[]
  ending: 'open' | 'esc' | 'left' | 'new'
}

type BuiltSession = {
  token: string
  sessionId: string
  fullPath: string
  projectDir: string
  flat: SessionPickerFlatRow
}

type BuiltProject = {
  token: string
  dir: string
  base: string
  fact: BootProjectFact & { running?: number }
}

const BASE_MS = Date.UTC(2026, 10, 1, 12, 0, 0)
const REPO_DIRS = [
  join(fixtureRoot, 'repo-a'),
  join(fixtureRoot, 'repo-b'),
  join(fixtureRoot, 'repo-c'),
] as const

function buildFixture(specs: readonly SessionSpec[], projectCount: number): {
  sessions: BuiltSession[]
  projects: BuiltProject[]
  sessionByToken: Map<string, BuiltSession>
  projectByToken: Map<string, BuiltProject>
} {
  const projects: BuiltProject[] = Array.from({ length: projectCount }, (_, i) => {
    const n = i + 1
    const token = `[P0${n}]`
    const dir = REPO_DIRS[i]!
    const base = `${token} repo-${n}`
    const fact: BootProjectFact & { running?: number } = {
      dir,
      base,
      ageMs: (n + 1) * 60_000,
      sessionId: null,
      firstSessionId: null,
      transcriptPath: null,
      running: i === 0 ? 1 : 0,
    }
    return { token, dir, base, fact }
  })

  const sessions: BuiltSession[] = specs.map((spec, idx) => {
    const n = idx + 1
    const tag = String(n).padStart(2, '0')
    const token = `[S${tag}]`
    const sessionId = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    const projectDir = REPO_DIRS[spec.projectIdx % REPO_DIRS.length]!
    const fullPath = join(projectDir, `${sessionId}.jsonl`)
    const ts = new Date(BASE_MS - spec.oldDays * 86_400_000 - n * 60_000)
    const label = `${token} chat-${tag}`
    const log: SessionListing = {
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
      projectPath: projectDir,
      fileSize: 4096,
    }
    const flat: SessionPickerFlatRow = {
      project: `repo-${(spec.projectIdx % REPO_DIRS.length) + 1}`,
      row: {
        id: sessionId,
        label,
        seen: `${spec.oldDays}d`,
        log,
        cleared: spec.cleared,
      },
    }
    return { token, sessionId, fullPath, projectDir, flat }
  })

  return {
    sessions,
    projects,
    sessionByToken: new Map(sessions.map(item => [item.token, item])),
    projectByToken: new Map(projects.map(item => [item.token, item])),
  }
}

function pointerTokensOf(frame: string): string[] {
  const tokens: string[] = []
  for (const line of frame.split('\n')) {
    let from = 0
    while (true) {
      const at = line.indexOf('❯ ', from)
      if (at < 0) break
      const slice = line.slice(at + 2, at + 16)
      const match = /^\[(S\d{2}|P0\d)\]/.exec(slice)
      if (match) tokens.push(`[${match[1]}]`)
      from = at + 2
    }
  }
  return tokens
}

function visibleSessionTokensOf(frame: string): string[] {
  const out = new Set<string>()
  for (const match of frame.matchAll(/\[S\d{2}\]/g)) {
    out.add(match[0])
  }
  return [...out]
}

const stdout = new FakeStdout(120, 34)
const stdin = new FakeStdin()
const ink = new Ink({
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

async function mountScreen(
  size: 'wide' | 'classic',
  sessions: BuiltSession[],
  projects: BuiltProject[],
  elsewhereCount: number,
  initialScope: 'all' | 'project',
): Promise<string> {
  resumedCalls = []
  bornCalls = []
  openedProjects = []
  pruneCalls = 0
  closeCalls = 0
  runSeq++
  const columns = size === 'wide' ? 120 : 80
  const rows = size === 'wide' ? 34 : 24
  ink.render(
    h(
      ThemeProvider,
      {},
      h(
        AppStateProvider,
        {},
        h(
          KeybindingSetup,
          {},
          h(
            Box,
            { width: columns, height: rows, flexDirection: 'column' },
            h(BootResumeScreen, {
              key: `sessions-run-${runSeq}`,
              fullScene: { columns, rows },
              initialScope,
              model: {
                flat: sessions.map(s => s.flat),
                elsewhereCount,
                pendingMore: 0,
                readNotice: null,
              },
              projects: projects.map(p => p.fact),
              onClose: () => {
                closeCalls++
              },
              openProject: p => {
                openedProjects.push({ dir: p.dir, base: p.base })
                return null
              },
            }),
          ),
        ),
      ),
    ),
  )
  return settleFrame()
}

async function runScenario(scenario: Scenario): Promise<void> {
  const { sessions, projects, sessionByToken, projectByToken } = buildFixture(
    scenario.sessions,
    scenario.projectCount,
  )
  let frame = await mountScreen(
    scenario.size,
    sessions,
    projects,
    scenario.elsewhereCount,
    scenario.initialScope,
  )

  const checkInvariants = (phase: string, current: string): string | null => {
    if (current.includes('RENDER ERROR')) {
      throw new Error(`${phase}: BootResumeScreen painted RENDER ERROR`)
    }
    if (resumedCalls.length > 0 || openedProjects.length > 0 || bornCalls.length > 0 || closeCalls > 0 || pruneCalls > 0) {
      throw new Error(
        `${phase}: unexpected side effect before ending (resumed=${resumedCalls.length}, projects=${openedProjects.length}, born=${bornCalls.length}, close=${closeCalls}, prune=${pruneCalls})`,
      )
    }
    const totalRows = sessions.length + projects.length
    const tokens = pointerTokensOf(current)
    if (totalRows === 0) {
      if (tokens.length !== 0) {
        throw new Error(`${phase}: empty screen painted pointer tokens ${JSON.stringify(tokens)}`)
      }
      return null
    }
    const unique = [...new Set(tokens)]
    if (unique.length !== 1) {
      throw new Error(
        `${phase}: expected all painted ❯ pointers to agree on 1 row token, got ${JSON.stringify(tokens)}:\n${current}`,
      )
    }
    const activeToken = unique[0]!
    if (!sessionByToken.has(activeToken) && !projectByToken.has(activeToken)) {
      throw new Error(`${phase}: painted highlighted token ${activeToken} not in generated fixture`)
    }
    const highlightedProject = projectByToken.get(activeToken)
    if (highlightedProject) {
      for (const sTok of visibleSessionTokensOf(current)) {
        const s = sessionByToken.get(sTok)
        if (s && s.projectDir !== highlightedProject.dir) {
          throw new Error(
            `${phase}: highlighting project ${highlightedProject.token} (${highlightedProject.dir}) leaked session ${sTok} from ${s.projectDir}`,
          )
        }
      }
    }
    return activeToken
  }

  let highlighted = checkInvariants('mount', frame)

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i]!
    const seq = step === 'a' ? 'a' : KEYS[step]
    frame = await sendKey(seq)
    highlighted = checkInvariants(`step[${i}]:${step}`, frame)
  }

  if (scenario.ending === 'open') {
    await sendKey(KEYS.enter)
    if (closeCalls !== 0 || bornCalls.length !== 0 || pruneCalls !== 0) {
      throw new Error(`Enter caused non-open side effect (close=${closeCalls}, born=${bornCalls.length}, prune=${pruneCalls})`)
    }
    if (highlighted === null) {
      if (resumedCalls.length !== 0 || openedProjects.length !== 0) {
        throw new Error(`Enter on empty sessions screen opened something (resumed=${resumedCalls.length}, projects=${openedProjects.length})`)
      }
      return
    }
    const expectedSession = sessionByToken.get(highlighted)
    if (expectedSession) {
      if (openedProjects.length !== 0 || resumedCalls.length !== 1) {
        throw new Error(
          `Enter on highlighted session ${highlighted} expected 1 focusResumedSession call, got resumed=${resumedCalls.length} projects=${openedProjects.length}`,
        )
      }
      const got = resumedCalls[0]!
      if (got.sessionId !== expectedSession.sessionId || got.fullPath !== expectedSession.fullPath) {
        throw new Error(
          `wrong session resumed: painted ${highlighted} (${expectedSession.sessionId}) != resumed (${got.sessionId})`,
        )
      }
      return
    }
    const expectedProject = projectByToken.get(highlighted)!
    if (resumedCalls.length !== 0 || openedProjects.length !== 1) {
      throw new Error(
        `Enter on highlighted project ${highlighted} expected 1 openProject call, got projects=${openedProjects.length} resumed=${resumedCalls.length}`,
      )
    }
    if (openedProjects[0]!.dir !== expectedProject.dir) {
      throw new Error(
        `wrong project opened: painted ${highlighted} (${expectedProject.dir}) != opened (${openedProjects[0]!.dir})`,
      )
    }
    return
  }

  if (scenario.ending === 'esc' || scenario.ending === 'left') {
    await sendKey(KEYS[scenario.ending])
    if (resumedCalls.length !== 0 || openedProjects.length !== 0 || bornCalls.length !== 0 || pruneCalls !== 0) {
      throw new Error(`${scenario.ending} triggered action instead of closing`)
    }
    if (closeCalls !== 1) {
      throw new Error(`${scenario.ending} expected onClose count 1, got ${closeCalls}`)
    }
    return
  }

  await sendKey('n')
  if (closeCalls !== 0 || resumedCalls.length !== 0 || openedProjects.length !== 0 || pruneCalls !== 0) {
    throw new Error(`'n' triggered non-birth side effect`)
  }
  if (bornCalls.length !== 1 || bornCalls[0]!.workspaceDir !== fixtureRoot) {
    throw new Error(`'n' expected bornSession({ workspaceDir: ${fixtureRoot} }), got ${JSON.stringify(bornCalls)}`)
  }
}

const sessionSpecArb: fc.Arbitrary<SessionSpec> = fc.record({
  projectIdx: fc.integer({ min: 0, max: 2 }),
  cleared: fc.boolean(),
  oldDays: fc.integer({ min: 1, max: 90 }),
})

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  sessions: fc.array(sessionSpecArb, { minLength: 0, maxLength: 8 }),
  projectCount: fc.integer({ min: 0, max: 3 }),
  elsewhereCount: fc.integer({ min: 0, max: 3 }),
  initialScope: fc.constantFrom('all' as const, 'project' as const),
  size: fc.constantFrom('wide' as const, 'classic' as const),
  steps: fc.array(fc.constantFrom('down' as const, 'up' as const, 'tab' as const, 'a' as const), {
    minLength: 0,
    maxLength: 14,
  }),
  ending: fc.constantFrom('open' as const, 'esc' as const, 'left' as const, 'new' as const),
})

const t = checker()
const SEED_NAV = 20261131
const SEED_PRUNE = 20261132
const SEED_FAULT = 20261133

try {
  t.section('§1 — BootResumeScreen: highlighted row matches Enter target, project filter holds, Esc/← always closes')
  {
    const result = await fc.check(
      fc.asyncProperty(scenarioArb, async scenario => {
        await runScenario(scenario)
      }),
      { numRuns: 60, seed: SEED_NAV },
    )
    t.check(
      `60 generated BootResumeScreen scenarios held highlight/open/filter/close laws (seed ${SEED_NAV})`,
      !result.failed,
      result.failed ? `path=${result.counterexamplePath} error=${String(result.errorInstance)}` : '',
    )
  }

  t.section('§2 — BootResumeScreen: prune card defaults to No, cancels safely without deleting or closing the screen')
  {
    const pruneArb = fc.record({
      sessions: fc.array(sessionSpecArb, { minLength: 1, maxLength: 6 }),
      dismissKey: fc.constantFrom('esc' as const, 'n' as const, 'enter' as const),
      size: fc.constantFrom('wide' as const, 'classic' as const),
    })
    const result = await fc.check(
      fc.asyncProperty(pruneArb, async ({ sessions, dismissKey, size }) => {
        const built = buildFixture(sessions, 0)
        let frame = await mountScreen(size, built.sessions, built.projects, 0, 'all')
        frame = await sendKey('d')
        if (!frame.includes('No — keep everything (default)')) {
          throw new Error(`'d' did not open prune confirmation card defaulting to No:\n${frame}`)
        }
        if (closeCalls !== 0 || pruneCalls !== 0) {
          throw new Error(`'d' caused premature close=${closeCalls} or prune=${pruneCalls}`)
        }
        frame = await sendKey(dismissKey === 'n' ? 'n' : KEYS[dismissKey])
        if (frame.includes('No — keep everything (default)')) {
          throw new Error(`dismissing prune card with ${dismissKey} left card open`)
        }
        if (closeCalls !== 0 || pruneCalls !== 0) {
          throw new Error(`dismissing prune card with ${dismissKey} triggered close=${closeCalls} or prune=${pruneCalls}`)
        }
        await sendKey(KEYS.esc)
        if (closeCalls !== 1 || pruneCalls !== 0) {
          throw new Error(`Esc after dismissing prune card expected closeCalls=1, got ${closeCalls}`)
        }
      }),
      { numRuns: 25, seed: SEED_PRUNE },
    )
    t.check(
      `25 generated prune-card dismissal scenarios kept data intact and left Esc working (seed ${SEED_PRUNE})`,
      !result.failed,
      result.failed ? `path=${result.counterexamplePath} error=${String(result.errorInstance)}` : '',
    )
  }

  t.section('§3 — Wrong session open produces a shrunk replayable counterexample with seed and path')
  {
    const faultArb: fc.Arbitrary<Scenario> = fc.record({
      sessions: fc.array(sessionSpecArb, { minLength: 2, maxLength: 6 }),
      projectCount: fc.constant(0),
      elsewhereCount: fc.constant(0),
      initialScope: fc.constant('all' as const),
      size: fc.constant('wide' as const),
      steps: fc.array(fc.constantFrom('down' as const, 'up' as const), { minLength: 1, maxLength: 6 }),
      ending: fc.constant('open' as const),
    })

    const faultyProp = fc.asyncProperty(faultArb, async scenario => {
      const built = buildFixture(scenario.sessions, 0)
      const firstId = built.sessions[0]!.sessionId
      faultRewriteId = () => firstId
      try {
        await runScenario(scenario)
      } finally {
        faultRewriteId = null
      }
    })

    const caught = await fc.check(faultyProp, { numRuns: 40, seed: SEED_FAULT })
    const shrinkPath = caught.counterexamplePath ?? ''
    t.check(
      `fault-injected wrong session open failed with seed ${SEED_FAULT} and shrink path`,
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
      fc.asyncProperty(faultArb, async scenario => {
        await runScenario(scenario)
      }),
      { seed: caught.seed, path: shrinkPath, endOnFailure: true },
    )
    t.check(
      `unmodified BootResumeScreen passed exact counterexample replay (seed=${caught.seed} path=${shrinkPath})`,
      !cleanReplay.failed,
      cleanReplay.failed ? String(cleanReplay.errorInstance) : '',
    )
  }
} finally {
  faultRewriteId = null
  ink.unmount()
  instances.delete(stdout as never)
  disposeKeybindingWatcher()
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}

t.finish('screen-properties-sessions')
