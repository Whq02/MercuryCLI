#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const J = (...parts: string[]): string => parts.join('')

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'floor-delivery-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }


let failures = 0
const sectionHints: Record<string, string> = {
  '§1': 'restore the owner text of MERCURY_CONSTITUTION in src/engine/system-prompt/mercuryContract.ts (the digest anchors that text)',
  '§2': 'change buildEffectiveSystemPrompt in src/engine/system-prompt/systemPrompt.ts',
  '§3': 'change getMercuryContractSections in src/engine/system-prompt/mercuryContract.ts',
  '§4': 'change composeSystemPrompt in src/engine/system-prompt/composer.ts or buildBehaviourContract and the renderers in src/engine/system-prompt/behaviourContract.ts',
  '§5': 'change buildSubagentMercurySections in src/tools/crewmate/crewmateDoctrine.ts',
}
let currentSectionHint = ''
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond && currentSectionHint ? ` — ${currentSectionHint}` : ''}`)
}
function section(t: string): void {
  currentSectionHint = sectionHints[t.slice(0, 2)] ?? ''
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' constitution delivery — every conversational seat, mechanism-pinned')
console.log('============================================================')

const contract = await import('../../src/engine/system-prompt/mercuryContract.ts')
const TEXT = contract.MERCURY_CONSTITUTION

section('§1 the constant — the owner’s text, byte-anchored')
{
  const anchors: Array<[string, RegExp]> = [
    ['identity (You are Mercury, the coding agent working in the operator\'s terminal)', /^You are Mercury, the coding agent working in the operator's terminal\./],
    ['the engine line', /The model running you is your engine and can be swapped;/],
    ['the attribution', /Mercury is the harness and was not built by the model's maker\./],
    ['the peer line', /Work as a capable colleague: use judgement, speak plainly, and be honest about what you know and what you have done\./],
    ['operator control', /Follow the operator's stated preferences on scope, approach, delegation and communication ahead of your defaults\./],
    ['the question rule', /^Respond to the meaning of the request\. Questions asking you to read, check, compare, research or diagnose authorise the investigation needed to answer\./m],
    ['the finishing clause', /Before ending, finish any useful work that remains both requested and authorised\./],
    ['the stop sentence', /Outstanding work and verification never override that instruction\./],
    ['the evidence rule', /Use evidence appropriate to the claim\. Ground statements about the project's current state in inspected files and observed behaviour, and statements about actions taken in their actual results\./],
    ['the smallest-question rule', /ask the smallest direct question and briefly explain what depends on the answer\. Keep paused work paused until they authorise resumption\.$/],
  ]
  for (const [name, re] of anchors) check(`statement present: ${name}`, re.test(TEXT))

  const digest = createHash('sha256').update(TEXT, 'utf8').digest('hex')
  check(
    'byte anchor (sha256 of the owner’s text)',
    digest === 'ad2ecbcc8613a11510bd6879fde192fb7a59cea98096c14be079120c49c063f7',
    digest,
  )
  check('provider-neutral (no engine family named)', !/\b(Claude|Anthropic|GPT|OpenAI|Gemini|Llama|DeepSeek|Kimi)\b/i.test(TEXT))
  check('the smallest-question rule is the LAST statement (no trailer: a run\'s blocked outcome is the runner\'s to decide)', TEXT.trimEnd().endsWith('Keep paused work paused until they authorise resumption.'))
  check('exactly ONE identity statement, stated positively and nowhere negated', (TEXT.match(/^You are /gm) ?? []).length === 1 && !/claim to be human|misrepresent what you are|not a person/i.test(TEXT))
}

section('§2 buildEffectiveSystemPrompt — the constitution FIRST on every replacing path')
{
  const { buildEffectiveSystemPrompt } = await import('../../src/engine/system-prompt/systemPrompt.ts')
  const ctx = { options: {} } as never
  const DEFAULT = ['default-head', 'default-tail']

  const custom = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: undefined,
    toolUseContext: ctx,
    customSystemPrompt: 'CUSTOM',
    defaultSystemPrompt: DEFAULT,
    appendSystemPrompt: undefined,
  })
  check('custom prompt: the constitution is element 0', custom[0] === TEXT)
  check('custom prompt: the custom text follows as its own element', custom[1] === 'CUSTOM' && custom.length === 2)

  const agentDef = {
    agentType: 'x-proof',
    source: 'projectSettings',
    getSystemPrompt: () => 'AGENT-PROMPT',
  } as never
  const agent = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: agentDef,
    toolUseContext: ctx,
    customSystemPrompt: 'CUSTOM',
    defaultSystemPrompt: DEFAULT,
    appendSystemPrompt: 'APPEND',
  })
  check('agent prompt beats custom and the constitution still leads', agent[0] === TEXT && agent[1] === 'AGENT-PROMPT')
  check('append rides LAST behind the constitution+agent pair', agent[agent.length - 1] === 'APPEND' && agent.length === 3)

  const dflt = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: undefined,
    toolUseContext: ctx,
    customSystemPrompt: undefined,
    defaultSystemPrompt: DEFAULT,
    appendSystemPrompt: 'APPEND',
  })
  check('default path passes the default through untouched (the constitution lives inside it)', dflt[0] === 'default-head' && dflt[1] === 'default-tail')
  check('default path: append rides last', dflt[2] === 'APPEND' && dflt.length === 3)

  const override = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: agentDef,
    toolUseContext: ctx,
    customSystemPrompt: 'CUSTOM',
    defaultSystemPrompt: DEFAULT,
    appendSystemPrompt: 'APPEND',
    overrideSystemPrompt: 'OVERRIDE',
  })
  check(
    'overrideSystemPrompt is the ONE exemption: exact replacement, nothing added',
    override.length === 1 && override[0] === 'OVERRIDE',
  )
  const emptyOverride = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: undefined,
    toolUseContext: ctx,
    customSystemPrompt: 'CUSTOM',
    defaultSystemPrompt: DEFAULT,
    appendSystemPrompt: undefined,
    overrideSystemPrompt: '',
  })
  check('an EMPTY override falls through to the custom path, the constitution first', emptyOverride[0] === TEXT && emptyOverride[1] === 'CUSTOM')

}

section('§3 contract sections — no identity or doctrine section; the constitution is static, ungated')
{
  const sections = contract.getMercuryContractSections()
  check('the contract sections carry no identity text and no doctrine', sections.every(s => !s.text.includes('You are') && s.name !== J('identity', '-floor') && s.name !== J('mercury', '-doctrine')))
}

section('§4 composer + renderers — position law, both wires')
{
  const { composeSystemPrompt } = await import('../../src/engine/system-prompt/composer.ts')
  const {
    buildBehaviourContract,
    renderAnthropicSections,
    renderOpenaiInstructions,
    resolveBehaviourContract,
    __resetBehaviourContractRegistryForTest,
  } = await import('../../src/engine/system-prompt/behaviourContract.ts')

  const parts = {
    staticSections: ['STATIC-HEAD', TEXT],
    dynamicBoundary: [],
    dynamicSpecs: [
      { name: 'env_info_simple', cacheBreak: false },
      { name: 'model_currency', cacheBreak: false },
    ],
    dynamicResolved: ['DYNAMIC-ENV', 'NEUTRAL-CURRENCY-RULE'],
    wrapperSections: contract.getMercuryContractSections(),
    modeSections: [{ name: 'mode-proof', text: 'MODE-PACK' }],
    antiSycSections: [],
  }

  const composed = composeSystemPrompt(parts as never)
  const at = composed.indexOf(TEXT)
  check('composed default prompt carries the constitution as its OWN segment', at !== -1)
  check('exactly once (never duplicated)', composed.filter(s => s === TEXT).length === 1)
  check('right after the head, before every fact', at === 1 && at < composed.indexOf('DYNAMIC-ENV'))
  check('before the mode packs', at < composed.indexOf('MODE-PACK'))
  check('the mode pack is the LAST segment: no identity tail follows it', composed[composed.length - 1] === 'MODE-PACK')

  const behaviour = buildBehaviourContract(parts as never)
  const constitutionSection = behaviour.sections.find(s => s.name === 'constitution')
  check('behaviour contract: the constitution section exists in the static group', constitutionSection?.group === 'static' && constitutionSection.text === TEXT)
  check('scope is ALL — no provider may drop it', constitutionSection?.scope === 'all')
  check('owner is the contract module', constitutionSection?.owner === 'src/engine/system-prompt/mercuryContract.ts')
  check('cache class is stable (paid once per session)', constitutionSection?.cacheClass === 'stable')

  const anthropic = renderAnthropicSections(behaviour)
  check('Anthropic wire carries the constitution', anthropic.includes(TEXT))

  const openai = renderOpenaiInstructions(behaviour)
  check('OpenAI instructions carry the constitution', openai.includes(TEXT))
  check('one content: OpenAI instructions == the Anthropic segments joined', openai === anthropic.join('\n\n'))
  check('the currency rule reaches EVERY wire (no anthropic-only scope)', openai.includes('NEUTRAL-CURRENCY-RULE') && anthropic.includes('NEUTRAL-CURRENCY-RULE'))

  __resetBehaviourContractRegistryForTest()
  const rawResolved = resolveBehaviourContract([TEXT, 'A CUSTOM REPLACEMENT PROMPT'])
  check('raw decode (custom path, registry miss) keeps the constitution', rawResolved.sections.some(s => s.text === TEXT))
  check('raw decode renders the constitution into OpenAI instructions', renderOpenaiInstructions(rawResolved).includes(TEXT))
}

section('§5 subagent doctrine — the constitution LEADS every spawned child')
{
  const { buildCrewmateMercurySections } = await import('../../src/tools/crewmate/crewmateDoctrine.ts')
  const { MERCURY_SCOUT_AGENT } = await import('../../src/tools/crewmate/built-in/mercuryScoutAgent.ts')

  const normal = buildCrewmateMercurySections({ agentDefinition: { agentType: 'mercury-crew' } })
  check('normal agent: the constitution is element 0', normal[0] === TEXT)
  check('normal agent: the operating register follows', typeof normal[1] === 'string' && normal[1]!.includes('<subagent-doctrine>'))

  const fixed = buildCrewmateMercurySections({ agentDefinition: MERCURY_SCOUT_AGENT })
  check('fixed-output agent (the scout): the constitution is STILL element 0', fixed[0] === TEXT)
}


console.log(failures ? '\n❌ FLOOR-DELIVERY RED' : '\n✅ FLOOR-DELIVERY GREEN')
process.exit(failures ? 1 : 0)
