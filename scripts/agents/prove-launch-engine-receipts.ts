import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CrewmateLaunchPlanInput } from '../../src/crew/crewmates/crewmateLaunchPlan.js'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const home = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'launch-receipts-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
const { buildCrewmateLaunchPlan } = await import('../../src/crew/crewmates/crewmateLaunchPlan.js')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.js')
const { CrewmateTool } = await import('../../src/tools/crewmate/CrewmateTool.js')
const { PROVIDER_ID_SPACES, providerDisplayName } = await import('../../src/models/roads/routeLaw.js')
let checks = 0
function check(label: string, condition: unknown, hint = ''): void {
  assert.ok(condition, hint ? `${label} — ${hint}` : label)
  checks++
  console.log(`PASS ${label}`)
}
const base = (over: Partial<CrewmateLaunchPlanInput> = {}): CrewmateLaunchPlanInput => ({
  activeAgents: [{ agentType: 'mercury-crew', source: 'built-in', whenToUse: 'fixture', getSystemPrompt: () => '', model: 'inherit' }],
  toolPermissionContext: getEmptyToolPermissionContext(),
  defaultAgentType: 'mercury-crew', engineModel: 'claude-fable-5-1',
  runInBackground: true, backgroundTasksDisabled: false, forceAsync: false,
  ...over,
})
const receipt = (modelNote: string | undefined, backgroundReason?: string): string => {
  const mapped = CrewmateTool.mapToolResultToToolResultBlockParam({
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
    const plan = buildCrewmateLaunchPlan(base(fixture.options))
    const expected = `engine: ${fixture.provider} (${fixture.model}) via the native in-process transport`
    check(`${fixture.label}: the plan names the resolved engine`, plan.model === fixture.model && plan.modelNote === expected, 'buildAgentLaunchPlan in src/crew/crewmates/crewmateLaunchPlan.ts must set model and modelNote to the engine line for this fixture')
    for (const reason of [undefined, 'backgrounded', 'turn-interrupted', 'message-queued']) {
      const text = receipt(plan.modelNote, reason)
      check(`${fixture.label}, ${reason ?? 'background launch'}: the receipt carries one identical engine line`, text.startsWith('Crewmate launched in the background.\n') && text.split('\n').filter(line => line.startsWith('engine:')).join('\n') === expected, 'agentToolResultBlock in src/tools/crewmate/call/resultBlock.ts must print the plan modelNote as one engine line in the async-launched receipt')
    }
  }
  for (const space of PROVIDER_ID_SPACES) {
    const model = `${space.qualifiedPrefix ?? space.barePrefixes?.[0]}fixture/model`
    const expected = `engine: ${providerDisplayName(space.route)} (${model}) via the native in-process transport`
    for (const dispatch of [true, false]) {
      const plan = buildCrewmateLaunchPlan(base(dispatch ? { engineDispatch: { backend: space.route, model } } : { engineModel: model }))
      check(`${space.route}, ${dispatch ? 'dispatch' : 'inherit'}: the receipt uses the provider-independent shape`, plan.modelNote === expected && receipt(plan.modelNote).split('\n').includes(expected), 'buildAgentLaunchPlan in src/crew/crewmates/crewmateLaunchPlan.ts must build the modelNote with providerDisplayName for this route, and agentToolResultBlock in src/tools/crewmate/call/resultBlock.ts must print it')
    }
  }
  const noted = buildCrewmateLaunchPlan(base({ engineDispatch: { backend: 'openai', model: 'gpt-6-astra', note: 'fixture catalogue note' } }))
  check('existing dispatch detail stays after the engine line', noted.modelNote === 'engine: OpenAI (gpt-6-astra) via the native in-process transport — fixture catalogue note', 'the engineDispatch branch of buildAgentLaunchPlan in src/crew/crewmates/crewmateLaunchPlan.ts must keep the engine line first and append the dispatch note after it')
  const unknown = buildCrewmateLaunchPlan(base({ resolvedModel: 'gateway-fixture' }))
  check('an undeclared model is not mislabeled as Anthropic', unknown.modelNote === 'engine: Gateway (Anthropic-compatible) (gateway-fixture) via the native in-process transport', 'the modelNote of buildAgentLaunchPlan in src/crew/crewmates/crewmateLaunchPlan.ts must label an undeclared model through laneLabelForVerdict, not as Anthropic')
  console.log(`Launch engine receipts: ${checks} checks passed (no model launches)`)
} finally {
  rmSync(home, { recursive: true, force: true })
}
