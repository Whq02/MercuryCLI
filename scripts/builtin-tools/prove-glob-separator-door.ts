#!/usr/bin/env bun
// ============================================================================
//  scripts/builtin-tools/prove-glob-separator-door.ts — a Glob or Grep
//  pattern spelled with Windows separators reaches ripgrep spelled the way
//  ripgrep matches (FN-015 rank 9, [Windows]).
//
//  On Windows ripgrep prints its relative paths with backslashes, so the
//  model's next Glob (`src\**\*.ts`) or Grep glob (`src\utils\*.ts`) was
//  primed with exactly the spelling that matches nothing: the field box
//  measured 2348 files for `src/**/*.ts` and 0 for `src\**\*.ts`. Both
//  tools handed the caller's spelling to the search binary verbatim.
//
//  The law: ONE pattern-intake door (src/utils/globPattern.ts) normalises
//  separators — on win32 every backslash becomes a forward slash (ripgrep's
//  matcher normalises candidate paths to forward slashes, and its glob
//  parser treats no backslash as an escape on Windows); on POSIX the door is
//  a no-op, because there a backslash IS the glob escape (`a\[1\].ts` names
//  the literal file `a[1].ts`).
//
//  §1 the door is pure and table-provable on every platform
//  §2 Glob: the `--glob` value glob() hands ripgrep rides the door (source)
//  §3 Grep: every `--glob` token the Grep tool builds rides the door (pure
//     split + source)
//  §4 LIVE (POSIX host): the no-op keeps escape semantics — an escaped
//     bracket pattern still matches its literal file through ripgrep
//  §5 the Windows live confirmation is FIELD-OWED by name (the call-shaped
//     pin above is what this Mac can prove)
//
//  Run:  ~/.bun/bin/bun run scripts/builtin-tools/prove-glob-separator-door.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' the glob separator door — one intake, both tools, both platforms')
console.log('============================================================')

const ROOT = join(import.meta.dir, '..', '..')
type Door = {
  normalizeGlobPattern: (pattern: string, platform?: NodeJS.Platform) => string
  splitGrepGlobField: (field: string, platform?: NodeJS.Platform) => string[]
}
let door: Door | null = null
try {
  door = (await import('../../src/utils/globPattern.ts')) as Door
} catch (e) {
  console.log(`  (the door module is absent: ${e instanceof Error ? e.message.split('\n')[0] : String(e)})`)
}

// ── §1 the pure door ────────────────────────────────────────────────────────
section('§1 normalizeGlobPattern — win32 rewrites separators, POSIX is a no-op')
check('the door module exists', door !== null)
if (door) {
  const n = door.normalizeGlobPattern
  check("win32: 'src\\**\\*.ts' → 'src/**/*.ts'", n('src\\**\\*.ts', 'win32') === 'src/**/*.ts', n('src\\**\\*.ts', 'win32'))
  check("win32: 'src\\utils\\path.ts' → 'src/utils/path.ts'", n('src\\utils\\path.ts', 'win32') === 'src/utils/path.ts')
  check("win32: a mixed spelling 'src\\utils/*.ts' → 'src/utils/*.ts'", n('src\\utils/*.ts', 'win32') === 'src/utils/*.ts')
  check("win32: an already-forward pattern is unchanged", n('src/**/*.ts', 'win32') === 'src/**/*.ts')
  check("win32: a brace group keeps its braces", n('src\\**\\*.{ts,tsx}', 'win32') === 'src/**/*.{ts,tsx}')
  check("linux: 'src\\**\\*.ts' is untouched (a backslash is the glob escape on POSIX)", n('src\\**\\*.ts', 'linux') === 'src\\**\\*.ts')
  check("darwin: 'a\\[1\\].ts' is untouched", n('a\\[1\\].ts', 'darwin') === 'a\\[1\\].ts')
  check('the platform default is the live process platform', n('x\\y', process.platform) === n('x\\y'))
}

// ── §2 Glob rides the door ──────────────────────────────────────────────────
section('§2 Glob — the --glob value glob() builds rides the door')
{
  const globUtil = readFileSync(join(ROOT, 'src', 'utils', 'glob.ts'), 'utf8')
  check('glob.ts imports the door', /from '\.\/globPattern\.js'/.test(globUtil))
  check("the argument vector's --glob value is the normalised pattern", /'--files',\s*'--glob',\s*normalizeGlobPattern\(pattern\)/.test(globUtil))
  check('no verbatim pattern reaches the vector any more', !/'--glob',\s*pattern,/.test(globUtil))
}

