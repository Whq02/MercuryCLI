#!/usr/bin/env bun
import { checker } from '../engine-durability/harness.ts'

const t = checker()

t.section('Journey C — replace-next RETIRED with the delivery law (steer-removal)')
const q = (await import('../../src/input-core/command-queue.ts')) as Record<string, unknown>
t.check(
  'command-queue exports NO replaceNext any more',
  typeof q.replaceNext === 'undefined',
)

t.section('Journey C — the peek/change-next surface is bound (RV-07/RV-08)')
{
  const { readFileSync } = await import('node:fs')
  const ag = readFileSync('src/keybindings/actionGraph.ts', 'utf8')
  t.check(
    "the Action Graph no longer names 'board:peek' (retired with the WORK panel)",
    !/['"]board:peek['"]/.test(ag) && /['"]prompts:expand['"]/.test(ag),
    'the retired peek verb is still registered',
  )
  t.check(
    "the Action Graph no longer names 'board:change-next' (retired with the WORK panel)",
    !/['"]board:change-next['"]/.test(ag),
    'the retired change-next verb is still registered',
  )
}

t.finish('repro-journey-c')
