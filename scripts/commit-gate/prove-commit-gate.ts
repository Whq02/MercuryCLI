// ============================================================================
//  scripts/commit-gate/prove-commit-gate.ts — PROOF: the commit gate is gated on the
//  ACTUAL shell control-flow, not just on the presence of `&&`.
//
//  Regression coverage for: the old gate split on `&&` only, so a
//  verify chained with `&&` followed by a `;`/`||`/`|` before the commit slipped
//  a BARE commit through (the separator runs the commit regardless of whether
//  the verify passed). This asserts evaluateCommitGate() denies every such
//  bypass while still allowing a genuinely `&&`-gated commit — including the
//  legit `setup ; verify && commit` shape (a `;` BEFORE the &&-gated chain is
//  fine; only a break BETWEEN the verify and the commit is a bypass).
//
//  Run:  bun run scripts/commit-gate/prove-commit-gate.ts
// ============================================================================
import { evaluateCommitGate } from '../../src/utils/hooks/commitGate.js'

interface Case {
  cmd: string
  allow: boolean
  why: string
}

const CASES: Case[] = [
  // ── must ALLOW: a real verify &&-chained directly before the commit ──
  { cmd: 'bun run build.ts && git commit -m "x"', allow: true, why: 'canonical verify && commit' },
  { cmd: 'npm test && git commit -am "x"', allow: true, why: 'test && commit' },
  { cmd: 'cd repo && bun run build.ts && git commit -m "x"', allow: true, why: 'cd &&-chained, still gated' },
  { cmd: 'mkdir -p x ; cd x ; bun run build.ts && git commit -m "x"', allow: true, why: '; SETUP then &&-gated chain — NOT a bypass (no false positive)' },
  { cmd: 'false || bun test && git commit -m "x"', allow: true, why: '(false||test)&&commit — commit runs iff test ok' },
  { cmd: 'git commit -m "msg with && and ; and || inside"', allow: false, why: 'operators inside the quoted message must NOT count as a verify/separator (bare commit)' },

  // ── must DENY: bare / unverified ──
  { cmd: 'git commit -m "feat: x"', allow: false, why: 'bare commit' },
  { cmd: 'git add -A && git commit -m "x"', allow: false, why: 'git add is not a verify' },
  { cmd: 'echo build && git commit -m "x"', allow: false, why: 'no-op head echo is not a verify (HB-0099)' },
  { cmd: 'bun run build.ts && git commit --no-verify -m "x"', allow: false, why: '--no-verify denied even when verify-chained' },

  // ── must DENY: the separator bypasses (verify present, but a break op runs the commit regardless) ──
  { cmd: 'bun run build.ts && echo done ; git commit -m "x"', allow: false, why: '; runs the commit even if build failed' },
  { cmd: 'bun run build.ts && false || git commit -m "x"', allow: false, why: '|| runs the commit when (build&&false) fails' },
  { cmd: 'bun test ; git commit -m "x"', allow: false, why: '; — commit runs regardless of the test' },
  { cmd: 'bun test | git commit -m "x"', allow: false, why: '| pipes; commit runs ungated' },
  { cmd: 'bun run build.ts & git commit -m "x"', allow: false, why: '& backgrounds the verify; commit runs immediately' },
  { cmd: 'bun test ; bun run build.ts && false || git commit -m "x"', allow: false, why: 'verify present but commit reached via ||' },

  // ── not our concern: no commit at all ──
  { cmd: 'ls -la', allow: true, why: 'not a commit' },
  { cmd: 'bun run build.ts', allow: true, why: 'verify alone, no commit' },

  // ── item 2: the exit-preserving piped form + vocabulary/splitter fixes ──
  { cmd: 'set -o pipefail && bun test 2>&1 | tail -40 && git commit -m "x"', allow: true, why: 'pipefail preserves the verifier exit — piped tail is gated AND readable' },
  { cmd: 'set -euo pipefail && npm test | tail -20 && git commit -m "x"', allow: true, why: 'combined-flag pipefail form' },
  { cmd: 'bun test 2>&1 | tail -40 && git commit -m "x"', allow: false, why: 'pipe WITHOUT pipefail: tail exit masks a red suite' },
  { cmd: 'set -o pipefail && bun test | tail -3 ; git commit -m "x"', allow: false, why: 'pipefail cannot save a ;-broken chain' },
  { cmd: 'bun test | tail -3 && set -o pipefail && git commit -m "x"', allow: false, why: 'pipefail AFTER the pipeline does not retro-protect it' },
  { cmd: 'npm test 2>&1 && git commit -m "x"', allow: true, why: 'fd-redirect 2>&1 must not split the chain (old splitter false-denied this)' },
  { cmd: 'npm run validate && git commit -m "x"', allow: true, why: 'validate verb is in the shared vocabulary (AVS field shape)' },
  { cmd: 'npm --prefix tools/azgaar-avs run validate && git commit -m "x"', allow: true, why: 'prefix selector + validate (the exact AVS chain)' },
]

