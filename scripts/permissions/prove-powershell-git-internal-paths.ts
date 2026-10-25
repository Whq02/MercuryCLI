#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ps-git-internal-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const project = join(scratch, 'Proj')
mkdirSync(join(project, 'src'), { recursive: true })
mkdirSync(join(scratch, 'Other'), { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

const { setCwd } = await import('../../src/utils/Shell.ts')
const { isGitInternalPathPS, isDotGitPathPS } = await import('../../src/tools/PowerShellTool/gitSafety.ts')
setCwd(project)

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log('1. the relative spellings (the control)')
for (const rel of ['HEAD', '.git', '.git/config', '.git\\hooks\\post-checkout', 'objects/ab/cdef', 'refs/heads/main', 'hooks/pre-commit', './HEAD', `../${basename(project)}/HEAD`]) {
  check(`relative ${JSON.stringify(rel)} is git-internal`, isGitInternalPathPS(rel) === true)
}
check('relative src/a.ts is not', isGitInternalPathPS('src/a.ts') === false)

console.log('2. the absolute spellings of the same paths into the session directory read the same')
for (const tail of ['HEAD', '.git', '.git/config', '.git/hooks/post-checkout', 'objects/ab/cdef', 'refs/heads/main', 'hooks/pre-commit']) {
  const abs = join(project, tail)
  check(`absolute ${JSON.stringify(abs)} is git-internal like ${JSON.stringify(tail)}`, isGitInternalPathPS(abs) === isGitInternalPathPS(tail) && isGitInternalPathPS(abs) === true)
}
check('an absolute path with a .. hop that re-enters the session directory is judged after resolution', isGitInternalPathPS(join(project, 'src', '..', 'HEAD')) === true)
check('the strict .git variant agrees on an absolute .git/hooks path', isDotGitPathPS(join(project, '.git', 'hooks', 'post-checkout')) === true && isDotGitPathPS(join(project, 'HEAD')) === false)

console.log('3. what is outside the session directory stays outside, absolute or not')
check('an absolute src file inside the session directory is not git-internal', isGitInternalPathPS(join(project, 'src', 'a.ts')) === false)
check("a sibling project's HEAD is not this project's", isGitInternalPathPS(join(scratch, 'Other', 'HEAD')) === false)
check("a sibling project's .git is not", isGitInternalPathPS(join(scratch, 'Other', '.git', 'config')) === false)
check('a path that merely starts with the session directory as a prefix string is not inside it', isGitInternalPathPS(`${project}2/HEAD`) === false)
check('a different drive stays outside (D:\\Proj\\HEAD on a macOS/Linux session is just a foreign path)', isGitInternalPathPS('D:\\Proj\\HEAD') === false)

console.log(failures === 0 ? '\nPOWERSHELL GIT-INTERNAL PATHS: ALL PASS' : `\nPOWERSHELL GIT-INTERNAL PATHS: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
