#!/usr/bin/env bun
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'cache-prefix-home-'))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cache-prefix-cwd-')))
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-proof-cache-prefix'
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
console.log(' cache-prefix law — byte-stable renders per family')
console.log('============================================================')

const prompts = await import('../../src/engine/system-prompt/defaultSystemPrompt.ts')
const bc = await import('../../src/engine/system-prompt/behaviourContract.ts')
const sections = await import('../../src/engine/system-prompt/systemPromptSections.ts')
const { setOriginalCwd } = await import('../../src/boot/process-state/processState.ts')
const { MERCURY_CONSTITUTION } = await import('../../src/engine/system-prompt/mercuryContract.ts')

const toolNames = ['Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'Crewmate', 'Skill', 'TaskCreate', 'AskUserQuestion']
const tools = toolNames.map(name => ({ name })) as never

const FAMILY_MODELS: ReadonlyArray<[bc.ContractRenderFamily, string]> = [
  ['anthropic', 'claude-fable-5'],
  ['openai', 'gpt-5.6-codex'],
  ['generic', 'glm-4.7'],
]

const renderFor = (family: bc.ContractRenderFamily, segments: string[]): string =>
  bc.renderContractSections(bc.resolveBehaviourContract(segments), family).join('\n\n')

for (const [family, model] of FAMILY_MODELS) {
  section(`§1 turn stability — ${family} (${model})`)
  const turn1 = await prompts.getSystemPrompt(tools, model, [])
  const turn2 = await prompts.getSystemPrompt(tools, model, [])
  const r1 = renderFor(family, turn1)
  const r2 = renderFor(family, turn2)
  check('consecutive builds render byte-identical', r1 === r2,
    `len ${r1.length} vs ${r2.length} — getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts must build the same sections on every call; look for a per-call value in a section, and see renderContractSections in src/engine/system-prompt/behaviourContract.ts`)
  const d1 = bc.resolveBehaviourContract(turn1).digest
  const d2 = bc.resolveBehaviourContract(turn2).digest
  check('consecutive builds carry the same contract digest', d1 === d2, `${d1} vs ${d2} — resolveBehaviourContract in src/engine/system-prompt/behaviourContract.ts must digest only stable section text`)
  check('resolved from the registry (typed sections, not raw decode)',
    bc.resolveBehaviourContract(turn1).sections.every(s => s.group !== 'segment'), 'resolveBehaviourContract in src/engine/system-prompt/behaviourContract.ts fell back to contractFromSegments (raw segments); composeSystemPrompt in src/engine/system-prompt/composer.ts must register the composition through registerComposedContract so the registry finds it')

  section(`§2 signature moves only with inputs — ${family}`)
  setOriginalCwd(join(cwd, 'other-project'))
  const frozen = await prompts.getSystemPrompt(tools, model, [])
  check('within the conversation a changed input is frozen out (byte-identical render, same digest)', renderFor(family, frozen) === r1 && bc.resolveBehaviourContract(frozen).digest === d1, 'a section that reads the working directory must be cached through systemPromptSection or keyedSystemPromptSection in src/engine/system-prompt/systemPromptSections.ts, not recomputed each turn')
  sections.clearSystemPromptSections()
  const changed = await prompts.getSystemPrompt(tools, model, [])
  const dChanged = bc.resolveBehaviourContract(changed).digest
  check('across the lawful boundary a changed input moves the digest', dChanged !== d1, 'after clearSystemPromptSections (src/engine/system-prompt/systemPromptSections.ts) the head built in getSystemPrompt (src/engine/system-prompt/defaultSystemPrompt.ts) must reflect the new working directory and move the digest')
  sections.clearSystemPromptSections()
  setOriginalCwd(cwd)
  const restored = await prompts.getSystemPrompt(tools, model, [])
  check('restoring the input restores the byte-identical render',
    renderFor(family, restored) === r1, `getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts must derive the working directory only from getOriginalCwd(); some other input survived the change`)
  check('…and the original digest', bc.resolveBehaviourContract(restored).digest === d1, `getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts must derive the digest only from its inputs; restoring the cwd did not restore it`)

  section(`§3 prefix stability under the input change — ${family}`)
  const base = renderFor(family, turn1)
  const moved = renderFor(family, changed)
  let firstDiff = 0
  const max = Math.min(base.length, moved.length)
  while (firstDiff < max && base[firstDiff] === moved[firstDiff]) firstDiff++
  check('the renders differ across the boundary (the input is render-visible)', base !== moved, 'the working directory must appear in the head built by getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts')
  check('a non-empty shared prefix precedes the first difference', firstDiff > 0,
    `firstDiff=${firstDiff} — the render must open with content that does not vary with the working directory (src/engine/system-prompt/defaultSystemPrompt.ts)`)
  const headLine = 'Working directory: '
  check('the first difference is the working directory in the head (the head leads; the constitution beneath it is byte-identical on both sides)',
    firstDiff >= headLine.length && base.startsWith(headLine) && moved.startsWith(headLine) && base.includes(MERCURY_CONSTITUTION) && moved.includes(MERCURY_CONSTITUTION),
    `firstDiff=${firstDiff} — getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts must put 'Working directory: ' first and the unchanged constitution (src/engine/system-prompt/mercuryContract.ts) after it`)

  section(`§4 the per-turn context tail — ${family}`)
  const tailed = [...turn1, 'gitStatus: clean (turn weather)']
  const rTailed = renderFor(family, tailed)
  check('composed render is a strict prefix of the tail-carrying render',
    rTailed.startsWith(r1) && rTailed.length > r1.length, 'resolveBehaviourContract in src/engine/system-prompt/behaviourContract.ts must keep the registered sections first and add the trailing context segment as a final turn-class section')
  check('the tail never joins the digest',
    bc.resolveBehaviourContract(tailed).digest === d1, 'resolveBehaviourContract in src/engine/system-prompt/behaviourContract.ts must give the base contract digest when only a trailing segment was added')
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ CACHE-PREFIX LAWS PASS')
else console.log(`❌ ${failures} CACHE-PREFIX CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
