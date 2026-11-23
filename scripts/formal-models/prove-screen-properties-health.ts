#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import stripAnsi from 'strip-ansi'
import { checker } from '../engine-durability/harness.ts'
import type { HealthCertificate, HealthCheck, HealthSection, HealthStatus, RemedyClass } from '../../src/platform/health/healthCertCore.ts'

const previousCwd = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'mercury-screen-health-'))
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
process.env.MERCURY_HEALTH_FIX = '1'
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
const { BootHealthScreen } = await import('../../src/screen/boot-face/BootHealthScreen.tsx')
const { isFixable, verdictFromStatuses } = await import('../../src/platform/health/healthCertCore.ts')

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
  esc: '\x1b[27u',
} as const

type NavKey = 'down' | 'up' | 'pgdn' | 'pgup' | 'home' | 'end'

type CheckSpec = {
  section: 0 | 1 | 2
  status: 'ok' | 'warn' | 'fail' | 'stale' | 'unknown'
  hasRemedy: boolean
  remedyClass: RemedyClass
}

type HealthScenario = {
  checks: CheckSpec[]
  viewport: { cols: number; rows: number }
  steps: NavKey[]
  ending: 'evidence' | 'fix-cancel' | 'fix-apply' | 'close'
}

type BuiltCheck = {
  marker: string
  evidenceToken: string
  check: HealthCheck
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
  ink.onRender()
  return stripAnsi(ink.lastFrameText())
}

async function sendKey(seq: string): Promise<string> {
  stdin.push(seq)
  return settleFrame()
}

let appliedIds: string[] = []
let closedCount = 0
let faultRewriteApplyId: ((checkId: string) => string) | null = null
let runSeq = 0

function buildCertificate(specs: readonly CheckSpec[]): {
  cert: HealthCertificate
  byMarker: Map<string, BuiltCheck>
  all: BuiltCheck[]
} {
  const sectionTitles = ['Runtime', 'Storage', 'Integrations'] as const
  const buckets: HealthCheck[][] = [[], [], []]
  const all: BuiltCheck[] = []
  specs.forEach((spec, idx) => {
    const tag = String(idx + 1).padStart(2, '0')
    const marker = `[H${tag}]`
    const evidenceToken = `EVH${tag}`
    const id = `chk-${tag}`
    const check: HealthCheck = {
      id,
      label: `${marker} probe-${tag}`,
      status: spec.status,
      evidence: `observed ${evidenceToken} status=${spec.status}`,
      ...(spec.status !== 'ok' ? { fix: `remedy for ${marker}` } : {}),
      ...(spec.hasRemedy
        ? {
            remedy: {
              plan: `apply ${spec.remedyClass} plan for ${marker}`,
              class: spec.remedyClass,
              apply: async () => {
                const targetId = faultRewriteApplyId ? faultRewriteApplyId(id) : id
                appliedIds.push(targetId)
                return { ok: true, note: `applied ${targetId}` }
              },
              verify: async () => ({ ok: true, note: `verified ${id}` }),
            },
          }
        : {}),
    }
    buckets[spec.section]!.push(check)
    all.push({ marker, evidenceToken, check })
  })
  const sections: HealthSection[] = buckets
    .map((checks, i) => ({ id: `sec-${i}`, title: sectionTitles[i]!, checks }))
    .filter(s => s.checks.length > 0)
  const flatStatuses: HealthStatus[] = sections.flatMap(s => s.checks.map(c => c.status))
  const cert: HealthCertificate = {
    verdict: verdictFromStatuses(flatStatuses),
    sections,
    ranAt: new Date(Date.UTC(2026, 10, 21, 5, 0, 0)).toISOString(),
    head: { sha: 'abcdef1234567890', branch: 'main', dirty: false },
    version: '1.0.12',
    durationMs: 12,
  }
  const byMarker = new Map(all.map(b => [b.marker, b]))
  return { cert, byMarker, all }
}

function focusedHealthMarkers(frame: string): { pointerLines: string[]; uniqueMarkers: string[] } {
  const pointerLines = frame.split('\n').filter(line => line.includes('❯ '))
  const markers = new Set<string>()
  for (const line of pointerLines) {
    const found = line.match(/\[H\d{2}\]/g)
    if (found) for (const m of found) markers.add(m)
  }
  return { pointerLines, uniqueMarkers: [...markers] }
}

