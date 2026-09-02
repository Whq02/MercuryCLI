#!/usr/bin/env bun
// ============================================================================
//  scripts/bash/prove-bash-permissions.ts
//  PROOF: the Bash permission & read-only security surface — the richest
//  single-tool security boundary in the harness (sandbox auto-allow, the
//  deny/ask/allow rule engine, the cd+git bare-repo gate, the read-only
//  allowlist). `bun run typecheck` is strict (AGENTS.md) but types never prove
//  behaviour: this suite is the regression guard for these invariants.
//
//  LOADABILITY (see memory/bun-run-proof-loadability): the three owned modules
//  — bashPermissions.ts / readOnlyValidation.ts / bashSecurity.ts — are NOT
//  importable under bare `bun run`: each transitively hits a `feature()` macro
//  from bun:bundle (via src/services/analytics → growthbook), which the bundler
//  rewrites at build but bun-run rejects ("feature() … can only be used directly
//  in an if statement or ternary"). So per the documented rule ("target a
//  loadable module OR prove the shared gate primitive + build/dist-grep — don't
//  fake-assert an unloadable module") this proof has TWO halves:
//
//    1. LIVE: exercise the loadable SHARED PRIMITIVES the owned files delegate to
//       — the rule parser/matcher (utils/permissions/shellRuleMatching.ts) and the
//       read-only flag validator + allowlists (utils/shell/readOnlyCommandValidation.ts).
//       These ARE the load-bearing logic behind "deny survives prefixes",
//       "prefix word-boundary", and "compound rm is not read-only".
//    2. DIST-GREP: the invariants that live only inside the unloadable owned files
//       (the cd+git bare-repo ASK gate, the read-only/sandbox decision reasons) are
//       verified present in the shipped dist/mercury.mjs via durable string literals
//       (the same method as scripts/tools/prove-classifier-failclosed.ts). Skips
//       cleanly if dist isn't built.
//
//  color-diff-napi is stubbed via Bun.plugin + dynamic import so the shared
//  modules' transitive graph resolves (see the substrate snapshot proofs).
// ============================================================================

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

// ── shared rule engine: parse + match (delegated to by bashPermissions) ───────
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
  // The deny rule's reach: `rm *` must match `rm -rf /` (the dangerous case)…
  check('rm * MATCHES "rm -rf /" (the deny would fire)', matchWildcardPattern('rm *', 'rm -rf /'))
  // …but NOT bleed onto a different binary that merely shares the prefix string.
  check('rm * does NOT match "rmdir foo" (word boundary, not a substring)', !matchWildcardPattern('rm *', 'rmdir foo'))
  check('git status does NOT match "git status-x" (exact-ish boundary)', !matchWildcardPattern('git status', 'git statusx'))
}

// ── read-only allowlist core: the "compound rm is not read-only" surface ──────
const ro = await import('../../src/utils/shell/readOnlyCommandValidation.js')

section('read-only allowlist — git read-only subcommands in, git WRITERS out')
{
  const has = (k: string) => Object.prototype.hasOwnProperty.call(ro.GIT_READ_ONLY_COMMANDS, k)
  check('GIT_READ_ONLY_COMMANDS allowlists "git status"', has('git status'))
  check('GIT_READ_ONLY_COMMANDS allowlists "git log"', has('git log'))
  check('GIT_READ_ONLY_COMMANDS allowlists "git diff"', has('git diff'))
  // The write/history-mutating verbs must NOT be on the read-only allowlist — if
  // they were, they'd be auto-allowed as "read-only" with zero prompt.
  check('"git push" is NOT read-only-allowlisted', !has('git push'))
  check('"git commit" is NOT read-only-allowlisted', !has('git commit'))
  check('"git reset" is NOT read-only-allowlisted', !has('git reset'))
  check('EXTERNAL_READONLY_COMMANDS is the docker-read subset (ps/images), not a write verb', ro.EXTERNAL_READONLY_COMMANDS.includes('docker ps') && !ro.EXTERNAL_READONLY_COMMANDS.includes('rm'))
}

