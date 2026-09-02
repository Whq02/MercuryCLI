#!/usr/bin/env bun
// ============================================================================
//  prove-glob-preamble — zsh NO_NOMATCH bash-parity in the Bash tool preamble.
//
//  AVS friction audit: the Bash tool runs the login shell — zsh
//  on macOS — where an unmatched glob ABORTS the whole command ("no matches
//  found: .github/workflows/*.yml"), a semantics divergence from the bash
//  conventions the model is trained on for a tool literally named Bash. The
//  fix rides the existing glob-normalization preamble (extglob-off, sourced
//  AFTER user config so it wins) with NO_NOMATCH on the zsh legs.
//
//  This proof runs the REAL getGlobPreambleCommand() output through real
//  /bin/zsh and /bin/bash — including the CONTROL leg (zsh WITHOUT the
//  preamble must fail, otherwise the pass is vacuous) — and pins the bash
//  branch byte-identical (bash needs no NOMATCH normalization).
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { getGlobPreambleCommand } from '../../src/utils/shell/globPreamble.js'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const UNMATCHED = `/tmp/__no_such_dir_${process.pid}/*.yml`
const run = (shell: string, cmd: string) =>
  spawnSync(shell, ['-c', cmd], { encoding: 'utf8' })

const hadPrefix = process.env.MERCURY_SHELL_PREFIX
delete process.env.MERCURY_SHELL_PREFIX

console.log('— the branch strings —')
const zshPre = getGlobPreambleCommand('/bin/zsh')
const bashPre = getGlobPreambleCommand('/bin/bash')
t(
  'zsh branch carries NO_NOMATCH and keeps NO_EXTENDED_GLOB (security invariant)',
  zshPre === 'setopt NO_EXTENDED_GLOB NO_NOMATCH 2>/dev/null || true',
  String(zshPre),
)
t(
  'bash branch BYTE-IDENTICAL (bash needs no NOMATCH normalization)',
  bashPre === 'shopt -u extglob 2>/dev/null || true',
  String(bashPre),
)
t('unknown shell → null', getGlobPreambleCommand('/bin/fish') === null)

process.env.MERCURY_SHELL_PREFIX = 'env'
const prefixPre = getGlobPreambleCommand('/bin/zsh')
delete process.env.MERCURY_SHELL_PREFIX
t(
  'shell-prefix both-shells leg carries NO_NOMATCH on the setopt (zsh-only) side',
  prefixPre ===
    '{ shopt -u extglob || setopt NO_EXTENDED_GLOB NO_NOMATCH; } >/dev/null 2>&1 || true',
  String(prefixPre),
)

console.log('— behavioral: real shells, real unmatched glob —')
if (existsSync('/bin/zsh')) {
  const control = run('/bin/zsh', `echo ${UNMATCHED}`)
  t(
    'CONTROL: bare zsh hard-fails the unmatched glob (the detector detects)',
    control.status !== 0,
    `status=${control.status}`,
  )
  const fixed = run('/bin/zsh', `${zshPre} && echo ${UNMATCHED}`)
  t(
    'zsh + preamble: unmatched glob passes through literally, exit 0',
    fixed.status === 0 && fixed.stdout.includes('__no_such_dir_'),
    `status=${fixed.status} stderr=${fixed.stderr.trim()}`,
  )
  const both = run('/bin/zsh', `${prefixPre} && echo ${UNMATCHED}`)
  t(
    'zsh + both-shells prefix leg: exit 0, literal pattern',
    both.status === 0 && both.stdout.includes('__no_such_dir_'),
    `status=${both.status}`,
  )
} else {
  t('SKIP zsh behavioral legs — /bin/zsh not present on this machine', true)
}
if (existsSync('/bin/bash')) {
  const b = run('/bin/bash', `${bashPre} && echo ${UNMATCHED}`)
  t(
    'bash + preamble: unchanged bash semantics (literal pattern, exit 0)',
    b.status === 0 && b.stdout.includes('__no_such_dir_'),
    `status=${b.status}`,
  )
  const bboth = run('/bin/bash', `${prefixPre} && echo ${UNMATCHED}`)
  t(
    'bash + both-shells prefix leg: harmless (exit 0, literal pattern)',
    bboth.status === 0 && bboth.stdout.includes('__no_such_dir_'),
    `status=${bboth.status}`,
  )
}

console.log('— wiring: the provider composes THIS preamble —')
const provider = readFileSync('src/utils/shell/bashProvider.ts', 'utf8')
t(
  'bashProvider imports the leaf',
  provider.includes("import { getGlobPreambleCommand } from './globPreamble.js'"),
)
t(
  'buildExecCommand pushes the preamble into the exec command',
  provider.includes('getGlobPreambleCommand(shellPath)'),
)
t(
  'no stale local copy left behind',
  !provider.includes('function getGlobPreambleCommand('),
)

if (hadPrefix !== undefined) process.env.MERCURY_SHELL_PREFIX = hadPrefix
console.log(failures ? '\n❌ GLOB-PREAMBLE RED' : '\n✅ GLOB-PREAMBLE GREEN')
process.exit(failures)
