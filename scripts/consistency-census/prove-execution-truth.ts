#!/usr/bin/env bun
// ============================================================================
//  scripts/consistency-census/prove-execution-truth.ts — W6 (UN-43/44/46):
//  typed fixed-tool execution + execution-profile refusal.
//
//  §A TYPED RESULTS (L17) — runGit keeps every failure mode distinct:
//     ok / nonzero / unavailable / (timeout) — and a valid empty answer is
//     an OK with empty stdout, never conflated with failure.
//  §B ARGV REVISIONS (L16) — `${sha}^{tree}` rides as ONE argv element and
//     resolves; fast.ts carries no string-shell git helper anymore, and its
//     anchor misses land in a ledger the plan PRINTS ("anchors failed to
//     resolve" ≠ "no anchor exists" — the F1 discrimination).
//  §C PROFILE MATRIX (L18) — posix/windows/hosted/packaged arms resolve from
//     injected facts; the Windows-source refusal names the hosted dispatch.
//  §D REFUSE-BEFORE-SPAWN (L21) — both fast.ts pool-spawn sites gate on the
//     profile BEFORE spawnSync, so a refusal leaves zero descendants by
//     construction (the source-order pin), and the refusal exits distinct
//     (3), never a half-run verdict.
// ============================================================================
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit, gitOutOrNull } from '../lib/git.ts'
import { fullPoolSupport, resolveExecutionProfile } from '../lib/executionProfile.ts'

const ROOT = join(import.meta.dir, '..', '..')
let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

// §A — typed results on a real fixture repo
const repo = mkdtempSync(join(tmpdir(), 'unison-w6-repo-'))
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
execFileSync('git', ['-c', 'user.email=w6@x', '-c', 'user.name=w6', 'commit', '-q', '--allow-empty', '-m', 'seed'], { cwd: repo })
const ok = runGit(['rev-parse', 'HEAD'], { cwd: repo })
check('§A ok arm carries stdout', ok.state === 'ok' && /^[0-9a-f]{40}$/.test(ok.stdout.trim()))
const nonzero = runGit(['rev-parse', '--verify', 'no-such-rev'], { cwd: repo })
check('§A nonzero arm carries code + stderr (never empty-success)', nonzero.state === 'nonzero' && nonzero.code !== 0 && nonzero.stderr.length > 0)
const unavailable = runGit(['rev-parse', 'HEAD'], { cwd: join(repo, 'no-such-dir') })
check('§A unavailable arm is distinct (spawn failure ⇒ typed, never empty-success)', unavailable.state === 'unavailable', unavailable.state)
const emptyOk = runGit(['status', '--porcelain'], { cwd: repo })
check('§A a valid EMPTY answer is ok+empty, not a failure', emptyOk.state === 'ok' && emptyOk.stdout === '')

// §B — argv revisions + the miss-ledger discrimination
const head = (runGit(['rev-parse', 'HEAD'], { cwd: repo }) as { state: 'ok'; stdout: string }).stdout.trim()
const tree = runGit(['rev-parse', `${head}^{tree}`], { cwd: repo })
check('§B `sha^{tree}` rides as ONE argv element and resolves', tree.state === 'ok' && /^[0-9a-f]{40}$/.test(tree.stdout.trim()))
const misses: string[] = []
const nullOut = gitOutOrNull(['rev-parse', 'not-a-rev^{tree}'], { cwd: repo, onMiss: m => misses.push(m.state) })
check('§B gitOutOrNull records WHY before failing soft (L17)', nullOut === null && misses.length === 1 && misses[0] === 'nonzero')
const fastSrc = readFileSync(join(ROOT, 'scripts/verify/fast.ts'), 'utf8')
check('§B fast.ts carries no string-shell git helper', !fastSrc.includes('execSync') && !/function git\(cmd: string\)/.test(fastSrc))
check('§B fast.ts routes git through the typed owner with a miss ledger', fastSrc.includes('gitOutOrNull(') && fastSrc.includes('anchorMisses'))
check('§B the plan PRINTS the discrimination line', fastSrc.includes('NOT proof that no anchor exists'))
const baselineSrc = readFileSync(join(ROOT, 'scripts/verify/prove-baseline-source.ts'), 'utf8')
check('§B the baseline prover is argv-clean too', !/\bexecSync\(/.test(baselineSrc))

// §C — the profile matrix from injected facts
const posix = resolveExecutionProfile(ROOT, { platform: 'darwin', env: {} })
check('§C posix source checkout resolves', posix.kind === 'source-maintainer-posix')
const win = resolveExecutionProfile(ROOT, { platform: 'win32', env: {} })
check('§C windows source checkout resolves', win.kind === 'source-maintainer-windows')
const hosted = resolveExecutionProfile(ROOT, { platform: 'linux', env: { GITHUB_ACTIONS: 'true' } })
check('§C hosted-gate resolves from the runner fact', hosted.kind === 'hosted-gate')
const nowhere = resolveExecutionProfile(mkdtempSync(join(tmpdir(), 'unison-w6-empty-')), { platform: 'darwin', env: {} })
check('§C a non-maintainer root refuses to impersonate a checkout', nowhere.kind === 'packaged-or-unknown')
check('§C posix + hosted support the pool', fullPoolSupport(posix).supported && fullPoolSupport(hosted).supported)
const refusal = fullPoolSupport(win)
check(
  '§C the Windows-source refusal names the hosted dispatch (L18)',
  !refusal.supported && refusal.remedy.includes('gh workflow run gate.yml'),
)

// §D — refuse-BEFORE-spawn (source-order pin: no bash spawn precedes its gate)
{
  const escalateIdx = fastSrc.indexOf("plan.kind === 'escalate'")
  const escalateGuard = fastSrc.indexOf('fullPoolSupport(resolveExecutionProfile(ROOT))', escalateIdx)
  const escalateSpawn = fastSrc.indexOf("spawnSync('bash', ['scripts/run-all-suites.sh']", escalateIdx)
  check('§D escalation: the profile gate precedes the pool spawn', escalateIdx > 0 && escalateGuard > escalateIdx && escalateGuard < escalateSpawn)
  const subsetGuard = fastSrc.indexOf('fullPoolSupport(resolveExecutionProfile(ROOT))', escalateSpawn)
  const subsetSpawn = fastSrc.indexOf("['scripts/run-all-suites.sh', ...plan.suites]")
  check('§D pooled subset: the same gate precedes ITS spawn', subsetGuard > 0 && subsetSpawn > subsetGuard)
  check('§D the refusal exit is distinct (3 — refusal, not failure)', fastSrc.includes('process.exit(3)'))
}

// §E — verify:fast --plan runs clean end-to-end on this host (the smoke)
{
  const plan = execFileSync(process.execPath, [join(ROOT, 'scripts/verify/fast.ts'), '--plan'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, MERCURY_SLICE_NO_CI: '1' },
  })
  check('§E --plan prints a verdict', plan.includes('plan verdict:'))
}

console.log(failed === 0 ? '\n ✅ EXECUTION TRUTH HOLDS' : `\n ❌ ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
