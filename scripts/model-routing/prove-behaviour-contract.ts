#!/usr/bin/env bun
// ============================================================================
//  scripts/model-routing/prove-behaviour-contract.ts
//  PROOF:
//  the typed behaviour-contract pipeline over the composer output.
//
//    1. PARITY: composeSystemPrompt() (which renders through the contract) is
//       BYTE-IDENTICAL to the frozen pre-A3 compose expression (the pinned
//       legacy oracle below) across representative part shapes — nulls,
//       boundary, wrapper, mode packs, anti-syc arm, reconcile tail — for
//       contracts carrying NO openai-only sections.
//    2. RENDERERS (the one-content law): the family-scope sets are EMPTY —
//       every renderer emits the SAME sections in the same order; the
//       renderers differ only in join shape (segments vs one string).
//    3. DIGEST: stable across rebuilds of identical parts · changes when any
//       section's text changes · the per-turn context tail NEVER joins it.
//    4. REGISTRY: a composed contract resolves back from its rendered
//       ANTHROPIC content (typed names/owners/digest for the non-Anthropic
//       joins), with the ONE appended system-context element carried as a
//       rendered-but-undigested 'context' section; unknown content decodes
//       raw (total fallback) and still renders identically.
//    5. UNSIGNED-THINKING STRIP (the Sol→Opus live-400 law): unsigned
//       thinking blocks drop before an Anthropic request; signed Anthropic
//       thinking and every other block survive byte-identically.
//    6. section metadata: semantic names only; owner + cacheClass carried
//       on every section.
//
//  Run:  ~/.bun/bin/bun run scripts/model-routing/prove-behaviour-contract.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' A3 — behaviour-contract pipeline proof')
console.log('============================================================')

const { composeSystemPrompt } = await import('../../src/prompt/composer.js')
const {
  buildBehaviourContract,
  renderAnthropicSections,
  renderOpenaiInstructions,
  renderGenericInstructions,
  registerComposedContract,
  resolveBehaviourContract,
  contractFromSegments,
  __resetBehaviourContractRegistryForTest,
} = await import('../../src/prompt/behaviourContract.js')
const { stripUnsignedThinkingBlocks } = await import('../../src/utils/messages/pairing.js')
import type { PromptParts } from '../../src/prompt/composer.js'

// The FROZEN pre-A3 compose law (verbatim from the pre-change composer) —
// the parity oracle for contracts with NO openai-only sections. Never
// "simplify" this to call the new path. (wrapper/mode parts carry
// semantic names now; the oracle maps their text — same order, same filter.)
function legacyCompose(parts: PromptParts): string[] {
  return [
    ...parts.staticSections,
    ...parts.dynamicBoundary,
    ...parts.dynamicResolved,
    ...parts.wrapperSections.map(s => s.text),
    ...parts.modeSections.map(s => s.text),
    ...parts.antiSycSections,
    ...parts.reconcileTailSections,
  ].filter((s): s is string => s !== null)
}

function parts(overrides: Partial<PromptParts> = {}): PromptParts {
  return {
    staticSections: ['intro text', 'system text', null, 'actions', 'tools', 'tone', 'efficiency'],
    dynamicBoundary: [],
    dynamicSpecs: [
      { name: 'session_guidance', cacheBreak: false },
      { name: 'ant_model_override', cacheBreak: false },
      { name: 'env_info_simple', cacheBreak: false },
    ],
    dynamicResolved: ['guidance body', null, 'env body'],
    wrapperSections: [
      { name: 'identity-floor', text: 'the identity floor' },
      { name: 'mercury-doctrine', text: 'the mercury doctrine' },
    ],
    modeSections: [],
    antiSycSections: [],
    reconcileTailSections: [],
    ...overrides,
  }
}

//
section('1 · parity — composeSystemPrompt ≡ the frozen legacy expression')
//
{
  const shapes: Array<[string, PromptParts]> = [
    ['baseline (nulls filtered)', parts()],
    ['boundary marker present', parts({ dynamicBoundary: ['=== boundary ==='] })],
    [
      'mode packs + anti-syc + reconcile tail',
      parts({
        modeSections: [
          { name: 'mode-implementer', text: 'implementer pack' },
          { name: 'mode-scribe', text: 'scribe pack' },
        ],
        antiSycSections: ['anti-syc arm'],
        reconcileTailSections: ['reconcile tail'],
      }),
    ],
    ['empty-string section survives (only null filters)', parts({ staticSections: ['', 'x'] })],
    [
      'identity floor only (doctrine off)',
      parts({ wrapperSections: [{ name: 'identity-floor', text: 'identity floor' }] }),
    ],
  ]
  for (const [label, p] of shapes) {
    const composed = composeSystemPrompt(p)
    const legacy = legacyCompose(p)
    check(`parity: ${label}`, JSON.stringify(composed) === JSON.stringify(legacy))
  }
}

//
section('2 · renderers — one content on every wire (empty scope sets)')
//
{
  const p = parts({
    dynamicSpecs: [
      { name: 'session_guidance', cacheBreak: false },
      { name: 'model_currency', cacheBreak: false },
      { name: 'env_info_simple', cacheBreak: false },
    ],
    dynamicResolved: ['guidance body', 'NEUTRAL CURRENCY RULE', 'env body'],
    wrapperSections: [
      { name: 'identity-floor', text: 'the identity floor' },
      { name: 'mercury-doctrine', text: 'the mercury doctrine' },
    ],
  })
  const contract = buildBehaviourContract(p)
  check('NO section is family-scoped (the one-content law)', contract.sections.every(s => s.scope === 'all'))
  const anthropic = renderAnthropicSections(contract)
  check('anthropic renderer carries every section', anthropic.length === contract.sections.length)
  check('model_currency (the neutral rule) rides the anthropic render', anthropic.includes('NEUTRAL CURRENCY RULE'))
  const openai = renderOpenaiInstructions(contract)
  check('openai render == the same sections joined (content identical)', openai === anthropic.join('\n\n'))
  check(
    'openai renderer keeps canonical order',
    openai.startsWith('intro text') && openai.includes('guidance body\n\nNEUTRAL CURRENCY RULE\n\nenv body'),
  )
  const generic = renderGenericInstructions(contract)
  check('generic render == openai render (chat lanes: same content)', generic === openai)
}

