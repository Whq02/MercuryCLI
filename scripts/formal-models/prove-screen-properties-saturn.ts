#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import stripAnsi from 'strip-ansi'
import { checker } from '../engine-durability/harness.ts'

const previousCwd = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'mercury-screen-props-saturn-'))
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

type CapturedRpc = {
  op: string
  action?: string
  sessionId?: string
  targetSessionId?: string
  resumeSessionId?: string
  prompt?: string
  scheduleEdit?: { op: string; scheduleId: string }
}

let rpcCalls: CapturedRpc[] = []
let faultRewriteScheduleId: ((id: string) => string) | null = null

const realControl = await import('../../src/daemon/control/controlSocket.ts')
mock.module('../../src/daemon/control/controlSocket.ts', () => ({
  ...realControl,
  daemonControlRpc: async (req: CapturedRpc) => {
    const captured: CapturedRpc = req.scheduleEdit
      ? {
          ...req,
          scheduleEdit: {
            ...req.scheduleEdit,
            scheduleId: faultRewriteScheduleId ? faultRewriteScheduleId(req.scheduleEdit.scheduleId) : req.scheduleEdit.scheduleId,
          },
        }
      : { ...req }
    rpcCalls.push(captured)
    return { ok: true, op: req.op, outcome: 'applied', detail: 'fixture' }
  },
}))

const realSaturnAccount = await import('../../src/daemon/saturn/saturnAccount.ts')
mock.module('../../src/daemon/saturn/saturnAccount.ts', () => ({
  ...realSaturnAccount,
  deriveScheduleAccountForModel: () => ({
    ok: true as const,
    account: { family: 'anthropic', source: 'oauth' as const, identity: 'op@fixture' },
  }),
  readLiveAccountFacts: () => ({
    signedIn: true,
    expired: false,
    rateLimited: false,
  }),
  scheduleAccountVerdict: () => ({ state: 'ready' as const }),
}))

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { registerBootDoors } = await import('../../src/boot/doors/registerDoors.ts')
registerBootDoors()

const { readBoxSchedules, addBoxSchedule, removeBoxSchedule, setBoxSchedulePaused } = await import(
  '../../src/daemon/saturn/saturnBoxSchedules.ts'
)
const { BootSaturnScreen, sortForBoard } = await import('../../src/screen/boot-face/BootSaturnScreen.tsx')
type SaturnScreenFactsV1 = import('../../src/screen/boot-face/BootSaturnScreen.tsx').SaturnScreenFactsV1
type SaturnScreenRowV1 = import('../../src/screen/boot-face/BootSaturnScreen.tsx').SaturnScreenRowV1
const { default: ScreenInstance } = await import('../../src/screen/renderer/screenInstance.js')
const { default: instances } = await import('../../src/screen/renderer/instances.js')
const { default: reconciler } = await import('../../src/screen/renderer/reconciler.js')
const { disposeKeybindingWatcher } = await import('../../src/screen/keys/loadUserBindings.js')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { TerminalSizeContext } = await import('../../src/screen/renderer/elements/TerminalSizeContext.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')

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
  enter: '\x1b[13u',
  backspace: '\x7f',
  esc: '\x1b[27u',
  add: 'a',
  del: 'x',
  runNow: 'n',
  pause: 'p',
  refresh: 'r',
  submit: 's',
} as const

type NavKey = 'down' | 'up' | 'pgdn' | 'pgup' | 'home' | 'end'
type BoardEnding = 'pause' | 'delete' | 'run-now' | 'esc'

type RowSpec = {
  kind: 'session-fire' | 'box-birth'
  paused: boolean
  parked: boolean
  offsetMin: number
  heldCount: number
}

type BoardScenario = {
  cols: number
  rows: number
  specs: RowSpec[]
  steps: NavKey[]
  ending: BoardEnding
}

const FIXED_NOW = Date.UTC(2026, 10, 21, 12, 0, 0)

function clearBoxFile(): void {
  for (const s of readBoxSchedules().schedules) {
    removeBoxSchedule(s.id)
  }
}

