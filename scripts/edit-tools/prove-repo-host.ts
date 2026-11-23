#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'anvil-s5-home-'))
process.env.MERCURY_BARE = '1'
delete process.env.MERCURY_REPO_HOST

const {
  fetchPr,
  fetchChecks,
  fetchIssue,
  composeReviewContext,
  recordReview,
  latestReview,
  _resetRepoHostCacheForTesting,
} = await import('../../src/platform/repo-host/repoHost.ts')
const { repoAdapter } = await import('../../src/integrations/resources/adapters/repo.ts')
const { resolveResource } = await import('../../src/integrations/resources/registry.ts')
const { processMainOwner } = await import('../../src/engine/run-owner/resolveOwner.ts')

const owner = processMainOwner()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — repo-host proof exceeded 120s; a git or gh shim call did not return, see the fetch and git helpers in src/platform/repo-host/repoHost.ts')
  process.exit(1)
}, 120_000)
guard.unref?.()

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=anvil', '-c', 'user.email=a@b', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  })
}
const repo = mkdtempSync(join(tmpdir(), 'anvil-s5-repo-'))
git(repo, 'init', '-q', '-b', 'main')
writeFileSync(join(repo, 'feature.js'), 'export function feat() { return 1 }\n')
writeFileSync(join(repo, 'other.js'), 'export const x = 1\n')
git(repo, 'add', '.')
git(repo, 'commit', '-q', '-m', 'init')
writeFileSync(join(repo, 'feature.js'), 'export function feat() { return 2 }\n')

const shimDir = mkdtempSync(join(tmpdir(), 'anvil-s5-shim-'))
const prJson = JSON.stringify({
  number: 7,
  title: 'seeded feature PR',
  state: 'OPEN',
  baseRefName: 'main',
  headRefName: 'feature',
  url: 'https://example.invalid/pr/7',
  body: 'Seeded body.',
  files: [
    { path: 'feature.js', additions: 1, deletions: 1 },
    { path: 'other.js', additions: 0, deletions: 0 },
  ],
})
writeFileSync(
  join(shimDir, 'gh'),
  [
    '#!/usr/bin/env bash',
    'case "$1 $2" in',
    `  "pr view") printf '%s\\n' '${prJson}' ;;`,
    '  "pr checks") printf \'gate\\tpass\\t1m0s\\thttps://ci.example/1\\nlint\\tfail\\t12s\\thttps://ci.example/2\\n\' ;;',
    `  "issue view") printf '%s\\n' '{"number":3,"title":"seeded issue","state":"OPEN","body":"Issue body."}' ;;`,
    '  *) echo "shim: unsupported $*" >&2; exit 1 ;;',
    'esac',
  ].join('\n'),
)
chmodSync(join(shimDir, 'gh'), 0o755)
const brokenShimDir = mkdtempSync(join(tmpdir(), 'anvil-s5-broken-'))
writeFileSync(join(brokenShimDir, 'gh'), '#!/usr/bin/env bash\necho "NOT JSON AT ALL"\n')
chmodSync(join(brokenShimDir, 'gh'), 0o755)
const emptyPath = mkdtempSync(join(tmpdir(), 'anvil-s5-nopath-'))
const REAL_PATH = process.env.PATH!
const withShim = `${shimDir}:${REAL_PATH}`
const withBroken = `${brokenShimDir}:${REAL_PATH}`
const gitOnlyDir = mkdtempSync(join(tmpdir(), 'anvil-s5-gitonly-'))
symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(gitOnlyDir, 'git'))
const noGh = `${emptyPath}:${gitOnlyDir}`

