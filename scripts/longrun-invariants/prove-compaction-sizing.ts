#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'compaction-sizing-home-'))
process.env.NODE_ENV = 'test'

const { getAutoFoldThreshold } = await import('../../src/engine/compaction/autoFold.js')
const { getAgentModel } = await import('../../src/models/catalogue/agentModel.js')

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
  const parent = 'claude-opus-4-6[1m]'
  const childOverride = 'claude-opus-4-6'
  const effective = getAgentModel(undefined, parent, childOverride as never)
  check('the chokepoint resolves the OVERRIDE, not the parent', effective === childOverride, `${effective} · getAgentModel in src/models/catalogue/agentModel.ts must return the child override model when one is given, not the parent model`)
  const parentThreshold = getAutoFoldThreshold(parent)
  const childThreshold = getAutoFoldThreshold(effective)
  check(
    'the two models genuinely size differently (the fixture is meaningful)',
    parentThreshold !== childThreshold,
    `parent=${parentThreshold} child=${childThreshold} · getAutoCompactThreshold in src/engine/compaction-window/autoFoldWindow.ts must size the [1m] model and the plain model by their own windows`,
  )
  check(
    'a 1m-window parent must not inflate a 200k child threshold',
    childThreshold < parentThreshold,
    `parent=${parentThreshold} child=${childThreshold} · the child threshold must come from the model getAgentModel (src/models/catalogue/agentModel.ts) returns, via getAutoCompactThreshold in src/engine/compaction-window/autoFoldWindow.ts`,
  )
  const inherited = getAgentModel(undefined, parent, undefined)
  check(
    'no override + no definition model ⇒ the parent model (inherit unchanged)',
    getAutoFoldThreshold(inherited) === parentThreshold,
    `getAgentModel in src/models/catalogue/agentModel.ts must return the parent model when there is no override and no definition model (got ${inherited})`,
  )
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} COMPACTION-SIZING PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL COMPACTION-SIZING PROOFS PASS')
