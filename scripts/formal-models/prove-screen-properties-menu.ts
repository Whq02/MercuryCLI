#!/usr/bin/env bun

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import stripAnsi from 'strip-ansi'
import { checker } from '../engine-durability/harness.ts'

const previousCwd = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'mercury-screen-props-menu-'))
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

type MockWorker = {
  runnerId: string
  sessionId: string
  lastDeliveryAt?: number
  settingsSnapshot?: {
    profileRevision: number
    rows: Array<{ env: string; value: string | null; source: string }>
  }
}

let activeWorkers: MockWorker[] = []

const realWorkers = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
mock.module('../../src/daemon/concourse-workers/concourseWorkers.ts', () => ({
  ...realWorkers,
  countLiveConcourseWorkers: () => activeWorkers.length,
  listConcourseWorkers: () => activeWorkers,
}))

const realControl = await import('../../src/daemon/control/controlSocket.ts')
mock.module('../../src/daemon/control/controlSocket.ts', () => ({
  ...realControl,
  daemonControlRpc: async () => ({ ok: true, op: 'sessionControl', outcome: 'applied', detail: 'fixture' }),
}))

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { registerBootDoors } = await import('../../src/boot/doors/registerDoors.ts')
registerBootDoors()

const { STARTUP_MENU, bootEnvPath, menuRowChoices, readBootDefaultsProfile, saveBootDefaultsProfile } = await import(
  '../../src/platform/substrate/startupMenu.ts'
)
const { SEATS_MENU_ROW, seatCeilingFactsAsync, setOperatorSeats } = await import(
  '../../src/daemon/switchboard-capacity/capacityCheck.ts'
)
const { MOTION_MENU_ROW, readMotionSetting, setMotionSetting } = await import(
  '../../src/screen/cockpit/motionSetting.ts'
)
const { JEV_MENU_ROW, readJevSettings, setJevEnabled } = await import('../../src/models/jev/jevSetting.ts')
const {
  BACKGROUND_LAUNCH_MENU_ROW,
  backgroundSessionsLaunchCrewmates,
  setBackgroundSessionsLaunchCrewmates,
} = await import('../../src/daemon/switchboard/backgroundLaunch.ts')
type SettingsEditor = import('../../src/screen/boot-face/settings/menuModel.ts').SettingsEditor
const { settingsEditors } = await import('../../src/screen/boot-face/settings/menuModel.ts')
const { BootSettingsScreen, withJevRow } = await import('../../src/screen/boot-face/BootSettingsScreen.tsx')
const { default: Ink } = await import('../../src/screen/renderer/screenInstance.js')
const { default: instances } = await import('../../src/screen/renderer/instances.js')
const { default: reconciler } = await import('../../src/screen/renderer/reconciler.js')
const { disposeKeybindingWatcher } = await import('../../src/screen/keys/loadUserBindings.js')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { TerminalSizeContext } = await import('../../src/screen/renderer/elements/TerminalSizeContext.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')

for (const row of STARTUP_MENU) {
  delete process.env[row.env]
}

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
  left: '\x1b[D',
  right: '\x1b[C',
  pgdn: '\x1b[6~',
  pgup: '\x1b[5~',
  home: '\x1b[H',
  end: '\x1b[F',
  enter: '\x1b[13u',
  space: ' ',
  backspace: '\x7f',
  esc: '\x1b[27u',
  apply: 'a',
} as const

type NavKey = 'down' | 'up' | 'pgdn' | 'pgup' | 'home' | 'end'
type Ending = 'enter' | 'space' | 'right' | 'left' | 'backspace' | 'esc'

type Scenario = {
  cols: number
  rows: number
  hasEditors: boolean
  presetEntries: Array<{ rowIndex: number; choiceIndex: number }>
  steps: NavKey[]
  ending: Ending
}

const ALL_MENU_ROWS = [...withJevRow(STARTUP_MENU), SEATS_MENU_ROW, MOTION_MENU_ROW]
const ALL_LABELS_DESC = [...settingsEditors.map(e => e.label), ...ALL_MENU_ROWS.map(r => r.label)].sort(
  (a, b) => b.length - a.length,
)

