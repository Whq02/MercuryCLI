#!/usr/bin/env bun
// ============================================================================
//  scripts/wards/prove-ward-regex-cache.ts — ward rules compile once per
//  rule object; identity is the invalidation; verdicts do not move.
//
//  Every qualifying tool call (Bash/PowerShell/Edit/Write/NotebookEdit)
//  used to rebuild every rule's RegExps from scratch — compile(rule) per
//  call plus fresh pathPattern/allowPathPattern constructions per
//  edit-scoped rule. The compiled products are now cached by RULE OBJECT
//  identity (rule objects are built once — module constants, or the
//  registration parse — and never mutated; a reloaded rules file mints new
//  objects and misses naturally). Laws:
//
//   W1  (counted operations) with RegExp construction wrapped, repeated
//       evaluateWards calls over the same rules construct ZERO new
//       regexes after the first call (the previous shape paid every rule's
//       patterns again per call);
//   W2  verdict stability — deny/allow/excerpt/line identical across
//       cached calls, for bash denials, edit path-pattern gating, the
//       allowPathPattern carve-out, an invalid pattern (skipped, rule
//       still enforced through its valid siblings), an invalid pathPattern
//       (rule never applies), and an invalid allowPathPattern (treated
//       absent — the rule still enforces);
//   W3  identity invalidation — a NEW rule object with identical fields
//       compiles afresh (the cache never bleeds across objects).
//
//  Run: ~/.bun/bin/bun run scripts/wards/prove-ward-regex-cache.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// The construction counter wraps the global BEFORE the module import so the
// module's `new RegExp` sites resolve to it.
const RealRegExp = globalThis.RegExp
let constructions = 0
let counting = false
const CountingRegExp = new Proxy(RealRegExp, {
  construct(target, args: unknown[]) {
    if (counting) constructions++
    return Reflect.construct(target, args)
  },
}) as RegExpConstructor
globalThis.RegExp = CountingRegExp

const wards = await import('../../src/utils/wards/wards.ts')
type WardRule = (typeof wards.AUTONOMOUS_WARDS)[number]

const bashCall = (command: string) =>
  ({ toolName: 'Bash', input: { command } }) as never
const editCall = (file_path: string, new_string: string) =>
  ({ toolName: 'Edit', input: { file_path, new_string, old_string: 'x' } }) as never

section('W1 · counted operations — zero constructions after the first call')
{
  const rules = wards.AUTONOMOUS_WARDS
  // Warm the cache with one call of each scope shape.
  wards.evaluateWards(rules, bashCall('ls -la'))
  counting = true
  constructions = 0
  for (let i = 0; i < 50; i++) {
    wards.evaluateWards(rules, bashCall('ls && echo ok'))
    wards.evaluateWards(rules, bashCall('rm -rf /Users/someone/things'))
  }
  counting = false
  console.log(`  · RegExp constructions across 100 warmed calls: ${constructions}`)
  check(
    '100 warmed evaluateWards calls construct ZERO regexes (the previous shape paid patterns x calls)',
    constructions === 0,
    `constructions=${constructions}`,
  )
}

section('W2 · verdict stability across cached calls')
{
  const rules = wards.AUTONOMOUS_WARDS
  const denied1 = wards.evaluateWards(rules, bashCall('rm -rf /Users/someone/project'))
  const denied2 = wards.evaluateWards(rules, bashCall('rm -rf /Users/someone/project'))
  check(
    'the home-recursive-delete denial is stable (rule, excerpt, line identical)',
    denied1.allow === false &&
      denied2.allow === false &&
      denied1.rule?.name === denied2.rule?.name &&
      denied1.excerpt === denied2.excerpt &&
      denied1.line === denied2.line,
    JSON.stringify({ denied1, denied2 }).slice(0, 200),
  )
  const allowed = wards.evaluateWards(rules, bashCall('rm -rf ./local/tmp'))
  check('a worktree-local recursive delete stays allowed', allowed.allow === true, JSON.stringify(allowed).slice(0, 120))

  const pathRule: WardRule = {
    name: 'edit-path-gated',
    teach: 'gated',
    scope: 'edit',
    patterns: ['forbidden-token'],
    pathPattern: 'src/hot/.*\\.ts$',
    allowPathPattern: 'src/hot/allowed/.*',
  } as WardRule
  const gated = [pathRule] as readonly WardRule[]
  const inScope1 = wards.evaluateWards(gated, editCall('src/hot/a.ts', 'has forbidden-token here'))
  const inScope2 = wards.evaluateWards(gated, editCall('src/hot/a.ts', 'has forbidden-token here'))
  const outOfScope = wards.evaluateWards(gated, editCall('src/cold/a.ts', 'has forbidden-token here'))
  const carvedOut = wards.evaluateWards(gated, editCall('src/hot/allowed/a.ts', 'has forbidden-token here'))
  check('path-gated denial stable across cached calls', inScope1.allow === false && inScope2.allow === false && inScope1.excerpt === inScope2.excerpt)
  check('out-of-scope path never applies', outOfScope.allow === true)
  check('allowPathPattern carve-out holds', carvedOut.allow === true)

  const invalidPatternRule: WardRule = {
    name: 'half-broken',
    teach: 'x',
    scope: 'bash',
    patterns: ['[unclosed', 'still-works'],
  } as WardRule
  const half1 = wards.evaluateWards([invalidPatternRule], bashCall('this still-works today'))
  const half2 = wards.evaluateWards([invalidPatternRule], bashCall('this still-works today'))
  check('an invalid pattern stays skipped while valid siblings enforce, stably', half1.allow === false && half2.allow === false && half1.excerpt === 'still-works')

  const invalidPathRule: WardRule = {
    name: 'never-applies',
    teach: 'x',
    scope: 'edit',
    patterns: ['forbidden-token'],
    pathPattern: '[unclosed',
  } as WardRule
  check(
    'an invalid pathPattern keeps the rule never-applying on every call',
    wards.evaluateWards([invalidPathRule], editCall('a.ts', 'forbidden-token')).allow === true &&
      wards.evaluateWards([invalidPathRule], editCall('a.ts', 'forbidden-token')).allow === true,
  )

  const invalidAllowRule: WardRule = {
    name: 'allow-broken',
    teach: 'x',
    scope: 'edit',
    patterns: ['forbidden-token'],
    allowPathPattern: '[unclosed',
  } as WardRule
  check(
    'an invalid allowPathPattern is treated absent — the rule still enforces, stably',
    wards.evaluateWards([invalidAllowRule], editCall('a.ts', 'forbidden-token')).allow === false &&
      wards.evaluateWards([invalidAllowRule], editCall('a.ts', 'forbidden-token')).allow === false,
  )
}

section('W3 · identity is the invalidation')
{
  const mint = (): WardRule =>
    ({
      name: 'minted',
      teach: 'x',
      scope: 'bash',
      patterns: ['needle-one', 'needle-two'],
    }) as WardRule
  const a = mint()
  wards.evaluateWards([a], bashCall('nothing'))
  counting = true
  constructions = 0
  wards.evaluateWards([a], bashCall('nothing again'))
  const cachedCalls = constructions
  const b = mint()
  wards.evaluateWards([b], bashCall('nothing more'))
  const freshCalls = constructions - cachedCalls
  counting = false
  check('the cached object constructs nothing', cachedCalls === 0, `cachedCalls=${cachedCalls}`)
  check('a NEW object with identical fields compiles afresh', freshCalls >= 2, `freshCalls=${freshCalls}`)
}

globalThis.RegExp = RealRegExp
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
