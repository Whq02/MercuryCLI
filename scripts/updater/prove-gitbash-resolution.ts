#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitBashCandidatePaths } from '../../src/utils/windowsPaths.ts'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const GIT_ROOT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'

console.log('── §1 the mingw64 shadow (the bridge-gate red) ──')
{
  const out = gitBashCandidatePaths(['C:\\Program Files\\Git\\mingw64\\bin\\git.exe'])
  check('the sibling probe is derived first', out[0] === 'C:\\Program Files\\Git\\mingw64\\bin\\bash.exe', out[0] ?? '')
  check('the install-root walk recovers bin\\bash.exe', out[1] === GIT_ROOT_BASH, out[1] ?? '')
}

console.log('── §2 every candidate shape derives a real bash location ──')
{
  const shapes: Array<[string, string]> = [
    ['C:\\Program Files\\Git\\cmd\\git.exe', GIT_ROOT_BASH],
    ['C:\\Program Files\\Git\\bin\\git.exe', GIT_ROOT_BASH],
    ['C:\\Program Files\\Git\\usr\\bin\\git.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'],
    ['C:\\Program Files\\Git\\mingw32\\bin\\git.exe', GIT_ROOT_BASH],
  ]
  for (const [git, want] of shapes) {
    const out = gitBashCandidatePaths([git])
    check(`${git.split('\\').slice(-2).join('\\')} reaches a bash`, out.includes(want), want)
  }
}

console.log('── §3 candidate order, dedup, and the classic last resort ──')
{
  const msys = gitBashCandidatePaths([
    'C:\\Program Files\\Git\\mingw64\\bin\\git.exe',
    'C:\\Program Files\\Git\\usr\\bin\\git.exe',
    'C:\\Program Files\\Git\\cmd\\git.exe',
  ])
  check(
    'the full MSYS candidate set reaches the root bash before the fallback',
    msys.indexOf(GIT_ROOT_BASH) >= 0 && msys.indexOf(GIT_ROOT_BASH) < msys.length - 2,
    `at ${msys.indexOf(GIT_ROOT_BASH)} of ${msys.length}`,
  )
  check('duplicates collapse case-insensitively', new Set(msys.map(p => p.toLowerCase())).size === msys.length)
  const empty = gitBashCandidatePaths([])
  check(
    'no candidates ⇒ exactly the two classic install roots',
    empty.length === 2 && empty[0] === GIT_ROOT_BASH && empty[1] === 'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    empty.join(' · '),
  )
}

console.log('── §4 the owner is WIRED through the multi-candidate walk ──')
{
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src/utils/windowsPaths.ts'), 'utf8')
  check(
    'findGitBashPath consumes gitBashCandidatePaths(findExecutableCandidates(…))',
    src.includes("gitBashCandidatePaths(findExecutableCandidates('git'))"),
  )
  check('the single-candidate derivation is gone', !src.includes('const bashPath = pathWin32.join('))
}

console.log(failures === 0 ? '\n✅ GITBASH RESOLUTION PROOF PASS' : `\n❌ GITBASH RESOLUTION PROOF RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