const stdout = new FakeStdout(124, 30)
const stdin = new FakeStdin()
const ink = new Ink({
  stdout: stdout as never,
  stdin: stdin as never,
  stderr: new FakeStdout(124, 30) as never,
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

function focusedLabelsOf(frame: string): string[] {
  const hits: string[] = []
  for (const line of frame.split('\n')) {
    let idx = line.indexOf('❯ ')
    while (idx >= 0) {
      const rest = line.slice(idx + 2).trimStart()
      const matched = ALL_LABELS_DESC.find(label => rest.startsWith(label))
      if (matched) hits.push(matched)
      idx = line.indexOf('❯ ', idx + 2)
    }
  }
  return hits
}

function resetPersistedMenuState(presetEntries: ReadonlyArray<{ rowIndex: number; choiceIndex: number }>): Record<string, string> {
  const path = bootEnvPath()
  if (existsSync(path)) rmSync(path, { force: true })
  const env: Record<string, string> = {}
  for (const item of presetEntries) {
    const row = STARTUP_MENU[item.rowIndex % STARTUP_MENU.length]!
    const choices = menuRowChoices(row).filter(c => c.value !== null)
    if (choices.length === 0) continue
    const pick = choices[item.choiceIndex % choices.length]!
    if (pick.value !== null) env[row.env] = pick.value
  }
  if (Object.keys(env).length > 0) {
    const res = saveBootDefaultsProfile(env, path)
    if (!res.ok) throw new Error(`failed to seed boot defaults profile: ${res.reason}`)
  }
  setOperatorSeats(null)
  setMotionSetting('auto')
  setJevEnabled(false)
  setBackgroundSessionsLaunchCrewmates(false)
  return env
}

function readSavedEnvMap(): Record<string, string> {
  const profile = readBootDefaultsProfile(bootEnvPath())
  return profile ? { ...profile.env } : {}
}

function stableEnvJson(env: Record<string, string>): string {
  return JSON.stringify(Object.keys(env).sort().map(k => [k, env[k]]))
}

let runSeq = 0
let closedCount = 0
let openedEditors: SettingsEditor[] = []
let faultRewriteEditor: ((editor: SettingsEditor) => SettingsEditor) | null = null

async function mountMenu(cols: number, rows: number, hasEditors: boolean): Promise<string> {
  closedCount = 0
  openedEditors = []
  runSeq++
  stdout.columns = cols
  stdout.rows = rows
  ink.render(
    h(
      ThemeProvider,
      {},
      h(
        AppStateProvider,
        {},
        h(
          TerminalSizeContext.Provider,
          { value: { columns: cols, rows } },
          h(
            KeybindingSetup,
            {},
            h(
              Box,
              { width: cols, height: rows, flexDirection: 'column' },
              h(BootSettingsScreen, {
                key: `menu-run-${runSeq}`,
                fullScene: { columns: cols, rows },
                onClose: () => {
                  closedCount++
                },
                ...(hasEditors
                  ? {
                      onOpenEditor: (editor: SettingsEditor) => {
                        openedEditors.push(faultRewriteEditor ? faultRewriteEditor(editor) : editor)
                      },
                    }
                  : {}),
              }),
            ),
          ),
        ),
      ),
    ),
  )
  let frame = await settleFrame()
  for (let i = 0; i < 8 && frame.includes('reading capacity…'); i++) {
    frame = await settleFrame()
  }
  return frame
}

function assertSingleFocusedLabel(phase: string, frame: string, validLabels: Set<string>): string {
  const hits = focusedLabelsOf(frame)
  const unique = [...new Set(hits)]
  if (unique.length !== 1) {
    throw new Error(`${phase}: expected 1 unique painted focused row, got ${JSON.stringify(hits)}\n${frame}`)
  }
  const label = unique[0]!
  if (!validLabels.has(label)) {
    throw new Error(`${phase}: focused row '${label}' is outside menuRows`)
  }
  return label
}

async function runScenario(scenario: Scenario): Promise<void> {
  activeWorkers = []
  const initialEnv = resetPersistedMenuState(scenario.presetEntries)
  const validRows = [...(scenario.hasEditors ? settingsEditors : []), ...ALL_MENU_ROWS]
  const validLabels = new Set(validRows.map(r => r.label))
  let frame = await mountMenu(scenario.cols, scenario.rows, scenario.hasEditors)
  let focusedLabel = assertSingleFocusedLabel('mount', frame, validLabels)

  for (let i = 0; i < scenario.steps.length; i++) {
    const key = scenario.steps[i]!
    frame = await sendKey(KEYS[key])
    if (closedCount !== 0 || openedEditors.length !== 0) {
      throw new Error(`step[${i}]:${key} triggered side effect (closed=${closedCount}, editors=${JSON.stringify(openedEditors)})`)
    }
    focusedLabel = assertSingleFocusedLabel(`step[${i}]:${key}`, frame, validLabels)
  }

  const targetRow = validRows.find(r => r.label === focusedLabel)
  if (!targetRow) {
    throw new Error(`before ending: painted label '${focusedLabel}' missing from validRows`)
  }

  if (scenario.ending === 'esc') {
    await sendKey(KEYS.esc)
    if (closedCount !== 1 || openedEditors.length !== 0) {
      throw new Error(`Esc expected closed=1 editors=0, got closed=${closedCount} editors=${JSON.stringify(openedEditors)}`)
    }
    if (stableEnvJson(readSavedEnvMap()) !== stableEnvJson(initialEnv)) {
      throw new Error(`Esc mutated saved boot-env profile`)
    }
    return
  }

  if ('editor' in targetRow) {
    await sendKey(KEYS[scenario.ending])
    if (closedCount !== 0) {
      throw new Error(`${scenario.ending} on editor '${targetRow.editor}' unexpectedly closed menu`)
    }
    if (scenario.ending === 'enter' || scenario.ending === 'space') {
      if (openedEditors.length !== 1 || openedEditors[0] !== targetRow.editor) {
        throw new Error(
          `wrong editor opened: painted '${targetRow.label}' (${targetRow.editor}) != opened ${JSON.stringify(openedEditors)}`,
        )
      }
    } else if (openedEditors.length !== 0) {
      throw new Error(`${scenario.ending} on editor '${targetRow.editor}' should not open editor: ${JSON.stringify(openedEditors)}`)
    }
    if (stableEnvJson(readSavedEnvMap()) !== stableEnvJson(initialEnv)) {
      throw new Error(`${scenario.ending} on editor '${targetRow.editor}' mutated boot-env profile`)
    }
    return
  }

  const beforeEnv = readSavedEnvMap()
  const beforeMotion = readMotionSetting()
  const beforeJev = readJevSettings().enabled
  const beforeBg = backgroundSessionsLaunchCrewmates()
  const beforeSeats = (await seatCeilingFactsAsync()).seats

  frame = await sendKey(KEYS[scenario.ending])
  frame = await settleFrame()

  if (closedCount !== 0 || openedEditors.length !== 0) {
    throw new Error(`${scenario.ending} on setting '${targetRow.env}' closed or opened editor (closed=${closedCount}, editors=${JSON.stringify(openedEditors)})`)
  }

  const afterEnv = readSavedEnvMap()
  if (targetRow.env === MOTION_MENU_ROW.env) {
    const afterMotion = readMotionSetting()
    if (scenario.ending === 'backspace') {
      if (afterMotion !== 'auto') throw new Error(`Backspace on motion expected 'auto', got '${afterMotion}'`)
    } else if (afterMotion === beforeMotion) {
      throw new Error(`${scenario.ending} on motion did not cycle value (stayed '${afterMotion}')`)
    }
    if (stableEnvJson(afterEnv) !== stableEnvJson(beforeEnv)) {
      throw new Error(`${scenario.ending} on motion unexpectedly mutated boot-env.json`)
    }
    return
  }
  if (targetRow.env === JEV_MENU_ROW.env) {
    const afterJev = readJevSettings().enabled
    if (scenario.ending === 'backspace') {
      if (afterJev !== false) throw new Error(`Backspace on jev expected false, got ${afterJev}`)
    } else if (afterJev === beforeJev) {
      throw new Error(`${scenario.ending} on jev did not toggle value (stayed ${afterJev})`)
    }
    if (stableEnvJson(afterEnv) !== stableEnvJson(beforeEnv)) {
      throw new Error(`${scenario.ending} on jev unexpectedly mutated boot-env.json`)
    }
    return
  }
  if (targetRow.env === BACKGROUND_LAUNCH_MENU_ROW.env) {
    const afterBg = backgroundSessionsLaunchCrewmates()
    if (scenario.ending === 'backspace') {
      if (afterBg !== false) throw new Error(`Backspace on background launch expected false, got ${afterBg}`)
    } else if (afterBg === beforeBg) {
      throw new Error(`${scenario.ending} on background launch did not toggle value (stayed ${afterBg})`)
    }
    if (stableEnvJson(afterEnv) !== stableEnvJson(beforeEnv)) {
      throw new Error(`${scenario.ending} on background launch unexpectedly mutated boot-env.json`)
    }
    return
  }
  if (targetRow.env === SEATS_MENU_ROW.env) {
    const afterSeatsFacts = await seatCeilingFactsAsync()
    if (scenario.ending === 'backspace') {
      if (afterSeatsFacts.source === 'operator') {
        throw new Error(`Backspace on seats did not clear operator override`)
      }
    } else {
      const expected = scenario.ending === 'left' ? Math.max(1, beforeSeats - 1) : beforeSeats + 1
      if (afterSeatsFacts.seats !== expected) {
        throw new Error(`${scenario.ending} on seats expected ${expected}, got ${afterSeatsFacts.seats}`)
      }
    }
    if (stableEnvJson(afterEnv) !== stableEnvJson(beforeEnv)) {
      throw new Error(`${scenario.ending} on seats unexpectedly mutated boot-env.json`)
    }
    return
  }

  const choices = menuRowChoices(targetRow)
  const expectedEnv = { ...beforeEnv }
  if (scenario.ending === 'backspace') {
    delete expectedEnv[targetRow.env]
  } else {
    const dir = scenario.ending === 'left' ? -1 : 1
    const cur = beforeEnv[targetRow.env] ?? null
    const idx = Math.max(0, choices.findIndex(c => c.value === cur))
    const next = choices[(idx + dir + choices.length) % choices.length]!
    if (next.value === null) delete expectedEnv[targetRow.env]
    else expectedEnv[targetRow.env] = next.value
  }
  if (stableEnvJson(afterEnv) !== stableEnvJson(expectedEnv)) {
    throw new Error(
      `${scenario.ending} on '${targetRow.label}' (${targetRow.env}) persisted wrong profile: expected ${stableEnvJson(expectedEnv)}, got ${stableEnvJson(afterEnv)}`,
    )
  }
}

const navKeyArb: fc.Arbitrary<NavKey> = fc.constantFrom('down', 'up', 'pgdn', 'pgup', 'home', 'end')
const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  cols: fc.constantFrom(88, 124, 140),
  rows: fc.constantFrom(24, 30, 42),
  hasEditors: fc.boolean(),
  presetEntries: fc.array(
    fc.record({
      rowIndex: fc.integer({ min: 0, max: STARTUP_MENU.length - 1 }),
      choiceIndex: fc.integer({ min: 0, max: 5 }),
    }),
    { minLength: 0, maxLength: 4 },
  ),
  steps: fc.array(navKeyArb, { minLength: 0, maxLength: 14 }),
  ending: fc.constantFrom('enter', 'space', 'right', 'left', 'backspace', 'esc'),
})

