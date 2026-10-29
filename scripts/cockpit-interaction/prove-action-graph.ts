#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'
import { ACTION_GRAPH, KEYBINDING_ACTIONS } from '../../src/keybindings/actionGraph.ts'
import { DEFAULT_BINDINGS } from '../../src/keybindings/defaultBindings.ts'
import {
  getReservedShortcuts,
  normalizeKeyForComparison,
} from '../../src/keybindings/reservedShortcuts.ts'

const t = checker()
const graph = ACTION_GRAPH as Record<string, { description: string; contexts: readonly string[]; rebindOnly?: string }>

t.section('§1 — one authority, zero parallel lists')
{
  const types = readFileSync('src/keybindings/types.ts', 'utf8')
  t.check(
    'types.ts DERIVES its union from the graph',
    types.includes('keyof ActionGraph') && !/\|\s*'app:interrupt'/.test(types),
    'no hand union',
  )
  const schema = readFileSync('src/keybindings/schema.ts', 'utf8')
  t.check(
    'schema.ts re-exports the derived list',
    schema.includes("export { KEYBINDING_ACTIONS } from './actionGraph.js'") &&
      !/KEYBINDING_ACTIONS = \[\s*\n/.test(schema),
    'no hand list',
  )
  t.check('the derived list is populated', KEYBINDING_ACTIONS.length >= 100, `${KEYBINDING_ACTIONS.length} actions`)
}

const bound = new Set<string>()
for (const block of DEFAULT_BINDINGS) {
  for (const action of Object.values(block.bindings)) {
    if (typeof action === 'string' && !action.startsWith('command:')) bound.add(action)
  }
}

t.section('§2 — reachability: default-bound or explicitly rebind-only')
{
  const unreachable = KEYBINDING_ACTIONS.filter(a => !bound.has(a) && !graph[a]?.rebindOnly)
  t.check(
    'no action is silently unreachable',
    unreachable.length === 0,
    unreachable.join(', ') || `${bound.size} default-bound · ${KEYBINDING_ACTIONS.length - bound.size} rebind-only`,
  )
  const both = KEYBINDING_ACTIONS.filter(a => bound.has(a) && graph[a]?.rebindOnly)
  t.check(
    'no action claims rebind-only WHILE default-bound (a stale reason)',
    both.length === 0,
    both.join(', ') || 'ok',
  )
  const weak = KEYBINDING_ACTIONS.filter(a => graph[a]?.rebindOnly !== undefined && (graph[a]!.rebindOnly!.trim().length < 20))
  t.check('every rebind-only reason is a real sentence', weak.length === 0, weak.join(', ') || 'ok')
}

t.section('§3 — totality: the defaults never bind an unregistered action')
{
  const ghosts = [...bound].filter(a => !(a in graph))
  t.check('every default-bound action exists in the graph', ghosts.length === 0, ghosts.join(', ') || `${bound.size} all present`)
}

t.section('§4 — honest collisions with the reserved chords')
{
  const ALLOWED = new Set([
    'cmd+c→selection:copy',
    'ctrl+c→app:interrupt',
    'ctrl+d→app:exit',
    'ctrl+c→transcript:exit',
    'ctrl+c→historySearch:cancel',
    'ctrl+c→messageActions:ctrlc',
    'ctrl+d→permission:toggleDebug',
  ])
  const reserved = new Map(
    getReservedShortcuts().map(r => [normalizeKeyForComparison(r.key), r.reason]),
  )
  const offenders: string[] = []
  for (const block of DEFAULT_BINDINGS) {
    for (const [key, action] of Object.entries(block.bindings)) {
      if (action === null) continue
      const norm = normalizeKeyForComparison(key)
      if (reserved.has(norm) && !ALLOWED.has(`${norm}→${String(action)}`)) {
        offenders.push(`${block.context}: ${key} → ${String(action)} (${reserved.get(norm)})`)
      }
    }
  }
  t.check('no undocumented default on a reserved chord', offenders.length === 0, offenders.join('; ') || `${ALLOWED.size} documented allowances`)
}

t.section('§5 — authored meaning')
{
  const blank = KEYBINDING_ACTIONS.filter(a => !graph[a]?.description || graph[a]!.description.trim().length < 8)
  t.check('every action carries a real description', blank.length === 0, blank.join(', ') || 'ok')
  const contextless = KEYBINDING_ACTIONS.filter(a => (graph[a]?.contexts ?? []).length === 0)
  t.check('every action declares its consumer contexts', contextless.length === 0, contextless.join(', ') || 'ok')
  const retired = [
    'app:toggleBrief', 'confirm:previousField', 'app:globalSearch', 'app:quickOpen',
    'crew:open-board', 'settings:search', 'confirm:toggle', 'confirm:nextField',
    'chat:submit', 'history:previous', 'history:next',
  ]
  const revived = retired.filter(a => a in graph)
  t.check(
    'the retired dead actions stay retired (zero consumers / empty DCE handlers / composer-hardcoded keys)',
    revived.length === 0,
    revived.join(', ') || 'ok',
  )
}

t.finish('prove-action-graph')
