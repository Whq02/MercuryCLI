#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { commitIdentityLine } = await import('../../src/services/gitGraph/observe.ts')
const root = mkdtempSync(join(tmpdir(), 'builtin-tools-identity-'))
const home = mkdtempSync(join(tmpdir(), 'builtin-tools-identity-home-'))
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
const sh = (args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env })

const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM }
Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' })
try {
  sh(['init', '--quiet', '--initial-branch=main'])
  writeFileSync(join(root, 'a.txt'), 'a\n')
  const none = commitIdentityLine(root)
  check('a repository with no identity gets the line', none !== undefined && none.startsWith('no commit identity here (user.name and user.email unset)'), none)
  check('the line tells the model not to invent one and names the operator road', none !== undefined && none.includes('do not invent one') && none.includes('git config'), none)
  sh(['config', 'user.name', 'proof'])
  const half = commitIdentityLine(root)
  check('a half identity names the missing half', half !== undefined && half.includes('(user.email unset)'), half)
  sh(['config', 'user.email', 'proof@local'])
  check('a full identity gets no line', commitIdentityLine(root) === undefined, commitIdentityLine(root))
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
