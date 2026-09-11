#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const src = readFileSync('src/utils/sideQuestion.ts', 'utf8')

t.section('Journey D — side-branch parentage + attachable result at the ONE seam')
t.check(
  'SideQuestionResult records parentage (originRef field in the type body)',
  /^\s*originRef[?]?:/m.test(src),
  'the result type carries no origin/parentage today',
)
t.check(
  'the result is attachable as a typed context item (export toContextItem)',
  /^export (function|const) toContextItem/m.test(src),
)
t.check(
  'the 1-turn no-tools contract is STILL the engine law (must never regress)',
  src.includes('maxTurns: 1,') && src.includes("behavior: 'deny',") && src.includes('tools are blocked for this fork'),
)

t.section('Journey D — the side-branch surface is bound (RV-09)')
{
  const ag = readFileSync('src/keybindings/actionGraph.ts', 'utf8')
  t.check(
    "the Action Graph no longer names 'board:side-question' (retired with the WORK panel)",
    !/['"]board:side-question['"]/.test(ag),
    'the retired side-question verb is still registered',
  )
}

t.finish('repro-journey-d')