section('L. local truth without any host')
{
  const root = await repoAdapter.resolve({ kind: 'repo', id: '', selectors: {} } as never, { owner, cwd: repo })
  check('L1 mercury://repo resolves locally', root.state === 'ok' && root.state === 'ok' && root.resource.summary.includes('no upstream'), 'mercury://repo must resolve from local git with a summary saying no upstream; see repoAdapter in src/integrations/resources/adapters/repo.ts')
  const branch = await repoAdapter.resolve({ kind: 'repo', id: 'branch', selectors: {} } as never, { owner, cwd: repo })
  check('L2 branch names the NO-upstream state exactly', branch.state === 'ok' && branch.state === 'ok' && branch.resource.summary.includes('NO upstream'), 'mercury://repo/branch must say NO upstream for a repo without one; see repoAdapter in src/integrations/resources/adapters/repo.ts')
  const sha = git(repo, 'rev-parse', 'HEAD').trim()
  git(repo, 'checkout', '-q', sha)
  const detached = await repoAdapter.resolve({ kind: 'repo', id: 'branch', selectors: {} } as never, { owner, cwd: repo })
  check('L3 detached HEAD is a truthful state', detached.state === 'ok', 'a detached HEAD must still resolve ok; see repoAdapter in src/integrations/resources/adapters/repo.ts')
  git(repo, 'checkout', '-q', 'main')
  const notRepo = await repoAdapter.resolve({ kind: 'repo', id: '', selectors: {} } as never, { owner, cwd: tmpdir() })
  check('L4 non-repo cwd ⇒ typed unavailable + remedy', notRepo.state === 'unavailable' && (notRepo as { note?: string }).note!.includes('remedy'), 'outside a repo the adapter must answer unavailable with a remedy in its note; see unavailable() in src/integrations/resources/adapters/repo.ts')
}

section('H. host reads (deterministic shim)')
{
  process.env.PATH = withShim
  process.env.MERCURY_GH_CMD = JSON.stringify([join(shimDir, 'gh')])
  _resetRepoHostCacheForTesting()
  const pr = await fetchPr(repo, 7)
  check('H1 pr view parsed + bounded', pr.state === 'ok' && pr.pr.number === 7 && pr.pr.files.length === 2, 'fetchPr must parse the gh pr view JSON; see fetchPr in src/platform/repo-host/repoHost.ts')
  const checks = await fetchChecks(repo, 7)
  check('H2 checks rows parsed (pass + fail)', checks.state === 'ok' && checks.checks.length === 2 && checks.checks[1]!.status === 'fail', 'fetchChecks must parse the tab-separated gh pr checks rows; see fetchChecks in src/platform/repo-host/repoHost.ts')
  const issue = await fetchIssue(repo, 3)
  check('H3 issue view parsed', issue.state === 'ok' && issue.issue.title === 'seeded issue', 'fetchIssue must parse the gh issue view JSON; see fetchIssue in src/platform/repo-host/repoHost.ts')
  const prRes = await resolveResource('mercury://repo/pr/7', { owner, cwd: repo })
  check('H4 mercury://repo/pr/<n> stable URI + body', prRes.state === 'ok' && prRes.state === 'ok' && (prRes.resource.text ?? '').includes('Seeded body.'), 'mercury://repo/pr/<n> must resolve with the PR body; see repoAdapter in src/integrations/resources/adapters/repo.ts')

  process.env.PATH = withBroken
  process.env.MERCURY_GH_CMD = JSON.stringify([join(brokenShimDir, 'gh')])
  _resetRepoHostCacheForTesting()
  const malformed = await fetchPr(repo, 7)
  check('H5 malformed CLI output ⇒ typed unavailable', malformed.state === 'unavailable' && malformed.note.includes('unparseable'), 'non-JSON gh output must give a typed unavailable whose note says unparseable; see fetchPr in src/platform/repo-host/repoHost.ts')

  process.env.PATH = noGh
  delete process.env.MERCURY_GH_CMD
  _resetRepoHostCacheForTesting()
  const missing = await fetchPr(repo, 7)
  check('H6 missing gh ⇒ exact remedy', missing.state === 'unavailable' && missing.remedy.includes('gh auth login'), 'a missing gh must give a remedy naming gh auth login; see the remedy text in src/platform/repo-host/repoHost.ts')
  process.env.PATH = REAL_PATH
  _resetRepoHostCacheForTesting()
}

