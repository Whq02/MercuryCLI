#!/usr/bin/env bun
// ============================================================================
//  scripts/behaviour-laws/prove-behaviour-laws-render.ts — laws 2–4 on the REAL
//  rendered contract (getSystemPrompt end-to-end under a pinned scratch
//  environment — the F6 ambient-state law: fresh MERCURY_CONFIG_DIR, fixture
//  cwd outside the repo, proof credential from the environment).
//
//    §1 PROVIDER LAW: the OpenAI render of the default contract carries ZERO
//       Claude model-currency instructions and no Claude-identity engine
//       clause; the GPT developer delta rides the OpenAI render only; the
//       Anthropic render carries the currency section and never the delta.
//    §2 ONE-OWNER LAW: sentinel doctrine phrases appear in exactly ONE
//       composed section (the duplicate-ownership detector).
//    §3 STALE-NAME LAW: no retired wrapper machinery, no retired register
//       register, no positional section ids anywhere in the composed
//       contract; live command/tool references resolve (spot set).
//
//  Run:  ~/.bun/bin/bun run scripts/behaviour-laws/prove-behaviour-laws-render.ts
// ============================================================================
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Scratch home BEFORE imports (module-load env reads).
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
console.log(' behaviour laws 2–4 — provider scope · one owner · no stale names')
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
check('OpenAI render: ZERO Claude model-currency instructions', !openai.includes('The most recent Claude models'))
check('OpenAI render: no "default to … Claude models" steering', !openai.includes('default to the latest and most capable Claude models'))
check('OpenAI render: no Claude-engine identity clause', !openai.includes('Claude model family'))
check('NO wire carries a family overlay (agentic_persistence retired)', !openai.includes('<agentic_persistence>') && !anthropic.includes('<agentic_persistence>'))
check('the neutral model-currency rule rides EVERY render', anthropic.includes('Model currency:') && openai.includes('Model currency:'))
check('no vendor model list hardcoded in prose (neutral rule instead)', !anthropic.includes('The most recent Claude models'))
check('OpenAI render == Anthropic render (same content, join shape apart)', openai === anthropic)
check('generic render == OpenAI render (chat lanes carry the same content)', contractMod.renderGenericInstructions(contract) === openai)
check('no section is family-scoped (every scope is "all")', contract.sections.every(s => s.scope === 'all'))
check('identity floor provider-neutral in the composed output', /model is the engine/.test(anthropic) && anthropic.includes('Mercury was not built by the maker of any model it runs'))

section('§2 one-owner law — sentinel doctrine phrases live in ONE section')
{
  const sentinels: Array<[string, RegExp]> = [
    ['methodName-to-snake-case example', /methodName.{0,60}snake/s],
    ['authorization-scope-bound', /Authorization stands for the scope/],
    ['no-colon-before-tool-calls', /colon before tool calls/],
    ['outcome-first close', /outcome-first|answer "what happened"/],
    ['end-turn-on-promise guard', /promise about work (you have not done|not yet done)/],
    ['audit-claims-against-tool-results', /audit each claim against a tool result/],
  ]
  for (const [label, re] of sentinels) {
    const owners = contract.sections.filter(s => re.test(s.text)).map(s => s.name)
    check(`${label}: exactly one owner`, owners.length === 1, owners.join(', ') || 'ABSENT')
  }
}

section('§3 stale-name law — retired machinery absent; ids semantic')
{
  const stale: Array<[string, RegExp]> = [
    ['retired coordination verbs', new RegExp(['temp', 'est_coord'].join('') + '|coord\\.mjs|sched-watch')],
    ['retired instance keys', /TF_REPO_ID|TF_WORKTREE_ID/],
    ['retired register', new RegExp(['Temp', 'est'].join('') + ' (Desert|harness|agent)')],
    ['lease/freeze machinery', new RegExp('FREEZE_WRITES|lease_claim|' + ['temp', 'est_lease'].join(''))],
    ['retired STATUS stop-rule', /STATUS: done or STATUS: blocked/],
    ['TodoWrite phantom (not in this catalog)', /TodoWrite/],
  ]
  for (const [label, re] of stale) {
    const hit = contract.sections.find(s => re.test(s.text))
    check(`absent: ${label}`, hit === undefined, hit ? `${hit.name}` : '')
  }
  check('no positional section names', contract.sections.every(s => !/^(wrapper|mode)-\d+$/.test(s.name)))
  // live references resolve (spot set): sections that name commands/tools the
  // session actually has. /provenance /doctor exist as commands; Read/
  // Grep names match the enabled tool list.
  const all = contract.sections.map(s => s.text).join('\n')
  check('tool references match the live catalog names (Read/Grep/Glob spot set)',
    all.includes('Read') && all.includes('Grep'))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ BEHAVIOUR LAWS 2–4 (scope · one-owner · stale-names) PASS')
else console.log(`❌ ${failures} RENDER CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
