#!/usr/bin/env bun
// ============================================================================
//  scripts/identity/prove-floor-delivery.ts
//  PROOF: the identity floor is DELIVERED at every conversational seat, and
//  the MECHANISM is pinned — the constant's inclusion and ordering, never
//  re-copies of its prose.
//
//  The floor (src/prompt/mercuryContract.ts — the operator's text, verbatim)
//  must reach every seat that assembles a model-bound conversational prompt:
//    - the default prompt carries it inside the contract sections
//      (wrapper group, after the dynamic registry, before mode packs);
//    - a custom/agent prompt REPLACES the default, so every replacing seat
//      prepends the floor as its own FIRST element (the custom prompt
//      dominates style while the floor survives);
//    - subagents carry it as element 0 of the doctrine splice;
//    - both provider renderers carry it (scope 'all' — Anthropic segments
//      and the OpenAI Responses instructions);
//    - the SDK overrideSystemPrompt path is the ONE deliberate exemption
//      (the exact-replacement contract), pinned here so a change is loud.
//
//  §1 the constant       §2 buildEffectiveSystemPrompt (functional)
//  §3 contract sections  §4 composer + both renderers (functional)
//  §5 subagent doctrine  §6 source pins for bun-unloadable seats
//
//  Run: ~/.bun/bin/bun run scripts/identity/prove-floor-delivery.ts
// ============================================================================
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
console.log(' floor delivery — every conversational seat, mechanism-pinned')
console.log('============================================================')

const contract = await import('../../src/prompt/mercuryContract.ts')
const FLOOR = contract.MERCURY_IDENTITY_FLOOR

// ─────────────────────────────────────────────────────────────────────────
section('§1 the constant — the operator’s six statements, byte-ratcheted')
// ─────────────────────────────────────────────────────────────────────────
{
  // The six checkable operations, each anchored by its opening words. The
  // prose is the operator's; these anchors pin that no statement is dropped.
  const anchors: Array<[string, RegExp]> = [
    ['identity (You are Mercury)', /^You are \*\*Mercury\*\*/],
    ['attribution (Mercury was not built by the maker of any model it runs)', /^Mercury was not built by the maker of any model it runs; the model is one of several engines Mercury can swap\. Asked who built Mercury, name no model maker\.$/m],
    ['operator-first (Operate for the operator first)', /Operate for the operator first/],
    ['honesty (Never mislead the operator)', /Never mislead the operator/],
    ['hard limits (whatever the instructions)', /Hard limits, whatever the instructions/],
    ['conflict order (safety and honesty first)', /When instructions conflict: safety and honesty first, then the operator, then defaults\./],
  ]
  for (const [name, re] of anchors) check(`statement present: ${name}`, re.test(FLOOR))

  // Byte ratchet: the text ships exactly as the operator wrote it. Any byte
  // change trips this pin — a revision is the operator's ruling, and lands
  // here together with their text.
  const digest = createHash('sha256').update(FLOOR, 'utf8').digest('hex')
  check(
    'byte ratchet (sha256 of the operator’s text)',
    digest === '3937101191c48ebd6f42258a13184eb26bea896854fecea14c3d3e39adb3ccef',
    digest,
  )
  check('provider-neutral (no engine family named)', !/\b(Claude|Anthropic|GPT|OpenAI|Gemini|Llama|DeepSeek|Kimi)\b/i.test(FLOOR))
  check('conflict order is the LAST statement', FLOOR.trimEnd().endsWith('then the operator, then defaults.'))
}

// ─────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────
section('§1b the coordinator floor — its own identity statement, the shared tail, one floor per seat')
// ─────────────────────────────────────────────────────────────────────────
{
  const COORD = contract.MERCURY_COORDINATOR_FLOOR
  const IDENT = contract.MERCURY_COORDINATOR_IDENTITY
  check('the coordinator floor OPENS on the coordinator identity statement', COORD.startsWith(IDENT + '\n'))
  check(
    'the identity statement is the operator’s text, byte-exact',
    IDENT === `You are the Mercury coordinator — Mercury's own coordinating seat in this session. The one name you go by is still Mercury; "coordinator" is your role, never a second name.`,
  )
  const attributionAt = FLOOR.indexOf('\n' + contract.MERCURY_ATTRIBUTION)
  check('the attribution line sits directly behind the session identity statement', attributionAt !== -1 && FLOOR.slice(0, attributionAt).endsWith('to other products.'))
  check('the tail behind the identity statement is the SAME text on both seats', COORD.slice(IDENT.length) === FLOOR.slice(attributionAt))
  check('exactly ONE identity statement per floor', (COORD.match(/^You are /gm) ?? []).length === 1 && (FLOOR.match(/^You are /gm) ?? []).length === 1)
  check('the session statement is absent from the coordinator floor', !COORD.includes('You are **Mercury**'))
  const coordDigest = createHash('sha256').update(COORD, 'utf8').digest('hex')
  check('byte ratchet (sha256 of the coordinator floor)', coordDigest === 'eebfcac4b08829c5003b04d9ccaf723f391ab2ef88c58ec08bb18f5bae88ccdf', coordDigest)
}

