#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'viewed-model-chip-'))
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
for (const key of ['MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_RECESS', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'NODE_ENV']) delete process.env[key]
for (const key of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[key] = 'http://127.0.0.1:1'

writeFileSync(join(home, 'settings.json'), JSON.stringify({ sessionsBar: true }))

const arg = process.argv.indexOf('--frames')
const frameDir = arg < 0 ? undefined : process.argv[arg + 1]
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
let checks = 0
let failures = 0
function check(label: string, good: boolean, detail = ''): void {
  checks++
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
async function until(predicate: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 4000
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
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
const { default: Ink } = await import('../../src/ink/ink.tsx')
const { Box, Text } = await import('../../src/ink.ts')
const { stringWidth } = await import('../../src/ink/stringWidth.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { useAppStateStore } = await import('../../src/state/AppState.tsx')
const { enterCrewmateView, exitCrewmateView, setMainChat } = await import('../../src/state/crewmateViewHelpers.ts')
const { useViewedCrewmate } = await import('../../src/components/tasks/useCrewmateView.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.tsx')
const { MercuryFrame } = await import('../../src/components/MercuryFrame.tsx')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.ts')
const { initializeSurfaceRoute, registerRouteSurface, ROOT_REPL_ROUTE } = await import('../../src/context/surfaceRoute.ts')
registerRouteSurface('concourse', { render: () => null })
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { setFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
const { resetHelmFocusForTest } = await import('../../src/utils/cockpit/helmFocus.ts')
const { getProjectDir, getAgentMetadataPath, writeAgentMetadata } = await import('../../src/utils/sessionStorage/paths.ts')
const { asAgentId } = await import('../../src/types/ids.ts')
const { renderModelChip } = await import('../../src/utils/model/model.ts')
const { default: instances } = await import('../../src/ink/instances.ts')
type AppState = import('../../src/state/AppState.tsx').AppState
type WorkRow = import('../../src/services/engine-connector/types.ts').WorkRowV1
const h = React.createElement
const leadModel = 'claude-fable-5-1'
const agentModel = 'gpt-6-astra'
const leadLabel = renderModelChip(leadModel)
const agentLabel = renderModelChip(agentModel)
const taskId = 'chip-agent'
const localAgentId = asAgentId('chip-local-agent')
const now = Date.now()
let focusedId = 'chip-parent'
const row: WorkRow = { id: taskId, agentId: taskId, kind: 'agent', name: 'atlas', status: 'running', startTime: now, model: agentModel }
const roster = { rows: [row], mission: [], samples: [], reported: true }
const listeners = new Set<() => void>()
const overrides: Record<string, unknown> = {
  sessionId: () => focusedId,
  modelFacts: () => ({ main: leadModel, effective: leadModel, sessionPin: null, effort: 'high', effortSent: 'high', pendingSwitch: null }),
  workRoster: () => roster,
  subscribeWork: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
}
const connector = new Proxy(noSessionConnector(), {
  get(target, key) {
    if (typeof key === 'string' && key in overrides) return overrides[key]
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  },
})
setFocusedSessionConnector(connector)
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))
const workspace = connector.workspace()
const cwd = workspace.originalCwd || workspace.cwd
const sidecar = (parent: string): string => join(getProjectDir(cwd), parent, 'subagents', `agent-${taskId}.meta.json`)
function seed(parent: string, data: unknown): void {
  const file = sidecar(parent)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data))
}
seed(focusedId, { agentType: 'mercury-general', model: agentModel, effort: 'max' })
seed('chip-other-parent', { agentType: 'mercury-general', model: leadModel, effort: 'low' })
await writeAgentMetadata(localAgentId, { agentType: 'mercury-general', model: agentModel, effort: 'medium' })
check('the local metadata fixture has its own agent id and scope', getAgentMetadataPath(localAgentId) !== sidecar(focusedId))

let store: ReturnType<typeof useAppStateStore>
function Harness(): React.ReactNode {
  store = useAppStateStore()
  const viewed = useViewedCrewmate()
  return h(KeybindingSetup, null, h(FullscreenLayout, {
    scrollable: h(Text, null, viewed === null ? '[Mercury] the lead transcript' : `[${viewed.name}] the crewmate transcript`),
    bottom: h(Box, { flexDirection: 'column' },
      h(MercuryFrame, { model: leadModel }),
      h(Box, { borderStyle: 'round' }, h(Text, null, viewed === null ? '› message Mercury Lead' : `› message ${viewed.name}`)),
    ),
  }))
}
const faults: string[] = []
const originalError = console.error
console.error = (...args: unknown[]): void => { faults.push(args.map(String).join(' ')); originalError(...args) }
const deadline = setTimeout(() => { console.error('viewed-model-chip exceeded its deadline'); process.exit(1) }, 120_000)
deadline.unref()

for (const [cols, rows] of [[178, 51], [120, 40]] as const) {
  const size = `${cols}x${rows}`
  focusedId = 'chip-parent'
  initializeSurfaceRoute(ROOT_REPL_ROUTE)
  resetChromeModeLatchForTests()
  resetHelmFocusForTest()
  const stdout = new Output(cols, rows)
  const ink = new Ink({ stdout: stdout as never, stdin: new Input() as never, stderr: new Output(cols, rows) as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  const state = { ...getDefaultAppState(), effortValue: 'high', supercode: false } as AppState
  ink.render(h(App, { initialState: state, getFpsMetrics: () => undefined }, h(Harness)))
  const lines = (): string[] => stripAnsi(ink.lastFrameText()).replace(/\n$/, '').split('\n')
  const strip = (): string => {
    const frame = lines()
    const title = frame.findIndex(line => line.includes('SESSIONS'))
    return title < 0 ? '' : frame[title + 1] ?? ''
  }
  const snapshot = (name: string): void => {
    if (frameDir !== undefined) writeFileSync(join(frameDir, `${size}-${name}.txt`), lines().join('\n') + '\n')
  }
  const geometry = (name: string): void => {
    const frame = lines()
    const title = frame.findIndex(line => line.includes('SESSIONS'))
    const band = frame.slice(title - 1, title + 3)
    check(`${size} ${name}: the strip keeps its four rows and whole borders`, title > 0 && band.length === 4 && band[0]!.startsWith('╭') && band[0]!.endsWith('╮') && band[3]!.startsWith('╰') && band[3]!.endsWith('╯') && band.slice(1, 3).every(line => line.startsWith('│') && line.endsWith('│')) && band.every(line => stringWidth(line) === cols), band.join(' | '))
    check(`${size} ${name}: the frame fits the terminal`, frame.length <= rows && frame.every(line => stringWidth(line) <= cols), `${frame.length}/${rows} rows`)
  }
  check(`${size}: lead chip starts with the lead model and effort`, await until(() => strip().includes(leadLabel) && /\bhigh\b/.test(strip())), strip())
  snapshot('lead')
  enterCrewmateView(taskId, store!.setState)
  check(`${size}: the real view transition opens the crewmate`, await until(() => lines().some(line => line.includes('VIEW · atlas · viewing'))), lines().find(line => line.includes('VIEW')))
  const agentPainted = await until(() => strip().includes(agentLabel) && /\bmax\b/.test(strip()))
  snapshot('viewing')
  check(`${size}: viewed chip names the crewmate model, not the lead`, strip().includes(agentLabel) && !strip().includes(leadLabel), strip())
  check(`${size}: viewed chip names the crewmate launch effort, not the lead`, agentPainted && !/\bhigh\b/.test(strip()), strip())
  geometry('viewing')
  setMainChat(taskId, store!.setState)
  exitCrewmateView(store!.setState)
  check(`${size}: returning to the lead restores its model and effort even while the crewmate stays pinned`, await until(() => lines().some(line => line.includes('[Mercury] the lead transcript')) && strip().includes(leadLabel) && /\bhigh\b/.test(strip())) && store!.getState().mainChatTaskId === taskId && !strip().includes(agentLabel), strip())
  snapshot('returned-lead')
  geometry('returned-lead')

  store!.setState(prev => ({ ...prev, mainChatTaskId: undefined, tasks: { [taskId]: { id: taskId, type: 'local_agent', agentId: localAgentId, agentType: 'mercury-general', description: 'atlas', prompt: '', model: agentModel, status: 'running', startTime: now, isBackgrounded: true } as never } }))
  enterCrewmateView(taskId, store!.setState)
  check(`${size}: a local crewmate reads its agent id's metadata, not the hosted row's or the lead's effort`, await until(() => strip().includes(agentLabel) && /\bmedium\b/.test(strip())), strip())
  snapshot('local')
  exitCrewmateView(store!.setState)
  await until(() => strip().includes(leadLabel))
  store!.setState(prev => ({ ...prev, tasks: {} }))
  focusedId = 'chip-other-parent'
  for (const listener of listeners) listener()
  enterCrewmateView(taskId, store!.setState)
  check(`${size}: a reused task id in another focused session reads that session's launch metadata`, await until(() => strip().includes(leadLabel) && /\blow\b/.test(strip())), strip())
  snapshot('other-parent')
  exitCrewmateView(store!.setState)
  await until(() => /\bhigh\b/.test(strip()))
  focusedId = 'chip-missing-parent'
  for (const listener of listeners) listener()
  enterCrewmateView(taskId, store!.setState)
  check(`${size}: missing launch effort stays unreported and never borrows the lead or previous crewmate`, await until(() => strip().includes(agentLabel) && strip().includes('effort unreported')) && !/\bhigh\b|\blow\b|\bmax\b|\bmedium\b/.test(strip()), strip())
  snapshot('unreported')
  ink.unmount()
  await ink.waitUntilExit()
  instances.delete(stdout as never)
}
console.error = originalError
clearTimeout(deadline)
check('no render or hook-order faults', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error|RENDER ERROR/.test(line)), faults.join('\n').slice(0, 500))
rmSync(home, { recursive: true, force: true })
console.log(`\nviewed-model-chip: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
