#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getGlobPreambleCommand } from '../../src/utils/shell/globPreamble.js'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const ROOT = join(import.meta.dir, '..', '..')
const scratch = mkdtempSync(join(tmpdir(), 'shell-split-'))
const bareHome = join(scratch, 'bare-zdotdir')
const unsplitHome = join(scratch, 'unsplit-zdotdir')
const snapshot = join(scratch, 'snapshot.zsh')
mkdirSync(bareHome)
mkdirSync(unsplitHome)
writeFileSync(join(unsplitHome, '.zshenv'), 'unsetopt sh_word_split\nsetopt nomatch extended_glob\n')
writeFileSync(snapshot, 'unalias -a 2>/dev/null || true\nunsetopt sh_word_split\nsetopt nomatch extended_glob\n')

const singleQuoted = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`
const chain = (preamble: string | null, scene: string, before: string[] = []): string =>
  [...before, ...(preamble === null ? [] : [preamble]), `eval ${singleQuoted(scene)} < /dev/null`].join(' && ')
const run = (shell: string, command: string, zdotdir = bareHome) =>
  spawnSync(shell, ['-c', command], { encoding: 'utf8', env: { ...process.env, ZDOTDIR: zdotdir } })
const lines = (out: string): string[] => out.split('\n').filter(line => line !== '')
const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((line, i) => line === b[i])
const show = (r: { status: number | null; stdout: string; stderr: string }): string =>
  `status=${r.status} stdout=${JSON.stringify(r.stdout)}${r.stderr.trim() ? ` stderr=${JSON.stringify(r.stderr.trim())}` : ''}`

const SPLIT = `X="a b c"; printf '%s\\n' $X`
const QUOTED = `X="a b c"; printf '%s\\n' "$X"`
const COUNT = `X="a b c"; set -- $X; echo $#`
const LOOP = `X="a b c"; for p in $X; do echo "[$p]"; done`
const UNMATCHED = `/tmp/__no_such_dir_${process.pid}/*.yml`
const GLOB = `echo ${UNMATCHED}`
const OPTIONS = `for o in sh_word_split nomatch extended_glob glob_subst; do if [[ -o $o ]]; then echo "$o=on"; else echo "$o=off"; fi; done`
const THREE = ['a', 'b', 'c']
const ONE = ['a b c']
const WALKED = ['[a]', '[b]', '[c]']
const LAWS = ['sh_word_split=on', 'nomatch=off', 'extended_glob=off', 'glob_subst=off']

const hadPrefix = process.env.MERCURY_SHELL_PREFIX
delete process.env.MERCURY_SHELL_PREFIX
const zshPre = getGlobPreambleCommand('/bin/zsh')
const bashPre = getGlobPreambleCommand('/bin/bash')
process.env.MERCURY_SHELL_PREFIX = 'env'
const prefixPre = getGlobPreambleCommand('/bin/zsh')
delete process.env.MERCURY_SHELL_PREFIX

console.log('— the legs —')
t('zsh leg carries SH_WORD_SPLIT beside NO_EXTENDED_GLOB and NO_NOMATCH', zshPre !== null && /^setopt NO_EXTENDED_GLOB NO_NOMATCH SH_WORD_SPLIT\b/.test(zshPre), String(zshPre))
t(
  'both-shells leg carries SH_WORD_SPLIT on the setopt side only, its shopt side unchanged',
  prefixPre !== null && prefixPre.startsWith('{ shopt -u extglob || setopt NO_EXTENDED_GLOB NO_NOMATCH SH_WORD_SPLIT; }') && !prefixPre.slice(0, prefixPre.indexOf('||')).includes('SH_WORD_SPLIT'),
  String(prefixPre),
)
t('bash leg byte-identical (bash splits unquoted expansions already)', bashPre === 'shopt -u extglob 2>/dev/null || true', String(bashPre))
t('unknown shell still null', getGlobPreambleCommand('/bin/fish') === null)

