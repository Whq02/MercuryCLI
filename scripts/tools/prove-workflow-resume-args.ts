#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-workflow-resume-args.ts
//  PROOF for: the Workflow resume cache chain was seeded at '' and folded
//  only each agent()'s (prompt, opts) — never the workflow's `args`. So a resume
//  with CHANGED args that affect branching/aggregation (but no agent's prompt/opts)
//  left every per-call key unchanged → STALE cached agent results replayed. The
//  fix seeds the chain from canonicalizeArgsSeed(args).
//
//  agentHooks.ts is unloadable under bun-run (pulls the runAgent → feature()
//  bun:bundle macro graph), so this locks the wiring by source-text + mirrors the
//  (pure) seed + chain-key derivation with the real crypto.
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-workflow-resume-args.ts
// ============================================================================
import crypto from 'node:crypto'
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
const hooks = readFileSync(join(import.meta.dir, '..', '..', 'src', 'tools', 'WorkflowTool', 'agentHooks.ts'), 'utf-8')
const exec = readFileSync(join(import.meta.dir, '..', '..', 'src', 'tools', 'WorkflowTool', 'executor.ts'), 'utf-8')

console.log('============================================================')
console.log(' workflow resume — chain seeded from args (HB-0105)')
console.log('============================================================')

section('source: the chain is seeded from the workflow args')
check('the cache-chain tip is seeded from canonicalizeArgsSeed(deps.args) (priorCacheKey/workflowArgs → cacheChainTip/deps.args; same law)', /let cacheChainTip = canonicalizeArgsSeed\(deps\.args\)/.test(hooks))
check('canonicalizeArgsSeed returns "" for undefined args (argless = unchanged)', /export function canonicalizeArgsSeed[\s\S]{0,120}if \(args === undefined\) return ''/.test(hooks))
check('makeWorkflowHooks seeds the chain from deps.args inside the factory (no destructure any more)', /export function makeWorkflowHooks\(deps: WorkflowHookDeps\)[\s\S]{0,4000}canonicalizeArgsSeed\(deps\.args\)/.test(hooks))
check('WorkflowHookDeps carries args (the doc comment sits above the field)', /interface WorkflowHookDeps \{[\s\S]{0,2000}args\?: unknown/.test(hooks))
check('executor passes opts.args into makeHooks (no trailing comment, the argument stays)', /opts\.makeHooks\(\{[\s\S]{0,800}args: opts\.args,/.test(exec))

section('behavioural mirror: seed + chain-key derivation (real crypto)')
// Mirror of canonicalizeValue / canonicalizeArgsSeed / agentCacheKey.
const canonicalize = (o: unknown): unknown => {
  if (typeof o === 'function') return undefined
  if (Array.isArray(o)) return o.map(canonicalize)
  if (o && typeof o === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o as Record<string, unknown>).sort()) {
      if (k === '__proto__') continue
      out[k] = canonicalize((o as Record<string, unknown>)[k])
    }
    return out
  }
  return o
}
const argsSeed = (args: unknown): string =>
  args === undefined ? '' : `args:${crypto.createHash('sha256').update(JSON.stringify(canonicalize(args))).digest('hex')}`
const cacheKey = (prompt: string, opts: unknown, prior: string): string =>
  crypto.createHash('sha256').update(prior).update('\x00').update(prompt).update('\x00').update(JSON.stringify(canonicalize(opts))).digest('hex')

check('undefined args ⇒ "" seed (argless workflows: byte-identical resume)', argsSeed(undefined) === '')
check('present args ⇒ non-empty seed', argsSeed({ q: 'find bugs', n: 3 }).startsWith('args:'))
check('seed is key-order-independent (stable across runs)', argsSeed({ q: 'x', n: 3 }) === argsSeed({ n: 3, q: 'x' }))
check('a CHANGED arg ⇒ a different seed', argsSeed({ q: 'x', n: 3 }) !== argsSeed({ q: 'x', n: 4 }))
// The payoff: with the SAME prompt/opts, a changed args seed ⇒ a changed cache key
// ⇒ the cached agent result is NOT replayed (the bug) — for the WHOLE chain.
const sameAgent = (seed: string) => cacheKey('do the work', { model: 'opus' }, seed)
check('same agent(prompt,opts) but changed args ⇒ DIFFERENT cache key (no stale replay)', sameAgent(argsSeed({ n: 3 })) !== sameAgent(argsSeed({ n: 4 })))
check('same agent + same args ⇒ SAME cache key (legit resume still hits cache)', sameAgent(argsSeed({ n: 3 })) === sameAgent(argsSeed({ n: 3 })))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL WORKFLOW-RESUME-ARGS PROOFS PASS')
else console.log(`❌ ${failures} WORKFLOW-RESUME-ARGS PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