const t = checker()
const SEED_MAIN = 20261141
const SEED_OVERLAY = 20261142
const SEED_FAULT = 20261143

try {
  t.section('§1 — BootSettingsScreen (menu): painted focused row matches open/cycle/reset target and Esc leaves')
  {
    const result = await fc.check(
      fc.asyncProperty(scenarioArb, async scenario => {
        await runScenario(scenario)
      }),
      { numRuns: 45, seed: SEED_MAIN },
    )
    t.check(
      `45 generated profile/geometry/key scenarios held painted-row identity, persistence & Esc laws (seed ${SEED_MAIN})`,
      !result.failed,
      result.failed ? `path=${result.counterexamplePath} error=${String(result.errorInstance)}` : '',
    )
  }

  t.section('§2 — BootSettingsScreen (menu): apply-receipts overlay stages Esc and corrupt profile still leaves on Esc')
  {
    const overlayArb = fc.record({
      workerCount: fc.integer({ min: 0, max: 3 }),
      steps: fc.array(navKeyArb, { minLength: 0, maxLength: 8 }),
      geometry: fc.constantFrom({ cols: 132, rows: 42, wide: true }, { cols: 100, rows: 28, wide: false }),
    })
    const result = await fc.check(
      fc.asyncProperty(overlayArb, async ({ workerCount, steps, geometry }) => {
        resetPersistedMenuState([])
        activeWorkers = Array.from({ length: workerCount }, (_, i) => ({
          runnerId: `r-${i + 1}`,
          sessionId: `00000000-0000-4000-8000-00000000000${i + 1}`,
          settingsSnapshot:
            i % 2 === 0
              ? { profileRevision: 0, rows: STARTUP_MENU.map(r => ({ env: r.env, value: null, source: 'default' })) }
              : undefined,
        }))
        let frame = await mountMenu(geometry.cols, geometry.rows, true)
        for (const k of steps) frame = await sendKey(KEYS[k])
        frame = await sendKey(KEYS.apply)
        for (let i = 0; i < 6 && frame.includes('reading established sessions…'); i++) {
          frame = await settleFrame()
        }
        const receiptVisible = geometry.wide ? frame.includes('apply to established sessions') : true
        if (!receiptVisible || !frame.includes('esc close receipts')) {
          throw new Error(`pressing 'a' did not open apply-receipts overlay (wide=${geometry.wide}):\n${frame}`)
        }
        if (closedCount !== 0) {
          throw new Error(`opening apply-receipts overlay called onClose`)
        }
        frame = await sendKey(KEYS.esc)
        if (closedCount !== 0 || frame.includes('esc close receipts') || !frame.includes('esc back')) {
          throw new Error(`first Esc did not close only the receipts overlay (closed=${closedCount}):\n${frame}`)
        }
        await sendKey(KEYS.esc)
        if (closedCount !== 1) {
          throw new Error(`second Esc did not leave menu (closed=${closedCount})`)
        }
      }),
      { numRuns: 20, seed: SEED_OVERLAY },
    )
    t.check(
      `20 generated apply-overlay sequences held 2-stage Esc (close receipts -> leave menu) (seed ${SEED_OVERLAY})`,
      !result.failed,
      result.failed ? `path=${result.counterexamplePath} error=${String(result.errorInstance)}` : '',
    )

    activeWorkers = []
    writeFileSync(bootEnvPath(), '{corrupt-json')
    let corruptFrame = await mountMenu(132, 42, true)
    const showsReadError = corruptFrame.includes('could not be read')
    corruptFrame = await sendKey(KEYS.down)
    await sendKey(KEYS.esc)
    t.check(
      'corrupt boot-env.json reports read error without crashing and Esc still leaves menu',
      showsReadError && closedCount === 1,
      `showsReadError=${showsReadError} closedCount=${closedCount}`,
    )
  }

  t.section('§3 — Wrong editor dispatch shrinks to a replayable minimal counterexample with seed and path')
  {
    const faultArb: fc.Arbitrary<Scenario> = fc.record({
      cols: fc.constant(124),
      rows: fc.constant(30),
      hasEditors: fc.constant(true),
      presetEntries: fc.constant([]),
      steps: fc.array(fc.constantFrom('down' as const, 'up' as const, 'home' as const), { minLength: 1, maxLength: 6 }),
      ending: fc.constant('enter' as const),
    })

    const faultyProp = fc.asyncProperty(faultArb, async scenario => {
      faultRewriteEditor = () => 'kit'
      try {
        await runScenario(scenario)
      } finally {
        faultRewriteEditor = null
      }
    })

    const caught = await fc.check(faultyProp, { numRuns: 40, seed: SEED_FAULT })
    const shrinkPath = caught.counterexamplePath ?? ''
    t.check(
      `fault-injected wrong editor failed with seed ${SEED_FAULT} and shrink path`,
      caught.failed && caught.seed === SEED_FAULT && shrinkPath.length > 0,
      `failed=${caught.failed} path=${shrinkPath}`,
    )

    const minimized = caught.counterexample?.[0]
    t.check(
      'shrunk counterexample is minimal (<= 2 steps)',
      minimized !== undefined && minimized.steps.length <= 2,
      minimized ? `steps=${JSON.stringify(minimized.steps)} shrinks=${caught.numShrinks}` : 'no counterexample',
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
        String(replay.errorInstance).includes('wrong editor opened:'),
      `replay.failed=${replay.failed} err=${String(replay.errorInstance).slice(0, 140)}`,
    )

    const cleanReplay = await fc.check(
      fc.asyncProperty(faultArb, async scenario => {
        await runScenario(scenario)
      }),
      { seed: caught.seed, path: shrinkPath, endOnFailure: true },
    )
    t.check(
      `unmodified BootSettingsScreen passed exact counterexample replay (seed=${caught.seed} path=${shrinkPath})`,
      !cleanReplay.failed,
      cleanReplay.failed ? String(cleanReplay.errorInstance) : '',
    )
  }
} finally {
  faultRewriteEditor = null
  ink.unmount()
  instances.delete(stdout as never)
  disposeKeybindingWatcher()
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}

t.finish('screen-properties-menu')
