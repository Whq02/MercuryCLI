#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const J = (...parts: string[]): string => parts.join('')

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'floor-delivery-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const SRC = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' constitution delivery — every conversational seat, mechanism-pinned')
console.log('============================================================')

const contract = await import('../../src/prompt/mercuryContract.ts')
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
    digest === 'f80d7ee7262d810d0709829bda4327f31e9c492f5935f6f8cf35e61ba1a54f40',
    digest,
  )
  check('provider-neutral (no engine family named)', !/\b(Claude|Anthropic|GPT|OpenAI|Gemini|Llama|DeepSeek|Kimi)\b/i.test(TEXT))
  check('the smallest-question rule is the LAST statement (no trailer: a run\'s blocked outcome is the runner\'s to decide)', TEXT.trimEnd().endsWith('Keep paused work paused until they authorise resumption.'))
  check('exactly ONE identity statement, stated positively and nowhere negated', (TEXT.match(/^You are /gm) ?? []).length === 1 && !/claim to be human|misrepresent what you are|not a person/i.test(TEXT))
}

section('§1b the coordinator seat — the same constitution, its seat fact behind it, one identity per seat')
{
  const SEAT = contract.MERCURY_COORDINATOR_SEAT
  check(
    'the seat fact is the owner’s text, byte-exact',
    SEAT === `This seat is the Mercury coordinator — Mercury's own coordinating seat in this session; "coordinator" is your role, never a second name.`,
  )
  check('the seat fact states no second identity', !/^You are /m.test(SEAT))
  check('the coordinator composition opens on the constitution with the seat fact directly behind it', SRC('src/services/concourse/coordinatorCall.ts').includes('MERCURY_CONSTITUTION,\n          MERCURY_COORDINATOR_SEAT,'))
  const seatDigest = createHash('sha256').update(SEAT, 'utf8').digest('hex')
  check('byte anchor (sha256 of the seat fact)', seatDigest === createHash('sha256').update(`This seat is the Mercury coordinator — Mercury's own coordinating seat in this session; "coordinator" is your role, never a second name.`, 'utf8').digest('hex'), seatDigest)
}

section('§2 buildEffectiveSystemPrompt — the constitution FIRST on every replacing path')
{
  const { buildEffectiveSystemPrompt } = await import('../../src/utils/systemPrompt.ts')
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

  const callers = ['src/rows/turn.ts', 'src/cli/run.ts', 'src/commands/compact/compact.ts', 'src/utils/analyzeContext.ts', 'src/tools/AgentTool/AgentTool.tsx']
  check(
    'no production caller supplies overrideSystemPrompt today',
    callers.every(f => !SRC(f).includes('overrideSystemPrompt')),
  )
}

section('§3 contract sections — no identity or doctrine section; the constitution is static, ungated')
{
  const sections = contract.getMercuryContractSections()
  check('the contract sections carry no identity text and no doctrine', sections.every(s => !s.text.includes('You are') && s.name !== J('identity', '-floor') && s.name !== J('mercury', '-doctrine')))
  check('no gate flag names the constitution', !SRC('src/prompt/mercuryContract.ts').includes(J('MERCURY_WRAPPER', '_APPEND')) && !SRC('src/substrate/flagRegistry.ts').includes(J('MERCURY_WRAPPER', '_APPEND')))
}

section('§4 composer + renderers — position law, both wires')
{
  const { composeSystemPrompt } = await import('../../src/prompt/composer.ts')
  const {
    buildBehaviourContract,
    renderAnthropicSections,
    renderOpenaiInstructions,
    resolveBehaviourContract,
    __resetBehaviourContractRegistryForTest,
  } = await import('../../src/prompt/behaviourContract.ts')

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
  check('owner is the contract module', constitutionSection?.owner === 'src/prompt/mercuryContract.ts')
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
  const { buildSubagentMercurySections } = await import('../../src/constants/subagentDoctrine.ts')
  const { MERCURY_SCOUT_AGENT } = await import('../../src/tools/AgentTool/built-in/mercuryScoutAgent.ts')

  const normal = buildSubagentMercurySections({ agentDefinition: { agentType: 'mercury-crew' } })
  check('normal agent: the constitution is element 0', normal[0] === TEXT)
  check('normal agent: the operating register follows', typeof normal[1] === 'string' && normal[1]!.includes('<subagent-doctrine>'))

  const fixed = buildSubagentMercurySections({ agentDefinition: MERCURY_SCOUT_AGENT })
  check('fixed-output agent (the scout): the constitution is STILL element 0', fixed[0] === TEXT)
}

