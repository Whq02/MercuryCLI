#!/usr/bin/env bun
import { join, isAbsolute, dirname, basename, sep } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')

console.log('============================================================')
console.log(' glob permission — getPath keys off the real search root (HB-0102)')
console.log('============================================================')


section('behavioural mirror: an absolute pattern resolves to its base dir (escapes cwd)')
function baseDirOf(pattern: string): string {
  const m = pattern.match(/[*?[{]/)
  if (!m || m.index === undefined) return dirname(pattern)
  const staticPrefix = pattern.slice(0, m.index)
  const i = Math.max(staticPrefix.lastIndexOf('/'), staticPrefix.lastIndexOf(sep))
  if (i === -1) return ''
  const b = staticPrefix.slice(0, i)
  return b === '' && i === 0 ? '/' : b
}
const getPathRoot = (pattern: string, cwd = '/home/u/proj'): string => {
  if (!isAbsolute(pattern)) return cwd
  const b = baseDirOf(pattern)
  return b || cwd
}
check('/etc/**/*.conf → /etc (outside cwd → permission check now sees /etc)', getPathRoot('/etc/**/*.conf') === '/etc', '', 'this runs the mirror baseDirOf / getPathRoot in this file; keep it in step with getPath in src/tools/glob/GlobTool.ts')
check('/var/log/*.log → /var/log', getPathRoot('/var/log/*.log') === '/var/log', '', 'this runs the mirror baseDirOf / getPathRoot in this file; keep it in step with getPath in src/tools/glob/GlobTool.ts')
check('/secret.txt (absolute literal) → / (root, outside cwd)', getPathRoot('/secret.txt') === '/', '', 'this runs the mirror baseDirOf / getPathRoot in this file; keep it in step with getPath in src/tools/glob/GlobTool.ts')
check('relative src/**/*.ts → stays cwd (in-root, unchanged)', getPathRoot('src/**/*.ts') === '/home/u/proj', '', 'this runs the mirror baseDirOf / getPathRoot in this file; keep it in step with getPath in src/tools/glob/GlobTool.ts')
check('bare **/*.ts → stays cwd', getPathRoot('**/*.ts') === '/home/u/proj', '', 'this runs the mirror baseDirOf / getPathRoot in this file; keep it in step with getPath in src/tools/glob/GlobTool.ts')

section('WP-1: win32 deny-rule normalization (live, platform-seam primed)')
{
  const fsMod = await import(join(ROOT, 'src', 'permissions', 'rules', 'filesystem.ts'))
  const platMod = await import(join(ROOT, 'src', 'platform', 'environment', 'platform.ts'))
  const cache = (platMod.getPlatform as unknown as { cache: Map<unknown, unknown> }).cache
  const hadReal = cache.has(undefined)
  const realValue = cache.get(undefined)
  cache.set(undefined, 'windows')
  try {
    const run = (root: string, patterns: string[], ref: string): string[] =>
      fsMod.normalizePatternsToPath(new Map([[root, patterns]]), ref)
    check(
      'same-root native win32 deny rule SURVIVES (was dropped to null)',
      run('C:\\Users\\me\\proj', ['secrets/**'], 'C:\\Users\\me\\proj').includes('/secrets/**'),
      '',
      'fix normalizePatternsToPath in src/permissions/rules/filesystem.ts so a same-root win32 rule is kept',
    )
    check(
      'child-root rule normalizes under the reference root',
      run('C:\\Users\\me\\proj\\sub', ['*.env'], 'C:\\Users\\me\\proj').includes('/sub/*.env'),
      '',
      'fix normalizePatternsToPath in src/permissions/rules/filesystem.ts so a child-root rule is rewritten under the reference root',
    )
    check(
      'case-variant spelling still matches (win32 path equivalence)',
      run('c:\\users\\ME\\proj', ['secrets/**'], 'C:\\Users\\me\\proj').includes('/secrets/**'),
      '',
      'fix normalizePatternsToPath in src/permissions/rules/filesystem.ts so root comparison ignores case on win32',
    )
    check(
      'outside-root pattern stays skipped (no over-application)',
      run('D:\\Elsewhere', ['x/**'], 'C:\\Users\\me\\proj').length === 0,
      '',
      'fix normalizePatternsToPath in src/permissions/rules/filesystem.ts so a rule rooted outside the reference root is skipped',
    )
    check(
      'forward-slash win32 spelling equivalent to backslash',
      run('C:/Users/me/proj', ['secrets/**'], 'C:\\Users\\me\\proj').includes('/secrets/**'),
      '',
      'fix normalizePatternsToPath in src/permissions/rules/filesystem.ts so forward-slash and backslash win32 roots compare equal',
    )
  } finally {
    if (hadReal) cache.set(undefined, realValue)
    else cache.delete(undefined)
  }
  const posixOut = fsMod.normalizePatternsToPath(
    new Map([['/home/u/proj', ['secrets/**']], ['/home/u/proj/sub', ['*.env']], ['/etc', ['x/**']]]),
    '/home/u/proj',
  )
  check('posix same-root + child-root unchanged; outside-root skipped', posixOut.includes('/secrets/**') && posixOut.includes('/sub/*.env') && !posixOut.some(p => p.includes('x/**')), '', 'fix normalizePatternsToPath in src/permissions/rules/filesystem.ts for posix roots: keep same-root and child-root rules, skip outside-root rules')
}

section('WP siblings: file-URI construction, argv quoting, win32 tokens')
{
  const { isPathLikeToken } = await import(join(ROOT, 'src', 'screen', 'suggestions', 'pathCompletion.ts'))
  check('WP-8: drive-letter forms are path-like', isPathLikeToken('C:\\Users\\me') && isPathLikeToken('C:/Users/me') && isPathLikeToken('c:\\'), '', 'fix isPathLikeToken in src/screen/suggestions/pathCompletion.ts to accept drive-letter paths')
  check('WP-8: UNC form is path-like', isPathLikeToken('\\\\server\\share'), '', 'fix isPathLikeToken in src/screen/suggestions/pathCompletion.ts to accept UNC paths')
  check('WP-8: POSIX + relative forms unchanged', isPathLikeToken('/etc') && isPathLikeToken('./x') && isPathLikeToken('~/y') && !isPathLikeToken('plainword') && !isPathLikeToken('C:'), '', 'fix isPathLikeToken in src/screen/suggestions/pathCompletion.ts: keep POSIX and relative paths accepted, bare words and a bare drive letter rejected')
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL GLOB-PERMISSION PROOFS PASS')
else console.log(`❌ ${failures} GLOB-PERMISSION PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
