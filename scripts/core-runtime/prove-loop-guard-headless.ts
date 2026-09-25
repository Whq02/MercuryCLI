#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mock } from 'bun:test'
import { z } from 'zod/v4'

const homeRoot = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(homeRoot, { recursive: true })
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(homeRoot, 'loop-guard-headless-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'loop-guard-headless-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'loop-guard-headless-teams-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const k of [
  'MERCURY_BARE',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_MAX_OUTPUT_TOKENS',
  'MERCURY_COMPACT',
  'MERCURY_AUTO_COMPACT',
  'MERCURY_SCRIPTED_STREAM',
  'NODE_ENV',
]) {
  delete process.env[k]
}

const realQueryModule = await import('../../src/query.ts')
const realQueryEvents = realQueryModule.queryEvents

type ScriptedDeps = Record<string, unknown> | null
let scriptedDeps: ScriptedDeps = null

async function* forwardingQueryEvents(params: Record<string, unknown>): AsyncGenerator<unknown, unknown> {
  const withDeps = scriptedDeps === null ? params : { ...params, deps: scriptedDeps }
  return yield* realQueryEvents(withDeps as never)
}

mock.module('../../src/query.ts', () => ({
  ...realQueryModule,
  queryEvents: forwardingQueryEvents,
}))

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { QueryEngine } = await import('../../src/QueryEngine.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const settingsRoad = await import('../../src/utils/settings/settings.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — loop-guard headless prover exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

function setStopKey(value: boolean | null): void {
  const path = settingsRoad.getSettingsFilePathForSource('userSettings')!
  if (value === null) rmSync(path, { force: true })
  else {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ loopGuardStopEnabled: value }, null, 2))
  }
  resetSettingsCache()
}

type AnyMsg = Record<string, unknown> & { type?: string; subtype?: string }
const MODEL = 'claude-opus-4-8'
const ENGINE_CWD = mkdtempSync(join(tmpdir(), 'loop-guard-headless-cwd-'))

function makeTool(name: string): never {
  return {
    name,
    async description() {
      return 'rig tool'
    },
    async prompt() {
      return 'rig tool'
    },
    inputSchema: z.object({}).catchall(z.unknown()),
    userFacingName: () => name,
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    async call(input: Record<string, unknown>) {
      return { data: `${name}:${JSON.stringify(input)}` }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: String(data),
    }),
  } as never
}
const TOOLS = [makeTool('Edit'), makeTool('Bash')]

const allowAll = async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

let idSeq = 0
type Step = { name: string; input: Record<string, unknown> }
function toolTurn(step: Step): unknown[] {
  const m = createAssistantMessage({
    content: [{ type: 'tool_use', id: `tu_${++idSeq}`, name: step.name, input: step.input }] as never,
  })
  m.message.stop_reason = 'tool_use'
  return [m]
}
function textTurn(text: string): unknown[] {
  const m = createAssistantMessage({ content: text })
  m.message.stop_reason = 'end_turn'
  return [m]
}

function makeEngine(): InstanceType<typeof QueryEngine> {
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  return new QueryEngine({
    cwd: ENGINE_CWD,
    tools: TOOLS as never,
    commands: [] as never,
    mcpClients: [],
    agents: [],
    canUseTool: allowAll as never,
    getAppState: () => appState as never,
    setAppState: f => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    readFileCache: createFileStateCacheWithSizeLimit(100),
    userSpecifiedModel: MODEL,
  } as never)
}

async function runHeadless(steps: Step[]): Promise<{ yields: AnyMsg[]; modelCalls: number }> {
  let modelCalls = 0
  async function* callModel(): AsyncGenerator<never, void> {
    const step = steps[modelCalls++]
    const turn = step ? toolTurn(step) : textTurn('done: the model ended the turn itself')
    for (const m of turn) yield m as never
  }
  scriptedDeps = {
    callModel,
    autocompact: async () => ({ wasCompacted: false }),
    microcompact: async (messages: unknown[]) => ({ messages }),
    uuid: (() => {
      let n = 0
      return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
    })(),
  }
  const yields: AnyMsg[] = []
  try {
    for await (const m of makeEngine().submitMessage('please do the scripted thing')) {
      yields.push(m as AnyMsg)
    }
  } finally {
    scriptedDeps = null
  }
  return { yields, modelCalls }
}

const EDIT = { file_path: '/tmp/a.ts', old_string: 'x', new_string: 'y' }
const TEST = { command: 'bun test', description: 'Run the tests' }
function pairs(count: number): Step[] {
  const steps: Step[] = []
  for (let i = 0; i < count; i++) {
    steps.push({ name: 'Edit', input: EDIT })
    steps.push({ name: 'Bash', input: TEST })
  }
  return steps
}
const resultOf = (yields: AnyMsg[]): AnyMsg | undefined => yields.find(m => m.type === 'result')

section('H1 — DEFAULT (no key): the headless road settles a reminded-but-continuing loop as the model\'s own success')
{
  setStopKey(null)
  const run = await runHeadless(pairs(10))
  const result = resultOf(run.yields)
  check('the model was called twenty-one times and ended the turn itself', run.modelCalls === 21, `calls=${run.modelCalls}`)
  check('the SDK result is subtype success carrying the model\'s own last words', result?.subtype === 'success' && result.is_error === false && String(result.result).startsWith('done: the model ended'), JSON.stringify({ subtype: result?.subtype, is_error: result?.is_error, result: result?.result }))
}

section('H2 — KEY ON: a loop-stopped run settles as its own error subtype, never as an empty success')
{
  setStopKey(true)
  const run = await runHeadless(pairs(10))
  const result = resultOf(run.yields)
  check('the model was called twenty times, never a twenty-first', run.modelCalls === 20, `calls=${run.modelCalls}`)
  check('exactly one SDK result was yielded', run.yields.filter(m => m.type === 'result').length === 1)
  check('its subtype is error_loop_stopped with is_error true', result?.subtype === 'error_loop_stopped' && result.is_error === true, JSON.stringify({ subtype: result?.subtype, is_error: result?.is_error }))
  check('its errors name the cycle that fired', Array.isArray(result?.errors) && /the same cycle of tool calls \(Edit -> Bash\)/.test(String((result?.errors as string[])[0])), JSON.stringify(result?.errors))
  check('no success envelope with an empty result rode the stream', !run.yields.some(m => m.type === 'result' && m.subtype === 'success'))
  setStopKey(null)
}

console.log('\n' + '='.repeat(76))
if (failures > 0) {
  console.log(`LOOP-GUARD-HEADLESS: ${failures} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`LOOP-GUARD-HEADLESS: all ${checks} checks passed`)
process.exit(0)
