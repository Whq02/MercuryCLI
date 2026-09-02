#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const ROOT = join(import.meta.dir, '..', '..')

t.section('§1 — the live gate no longer relies on one loose ratio allowance')
{
  const gateSrc = readFileSync(join(ROOT, 'scripts/interview/prove-resume-bounds.ts'), 'utf8')
  t.check('(premise) the resume-bounds gate exists and measures multi-size slopes',
    gateSrc.includes('opsFor(100)') && gateSrc.includes('opsFor(400)'))
  t.check(
    'the gate uses a slope envelope / operation counts, not a single ×300 allowance',
    !gateSrc.includes('* 300'),
    'prove-resume-bounds.ts still carries `bigMs < Math.max(1, smallMs) * 300`',
  )
}

t.section('§2 — the gate rejects a seeded quadratic (the slope-envelope certificate)')
{
  const gateSrc = readFileSync(join(ROOT, 'scripts/interview/prove-resume-bounds.ts'), 'utf8')
  t.check('the gate measures an operation-count slope envelope', gateSrc.includes('SLOPE_MAX') && gateSrc.includes('opsFor'))
  t.check('the gate carries the seeded-quadratic rejection certificate', gateSrc.includes('REJECTS the seeded quadratic') && gateSrc.includes('quadOps'))
  t.check('the absolute budget stays a SEPARATE gate', gateSrc.includes('§1b') && gateSrc.includes('250'))
}

t.finish('repro-p1-4-bounds-gate-accepts-quadratic')
