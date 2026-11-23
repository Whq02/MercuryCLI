#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'advisor-chip-'))
Object.assign(process.env, {
  MERCURY_CONFIG_DIR: home,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_FULLSCREEN: '1',
  MERCURY_HELM_HOME: '1',
  MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_REDUCED_MOTION: '1',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
  FORCE_COLOR: '3',
})
for (const key of ['MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_RECESS', 'MERCURY_ADVISOR_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'NODE_ENV']) delete process.env[key]
for (const key of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[key] = 'http://127.0.0.1:1'

const arg = process.argv.indexOf('--frames')
const frameDir = arg < 0 ? undefined : process.argv[arg + 1]
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
let checks = 0
let failures = 0
let chipWhere = ''
function check(label: string, good: boolean, detail = ''): void {
  checks++
  if (!good) failures++
  console.log(`  [${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}${!good && chipWhere ? `${detail ? '; ' : ' — '}${chipWhere}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)
async function until(predicate: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 4000
  while (!predicate() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
  return predicate()
}
class Output extends EventEmitter {
  isTTY = true
  constructor(public columns: number, public rows: number) { super() }
  write(): boolean { return true }
}
class Input extends EventEmitter {
  isTTY = true
  isRaw = false
  setEncoding(): this { return this }
  setRawMode(value: boolean): this { this.isRaw = value; return this }
  ref(): this { return this }
  unref(): this { return this }
  read(): null { return null }
  get readableLength(): number { return 0 }
}

const React = await import('react')
const { default: Ink } = await import('../../src/screen/renderer/screenInstance.tsx')
const { Box, Text } = await import('../../src/screen/themedRenderer.ts')
const { App } = await import('../../src/boot/App.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/screen/fullscreen-layout/FullscreenLayout.tsx')
const { MercuryFrame } = await import('../../src/screen/frame-chips/MercuryFrame.tsx')
const { resetChromeModeLatchForTests } = await import('../../src/screen/fullscreen-layout/useLayoutTier.ts')
const { initializeSurfaceRoute, registerRouteSurface, ROOT_CHAT_ROUTE } = await import('../../src/screen/routes/surfaceRoute.ts')
registerRouteSurface('concourse', { render: () => null })
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/platform/settings/config.ts')
const { noSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
const { setFocusedSessionConnector } = await import('../../src/engine/connector/focusedConnector.ts')
const { resetHelmFocusForTest } = await import('../../src/screen/cockpit/helmFocus.ts')
const { default: instances } = await import('../../src/screen/renderer/instances.ts')
const advisor = await import('../../src/models/advisor/index.ts')
const storage = await import('../../src/sessions/transcripts/sessionStorage.ts')
type AppState = import('../../src/screen/app-state/AppState.tsx').AppState
type AdvisorFacts = import('../../src/engine/connector/types.ts').AdvisorFactsV1
const h = React.createElement
const MODEL = 'claude-opus-4-8'
const leadModel = 'claude-fable-5-1'

section("§0 the words: 'advisor · every N minutes' while the chat is effectively on; 'advisor · off in settings' when the chat is on but the settings are off; nothing when the chat's switch is off or the runner has not spoken")
{
  chipWhere = 'fix advisorChipWords in src/models/advisor/advisorSettings.ts so the chip words follow the facts this check names'
  const on: AdvisorFacts = { on: true, chat: true, settings: true, minutes: 10, model: MODEL }
  check('on · every 10 minutes', advisor.advisorChipWords(on) === 'advisor · every 10 minutes', j(advisor.advisorChipWords(on)))
  check('one minute reads singular', advisor.advisorChipWords({ ...on, minutes: 1 }) === 'advisor · every 1 minute')
  check('chat on, settings off: the chip says why nothing lands', advisor.advisorChipWords({ ...on, on: false, settings: false }) === 'advisor · off in settings')
  check("chat off: nothing, whatever the settings say", advisor.advisorChipWords({ ...on, on: false, chat: false }) === null && advisor.advisorChipWords({ ...on, on: false, chat: false, settings: false }) === null)
  check('a runner that has not spoken paints nothing', advisor.advisorChipWords(null) === null)
  check("a crewmate seat's runner (chat on, settings on, refused) paints nothing", advisor.advisorChipWords({ ...on, on: false }) === null)
}

section("§1 the runner's own facts: advisorFacts() reads the effective test, the chat's switch, the settings, the minutes and the model, and rides the session facts answer under `advisor`")
{
  chipWhere = 'fix advisorFacts in src/models/advisor/advisorSettings.ts (or the connector that carries it: src/engine/connector/daemonConnector.ts, src/engine/connector/noSessionConnector.ts) so the facts match the expected object shown above'
  enableConfigs()
  const fresh = advisor.advisorFacts()
  check('a fresh runner: off, chat off, settings off, ten minutes, no model', j(fresh) === j({ on: false, chat: false, settings: false, minutes: 10, model: null }), j(fresh))
  advisor.setAdvisorEnabled(true)
  advisor.setAdvisorMinutes(20)
  saveGlobalConfig(c => ({ ...c, subModels: { ...c.subModels, advisor: MODEL } }))
  storage.saveAdvisorSwitch(true)
  const on = advisor.advisorFacts()
  check('settings on, /advise on, a model pinned: on with the minutes and the model', j(on) === j({ on: true, chat: true, settings: true, minutes: 20, model: MODEL }), j(on))
  const { liveFactsOf, withLiveRunner } = await import('../lib/builtProduct.ts')
  const liveAdvisor = (await withLiveRunner(liveFactsOf, { env: { MERCURY_CONFIG_DIR: home } })).advisor
  const liveAdvised = (await withLiveRunner(liveFactsOf, { argv: ['--advise'], env: { MERCURY_CONFIG_DIR: home } })).advisor
  advisor.setAdvisorEnabled(false)
  const master = advisor.advisorFacts()
  check('the settings off: chat still on, on false', j(master) === j({ on: false, chat: true, settings: false, minutes: 20, model: MODEL }), j(master))
  storage.saveAdvisorSwitch(false)
  advisor.setAdvisorMinutes(10)
  saveGlobalConfig(c => { const next = { ...c.subModels }; delete next.advisor; return { ...c, subModels: Object.keys(next).length > 0 ? next : undefined } })
  check("the session facts answer carries `advisor: advisorFacts()` beside the pause gate, so the screen reads THIS chat's state through its connector", j(liveAdvisor) === j({ ...on, on: false, chat: false }) && j(liveAdvised) === j(on), j({ liveAdvisor, liveAdvised }))
  const { publishSessionFacts } = await import('../../src/engine/connector/seatProjections.ts')
  const { DaemonSessionConnector } = await import('../../src/engine/connector/daemonConnector.ts')
  const planeBefore = process.env.MERCURY_DAEMON_DIR
  process.env.MERCURY_DAEMON_DIR = join(home, 'advisor-plane')
  const hostedAdvisor = (sessionId: string, facts: Record<string, unknown> | null): AdvisorFacts | null => {
    if (facts !== null) publishSessionFacts({ schema: 1, sessionId, atMs: Date.now(), busy: false, pendingModel: null, model: { effective: leadModel, setting: null }, usage: {}, queue: [], ...facts } as never)
    return new DaemonSessionConnector({ sessionId, runnerId: 'runner-1', title: 'advisor chip', projectLabel: 'proof', workspaceId: home, home } as never).advisorFacts()
  }
  const hosted = { told: hostedAdvisor('advisor-told', { advisor: on }), untold: hostedAdvisor('advisor-untold', {}), unread: hostedAdvisor('advisor-unread', null) }
  if (planeBefore === undefined) delete process.env.MERCURY_DAEMON_DIR
  else process.env.MERCURY_DAEMON_DIR = planeBefore
  check('the daemon connector answers the facts it read, the resting connector null', j(hosted) === j({ told: on, untold: null, unread: null }) && noSessionConnector().advisorFacts() === null, `advisorFacts() of the hosted connector answers ${j(hosted)}, resting ${j(noSessionConnector().advisorFacts())}`)
}

section("§2 the inline chat's statusline, rendered from source (the one surface that paints the frame's chips since the cockpit's sessions box left): the chip stands after the vitals while the chat is on, says off in settings when the settings are off, and is absent when the chat is off")
{
  chipWhere = 'fix how src/screen/frame-chips/MercuryFrame.tsx paints the advisor chip on the status row from the focused connector advisorFacts() (the shown value is the status row as rendered)'
  process.env.MERCURY_FULLSCREEN = '0'
  let facts: AdvisorFacts | null = null
  const listeners = new Set<() => void>()
  const overrides: Record<string, unknown> = {
    sessionId: () => 'chip-session',
    modelFacts: () => ({ main: leadModel, effective: leadModel, sessionPin: null, effort: 'high', effortSent: 'high', pendingSwitch: null }),
    subscribeModel: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    advisorFacts: () => facts,
  }
  const connector = new Proxy(noSessionConnector(), {
    get(target, key) {
      if (typeof key === 'string' && key in overrides) return overrides[key]
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  setFocusedSessionConnector(connector)
  saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
  saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))
  const pulse = (next: AdvisorFacts | null): void => {
    facts = next
    for (const listener of listeners) listener()
  }
  function Harness(): React.ReactNode {
    return h(KeybindingSetup, null, h(FullscreenLayout, {
      scrollable: h(Text, null, '[Mercury] the lead transcript'),
      bottom: h(Box, { flexDirection: 'column' }, h(MercuryFrame, { model: leadModel }), h(Box, { borderStyle: 'round' }, h(Text, null, '› message Mercury'))),
    }))
  }
  const deadline = setTimeout(() => { console.error('advisor chip exceeded its deadline'); process.exit(1) }, 120_000)
  deadline.unref()
  for (const [cols, rows] of [[178, 51], [120, 40]] as const) {
    const size = `${cols}x${rows}`
    facts = null
    initializeSurfaceRoute(ROOT_CHAT_ROUTE)
    resetChromeModeLatchForTests()
    resetHelmFocusForTest()
    const stdout = new Output(cols, rows)
    const ink = new Ink({ stdout: stdout as never, stdin: new Input() as never, stderr: new Output(cols, rows) as never, exitOnCtrlC: false, patchConsole: false })
    instances.set(stdout as never, ink)
    const state = { ...getDefaultAppState(), effortValue: 'high' } as AppState
    ink.render(h(App, { initialState: state, getFpsMetrics: () => undefined }, h(Harness)))
    const lines = (): string[] => stripAnsi(ink.lastFrameText()).replace(/\n$/, '').split('\n')
    const statusRow = (): string => lines().find(line => line.includes('Fable')) ?? ''
    const snapshot = (name: string): void => {
      if (frameDir !== undefined) writeFileSync(join(frameDir, `advisor-chip-${size}-${name}.txt`), lines().join('\n') + '\n')
    }
    check(`${size}: the status row paints with the lead model and no advisor chip before the runner speaks`, await until(() => statusRow().includes('Fable') && !statusRow().includes('advisor')), statusRow())
    snapshot('unspoken')
    pulse({ on: true, chat: true, settings: true, minutes: 10, model: MODEL })
    check(`${size}: /advise on lands the chip on the status row — 'advisor · every 10 minutes' after the vitals (red on the base: no chip)`, await until(() => statusRow().includes('advisor · every 10 minutes')), statusRow())
    check(`${size}: the chip stands right of the model and the folder, behind the row's own separator`, / \S advisor · every 10 minutes/.test(statusRow()) && statusRow().indexOf('advisor · every') > statusRow().indexOf('Fable'), statusRow())
    snapshot('on')
    console.log(`    ${statusRow().trim()}`)
    pulse({ on: false, chat: true, settings: false, minutes: 10, model: MODEL })
    check(`${size}: the settings off with the chat still on: the chip says 'advisor · off in settings'`, await until(() => statusRow().includes('advisor · off in settings')), statusRow())
    snapshot('off-in-settings')
    pulse({ on: false, chat: false, settings: true, minutes: 10, model: MODEL })
    check(`${size}: /advise off takes the chip away`, await until(() => !statusRow().includes('advisor')), statusRow())
    snapshot('off')
    ink.unmount()
    instances.delete(stdout as never)
  }
  clearTimeout(deadline)
}

console.log(`\n${failures === 0 ? '✅' : '❌'} advisor chip: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