section('flag validator — a write flag flips a read-only command to NOT-safe')
{
  const gitLog = ro.GIT_READ_ONLY_COMMANDS['git log']!
  check('validateFlags("git log --oneline") === true (read-only flag passes)', ro.validateFlags(['git', 'log', '--oneline'], 2, gitLog, { commandName: 'git', rawCommand: 'git log --oneline' }) === true)
  // --output=FILE writes to disk: the validator MUST reject it (read-only floor).
  check('validateFlags("git log --output=/tmp/x") === false (write flag rejected)', ro.validateFlags(['git', 'log', '--output=/tmp/x'], 2, gitLog, { commandName: 'git', rawCommand: 'git log --output=/tmp/x' }) === false)
  const gitDiff = ro.GIT_READ_ONLY_COMMANDS['git diff']!
  check('validateFlags("git diff --output=/tmp/x") === false (write flag rejected)', ro.validateFlags(['git', 'diff', '--output=/tmp/x'], 2, gitDiff, { commandName: 'git', rawCommand: 'git diff --output=/tmp/x' }) === false)
}

// ── dist-grep: the invariants that live ONLY in the unloadable owned files ─────
section('dist ships the owned-file decision boundaries (cd+git gate, read-only / sandbox reasons)')
{
  const dist = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
  if (!existsSync(dist)) {
    console.log('  [SKIP] dist/mercury.mjs not built — run `bun run build.ts` to grep-verify the shipped branches')
  } else {
    // Each needle is a string literal that survives minification (identifiers do
    // not — see memory/host-harness-vs-built-binary). Grep -F for the literal.
    const present = (needle: string): boolean =>
      execSync(`grep -F -c ${JSON.stringify(needle)} ${JSON.stringify(dist)} || true`, { encoding: 'utf-8' }).trim() !== '0'
    // The cd+git compound gate (bashPermissions.ts:~2217): `cd /evil && git status`
    // must ASK, because the cwd may be a bare repo with a core.fsmonitor hook (RCE).
    check('cd+git bare-repo ASK gate ships in dist', present('A compound command pairing cd with git needs approval — the cd could land the git call inside a hostile bare repository'))
    // The readOnlyValidation.ts bare-repo git guard (line ~1937).
    check('read-only bare-repo git guard ships in dist', present('This directory has bare-repository structure, so git commands here go through the permission gate'))
    // The read-only auto-allow leaf (bashPermissions.ts:~1159) and the sandbox
    // auto-allow leaf (~1356) — the two "allow without prompt" decision reasons.
    check("read-only auto-allow reason ('Read-only command is allowed') ships in dist", present('Read-only command is allowed'))
    check("sandbox auto-allow reason ('Auto-allowed with sandbox') ships in dist", present('Auto-allowed with sandbox'))
  }
}

// ── prose hygiene: the BashTool prompt source must be plain-ASCII apostrophes ──
// A curly apostrophe (U+2019) crept into the prose at prompt.ts:~362 ("it’s")
// while the rest of the file uses ASCII '. Normalized to U+0027. This guards the
// regression: the file must carry ZERO U+2019. We scan the SOURCE directly (no
// module load — the BashTool prompt graph is one of the unloadable feature()
// chains), so the check is a byte-level read of the shipped source text.
section("prose hygiene — BashTool/prompt.ts uses ASCII apostrophes (no curly U+2019)")
{
  const promptSrc = join(import.meta.dir, '..', '..', 'src', 'tools', 'BashTool', 'prompt.ts')
  const text = readFileSync(promptSrc, 'utf-8')
  // Count U+2019 (RIGHT SINGLE QUOTATION MARK) by codepoint — never a control/curly
  // regex literal in shipped source, but this is a proof script reading text, and we
  // count via codepoint to stay explicit about what's banned.
  let curlyCount = 0
  for (const ch of text) if (ch.codePointAt(0) === 0x2019) curlyCount++
  check('BashTool/prompt.ts contains ZERO curly apostrophes (U+2019)', curlyCount === 0, `count=${curlyCount}`)
  // Positive control: the normalized ASCII prose IS present (so the line wasn't
  // deleted/reflowed away — the fix is the right one, not a vacuous pass).
  check("the normalized ASCII prose (\"it's the stronger path\") is present", text.includes("it's the stronger path"))
  // Negative-arm self-test: a planted curly in a local copy MUST be caught by the
  // same codepoint scan (proves the check actually fires on a regression).
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
