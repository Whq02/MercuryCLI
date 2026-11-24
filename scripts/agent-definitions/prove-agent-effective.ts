import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'foundry-effective-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.MERCURY_EFFORT_LEVEL
process.env.NODE_ENV = 'test'

const { setSessionTrustAccepted: trustTheProofFolder } = await import('../../src/boot/process-state/processState.js')
trustTheProofFolder(true)
await import('../../src/tools/crewmate/CrewmateTool.js')
const { resolveAgentEstate, resolveEffectiveAgentRuntime } = await import(
  '../../src/crew/agents/resolver.js'
)
const { setAgentDisabled, setAgentOverride } = await import(
  '../../src/crew/agents/overrides.js'
)
const { clearAgentDefinitionsCache, getAgentDefinitionsWithOverrides } =
  await import('../../src/tools/crewmate/loadAgentsDir.js')
const { resolveEffortTruth } = await import('../../src/models/effort/effort.js')

let failures = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''} — to fix, change resolveEffectiveAgentRuntime or resolveAgentEstate in src/crew/agents/resolver.ts, setAgentOverride or setAgentDisabled in src/crew/agents/overrides.ts, getAgentDefinitionsWithOverrides in src/tools/crewmate/loadAgentsDir.ts, resolveEffortTruth in src/models/effort/effort.ts, or resolveAgentEffort in src/tools/crewmate/runCrewmate.ts, whichever this check's section names`)
  }
}

const PARENT = 'claude-opus-4-8'

const agentFile = (
  name: string,
  extra: string,
): string => `---\nname: ${name}\ndescription: "d"\n${extra}\n---\n\nYou are ${name}.\n`

const project = join(scratch, 'project')
mkdirSync(join(project, '.git'), { recursive: true })
mkdirSync(join(project, '.mercury', 'agents'), { recursive: true })
writeFileSync(
  join(project, '.mercury', 'agents', 'haiku-wants.md'),
  agentFile('foundry-haiku-wants', 'model: haiku'),
)
writeFileSync(
  join(project, '.mercury', 'agents', 'inheriter.md'),
  agentFile('foundry-inheriter', 'effort: xhigh'),
)
writeFileSync(
  join(project, '.mercury', 'agents', 'plain.md'),
  agentFile('foundry-plain', 'model: sonnet'),
)

clearAgentDefinitionsCache()
let result = await getAgentDefinitionsWithOverrides(project)
const byName = (n: string) => result.activeAgents.find(a => a.agentType === n)

{
  console.log('E1: a haiku intent applies as the haiku row')
  const agent = byName('foundry-haiku-wants')!
  const eff = resolveEffectiveAgentRuntime(agent, {
    parentModel: PARENT,
    sessionEffort: undefined,
  })
  check('raw intent retained', eff.modelIntent === 'haiku')
  check('applied model is the haiku row', eff.model.includes('haiku'), eff.model)
}

{
  console.log('E2: inherit + definition-effort-over-session')
  const agent = byName('foundry-inheriter')!
  const eff = resolveEffectiveAgentRuntime(agent, {
    parentModel: PARENT,
    sessionEffort: 'low',
  })
  check('inherit resolves to the parent', eff.model === PARENT, eff.model)
  check('definition effort wins over session', eff.effortIntent === 'xhigh')
  check(
    'applied equals the truth for that input',
    JSON.stringify(eff.effort) ===
      JSON.stringify(resolveEffortTruth(PARENT, 'xhigh')),
  )
  const noDef = byName('foundry-plain')!
  const effSession = resolveEffectiveAgentRuntime(noDef, {
    parentModel: PARENT,
    sessionEffort: 'low',
  })
  check(
    'no definition effort ⇒ session effort flows',
    JSON.stringify(effSession.effort) ===
      JSON.stringify(resolveEffortTruth(effSession.model, 'low')),
  )
}

{
  console.log('E3: calibre truth across three vocabularies')
  for (const model of ['claude-opus-4-8', 'claude-sonnet-5', 'claude-fable-5']) {
    const maxTruth = resolveEffortTruth(model, 'max')
    check(
      `${model}: applied ∈ selectable`,
      maxTruth.applied === undefined ||
        maxTruth.selectable.includes(maxTruth.applied),
      JSON.stringify(maxTruth),
    )
    check(
      `${model}: step-down names its origin`,
      maxTruth.applied === 'max' || maxTruth.adjustedFrom === 'max',
      JSON.stringify({ applied: maxTruth.applied, adjustedFrom: maxTruth.adjustedFrom }),
    )
    check(
      `${model}: label tells the wire truth`,
      maxTruth.wire === undefined
        ? maxTruth.label === 'high'
        : maxTruth.label === String(maxTruth.wire),
    )
  }
}

