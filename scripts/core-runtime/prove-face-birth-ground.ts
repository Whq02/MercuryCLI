#!/usr/bin/env bun
// prove-face-birth-ground — FC-071: the Boot face births sessions in the
// SESSION GROUND, never the launch folder. A --worktree boot moves the
// project root into the worktree (setup.ts — "the one place the project
// root moves": setCwd + setOriginalCwd + setProjectRoot) and setCwd is
// bookkeeping, not process.chdir — so every process.cwd() read in the boot
// screens answered the LAUNCH folder: the face offered "New Session in
// <launch folder>", bornSession got the base folder as workspaceDir, and
// project.json recorded the launch folder while the same process's session
// record carried the worktree path. Every other birth site already reads
// the moved ground (main.tsx chat-forward, REPL ctrl+n, the concourse's
// explicit ground) — the two boot screens were the stragglers.
//
//   §1 the class ratchet: ZERO process.cwd() reads in the two boot screens.
//   §2 the births spell the ground (call-shaped).
//   §3 the ground owner is imported where the reads moved.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const ROOT = join(import.meta.dir, '..', '..')
const SCREENS = ['BootSplashScreen.tsx', 'BootResumeScreen.tsx'] as const
const src = new Map(SCREENS.map(name => [name, readFileSync(join(ROOT, 'src', 'components', name), 'utf8')]))

section('§1 THE CLASS RATCHET — no launch-folder reads in the boot screens')
for (const name of SCREENS) {
  const hits = (src.get(name) ?? '').split('\n').flatMap((line, i) => (line.includes('process.cwd()') ? [`${name}:${i + 1}`] : []))
  check(`${name} reads the ground, never process.cwd()`, hits.length === 0, hits.join(', '))
}

section('§2 THE BIRTHS SPELL THE GROUND (call-shaped)')
{
  const splash = src.get('BootSplashScreen.tsx') ?? ''
  const resume = src.get('BootResumeScreen.tsx') ?? ''
  check(
    "the face's New Session births with workspaceDir: getCwd()",
    /bornSession\(\{ workspaceDir: getCwd\(\)/.test(splash),
  )
  check(
    "the resume screen's birth does too",
    /bornSession\(\{ workspaceDir: getCwd\(\)/.test(resume),
  )
}

section('§3 THE GROUND OWNER IS IMPORTED')
for (const name of SCREENS) {
  check(
    `${name} imports getCwd from the cwd owner`,
    /import \{[^}]*getCwd[^}]*\} from '\.\.\/utils\/cwd\.js'/.test(src.get(name) ?? ''),
  )
}

if (failures > 0) {
  console.error(`\nprove-face-birth-ground: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-face-birth-ground: all green')