let fail = 0
console.log('\n=== PROOF — commit gate honors shell control-flow (HB-0131 regression) ===\n')
for (const c of CASES) {
  const got = evaluateCommitGate(c.cmd).allow
  const ok = got === c.allow
  if (!ok) fail = 1
  const tag = ok ? '[PASS]' : '[FAIL]'
  const exp = c.allow ? 'ALLOW' : 'DENY '
  console.log(`  ${tag} ${exp}  ${JSON.stringify(c.cmd)}`)
  if (!ok) console.log(`         expected ${c.allow ? 'ALLOW' : 'DENY'}, got ${got ? 'ALLOW' : 'DENY'} — ${c.why}`)
}

// ── item 2: the fresh-receipt attestation (pure seam) ──
console.log('\n— fresh-receipt attestation —')
{
  const denyBare = evaluateCommitGate('git commit -m "x"')
  const allowFresh = evaluateCommitGate('git commit -m "x"', { freshReceipt: true })
  const denyNoVerify = evaluateCommitGate('git commit --no-verify -m "x"', { freshReceipt: true })
  const cases: Array<[string, boolean]> = [
    ['bare commit without receipt still DENIED', denyBare.allow === false && denyBare.rule === 'bare-commit'],
    ['bare commit WITH fresh receipt ALLOWED (rule fresh-receipt)', allowFresh.allow === true && allowFresh.rule === 'fresh-receipt'],
    ['--no-verify denied even with a fresh receipt', denyNoVerify.allow === false && denyNoVerify.rule === 'no-verify-flag'],
  ]
  for (const [label, ok] of cases) {
    if (!ok) fail = 1
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`)
  }
}

// ── item 2: CROSS-SHELL exit-preservation of the pipefail form ──
// The gate's grammar claims `set -o pipefail && verify | tail && commit`
// retains the verifier's exit. Prove it on the REAL shells: a failing
// verify must never reach the commit stand-in; a green one must.
console.log('\n— cross-shell pipefail exit-preservation (real subprocess) —')
{
  const { execFileSync } = await import('node:child_process')
  const run = (shell: string, script: string): string => {
    try {
      return execFileSync(shell, ['-c', script], { encoding: 'utf8', timeout: 10_000 }).trim()
    } catch (e) {
      return (e as { stdout?: string }).stdout?.trim() ?? ''
    }
  }
  for (const shell of ['bash', 'zsh']) {
    // Presence probe with ENOENT discrimination (CI 30229876859: ubuntu-24.04
    // runners ship no zsh — execFileSync threw, the red leg then passed
    // VACUOUSLY on empty stdout while the green leg failed). An absent shell
    // is a loud SKIP (the darwin lane covers zsh); a present-but-broken
    // shell still fails the legs below.
    try {
      execFileSync(shell, ['-c', 'exit 0'], { timeout: 10_000 })
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') {
        console.log(`  [SKIP] ${shell}: not installed on this runner — law proven on the shells present`)
        continue
      }
    }
    const red = run(shell, 'set -o pipefail && false | tail -1 && echo COMMIT')
    const green = run(shell, 'set -o pipefail && true | tail -1 && echo COMMIT')
    const redOk = !red.includes('COMMIT')
    const greenOk = green.includes('COMMIT')
    if (!redOk || !greenOk) fail = 1
    console.log(`  [${redOk ? 'PASS' : 'FAIL'}] ${shell}: failing verify | tail never reaches the commit`)
    console.log(`  [${greenOk ? 'PASS' : 'FAIL'}] ${shell}: green verify | tail reaches the commit`)
  }
}

console.log()
if (fail === 0) console.log(`✅ ALL PASS — ${CASES.length} commit-gate control-flow cases + receipt + cross-shell legs`)
else console.log('❌ FAILED — commit-gate control-flow proof')
console.log()
process.exit(fail)