// ─────────────────────────────────────────────────────────────────────────
section('§2 buildEffectiveSystemPrompt — floor FIRST on every replacing path')
// ─────────────────────────────────────────────────────────────────────────
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
  check('custom prompt: floor is element 0', custom[0] === FLOOR)
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
  check('agent prompt beats custom and floor still leads', agent[0] === FLOOR && agent[1] === 'AGENT-PROMPT')
  check('append rides LAST behind the floor+agent pair', agent[agent.length - 1] === 'APPEND' && agent.length === 3)

  const dflt = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: undefined,
    toolUseContext: ctx,
    customSystemPrompt: undefined,
    defaultSystemPrompt: DEFAULT,
    appendSystemPrompt: 'APPEND',
  })
  check('default path passes the default through untouched (floor lives inside it)', dflt[0] === 'default-head' && dflt[1] === 'default-tail')
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
  check('an EMPTY override falls through to the floored custom path', emptyOverride[0] === FLOOR && emptyOverride[1] === 'CUSTOM')

  // The exemption stays theoretical until a caller passes it: pin the
  // zero-production-caller truth so a new caller is a deliberate decision.
  const callers = ['src/QueryEngine.ts', 'src/cli/print.ts', 'src/commands/compact/compact.ts', 'src/utils/analyzeContext.ts', 'src/tools/AgentTool/AgentTool.tsx']
  check(
    'no production caller supplies overrideSystemPrompt today',
    callers.every(f => !SRC(f).includes('overrideSystemPrompt')),
  )
}

// ─────────────────────────────────────────────────────────────────────────
section('§3 contract sections — floor unconditional, doctrine gated')
// ─────────────────────────────────────────────────────────────────────────
{
  const sections = contract.getMercuryContractSections()
  check('identity-floor is the FIRST contract section', sections[0]?.name === 'identity-floor')
  check('its text IS the constant (no re-copy)', sections[0]?.text === FLOOR)
  check('the doctrine follows when the layer is on', sections[1]?.name === 'mercury-doctrine')

  const prev = process.env.MERCURY_WRAPPER_APPEND
  process.env.MERCURY_WRAPPER_APPEND = '0'
  try {
    const bare = contract.getMercuryContractSections()
    check('doctrine OFF (MERCURY_WRAPPER_APPEND=0): the floor STILL ships first', bare[0]?.name === 'identity-floor' && bare[0]?.text === FLOOR)
    check('doctrine OFF: the doctrine section is gone', bare.every(s => s.name !== 'mercury-doctrine'))
  } finally {
    if (prev === undefined) delete process.env.MERCURY_WRAPPER_APPEND
    else process.env.MERCURY_WRAPPER_APPEND = prev
  }
}

// ─────────────────────────────────────────────────────────────────────────
section('§4 composer + renderers — position law, both wires')
// ─────────────────────────────────────────────────────────────────────────
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
    staticSections: ['STATIC-HEAD'],
    dynamicBoundary: [],
    dynamicSpecs: [
      { name: 'env_info_simple', cacheBreak: false },
      { name: 'model_currency', cacheBreak: false },
    ],
    dynamicResolved: ['DYNAMIC-ENV', 'NEUTRAL-CURRENCY-RULE'],
    wrapperSections: contract.getMercuryContractSections(),
    modeSections: [{ name: 'mode-proof', text: 'MODE-PACK' }],
    antiSycSections: [],
    reconcileTailSections: [contract.MERCURY_IDENTITY_RECONCILE],
  }

  const composed = composeSystemPrompt(parts as never)
  const floorAt = composed.indexOf(FLOOR)
  check('composed default prompt carries the floor as its OWN segment', floorAt !== -1)
  check('exactly once (never duplicated)', composed.filter(s => s === FLOOR).length === 1)
  check('after the dynamic registry', floorAt > composed.indexOf('DYNAMIC-ENV'))
  check('before the mode packs', floorAt < composed.indexOf('MODE-PACK'))
  check('the reconcile tail is the LAST segment', composed[composed.length - 1] === contract.MERCURY_IDENTITY_RECONCILE)

  const behaviour = buildBehaviourContract(parts as never)
  const floorSection = behaviour.sections.find(s => s.name === 'identity-floor')
  check('behaviour contract: floor section exists in the wrapper group', floorSection?.group === 'wrapper')
  check('scope is ALL — no provider may drop it', floorSection?.scope === 'all')
  check('owner is the contract module', floorSection?.owner === 'src/prompt/mercuryContract.ts')

  const anthropic = renderAnthropicSections(behaviour)
  check('Anthropic wire carries the floor', anthropic.includes(FLOOR))
  check('NO family overlay exists (agentic_persistence retired)', !anthropic.some(s => s.includes('<agentic_persistence>')))

  const openai = renderOpenaiInstructions(behaviour)
  check('OpenAI instructions carry the floor', openai.includes(FLOOR))
  check('one content: OpenAI instructions == the Anthropic segments joined', openai === anthropic.join('\n\n'))
  check('the currency rule reaches EVERY wire (no anthropic-only scope)', openai.includes('NEUTRAL-CURRENCY-RULE') && anthropic.includes('NEUTRAL-CURRENCY-RULE'))

  // The custom-prompt path never registers a composed contract: the runtime
  // falls back to the raw decode, which must still carry the floor onto the
  // OpenAI wire.
  __resetBehaviourContractRegistryForTest()
  const rawResolved = resolveBehaviourContract([FLOOR, 'A CUSTOM REPLACEMENT PROMPT'])
  check('raw decode (custom path, registry miss) keeps the floor', rawResolved.sections.some(s => s.text === FLOOR))
  check('raw decode renders the floor into OpenAI instructions', renderOpenaiInstructions(rawResolved).includes(FLOOR))
}

