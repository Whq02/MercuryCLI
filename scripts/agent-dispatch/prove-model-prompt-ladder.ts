#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'model-prompt-ladder-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = home
delete process.env.NODE_ENV
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(" the model prompt's ladder: read mercury://models, then mercury://models/known, then ask — never a live-catalogue demand, never another provider")
console.log('============================================================')

;(await import('../../src/platform/settings/config.ts')).enableConfigs()
const { CrewmateTool } = await import('../../src/tools/crewmate/CrewmateTool.tsx')
const { agentRosterOf, withoutAgentRoster } = await import('../../src/tools/crewmate/prompt.ts')
const { CREWMATE_TOOL_NAME } = await import('../../src/tools/kit/names/crewmate.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { getAllBaseTools } = await import('../../src/tools/kit/toolList.ts')
const { zodToJsonSchema } = await import('../../src/platform/primitives/zodToJsonSchema.ts')
const schema = zodToJsonSchema(CrewmateTool.inputSchema as never) as { properties?: Record<string, { description?: string }> }
const wireWords = schema.properties?.model?.description ?? ''
const permissionContext = getEmptyToolPermissionContext()
const manual = await CrewmateTool.prompt({ getToolPermissionContext: async () => permissionContext, tools: [...getAllBaseTools()], agents: [] })
const MODEL_SECTION = '\n## Model selection\n'
const modelWords = manual.includes(MODEL_SECTION) ? manual.slice(manual.indexOf(MODEL_SECTION) + MODEL_SECTION.length).split('\n## ')[0]! : ''

section("§1 the launch tool's model parameter")
{
  check('the model field names live discovery once without a fallback ladder', wireWords.includes('read mercury://models') && wireWords.split('mercury://models').length === 2 && !wireWords.includes('mercury://models/known'), wireWords)
  check('the field preserves model grammar and precedence', ['[1m]', 'your own family keeps your exact model', 'Overrides the agent definition', "omitted, the definition's model, else the configured crewmate default, else yours"].every(words => wireWords.includes(words)), wireWords)
  check('the operator model/effort choice is preserved once in its field', wireWords.includes("Follow the operator's model and effort; never downgrade to obtain read-only scoping.") && !manual.includes('never downgrade'), wireWords)
  check('the manual has no model ladder or alias inventory', !manual.includes(MODEL_SECTION) && modelWords === '' && !manual.includes('Class aliases:') && !manual.includes('mercury://models'), manual)
  const wire = CrewmateTool.wireDescription(manual)
  const purpose = withoutAgentRoster(wire)
  check('the wire is a purpose statement plus the agent roster, not an abridged manual', Buffer.byteLength(purpose) <= 200 && !wire.includes('Model and effort:') && !manual.includes(purpose) && wire.includes(agentRosterOf(manual)))
}

section('§2 the same words wherever the model parameter repeats')
{
  const { InspectTool } = await import('../../src/tools/inspect/InspectTool.ts')
  const inspect = await InspectTool.prompt({} as never)
  check('Inspect names both model pages once and carries no launch runbook', inspect.includes("models — mercury://models lists reachable models live; mercury://models/known lists this build's pin tables, not reachability.") && inspect.split('mercury://models/known').length === 2 && !inspect.includes('Before naming a model for a launch') && Buffer.byteLength(inspect) <= 800, inspect)
  const { readTargetPromptLines } = await import('../../src/tools/read/readTarget.ts')
  const read = readTargetPromptLines()
  check("the Read tool's description keeps its byte budget: mercury:// records in one sentence, the models pages not named (the fact lives once, in the launch parameter and the Inspect listing)", read.includes('A mercury:// reference reads a session record') && !read.includes('mercury://models'), read)
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`)
process.exit(failures === 0 ? 0 : 1)
