;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
await import('../../src/tools/crewmate/CrewmateTool.tsx')
const { resolveAgentTools } = await import('../../src/tools/crewmate/crewmateLifecycle.ts')
const { buildSubagentMercurySections } = await import('../../src/tools/crewmate/subagentDoctrine.ts')
const { MEMORY_WRITE_VERBS_SENTENCE } = await import('../../src/sessions/mneme/mnemeFrontPage.ts')
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
  const front = resolveAgentTools(definition as never, pool).resolvedTools
  const back = resolveAgentTools(definition as never, pool).resolvedTools
  const prefix = (tools: typeof front) => buildSubagentMercurySections({ agentDefinition: definition, toolNames: new Set(tools.map(t => t.name)) }).join('\n\n')
  const initial = prefix(front)
  const resumed = prefix(back)
  check(`${definition.agentType}: memory verbs survive background resume`, memoryNames.every(name => back.some(tool => tool.name === name)), `${back.map(tool => tool.name).join(', ')}; hint: resolveAgentTools in src/tools/crewmate/crewmateLifecycle.ts must keep Retain, Recall, Reflect and Correct for this agent when it resumes`)
  check(`${definition.agentType}: foreground and background prefixes are byte-identical`, initial === resumed, `foreground writer=${initial.includes(MEMORY_WRITE_VERBS_SENTENCE)}; background writer=${resumed.includes(MEMORY_WRITE_VERBS_SENTENCE)}; hint: buildSubagentMercurySections in src/tools/crewmate/subagentDoctrine.ts must give the same text for the same tool pool, whichever run builds it`)
  const writerWords = (page: string): boolean => page.includes(MEMORY_WRITE_VERBS_SENTENCE) || /Memory is written only when the user asks for something to be remembered/.test(page)
  check(`${definition.agentType}: the shared memory writer supplies the wording (the verbs sentence, or the empty page's writer words)`, writerWords(initial) && writerWords(resumed), 'hint: buildSubagentMercurySections in src/tools/crewmate/subagentDoctrine.ts must include MEMORY_WRITE_VERBS_SENTENCE from src/sessions/mneme/mnemeFrontPage.ts for an agent that holds the memory tools')
}
for (const async of [false, true]) {
  const definition = { agentType: 'reader', source: 'projectSettings', tools: ['*'], disallowedTools: ['Retain', 'Correct'] }
  const tools = resolveAgentTools(definition as never, pool).resolvedTools
  const prefix = buildSubagentMercurySections({ agentDefinition: definition, toolNames: new Set(tools.map(t => t.name)) }).join('\n')
  check(`explicit memory denials still narrow the ${async ? 'background' : 'foreground'} pool`, !tools.some(t => t.name === 'Retain' || t.name === 'Correct'), `pool kept ${tools.map(t => t.name).join(', ')}; hint: resolveAgentTools in src/tools/crewmate/crewmateLifecycle.ts must drop the tools named in disallowedTools`)
  check('a reader is never told to use unavailable memory writers', !prefix.includes(MEMORY_WRITE_VERBS_SENTENCE), 'hint: buildSubagentMercurySections in src/tools/crewmate/subagentDoctrine.ts must leave out MEMORY_WRITE_VERBS_SENTENCE when Retain and Correct are not in the tool pool')
}
console.log(`resumed-memory-prefix: ${failures} failures`)
process.exit(failures ? 1 : 0)