section('§6 source pins — the bun-unloadable seats, one line each')
{
  const pins: Array<[string, string, string]> = [
    ['every session turn — interactive (the concourse runner) and headless alike (custom prompt)', 'src/rows/turn.ts', '? [MERCURY_CONSTITUTION, config.customSystemPrompt]'],
    ['bare MERCURY_BARE prompt', 'src/constants/prompts.ts', 'return [`${head}\\n\\n${law}`]'],
    ['the shipped prompt: the head then the constitution as the static group', 'src/constants/prompts.ts', 'const staticSections: Array<string | null> = [frozenHead ?? head, law]'],
    ['the constitution is the law under stock', 'src/constants/prompts.ts', "const law = layers === 'replace' ? promptReplacementText() : stockLaw"],
    ['the stock law is the constitution, its headless form only for a run no host attends', 'src/constants/prompts.ts', "systemPromptSection('constitution', () => isUnattendedRun() ? MERCURY_HEADLESS_CONSTITUTION : MERCURY_CONSTITUTION)"],
    ['the stock law falls back to the constitution itself', 'src/constants/prompts.ts', 'const stockLaw = constitution ?? MERCURY_CONSTITUTION'],
    ['switchboard coordinator seat (the constitution, its seat fact, then its engine line, then its contract, then the persona)', 'src/services/concourse/coordinatorCall.ts', 'asSystemPrompt([\n          MERCURY_CONSTITUTION,\n          MERCURY_COORDINATOR_SEAT,\n          engineLine,\n          MERCURY_COORDINATOR_CONTRACT,\n          input.contract,'],
    ['the coordinator seat states its engine from ONE owner', 'src/services/concourse/coordinatorCall.ts', 'const engineLine = mercuryEngineIdentityLine(modelId)'],
    ['agent-prompt replacement seat', 'src/utils/systemPrompt.ts', 'parts.push(MERCURY_CONSTITUTION, agentPrompt)'],
    ['custom-prompt replacement seat', 'src/utils/systemPrompt.ts', 'parts.push(MERCURY_CONSTITUTION, customSystemPrompt)'],
    ['AgentTool default spawn (doctrine leads)', 'src/tools/AgentTool/AgentTool.tsx', '[...doctrine, ownPrompt]'],
    ['runAgent fallback build (doctrine leads)', 'src/tools/AgentTool/runAgent.ts', '[...doctrine, ownPrompt]'],
    ['runAgent honors override only when supplied', 'src/tools/AgentTool/runAgent.ts', 'override?.systemPrompt ??'],
  ]
  for (const [label, file, needle] of pins) {
    check(`${label} — ${file}`, SRC(file).includes(needle))
  }
  check('the session env blocks state no engine (the seat reads mercury://seat) — src/constants/prompts.ts', !SRC('src/constants/prompts.ts').includes('mercuryEngineIdentityLine'))

  check(
    'buildSubagentMercurySections is called at both chokepoints',
    SRC('src/tools/AgentTool/AgentTool.tsx').includes('buildSubagentMercurySections({') &&
      SRC('src/tools/AgentTool/runAgent.ts').includes('buildSubagentMercurySections({'),
  )
  check('no road splices an identity sentence of its own (the Anthropic wire, the side query)', !/You are/.test(SRC('src/constants/system.ts')) && !/You are/.test(SRC('src/utils/sideQuery.ts')) && SRC('src/services/providers/anthropic/cacheAndUsage.ts').includes('return asSystemPrompt([attribution, ...systemPrompt].filter(Boolean))'))
}

console.log(failures ? '\n❌ FLOOR-DELIVERY RED' : '\n✅ FLOOR-DELIVERY GREEN')
process.exit(failures ? 1 : 0)
