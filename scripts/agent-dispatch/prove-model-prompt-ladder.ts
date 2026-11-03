#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

;(await import('../../src/utils/config.ts')).enableConfigs()
const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
const { AGENT_TOOL_NAME } = await import('../../src/tools/AgentTool/constants.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getAllBaseTools } = await import('../../src/tools.ts')
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
const schema = zodToJsonSchema(AgentTool.inputSchema as never) as { properties?: Record<string, { description?: string }> }
const wireWords = schema.properties?.model?.description ?? ''
const permissionContext = getEmptyToolPermissionContext()
const manual = await AgentTool.prompt({ getToolPermissionContext: async () => permissionContext, tools: [...getAllBaseTools()], agents: [] })
const MODEL_SECTION = '\n## Model selection\n'
const modelWords = manual.includes(MODEL_SECTION) ? manual.slice(manual.indexOf(MODEL_SECTION) + MODEL_SECTION.length).split('\n## ')[0]! : ''
const src = (rel: string): string => readFileSync(join(import.meta.dir, '../../', rel), 'utf8')

section("§1 the launch tool's model parameter")
{
  check('the model field names live discovery once without a fallback ladder', wireWords.includes('read mercury://models') && wireWords.split('mercury://models').length === 2 && !wireWords.includes('mercury://models/known'), wireWords)
  check('the field preserves model grammar and precedence', ['[1m]', 'your own family keeps your exact model', 'Overrides the agent definition', 'omitted inherits yours'].every(words => wireWords.includes(words)), wireWords)
  check('the operator model/effort choice is preserved once in its field', wireWords.includes("Follow the operator's model and effort; never downgrade to obtain read-only scoping.") && !manual.includes('never downgrade'), wireWords)
  check('the manual has no model ladder or alias inventory', !manual.includes(MODEL_SECTION) && modelWords === '' && !manual.includes('Class aliases:') && !manual.includes('mercury://models'), manual)
  check('the wire is a purpose statement, not an abridged manual', Buffer.byteLength(AgentTool.wireDescription()) <= 200 && !AgentTool.wireDescription().includes('Model and effort:') && !manual.includes(AgentTool.wireDescription()))
}

section('§2 the same words wherever the model parameter repeats')
{
  const workflow = src('src/tools/WorkflowTool/workflowPrompt.ts')
  check('Workflow defines its model option without copying discovery or recovery', workflow.includes('opts.model: operator-selected model id or family word') && !workflow.includes('mercury://models') && !workflow.includes('${MODEL_LOOKUP_LADDER}'))
  const { getWorkflowToolPrompt } = await import('../../src/tools/WorkflowTool/workflowPrompt.ts').catch(() => ({ getWorkflowToolPrompt: undefined as undefined | (() => string) }))
  if (typeof getWorkflowToolPrompt === 'function') {
    const composed = String(getWorkflowToolPrompt())
    check('the composed Workflow manual keeps model selection in its option once', composed.split('opts.model:').length === 2 && !composed.includes('mercury://models'), composed.slice(0, 200))
  }
  const { InspectTool } = await import('../../src/tools/InspectTool/InspectTool.ts')
  const inspect = await InspectTool.prompt({} as never)
  check('Inspect names both model pages once and carries no launch runbook', inspect.includes("models — mercury://models lists reachable models live; mercury://models/known lists this build's pin tables, not reachability.") && inspect.split('mercury://models/known').length === 2 && !inspect.includes('Before naming a model for a launch') && Buffer.byteLength(inspect) <= 800, inspect)
  const { readTargetPromptLines } = await import('../../src/tools/FileReadTool/readTarget.ts')
  const read = readTargetPromptLines()
  check("the Read tool's description keeps its byte budget: the pages ride its mercury:// line without a sentence of their own (the fact lives once, in the launch parameter and the Inspect listing)", read.includes('This tool also reads mercury:// resource references') && !read.includes('mercury://models'), read)
  const crew = src('docs/CREW.md')
  check('docs/CREW.md follows: the two pages, the family-word default and the receipt line, the ask rung, the /logins refusal, never another provider (RED on the base)', crew.includes('`mercury://models` lists the providers the operator is signed into') && crew.includes('`mercury://models/known` lists the models this build knows') && crew.includes("runs the family's pinned default (xAI: Grok 4.7) and the launch receipt says") && crew.includes('ask the operator for the model id') && crew.includes('naming `/logins`') && crew.includes('no\nlaunch ever moves to another provider on its own'), crew.slice(crew.indexOf('## Starting a crewmate'), crew.indexOf('## Starting a crewmate') + 1800))
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`)
process.exit(failures === 0 ? 0 : 1)
