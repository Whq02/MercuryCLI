#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import stripAnsi from 'strip-ansi'
import { checker } from '../engine-durability/harness.ts'

const previousCwd = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'mercury-screen-agents-'))
const configHome = join(scratch, 'config')
const fixtureRoot = join(scratch, 'project')
const agentsDir = join(configHome, 'agents')
const projectAgentsDir = join(fixtureRoot, '.mercury', 'agents')
mkdirSync(agentsDir, { recursive: true })
mkdirSync(projectAgentsDir, { recursive: true })

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

const { default: Ink } = await import('../../src/screen/renderer/screenInstance.js')
const { default: instances } = await import('../../src/screen/renderer/instances.js')
const { default: reconciler } = await import('../../src/screen/renderer/reconciler.js')
const { disposeKeybindingWatcher } = await import('../../src/screen/keys/loadUserBindings.js')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { TerminalSizeContext } = await import('../../src/screen/renderer/elements/TerminalSizeContext.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { BootAgentsScreen } = await import('../../src/screen/boot-face/BootAgentsScreen.tsx')

type AgentDefinition = import('../../src/crew/agents/agentDefinition.js').AgentDefinition
type AgentDefinitionsResult = import('../../src/crew/agents/agentDefinition.js').AgentDefinitionsResult

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
  backspace: '\x7f',
} as const

type AgentSpec = {
  kind: 'user' | 'project' | 'builtin'
  disabled: boolean
}

type NavKey = 'down' | 'up' | 'pgdn' | 'pgup' | 'home' | 'end'
type SubViewKey = 'n' | 'u' | 'backspace'

type Scenario = {
  agents: AgentSpec[]
  steps: NavKey[]
  ending: 'enter' | 'close'
}

type BuiltAgent = {
  name: string
  kind: AgentSpec['kind']
  disabled: boolean
  def: AgentDefinition
}

const COLS = 144
const ROWS = 34

function buildRoster(specs: readonly AgentSpec[], tag: number): {
  built: BuiltAgent[]
  byName: Map<string, BuiltAgent>
  result: AgentDefinitionsResult
} {
  const built: BuiltAgent[] = specs.map((spec, i) => {
    const id = String(i + 1).padStart(2, '0')
    const name = `ag${id}-${spec.kind}`
    const whenToUse = `Fixture agent ${name} handles task ${id}`
    if (spec.kind === 'builtin') {
      const def: AgentDefinition = {
        agentType: name,
        whenToUse,
        source: 'built-in',
        baseDir: 'built-in',
        getSystemPrompt: () => `You are ${name}.`,
      }
      return { name, kind: spec.kind, disabled: false, def }
    }
    const dir = spec.kind === 'user' ? agentsDir : projectAgentsDir
    const filePath = join(dir, `${tag}-${name}.md`)
    writeFileSync(
      filePath,
      `---\nname: ${name}\ndescription: ${whenToUse}\n---\nYou are ${name}.\n`,
      'utf8',
    )
    const def: AgentDefinition = {
      agentType: name,
      whenToUse,
      source: spec.kind === 'user' ? 'userSettings' : 'projectSettings',
      filePath,
      revision: `rev-${tag}-${id}`,
      disabled: spec.disabled,
      getSystemPrompt: () => `You are ${name}.`,
    }
    return { name, kind: spec.kind, disabled: spec.disabled, def }
  })
  const allAgents = built.map(b => b.def)
  const activeAgents = allAgents.filter(a => a.disabled !== true)
  const byName = new Map(built.map(b => [b.name, b]))
  return {
    built,
    byName,
    result: { allAgents, activeAgents },
  }
}

function focusedAgentNames(frame: string): string[] {
  const names = new Set<string>()
  for (const line of frame.split('\n')) {
    const matches = line.matchAll(/❯\s+(ag\d{2}-(?:user|project|builtin))\b/g)
    for (const m of matches) names.add(m[1]!)
  }
  return [...names]
}

