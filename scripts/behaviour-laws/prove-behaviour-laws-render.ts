#!/usr/bin/env bun
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'vox-home-'))
const cwd = mkdtempSync(join(tmpdir(), 'vox-cwd-'))
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-proof-render'
delete process.env.MERCURY_WRAPPER_APPEND
process.chdir(cwd)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' behaviour laws 2–4 — provider scope · one owner · semantic ids')
console.log('============================================================')

const prompts = await import('../../src/constants/prompts.ts')
const contractMod = await import('../../src/prompt/behaviourContract.ts')

const toolNames = ['Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'Agent', 'Skill', 'TaskCreate', 'AskUserQuestion']
const tools = toolNames.map(name => ({ name })) as never
const segments = await prompts.getSystemPrompt(tools, 'claude-fable-5', undefined, [])
const contract = contractMod.resolveBehaviourContract(segments)
const openai = contractMod.renderOpenaiInstructions(contract)
const anthropic = segments.join('\n\n')

section('§1 the one-content law — every wire, the same content')
check('contract resolved from the registry (typed sections, not raw decode)', contract.sections.every(s => s.group !== 'segment'))
const VENDOR_STEER_RE = /\b(?:most recent|latest|newest|most capable|default to)\b[^.\n]{0,60}\b(?:Claude|GPT|Gemini|Llama|Grok|Mistral|Qwen|DeepSeek)\b[^.\n]{0,20}\bmodels\b/i
check('the neutral model-currency rule rides EVERY render', anthropic.includes('Model currency:') && openai.includes('Model currency:'))
check("no render steers toward one vendor's models (the neutral rule instead)", !VENDOR_STEER_RE.test(anthropic) && !VENDOR_STEER_RE.test(openai))
check('OpenAI render == Anthropic render (same content, join shape apart)', openai === anthropic)
check('generic render == OpenAI render (chat lanes carry the same content)', contractMod.renderGenericInstructions(contract) === openai)
check('no section is family-scoped (every scope is "all")', contract.sections.every(s => s.scope === 'all'))
check('identity floor provider-neutral in the composed output', /model is the engine/.test(anthropic) && anthropic.includes('Mercury was not built by the maker of any model it runs'))
const WORKING_NOTE_RULE =
  'Text written before a tool call is a one-line working note about the next step; the final answer never restates it and stands on its own.'
check('the working-note rule rides the Anthropic render', anthropic.includes(WORKING_NOTE_RULE))
check('the working-note rule rides the OpenAI render', openai.includes(WORKING_NOTE_RULE))
check('the working-note rule names no vendor or model', !/claude|anthropic|openai|gpt/i.test(WORKING_NOTE_RULE))

section('§2 one-owner law — sentinel doctrine phrases live in ONE section')
{
  const sentinels: Array<[string, RegExp]> = [
    ['methodName-to-snake-case example', /methodName.{0,60}snake/s],
    ['authorization-scope-bound', /Authorization stands for the scope/],
    ['no-colon-before-tool-calls', /colon before tool calls/],
    ['working-note-before-a-tool-call', /working note about the next step/],
    ['outcome-first close', /outcome-first|answer "what happened"/],
    ['end-turn-on-promise guard', /promise about work (you have not done|not yet done)/],
    ['audit-claims-against-tool-results', /audit each claim against a tool result/],
  ]
  for (const [label, re] of sentinels) {
    const owners = contract.sections.filter(s => re.test(s.text)).map(s => s.name)
    check(`${label}: exactly one owner`, owners.length === 1, owners.join(', ') || 'ABSENT')
  }
}

section('§3 semantic ids — no positional section names; live references resolve')
{
  check('no positional section names', contract.sections.every(s => !/^(wrapper|mode)-\d+$/.test(s.name)))
  const all = contract.sections.map(s => s.text).join('\n')
  check('tool references match the live catalog names (Read/Grep/Glob spot set)',
    all.includes('Read') && all.includes('Grep'))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ BEHAVIOUR LAWS 2–4 (scope · one-owner · semantic ids) PASS')
else console.log(`❌ ${failures} RENDER CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