section('R. review context + typed record')
{
  const ctx = await composeReviewContext(repo)
  check('R1 worktree context composes the diff set', ctx.state === 'ok' && ctx.context.files.some(f => f.path === 'feature.js'), 'composeReviewContext must list the changed worktree files; see composeReviewContext in src/platform/repo-host/repoHost.ts')
  check('R2 impact is a REF + diagnostics note honest', ctx.state === 'ok' && ctx.context.impactRef.startsWith('mercury://project/impact') && ctx.context.diagnosticsNote.length > 0, 'the review context needs an impact ref starting mercury://project/impact and a non-empty diagnosticsNote; see composeReviewContext in src/platform/repo-host/repoHost.ts')

  const invented = await recordReview({
    root: repo,
    scope: 'worktree',
    inspected: ['feature.js'],
    findings: [{ class: 'defect', severity: 'major', path: 'ghost.js', range: 'L1', claim: 'x', evidence: 'y', nextAction: 'z' }],
    allowedPaths: ['feature.js'],
  })
  check('R3 out-of-set path REFUSED (never invent locations)', invented.state === 'refused' && invented.reason.includes('ghost.js'), 'recordReview must refuse a finding whose path is outside allowedPaths and name it; see recordReview in src/platform/repo-host/repoHost.ts')

  const badRange = await recordReview({
    root: repo,
    scope: 'worktree',
    inspected: [],
    findings: [{ class: 'defect', severity: 'major', path: 'feature.js', range: '10-14', claim: 'x', evidence: 'y', nextAction: 'z' }],
    allowedPaths: ['feature.js'],
  })
  check('R4 malformed range refused', badRange.state === 'refused' && badRange.reason.includes("'L<start>'"), 'recordReview must refuse a range not spelled L<start> and say so; see recordReview in src/platform/repo-host/repoHost.ts')

  const emptyBad = await recordReview({ root: repo, scope: 'worktree', inspected: [], findings: [], allowedPaths: [] })
  check('R5 empty review must name what it inspected', emptyBad.state === 'refused', 'recordReview must refuse a review with no findings and nothing inspected; see recordReview in src/platform/repo-host/repoHost.ts')

  const good = await recordReview({
    root: repo,
    scope: 'worktree',
    inspected: ['feature.js', 'other.js'],
    findings: [
      { class: 'defect', severity: 'major', path: 'feature.js', range: 'L1', claim: 'feat() return value changed without a test', evidence: 'worktree diff hunk 1', nextAction: 'add a regression test before merging' },
      { class: 'polish', severity: 'minor', path: 'feature.js', range: 'L1', claim: 'naming could be clearer', evidence: 'style only', nextAction: 'optional rename' },
    ],
    allowedPaths: ['feature.js'],
  })
  check('R6 valid record persists', good.state === 'ok', 'recordReview refused a valid record: ' + JSON.stringify(good) + '; see recordReview in src/platform/repo-host/repoHost.ts')
  const latest = latestReview(repo)
  check('R7 latest review readable + classes separated',
    latest !== null && latest.findings.filter(f => f.class === 'defect').length === 1 && latest.findings.filter(f => f.class === 'polish').length === 1, 'latestReview must return the saved review with both finding classes; see latestReview and recordReview in src/platform/repo-host/repoHost.ts')
  const res = await resolveResource('mercury://repo/review/latest', { owner, cwd: repo })
  check('R8 review serves as a resource with exact locations', res.state === 'ok' && res.state === 'ok' && (res.resource.text ?? '').includes('feature.js:L1'), 'mercury://repo/review/latest must render findings as path:L<line>; see repoAdapter in src/integrations/resources/adapters/repo.ts')

  const emptyOk = await recordReview({ root: repo, scope: 'worktree', inspected: ['feature.js'], findings: [], allowedPaths: ['feature.js'], note: 'no supported findings' })
  check('R9 honest no-findings review records what it inspected', emptyOk.state === 'ok', 'recordReview must accept zero findings when inspected is named; see recordReview in src/platform/repo-host/repoHost.ts')
}

section('G. MERCURY_REPO_HOST=0')
{
  process.env.MERCURY_REPO_HOST = '0'
  const off = await repoAdapter.resolve({ kind: 'repo', id: '', selectors: {} } as never, { owner, cwd: repo })
  check('G1 kind answers unavailable when off', off.state === 'unavailable', 'MERCURY_REPO_HOST=0 must make mercury://repo unavailable; see repoAdapter in src/integrations/resources/adapters/repo.ts')
  process.env.MERCURY_REPO_HOST = '1'
}

console.log('')
if (failures > 0) {
  console.error(`prove-repo-host: ${failures} RED`)
  process.exit(1)
}
console.log('prove-repo-host: GREEN')
