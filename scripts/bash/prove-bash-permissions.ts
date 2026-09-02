#!/usr/bin/env bun

import { plugin } from 'bun'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' Bash permission & read-only security — surface proof')
console.log('============================================================')

const { parsePermissionRule, matchWildcardPattern, permissionRuleExtractPrefix } =
  await import('../../src/utils/permissions/shellRuleMatching.js')

section('rule parser — the deny/ask/allow rule shapes bashPermissions resolves')
{
  const prefix = parsePermissionRule('rm:*')
  check("legacy 'rm:*' parses as a PREFIX rule", prefix.type === 'prefix' && (prefix as { prefix: string }).prefix === 'rm', `=> ${JSON.stringify(prefix)}`)
  const wild = parsePermissionRule('Bash(rm:*)')
  check("wrapped 'Bash(rm:*)' parses as a WILDCARD rule (pattern form)", wild.type === 'wildcard', `=> ${JSON.stringify(wild)}`)
  const exact = parsePermissionRule('npm run build')
  check("bare 'npm run build' parses as an EXACT rule", exact.type === 'exact' && (exact as { command: string }).command === 'npm run build')
  check("permissionRuleExtractPrefix('npm:*') => 'npm'", permissionRuleExtractPrefix('npm:*') === 'npm')
}

section('wildcard matcher — a deny like Bash(rm *) catches rm, with a real word boundary')
{
  check('rm * MATCHES "rm -rf /" (the deny would fire)', matchWildcardPattern('rm *', 'rm -rf /'))
  check('rm * does NOT match "rmdir foo" (word boundary, not a substring)', !matchWildcardPattern('rm *', 'rmdir foo'))
  check('git status does NOT match "git status-x" (exact-ish boundary)', !matchWildcardPattern('git status', 'git statusx'))
}

const ro = await import('../../src/utils/shell/readOnlyCommandValidation.js')

section('read-only allowlist — git read-only subcommands in, git WRITERS out')
{
  const has = (k: string) => Object.prototype.hasOwnProperty.call(ro.GIT_READ_ONLY_COMMANDS, k)
  check('GIT_READ_ONLY_COMMANDS allowlists "git status"', has('git status'))
  check('GIT_READ_ONLY_COMMANDS allowlists "git log"', has('git log'))
  check('GIT_READ_ONLY_COMMANDS allowlists "git diff"', has('git diff'))
  check('"git push" is NOT read-only-allowlisted', !has('git push'))
  check('"git commit" is NOT read-only-allowlisted', !has('git commit'))
  check('"git reset" is NOT read-only-allowlisted', !has('git reset'))
  check('EXTERNAL_READONLY_COMMANDS is the docker-read subset (ps/images), not a write verb', ro.EXTERNAL_READONLY_COMMANDS.includes('docker ps') && !ro.EXTERNAL_READONLY_COMMANDS.includes('rm'))
}

section('flag validator — a write flag flips a read-only command to NOT-safe')
{
  const gitLog = ro.GIT_READ_ONLY_COMMANDS['git log']!
  check('validateFlags("git log --oneline") === true (read-only flag passes)', ro.validateFlags(['git', 'log', '--oneline'], 2, gitLog, { commandName: 'git', rawCommand: 'git log --oneline' }) === true)
  check('validateFlags("git log --output=/tmp/x") === false (write flag rejected)', ro.validateFlags(['git', 'log', '--output=/tmp/x'], 2, gitLog, { commandName: 'git', rawCommand: 'git log --output=/tmp/x' }) === false)
  const gitDiff = ro.GIT_READ_ONLY_COMMANDS['git diff']!
  check('validateFlags("git diff --output=/tmp/x") === false (write flag rejected)', ro.validateFlags(['git', 'diff', '--output=/tmp/x'], 2, gitDiff, { commandName: 'git', rawCommand: 'git diff --output=/tmp/x' }) === false)
}

section('dist ships the owned-file decision boundaries (cd+git gate, read-only / sandbox reasons)')
{
  const dist = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
  if (!existsSync(dist)) {
    console.log('  [SKIP] dist/mercury.mjs not built — run `bun run build.ts` to grep-verify the shipped branches')
  } else {
    const present = (needle: string): boolean =>
      execSync(`grep -F -c ${JSON.stringify(needle)} ${JSON.stringify(dist)} || true`, { encoding: 'utf-8' }).trim() !== '0'
    check('cd+git bare-repo ASK gate ships in dist', present('A compound command pairing cd with git needs approval — the cd could land the git call inside a hostile bare repository'))
    check('read-only bare-repo git guard ships in dist', present('This directory has bare-repository structure, so git commands here go through the permission gate'))
    check("read-only auto-allow reason ('Read-only command is allowed') ships in dist", present('Read-only command is allowed'))
    check("sandbox auto-allow reason ('Auto-allowed with sandbox') ships in dist", present('Auto-allowed with sandbox'))
  }
}

section("prose hygiene — BashTool/prompt.ts uses ASCII apostrophes (no curly U+2019)")
{
  const promptSrc = join(import.meta.dir, '..', '..', 'src', 'tools', 'BashTool', 'prompt.ts')
  const text = readFileSync(promptSrc, 'utf-8')
  let curlyCount = 0
  for (const ch of text) if (ch.codePointAt(0) === 0x2019) curlyCount++
  check('BashTool/prompt.ts contains ZERO curly apostrophes (U+2019)', curlyCount === 0, `count=${curlyCount}`)
  check("the normalized ASCII prose (\"it's the stronger path\") is present", text.includes("it's the stronger path"))
  const planted = text.replace("it's the stronger", 'it’s the stronger')
  let plantedCurly = 0
  for (const ch of planted) if (ch.codePointAt(0) === 0x2019) plantedCurly++
  check('planted-bad arm: a re-introduced U+2019 IS detected by the scan', plantedCurly === 1, `plantedCount=${plantedCurly}`)
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ALL BASH PERMISSION/SECURITY PROOFS PASS')
} else {
  console.log(` ❌ ${failures} BASH PERMISSION/SECURITY CHECK(S) FAILED`)
}
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