if (existsSync('/bin/zsh') && zshPre !== null && prefixPre !== null) {
  console.log('— zsh through the road: the defect, then the preamble —')
  const control = run('/bin/zsh', chain(null, SPLIT))
  t('CONTROL: without the preamble zsh keeps an unquoted "a b c" one word (the defect the road corrects)', same(lines(control.stdout), ONE), show(control))
  const controlCount = run('/bin/zsh', chain(null, COUNT))
  t('CONTROL: without the preamble set -- $X counts 1', same(lines(controlCount.stdout), ['1']), show(controlCount))
  const split = run('/bin/zsh', chain(zshPre, SPLIT))
  t('zsh + preamble: printf over an unquoted $X prints three lines', split.status === 0 && same(lines(split.stdout), THREE), show(split))
  const quoted = run('/bin/zsh', chain(zshPre, QUOTED))
  t('zsh + preamble: the quoted "$X" stays one line', quoted.status === 0 && same(lines(quoted.stdout), ONE), show(quoted))
  const count = run('/bin/zsh', chain(zshPre, COUNT))
  t('zsh + preamble: set -- $X counts 3', count.status === 0 && same(lines(count.stdout), ['3']), show(count))
  const loop = run('/bin/zsh', chain(zshPre, LOOP))
  t('zsh + preamble: for p in $X walks three words', loop.status === 0 && same(lines(loop.stdout), WALKED), show(loop))
  const bothSplit = run('/bin/zsh', chain(prefixPre, SPLIT))
  t('zsh + both-shells leg: three lines', bothSplit.status === 0 && same(lines(bothSplit.stdout), THREE), show(bothSplit))
  const bothQuoted = run('/bin/zsh', chain(prefixPre, QUOTED))
  t('zsh + both-shells leg: the quoted form stays one line', bothQuoted.status === 0 && same(lines(bothQuoted.stdout), ONE), show(bothQuoted))

  console.log('— zsh: the preamble runs after the operator config and wins —')
  const sourced = [`source ${singleQuoted(snapshot)} 2>/dev/null || true`]
  const snapSplit = run('/bin/zsh', chain(zshPre, SPLIT, sourced))
  t('snapshot road: a sourced snapshot that unsets sh_word_split is overridden, three lines', snapSplit.status === 0 && same(lines(snapSplit.stdout), THREE), show(snapSplit))
  const snapLaws = run('/bin/zsh', chain(zshPre, OPTIONS, sourced))
  t('snapshot road: after a snapshot that sets nomatch and extended_glob the four options read the preamble way', same(lines(snapLaws.stdout), LAWS), show(snapLaws))
  const rcSplit = run('/bin/zsh', chain(zshPre, SPLIT), unsplitHome)
  t('rc road: a .zshenv that unsets sh_word_split is overridden, three lines', rcSplit.status === 0 && same(lines(rcSplit.stdout), THREE), show(rcSplit))
  const rcLaws = run('/bin/zsh', chain(zshPre, OPTIONS), unsplitHome)
  t('rc road: after a .zshenv that sets nomatch and extended_glob the four options read the preamble way', same(lines(rcLaws.stdout), LAWS), show(rcLaws))

  console.log('— zsh: the glob laws still hold under the new leg —')
  const bareGlob = run('/bin/zsh', chain(null, GLOB))
  t('CONTROL: bare zsh hard-fails the unmatched glob', bareGlob.status !== 0, show(bareGlob))
  const glob = run('/bin/zsh', chain(zshPre, GLOB))
  t('zsh + preamble: the unmatched glob passes through literally, exit 0', glob.status === 0 && glob.stdout.includes('__no_such_dir_'), show(glob))
  const bothGlob = run('/bin/zsh', chain(prefixPre, GLOB))
  t('zsh + both-shells leg: the unmatched glob passes through literally, exit 0', bothGlob.status === 0 && bothGlob.stdout.includes('__no_such_dir_'), show(bothGlob))
  const laws = run('/bin/zsh', chain(zshPre, OPTIONS))
  t('zsh + preamble: sh_word_split on, nomatch off, extended_glob off, glob_subst off (nothing else changed)', same(lines(laws.stdout), LAWS), show(laws))
  const bothLaws = run('/bin/zsh', chain(prefixPre, OPTIONS))
  t('zsh + both-shells leg: the same four', same(lines(bothLaws.stdout), LAWS), show(bothLaws))
} else {
  t('SKIP zsh legs — /bin/zsh not present on this machine', true)
}

if (existsSync('/bin/bash') && bashPre !== null && prefixPre !== null) {
  console.log('— bash control: unchanged —')
  const split = run('/bin/bash', chain(bashPre, SPLIT))
  t('bash + preamble: three lines', split.status === 0 && same(lines(split.stdout), THREE), show(split))
  const quoted = run('/bin/bash', chain(bashPre, QUOTED))
  t('bash + preamble: the quoted form stays one line', quoted.status === 0 && same(lines(quoted.stdout), ONE), show(quoted))
  const count = run('/bin/bash', chain(bashPre, COUNT))
  t('bash + preamble: set -- $X counts 3', count.status === 0 && same(lines(count.stdout), ['3']), show(count))
  const loop = run('/bin/bash', chain(bashPre, LOOP))
  t('bash + preamble: for p in $X walks three words', loop.status === 0 && same(lines(loop.stdout), WALKED), show(loop))
  const bothSplit = run('/bin/bash', chain(prefixPre, SPLIT))
  t('bash + both-shells leg: three lines', bothSplit.status === 0 && same(lines(bothSplit.stdout), THREE), show(bothSplit))
  const bothQuoted = run('/bin/bash', chain(prefixPre, QUOTED))
  t('bash + both-shells leg: the quoted form stays one line', bothQuoted.status === 0 && same(lines(bothQuoted.stdout), ONE), show(bothQuoted))
  const glob = run('/bin/bash', chain(bashPre, GLOB))
  t('bash + preamble: the unmatched glob passes through literally, exit 0', glob.status === 0 && glob.stdout.includes('__no_such_dir_'), show(glob))
}

console.log('— wiring: both roads source the snapshot before the preamble —')
const provider = readFileSync(join(ROOT, 'src/utils/shell/bashProvider.ts'), 'utf8')
const providerSource = 'parts.push(`source ${quote([snapshot])} 2>/dev/null || true`)'
const providerPreamble = 'if (preamble) parts.push(preamble)'
t(
  'bashProvider pushes the sourced snapshot, then the preamble, into one && chain',
  provider.includes(providerSource) && provider.includes(providerPreamble) && provider.indexOf(providerSource) < provider.indexOf(providerPreamble),
)
const engine = readFileSync(join(ROOT, 'src/utils/shell/engineSession.ts'), 'utf8')
const engineSource = 'seeds.push(`source ${quote([snapshot])} 2>&1 || :`)'
const enginePreamble = 'if (preamble) seeds.push(preamble)'
t(
  'engineSession seeds the sourced snapshot, then the preamble, in one frame',
  engine.includes(engineSource) && engine.includes(enginePreamble) && engine.indexOf(engineSource) < engine.indexOf(enginePreamble),
)

rmSync(scratch, { recursive: true, force: true })
if (hadPrefix !== undefined) process.env.MERCURY_SHELL_PREFIX = hadPrefix
console.log(failures ? '\nSHELL-SPLIT RED' : '\nSHELL-SPLIT GREEN')
process.exit(failures)
