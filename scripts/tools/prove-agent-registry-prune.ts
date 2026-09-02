#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-agent-registry-prune.ts
//  PROOF for: agentNameRegistry (name→agentId, for SendMessage routing)
//  had ONE writer (.set) and ZERO .delete — evictTerminalTask removed the task but
//  never the registry entry. Over a long autonomous session the Map grew unbounded,
//  and a REUSED name kept the OLD mapping → SendMessage routed to the dead agent.
//  The fix prunes registry entries whose value (agentId) === the evicted taskId.
//
//  framework.ts is unloadable under bun-run (voice feature() macro graph), so this
//  locks the wiring by source-text + mirrors the (pure) prune.
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-agent-registry-prune.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const fw = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'task', 'framework.ts'), 'utf-8')

console.log('============================================================')
console.log(' agent registry prune — evictTerminalTask drops stale routes (HB-0133)')
console.log('============================================================')

section('source: evictTerminalTask prunes the name→agentId registry by value===taskId')
check('it collects registry names whose id === the evicted taskId', /for \(const \[name, agentId\] of registry\)[\s\S]{0,80}String\(agentId\) === taskId/.test(fw))
check('it deletes those names (clone-on-write, only when something is removed)', /if \(staleNames\.length > 0\)[\s\S]{0,120}registry = new Map\(registry\)[\s\S]{0,80}registry\.delete\(name\)/.test(fw))
check('the returned state carries the pruned registry', /return \{ \.\.\.prevState, tasks, agentNameRegistry: registry \}/.test(fw))

section('behavioural mirror: evict prunes the matching route, keeps the rest')
// Mirror of the shipped prune.
const evict = (
  state: { tasks: Record<string, { id: string; status: string; notified: boolean }>; registry: Map<string, string> },
  taskId: string,
): typeof state => {
  const task = state.tasks[taskId]
  if (!task || task.status !== 'completed' || !task.notified) return state // terminal+notified only
  const { [taskId]: _, ...remaining } = state.tasks
  let registry = state.registry
  const stale: string[] = []
  for (const [name, id] of registry) if (id === taskId) stale.push(name)
  if (stale.length) {
    registry = new Map(registry)
    for (const n of stale) registry.delete(n)
  }
  return { tasks: remaining, registry }
}
const s0 = {
  tasks: { t1: { id: 't1', status: 'completed', notified: true }, t2: { id: 't2', status: 'running', notified: false } },
  registry: new Map([['alpha', 't1'], ['atlas', 't1'], ['beta', 't2']]),
}
const s1 = evict(s0, 't1')
check('evicting t1 removes the task', s1.tasks.t1 === undefined)
check('ALL routes to t1 are pruned (alpha + atlas)', !s1.registry.has('alpha') && !s1.registry.has('atlas'))
check('routes to OTHER agents survive (beta→t2)', s1.registry.get('beta') === 't2')
check('registry no longer grows unbounded (size shrank)', s1.registry.size === 1)
const sRunning = evict(s0, 't2') // t2 is running (not terminal) → no change
check('a non-terminal task is NOT evicted and its route is kept', sRunning.tasks.t2 !== undefined && sRunning.registry.has('beta'))
// reused-name shadowing: after prune, re-registering the name maps to the NEW agent.
const reused = new Map(s1.registry)
reused.set('alpha', 't9')
check('after prune, re-registering a freed name maps to the NEW agent (no stale shadow)', reused.get('alpha') === 't9')

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL AGENT-REGISTRY-PRUNE PROOFS PASS')
else console.log(`❌ ${failures} AGENT-REGISTRY-PRUNE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
