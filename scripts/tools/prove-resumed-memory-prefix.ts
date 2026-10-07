;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
await import('../../src/tools/AgentTool/AgentTool.tsx')
const { resolveAgentTools } = await import('../../src/tools/AgentTool/agentToolUtils.ts')
const { buildSubagentMercurySections } = await import('../../src/constants/subagentDoctrine.ts')
const { MEMORY_WRITE_VERBS_SENTENCE } = await import('../../src/mneme/mnemeFrontPage.ts')
const memoryNames = ['Retain', 'Recall', 'Reflect', 'Correct']
const pool = ['Read', ...memoryNames].map(name => ({ name })) as never
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail}`}`)
}
for (const definition of [
  { agentType: 'mercury-crew', source: 'built-in', tools: ['*'] },
  { agentType: 'remembering', source: 'projectSettings', tools: ['Read', ...memoryNames] },
]) {
  const front = resolveAgentTools(definition as never, pool, false).resolvedTools
  const back = resolveAgentTools(definition as never, pool, true).resolvedTools
  const prefix = (tools: typeof front) => buildSubagentMercurySections({ agentDefinition: definition, toolNames: new Set(tools.map(t => t.name)) }).join('\n\n')
  const initial = prefix(front)
  const resumed = prefix(back)
  check(`${definition.agentType}: memory verbs survive background resume`, memoryNames.every(name => back.some(tool => tool.name === name)), back.map(tool => tool.name).join(', '))
  check(`${definition.agentType}: foreground and background prefixes are byte-identical`, initial === resumed, `foreground writer=${initial.includes(MEMORY_WRITE_VERBS_SENTENCE)}; background writer=${resumed.includes(MEMORY_WRITE_VERBS_SENTENCE)}`)
  check(`${definition.agentType}: the shared memory writer supplies the wording`, initial.includes(MEMORY_WRITE_VERBS_SENTENCE) && resumed.includes(MEMORY_WRITE_VERBS_SENTENCE))
}
for (const async of [false, true]) {
  const definition = { agentType: 'reader', source: 'projectSettings', tools: ['*'], disallowedTools: ['Retain', 'Correct'] }
  const tools = resolveAgentTools(definition as never, pool, async).resolvedTools
  const prefix = buildSubagentMercurySections({ agentDefinition: definition, toolNames: new Set(tools.map(t => t.name)) }).join('\n')
  check(`explicit memory denials still narrow the ${async ? 'background' : 'foreground'} pool`, !tools.some(t => t.name === 'Retain' || t.name === 'Correct'))
  check('a reader is never told to use unavailable memory writers', !prefix.includes(MEMORY_WRITE_VERBS_SENTENCE))
}
console.log(`resumed-memory-prefix: ${failures} failures`)
process.exit(failures ? 1 : 0)
