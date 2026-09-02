#!/usr/bin/env bun
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const OWNER = '../../src/services/workbench/returnState.ts'

t.section('Journey E — the attach/detach return-state seam exists')
let mod: Record<string, unknown> | null = null
try {
  mod = (await import(OWNER)) as Record<string, unknown>
} catch {
  mod = null
}
t.check(
  'src/services/workbench/returnState.ts loads',
  mod !== null,
  mod ? 'loaded' : 'module absent — detach has nowhere to return to',
)
t.check('captureReturnState exists', typeof mod?.captureReturnState === 'function')
t.check('restoreReturnState exists', typeof mod?.restoreReturnState === 'function')

t.section('Journey E — the attach/detach surface is bound (RV-10)')
{
  const { readFileSync } = await import('node:fs')
  const ag = readFileSync('src/keybindings/actionGraph.ts', 'utf8')
  t.check(
    "the Action Graph no longer names 'board:attach' (retired with the WORK panel)",
    !/['"]board:attach['"]/.test(ag),
    'the retired attach verb is still registered',
  )
}

t.finish('repro-journey-e')
