#!/usr/bin/env bun
// ============================================================================
//  prove-verification-state — the mutation→verification evidence model
//  (Sol 5.6 WS5). The advisory's E2E ladder, each leg on the REAL module:
//
//   (1) edit → stale: a successful first-party mutation invalidates prior
//       green evidence (order matters, not just presence).
//   (2) an UNRELATED command records nothing (ls after the edit ≠ verified).
//   (3) a targeted suite → verified with the suite's own coverage words
//       (partial verification is labeled, never inflated to full).
//   (4) a failing verification → failed (a run is not a pass).
//   (5) a subsequent edit → stale again.
//   (6) the full gate → verified with full-gate coverage.
//   (7) RESTART honesty: a fresh process reads the digest-bound persisted
//       evidence — same tree ⇒ verified; a tree change ⇒ stale (proven in a
//       scratch git repo so the digest is real).
//   (8) the executed-path discriminator: pre-execution refusals (no
//       durationMs analog — killed/denied) never mark mutations or record
//       evidence (observeCompletedToolCall is only fed executed calls; here:
//       a FAILED Edit does not advance the mutation seq).
//   (9) classifyVerificationCommand matrix (the deterministic detector).
//
//  Run:  ~/.bun/bin/bun run scripts/verify/prove-verification-state.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const REPO = join(new URL('.', import.meta.url).pathname, '../..')
const BUN = process.env.BUN ?? join(homedir(), '.bun/bin/bun')

const vs = await import('../../src/utils/verification/verificationState.js')
const scratch = mkdtempSync(join(tmpdir(), 'verify-state-'))
const cwd = join(scratch, 'proj')
mkdirSync(cwd, { recursive: true })

console.log('============================================================')
console.log(' verification evidence — order · outcome · coverage · restart')
console.log('============================================================')

vs._resetVerificationStateForTesting()

// (baseline) nothing yet
check('fresh state reads unverified', vs.verificationSummary(cwd).state === 'unverified')

// (6-first) full gate green → verified
vs.observeCompletedToolCall('Bash', { command: 'bash scripts/run-all-suites.sh' }, true, cwd)
{
  const s = vs.verificationSummary(cwd, { skipDigest: true })
  check('full gate green → verified', s.state === 'verified', s.detail)
  check('coverage says full gate', /full gate/.test(s.detail))
}

// (1) edit → stale
vs.observeCompletedToolCall('Edit', { file_path: 'src/x.ts' }, true, cwd)
{
  const s = vs.verificationSummary(cwd, { skipDigest: true })
  check('edit AFTER green evidence → stale', s.state === 'stale', s.detail)
  check('detail counts the mutation', /1 mutation/.test(s.detail))
}

// (2) unrelated command records nothing
vs.observeCompletedToolCall('Bash', { command: 'ls -la && git status' }, true, cwd)
{
  const s = vs.verificationSummary(cwd, { skipDigest: true })
  check('unrelated command does NOT verify (still stale)', s.state === 'stale')
}

// (3) targeted suite → verified with partial coverage words
vs.observeCompletedToolCall('Bash', { command: 'bash scripts/lsp/run-all.sh' }, true, cwd)
{
  const s = vs.verificationSummary(cwd, { skipDigest: true })
  check('targeted suite after the edit → verified', s.state === 'verified', s.detail)
  check('coverage names the SUITE, not the gate', /scripts\/lsp suite/.test(s.detail) && !/full gate/.test(s.detail))
}

// (4) failing verification → failed
vs.observeCompletedToolCall('Edit', { file_path: 'src/y.ts' }, true, cwd)
vs.observeCompletedToolCall('Bash', { command: 'bash scripts/typecheck/run-all.sh' }, false, cwd)
{
  const s = vs.verificationSummary(cwd, { skipDigest: true })
  check('failing check → failed (a run is not a pass)', s.state === 'failed', s.detail)
  check('detail says FAILED + what', /FAILED/.test(s.detail) && /typecheck/.test(s.detail))
}

// green again, then (5) edit → stale again
vs.observeCompletedToolCall('Bash', { command: 'bash scripts/typecheck/run-all.sh' }, true, cwd)
check('re-run green → verified again', vs.verificationSummary(cwd, { skipDigest: true }).state === 'verified')
vs.observeCompletedToolCall('Edit', { file_path: 'src/z.ts' }, true, cwd)
check('subsequent edit → stale again', vs.verificationSummary(cwd, { skipDigest: true }).state === 'stale')

