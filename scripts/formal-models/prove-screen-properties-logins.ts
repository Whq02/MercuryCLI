#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import stripAnsi from 'strip-ansi'
import { checker } from '../engine-durability/harness.ts'
import type { AccountSlot, FamilySlotGroup } from '../../src/models/roads/accountSlots.ts'
import type { ProviderId, ProviderUsability } from '../../src/models/roads/providerUsability.ts'
import type { ProviderFamilyPresence } from '../../src/models/roads/providerUsage.ts'
import type { LoginsArmV1, LoginsScreenFactsV1 } from '../../src/screen/boot-face/logins/facts.ts'
import type { FaceKeyLegId } from '../../src/screen/boot-face/logins/pickLines.ts'

const previousCwd = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'mercury-screen-logins-'))
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

let openedArms: string[] = []
let faultForceArm: LoginsArmV1 | null = null

const realPicks = await import('../../src/screen/boot-face/logins/picks.ts')
const origOpenFlowOf = realPicks.openFlowOf
mock.module('../../src/screen/boot-face/logins/picks.ts', () => ({
  ...realPicks,
  openFlowOf: (ctx: Parameters<typeof origOpenFlowOf>[0], arm: LoginsArmV1) => {
    const chosen = faultForceArm ?? arm
    openedArms.push(chosen.row.value)
    return origOpenFlowOf(ctx, chosen)
  },
}))

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
const {
  BootLoginsScreen,
  keyLegTitle,
  loginsCatalogue,
  loginsFamilyCounts,
  loginsSortedArms,
} = await import('../../src/screen/boot-face/BootLoginsScreen.tsx')

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
  pgdn: '\x1b[6~',
  pgup: '\x1b[5~',
  home: '\x1b[H',
  end: '\x1b[F',
  enter: '\x1b[13u',
  esc: '\x1b[27u',
} as const

type NavKey = 'down' | 'up' | 'pgdn' | 'pgup' | 'home' | 'end'

const PICK_GROUP_TITLE: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  zai: 'which key is this?',
  moonshot: 'Kimi (Moonshot)',
  huggingface: 'Hugging Face',
  openrouter: 'OpenRouter',
  gemini: 'Google Gemini',
  xai: 'xAI (Grok)',
  nous: 'Nous Portal',
  orcarouter: 'OrcaRouter',
  meta: 'Meta (Muse)',
}

const ALL_CATALOGUE = loginsCatalogue()
const ALL_FAMILY_IDS = [...new Set(ALL_CATALOGUE.map(a => a.familyId))]

type LoginsScenario = {
  signedMask: number[]
  expiredIdx: number | null
  viewport: { cols: number; rows: number }
  steps: NavKey[]
  ending: 'open-and-esc' | 'esc' | 'left'
}

