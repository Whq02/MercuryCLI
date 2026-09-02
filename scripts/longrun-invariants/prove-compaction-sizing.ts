#!/usr/bin/env bun
// ============================================================================
//  scripts/longrun-invariants/prove-compaction-sizing.ts — compaction sizing.
//
//  What the code did vs the invariant it missed: the in-process teammate
//  runner sized its pre-compaction threshold from the PARENT model's context
//  window (`getAutoCompactThreshold(toolUseContext.options.mainLoopModel)`)
//  while dispatching the CHILD model — a teammate on a smaller-window model
//  could overflow the provider before the runner ever compacted, and a
//  larger-window teammate compacted needlessly early.
//
//  The invariant: the threshold sizes against the model the runner actually
//  dispatches — resolved ONCE through the same chokepoint runAgent uses
//  (getAgentModel(definition.model, parentModel, override)).
// ============================================================================
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'compaction-sizing-home-'))
// getAutoCompactThreshold reads global config behind the boot allowance —
// the standard test-env pin opens it for this hermetic scratch home.
process.env.NODE_ENV = 'test'

const { getAutoCompactThreshold } = await import('../../src/services/compact/autoCompact.js')
const { getAgentModel } = await import('../../src/utils/model/agent.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('§A the derivation: child threshold ≠ parent threshold when windows differ')
{
  const parent = 'claude-fable-5[1m]' // 1m-window catalogue row
  const childOverride = 'claude-fable-5' // the same family's 200k row — only the window differs
  const effective = getAgentModel(undefined, parent, childOverride as never)
  check('the chokepoint resolves the OVERRIDE, not the parent', effective === childOverride, effective)
  const parentThreshold = getAutoCompactThreshold(parent)
  const childThreshold = getAutoCompactThreshold(effective)
  check(
    'the two models genuinely size differently (the fixture is meaningful)',
    parentThreshold !== childThreshold,
    `parent=${parentThreshold} child=${childThreshold}`,
  )
  check(
    'a 1m-window parent must not inflate a 200k child threshold',
    childThreshold < parentThreshold,
    `parent=${parentThreshold} child=${childThreshold}`,
  )
  const inherited = getAgentModel(undefined, parent, undefined)
  check(
    'no override + no definition model ⇒ the parent model (inherit unchanged)',
    getAutoCompactThreshold(inherited) === parentThreshold,
  )
}

section('§B the runner wires the threshold to the effective teammate model')
{
  const src = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'utils', 'swarm', 'inProcessRunner.ts'),
    'utf8',
  )
  check(
    'the effective model is resolved ONCE through getAgentModel',
    src.includes('const effectiveModel = getAgentModel('),
  )
  check(
    'the compaction threshold reads the effective model',
    src.includes('getAutoCompactThreshold(effectiveModel)'),
  )
  check(
    'no compaction threshold reads the parent model anymore',
    !src.includes('getAutoCompactThreshold(toolUseContext.options.mainLoopModel)'),
  )
  check(
    'the resolution feeds from the same inputs the dispatch uses (definition + parent + override)',
    /getAgentModel\(derivedDefinition\.model, options\.mainLoopModel, config\.model\)/.test(src),
  )
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} COMPACTION-SIZING PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL COMPACTION-SIZING PROOFS PASS')