// (8) executed-path honesty: a FAILED mutation never advances the seq
{
  const before = vs.verificationSummary(cwd, { skipDigest: true }).mutationsSinceEvidence
  vs.observeCompletedToolCall('Edit', { file_path: 'src/failed.ts' }, false, cwd)
  const after = vs.verificationSummary(cwd, { skipDigest: true }).mutationsSinceEvidence
  check('a failed Edit does not mark a mutation', before === after)
  // LSP emits TYPED EFFECTS — its apply:true INPUT no longer marks
  // anything at the legacy classifier (a failed/no-op apply must not advance
  // the sequence; mutation truth is the effect's actual changedPaths, proven
  // end-to-end in scripts/lsp/prove-ide-transaction.ts).
  vs.observeCompletedToolCall('LSP', { operation: 'rename', apply: true }, true, cwd)
  const applied = vs.verificationSummary(cwd, { skipDigest: true }).mutationsSinceEvidence
  check('an LSP apply INPUT no longer marks a mutation (effects own it)', applied === after)
  check('an LSP read op is not a mutation', vs.isMutationToolCall('LSP', { operation: 'hover' }) === false)
}

// (9) classifier matrix
{
  const c = vs.classifyVerificationCommand
  check('full gate classified', c('bash scripts/run-all-suites.sh')?.scope === 'full-gate')
  check('gate SUBSET classified as suite-scope', c('bash scripts/run-all-suites.sh scribe ui')?.scope === 'suite')
  check('typecheck classified', c('bash scripts/typecheck/run-all.sh')?.scope === 'typecheck')
  check('domain suite classified with name', c('bash scripts/crew/run-all.sh')?.coverage === 'scripts/crew suite')
  check('single proof classified', c('~/.bun/bin/bun run scripts/lsp/prove-lsp-contract.ts')?.scope === 'proof')
  check('build classified', c('bun run build.ts')?.scope === 'build')
  check('verify:fast classified', c('bun run verify:fast')?.scope === 'fast')
  check('plain ls is NOT verification', c('ls -la') === null)
  check('grep is NOT verification', c('rg -n "foo" src') === null)
}

// (10) the ONE verification vocabulary: generic project families mint,
// exit-masked/quoted/no-op shapes never do. The guarded
// split-recognizer defect: `npm run validate` + `npm test` green
// minting NOTHING here while the commit gate's own list accepts them — the
// stop gate demanding read-back "no verification machinery" over green suites.
console.log('\n— the shared vocabulary (generic families + exit-propagation) —')
{
  const c = vs.classifyVerificationCommand
  check('npm test mints (scope test)', c('npm test')?.scope === 'test')
  check('npm run validate mints (scope check)', c('npm run validate')?.scope === 'check')
  check('the exact AVS chain mints: npm --prefix … run validate', c('npm --prefix tools/azgaar-avs run validate')?.scope === 'check')
  check('yarn test mints', c('yarn test')?.scope === 'test')
  check('pnpm -C app test mints', c('pnpm -C app test')?.scope === 'test')
  check('make check mints', c('make check')?.scope === 'check')
  check('cargo test mints', c('cargo test')?.scope === 'test')
  check('pytest mints', c('pytest -q')?.scope === 'test')
  check('npm run lint mints (scope lint)', c('npm run lint')?.scope === 'lint')
  check('cd app && npm test mints (last segment)', c('cd app && npm test')?.scope === 'test')
  check('npm test 2>&1 mints (fd-redirect never splits)', c('npm test 2>&1')?.scope === 'test')
  check('npm test && git push mints (&&-to-end: failure propagates)', c('npm test && git push')?.scope === 'test')
  check('a QUOTED verify word never mints: git commit -m "npm test fixed"', c('git commit -m "npm test fixed"') === null)
  // Wave refute pass (mint soundness — every row must be TRUE):
  check('REACHABILITY: [ -d node_modules ] || npm ci never mints (skipped on success)', c('[ -d node_modules ] || npm ci') === null)
  check('REACHABILITY: grep -q done .status || npm test never mints', c('grep -q done .status || npm test') === null)
  check('TREE BINDING: npm test && sed -i s/a/b/ f.ts never mints (post-suite mutation)', c("npm test && sed -i 's/a/b/' f.ts") === null)
  check('…but the chained-commit idiom still mints: npm test && git add -A && git commit', c('npm test && git add -A && git commit -m "x"')?.scope === 'test')
  check('CWD BINDING: cd /elsewhere && npm test never mints (foreign tree)', c('cd /elsewhere && npm test') === null)
  check('…while a relative cd mints: cd app && npm test', c('cd app && npm test')?.scope === 'test')
  check('bash &> redirect never splits the chain: npm test &> log mints', c('npm test &> log')?.scope === 'test')
  check('foreign runners mint: ./gradlew check', c('./gradlew check')?.scope === 'check')
  check('foreign runners mint: mvn -B verify', c('mvn -B verify')?.scope === 'check')
  check('foreign runners mint: dotnet test', c('dotnet test')?.scope === 'test')
  check('a no-op head never mints: echo npm test', c('echo npm test') === null)
  check('an exit-masked pipe never mints: npm test | tee log', c('npm test | tee log') === null)
  check('pipefail restores the piped mint: set -o pipefail && npm test | tee log', c('set -o pipefail && npm test | tee log')?.scope === 'test')
  check('a ;-masked verify never mints: npm test ; ls', c('npm test ; ls') === null)
}