async function mountHealth(viewport: { cols: number; rows: number }, cert: HealthCertificate): Promise<string> {
  stdout.columns = viewport.cols
  stdout.rows = viewport.rows
  appliedIds = []
  closedCount = 0
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
              h(BootHealthScreen, {
                key: `health-run-${runSeq}`,
                fullScene: { columns: viewport.cols, rows: viewport.rows },
                certificate: cert,
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

async function runHealthScenario(scenario: HealthScenario): Promise<void> {
  const { cert, byMarker } = buildCertificate(scenario.checks)
  let frame = await mountHealth(scenario.viewport, cert)
  if (!frame.includes('health check')) {
    throw new Error(`BootHealthScreen did not paint title:\n${frame}`)
  }
  const hasCertBox = frame.includes('CERTIFICATE')
  if (hasCertBox && !frame.includes(cert.verdict)) {
    throw new Error(`BootHealthScreen wide summary missing verdict=${cert.verdict}:\n${frame}`)
  }

  const assertPointerInvariant = (phase: string, current: string): BuiltCheck => {
    if (closedCount !== 0) throw new Error(`${phase}: closed before Escape (closedCount=${closedCount})`)
    if (appliedIds.length !== 0) throw new Error(`${phase}: remedy applied before confirm Enter (${appliedIds.join(',')})`)
    const { pointerLines, uniqueMarkers } = focusedHealthMarkers(current)
    const expectedPointers = hasCertBox ? 2 : 1
    if (pointerLines.length !== expectedPointers || uniqueMarkers.length !== 1) {
      throw new Error(`${phase}: expected ${expectedPointers} pointer line(s) agreeing on 1 marker, got lines=${pointerLines.length} unique=${uniqueMarkers.join(',')}:\n${current}`)
    }
    const built = byMarker.get(uniqueMarkers[0]!)
    if (!built) throw new Error(`${phase}: focused marker ${uniqueMarkers[0]} not in generated checks`)
    if (!current.includes(built.evidenceToken)) {
      throw new Error(`${phase}: painted frame missing evidence ${built.evidenceToken} for focused ${built.marker}:\n${current}`)
    }
    return built
  }

  let focused = assertPointerInvariant('mount', frame)

  for (let i = 0; i < scenario.steps.length; i++) {
    const key = scenario.steps[i]!
    frame = await sendKey(KEYS[key])
    focused = assertPointerInvariant(`step[${i}]:${key}`, frame)
  }

  if (scenario.ending === 'close') {
    await sendKey(KEYS.esc)
    if (closedCount !== 1 || appliedIds.length !== 0) {
      throw new Error(`Esc on list expected closedCount=1 applied=0, got closed=${closedCount} applied=${appliedIds.length}`)
    }
    return
  }

  if (scenario.ending === 'evidence') {
    frame = await sendKey(KEYS.enter)
    if (closedCount !== 0 || appliedIds.length !== 0) {
      throw new Error(`Enter evidence trail triggered close/apply (closed=${closedCount}, applied=${appliedIds.length})`)
    }
    if (!frame.includes(focused.evidenceToken) || !frame.includes('esc back')) {
      throw new Error(`evidence trail for ${focused.marker} missing ${focused.evidenceToken} or esc back:\n${frame}`)
    }
    frame = await sendKey(KEYS.esc)
    if (closedCount !== 0) throw new Error(`Esc from evidence trail closed whole screen instead of returning to list`)
    const afterBack = assertPointerInvariant('after-trail-esc', frame)
    if (afterBack.marker !== focused.marker) {
      throw new Error(`Esc from evidence trail moved focus from ${focused.marker} to ${afterBack.marker}`)
    }
    await sendKey(KEYS.esc)
    if (closedCount !== 1) throw new Error(`second Esc after trail did not close BootHealthScreen (closed=${closedCount})`)
    return
  }

  const fixable = isFixable(focused.check)
  frame = await sendKey('f')
  if (!fixable) {
    if (frame.includes('↵ apply · esc cancel') || appliedIds.length !== 0 || closedCount !== 0) {
      throw new Error(`pressing f on non-fixable ${focused.marker} (status=${focused.check.status}) opened confirm or had side effect`)
    }
    await sendKey(KEYS.esc)
    if (closedCount !== 1 || appliedIds.length !== 0) {
      throw new Error(`Esc after non-fixable f did not close cleanly (closed=${closedCount}, applied=${appliedIds.length})`)
    }
    return
  }

  if (!frame.includes('↵ apply · esc cancel')) {
    throw new Error(`pressing f on fixable ${focused.marker} did not open confirm card:\n${frame}`)
  }
  if (hasCertBox && focused.check.remedy?.class === 'destructive' && !frame.includes('DESTRUCTIVE')) {
    throw new Error(`destructive remedy confirm for ${focused.marker} missing DESTRUCTIVE warning:\n${frame}`)
  }
  if (appliedIds.length !== 0 || closedCount !== 0) {
    throw new Error(`confirm card applied remedy or closed before Enter (applied=${appliedIds.length}, closed=${closedCount})`)
  }

  if (scenario.ending === 'fix-cancel') {
    frame = await sendKey(KEYS.esc)
    if (closedCount !== 0 || appliedIds.length !== 0) {
      throw new Error(`Esc in fix confirm closed screen or applied remedy (closed=${closedCount}, applied=${appliedIds.length})`)
    }
    assertPointerInvariant('after-fix-cancel', frame)
    await sendKey(KEYS.esc)
    if (closedCount !== 1 || appliedIds.length !== 0) {
      throw new Error(`Esc after fix cancel did not close cleanly (closed=${closedCount}, applied=${appliedIds.length})`)
    }
    return
  }

  frame = await sendKey(KEYS.enter)
  if (appliedIds.length !== 1) {
    throw new Error(`Enter in fix confirm expected 1 apply call for ${focused.check.id}, got ${appliedIds.length}`)
  }
  if (appliedIds[0] !== focused.check.id) {
    throw new Error(`wrong remedy applied: painted row ${focused.marker} (${focused.check.id}) != applied (${appliedIds[0]})`)
  }
  if (closedCount !== 0) {
    throw new Error(`applying remedy closed screen before user dismissed done card`)
  }
  frame = await sendKey(KEYS.esc)
  if (closedCount !== 0) throw new Error(`first Esc on done card closed screen instead of dismissing done card`)
  await sendKey(KEYS.esc)
  if (closedCount !== 1) throw new Error(`Esc after dismissing done card did not close screen (closed=${closedCount})`)
}

const checkSpecArb: fc.Arbitrary<CheckSpec> = fc.record({
  section: fc.constantFrom(0 as const, 1 as const, 2 as const),
  status: fc.constantFrom('ok' as const, 'warn' as const, 'fail' as const, 'stale' as const, 'unknown' as const),
  hasRemedy: fc.boolean(),
  remedyClass: fc.constantFrom('safe' as const, 'destructive' as const),
})

const navKeyArb: fc.Arbitrary<NavKey> = fc.constantFrom('down', 'up', 'pgdn', 'pgup', 'home', 'end')

const viewportArb = fc.constantFrom(
  { cols: 120, rows: 40 },
  { cols: 120, rows: 24 },
  { cols: 90, rows: 24 },
)

const scenarioArb: fc.Arbitrary<HealthScenario> = fc.record({
  checks: fc.array(checkSpecArb, { minLength: 1, maxLength: 12 }),
  viewport: viewportArb,
  steps: fc.array(navKeyArb, { minLength: 0, maxLength: 12 }),
  ending: fc.constantFrom('evidence' as const, 'fix-cancel' as const, 'fix-apply' as const, 'close' as const),
})

const t = checker()
const SEED_MAIN = 20261131
const SEED_CONSENT = 20261132
const SEED_FAULT = 20261133

try {
  t.section('§1 — BootHealthScreen: painted row identity, evidence trail, fix consent, and Esc unwind')
  {
    const result = await fc.check(
      fc.asyncProperty(scenarioArb, async scenario => {
        await runHealthScenario(scenario)
      }),
      { numRuns: 60, seed: SEED_MAIN },
    )
    t.check(
      `60 generated health certificate/key scenarios held row identity, evidence trail, fix consent, and Esc laws (seed ${SEED_MAIN})`,
      !result.failed,
      result.failed ? `path=${result.counterexamplePath} error=${String(result.errorInstance)}` : '',
    )
  }

  t.section('§2 — BootHealthScreen: fixable checks require confirm + empty certificate still closes on Esc')
  {
    const fixableScenarioArb: fc.Arbitrary<HealthScenario> = fc.record({
      checks: fc.array(
        fc.record({
          section: fc.constantFrom(0 as const, 1 as const),
          status: fc.constantFrom('fail' as const, 'warn' as const, 'stale' as const),
          hasRemedy: fc.constant(true),
          remedyClass: fc.constantFrom('safe' as const, 'destructive' as const),
        }),
        { minLength: 2, maxLength: 8 },
      ),
      viewport: fc.constant({ cols: 120, rows: 40 }),
      steps: fc.array(navKeyArb, { minLength: 1, maxLength: 8 }),
      ending: fc.constantFrom('fix-cancel' as const, 'fix-apply' as const),
    })
    const result = await fc.check(
      fc.asyncProperty(fixableScenarioArb, async scenario => {
        await runHealthScenario(scenario)
      }),
      { numRuns: 30, seed: SEED_CONSENT },
    )
    t.check(
      `30 generated fixable scenarios held confirm-before-apply and exact remedy identity (seed ${SEED_CONSENT})`,
      !result.failed,
      result.failed ? `path=${result.counterexamplePath} error=${String(result.errorInstance)}` : '',
    )

    const emptyCert: HealthCertificate = {
      verdict: 'certified',
      sections: [],
      ranAt: new Date(Date.UTC(2026, 10, 21, 5, 0, 0)).toISOString(),
      head: { sha: 'abcdef1234567890', branch: 'main', dirty: false },
      version: '1.0.12',
      durationMs: 1,
    }
    const emptyFrame = await mountHealth({ cols: 120, rows: 24 }, emptyCert)
    await sendKey(KEYS.enter)
    const enterSafe = closedCount === 0 && appliedIds.length === 0
    await sendKey(KEYS.esc)
    t.check(
      'empty health certificate ignores Enter and closes cleanly on Esc',
      emptyFrame.includes('health check') && enterSafe && closedCount === 1,
      `enterSafe=${enterSafe} closed=${closedCount}`,
    )
  }

  t.section('§3 — Wrong remedy target produces a shrunk replayable counterexample with seed and path')
  {
    const faultScenarioArb: fc.Arbitrary<HealthScenario> = fc.record({
      checks: fc.array(
        fc.record({
          section: fc.constant(0 as const),
          status: fc.constantFrom('fail' as const, 'warn' as const),
          hasRemedy: fc.constant(true),
          remedyClass: fc.constant('safe' as const),
        }),
        { minLength: 2, maxLength: 8 },
      ),
      viewport: fc.constant({ cols: 120, rows: 40 }),
      steps: fc.array(fc.constantFrom('down' as const, 'up' as const, 'end' as const), { minLength: 1, maxLength: 6 }),
      ending: fc.constant('fix-apply' as const),
    })
    const faultyProp = fc.asyncProperty(faultScenarioArb, async scenario => {
      faultRewriteApplyId = () => 'chk-01'
      try {
        await runHealthScenario(scenario)
      } finally {
        faultRewriteApplyId = null
      }
    })
    const caught = await fc.check(faultyProp, { numRuns: 40, seed: SEED_FAULT })
    const shrinkPath = caught.counterexamplePath ?? ''
    t.check(
      `fault-injected wrong remedy target failed with seed ${SEED_FAULT} and shrink path`,
      caught.failed && caught.seed === SEED_FAULT && shrinkPath.length > 0,
      `failed=${caught.failed} path=${shrinkPath}`,
    )
    const minimized = caught.counterexample?.[0]
    t.check(
      'shrunk counterexample is short (<= 3 checks, <= 3 steps)',
      minimized !== undefined && minimized.checks.length <= 3 && minimized.steps.length <= 3,
      minimized ? `checks=${minimized.checks.length} steps=${minimized.steps.length} shrinks=${caught.numShrinks}` : 'none',
    )
    const replay = await fc.check(faultyProp, { seed: caught.seed, path: shrinkPath, endOnFailure: true })
    t.check(
      `replaying seed=${caught.seed} path=${shrinkPath} reproduced identical wrong-remedy failure`,
      replay.failed &&
        JSON.stringify(replay.counterexample) === JSON.stringify(caught.counterexample) &&
        String(replay.errorInstance).includes('wrong remedy applied:'),
      `replay.failed=${replay.failed} err=${String(replay.errorInstance).slice(0, 140)}`,
    )
    const cleanReplay = await fc.check(
      fc.asyncProperty(faultScenarioArb, async scenario => {
        await runHealthScenario(scenario)
      }),
      { seed: caught.seed, path: shrinkPath, endOnFailure: true },
    )
    t.check(
      `unmodified BootHealthScreen passed exact counterexample replay (seed=${caught.seed} path=${shrinkPath})`,
      !cleanReplay.failed,
      cleanReplay.failed ? String(cleanReplay.errorInstance) : '',
    )
  }
} finally {
  faultRewriteApplyId = null
  ink.unmount()
  instances.delete(stdout as never)
  disposeKeybindingWatcher()
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}

t.finish('screen-properties-health')
