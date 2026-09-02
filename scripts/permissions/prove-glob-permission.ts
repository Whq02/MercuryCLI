#!/usr/bin/env bun
// ============================================================================
//  scripts/permissions/prove-glob-permission.ts
//  PROOF for: GlobTool.getPath() ignored `pattern`, so the read-permission
//  check keyed off cwd while glob() redirected the actual ripgrep --files search
//  to an ABSOLUTE pattern's base dir → filename enumeration OUTSIDE the
//  permission-checked working dir. The fix makes getPath derive the search root
//  the SAME way glob() does (extractGlobBaseDirectory for absolute patterns), so
//  the permission-checked path == the searched root.
//
//  GlobTool.ts/glob.ts are unloadable under bun-run (the import graph pulls the
//  voice feature() bun:bundle macro + color-diff-napi), so this locks the wiring
//  by source-text + mirrors the (pure) base-dir derivation.
//
//  Run: ~/.bun/bin/bun run scripts/permissions/prove-glob-permission.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join, isAbsolute, dirname, basename, sep } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const globTool = readFileSync(join(ROOT, 'src', 'tools', 'GlobTool', 'GlobTool.ts'), 'utf-8')
const globUtil = readFileSync(join(ROOT, 'src', 'utils', 'glob.ts'), 'utf-8')

console.log('============================================================')
console.log(' glob permission — getPath keys off the real search root (HB-0102)')
console.log('============================================================')

section('source: getPath derives the root from the pattern, mirroring glob()')
check('getPath now takes `pattern` (not just `path`)', /getPath\(\{ path, pattern \}\)/.test(globTool))
check('getPath derives an absolute pattern’s base dir via extractGlobBaseDirectory', /isAbsolute\(pattern\)[\s\S]{0,120}extractGlobBaseDirectory\(pattern\)/.test(globTool))
check('getPath imports the SAME helper glob() uses', /import \{ glob, extractGlobBaseDirectory \} from/.test(globTool))
check('glob() ALSO uses extractGlobBaseDirectory for absolute patterns (consistency)', /if \(isAbsolute\(filePattern\)\)[\s\S]{0,160}extractGlobBaseDirectory\(filePattern\)/.test(globUtil))

section('behavioural mirror: an absolute pattern resolves to its base dir (escapes cwd)')
// Mirror of extractGlobBaseDirectory (utils/glob.ts) — pure prefix extraction.
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
check('/etc/**/*.conf → /etc (outside cwd → permission check now sees /etc)', getPathRoot('/etc/**/*.conf') === '/etc')
check('/var/log/*.log → /var/log', getPathRoot('/var/log/*.log') === '/var/log')
check('/secret.txt (absolute literal) → / (root, outside cwd)', getPathRoot('/secret.txt') === '/')
check('relative src/**/*.ts → stays cwd (in-root, unchanged)', getPathRoot('src/**/*.ts') === '/home/u/proj')
check('bare **/*.ts → stays cwd', getPathRoot('**/*.ts') === '/home/u/proj')

// ── (WP-1) — win32 deny rules survive normalization ────────────
// LIVE: filesystem.ts loads under bun-run; getPlatform is lodash-memoized,
// so the win32 arm is driven through the REAL platform seam by priming the
// memoize cache (production condition, not a mock parser). The kickoff
// defect: posix ops on native backslash paths returned null and settings
// DENY RULES were silently dropped — Grep/Glob/Read printed denied files.
section('WP-1: win32 deny-rule normalization (live, platform-seam primed)')
{
  const fsMod = await import(join(ROOT, 'src', 'utils', 'permissions', 'filesystem.ts'))
  const platMod = await import(join(ROOT, 'src', 'utils', 'platform.ts'))
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
    )
    check(
      'child-root rule normalizes under the reference root',
      run('C:\\Users\\me\\proj\\sub', ['*.env'], 'C:\\Users\\me\\proj').includes('/sub/*.env'),
    )
    check(
      'case-variant spelling still matches (win32 path equivalence)',
      run('c:\\users\\ME\\proj', ['secrets/**'], 'C:\\Users\\me\\proj').includes('/secrets/**'),
    )
    check(
      'outside-root pattern stays skipped (no over-application)',
      run('D:\\Elsewhere', ['x/**'], 'C:\\Users\\me\\proj').length === 0,
    )
    check(
      'forward-slash win32 spelling equivalent to backslash',
      run('C:/Users/me/proj', ['secrets/**'], 'C:\\Users\\me\\proj').includes('/secrets/**'),
    )
  } finally {
    if (hadReal) cache.set(undefined, realValue)
    else cache.delete(undefined)
  }
  // POSIX regression rows — behavior unchanged where it was already correct.
  const posixOut = fsMod.normalizePatternsToPath(
    new Map([['/home/u/proj', ['secrets/**']], ['/home/u/proj/sub', ['*.env']], ['/etc', ['x/**']]]),
    '/home/u/proj',
  )
  check('posix same-root + child-root unchanged; outside-root skipped', posixOut.includes('/secrets/**') && posixOut.includes('/sub/*.env') && !posixOut.some(p => p.includes('x/**')))
}

// ── (WP-3/7/8/9/10) — win32 path/URI sibling rows ─────────────
section('WP siblings: file-URI construction, argv quoting, win32 tokens')
{
  const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8')
  const mcpClient = read('src/services/mcp/client.ts')
  check('WP-3: MCP roots via pathToFileURL (defective concat template gone)', mcpClient.includes('pathToFileURL(getOriginalCwd()).href') && !mcpClient.includes('`file://${'))
  const browser = read('src/utils/browser.ts')
  check('WP-7: BROWSER argv gets the bare url (no literal quotes)', browser.includes('await execFileNoThrow(browserEnv, [url])') && !browser.includes('[`"${url}"`]'))
  const insights = read('src/commands/insights.ts')
  check('WP-10: insights report link via pathToFileURL', /pathToFileURL\([^)]+\)\.href/.test(insights))
  const teammate = read('src/utils/swarm/teammateInit.ts')
  check("WP-9: team allowed-path absoluteness via isAbsolute, not startsWith('/')", teammate.includes('isAbsolute(allowedPath.path)'))
  // WP-8 live: isPathLikeToken is pure — drive it.
  const { isPathLikeToken } = await import(join(ROOT, 'src', 'utils', 'suggestions', 'directoryCompletion.ts'))
  check('WP-8: drive-letter forms are path-like', isPathLikeToken('C:\\Users\\me') && isPathLikeToken('C:/Users/me') && isPathLikeToken('c:\\'))
  check('WP-8: UNC form is path-like', isPathLikeToken('\\\\server\\share'))
  check('WP-8: POSIX + relative forms unchanged', isPathLikeToken('/etc') && isPathLikeToken('./x') && isPathLikeToken('~/y') && !isPathLikeToken('plainword') && !isPathLikeToken('C:'))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL GLOB-PERMISSION PROOFS PASS')
else console.log(`❌ ${failures} GLOB-PERMISSION PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
