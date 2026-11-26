#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import stripAnsi from 'strip-ansi'
import { checker } from '../engine-durability/harness.ts'
import type { KitCatalogue, KitRow, KitRowState, KitStates } from '../../src/screen/kit-menu-model/kitTypes.ts'
import type { KitMenuStore } from '../../src/screen/kit-menu-model/menuStore.ts'

const previousCwd = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'mercury-screen-kit-'))
const configHome = join(scratch, 'config')
const daemonDir = join(scratch, 'daemon')
const fixtureRoot = join(scratch, 'project')
mkdirSync(configHome, { recursive: true })
mkdirSync(daemonDir, { recursive: true })
mkdirSync(fixtureRoot, { recursive: true })

process.chdir(fixtureRoot)
process.env.MERCURY_CONFIG_DIR = configHome
process.env.MERCURY_DAEMON_DIR = daemonDir
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
const { registerBootDoors } = await import('../../src/boot/doors/registerDoors.ts')
registerBootDoors()

const { default: ScreenInstance } = await import('../../src/screen/renderer/screenInstance.js')
const { default: instances } = await import('../../src/screen/renderer/instances.js')
const { default: reconciler } = await import('../../src/screen/renderer/reconciler.js')
const { disposeKeybindingWatcher } = await import('../../src/screen/keys/loadUserBindings.js')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { TerminalSizeContext } = await import('../../src/screen/renderer/elements/TerminalSizeContext.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { KitMenuScreen } = await import('../../src/screen/boot-face/KitMenuScreen.tsx')
const { cycleState, kitCounts, kitRowView, kitStateKey, sectionRows } = await import('../../src/screen/kit-menu-model/kitTypes.ts')
const { receiptFor } = await import('../../src/screen/kit-menu-model/menuStore.ts')

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
} as const

type NavKey = 'down' | 'up' | 'pgdn' | 'pgup' | 'home' | 'end'
type ToggleKey = 'enter' | 'space' | 'right' | 'left' | 'backspace'

type MemberSpec = {
  kind: 'mcp' | 'skill'
  ownedByExt: boolean
}

type KitScenario = {
  hasExt: boolean
  members: MemberSpec[]
  viewport: { cols: number; rows: number }
  steps: NavKey[]
  toggle: ToggleKey
  closeOnly: boolean
}

type BuiltRow = {
  marker: string
  stateKey: string
  row: KitRow
}