function buildFacts(specs: readonly RowSpec[]): {
  facts: SaturnScreenFactsV1
  byId: Map<string, SaturnScreenRowV1>
} {
  clearBoxFile()
  const built: SaturnScreenRowV1[] = []
  let heldTotal = 0
  let sessionCount = 0

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!
    const nextFireMs = FIXED_NOW + (spec.offsetMin + 1) * 60_000
    const account = { family: 'anthropic', source: 'oauth' as const, identity: 'op@fixture' }
    if (spec.kind === 'box-birth') {
      const added = addBoxSchedule(
        {
          when: { kind: 'at', atMs: nextFireMs, spelling: `in ${spec.offsetMin + 1}m` },
          action: {
            kind: 'birth',
            birth: {
              workspaceDir: fixtureRoot,
              modelKey: 'claude-opus-5',
              presence: 'headless',
            },
          },
          note: `box-${i}`,
        },
        'operator:saturn-props',
        {
          deriveAccount: () => ({ ok: true as const, account }),
          preflight: () => ({ state: 'ready' as const }),
        },
      )
      if (!added.ok) throw new Error(`failed to seed box schedule: ${added.reason}`)
      if (spec.paused) setBoxSchedulePaused(added.id, true)
      const stored = readBoxSchedules().schedules.find(s => s.id === added.id)!
      const schedule = stored
      const held = Array.from({ length: spec.heldCount }, (_, k) => ({
        scheduleId: schedule.id,
        dueAt: FIXED_NOW - (k + 1) * 60_000,
        heldAt: FIXED_NOW - (k + 1) * 60_000,
        reason: 'sign-in-expired' as const,
        envelope: {
          schema: 1 as const,
          scheduleId: schedule.id,
          dueAt: FIXED_NOW - (k + 1) * 60_000,
          kind: 'birth' as const,
          birth: {
            workspaceDir: fixtureRoot,
            modelKey: 'claude-opus-5',
            presence: 'headless' as const,
          },
        },
      }))
      heldTotal += held.length
      built.push({
        sessionTitle: 'box',
        sessionId: `box:${schedule.id}`,
        workspaceId: fixtureRoot,
        parked: false,
        box: true,
        facts: {
          id: schedule.id,
          kind: 'birth',
          when: `in ${spec.offsetMin + 1}m`,
          nextFireMs: spec.paused ? null : nextFireMs,
          ...(spec.paused ? { paused: true as const } : {}),
        },
        schedule,
        held,
      })
    } else {
      sessionCount++
      const id = `sc${String(i + 1).padStart(2, '0')}aa`
      const sessionId = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`
      const prompt = `run check ${id}`
      const schedule = {
        schema: 1 as const,
        id,
        when: { kind: 'at' as const, atMs: nextFireMs, spelling: `in ${spec.offsetMin + 1}m` },
        action: { kind: 'fire' as const, prompt },
        modelKey: 'claude-opus-5',
        account,
        createdAt: FIXED_NOW - 60_000,
        createdBy: 'operator:saturn-props',
        ...(spec.paused ? { paused: true as const } : {}),
      }
      const held = Array.from({ length: spec.heldCount }, (_, k) => ({
        scheduleId: id,
        dueAt: FIXED_NOW - (k + 1) * 60_000,
        heldAt: FIXED_NOW - (k + 1) * 60_000,
        reason: 'sign-in-expired' as const,
        envelope: {
          schema: 1 as const,
          scheduleId: id,
          dueAt: FIXED_NOW - (k + 1) * 60_000,
          kind: 'fire' as const,
          prompt,
        },
      }))
      heldTotal += held.length
      built.push({
        sessionTitle: `lane-${i + 1}`,
        sessionId,
        workspaceId: fixtureRoot,
        parked: spec.parked,
        facts: {
          id,
          kind: 'fire',
          when: `in ${spec.offsetMin + 1}m`,
          nextFireMs: spec.paused ? null : nextFireMs,
          ...(spec.paused ? { paused: true as const } : {}),
        },
        schedule,
        held,
      })
    }
  }
  const sorted = sortForBoard(built)
  const byId = new Map(sorted.map(row => [row.facts.id, row]))
  return {
    facts: {
      rows: sorted,
      heldTotal,
      sessions: sessionCount,
      daemonReadable: true,
    },
    byId,
  }
}

const stdout = new FakeStdout(136, 40)
const stdin = new FakeStdin()
const ink = new ScreenInstance({
  stdout: stdout as never,
  stdin: stdin as never,
  stderr: new FakeStdout(136, 40) as never,
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

function focusedScheduleIdsOf(frame: string, knownIds: readonly string[]): string[] {
  const ordered = [...knownIds].sort((a, b) => b.length - a.length)
  const hits: string[] = []
  for (const line of frame.split('\n')) {
    let idx = line.indexOf('❯ ')
    while (idx >= 0) {
      const rest = line.slice(idx + 2).trimStart()
      const matched = ordered.find(id => rest.startsWith(id))
      if (matched) hits.push(matched)
      idx = line.indexOf('❯ ', idx + 2)
    }
  }
  return hits
}

let runSeq = 0
let closedCount = 0

async function mountSaturn(
  cols: number,
  rows: number,
  facts?: SaturnScreenFactsV1,
): Promise<string> {
  closedCount = 0
  rpcCalls = []
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
              h(BootSaturnScreen, {
                key: `saturn-run-${runSeq}`,
                fullScene: { columns: cols, rows },
                ...(facts !== undefined ? { facts } : {}),
                nowMs: FIXED_NOW,
                receiptsOf: () => [],
                modelOptionsOf: () => ['claude-opus-5', 'gpt-5-codex'],
                presetsOf: () => ['default-kit', 'minimal-kit'],
                projectsOf: () => [fixtureRoot],
                preflightOf: () => ({
                  derivation: { ok: true as const, account: { family: 'anthropic', source: 'oauth' as const, identity: 'op@fixture' } },
                  verdict: { state: 'ready' as const },
                }),
                onClose: () => {
                  closedCount++
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

async function runBoardScenario(scenario: BoardScenario): Promise<void> {
  const { facts, byId } = buildFacts(scenario.specs)
  const knownIds = [...byId.keys()]
  let frame = await mountSaturn(scenario.cols, scenario.rows, facts)

  const checkPaintedRow = (phase: string, current: string): SaturnScreenRowV1 | null => {
    if (closedCount !== 0 || rpcCalls.length !== 0) {
      throw new Error(`${phase}: unexpected side effect before ending (closed=${closedCount}, rpcs=${rpcCalls.length})`)
    }
    if (knownIds.length === 0) {
      if (!current.includes('saturn scheduler')) {
        throw new Error(`${phase}: empty board did not paint saturn header:\n${current}`)
      }
      if (scenario.cols >= 120 && scenario.rows >= 40 && !current.includes('no live sessions hold schedules')) {
        throw new Error(`${phase}: wide empty board did not paint empty detail line:\n${current}`)
      }
      return null
    }
    const hits = focusedScheduleIdsOf(current, knownIds)
    const unique = [...new Set(hits)]
    if (unique.length !== 1) {
      throw new Error(`${phase}: expected 1 unique painted schedule id under ❯, got ${JSON.stringify(hits)}\n${current}`)
    }
    const row = byId.get(unique[0]!)
    if (!row) {
      throw new Error(`${phase}: painted schedule id '${unique[0]}' not in generated data`)
    }
    return row
  }

  let focused = checkPaintedRow('mount', frame)
  for (let i = 0; i < scenario.steps.length; i++) {
    const key = scenario.steps[i]!
    frame = await sendKey(KEYS[key])
    focused = checkPaintedRow(`step[${i}]:${key}`, frame)
  }

  if (scenario.ending === 'esc') {
    await sendKey(KEYS.esc)
    if (closedCount !== 1 || rpcCalls.length !== 0) {
      throw new Error(`Esc expected closed=1 rpcs=0, got closed=${closedCount} rpcs=${rpcCalls.length}`)
    }
    return
  }

  if (focused === null) {
    const key = scenario.ending === 'pause' ? KEYS.pause : scenario.ending === 'delete' ? KEYS.del : KEYS.runNow
    await sendKey(key)
    if (closedCount !== 0 || rpcCalls.length !== 0) {
      throw new Error(`${scenario.ending} on empty board triggered side effect (closed=${closedCount}, rpcs=${rpcCalls.length})`)
    }
    return
  }

  if (scenario.ending === 'pause') {
    const beforeBoxIds = readBoxSchedules().schedules.map(s => s.id)
    frame = await sendKey(KEYS.pause)
    if (closedCount !== 0) throw new Error(`pause unexpectedly closed Saturn`)
    if (focused.box === true) {
      if (rpcCalls.length !== 0) throw new Error(`pause on box schedule sent daemon RPC`)
      const stored = readBoxSchedules().schedules.find(s => s.id === focused.facts.id)
      if (!stored || Boolean(stored.paused) !== (focused.facts.paused !== true)) {
        throw new Error(`pause on box schedule '${focused.facts.id}' did not persist paused=${focused.facts.paused !== true}`)
      }
      if (readBoxSchedules().schedules.map(s => s.id).join(',') !== beforeBoxIds.join(',')) {
        throw new Error(`pause on box schedule altered schedule roster`)
      }
    } else {
      if (rpcCalls.length !== 1) {
        throw new Error(`pause on '${focused.facts.id}' sent ${rpcCalls.length} RPCs, expected 1`)
      }
      const rpc = rpcCalls[0]!
      const expectedOp = focused.facts.paused ? 'resume' : 'pause'
      if (
        rpc.op !== 'sessionControl' ||
        rpc.action !== 'set-schedule' ||
        rpc.sessionId !== focused.sessionId ||
        rpc.scheduleEdit?.op !== expectedOp ||
        rpc.scheduleEdit?.scheduleId !== focused.facts.id
      ) {
        throw new Error(
          `wrong schedule targeted on pause: painted '${focused.facts.id}' (${focused.sessionId}, ${expectedOp}) != rpc ${JSON.stringify(rpc)}`,
        )
      }
    }
    return
  }

  if (scenario.ending === 'delete') {
    const beforeBoxIds = readBoxSchedules().schedules.map(s => s.id)
    frame = await sendKey(KEYS.del)
    if (closedCount !== 0) throw new Error(`delete unexpectedly closed Saturn`)
    if (focused.box === true) {
      if (rpcCalls.length !== 0) throw new Error(`delete on box schedule sent daemon RPC`)
      const afterBoxIds = readBoxSchedules().schedules.map(s => s.id)
      const expectedBoxIds = beforeBoxIds.filter(id => id !== focused.facts.id)
      if (afterBoxIds.join(',') !== expectedBoxIds.join(',')) {
        throw new Error(`delete on box schedule '${focused.facts.id}' left wrong ids: expected ${JSON.stringify(expectedBoxIds)}, got ${JSON.stringify(afterBoxIds)}`)
      }
    } else {
      if (rpcCalls.length !== 1) {
        throw new Error(`delete on '${focused.facts.id}' sent ${rpcCalls.length} RPCs, expected 1`)
      }
      const rpc = rpcCalls[0]!
      if (
        rpc.op !== 'sessionControl' ||
        rpc.action !== 'set-schedule' ||
        rpc.sessionId !== focused.sessionId ||
        rpc.scheduleEdit?.op !== 'remove' ||
        rpc.scheduleEdit?.scheduleId !== focused.facts.id
      ) {
        throw new Error(
          `wrong schedule targeted on delete: painted '${focused.facts.id}' (${focused.sessionId}) != rpc ${JSON.stringify(rpc)}`,
        )
      }
    }
    return
  }

  frame = await sendKey(KEYS.runNow)
  if (closedCount !== 0) throw new Error(`run-now unexpectedly closed Saturn`)
  if (focused.schedule.action.kind !== 'fire') {
    if (rpcCalls.length !== 0) {
      throw new Error(`run-now on birth schedule '${focused.facts.id}' sent RPC`)
    }
    return
  }
  if (rpcCalls.length !== 1) {
    throw new Error(`run-now on fire schedule '${focused.facts.id}' sent ${rpcCalls.length} RPCs, expected 1`)
  }
  const rpc = rpcCalls[0]!
  const targetField = focused.parked ? rpc.resumeSessionId : rpc.targetSessionId
  if (rpc.op !== 'sessionDispatch' || rpc.prompt !== focused.schedule.action.prompt || targetField !== focused.sessionId) {
    throw new Error(
      `wrong schedule run-now: painted '${focused.facts.id}' (${focused.sessionId}) != rpc ${JSON.stringify(rpc)}`,
    )
  }
}

const rowSpecArb: fc.Arbitrary<RowSpec> = fc.record({
  kind: fc.constantFrom('session-fire' as const, 'box-birth' as const),
  paused: fc.boolean(),
  parked: fc.boolean(),
  offsetMin: fc.integer({ min: 1, max: 180 }),
  heldCount: fc.integer({ min: 0, max: 2 }),
})

const navKeyArb: fc.Arbitrary<NavKey> = fc.constantFrom('down', 'up', 'pgdn', 'pgup', 'home', 'end')

const boardScenarioArb: fc.Arbitrary<BoardScenario> = fc.record({
  cols: fc.constantFrom(100, 136),
  rows: fc.constantFrom(28, 40),
  specs: fc.array(rowSpecArb, { minLength: 0, maxLength: 8 }),
  steps: fc.array(navKeyArb, { minLength: 0, maxLength: 12 }),
  ending: fc.constantFrom('pause' as const, 'delete' as const, 'run-now' as const, 'esc' as const),
})

const t = checker()
const SEED_BOARD = 20261151
const SEED_FORM = 20261152
const SEED_FAULT = 20261153

try {
  t.section('§1 — BootSaturnScreen (saturn): painted highlighted schedule matches pause/delete/run-now target and Esc leaves')
  {
    const result = await fc.check(
      fc.asyncProperty(boardScenarioArb, async scenario => {
        await runBoardScenario(scenario)
      }),
      { numRuns: 50, seed: SEED_BOARD },
    )
    t.check(
      `50 generated schedule/key scenarios held painted-row action identity & Esc laws (seed ${SEED_BOARD})`,
      !result.failed,
      result.failed ? `path=${result.counterexamplePath} error=${String(result.errorInstance)}` : '',
    )

    clearBoxFile()
    const unreadableFacts: SaturnScreenFactsV1 = { rows: [], heldTotal: 0, sessions: 0, daemonReadable: false }
    let unreadableFrame = await mountSaturn(136, 40, unreadableFacts)
    const showsUnreadable = unreadableFrame.includes("the daemon's records are not readable here")
    await sendKey(KEYS.esc)
    t.check(
      'unreadable daemon records state paints honest message and still leaves on Esc',
      showsUnreadable && closedCount === 1 && rpcCalls.length === 0,
      `showsUnreadable=${showsUnreadable} closedCount=${closedCount} rpcs=${rpcCalls.length}`,
    )
  }

  t.section('§2 — BootSaturnScreen (saturn): birth form and nested prompt/picker stage Esc and validate submit')
  {
    const formArb = fc.record({
      formMoves: fc.array(fc.constantFrom('down' as const, 'up' as const), { minLength: 0, maxLength: 8 }),
      whenSpelling: fc.constantFrom('in 2h', 'in 45m', 'every 1h'),
      commitSchedule: fc.boolean(),
    })

    const result = await fc.check(
      fc.asyncProperty(formArb, async ({ formMoves, whenSpelling, commitSchedule }) => {
        clearBoxFile()
        const emptyFacts: SaturnScreenFactsV1 = { rows: [], heldTotal: 0, sessions: 0, daemonReadable: true }
        let frame = await mountSaturn(136, 44, emptyFacts)
        frame = await sendKey(KEYS.add)
        if (!frame.includes('schedule a birth') || closedCount !== 0) {
          throw new Error(`pressing 'a' did not open birth form (closed=${closedCount}):\n${frame}`)
        }
        frame = await sendKey(KEYS.submit)
        if (!frame.includes('say when first') || readBoxSchedules().schedules.length !== 0) {
          throw new Error(`submitting empty When did not refuse cleanly:\n${frame}`)
        }
        for (const move of formMoves) {
          frame = await sendKey(KEYS[move])
        }
        frame = await sendKey(KEYS.home)
        frame = await sendKey(KEYS.enter)
        if (!frame.includes('type · ↵ set · esc cancel')) {
          throw new Error(`Enter on When row did not open text prompt`)
        }
        for (const ch of 'banana') frame = await sendKey(ch)
        frame = await sendKey(KEYS.esc)
        if (!frame.includes('s schedule it') || closedCount !== 0) {
          throw new Error(`Esc inside prompt did not return to form without closing Saturn`)
        }
        frame = await sendKey(KEYS.down)
        frame = await sendKey(KEYS.enter)
        if (!frame.includes('↵ pick · esc back')) {
          throw new Error(`Enter on Model row did not open picker`)
        }
        frame = await sendKey(KEYS.esc)
        if (!frame.includes('s schedule it') || closedCount !== 0) {
          throw new Error(`Esc inside picker did not return to form without closing Saturn`)
        }
        if (commitSchedule) {
          frame = await sendKey(KEYS.home)
          frame = await sendKey(KEYS.enter)
          for (const ch of whenSpelling) frame = await sendKey(ch)
          frame = await sendKey(KEYS.enter)
          frame = await sendKey(KEYS.submit)
          if (readBoxSchedules().schedules.length !== 1 || closedCount !== 0) {
            throw new Error(`submitting valid '${whenSpelling}' did not write 1 box schedule and return to board`)
          }
          await sendKey(KEYS.esc)
          if (closedCount !== 1) {
            throw new Error(`Esc from board after submit did not close Saturn (closed=${closedCount})`)
          }
        } else {
          frame = await sendKey(KEYS.esc)
          if (closedCount !== 0 || frame.includes('s schedule it') || readBoxSchedules().schedules.length !== 0) {
            throw new Error(`Esc from form did not return to board cleanly (closed=${closedCount})`)
          }
          await sendKey(KEYS.esc)
          if (closedCount !== 1) {
            throw new Error(`second Esc from board did not close Saturn (closed=${closedCount})`)
          }
        }
      }),
      { numRuns: 20, seed: SEED_FORM },
    )
    t.check(
      `20 generated birth-form sequences held nested Esc staging and submit validation (seed ${SEED_FORM})`,
      !result.failed,
      result.failed ? `path=${result.counterexamplePath} error=${String(result.errorInstance)}` : '',
    )
  }

  t.section('§3 — Wrong schedule target shrinks to a replayable minimal counterexample with seed and path')
  {
    const faultScenarioArb: fc.Arbitrary<BoardScenario> = fc.record({
      cols: fc.constant(136),
      rows: fc.constant(40),
      specs: fc.array(
        fc.record({
          kind: fc.constant('session-fire' as const),
          paused: fc.constant(false),
          parked: fc.constant(false),
          offsetMin: fc.integer({ min: 1, max: 60 }),
          heldCount: fc.constant(0),
        }),
        { minLength: 2, maxLength: 6 },
      ),
      steps: fc.array(fc.constantFrom('down' as const, 'up' as const, 'end' as const), { minLength: 1, maxLength: 6 }),
      ending: fc.constant('delete' as const),
    })

    const faultyProp = fc.asyncProperty(faultScenarioArb, async scenario => {
      const { facts } = buildFacts(scenario.specs)
      const firstId = facts.rows[0]!.facts.id
      faultRewriteScheduleId = () => firstId
      try {
        await runBoardScenario(scenario)
      } finally {
        faultRewriteScheduleId = null
      }
    })

    const caught = await fc.check(faultyProp, { numRuns: 40, seed: SEED_FAULT })
    const shrinkPath = caught.counterexamplePath ?? ''
    t.check(
      `fault-injected wrong schedule target failed with seed ${SEED_FAULT} and shrink path`,
      caught.failed && caught.seed === SEED_FAULT && shrinkPath.length > 0,
      `failed=${caught.failed} path=${shrinkPath}`,
    )

    const minimized = caught.counterexample?.[0]
    t.check(
      'shrunk counterexample is minimal (<= 3 schedules, <= 2 steps)',
      minimized !== undefined && minimized.specs.length <= 3 && minimized.steps.length <= 2,
      minimized ? `specs=${minimized.specs.length} steps=${JSON.stringify(minimized.steps)} shrinks=${caught.numShrinks}` : 'no counterexample',
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
        String(replay.errorInstance).includes('wrong schedule targeted on delete:'),
      `replay.failed=${replay.failed} err=${String(replay.errorInstance).slice(0, 140)}`,
    )

    const cleanReplay = await fc.check(
      fc.asyncProperty(faultScenarioArb, async scenario => {
        await runBoardScenario(scenario)
      }),
      { seed: caught.seed, path: shrinkPath, endOnFailure: true },
    )
    t.check(
      `unmodified BootSaturnScreen passed exact counterexample replay (seed=${caught.seed} path=${shrinkPath})`,
      !cleanReplay.failed,
      cleanReplay.failed ? String(cleanReplay.errorInstance) : '',
    )
  }
} finally {
  faultRewriteScheduleId = null
  ink.unmount()
  instances.delete(stdout as never)
  disposeKeybindingWatcher()
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}

t.finish('screen-properties-saturn')
