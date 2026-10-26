import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentLaunchPlanInput } from '../../src/utils/crew/agentLaunchPlan.js'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const home = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'launch-receipts-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { buildAgentLaunchPlan } = await import('../../src/utils/crew/agentLaunchPlan.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.js')
const { PROVIDER_ID_SPACES, providerDisplayName } = await import('../../src/services/providers/routeLaw.js')
let checks = 0
function check(label: string, condition: unknown): void {
  assert.ok(condition, label)
  checks++
  console.log(`PASS ${label}`)
}
const base = (over: Partial<AgentLaunchPlanInput> = {}): AgentLaunchPlanInput => ({
  activeAgents: [{ agentType: 'mercury-crew', source: 'built-in', whenToUse: 'fixture', getSystemPrompt: () => '', model: 'inherit' }],
  toolPermissionContext: getEmptyToolPermissionContext(),
  defaultAgentType: 'mercury-crew', engineModel: 'claude-fable-5-1',
  runInBackground: true, backgroundTasksDisabled: false, forceAsync: false,
  ...over,
})
const receipt = (modelNote: string | undefined, backgroundReason?: string): string => {
  const mapped = AgentTool.mapToolResultToToolResultBlockParam({
    status: 'async_launched', isAsync: true, agentId: 'receipt-fixture', agentName: 'receipt-test',
    outputFile: 'receipt-fixture.output', canReadOutputFile: false, modelNote, backgroundReason,
  } as never, 'receipt-call')
  return (mapped.content as Array<{ text: string }>).map(block => block.text).join('\n')
}

try {
  const models = [
    { label: 'Anthropic explicit', model: 'claude-fable-5-1', provider: 'Anthropic', options: { resolvedModel: 'claude-fable-5-1' } },
    { label: 'Anthropic inherited', model: 'claude-fable-5-1', provider: 'Anthropic', options: {} },
    { label: 'OpenAI explicit', model: 'gpt-6-astra', provider: 'OpenAI', options: { engineDispatch: { backend: 'openai' as const, model: 'gpt-6-astra' } } },
    { label: 'OpenAI inherited', model: 'gpt-6-astra', provider: 'OpenAI', options: { engineModel: 'gpt-6-astra' } },
    { label: 'Gemini explicit', model: 'gemini-4-argon-high', provider: 'Gemini', options: { engineDispatch: { backend: 'gemini' as const, model: 'gemini-4-argon-high' } } },
    { label: 'Gemini inherited', model: 'gemini-4-argon-high', provider: 'Gemini', options: { engineModel: 'gemini-4-argon-high' } },
  ]
  for (const fixture of models) {
    const plan = buildAgentLaunchPlan(base(fixture.options))
    const expected = `engine: ${fixture.provider} (${fixture.model}) via the native in-process transport`
    check(`${fixture.label}: the plan names the resolved engine`, plan.model === fixture.model && plan.modelNote === expected)
    for (const reason of [undefined, 'backgrounded', 'turn-interrupted', 'message-queued']) {
      const text = receipt(plan.modelNote, reason)
      check(`${fixture.label}, ${reason ?? 'background launch'}: the receipt carries one identical engine line`, text.startsWith('Crewmate launched in the background.\n') && text.split('\n').filter(line => line.startsWith('engine:')).join('\n') === expected)
    }
  }
  for (const space of PROVIDER_ID_SPACES) {
    const model = `${space.qualifiedPrefix ?? space.barePrefixes?.[0]}fixture/model`
    const expected = `engine: ${providerDisplayName(space.route)} (${model}) via the native in-process transport`
    for (const dispatch of [true, false]) {
      const plan = buildAgentLaunchPlan(base(dispatch ? { engineDispatch: { backend: space.route, model } } : { engineModel: model }))
      check(`${space.route}, ${dispatch ? 'dispatch' : 'inherit'}: the receipt uses the provider-independent shape`, plan.modelNote === expected && receipt(plan.modelNote).split('\n').includes(expected))
    }
  }
  const noted = buildAgentLaunchPlan(base({ engineDispatch: { backend: 'openai', model: 'gpt-6-astra', note: 'fixture catalogue note' } }))
  check('existing dispatch detail stays after the engine line', noted.modelNote === 'engine: OpenAI (gpt-6-astra) via the native in-process transport — fixture catalogue note')
  const unknown = buildAgentLaunchPlan(base({ resolvedModel: 'gateway-fixture' }))
  check('an undeclared model is not mislabeled as Anthropic', unknown.modelNote === 'engine: Gateway (Anthropic-compatible) (gateway-fixture) via the native in-process transport')
  console.log(`Launch engine receipts: ${checks} checks passed (no model launches)`)
} finally {
  rmSync(home, { recursive: true, force: true })
}