const stdout = new FakeStdout(120, 40)
const stdin = new FakeStdin()
const ink = new ScreenInstance({
  stdout: stdout as never,
  stdin: stdin as never,
  stderr: new FakeStdout(120, 40) as never,
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
  reconciler.flushSyncWork()
  ink.onRender()
  return stripAnsi(ink.lastFrameText())
}

async function sendKey(seq: string): Promise<string> {
  stdin.push(seq)
  return settleFrame()
}

let closedCount = 0
let writeLog: Array<{ key: string; next: KitRowState }> = []
let faultRewriteKey: ((key: string) => string) | null = null
let runSeq = 0

function makeMemoryStore(): { store: KitMenuStore; backing: Map<string, KitRowState> } {
  const backing = new Map<string, KitRowState>()
  const store: KitMenuStore = {
    read: (): KitStates => new Map(backing),
    write: (_ws, row, next) => {
      const rawKey = kitStateKey(row)
      if (rawKey === null) return { ok: false, reason: 'not a toggle' }
      const key = faultRewriteKey ? faultRewriteKey(rawKey) : rawKey
      const prev = backing.get(key) ?? 'on'
      if (next === 'on') backing.delete(key)
      else backing.set(key, next)
      writeLog.push({ key, next })
      return { ok: true, receipt: receiptFor(row, next, prev !== next) }
    },
  }
  return { store, backing }
}

function buildCatalogue(hasExt: boolean, specs: readonly MemberSpec[]): {
  catalogue: KitCatalogue
  byMarker: Map<string, BuiltRow>
  all: BuiltRow[]
} {
  const rows: KitRow[] = []
  const all: BuiltRow[] = []
  const extName = '[E01] ext-01'
  if (hasExt) {
    const extRow: KitRow = { kind: 'extension', section: 'mcp', name: extName, contributes: 'fixture tools' }
    rows.push(extRow)
    all.push({ marker: '[E01]', stateKey: kitStateKey(extRow)!, row: extRow })
  }
  let mIdx = 0
  let kIdx = 0
  for (const spec of specs) {
    if (spec.kind === 'mcp') {
      mIdx++
      const tag = String(mIdx).padStart(2, '0')
      const marker = `[M${tag}]`
      const row: KitRow = {
        kind: 'mcp',
        section: 'mcp',
        name: `${marker} srv-${tag}`,
        scope: 'project',
        extension: hasExt && spec.ownedByExt ? extName : null,
      }
      rows.push(row)
      all.push({ marker, stateKey: kitStateKey(row)!, row })
    } else {
      kIdx++
      const tag = String(kIdx).padStart(2, '0')
      const marker = `[K${tag}]`
      const row: KitRow = {
        kind: 'skill',
        section: 'skill',
        name: `${marker} skl-${tag}`,
        source: 'project',
        extension: hasExt && spec.ownedByExt ? extName : null,
      }
      rows.push(row)
      all.push({ marker, stateKey: kitStateKey(row)!, row })
    }
  }
  const byMarker = new Map(all.map(b => [b.marker, b]))
  return { catalogue: { rows }, byMarker, all }
}

function focusedKitMarkers(frame: string): { pointerLines: string[]; uniqueMarkers: string[] } {
  const pointerLines = frame.split('\n').filter(line => line.includes('❯ '))
  const markers = new Set<string>()
  for (const line of pointerLines) {
    const found = line.match(/\[[MKE]\d{2}\]/g)
    if (found) for (const m of found) markers.add(m)
  }
  return { pointerLines, uniqueMarkers: [...markers] }
}

async function mountKit(viewport: { cols: number; rows: number }, catalogue: KitCatalogue, store: KitMenuStore): Promise<string> {
  stdout.columns = viewport.cols
  stdout.rows = viewport.rows
  closedCount = 0
  writeLog = []
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
          { value: { columns: viewport.cols, rows: viewport.rows } },
          h(
            KeybindingSetup,
            {},
            h(
              Box,
              { width: viewport.cols, height: viewport.rows, flexDirection: 'column' },
              h(KitMenuScreen, {
                key: `kit-run-${runSeq}`,
                fullScene: { columns: viewport.cols, rows: viewport.rows },
                catalogue,
                store,
                workspaceDir: fixtureRoot,
                onClose: () => {
                  closedCount += 1
                },
              }),
            ),
          ),
        ),
      ),
    ),
  )
  return settleFrame()
}

