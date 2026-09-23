#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const home = mkdtempSync(join(tmpdir(), 'parent-family-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.OPENAI_API_KEY = 'fixture-openai-key'
const { getAgentModel } = await import('../../src/utils/model/agent.js')
const { resolveEngineDispatch, unrecognisedModelWordRefusal } = await import('../../src/utils/swarm/engineDispatch.js')
const { refreshProviderDiscovery } = await import('../../src/utils/router/providerDiscovery.js')
const { refreshOpenaiCatalogue } = await import('../../src/services/providers/openai/openaiCatalogue.js')
const { buildAgentLaunchPlan } = await import('../../src/utils/swarm/agentLaunchPlan.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
await refreshProviderDiscovery('openai', { force: true })
await refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: (async () => new Response(JSON.stringify({ models: ['gpt-5.6-sol', 'gpt-5.6-terra'].map((id, i) => ({ slug: id, display_name: id, priority: i + 1, supported_reasoning_levels: ['high'], supported_in_api: true, visibility: 'public' })) }), { headers: { 'content-type': 'application/json' } })) as typeof fetch })
const source = readFileSync(join(import.meta.dir, '../../src/tools/AgentTool/AgentTool.tsx'), 'utf8')
const step = source.slice(source.indexOf('    const modelParam = input.model'), source.indexOf('    if (isTeammateSpawn(input, teamName)) {'))
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const resolve = new AsyncFunction('input', 'options', 'getAgentModel', 'resolveEngineDispatch', 'unrecognisedModelWordRefusal', `${step}\nreturn { engineDispatch, modelParam: typeof modelParam === 'undefined' ? input.model : modelParam }`) as (...args: unknown[]) => Promise<{ engineDispatch: { backend: string; model: string } | null; modelParam?: string }>
const teammate = /const teammateModel =([\s\S]*?)\n\s*const spawned/.exec(source)?.[1]
const parameter = /modelParam:([^\n]*)/.exec(source)?.[1].replace(/,\s*$/, '').replace(' as never', '')
if (!teammate || !parameter) throw new Error('the Agent tool model handoff was not found')
const teammateModel = new Function('engineDispatch', 'input', 'modelParam', 'teammateDefinition', `return ${teammate.trim()}`)
const planParameter = new Function('engineDispatch', 'input', 'modelParam', `return ${parameter}`)
const resolvedParameter = /resolvedModel:([^\n]*)/.exec(source)?.[1].replace(/,\s*$/, '')
const planResolved = new Function('modelParam', `return ${resolvedParameter ?? 'undefined'}`)
const definition = { agentType: 'mercury-general', source: 'built-in', whenToUse: 'general', getSystemPrompt: () => 'general' }
let failures = 0
function check(label: string, ok: boolean, actual: unknown): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}: ${JSON.stringify(actual)}`)
}
try {
  for (const [parent, word, expected] of [['gpt-5.6-terra', 'gpt', 'gpt-5.6-terra'], ['claude-sonnet-5', 'gpt', 'gpt-5.6-sol'], ['claude-sonnet-5[1m]', 'sonnet', 'claude-sonnet-5[1m]'], ['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-sol']]) {
    const input = { model: word }
    const resolved = await resolve(input, { mainLoopModel: parent }, getAgentModel, resolveEngineDispatch, unrecognisedModelWordRefusal)
    const plan = buildAgentLaunchPlan({ requestedType: 'mercury-general', activeAgents: [definition], toolPermissionContext: getEmptyToolPermissionContext(), forkGateOn: false, forkAgent: definition, defaultAgentType: 'mercury-general', mainLoopModel: parent, modelParam: planParameter(resolved.engineDispatch, input, resolved.modelParam), resolvedModel: planResolved(resolved.modelParam), backgroundTasksDisabled: false, forceAsync: false, ...(resolved.engineDispatch ? { engineDispatch: resolved.engineDispatch } : {}) } as never)
    const spawnModel = teammateModel(resolved.engineDispatch, input, resolved.modelParam, undefined)
    check(`${parent} + ${word}: the plan retains the resolved model`, plan.model === expected, plan.model)
    check(`${parent} + ${word}: the teammate receives the same exact model`, spawnModel === expected, spawnModel)
  }
  let refusal = ''
  try { await resolve({ model: 'plainword' }, { mainLoopModel: 'gpt-5.6-terra' }, getAgentModel, resolveEngineDispatch, unrecognisedModelWordRefusal) } catch (error) { refusal = String((error as Error).message) }
  check('an unknown word keeps its refusal unchanged', refusal === unrecognisedModelWordRefusal('plainword'), refusal)
} finally {
  rmSync(home, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