//
section('3 · digest — stable · content-sensitive · context-excluded')
//
{
  const a = buildBehaviourContract(parts())
  const b = buildBehaviourContract(parts())
  check('identical parts → identical digest', a.digest === b.digest && a.digest.startsWith('bc1-'))
  const c = buildBehaviourContract(
    parts({ wrapperSections: [{ name: 'identity-floor', text: 'the identity floor v2' }] }),
  )
  check('changed section text → changed digest', c.digest !== a.digest)
  __resetBehaviourContractRegistryForTest()
  registerComposedContract(a)
  const withContext = resolveBehaviourContract([...renderAnthropicSections(a), 'gitStatus: clean'])
  check('context tail resolves to the SAME digest (never digested)', withContext.digest === a.digest)
  check(
    "context tail rides as a rendered 'context' section",
    withContext.sections.at(-1)?.group === 'context' && renderOpenaiInstructions(withContext).endsWith('gitStatus: clean'),
  )
}

//
section('4 · registry — anthropic-content hit · tail probe · typed recovery · raw fallback')
//
{
  __resetBehaviourContractRegistryForTest()
  const typed = buildBehaviourContract(
    parts({
      wrapperSections: [
        { name: 'identity-floor', text: 'the identity floor' },
        { name: 'mercury-doctrine', text: 'the mercury doctrine' },
      ],
    }),
  )
  registerComposedContract(typed)
  const anthropicRender = renderAnthropicSections(typed)
  const resolved = resolveBehaviourContract(anthropicRender)
  check('registry resolves the TYPED contract from the anthropic render', resolved.digest === typed.digest)
  check('…with semantic names intact (not a raw decode)', resolved.sections.some(s => s.name === 'mercury-doctrine'))
  check('…and the OpenAI join renders the same content', renderOpenaiInstructions(resolved) === anthropicRender.join('\n\n'))
  const unknown = resolveBehaviourContract(['alien prompt', 'segments'])
  check('unknown content decodes raw (total fallback)', unknown.sections.every(s => s.group === 'segment'))
  check('raw fallback renders identically to its input', renderOpenaiInstructions(unknown) === 'alien prompt\n\nsegments')
  const rawAgain = contractFromSegments(['alien prompt', 'segments'])
  check('raw decode digest is stable for identical bytes', rawAgain.digest === unknown.digest)
}

//
section('5 · unsigned-thinking strip (the Sol→Opus live-400 law)')
//
{
  const mk = (content: unknown[]): never =>
    ({ type: 'assistant', message: { role: 'assistant', content }, uuid: 'u', timestamp: 't' }) as never
  const gptTurn = mk([
    { type: 'thinking', thinking: 'gpt reasoning summary', signature: '' },
    { type: 'text', text: 'answer' },
  ])
  const anthropicTurn = mk([
    { type: 'thinking', thinking: 'real claude thinking', signature: 'sig-abc123' },
    { type: 'text', text: 'claude answer' },
  ])
  const out = stripUnsignedThinkingBlocks([gptTurn, anthropicTurn] as never)
  const first = (out[0] as { message: { content: Array<{ type: string }> } }).message.content
  const second = (out[1] as { message: { content: Array<{ type: string }> } }).message.content
  check('unsigned (foreign) thinking dropped', first.length === 1 && first[0]!.type === 'text')
  check('signed Anthropic thinking survives byte-identically', second.length === 2 && second[0]!.type === 'thinking')
  const onlyThinking = mk([{ type: 'thinking', thinking: 'only', signature: '' }])
  const kept = stripUnsignedThinkingBlocks([onlyThinking] as never)
  const keptContent = (kept[0] as { message: { content: Array<{ type: string }> } }).message.content
  check('a turn left empty gains the placeholder (row stays valid)', keptContent.length === 1 && keptContent[0]!.type === 'text')
  const untouched = [anthropicTurn]
  check('no unsigned thinking ⇒ the SAME array reference (zero-copy)', stripUnsignedThinkingBlocks(untouched as never) === (untouched as never))
}

//
section('6 · section metadata — semantic names, owner, cacheClass')
//
{
  const contract = buildBehaviourContract(
    parts({
      modeSections: [{ name: 'mode-scribe', text: 'scribe pack' }],
      antiSycSections: ['arm'],
      reconcileTailSections: ['tail'],
      dynamicBoundary: ['boundary'],
    }),
  )
  check('no positional wrapper-N/mode-N names', contract.sections.every(s => !/^wrapper-\d+$|^mode-\d+$/.test(s.name)))
  check('every section carries an owner', contract.sections.every(s => typeof s.owner === 'string' && s.owner.length > 0))
  check('every section carries a cacheClass', contract.sections.every(s => ['stable', 'session', 'turn'].includes(s.cacheClass)))
  const scribe = contract.sections.find(s => s.name === 'mode-scribe')
  check('mode-scribe owner is the scribe pack', scribe?.owner === 'src/utils/scribe/scribePack.ts')
  const staticIntro = contract.sections.find(s => s.name === 'intro')
  check('static sections are cache-stable', staticIntro?.cacheClass === 'stable')
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL BEHAVIOUR-CONTRACT PROOFS PASS')
else console.log(`${failures} BEHAVIOUR-CONTRACT PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