// ── §3 Grep rides the door ──────────────────────────────────────────────────
section('§3 Grep — every --glob token rides the door')
{
  const grepTool = readFileSync(join(ROOT, 'src', 'tools', 'GrepTool', 'GrepTool.ts'), 'utf8')
  check('GrepTool imports the door', /from '\.\.\/\.\.\/utils\/globPattern\.js'/.test(grepTool))
  check('the glob field is split and normalised through splitGrepGlobField', /splitGrepGlobField\(input\.glob\)/.test(grepTool))
  check('no verbatim token/piece push remains', !/args\.push\('--glob', token\)/.test(grepTool) && !/args\.push\('--glob', piece\)/.test(grepTool))
  if (door) {
    const s = door.splitGrepGlobField
    check("win32: 'src\\**\\*.ts' → ['src/**/*.ts']", JSON.stringify(s('src\\**\\*.ts', 'win32')) === JSON.stringify(['src/**/*.ts']), JSON.stringify(s('src\\**\\*.ts', 'win32')))
    check("win32: 'src\\**\\*.ts *.md' splits on whitespace and normalises each", JSON.stringify(s('src\\**\\*.ts *.md', 'win32')) === JSON.stringify(['src/**/*.ts', '*.md']))
    check("win32: 'a\\*.ts,b\\*.ts' splits on commas and normalises each", JSON.stringify(s('a\\*.ts,b\\*.ts', 'win32')) === JSON.stringify(['a/*.ts', 'b/*.ts']))
    check("win32: a brace token 'src\\**\\*.{ts,tsx}' passes whole (no comma split inside braces)", JSON.stringify(s('src\\**\\*.{ts,tsx}', 'win32')) === JSON.stringify(['src/**/*.{ts,tsx}']))
    check("linux: '*.{ts,tsx} *.md,*.txt' keeps the shipped split rules", JSON.stringify(s('*.{ts,tsx} *.md,*.txt', 'linux')) === JSON.stringify(['*.{ts,tsx}', '*.md', '*.txt']))
    check("linux: 'src\\**\\*.ts' is untouched", JSON.stringify(s('src\\**\\*.ts', 'linux')) === JSON.stringify(['src\\**\\*.ts']))
    check('empty and whitespace-only fields yield no tokens', s('', 'win32').length === 0 && s('   ', 'linux').length === 0)
  }
}

// ── §4 LIVE on a POSIX host: the no-op keeps escapes working ────────────────
section('§4 LIVE (POSIX) — the no-op door keeps ripgrep escape semantics')
if (process.platform === 'win32') {
  check('skipped by name: the POSIX escape arm does not apply on win32 (see §5)', true)
} else if (!door) {
  check('the live arm needs the door', false, 'door absent')
} else {
  const fixture = mkdtempSync(join(tmpdir(), 'prove-glob-separator-door-'))
  mkdirSync(join(fixture, 'sub'))
  writeFileSync(join(fixture, 'a[1].ts'), '')
  writeFileSync(join(fixture, 'a1.ts'), '')
  writeFileSync(join(fixture, 'sub', 'c.ts'), '')
  try {
    const { ripGrep } = await import('../../src/utils/ripgrep.ts')
    const escaped = door.normalizeGlobPattern('a\\[1\\].ts')
    const hits = await ripGrep(['--files', '--glob', escaped], fixture, new AbortController().signal)
    check("'a\\[1\\].ts' still names the literal file a[1].ts (escape kept)", hits.length === 1 && /a\[1\]\.ts$/.test(hits[0] ?? ''), JSON.stringify(hits))
    // ripgrep anchors a slash-bearing glob at ITS working directory, not at
    // the root argument — the wrapper passes no cwd — so the live spelling
    // is the unanchored one; the door's no-op is the fact under test.
    const deep = await ripGrep(['--files', '--glob', door.normalizeGlobPattern('**/sub/**/*.ts')], fixture, new AbortController().signal)
    check("'**/sub/**/*.ts' finds sub/c.ts through the door", deep.length === 1 && /sub\/c\.ts$/.test(deep[0] ?? ''), JSON.stringify(deep))
  } catch (e) {
    check('the live ripgrep arm ran', false, e instanceof Error ? e.message.split('\n')[0] : String(e))
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

// ── §5 the Windows confirmation is owed to the field ────────────────────────
section('§5 FIELD-OWED — the win32 live confirmation')
check("owed by name: on the Windows box, Glob 'src\\**\\*.ts' and Grep glob 'src\\utils\\*.ts' must return files (the door is call-shaped here)", true)

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-glob-separator-door${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