async function runKitScenario(scenario: KitScenario): Promise<void> {
  const { catalogue, byMarker } = buildCatalogue(scenario.hasExt, scenario.members)
  const { store } = makeMemoryStore()
  const listRows = sectionRows(catalogue)
  let frame = await mountKit(scenario.viewport, catalogue, store)
  if (!frame.includes('mcps & skills')) {
    throw new Error(`KitMenuScreen did not paint title:\n${frame}`)
  }
  const hasSummaryBox = frame.includes('Applies')

  const assertPointerInvariant = (phase: string, current: string, expectedWrites: number): BuiltRow => {
    if (closedCount !== 0) throw new Error(`${phase}: closed before Escape (closed=${closedCount})`)
    if (writeLog.length !== expectedWrites) {
      throw new Error(`${phase}: unexpected store writes=${writeLog.length}, expected ${expectedWrites}`)
    }
    const { pointerLines, uniqueMarkers } = focusedKitMarkers(current)
    const expectedPointers = 1
    if (pointerLines.length !== expectedPointers || uniqueMarkers.length !== 1) {
      throw new Error(`${phase}: expected ${expectedPointers} pointer line(s) agreeing on 1 member marker, got lines=${pointerLines.length} unique=${uniqueMarkers.join(',')}:\n${current}`)
    }
    const built = byMarker.get(uniqueMarkers[0]!)
    if (!built) throw new Error(`${phase}: focused marker ${uniqueMarkers[0]} not in generated members`)
    if (hasSummaryBox) {
      const counts = kitCounts(listRows, store.read(fixtureRoot))
      const mcpLine = `${counts.mcp.on} on · ${counts.mcp.off} off`
      const skillLine = `${counts.skill.on} on · ${counts.skill.invocable} invocable · ${counts.skill.off} off`
      if (!current.includes(mcpLine) || !current.includes(skillLine)) {
        throw new Error(`${phase}: painted NEXT SESSION counts disagreed with kitCounts (${mcpLine} | ${skillLine}):\n${current}`)
      }
    }
    return built
  }

  let focused = assertPointerInvariant('mount', frame, 0)

  for (let i = 0; i < scenario.steps.length; i++) {
    const key = scenario.steps[i]!
    frame = await sendKey(KEYS[key])
    focused = assertPointerInvariant(`step[${i}]:${key}`, frame, 0)
  }

  if (scenario.closeOnly) {
    await sendKey(KEYS.esc)
    if (closedCount !== 1 || writeLog.length !== 0) {
      throw new Error(`Esc close expected closed=1 writes=0, got closed=${closedCount} writes=${writeLog.length}`)
    }
    return
  }

  const beforeView = kitRowView(focused.row, store.read(fixtureRoot))
  const expectedNext: KitRowState =
    scenario.toggle === 'backspace'
      ? 'on'
      : cycleState(focused.row, beforeView.own, scenario.toggle === 'left' ? -1 : 1)

  frame = await sendKey(KEYS[scenario.toggle])
  if (closedCount !== 0) throw new Error(`toggle ${scenario.toggle} closed screen unexpectedly`)
  if (writeLog.length !== 1) {
    throw new Error(`toggle ${scenario.toggle} on ${focused.marker} expected 1 store write, got ${writeLog.length}`)
  }
  const written = writeLog[0]!
  if (written.key !== focused.stateKey) {
    throw new Error(`wrong kit row toggled: painted row ${focused.marker} (${focused.stateKey}) != written (${written.key})`)
  }
  if (written.next !== expectedNext) {
    throw new Error(`wrong toggled state for ${focused.marker}: expected ${expectedNext}, got ${written.next}`)
  }
  assertPointerInvariant(`after-${scenario.toggle}`, frame, 1)

  await sendKey(KEYS.esc)
  if (closedCount !== 1) throw new Error(`Esc after toggle did not close KitMenuScreen (closed=${closedCount})`)
}

const memberSpecArb: fc.Arbitrary<MemberSpec> = fc.record({
  kind: fc.constantFrom('mcp' as const, 'skill' as const),
  ownedByExt: fc.boolean(),
})

const navKeyArb: fc.Arbitrary<NavKey> = fc.constantFrom('down', 'up', 'pgdn', 'pgup', 'home', 'end')
const toggleKeyArb: fc.Arbitrary<ToggleKey> = fc.constantFrom('enter', 'space', 'right', 'left', 'backspace')
const viewportArb = fc.constantFrom({ cols: 120, rows: 40 }, { cols: 90, rows: 24 })

const scenarioArb: fc.Arbitrary<KitScenario> = fc.record({
  hasExt: fc.boolean(),
  members: fc.array(memberSpecArb, { minLength: 1, maxLength: 10 }),
  viewport: viewportArb,
  steps: fc.array(navKeyArb, { minLength: 0, maxLength: 10 }),
  toggle: toggleKeyArb,
  closeOnly: fc.boolean(),
})

