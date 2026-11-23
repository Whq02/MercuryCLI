#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

type Door = {
  normalizeGlobPattern: (pattern: string, platform?: NodeJS.Platform) => string
  splitGrepGlobField: (field: string, platform?: NodeJS.Platform) => string[]
}
const normHint = 'change normalizeGlobPattern in src/tools/glob/globPattern.ts'
const splitHint = 'change splitGrepGlobField in src/tools/glob/globPattern.ts'
let door: Door | null = null
try {
  door = (await import('../../src/tools/glob/globPattern.ts')) as Door
} catch (e) {
  console.log(`  (the door module is absent: ${e instanceof Error ? e.message.split('\n')[0] : String(e)})`)
}

section('§1 normalizeGlobPattern — win32 rewrites separators, POSIX is a no-op')
check('the door module exists', door !== null, 'src/tools/glob/globPattern.ts must exist and export normalizeGlobPattern and splitGrepGlobField')
if (door) {
  const n = door.normalizeGlobPattern
  check("win32: 'src\\**\\*.ts' → 'src/**/*.ts'", n('src\\**\\*.ts', 'win32') === 'src/**/*.ts', `${n('src\\**\\*.ts', 'win32')} | ${normHint}`)
  check("win32: 'src\\utils\\path.ts' → 'src/platform/files/path.ts'", n('src\\utils\\path.ts', 'win32') === 'src/platform/files/path.ts', normHint)
  check("win32: a mixed spelling 'src\\utils/*.ts' → 'src/utils/*.ts'", n('src\\utils/*.ts', 'win32') === 'src/utils/*.ts', normHint)
  check("win32: an already-forward pattern is unchanged", n('src/**/*.ts', 'win32') === 'src/**/*.ts', normHint)
  check("win32: a brace group keeps its braces", n('src\\**\\*.{ts,tsx}', 'win32') === 'src/**/*.{ts,tsx}', normHint)
  check("linux: 'src\\**\\*.ts' is untouched (a backslash is the glob escape on POSIX)", n('src\\**\\*.ts', 'linux') === 'src\\**\\*.ts', normHint)
  check("darwin: 'a\\[1\\].ts' is untouched", n('a\\[1\\].ts', 'darwin') === 'a\\[1\\].ts', normHint)
  check('the platform default is the live process platform', n('x\\y', process.platform) === n('x\\y'), `${normHint} so its platform default is process.platform`)
}


section('§3 Grep — every --glob token rides the door')
{
  if (door) {
    const s = door.splitGrepGlobField
    check("win32: 'src\\**\\*.ts' → ['src/**/*.ts']", JSON.stringify(s('src\\**\\*.ts', 'win32')) === JSON.stringify(['src/**/*.ts']), `${JSON.stringify(s('src\\**\\*.ts', 'win32'))} | ${splitHint}`)
    check("win32: 'src\\**\\*.ts *.md' splits on whitespace and normalises each", JSON.stringify(s('src\\**\\*.ts *.md', 'win32')) === JSON.stringify(['src/**/*.ts', '*.md']), splitHint)
    check("win32: 'a\\*.ts,b\\*.ts' splits on commas and normalises each", JSON.stringify(s('a\\*.ts,b\\*.ts', 'win32')) === JSON.stringify(['a/*.ts', 'b/*.ts']), splitHint)
    check("win32: a brace token 'src\\**\\*.{ts,tsx}' passes whole (no comma split inside braces)", JSON.stringify(s('src\\**\\*.{ts,tsx}', 'win32')) === JSON.stringify(['src/**/*.{ts,tsx}']), splitHint)
    check("linux: '*.{ts,tsx} *.md,*.txt' keeps the shipped split rules", JSON.stringify(s('*.{ts,tsx} *.md,*.txt', 'linux')) === JSON.stringify(['*.{ts,tsx}', '*.md', '*.txt']), splitHint)
    check("linux: 'src\\**\\*.ts' is untouched", JSON.stringify(s('src\\**\\*.ts', 'linux')) === JSON.stringify(['src\\**\\*.ts']), splitHint)
    check('empty and whitespace-only fields yield no tokens', s('', 'win32').length === 0 && s('   ', 'linux').length === 0, splitHint)
  }
}

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
    const { ripGrep } = await import('../../src/platform/shell/ripgrep.ts')
    const escaped = door.normalizeGlobPattern('a\\[1\\].ts')
    const hits = await ripGrep(['--files', '--glob', escaped], fixture, new AbortController().signal)
    check("'a\\[1\\].ts' still names the literal file a[1].ts (escape kept)", hits.length === 1 && /a\[1\]\.ts$/.test(hits[0] ?? ''), `${JSON.stringify(hits)} | ${normHint} so it leaves backslashes alone off win32`)
    const deep = await ripGrep(['--files', '--glob', door.normalizeGlobPattern('**/sub/**/*.ts')], fixture, new AbortController().signal)
    check("'**/sub/**/*.ts' finds sub/c.ts through the door", deep.length === 1 && /sub\/c\.ts$/.test(deep[0] ?? ''), `${JSON.stringify(deep)} | ${normHint}`)
  } catch (e) {
    check('the live ripgrep arm ran', false, e instanceof Error ? e.message.split('\n')[0] : String(e))
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

section('§5 FIELD-OWED — the win32 live confirmation')
check("owed by name: on the Windows box, Glob 'src\\**\\*.ts' and Grep glob 'src\\utils\\*.ts' must return files (the door is call-shaped here)", true)

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-glob-separator-door${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