const stdout = new FakeStdout(COLS, ROWS)
const stdin = new FakeStdin()
const ink = new Ink({
  stdout: stdout as never,
  stdin: stdin as never,
  stderr: new FakeStdout(COLS, ROWS) as never,
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
let closeCount = 0
const readCloseCount = (): number => closeCount

async function mountAgents(definitions: AgentDefinitionsResult): Promise<string> {
  closeCount = 0
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
          { value: { columns: COLS, rows: ROWS } },
          h(
            KeybindingSetup as never,
            {},
            h(
              Box,
              { width: COLS, height: ROWS, flexDirection: 'column' },
              h(BootAgentsScreen as never, {
                key: `agents-run-${runSeq}`,
                fullScene: { columns: COLS, rows: ROWS },
                definitions,
                workspaceDir: fixtureRoot,
                toolsOf: () => [],
                onClose: () => {
                  closeCount++
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

async function runScenario(
  scenario: Scenario,
  faultExpectedTarget?: (highlighted: BuiltAgent, roster: BuiltAgent[]) => BuiltAgent,
): Promise<void> {
  const { built, byName, result } = buildRoster(scenario.agents, runSeq + 1)
  let frame = await mountAgents(result)
  if (!frame.includes('AGENTS') && !frame.includes('MERCURY · agents')) {
    throw new Error(`BootAgentsScreen did not paint agents header:\n${frame}`)
  }

  const assertRosterFrame = (phase: string, current: string): BuiltAgent | null => {
    if (readCloseCount() !== 0) {
      throw new Error(`${phase}: BootAgentsScreen closed before Esc (closeCount=${readCloseCount()})`)
    }
    const paintedAgents = new Set(current.match(/\bag\d{2}-(?:user|project|builtin)\b/g) ?? [])
    for (const seen of paintedAgents) {
      if (!byName.has(seen)) {
        throw new Error(`${phase}: phantom agent ${seen} painted outside generated roster`)
      }
    }
    if (built.length === 0) {
      if (!current.includes('no agents in this workspace yet')) {
        throw new Error(`${phase}: empty roster did not paint empty state:\n${current}`)
      }
      return null
    }
    const focused = focusedAgentNames(current)
    if (focused.length !== 1) {
      throw new Error(`${phase}: expected 1 focused agent marker, got ${JSON.stringify(focused)}:\n${current}`)
    }
    const target = byName.get(focused[0]!)
    if (!target) {
      throw new Error(`${phase}: focused agent ${focused[0]} not in roster`)
    }
    return target
  }

  let focused = assertRosterFrame('mount', frame)
  for (let i = 0; i < scenario.steps.length; i++) {
    frame = await sendKey(KEYS[scenario.steps[i]!])
    focused = assertRosterFrame(`step[${i}]:${scenario.steps[i]}`, frame)
  }

  if (scenario.ending === 'close') {
    await sendKey(KEYS.esc)
    if (readCloseCount() !== 1) {
      throw new Error(`Esc from agents roster expected closeCount=1, got ${readCloseCount()}`)
    }
    return
  }

  if (focused === null) {
    frame = await sendKey(KEYS.enter)
    if (readCloseCount() !== 0) {
      throw new Error(`Enter on empty agents roster must not close screen`)
    }
    await sendKey(KEYS.esc)
    if (readCloseCount() !== 1) {
      throw new Error(`Esc on empty agents roster expected closeCount=1, got ${readCloseCount()}`)
    }
    return
  }

  const expected = faultExpectedTarget ? faultExpectedTarget(focused, built) : focused
  frame = await sendKey(KEYS.enter)
  if (readCloseCount() !== 0) {
    throw new Error(`Enter on ${focused.name} closed screen instead of opening editor/picker`)
  }
  if (expected.kind === 'builtin') {
    if (!frame.includes(`${expected.name} — model override`) && !(frame.includes('model') && frame.includes('Inherit'))) {
      throw new Error(`wrong agent opened on Enter: expected built-in model picker for ${expected.name}, got:\n${frame}`)
    }
  } else {
    if (!frame.includes('agent form') || !frame.includes(`identifier`) || !frame.includes(expected.name)) {
      throw new Error(`wrong agent opened on Enter: expected edit form for ${expected.name}, got:\n${frame}`)
    }
  }

  frame = await sendKey(KEYS.esc)
  if (readCloseCount() !== 0) {
    throw new Error(`first Esc from sub-view closed entire agents screen instead of returning to list`)
  }
  assertRosterFrame('after-subview-esc', frame)
  await sendKey(KEYS.esc)
  if (readCloseCount() !== 1) {
    throw new Error(`second Esc from agents roster expected closeCount=1, got ${readCloseCount()}`)
  }
}

const agentSpecArb: fc.Arbitrary<AgentSpec> = fc.record({
  kind: fc.constantFrom('user' as const, 'project' as const, 'builtin' as const),
  disabled: fc.boolean(),
})

const navKeyArb: fc.Arbitrary<NavKey> = fc.constantFrom('down', 'up', 'pgdn', 'pgup', 'home', 'end')

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  agents: fc.array(agentSpecArb, { minLength: 0, maxLength: 10 }),
  steps: fc.array(navKeyArb, { minLength: 0, maxLength: 12 }),
  ending: fc.constantFrom('enter' as const, 'close' as const),
})

const t = checker()
const SEED_MAIN = 20261131
const SEED_SUBVIEWS = 20261132
const SEED_FAULT = 20261133

try {
  t.section('§1 — BootAgentsScreen: painted rows match roster, Enter opens highlighted agent, Esc leaves')
  {
    const result = await fc.check(
      fc.asyncProperty(scenarioArb, async scenario => {
        await runScenario(scenario)
      }),
      { numRuns: 45, seed: SEED_MAIN },
    )
    t.check(
      `45 generated roster/key scenarios held painted-row identity, Enter target, and Esc close laws (seed ${SEED_MAIN})`,
      !result.failed,
      result.failed ? `path=${result.counterexamplePath} error=${String(result.errorInstance)}` : '',
    )
  }

  t.section('§2 — BootAgentsScreen: sub-views (n create, u trash, Backspace confirm) return on Esc, then Esc closes')
  {
    const subViewArb = fc.record({
      agents: fc.array(agentSpecArb, { minLength: 1, maxLength: 6 }),
      steps: fc.array(navKeyArb, { minLength: 0, maxLength: 6 }),
      subView: fc.constantFrom('n' as const, 'u' as const, 'backspace' as const),
    })
    const result = await fc.check(
      fc.asyncProperty(subViewArb, async ({ agents, steps, subView }) => {
        const { byName, result: defs } = buildRoster(agents, runSeq + 1)
        let frame = await mountAgents(defs)
        for (const k of steps) frame = await sendKey(KEYS[k])
        const focusedName = focusedAgentNames(frame)[0]!
        const focused = byName.get(focusedName)!
        const keySeq = subView === 'backspace' ? KEYS.backspace : subView
        frame = await sendKey(keySeq)
        if (readCloseCount() !== 0) {
          throw new Error(`opening sub-view ${subView} closed agents screen`)
        }
        const openedSubView = subView === 'n' || subView === 'u' || (subView === 'backspace' && focused.kind !== 'builtin')
        if (openedSubView) {
          frame = await sendKey(KEYS.esc)
          if (readCloseCount() !== 0) {
            throw new Error(`Esc inside ${subView} sub-view closed entire screen instead of returning to roster`)
          }
          if (focusedAgentNames(frame).length !== 1) {
            throw new Error(`Esc from ${subView} did not restore roster focus:\n${frame}`)
          }
        }
        await sendKey(KEYS.esc)
        if (readCloseCount() !== 1) {
          throw new Error(`Esc from roster after ${subView} expected closeCount=1, got ${readCloseCount()}`)
        }
      }),
      { numRuns: 25, seed: SEED_SUBVIEWS },
    )
    t.check(
      `25 generated sub-view/Esc scenarios returned to roster then closed cleanly (seed ${SEED_SUBVIEWS})`,
      !result.failed,
      result.failed ? `path=${result.counterexamplePath} error=${String(result.errorInstance)}` : '',
    )
  }

  t.section('§3 — Fault replay: wrong Enter target shrinks and replays identically with seed and path')
  {
    const faultArb: fc.Arbitrary<Scenario> = fc.record({
      agents: fc.array(agentSpecArb, { minLength: 2, maxLength: 8 }),
      steps: fc.array(fc.constantFrom('down' as const, 'up' as const, 'end' as const), { minLength: 1, maxLength: 6 }),
      ending: fc.constant('enter' as const),
    })
    const faultyProp = fc.asyncProperty(faultArb, async scenario => {
      await runScenario(scenario, (highlighted, roster) => {
        const wrong = roster.find(a => a.name !== highlighted.name)
        return wrong ?? highlighted
      })
    })
    const caught = await fc.check(faultyProp, { numRuns: 30, seed: SEED_FAULT })
    const shrinkPath = caught.counterexamplePath ?? ''
    t.check(
      `fault-injected wrong agent target failed with seed ${SEED_FAULT} and shrink path`,
      caught.failed && caught.seed === SEED_FAULT && shrinkPath.length > 0,
      `failed=${caught.failed} path=${shrinkPath}`,
    )
    const minimized = caught.counterexample?.[0]
    t.check(
      'shrunk counterexample is short (<= 3 agents, <= 3 steps)',
      minimized !== undefined && minimized.agents.length <= 3 && minimized.steps.length <= 3,
      minimized ? `agents=${minimized.agents.length} steps=${minimized.steps.length} shrinks=${caught.numShrinks}` : 'none',
    )
    const replay = await fc.check(faultyProp, { seed: caught.seed, path: shrinkPath, endOnFailure: true })
    t.check(
      `replaying seed=${caught.seed} path=${shrinkPath} reproduced identical counterexample`,
      replay.failed &&
        JSON.stringify(replay.counterexample) === JSON.stringify(caught.counterexample) &&
        String(replay.errorInstance).includes('wrong agent opened on Enter:'),
      `replay.failed=${replay.failed} err=${String(replay.errorInstance).slice(0, 140)}`,
    )
    const cleanReplay = await fc.check(
      fc.asyncProperty(faultArb, async scenario => {
        await runScenario(scenario)
      }),
      { seed: caught.seed, path: shrinkPath, endOnFailure: true },
    )
    t.check(
      `unmodified BootAgentsScreen passed exact counterexample replay (seed=${caught.seed} path=${shrinkPath})`,
      !cleanReplay.failed,
      cleanReplay.failed ? String(cleanReplay.errorInstance) : '',
    )
  }
} finally {
  ink.unmount()
  instances.delete(stdout as never)
  disposeKeybindingWatcher()
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}

t.finish('screen-properties-agents')