{
  console.log('E4: operator overrides')
  await setAgentOverride('project', project, 'foundry-plain', {
    model: 'opus',
    effort: 'high',
  })
  clearAgentDefinitionsCache()
  result = await getAgentDefinitionsWithOverrides(project)
  const agent = byName('foundry-plain')!
  check('override model applied at load', agent.model === 'opus', agent.model)
  check('override effort applied at load', agent.effort === 'high')
  check(
    'provenance + intent retained',
    agent.operatorOverride?.from === 'project' &&
      agent.operatorOverride?.intentModel === 'sonnet',
    JSON.stringify(agent.operatorOverride),
  )

  await setAgentDisabled('user', project, 'foundry-plain', true)
  clearAgentDefinitionsCache()
  result = await getAgentDefinitionsWithOverrides(project)
  check('disabled agent leaves activeAgents', byName('foundry-plain') === undefined)
  const shelved = result.allAgents.find(a => a.agentType === 'foundry-plain')
  check('disabled agent stays visible in allAgents', shelved?.disabled === true)

  await setAgentDisabled('user', project, 'mercury-crew', true)
  clearAgentDefinitionsCache()
  result = await getAgentDefinitionsWithOverrides(project)
  check(
    'built-ins cannot be disabled',
    result.activeAgents.some(a => a.agentType === 'mercury-crew'),
  )
  await setAgentDisabled('user', project, 'mercury-crew', false)
  await setAgentDisabled('user', project, 'foundry-plain', false)
  await setAgentOverride('project', project, 'foundry-plain', undefined)
}

{
  console.log('E5: shadow chains name their reasons')
  mkdirSync(join(project, '.mercury', 'agents'), { recursive: true })
  writeFileSync(
    join(project, '.mercury', 'agents', 'dup.md'),
    agentFile('foundry-inheriter', 'model: sonnet'),
  )
  mkdirSync(join(home, 'agents'), { recursive: true })
  writeFileSync(
    join(home, 'agents', 'userdup.md'),
    agentFile('foundry-plain', 'model: sonnet'),
  )
  clearAgentDefinitionsCache()
  result = await getAgentDefinitionsWithOverrides(project)
  const estate = resolveAgentEstate(result)
  const dupEntry = estate.get('foundry-inheriter')!
  check(
    'same-tree duplicate shadow named',
    dupEntry.candidates.some(
      c => !c.winner && c.shadowReason === 'duplicate-in-tree',
    ),
    JSON.stringify(dupEntry.candidates.map(c => ({ w: c.winner, r: c.shadowReason }))),
  )
  const crossEntry = estate.get('foundry-plain')!
  check(
    'scope shadow named',
    crossEntry.candidates.some(
      c => !c.winner && c.shadowReason === 'scope-precedence',
    ),
  )
}


{
  console.log('E7: the agent-scoped state dispatches the resolved effort (FN-018 rank 2)')
  const { resolveCrewmateEffort } = await import('../../src/tools/crewmate/runCrewmate.js')
  check('pin wins on a non-exact-tools run', resolveCrewmateEffort({ effortOverride: 'max', useExactTools: false, definitionEffort: 'low', defaultEffort: 'medium' }) === 'max')
  check('an exact-tools run ignores the pin (the definition rules)', resolveCrewmateEffort({ effortOverride: 'max', useExactTools: true, definitionEffort: 'low', defaultEffort: 'medium' }) === 'low')
  check('no pin ⇒ the definition over the configured default', resolveCrewmateEffort({ effortOverride: undefined, useExactTools: false, definitionEffort: 'xhigh', defaultEffort: 'low' }) === 'xhigh')
  check('no pin, no definition ⇒ the configured default', resolveCrewmateEffort({ effortOverride: undefined, useExactTools: false, definitionEffort: undefined, defaultEffort: 'high' }) === 'high')
  check('nothing declared anywhere ⇒ undefined (the resolver keeps its own default)', resolveCrewmateEffort({ effortOverride: undefined, useExactTools: false, definitionEffort: undefined, defaultEffort: undefined }) === undefined)
  check('a pin off the ladder yields to the next rung, never rides raw', resolveCrewmateEffort({ effortOverride: 'turbo', useExactTools: false, definitionEffort: undefined, defaultEffort: 'low' }) === 'low')
  check('a spoken pin normalises through the one effort normaliser', resolveCrewmateEffort({ effortOverride: 'x-high', useExactTools: false, definitionEffort: undefined, defaultEffort: undefined }) === 'xhigh')
  const t = await import('../core-runtime/turnScenarios.ts')
  const dispatched = await t.runScripted({ appState: { effortValue: 'low', effort: 'max' }, script: [t.fixtures.yields(t.fixtures.says('done.'))] })
  const sent = dispatched.requests[0]?.options.effortValue
  const announced = dispatched.events.find(event => event.kind === 'model_call_started')?.effort
  check('dispatch reads appState.effortValue (the key the scoped state now carries)', sent === 'low' && announced === 'low', `a run whose app state holds effortValue low (and a stray effort key max) sent ${String(sent)} to the model and announced ${String(announced)}: the model call of src/engine/loop/turn/streamModel.ts must carry the effortValue key of the context's app state`)
}

rmSync(scratch, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} effective-truth check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll effective-truth checks pass.')
