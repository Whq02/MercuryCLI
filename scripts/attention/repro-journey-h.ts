#!/usr/bin/env bun
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const OWNER = '../../src/services/attention/relations.ts'
const EDGES = ['spawned-by', 'depends-on', 'worktree', 'overlap']

t.section('Journey H — the relationship model exists at its pinned owner')
let mod: Record<string, unknown> | null = null
try {
  mod = (await import(OWNER)) as Record<string, unknown>
} catch {
  mod = null
}
t.check(
  'src/services/attention/relations.ts loads',
  mod !== null,
  mod ? 'loaded' : 'module absent — no relationship model',
)
const kinds = mod?.RELATION_EDGE_KINDS as unknown
t.check(
  'RELATION_EDGE_KINDS carries every required edge kind',
  Array.isArray(kinds) && EDGES.every(k => (kinds as string[]).includes(k)),
  Array.isArray(kinds) ? (kinds as string[]).join(',') : 'absent',
)
t.check('the fold entry exists (foldRelations — owner events in, edges out)', typeof mod?.foldRelations === 'function')

t.section('Journey H — the graph surface is bound (RV-13)')
{
  const { readFileSync } = await import('node:fs')
  const ag = readFileSync('src/keybindings/actionGraph.ts', 'utf8')
  t.check(
    "the Action Graph no longer names 'board:graph' (retired with the WORK panel)",
    !/['"]board:graph['"]/.test(ag),
    'the retired graph verb is still registered',
  )
}

t.finish('repro-journey-h')
