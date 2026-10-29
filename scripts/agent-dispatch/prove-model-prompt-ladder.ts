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
  check('the wire parameter is a short contract that names the two pages and points at the manual for the ladder', wireWords.length > 0 && Buffer.byteLength(wireWords) < 600 && wireWords.includes('mercury://models') && wireWords.includes('mercury://models/known') && wireWords.includes('The full manual'), wireWords)
  check('the manual carries the ladder under its own heading (## Model selection), the last section of the manual', manual.includes(MODEL_SECTION) && modelWords.length > 200, manual.slice(-300))
  check('the parameter has words', modelWords.length > 200, modelWords.slice(0, 120))
  check('"must be in its live catalogue" has left the prompt (RED on the base)', !modelWords.includes('must be in its live catalogue'), modelWords.slice(-300))
  check('it says how to know what is reachable: read mercury://models and name one of its rows (RED on the base)', modelWords.includes('To see the providers the operator is signed into and the models each reaches, read mercury://models and name one of them by its id'), modelWords)
  check("a family word runs that family's current default", modelWords.includes("a family word runs that family's current default"), modelWords)
  check('the ladder is spelled live, then known, then ask, with the known page named', modelWords.includes('The ladder is live, then known, then web, then ask') && modelWords.includes('mercury://models/known decides') && modelWords.includes('the launch receipt says so') && modelWords.includes('an exact id the known page lists runs'), modelWords)
  check('the last rung: ask the operator in an interactive session (AskUserQuestion, naming the signed-in providers and the nearest rows); one line and stop in a headless run', modelWords.includes('ask the operator for the model id with AskUserQuestion, naming the providers that are signed in, the nearest live or known rows') && modelWords.includes('in a headless run say why in one line and stop'), modelWords)
  check('never switch to another provider on your own — if the one asked for cannot run, say why and stop', modelWords.includes('Never switch to another provider on your own — if the one you were asked for cannot run, say why and stop.'), modelWords)
  check('the family words keep their rows named (grok, glm, kimi, deepseek, muse, mistral)', modelWords.includes("'grok' (xAI's newest Grok row)") && modelWords.includes("'glm' (Z.AI's newest GLM row)") && modelWords.includes("'kimi' (Moonshot's newest Kimi row)") && modelWords.includes("'deepseek' (DeepSeek's newest row)") && modelWords.includes("'muse' (Meta's newest served Standard Muse Spark row)") && modelWords.includes("'mistral' (Mistral's newest row)"), modelWords)
  check(`the sentence is free of the tool's own name (${AGENT_TOOL_NAME})`, !new RegExp(`\\b${AGENT_TOOL_NAME}\\b`).test(modelWords) && !/\bCrewmate tool\b/.test(modelWords), modelWords)
  check('no model-facing word, on the wire or in the manual, says "catalogue-verified" or demands a live catalogue', !/catalogue-verified|live catalogue/.test(modelWords) && !/catalogue-verified|live catalogue/.test(wireWords), modelWords)
}

section('§2 the same words wherever the model parameter repeats')
{
  const workflow = src('src/tools/WorkflowTool/workflowPrompt.ts')
  check("the Workflow tool's opts.model line points at mercury://models and the known page and keeps the operator-asks rung (RED on the base: 'a string the catalog cannot resolve fails the dispatch')", workflow.includes('read mercury://models and name one of them by its id') && workflow.includes('mercury://models/known decides') && workflow.includes('${MODEL_LOOKUP_LADDER}'), workflow.match(/opts\.model —[^\n]*/)?.[0] ?? '')
  const { getWorkflowToolPrompt } = await import('../../src/tools/WorkflowTool/workflowPrompt.ts').catch(() => ({ getWorkflowToolPrompt: undefined as undefined | (() => string) }))
  if (typeof getWorkflowToolPrompt === 'function') {
    const composed = String(getWorkflowToolPrompt())
    check("the composed Workflow prompt carries the pointer", composed.includes('read mercury://models and name one of them by its id'), composed.slice(0, 200))
  }
  const { InspectTool } = await import('../../src/tools/InspectTool/InspectTool.ts')
  const inspect = await InspectTool.prompt({} as never)
  check('the Inspect tool tells the model the two pages exist and what each is (RED on the base)', inspect.includes('mercury://models is what the operator sees in /model and /logins') && inspect.includes('mercury://models/known is what this build knows from its pin tables, not what is reachable now') && inspect.includes('Before naming a model for a launch, read mercury://models'), inspect.slice(-700))
  const { readTargetPromptLines } = await import('../../src/tools/FileReadTool/readTarget.ts')
  const read = readTargetPromptLines()
  check("the Read tool's description keeps its byte budget: the pages ride its mercury:// line without a sentence of their own (the fact lives once, in the launch parameter and the Inspect listing)", read.includes('This tool also reads mercury:// resource references') && !read.includes('mercury://models'), read)
  const crew = src('docs/CREW.md')
  check('docs/CREW.md follows: the two pages, the family-word default and the receipt line, the ask rung, the /logins refusal, never another provider (RED on the base)', crew.includes('`mercury://models` lists the providers the operator is signed into') && crew.includes('`mercury://models/known` lists the models this build knows') && crew.includes("runs the family's pinned default (xAI: Grok 4.7) and the launch receipt says") && crew.includes('ask the operator for the model id') && crew.includes('naming `/logins`') && crew.includes('no\nlaunch ever moves to another provider on its own'), crew.slice(crew.indexOf('## Starting a crewmate'), crew.indexOf('## Starting a crewmate') + 1800))
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`)
process.exit(failures === 0 ? 0 : 1)
