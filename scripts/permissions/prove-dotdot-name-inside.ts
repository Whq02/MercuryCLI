import '../lib/hermetic.ts'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const launchDir = process.cwd()
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'dotdot-name-proj-')))
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(PROJ)

const fsMod = await import('../../src/permissions/rules/filesystem.ts')
const { getPlatform } = await import('../../src/platform/environment/platform.ts')
type Ctx = import('../../src/tools/kit/tool.ts').ToolPermissionContext
type Platform = ReturnType<typeof getPlatform>

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const DOTDOT_ESCAPE_HINT = ' · fix relativePathEscapes in src/permissions/rules/filesystem.ts: only .. itself or .. followed by a separator escapes, a name that merely starts with .. stays inside'
const DOTDOT_INSIDE_HINT = ' · fix pathInWorkingPath in src/permissions/rules/filesystem.ts: a ..-led name is inside the working directory, .. and ../x are outside'
const DOTDOT_RULE_HINT = ' · fix matchingRuleForInput or pathMatchesRulePattern in src/permissions/rules/filesystem.ts so a rule reaches a ..-led name inside the working directory and never a path outside it'

const escapes = (fsMod as { relativePathEscapes?: (relative: string, platform?: Platform) => boolean }).relativePathEscapes
const cache = (getPlatform as unknown as { cache: Map<unknown, unknown> }).cache
function onPlatform<T>(platform: Platform, body: () => T): T {
  const had = cache.has(undefined)
  const real = cache.get(undefined)
  cache.set(undefined, platform)
  try {
    return body()
  } finally {
    if (had) cache.set(undefined, real)
    else cache.delete(undefined)
  }
}
const ctx = (behavior: 'allow' | 'deny', rules: string[]): Ctx =>
  ({
    alwaysDenyRules: behavior === 'deny' ? { session: rules } : {},
    alwaysAllowRules: behavior === 'allow' ? { session: rules } : {},
    alwaysAskRules: {},
  }) as unknown as Ctx

section('§1 the one traversal test: `..` itself or `..` followed by a separator')
{
  check('the helper exists on filesystem.ts', typeof escapes === 'function', 'export relativePathEscapes from src/permissions/rules/filesystem.ts')
  const rows: Array<[string, Platform, boolean]> = [
    ['..', 'linux', true],
    ['../x', 'linux', true],
    ['..\\x', 'windows', true],
    ['..\\x', 'linux', false],
    ['..foo', 'linux', false],
    ['..foo', 'windows', false],
    ['...', 'linux', false],
    ['..foo/bar', 'linux', false],
    ['', 'linux', false],
    ['x/..foo', 'linux', false],
  ]
  for (const [relative, platform, expected] of rows) {
    const got = typeof escapes === 'function' ? escapes(relative, platform) : undefined
    check(`${JSON.stringify(relative)} on ${platform} → ${expected ? 'outside' : 'inside'}`, got === expected, `got ${String(got)}` + DOTDOT_ESCAPE_HINT)
  }
  const primed = typeof escapes === 'function' ? onPlatform('windows', () => escapes('..\\x')) : undefined
  check('the platform default reads the live seam (win32 primed: `..\\x` is outside)', primed === true, `got ${String(primed)}` + DOTDOT_ESCAPE_HINT + '; its platform default must read getPlatform() at call time')
}

