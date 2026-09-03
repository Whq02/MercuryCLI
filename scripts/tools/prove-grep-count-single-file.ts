#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-grep-count-single-file.ts — Grep count mode totals a
//  single-FILE target (FC-090). rg -c against one file prints the BARE
//  count (no path:count shape); the directory-shaped parse pushed that line
//  into the body and counted it toward NEITHER total, so the result carried
//  body "3" beside "0 matches across 0 files" and the operator's row was
//  built from the zero.
//
//  §1 the engine mechanism, driven on the vendored rg: one file ⇒ a bare
//     count; a directory ⇒ path:count lines (the two shapes the parse
//     must speak).
//  §2 the parse arm, source-pinned: a bare integer line counts as that
//     file's tally.
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-grep-count-single-file.ts
// ============================================================================
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')

console.log('§1 the engine mechanism')
{
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const candidates = [
    join(ROOT, 'node_modules', '@vscode', `ripgrep-${process.platform}-${process.arch}`, 'bin', exe),
    join(ROOT, 'node_modules', '@vscode', 'ripgrep', 'bin', exe),
  ]
  const rg = candidates.find(c => existsSync(c)) ?? 'rg'
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'grep-count-')))
  writeFileSync(join(dir, 'three.txt'), 'hit\nhit\nhit\n')
  writeFileSync(join(dir, 'one.txt'), 'hit\n')
  const single = (spawnSync(rg, ['-c', 'hit', join(dir, 'three.txt')], { encoding: 'utf8' }).stdout ?? '').trim()
  check('one FILE ⇒ the bare count (no path)', single === '3', JSON.stringify(single))
  // The directory is NAMED and stdin is closed: with no path and a piped
  // stdin (a hosted runner has no TTY) ripgrep searches the empty stdin
  // instead of the cwd and prints nothing.
  const wholeDir = (spawnSync(rg, ['-c', 'hit', dir], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).stdout ?? '').trim().split('\n').sort()
  check(
    'a DIRECTORY ⇒ path:count lines',
    wholeDir.length === 2 && wholeDir.every(l => /:\d+$/.test(l)),
    wholeDir.join(','),
  )
  rmSync(dir, { recursive: true, force: true })
}

console.log('§2 the parse arm')
{
  const src = readFileSync(join(ROOT, 'src', 'tools', 'GrepTool', 'GrepTool.ts'), 'utf8')
  check(
    "a bare integer line counts as that file's tally (call-shaped)",
    /if \(\/\^\\d\+\$\/\.test\(line\)\) \{\s*\n\s*numMatches \+= parseInt\(line, 10\)\s*\n\s*numFiles\+\+/.test(src),
  )
}

console.log(failures === 0 ? '\nprove-grep-count-single-file: all green' : `\nprove-grep-count-single-file: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
