#!/usr/bin/env bun
import { mkdtempSync, realpathSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')


console.log('§2 the engine, driven')
{
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const candidates = [
    join(ROOT, 'node_modules', '@vscode', `ripgrep-${process.platform}-${process.arch}`, 'bin', exe),
    join(ROOT, 'node_modules', '@vscode', 'ripgrep', 'bin', exe),
  ]
  const rg = candidates.find(c => existsSync(c)) ?? 'rg'
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'glob-sort-')))
  const stamp = (name: string, secondsAgo: number): void => {
    const p = join(dir, name)
    writeFileSync(p, name)
    const t = (Date.now() - secondsAgo * 1000) / 1000
    utimesSync(p, t, t)
  }
  stamp('old.txt', 3000)
  stamp('mid.txt', 2000)
  stamp('new.txt', 1000)
  const run = (flag: string): string[] =>
    (spawnSync(rg, ['--files', '--glob', '*.txt', flag], { cwd: dir, encoding: 'utf8' }).stdout ?? '')
      .trim()
      .split('\n')
  const descending = run('--sortr=modified')
  check(
    '--sortr=modified answers newest first (the promise kept)',
    descending[0] === 'new.txt' && descending[2] === 'old.txt',
    descending.join(','),
    'this drives the rg binary found under node_modules/@vscode or on PATH, not Mercury code; if it fails the installed ripgrep no longer sorts --sortr=modified newest first, so reinstall ripgrep or change the flag glob() in src/tools/glob/glob.ts passes',
  )
  const ascending = run('--sort=modified')
  check(
    "bare --sort=modified is ascending — the defect's mechanism (control)",
    ascending[0] === 'old.txt' && ascending[2] === 'new.txt',
    ascending.join(','),
    'the control expects bare --sort=modified to list oldest first; if rg now sorts it newest first, the --sortr=modified flag in glob() in src/tools/glob/glob.ts may no longer be needed, so recheck the direction of both flags',
  )
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-glob-sort-direction: all green' : `\nprove-glob-sort-direction: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