const t = checker()
const SEED_MAIN = 20261141
const SEED_LAYERS = 20261142
const SEED_FAULT = 20261143

try {
  t.section('§1 — KitMenuScreen: highlighted row matches toggled store key, counts stay truthful, Esc closes')
  {
    const result = await fc.check(
      fc.asyncProperty(scenarioArb, async scenario => {
        await runKitScenario(scenario)
      }),
      { numRuns: 60, seed: SEED_MAIN },
    )
    t.check(
      `60 generated kit catalogue/key scenarios held toggle identity, summary counts, and Esc laws (seed ${SEED_MAIN})`,
      !result.failed,
      result.failed ? `path=${result.counterexamplePath} error=${String(result.errorInstance)}` : '',
    )
  }

  t.section('§2 — KitMenuScreen: preset prompt & presets layer Esc unwind + extension master-off + empty catalogue')
  {
    const layerArb = fc.record({
      members: fc.array(memberSpecArb, { minLength: 1, maxLength: 6 }),
      typed: fc.stringMatching(/^[a-z0-9]{1,6}$/),
      layer: fc.constantFrom('prompt' as const, 'presets' as const),
    })
    const result = await fc.check(
      fc.asyncProperty(layerArb, async ({ members, typed, layer }) => {
        const { catalogue } = buildCatalogue(true, members)
        const { store } = makeMemoryStore()
        let frame = await mountKit({ cols: 120, rows: 40 }, catalogue, store)
        if (layer === 'prompt') {
          frame = await sendKey('p')
          if (!frame.includes('save as preset') || closedCount !== 0) {
            throw new Error(`pressing p did not open preset save prompt:\n${frame}`)
          }
          for (const ch of typed) frame = await sendKey(ch)
          if (!frame.includes(`name: ${typed}`) || closedCount !== 0) {
            throw new Error(`typing '${typed}' in preset prompt did not paint draft`)
          }
          frame = await sendKey(KEYS.esc)
          if (closedCount !== 0 || !frame.includes('mcps & skills')) {
            throw new Error(`Esc in preset prompt did not return cleanly to main kit menu`)
          }
        } else {
          frame = await sendKey('w')
          if (!frame.includes('saved presets') || closedCount !== 0) {
            throw new Error(`pressing w did not open presets layer:\n${frame}`)
          }
          frame = await sendKey(KEYS.esc)
          if (closedCount !== 0 || !frame.includes('mcps & skills')) {
            throw new Error(`Esc in presets layer did not return cleanly to main kit menu`)
          }
        }
        await sendKey(KEYS.esc)
        if (closedCount !== 1 || writeLog.length !== 0) {
          throw new Error(`Esc after leaving ${layer} did not close cleanly (closed=${closedCount}, writes=${writeLog.length})`)
        }
      }),
      { numRuns: 25, seed: SEED_LAYERS },
    )
    t.check(
      `25 generated preset-prompt & presets-layer Esc sequences returned to menu then closed cleanly (seed ${SEED_LAYERS})`,
      !result.failed,
      result.failed ? `path=${result.counterexamplePath} error=${String(result.errorInstance)}` : '',
    )

    const { catalogue: masterCat } = buildCatalogue(true, [{ kind: 'mcp', ownedByExt: true }])
    const { store: masterStore } = makeMemoryStore()
    let masterFrame = await mountKit({ cols: 120, rows: 40 }, masterCat, masterStore)
    masterFrame = await sendKey(KEYS.enter)
    masterFrame = await sendKey(KEYS.down)
    const writesBeforeBlocked = writeLog.length
    masterFrame = await sendKey(KEYS.enter)
    const masterOffHeld =
      writesBeforeBlocked === 1 &&
      writeLog.length === 1 &&
      masterFrame.includes('off (extension)') &&
      closedCount === 0
    await sendKey(KEYS.esc)
    t.check(
      'turning an extension off blocks toggling its child server (master-off law) and Esc closes',
      masterOffHeld && closedCount === 1,
      `writesBefore=${writesBeforeBlocked} writesAfter=${writeLog.length} closed=${closedCount}`,
    )

    const { store: emptyStore } = makeMemoryStore()
    const emptyFrame = await mountKit({ cols: 120, rows: 40 }, { rows: [] }, emptyStore)
    await sendKey(KEYS.enter)
    const enterNoop = writeLog.length === 0 && closedCount === 0
    await sendKey(KEYS.esc)
    t.check(
      'empty kit catalogue ignores Enter (0 writes) and closes cleanly on Esc',
      emptyFrame.includes('nothing to toggle yet') && enterNoop && closedCount === 1,
      `enterNoop=${enterNoop} closed=${closedCount}`,
    )
  }

  t.section('§3 — Wrong toggled row produces a shrunk replayable counterexample with seed and path')
  {
    const faultScenarioArb: fc.Arbitrary<KitScenario> = fc.record({
      hasExt: fc.constant(false),
      members: fc.array(fc.constant({ kind: 'mcp' as const, ownedByExt: false }), { minLength: 2, maxLength: 8 }),
      viewport: fc.constant({ cols: 120, rows: 40 }),
      steps: fc.array(fc.constantFrom('down' as const, 'up' as const, 'end' as const), { minLength: 1, maxLength: 6 }),
      toggle: fc.constant('enter' as const),
      closeOnly: fc.constant(false),
    })
    const faultyProp = fc.asyncProperty(faultScenarioArb, async scenario => {
      faultRewriteKey = () => 'mcp:[M01] srv-01'
      try {
        await runKitScenario(scenario)
      } finally {
        faultRewriteKey = null
      }
    })
    const caught = await fc.check(faultyProp, { numRuns: 40, seed: SEED_FAULT })
    const shrinkPath = caught.counterexamplePath ?? ''
    t.check(
      `fault-injected wrong kit toggle failed with seed ${SEED_FAULT} and shrink path`,
      caught.failed && caught.seed === SEED_FAULT && shrinkPath.length > 0,
      `failed=${caught.failed} path=${shrinkPath}`,
    )
    const minimized = caught.counterexample?.[0]
    t.check(
      'shrunk counterexample is short (<= 3 members, <= 3 steps)',
      minimized !== undefined && minimized.members.length <= 3 && minimized.steps.length <= 3,
      minimized ? `members=${minimized.members.length} steps=${minimized.steps.length} shrinks=${caught.numShrinks}` : 'none',
    )
    const replay = await fc.check(faultyProp, { seed: caught.seed, path: shrinkPath, endOnFailure: true })
    t.check(
      `replaying seed=${caught.seed} path=${shrinkPath} reproduced identical wrong-row toggle failure`,
      replay.failed &&
        JSON.stringify(replay.counterexample) === JSON.stringify(caught.counterexample) &&
        String(replay.errorInstance).includes('wrong kit row toggled:'),
      `replay.failed=${replay.failed} err=${String(replay.errorInstance).slice(0, 140)}`,
    )
    const cleanReplay = await fc.check(
      fc.asyncProperty(faultScenarioArb, async scenario => {
        await runKitScenario(scenario)
      }),
      { seed: caught.seed, path: shrinkPath, endOnFailure: true },
    )
    t.check(
      `unmodified KitMenuScreen passed exact counterexample replay (seed=${caught.seed} path=${shrinkPath})`,
      !cleanReplay.failed,
      cleanReplay.failed ? String(cleanReplay.errorInstance) : '',
    )
  }
} finally {
  faultRewriteKey = null
  ink.unmount()
  instances.delete(stdout as never)
  disposeKeybindingWatcher()
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}

t.finish('screen-properties-kit')