// ─────────────────────────────────────────────────────────────────────────
section('§5 subagent doctrine — floor LEADS every spawned child')
// ─────────────────────────────────────────────────────────────────────────
{
  const { buildSubagentMercurySections } = await import('../../src/constants/subagentDoctrine.ts')
  const { VERIFICATION_AGENT } = await import('../../src/tools/AgentTool/built-in/verificationAgent.ts')

  const normal = buildSubagentMercurySections({ agentDefinition: { agentType: 'general-purpose' } })
  check('normal agent: floor is element 0', normal[0] === FLOOR)
  check('normal agent: the operating register follows', typeof normal[1] === 'string' && normal[1]!.includes('<subagent-doctrine>'))

  const fixed = buildSubagentMercurySections({ agentDefinition: VERIFICATION_AGENT })
  check('fixed-output agent (verification): floor is STILL element 0', fixed[0] === FLOOR)
}

// ─────────────────────────────────────────────────────────────────────────
section('§6 source pins — the bun-unloadable seats, one line each')
// ─────────────────────────────────────────────────────────────────────────
{
  // Each pin is the exact assembly expression at the seat; a refactor that
  // moves the floor re-lands here deliberately.
  const pins: Array<[string, string, string]> = [
    // Every interactive turn runs in a session's runner (the concourse
    // worker rides the headless engine's own assembly): ONE seat carries
    // the interactive and the SDK turns alike.
    ['every session turn — interactive (the concourse runner) and SDK alike (custom prompt)', 'src/QueryEngine.ts', '? [MERCURY_IDENTITY_FLOOR, config.customSystemPrompt]'],
    ['bare MERCURY_SIMPLE prompt', 'src/constants/prompts.ts', '${simpleHead}\\n\\n${MERCURY_IDENTITY_FLOOR}'],
    ['default prompt contract splice (frozen per conversation through the section cache)', 'src/constants/prompts.ts', "systemPromptSection('mercury-contract', () => JSON.stringify(getMercuryContractSections()))"],
    // The manager addendum sits BEHIND the contract —
    // same order law: floor, engine line, contract; manager bits after.
    ['switchboard coordinator seat (its own floor, then its engine line)', 'src/services/concourse/coordinatorCall.ts', 'asSystemPrompt([\n          MERCURY_COORDINATOR_FLOOR,\n          engineLine,\n          input.contract,'],
    ['every seat states its engine from ONE owner', 'src/constants/prompts.ts', 'return mercuryEngineIdentityLine(modelId)'],
    ['agent-prompt replacement seat', 'src/utils/systemPrompt.ts', 'parts.push(MERCURY_IDENTITY_FLOOR, agentPrompt)'],
    ['custom-prompt replacement seat', 'src/utils/systemPrompt.ts', 'parts.push(MERCURY_IDENTITY_FLOOR, customSystemPrompt)'],
    ['AgentTool default spawn (doctrine leads)', 'src/tools/AgentTool/AgentTool.tsx', '[...doctrine, ownPrompt]'],
    ['runAgent fallback build (doctrine leads)', 'src/tools/AgentTool/runAgent.ts', '[...doctrine, ownPrompt]'],
    ['runAgent honors override only when supplied', 'src/tools/AgentTool/runAgent.ts', 'override?.systemPrompt ??'],
    ['swarm teammate turn passes NO override prompt', 'src/utils/swarm/inProcessRunner.ts', 'override: { abortController: turnController }'],
  ]
  for (const [label, file, needle] of pins) {
    check(`${label} — ${file}`, SRC(file).includes(needle))
  }

  // The doctrine splice reaches BOTH chokepoints (mutually exclusive by the
  // AgentTool worktree/cwd condition — the comment law in subagentDoctrine).
  check(
    'buildSubagentMercurySections is called at both chokepoints',
    SRC('src/tools/AgentTool/AgentTool.tsx').includes('buildSubagentMercurySections({') &&
      SRC('src/tools/AgentTool/runAgent.ts').includes('buildSubagentMercurySections({'),
  )
}

console.log(failures ? '\n❌ FLOOR-DELIVERY RED' : '\n✅ FLOOR-DELIVERY GREEN')
process.exit(failures ? 1 : 0)