function buildFacts(signedMask: readonly number[], expiredIdx: number | null): LoginsScreenFactsV1 {
  const signedSet = new Set(signedMask.map(i => ALL_FAMILY_IDS[i % ALL_FAMILY_IDS.length]!))
  const expiredFamily = expiredIdx !== null ? ALL_FAMILY_IDS[expiredIdx % ALL_FAMILY_IDS.length]! : null
  const groups: FamilySlotGroup[] = []
  const usability = {} as Record<ProviderId, ProviderUsability>
  for (let i = 0; i < ALL_FAMILY_IDS.length; i++) {
    const id = ALL_FAMILY_IDS[i]!
    const isSigned = signedSet.has(id)
    const isExpired = expiredFamily === id && !isSigned
    const presence = {
      id,
      available: true,
      credentialed: isSigned,
      ...(isExpired ? { expired: true } : {}),
    } as ProviderFamilyPresence
    const slots: AccountSlot[] = isSigned
      ? [
          {
            family: id,
            id: `${id}:fixture-slot`,
            kind: 'api-key',
            name: 'fixture',
            kindLabel: 'API key',
            identity: `op${String(i + 1).padStart(2, '0')}@fixture.example`,
            active: true,
            envPinned: false,
            signedIn: true,
            removal: { route: 'owner', note: 'fixture' },
          },
        ]
      : isExpired
        ? [
            {
              family: id,
              id: `${id}:expired-slot`,
              kind: 'oauth',
              name: 'expired',
              kindLabel: 'sign-in',
              identity: `exp${String(i + 1).padStart(2, '0')}@fixture.example`,
              active: false,
              envPinned: false,
              signedIn: false,
              expired: true,
              removal: { route: 'owner', note: 'fixture' },
            },
          ]
        : []
    groups.push({ family: presence, slots })
    usability[id] = {
      provider: id,
      credential: isSigned ? 'api-key' : 'none',
      limit: 'unknown',
      usable: isSigned,
      blockers: isSigned ? [] : ['no credential for this family'],
    }
  }
  return { groups, usability }
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

let closedCount = 0
let signedInCount = 0
let runSeq = 0

async function mountLogins(
  viewport: { cols: number; rows: number },
  facts: LoginsScreenFactsV1,
  family?: string,
): Promise<string> {
  stdout.columns = viewport.cols
  stdout.rows = viewport.rows
  openedArms = []
  closedCount = 0
  signedInCount = 0
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
              h(BootLoginsScreen, {
                key: `logins-run-${runSeq}`,
                fullScene: { columns: viewport.cols, rows: viewport.rows },
                facts,
                ...(family !== undefined ? { family } : {}),
                onClose: () => {
                  closedCount += 1
                },
                onSignedIn: () => {
                  signedInCount += 1
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

function focusedArmOf(frame: string, arms: readonly LoginsArmV1[]): { pointerLines: string[]; matched: LoginsArmV1[] } {
  const pointerLines = frame.split('\n').filter(line => line.includes('❯ '))
  const byValue = new Map<string, LoginsArmV1>()
  for (const line of pointerLines) {
    const after = line.slice(line.indexOf('❯ ') + 2)
    const token = (after.split(/\s{2,}|│/)[0] ?? '').trim()
    for (const arm of arms) {
      if (
        line.includes(`❯ ${arm.row.label}`) ||
        (token.endsWith('…') && token.length >= 12 && arm.row.label.startsWith(token.slice(0, -1)))
      ) {
        byValue.set(arm.row.value, arm)
      }
    }
  }
  return { pointerLines, matched: [...byValue.values()] }
}

function expectedFlowNeedle(armValue: string): string {
  if (armValue in PICK_GROUP_TITLE) return PICK_GROUP_TITLE[armValue]!
  return keyLegTitle(armValue as FaceKeyLegId)
}

async function runLoginsScenario(scenario: LoginsScenario): Promise<void> {
  const facts = buildFacts(scenario.signedMask, scenario.expiredIdx)
  const arms = loginsSortedArms(facts)
  let frame = await mountLogins(scenario.viewport, facts)
  if (!frame.includes('logins')) {
    throw new Error(`BootLoginsScreen did not paint title:\n${frame}`)
  }
  const hasSummaryBox = frame.includes('Families')
  if (hasSummaryBox) {
    const { familyIds, signed } = loginsFamilyCounts(facts.groups)
    const countText = `${signed} of ${familyIds.length}`
    if (!frame.includes(countText)) {
      throw new Error(`BootLoginsScreen LOGINS summary missing '${countText}':\n${frame}`)
    }
  }

  const assertPointerInvariant = (phase: string, current: string): LoginsArmV1 => {
    if (closedCount !== 0) throw new Error(`${phase}: closed before Esc/Left (closed=${closedCount})`)
    if (signedInCount !== 0) throw new Error(`${phase}: onSignedIn fired during navigation`)
    if (openedArms.length !== 0) throw new Error(`${phase}: flow opened before Enter (${openedArms.join(',')})`)
    const { pointerLines, matched } = focusedArmOf(current, arms)
    const expectedPointers = 1
    if (pointerLines.length !== expectedPointers || matched.length !== 1) {
      throw new Error(`${phase}: expected ${expectedPointers} pointer line(s) matching 1 arm, got lines=${pointerLines.length} matched=${matched.map(a => a.row.value).join(',')}:\n${current}`)
    }
    return matched[0]!
  }

  let focused = assertPointerInvariant('mount', frame)

  for (let i = 0; i < scenario.steps.length; i++) {
    const key = scenario.steps[i]!
    frame = await sendKey(KEYS[key])
    focused = assertPointerInvariant(`step[${i}]:${key}`, frame)
  }

  if (scenario.ending === 'esc' || scenario.ending === 'left') {
    await sendKey(scenario.ending === 'esc' ? KEYS.esc : KEYS.left)
    if (closedCount !== 1 || openedArms.length !== 0) {
      throw new Error(`${scenario.ending} on logins list expected closed=1 opened=0, got closed=${closedCount} opened=${openedArms.length}`)
    }
    return
  }

  frame = await sendKey(KEYS.enter)
  if (closedCount !== 0) throw new Error(`Enter on ${focused.row.value} closed screen instead of opening provider flow`)
  if (openedArms.length !== 1) {
    throw new Error(`Enter on ${focused.row.value} expected 1 openFlowOf call, got ${openedArms.length}`)
  }
  if (openedArms[0] !== focused.row.value) {
    throw new Error(`wrong provider opened: painted row ${focused.row.value} != opened (${openedArms[0]})`)
  }
  const isPick = focused.row.value in PICK_GROUP_TITLE
  const needle = expectedFlowNeedle(focused.row.value)
  const flowVisible = hasSummaryBox || isPick ? frame.includes(needle) : frame.includes('↵ store key · esc back')
  if (!flowVisible) {
    throw new Error(`opened flow for ${focused.row.value} missing expected UI marker '${hasSummaryBox || isPick ? needle : '↵ store key · esc back'}':\n${frame}`)
  }
  frame = await sendKey(KEYS.esc)
  if (closedCount !== 0) throw new Error(`Esc from ${focused.row.value} flow closed whole screen instead of returning to roster`)
  const { matched: afterBack } = focusedArmOf(frame, arms)
  if (afterBack.length !== 1 || afterBack[0]!.row.value !== focused.row.value) {
    throw new Error(`Esc from ${focused.row.value} flow did not restore roster focus (got=${afterBack.map(a => a.row.value).join(',')})`)
  }
  await sendKey(KEYS.esc)
  if (closedCount !== 1) throw new Error(`second Esc after returning to roster did not close BootLoginsScreen (closed=${closedCount})`)
}

const navKeyArb: fc.Arbitrary<NavKey> = fc.constantFrom('down', 'up', 'pgdn', 'pgup', 'home', 'end')
const viewportArb = fc.constantFrom({ cols: 120, rows: 40 }, { cols: 90, rows: 24 })

const scenarioArb: fc.Arbitrary<LoginsScenario> = fc.record({
  signedMask: fc.array(fc.integer({ min: 0, max: ALL_FAMILY_IDS.length - 1 }), { minLength: 0, maxLength: 6 }),
  expiredIdx: fc.option(fc.integer({ min: 0, max: ALL_FAMILY_IDS.length - 1 }), { nil: null }),
  viewport: viewportArb,
  steps: fc.array(navKeyArb, { minLength: 0, maxLength: 10 }),
  ending: fc.constantFrom('open-and-esc' as const, 'esc' as const, 'left' as const),
})

const t = checker()
const SEED_MAIN = 20261151
const SEED_KEYS = 20261152
const SEED_FAULT = 20261153

try {
  t.section('§1 — BootLoginsScreen: painted facts, highlighted provider matches Enter flow, Esc/Left unwind')
  {
    const result = await fc.check(
      fc.asyncProperty(scenarioArb, async scenario => {
        await runLoginsScenario(scenario)
      }),
      { numRuns: 50, seed: SEED_MAIN },
    )
    t.check(
      `50 generated login-roster/key scenarios held row identity, provider flow opening, and Esc/Left laws (seed ${SEED_MAIN})`,
      !result.failed,
      result.failed ? `path=${result.counterexamplePath} error=${String(result.errorInstance)}` : '',
    )
  }

  t.section('§2 — BootLoginsScreen: direct-key draft masking, initial family focus, and nested Kimi Esc unwind')
  {
    const directKeyFamilies = ['deepseek', 'mistral', 'groq', 'cohere', 'fireworks', 'qwen', 'cerebras', 'together'] as const
    const keyDraftArb = fc.record({
      family: fc.constantFrom(...directKeyFamilies),
      secretTail: fc.stringMatching(/^[a-z0-9]{6,10}$/),
    })
    const result = await fc.check(
      fc.asyncProperty(keyDraftArb, async ({ family, secretTail }) => {
        const facts = buildFacts([], null)
        const arms = loginsSortedArms(facts)
        let frame = await mountLogins({ cols: 120, rows: 40 }, facts, family)
        const { matched } = focusedArmOf(frame, arms)
        if (matched.length !== 1 || matched[0]!.row.value !== family) {
          throw new Error(`initial family=${family} did not focus ${family} on mount (got=${matched.map(a => a.row.value).join(',')})`)
        }
        frame = await sendKey(KEYS.enter)
        const expectedTitle = keyLegTitle(family)
        if (!frame.includes(expectedTitle) || closedCount !== 0) {
          throw new Error(`Enter on ${family} did not open '${expectedTitle}' key prompt`)
        }
        const secret = `sk-fixture-${secretTail}`
        for (const ch of secret) frame = await sendKey(ch)
        if (frame.includes(secret) || frame.includes(secretTail)) {
          throw new Error(`key prompt for ${family} leaked raw typed secret onto painted frame`)
        }
        frame = await sendKey(KEYS.esc)
        if (closedCount !== 0 || signedInCount !== 0) {
          throw new Error(`Esc in ${family} key prompt closed screen or triggered sign-in`)
        }
        await sendKey(KEYS.esc)
        if (closedCount !== 1 || signedInCount !== 0) {
          throw new Error(`second Esc after ${family} key prompt did not close screen cleanly (closed=${closedCount})`)
        }
      }),
      { numRuns: 25, seed: SEED_KEYS },
    )
    t.check(
      `25 generated family-focus & masked key-entry scenarios hid raw secrets and unwound cleanly on Esc (seed ${SEED_KEYS})`,
      !result.failed,
      result.failed ? `path=${result.counterexamplePath} error=${String(result.errorInstance)}` : '',
    )

    const moonFacts = buildFacts([], null)
    let moonFrame = await mountLogins({ cols: 120, rows: 40 }, moonFacts, 'moonshot')
    moonFrame = await sendKey(KEYS.enter)
    const onMoonPick = moonFrame.includes('Kimi (Moonshot)') && closedCount === 0
    moonFrame = await sendKey(KEYS.enter)
    const onRegionPick = moonFrame.includes('which deployment?') && closedCount === 0
    moonFrame = await sendKey(KEYS.esc)
    const backToMoon = moonFrame.includes('Kimi (Moonshot)') && closedCount === 0
    moonFrame = await sendKey(KEYS.esc)
    const backToRoster = moonFrame.includes('Families') && closedCount === 0
    await sendKey(KEYS.esc)
    t.check(
      'nested Moonshot kimi-region pick unwinds region -> moonshot -> roster -> close on successive Esc keys',
      onMoonPick && onRegionPick && backToMoon && backToRoster && closedCount === 1,
      `moon=${onMoonPick} region=${onRegionPick} backMoon=${backToMoon} backRoster=${backToRoster} closed=${closedCount}`,
    )
  }

  t.section('§3 — Wrong provider opened produces a shrunk replayable counterexample with seed and path')
  {
    const faultScenarioArb: fc.Arbitrary<LoginsScenario> = fc.record({
      signedMask: fc.constant([]),
      expiredIdx: fc.constant(null),
      viewport: fc.constant({ cols: 120, rows: 40 }),
      steps: fc.array(fc.constantFrom('down' as const, 'up' as const, 'end' as const), { minLength: 1, maxLength: 6 }),
      ending: fc.constant('open-and-esc' as const),
    })
    const firstArm = loginsSortedArms(buildFacts([], null))[0]!
    const faultyProp = fc.asyncProperty(faultScenarioArb, async scenario => {
      faultForceArm = firstArm
      try {
        await runLoginsScenario(scenario)
      } finally {
        faultForceArm = null
      }
    })
    const caught = await fc.check(faultyProp, { numRuns: 40, seed: SEED_FAULT })
    const shrinkPath = caught.counterexamplePath ?? ''
    t.check(
      `fault-injected wrong provider open failed with seed ${SEED_FAULT} and shrink path`,
      caught.failed && caught.seed === SEED_FAULT && shrinkPath.length > 0,
      `failed=${caught.failed} path=${shrinkPath}`,
    )
    const minimized = caught.counterexample?.[0]
    t.check(
      'shrunk counterexample is short (<= 3 steps)',
      minimized !== undefined && minimized.steps.length <= 3,
      minimized ? `steps=${minimized.steps.length} shrinks=${caught.numShrinks}` : 'none',
    )
    const replay = await fc.check(faultyProp, { seed: caught.seed, path: shrinkPath, endOnFailure: true })
    t.check(
      `replaying seed=${caught.seed} path=${shrinkPath} reproduced identical wrong-provider failure`,
      replay.failed &&
        JSON.stringify(replay.counterexample) === JSON.stringify(caught.counterexample) &&
        String(replay.errorInstance).includes('wrong provider opened:'),
      `replay.failed=${replay.failed} err=${String(replay.errorInstance).slice(0, 140)}`,
    )
    const cleanReplay = await fc.check(
      fc.asyncProperty(faultScenarioArb, async scenario => {
        await runLoginsScenario(scenario)
      }),
      { seed: caught.seed, path: shrinkPath, endOnFailure: true },
    )
    t.check(
      `unmodified BootLoginsScreen passed exact counterexample replay (seed=${caught.seed} path=${shrinkPath})`,
      !cleanReplay.failed,
      cleanReplay.failed ? String(cleanReplay.errorInstance) : '',
    )
  }
} finally {
  faultForceArm = null
  ink.unmount()
  instances.delete(stdout as never)
  disposeKeybindingWatcher()
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}

t.finish('screen-properties-logins')
