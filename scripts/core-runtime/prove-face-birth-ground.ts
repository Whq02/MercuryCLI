#!/usr/bin/env bun
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
