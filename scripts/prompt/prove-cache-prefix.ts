#!/usr/bin/env bun
// ============================================================================
//  scripts/prompt/prove-cache-prefix.ts — the prompt-cache correctness law
//  at the composer seam.
//
//  Prompt caching is a MEASURED invariant, not an assertion: a provider cache
//  hits only when the rendered prefix is byte-identical between consecutive
//  requests. This prover pins, per render family (anthropic · openai ·
// generic), under a environment (the F6 ambient-state law):
//
//    §1 TURN STABILITY — two consecutive getSystemPrompt builds with
//       identical inputs render byte-identical strings on every family
//       renderer, and carry the same contract digest (no hidden per-turn
//       entropy — a timestamp or counter anywhere in the composition would
//       break every provider cache silently).
//    §2 SIGNATURE MOVES ONLY WITH INPUTS — a changed input (additional
//       working directories) moves the digest; restoring the input restores
//       the byte-identical render and the original digest (no latch, no
//       drift).
//    §3 PREFIX UNDER INPUT CHANGE — when an input changes, every byte
//       BEFORE the first differing segment is unchanged: the cacheable head
//       is a stable prefix, so a mid-prompt change can never invalidate the
//       prefix above it.
//    §4 THE PER-TURN CONTEXT TAIL — the turn machine appends exactly one
//       system-context element after composition; the composed render must
//       be a strict prefix of the tail-carrying render on every family
//       renderer, and the tail never joins the digest (receipts pin the
//       contract, not the turn's weather).
//
//  Run:  ~/.bun/bin/bun run scripts/prompt/prove-cache-prefix.ts
// ============================================================================
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// BEFORE imports (module-load env reads).
const home = mkdtempSync(join(tmpdir(), 'cache-prefix-home-'))
const cwd = mkdtempSync(join(tmpdir(), 'cache-prefix-cwd-'))
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

const prompts = await import('../../src/constants/prompts.ts')
const bc = await import('../../src/prompt/behaviourContract.ts')
const sections = await import('../../src/constants/systemPromptSections.ts')

const toolNames = ['Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'Agent', 'Skill', 'TaskCreate', 'AskUserQuestion']
const tools = toolNames.map(name => ({ name })) as never

/** One model per render family — the family renderer is the seam under
 *  proof; the model selects the composition inputs the way the runtime does. */
const FAMILY_MODELS: ReadonlyArray<[bc.ContractRenderFamily, string]> = [
  ['anthropic', 'claude-fable-5'],
  ['openai', 'gpt-5.6-codex'],
  ['generic', 'glm-4.7'],
]

const renderFor = (family: bc.ContractRenderFamily, segments: string[]): string =>
  bc.renderContractSections(bc.resolveBehaviourContract(segments), family).join('\n\n')

for (const [family, model] of FAMILY_MODELS) {
  section(`§1 turn stability — ${family} (${model})`)
  const turn1 = await prompts.getSystemPrompt(tools, model, undefined, [])
  const turn2 = await prompts.getSystemPrompt(tools, model, undefined, [])
  const r1 = renderFor(family, turn1)
  const r2 = renderFor(family, turn2)
  check('consecutive builds render byte-identical', r1 === r2,
    `len ${r1.length} vs ${r2.length}`)
  const d1 = bc.resolveBehaviourContract(turn1).digest
  const d2 = bc.resolveBehaviourContract(turn2).digest
  check('consecutive builds carry the same contract digest', d1 === d2, `${d1} vs ${d2}`)
  check('resolved from the registry (typed sections, not raw decode)',
    bc.resolveBehaviourContract(turn1).sections.every(s => s.group !== 'segment'))

  section(`§2 signature moves only with inputs — ${family}`)
  // Within a conversation the sections are FROZEN (the section cache): a
  // changed input never rewrites the prefix mid-conversation. The lawful
  // boundary (a compaction or /clear) re-evaluates — there the input moves
  // the digest.
  const frozen = await prompts.getSystemPrompt(tools, model, [join(cwd, 'extra-dir')], [])
  check('within the conversation a changed input is frozen out (byte-identical render, same digest)', renderFor(family, frozen) === r1 && bc.resolveBehaviourContract(frozen).digest === d1)
  sections.clearSystemPromptSections()
  const changed = await prompts.getSystemPrompt(tools, model, [join(cwd, 'extra-dir')], [])
  const dChanged = bc.resolveBehaviourContract(changed).digest
  check('across the lawful boundary a changed input moves the digest', dChanged !== d1)
  sections.clearSystemPromptSections()
  const restored = await prompts.getSystemPrompt(tools, model, undefined, [])
  check('restoring the input restores the byte-identical render',
    renderFor(family, restored) === r1)
  check('…and the original digest', bc.resolveBehaviourContract(restored).digest === d1)

  section(`§3 prefix stability under the input change — ${family}`)
  const base = renderFor(family, turn1)
  const moved = renderFor(family, changed)
  let firstDiff = 0
  const max = Math.min(base.length, moved.length)
  while (firstDiff < max && base[firstDiff] === moved[firstDiff]) firstDiff++
  check('the renders differ across the boundary (the input is render-visible)', base !== moved)
  check('a non-empty shared prefix precedes the first difference', firstDiff > 0,
    `firstDiff=${firstDiff}`)
  // The differing section is the env block, which sits in the dynamic group —
  // the static head (every byte before the boundary) must be inside the
  // shared prefix.
  const boundaryIdx = base.indexOf(prompts.SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
  if (boundaryIdx !== -1) {
    check('the static head (through the cache boundary) is inside the shared prefix',
      firstDiff > boundaryIdx, `boundary@${boundaryIdx} firstDiff@${firstDiff}`)
  } else {
    // No global-cache-scope marker in this configuration: pin the weaker but
    // still real law — the shared prefix covers the whole static intro.
    check('the shared prefix covers the intro section', firstDiff > 200,
      `firstDiff=${firstDiff}`)
  }

  section(`§4 the per-turn context tail — ${family}`)
  const tailed = [...turn1, 'gitStatus: clean (turn weather)']
  const rTailed = renderFor(family, tailed)
  check('composed render is a strict prefix of the tail-carrying render',
    rTailed.startsWith(r1) && rTailed.length > r1.length)
  check('the tail never joins the digest',
    bc.resolveBehaviourContract(tailed).digest === d1)
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ CACHE-PREFIX LAWS PASS')
else console.log(`❌ ${failures} CACHE-PREFIX CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
