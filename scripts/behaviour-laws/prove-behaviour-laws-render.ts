#!/usr/bin/env bun
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'vox-home-'))
const cwd = mkdtempSync(join(tmpdir(), 'vox-cwd-'))
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-proof-render'
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

const prompts = await import('../../src/engine/system-prompt/defaultSystemPrompt.ts')
const contractMod = await import('../../src/engine/system-prompt/behaviourContract.ts')

const toolNames = ['Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'Crewmate', 'Skill', 'TaskCreate', 'AskUserQuestion']
const tools = toolNames.map(name => ({ name })) as never
const segments = await prompts.getSystemPrompt(tools, 'claude-fable-5', [])
const contract = contractMod.resolveBehaviourContract(segments)
const openai = contractMod.renderOpenaiInstructions(contract)
const anthropic = segments.join('\n\n')

section('§1 the one-content law — every wire, the same content')
check('contract resolved from the registry (typed sections, not raw decode)', contract.sections.every(s => s.group !== 'segment'), 'resolveBehaviourContract in src/engine/system-prompt/behaviourContract.ts must type every section the system prompt of getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts carries, none left as a raw segment')
const VENDOR_STEER_RE = /\b(?:most recent|latest|newest|most capable|default to)\b[^.\n]{0,60}\b(?:Claude|GPT|Gemini|Llama|Grok|Mistral|Qwen|DeepSeek)\b[^.\n]{0,20}\bmodels\b/i
check('the neutral model-currency rule rides EVERY render', anthropic.includes('Model currency:') && openai.includes('Model currency:'), 'the Model currency rule must be a section of the contract that getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts composes, so every render carries it')
check("no render steers toward one vendor's models (the neutral rule instead)", !VENDOR_STEER_RE.test(anthropic) && !VENDOR_STEER_RE.test(openai), 'reword the prompt section that names one vendor as latest or default so it stays model-neutral; sections are composed in src/engine/system-prompt/defaultSystemPrompt.ts')
check('OpenAI render == Anthropic render (same content, join shape apart)', openai === anthropic, 'renderOpenaiInstructions in src/engine/system-prompt/behaviourContract.ts must render the same section text that getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts joins')
check('generic render == OpenAI render (chat lanes carry the same content)', contractMod.renderGenericInstructions(contract) === openai, 'renderGenericInstructions in src/engine/system-prompt/behaviourContract.ts must render the same content as renderOpenaiInstructions')
check('no section is family-scoped (every scope is "all")', contract.sections.every(s => s.scope === 'all'), 'a section of the contract resolved in src/engine/system-prompt/behaviourContract.ts has a scope other than all; make it provider-neutral')
const { MERCURY_CONSTITUTION } = await import('../../src/engine/system-prompt/mercuryContract.ts')
check('the constitution rides the composed output, provider-neutral, once', anthropic.split(MERCURY_CONSTITUTION).length === 2 && !/Claude|Anthropic|GPT|OpenAI/.test(MERCURY_CONSTITUTION), 'MERCURY_CONSTITUTION in src/engine/system-prompt/mercuryContract.ts must appear exactly once in the composed prompt and name no vendor')
check('the constitution rides the OpenAI render too', openai.includes(MERCURY_CONSTITUTION), 'renderOpenaiInstructions in src/engine/system-prompt/behaviourContract.ts must include MERCURY_CONSTITUTION from src/engine/system-prompt/mercuryContract.ts')

section('§2 one-owner law — sentinel doctrine phrases live in ONE section')
{
  const sentinels: Array<[string, RegExp]> = [
    ['the identity (You are Mercury)', /^You are Mercury, the coding agent working in the operator's terminal\./m],
    ['the stop sentence', /Outstanding work and verification never override that instruction\./],
    ['the evidence rule', /Use evidence appropriate to the claim\./],
    ['the instruction file (MERCURY.md)', /MERCURY\.md is the project's standing instruction file/],
    ['pinned memory (the user\'s own rule)', /is pinned memory instead/],
    ['the hooks fact', /Hooks are shell commands the user set up in settings/],
    ['the model-currency rule', /^Model currency:/m],
    ['the smallest-question rule', /ask the smallest direct question and briefly explain what depends on the answer\./],
    ['the failure rule', /Take reported failures seriously and investigate them\./],
  ]
  for (const [label, re] of sentinels) {
    const owners = contract.sections.filter(s => re.test(s.text)).map(s => s.name)
    check(`${label}: exactly one owner`, owners.length === 1, (owners.join(', ') || 'ABSENT') + ' | keep this doctrine phrase in exactly one section of the prompt that getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts composes; remove the duplicate or restore the missing one')
  }
}

section('§3 semantic ids — no positional section names; live references resolve')
{
  check('no positional section names', contract.sections.every(s => !/^(wrapper|mode)-\d+$/.test(s.name)), 'give each section a semantic name in resolveBehaviourContract in src/engine/system-prompt/behaviourContract.ts instead of wrapper-N or mode-N')
  const all = contract.sections.map(s => s.text).join('\n')
  check('live references resolve (spot set): the discovery commands the harness map names exist',
    all.includes('/help lists commands') && all.includes('/capabilities'), 'restore the harness map lines naming /help and /capabilities in the prompt sections composed by src/engine/system-prompt/defaultSystemPrompt.ts, or rename them to commands that exist')
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ BEHAVIOUR LAWS 2–4 (scope · one-owner · semantic ids) PASS')
else console.log(`❌ ${failures} RENDER CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
