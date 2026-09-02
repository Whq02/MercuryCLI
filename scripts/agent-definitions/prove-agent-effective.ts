/**
 * effective runtime truth + overrides + shadow chains.
 *
 * E1 never-Haiku floor surfaces as flooredFrom (raw intent ≠ applied).
 * E2 'inherit' resolves to the parent; definition effort overrides session
 *    effort (runAgent dispatch parity — seam-pinned below).
 * E3 effort truth on three model vocabularies: applied ∈ selectable,
 *    step-down carries adjustedFrom, label ≡ wire tier.
 * E4 operator overrides: model/effort replaced AT LOAD with provenance +
 *    intent retained; disabled excluded from active (flagged in allAgents);
 *    built-ins cannot be disabled.
 * E5 estate shadow chains name their reasons.
 * E6 dispatch seam pins: runAgent consumes definition-effort-over-session;
 *    AgentTool consumes agentDef.model — the same inputs this resolver uses.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'foundry-effective-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.MERCURY_EFFORT_LEVEL
// resolveEffortTruth's launch-pin path reads global config; the boot gate
// yields under the test env (the calibre matrix prover's same seam).
process.env.NODE_ENV = 'test'

// Production loads AgentTool through the tool catalog BEFORE anything touches
// agentToolUtils; starting the graph at resolver.ts instead trips the
// LocalAgentTask↔AgentTool cycle's TDZ under bun source-run. Mirror the
// production order (bun-run proof-loadability law).
await import('../../src/tools/AgentTool/AgentTool.js')
const { resolveAgentEstate, resolveEffectiveAgentRuntime } = await import(
  '../../src/services/agents/resolver.js'
)
const { setAgentDisabled, setAgentOverride } = await import(
  '../../src/services/agents/overrides.js'
)
const { clearAgentDefinitionsCache, getAgentDefinitionsWithOverrides } =
  await import('../../src/tools/AgentTool/loadAgentsDir.js')
const { resolveEffortTruth } = await import('../../src/utils/effort.js')

let failures = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
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
  console.log('E1: never-Haiku floor is visible truth')
  const agent = byName('foundry-haiku-wants')!
  const eff = resolveEffectiveAgentRuntime(agent, {
    parentModel: PARENT,
    sessionEffort: undefined,
  })
  check('raw intent retained', eff.modelIntent === 'haiku')
  check('applied model is not haiku', !eff.model.includes('haiku'), eff.model)
  check('floor firing named', eff.flooredFrom !== undefined, String(eff.flooredFrom))
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

  await setAgentDisabled('user', project, 'general-purpose', true)
  clearAgentDefinitionsCache()
  result = await getAgentDefinitionsWithOverrides(project)
  check(
    'built-ins cannot be disabled',
    result.activeAgents.some(a => a.agentType === 'general-purpose'),
  )
  await setAgentDisabled('user', project, 'general-purpose', false)
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
  console.log('E6: dispatch seam pins (display truth = dispatch truth inputs)')
  const runAgent = readFileSync('src/tools/AgentTool/runAgent.ts', 'utf-8')
  // Re-cut (FN-018 rank 2): the ladder moved into resolveAgentEffort, the
  // ONE expression both the readout and the agent-scoped dispatch state
  // consume — definition-over-session is its second and third rungs.
  check(
    'runAgent consumes definition-effort-over-session (the one ladder at the dispatch seam)',
    /definitionEffort:\s*agentDefinition\.effort,\s*sessionEffort:\s*state\.effortValue,/.test(
      runAgent,
    ),
  )
  const agentTool = readFileSync('src/tools/AgentTool/AgentTool.tsx', 'utf-8')
  check(
    'AgentTool consumes agentDef.model at launch',
    /model:\s*model\s*\?\?\s*agentDef\?\.model/.test(agentTool),
  )
}

{
  console.log('E7: the agent-scoped state dispatches the resolved effort (FN-018 rank 2)')
  // The pure ladder, exported from the runner: pin → definition → session.
  const { resolveAgentEffort } = await import('../../src/tools/AgentTool/runAgent.js')
  check('pin wins on a non-exact-tools run', resolveAgentEffort({ effortOverride: 'max', useExactTools: false, definitionEffort: 'low', sessionEffort: 'medium' }) === 'max')
  check('an exact-tools run ignores the pin (the definition rules)', resolveAgentEffort({ effortOverride: 'max', useExactTools: true, definitionEffort: 'low', sessionEffort: 'medium' }) === 'low')
  check('no pin ⇒ the definition over the session', resolveAgentEffort({ effortOverride: undefined, useExactTools: false, definitionEffort: 'xhigh', sessionEffort: 'low' }) === 'xhigh')
  check('no pin, no definition ⇒ the session', resolveAgentEffort({ effortOverride: undefined, useExactTools: false, definitionEffort: undefined, sessionEffort: 'high' }) === 'high')
  check('nothing declared anywhere ⇒ undefined (the resolver keeps its own default)', resolveAgentEffort({ effortOverride: undefined, useExactTools: false, definitionEffort: undefined, sessionEffort: undefined }) === undefined)
  check('a pin off the ladder yields to the next rung, never rides raw', resolveAgentEffort({ effortOverride: 'turbo', useExactTools: false, definitionEffort: undefined, sessionEffort: 'low' }) === 'low')
  check('a spoken pin normalises through the one effort normaliser', resolveAgentEffort({ effortOverride: 'x-high', useExactTools: false, definitionEffort: undefined, sessionEffort: undefined }) === 'xhigh')
  // The dispatch seam: the agent-scoped app state writes the ladder's answer
  // to effortValue — the key turn-machine reads — never to a dead key.
  const runAgent = readFileSync('src/tools/AgentTool/runAgent.ts', 'utf-8')
  const scoped = runAgent.slice(runAgent.indexOf('const agentGetAppState'), runAgent.indexOf('// ── Hooks'))
  check('the scoped state writes effortValue (the key dispatch reads)', /parentState\.effortValue !== effortValue/.test(scoped) && /toolPermissionContext: context, effortValue \}/.test(scoped), scoped.slice(0, 80))
  check('…and never the dead effort key the base wrote', !/\beffort: effortValue/.test(scoped) && !/\{ effort\?: unknown \}/.test(scoped))
  check('the identity readout rides the same ladder', /const resolvedEffort = resolveAgentEffort\(\{/.test(runAgent))
  const turnMachine = readFileSync('src/run-core/turn-machine.ts', 'utf-8')
  check('dispatch reads appState.effortValue (the key the scoped state now carries)', /iter\.appState\.effortValue/.test(turnMachine))
  const store = readFileSync('src/state/AppStateStore.ts', 'utf-8')
  check('AppState declares effortValue and no effort key', /^\s*effortValue: EffortValue \| undefined/m.test(store) && !/^\s*effort: /m.test(store))
  // FN-017 rank 15: the per-spawn instruction capture reads the bundle's
  // real digest field — the structural cast that read `.digest` always
  // answered '' and the sidecar never carried instructionDigest.
  check('the instruction capture reads bundleDigest (no structural cast to a field that does not exist)', /digest: slice\.bundle\.bundleDigest/.test(runAgent) && !/\{ digest\?: string \}/.test(runAgent))
}

rmSync(scratch, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} effective-truth check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll effective-truth checks pass.')
