#!/usr/bin/env bun
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

const wards = await import('../../src/permissions/wards/wards.ts')
type WardRule = (typeof wards.AUTONOMOUS_WARDS)[number]

const bashCall = (command: string) =>
  ({ toolName: 'Bash', input: { command }, shellCommand: command }) as never
const editCall = (file_path: string, new_string: string) =>
  ({ toolName: 'Edit', input: { file_path, new_string, old_string: 'x' } }) as never

section('W1 · counted operations — zero constructions after the first call')
{
  const rules = wards.AUTONOMOUS_WARDS
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
    `constructions=${constructions}; evaluateWards in src/permissions/wards/wards.ts is compiling a RegExp per call, so keep the compiled pattern in the per-rule WeakMap (compile, wardPattern)`,
  )
  const builtin = wards.BUILTIN_WARDS
  const heads: Record<string, string> = { '/p/gen.ts': '// @generated\nexport const a = 1\n', '/p/plain.ts': 'export const a = 1\n' }
  const readHead = (path: string): string | undefined => heads[path]
  const resolvePath = (path: string) => ({ path, root: '/p' })
  const edits = [
    { toolName: 'Edit', input: { file_path: '/p/plain.ts', old_string: 'a', new_string: 'const b = 2' }, resolvePath, readHead },
    { toolName: 'Edit', input: { file_path: '/p/gen.ts', old_string: 'a', new_string: 'const b = 2' }, resolvePath, readHead },
    { toolName: 'Write', input: { file_path: '/p/scripts/settings/settings-schema.json', content: '{}' }, resolvePath, readHead },
    { toolName: 'Write', input: { file_path: '/p/plain.ts', content: 'export function a() {}\n// rest of methods ...\n' }, resolvePath, readHead },
    { toolName: 'ChangeSet', input: { op: 'apply', changes: [{ file_path: '/p/plain.ts', expected_anchor: 'fa:0', hunks: [{ lines: '1', replace: '// ... existing code ...' }] }] }, resolvePath, readHead },
  ] as never[]
  for (const call of edits) wards.evaluateWards(builtin, call)
  counting = true
  constructions = 0
  for (let i = 0; i < 20; i++) for (const call of edits) wards.evaluateWards(builtin, call)
  counting = false
  console.log(`  · RegExp constructions across 100 warmed edit-scope calls over the builtin rules: ${constructions}`)
  check(
    '100 warmed edit-scope calls over the builtin rules (path table, leading marker, declaration, placeholder, a ChangeSet member) construct ZERO regexes',
    constructions === 0,
    `constructions=${constructions}; an edit-scope check in src/permissions/wards/wards.ts (cachedPathRegex, cachedLeadingMarker, cachedGeneratedPaths or the declaration regex) is compiling per call, so cache it per rule`,
  )
  const verdicts = edits.map(call => wards.evaluateWards(builtin, call))
  check(
    'the five verdicts are allow, deny (marker), deny (name), deny (placeholder), deny (placeholder in a ChangeSet member)',
    verdicts[0]!.allow === true && verdicts[1]!.allow === false && verdicts[2]!.allow === false && verdicts[3]!.allow === false && verdicts[4]!.allow === false,
    JSON.stringify(verdicts.map(v => (v.allow ? 'allow' : v.rule.name))) + '; caching must not change what evaluateWards in src/permissions/wards/wards.ts answers over BUILTIN_WARDS',
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
    JSON.stringify({ denied1, denied2 }).slice(0, 200) + ' — the second evaluateWards call of the same rule list answered differently from the first; look at the cached compile in src/permissions/wards/wards.ts',
  )
  const allowed = wards.evaluateWards(rules, bashCall('rm -rf ./local/tmp'))
  check('a worktree-local recursive delete stays allowed', allowed.allow === true, JSON.stringify(allowed).slice(0, 120) + ' — AUTONOMOUS_WARDS in src/permissions/wards/wards.ts now refuses a recursive delete inside the worktree; narrow the rule that fired')

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
  check('path-gated denial stable across cached calls', inScope1.allow === false && inScope2.allow === false && inScope1.excerpt === inScope2.excerpt, `first ${JSON.stringify(inScope1)}, second ${JSON.stringify(inScope2)}; a rule with pathPattern must deny the same edit on every call (cachedPathRegex in src/permissions/wards/wards.ts)`)
  check('out-of-scope path never applies', outOfScope.allow === true, `${JSON.stringify(outOfScope)}; a path that pathPattern does not match must be allowed (cachedPathRegex in src/permissions/wards/wards.ts)`)
  check('allowPathPattern carve-out holds', carvedOut.allow === true, `${JSON.stringify(carvedOut)}; a path matching allowPathPattern must be allowed (compiledAllowPathPatterns in src/permissions/wards/wards.ts)`)

  const invalidPatternRule: WardRule = {
    name: 'half-broken',
    teach: 'x',
    scope: 'bash',
    patterns: ['[unclosed', 'still-works'],
  } as WardRule
  const half1 = wards.evaluateWards([invalidPatternRule], bashCall('this still-works today'))
  const half2 = wards.evaluateWards([invalidPatternRule], bashCall('this still-works today'))
  check('an invalid pattern stays skipped while valid siblings enforce, stably', half1.allow === false && half2.allow === false && half1.excerpt === 'still-works', `${JSON.stringify([half1, half2])}; compile in src/permissions/wards/wards.ts must skip a pattern that does not compile and keep the valid ones`)

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
    'a pathPattern that does not compile must leave the rule never applying, on the first call and on the cached one (cachedPathRegex in src/permissions/wards/wards.ts)',
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
    'an allowPathPattern that does not compile must be treated as absent, on the first call and on the cached one (cachedPathRegex in src/permissions/wards/wards.ts)',
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
  check('the cached object constructs nothing', cachedCalls === 0, `cachedCalls=${cachedCalls}; the rule object was already compiled, so compile in src/permissions/wards/wards.ts must read it from compiledPatterns`)
  check('a NEW object with identical fields compiles afresh', freshCalls >= 2, `freshCalls=${freshCalls}; the cache in src/permissions/wards/wards.ts must key on the rule object (WeakMap), not on its fields, so a new object compiles its patterns afresh`)
}

globalThis.RegExp = RealRegExp
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