section('§2 working-directory containment (the tester\'s Write ..foo)')
{
  const inside = (path: string): boolean => fsMod.pathInWorkingPath(path, PROJ)
  check('<cwd>/..foo is inside the working directory', inside(join(PROJ, '..foo')) === true, DOTDOT_INSIDE_HINT)
  check('<cwd>/..hidden/x.txt is inside', inside(join(PROJ, '..hidden', 'x.txt')) === true, DOTDOT_INSIDE_HINT)
  check('<cwd>/... is inside', inside(join(PROJ, '...')) === true, DOTDOT_INSIDE_HINT)
  check('<cwd>/..foo/bar is inside', inside(join(PROJ, '..foo', 'bar')) === true, DOTDOT_INSIDE_HINT)
  check('<cwd>/hello.py is inside (control)', inside(join(PROJ, 'hello.py')) === true, DOTDOT_INSIDE_HINT)
  check('the parent of <cwd> is outside', inside(join(PROJ, '..')) === false, DOTDOT_INSIDE_HINT)
  check('<cwd>/../x is outside', inside(join(PROJ, '..', 'x')) === false, DOTDOT_INSIDE_HINT)
  check('a sibling spelled with a ..-led name component is outside', inside(join(PROJ, '..', '..foo')) === false, DOTDOT_INSIDE_HINT)
  const win = onPlatform('windows', () => ({
    dotdotName: fsMod.pathInWorkingPath('C:\\work\\..foo', 'C:\\work'),
    parent: fsMod.pathInWorkingPath('C:\\work\\..', 'C:\\work'),
    sibling: fsMod.pathInWorkingPath('C:\\work\\..\\x', 'C:\\work'),
    deep: fsMod.pathInWorkingPath('C:\\work\\..foo\\bar.txt', 'C:\\work'),
  }))
  check('win32: C:\\work\\..foo is inside C:\\work', win.dotdotName === true, DOTDOT_INSIDE_HINT)
  check('win32: C:\\work\\..foo\\bar.txt is inside', win.deep === true, DOTDOT_INSIDE_HINT)
  check('win32: C:\\work\\.. is outside', win.parent === false, DOTDOT_INSIDE_HINT)
  check('win32: C:\\work\\..\\x is outside', win.sibling === false, DOTDOT_INSIDE_HINT)
}

section('§3 rule matching: an allow rule and a deny rule both reach a ..-led name')
{
  const target = join(PROJ, '..foo')
  const allow = fsMod.matchingRuleForInput(target, ctx('allow', ['Write(..foo)']), 'edit', 'allow')
  check('Write(..foo) as an allow rule matches <cwd>/..foo', allow !== null, JSON.stringify(allow) + DOTDOT_RULE_HINT)
  const deny = fsMod.matchingRuleForInput(target, ctx('deny', ['Write(..foo)']), 'edit', 'deny')
  check('Write(..foo) as a deny rule matches <cwd>/..foo', deny !== null, JSON.stringify(deny) + DOTDOT_RULE_HINT)
  const globAllow = fsMod.matchingRuleForInput(join(PROJ, '..hidden', 'x.txt'), ctx('allow', ['Write(..hidden/**)']), 'edit', 'allow')
  check('Write(..hidden/**) as an allow rule matches <cwd>/..hidden/x.txt', globAllow !== null, JSON.stringify(globAllow) + DOTDOT_RULE_HINT)
  const outside = fsMod.matchingRuleForInput(join(PROJ, '..', 'x.txt'), ctx('allow', ['Write(**)']), 'edit', 'allow')
  check('a rule rooted at cwd never reaches <cwd>/../x.txt', outside === null, JSON.stringify(outside) + DOTDOT_RULE_HINT)
  check('pathMatchesRulePattern: <cwd>/..foo matches the pattern ..foo', fsMod.pathMatchesRulePattern(target, '..foo') === true, DOTDOT_RULE_HINT)
  check('pathMatchesRulePattern: <cwd>/../x never matches **', fsMod.pathMatchesRulePattern(join(PROJ, '..', 'x'), '**') === false, DOTDOT_RULE_HINT)
}

section('§4 pattern normalisation keeps a ..-led child root')
{
  const kept = fsMod.normalizePatternsToPath(new Map([[join(PROJ, '..foo'), ['*.txt']]]), PROJ)
  check('a child root named ..foo is rewritten under the reference root', kept.includes('/..foo/*.txt'), JSON.stringify(kept) + ' · fix normalizePatternsToPath in src/permissions/rules/filesystem.ts to keep a child root whose name starts with ..')
  const dropped = fsMod.normalizePatternsToPath(new Map([[join(PROJ, '..', 'elsewhere'), ['*.txt']]]), PROJ)
  check('a root outside the reference root is still skipped', dropped.length === 0, JSON.stringify(dropped) + ' · fix normalizePatternsToPath in src/permissions/rules/filesystem.ts to skip a root outside the reference root')
}

process.chdir(launchDir)
rmSync(PROJ, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ALL DOTDOT-NAME PROOFS PASS' : `❌ ${failures} DOTDOT-NAME PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