// (11) the typed demand/gate contract store:
// demandedReadBackPaths = unpaid read-back debt WHERE read-back is the
// evidence class (non-verifiable workspace only) — the ONE set the
// tool-efficiency gate consults so the stop gate's demand is satisfiable.
console.log('\n— demandedReadBackPaths (the item-1 contract store) —')
{
  const { resolve } = await import('node:path')
  vs._resetVerificationStateForTesting()
  const docs = join(scratch, 'docs-ws')
  mkdirSync(docs, { recursive: true })
  const changed = join(docs, 'notes.md')
  vs.observeCompletedToolCall('Write', { file_path: changed }, true, docs)
  const demanded = vs.demandedReadBackPaths(docs)
  check('a mutation in a NON-verifiable workspace lists its read-back debt', demanded.has(vs.canonicalEvidencePath(changed)), [...demanded].join(','))
  // A RANGED Read never pays (wave finding 10: a 1-line peek must not attest
  // "changed files read back").
  vs.observeCompletedToolCall('Read', { file_path: changed, offset: 1, limit: 1 }, true, docs)
  check('a RANGED Read does NOT pay the debt', vs.demandedReadBackPaths(docs).size === 1)
  vs.observeCompletedToolCall('Read', { file_path: changed }, true, docs)
  check('the demanded WHOLE-FILE Read pays the debt (set empties)', vs.demandedReadBackPaths(docs).size === 0)
  check('…and mints the read-back evidence row (summary verified)', vs.verificationSummary(docs, { skipDigest: true }).state === 'verified')

  vs._resetVerificationStateForTesting()
  const codeWs = join(scratch, 'code-ws')
  mkdirSync(codeWs, { recursive: true })
  writeFileSync(join(codeWs, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }))
  vs.observeCompletedToolCall('Write', { file_path: join(codeWs, 'a.ts') }, true, codeWs)
  check('a VERIFIABLE workspace exposes NO demanded read-backs (rereads stay discouraged)', vs.demandedReadBackPaths(codeWs).size === 0)
  vs._resetVerificationStateForTesting()
}

// (12) PowerShell observation: Windows verifies mint too.
console.log('\n— PowerShell evidence observation —')
{
  vs._resetVerificationStateForTesting()
  const winWs = join(scratch, 'win-ws')
  mkdirSync(winWs, { recursive: true })
  vs.observeCompletedToolCall('Edit', { file_path: join(winWs, 'a.ts') }, true, winWs)
  vs.observeCompletedToolCall('PowerShell', { command: 'npm test' }, true, winWs)
  check('a PowerShell npm test mints evidence (verified)', vs.verificationSummary(winWs, { skipDigest: true }).state === 'verified')
  vs._resetVerificationStateForTesting()
}

// (7) restart honesty in a REAL scratch git repo (digest-bound)
{
  const repo = join(scratch, 'git-proj')
  mkdirSync(repo, { recursive: true })
  const git = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@x', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@x' } })
  git('git init -q')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git('git add -A && git commit -qm seed')

  const CHILD = `
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const vs = await import('${REPO}/src/utils/verification/verificationState.js')
const mode = process.env.LEG
if (mode === 'record') {
  vs.observeCompletedToolCall('Bash', { command: 'bash scripts/run-all-suites.sh' }, true, '${repo}')
}
console.log('@@' + JSON.stringify(vs.verificationSummary('${repo}')))
`
  writeFileSync(join(scratch, 'restart-child.ts'), CHILD)
  const runChild = (leg: string) => {
    const r = spawnSync(BUN, ['run', join(scratch, 'restart-child.ts')], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, LEG: leg },
    })
    const line = (r.stdout ?? '').split('\n').find(l => l.startsWith('@@'))
    return line ? (JSON.parse(line.slice(2)) as { state: string; detail: string }) : undefined
  }

  const recorded = runChild('record')
  check('process A records digest-bound evidence (verified)', recorded?.state === 'verified', recorded?.detail)
  const restart = runChild('read')
  check('process B (restart, same tree) reads verified from the artifact', restart?.state === 'verified', restart?.detail)
  writeFileSync(join(repo, 'a.txt'), 'two\n')
  const drifted = runChild('read')
  check('process C after a TREE CHANGE reads stale, never silently green', drifted?.state === 'stale', drifted?.detail)
  check('stale detail names the tree change', /tree changed/.test(drifted?.detail ?? ''))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ALL VERIFICATION-STATE CHECKS PASS')
  process.exit(0)
} else {
  console.log(` ❌ ${failures} CHECK(S) FAILED`)
  process.exit(1)
}
