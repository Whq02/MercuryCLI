#!/usr/bin/env bun
// ============================================================================
//  scripts/structure-tools/prove-repo-observation.ts — Family 2: the repository
//  observation delta, proved with a REAL disposable git repo (local ops)
//  and a DETERMINISTIC gh shim (host ops — zero live hosted calls):
//
//    L. local at-ref reads — fileAtRef exact bytes at an OLD ref · treeAtRef
//       entries · compare ahead/behind/commits/files; bad ref and bad path
//       name themselves distinctly;
//    S. host search — typed rows per kind; empty query refuses;
//    D. paginated PR diff — file list; per-file pages deterministic and
//       disjoint; an absent file names itself; the SAME shim fetch serves
//       the list and every page (one host call within the TTL);
//    W. run watch on the execution plane — a finite fixture run registers
//       'running', settles 'succeeded' from the OBSERVED completed poll;
//       a never-ending run cancels to 'stopped' via the plane's stop;
//    C. cache discipline — identical concurrent queries share ONE gh call
//       (in-flight dedup, the latest-request-wins seam).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lathe-f2-home-'))
process.env.MERCURY_SIMPLE = '1'
delete process.env.MERCURY_REPO_HOST

const { gitCompare, gitFileAtRef, gitTreeAtRef } = await import('../../src/services/gitGraph/observe.ts')
const { searchHost, fetchPrDiffFiles, fetchPrDiffPage, fetchRun, _resetRepoHostCacheForTesting } = await import(
  '../../src/services/repoHost/repoHost.ts'
)
const { watchRun, cancelRunWatch, _resetRunWatchesForTesting } = await import('../../src/services/repoHost/runWatch.ts')
const { getExecution } = await import('../../src/services/primitives/executionPlane.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(name: string): void {
  console.log(`\n${name}`)
}

// ── fixtures: a real disposable repo ────────────────────────────────────────
const repo = mkdtempSync(join(tmpdir(), 'lathe-f2-repo-'))
const g = (...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' })
g('init', '-q', '-b', 'main')
mkdirSync(join(repo, 'lib'))
writeFileSync(join(repo, 'lib', 'a.txt'), 'first version\n')
writeFileSync(join(repo, 'top.txt'), 'top\n')
g('add', '-A')
g('commit', '-q', '-m', 'c1')
const c1 = g('rev-parse', 'HEAD').trim()
writeFileSync(join(repo, 'lib', 'a.txt'), 'second version\n')
writeFileSync(join(repo, 'lib', 'b.txt'), 'new file\n')
g('add', '-A')
g('commit', '-q', '-m', 'c2')

// ── L. local at-ref reads ───────────────────────────────────────────────────
section('L. local at-ref observation')
{
  const old = gitFileAtRef(repo, c1, 'lib/a.txt')
  check('fileAtRef reads the OLD ref exactly', !('state' in old) && old.text === 'first version\n')
  const now = gitFileAtRef(repo, 'HEAD', 'lib/a.txt')
  check('fileAtRef reads HEAD exactly', !('state' in now) && now.text === 'second version\n')
  const badPath = gitFileAtRef(repo, 'HEAD', 'lib/nope.txt')
  check('bad path names the path+ref', 'state' in badPath && badPath.note.includes('does not exist at HEAD'))
  const badRef = gitFileAtRef(repo, 'deadbeef99', 'lib/a.txt')
  check('bad ref names the ref', 'state' in badRef && badRef.note.includes("'deadbeef99' does not resolve"))

  const tree = gitTreeAtRef(repo, c1, 'lib')
  check('treeAtRef lists the OLD tree', !('state' in tree) && tree.entries.length === 1 && tree.entries[0]!.name === 'a.txt')
  const treeNow = gitTreeAtRef(repo, 'HEAD', 'lib')
  check('treeAtRef lists HEAD', !('state' in treeNow) && treeNow.entries.length === 2)

  const cmp = gitCompare(repo, c1, 'HEAD')
  check(
    'compare: ahead/behind + commits + files',
    !('state' in cmp) &&
      cmp.ahead === 1 &&
      cmp.behind === 0 &&
      cmp.commitsAhead.length === 1 &&
      cmp.commitsAhead[0]!.subject === 'c2' &&
      cmp.files.length === 2 &&
      cmp.mergeBase === c1,
    JSON.stringify(cmp),
  )
}

// ── the gh shim (host ops) ──────────────────────────────────────────────────
const shimDir = mkdtempSync(join(tmpdir(), 'lathe-f2-shim-'))
const stateDir = mkdtempSync(join(tmpdir(), 'lathe-f2-state-'))
writeFileSync(join(stateDir, 'poll-count'), '0')
const DIFF = [
  'diff --git a/src/one.ts b/src/one.ts',
  'index 111..222 100644',
  '--- a/src/one.ts',
  '+++ b/src/one.ts',
  '@@ -1,3 +1,4 @@',
  ' line1',
  '+added-one',
  ' line2',
  ' line3',
  'diff --git a/src/two.ts b/src/two.ts',
  'index 333..444 100644',
  '--- a/src/two.ts',
  '+++ b/src/two.ts',
  ...Array.from({ length: 30 }, (_, i) => `@@ -${i * 10 + 1},2 +${i * 10 + 1},3 @@\n line-a-${i}\n+added-${i}\n line-b-${i}`).flatMap(s => s.split('\n')),
].join('\n')
writeFileSync(join(stateDir, 'diff.txt'), `${DIFF}\n`)
writeFileSync(
  join(shimDir, 'gh'),
  [
    '#!/bin/bash',
    `STATE="${stateDir}"`,
    'echo "$*" >> "$STATE/calls.log"',
    'case "$1 $2" in',
    '  "search code") echo \'[{"path":"src/hit.ts","repository":{"nameWithOwner":"o/r"},"url":"https://x/code"}]\' ;;',
    '  "search prs") echo \'[{"number":7,"title":"Fix things","state":"open","repository":{"nameWithOwner":"o/r"},"url":"https://x/pr"}]\' ;;',
    '  "search commits") echo \'[{"sha":"abc1234567890","commit":{"message":"fix: the thing\\nbody"},"repository":{"nameWithOwner":"o/r"}}]\' ;;',
    '  "pr diff") sleep 0.2; cat "$STATE/diff.txt" ;;',
    '  "run list") echo \'[{"databaseId":42,"displayTitle":"ci","workflowName":"gate","status":"in_progress","conclusion":"","headBranch":"main","createdAt":"2026-07-20T00:00:00Z"}]\' ;;',
    '  "run view")',
    '    RUN_ID="$3"',
    '    if [ "$RUN_ID" = "42" ]; then',
    '      N=$(cat "$STATE/poll-count"); N=$((N+1)); echo "$N" > "$STATE/poll-count"',
    '      if [ "$N" -ge 2 ]; then',
    '        echo \'{"databaseId":42,"displayTitle":"ci","workflowName":"gate","status":"completed","conclusion":"success","jobs":[{"name":"build","status":"completed","conclusion":"success"}]}\'',
    '      else',
    '        echo \'{"databaseId":42,"displayTitle":"ci","workflowName":"gate","status":"in_progress","conclusion":"","jobs":[{"name":"build","status":"in_progress","conclusion":""}]}\'',
    '      fi',
    '    elif [ "$RUN_ID" = "77" ]; then',
    '      echo \'{"databaseId":77,"displayTitle":"forever","workflowName":"gate","status":"in_progress","conclusion":"","jobs":[]}\'',
    '    else',
    '      echo "run not found" >&2; exit 1',
    '    fi ;;',
    '  *) echo "shim: unsupported $*" >&2; exit 1 ;;',
    'esac',
  ].join('\n') + '\n',
)
chmodSync(join(shimDir, 'gh'), 0o755)
const REAL_PATH = process.env.PATH ?? ''
process.env.PATH = `${shimDir}:${REAL_PATH}`

// ── S. host search ──────────────────────────────────────────────────────────
section('S. host search (deterministic shim)')
{
  const code = await searchHost(repo, 'code', 'needle')
  check('code rows typed', code.state === 'ok' && code.rows[0]!.title === 'src/hit.ts' && code.rows[0]!.repo === 'o/r')
  const prs = await searchHost(repo, 'prs', 'fix')
  check('pr rows typed', prs.state === 'ok' && prs.rows[0]!.title.startsWith('#7 ') && prs.rows[0]!.detail === 'open')
  const commits = await searchHost(repo, 'commits', 'fix')
  check('commit rows carry subject + short sha', commits.state === 'ok' && commits.rows[0]!.title === 'fix: the thing' && commits.rows[0]!.detail === 'abc123456789')
  const empty = await searchHost(repo, 'code', '   ')
  check('empty query refuses', empty.state === 'unavailable')
}

// ── D. paginated PR diff ────────────────────────────────────────────────────
section('D. paginated per-file diff (one fetch, many pages)')
{
  writeFileSync(join(stateDir, 'calls.log'), '')
  const files = await fetchPrDiffFiles(repo)
  check('file list', files.state === 'ok' && files.files.length === 2 && files.files[1]!.path === 'src/two.ts', JSON.stringify(files))
  const p0 = await fetchPrDiffPage(repo, 'src/two.ts', 0)
  const p1 = await fetchPrDiffPage(repo, 'src/two.ts', 1)
  check('pages are bounded + disjoint', p0.state === 'ok' && p1.state === 'ok' && p0.pages > 1 && p0.lines[0] !== p1.lines[0] && p0.lines.length === 80)
  const again = await fetchPrDiffPage(repo, 'src/two.ts', 0)
  check('page read is deterministic', again.state === 'ok' && p0.state === 'ok' && again.lines.join('\n') === p0.lines.join('\n'))
  const absent = await fetchPrDiffPage(repo, 'src/none.ts', 0)
  check("absent file names itself", absent.state === 'unavailable' && absent.note.includes('src/none.ts'))
  const calls = readFileSync(join(stateDir, 'calls.log'), 'utf8').split('\n').filter(l => l.startsWith('pr diff'))
  check('ONE host fetch served list + pages (TTL row)', calls.length === 1, `${calls.length} pr-diff calls`)
}

// ── C. cache discipline: concurrent identical queries share one call ───────
section('C. in-flight dedup (latest-request-wins seam)')
{
  _resetRepoHostCacheForTesting()
  writeFileSync(join(stateDir, 'calls.log'), '')
  const [a, b, c] = await Promise.all([
    fetchPrDiffFiles(repo),
    fetchPrDiffFiles(repo),
    fetchPrDiffFiles(repo),
  ])
  const calls = readFileSync(join(stateDir, 'calls.log'), 'utf8').split('\n').filter(l => l.startsWith('pr diff'))
  check('three concurrent identical queries → one gh call', calls.length === 1, `${calls.length} calls`)
  check('all three callers answered', a.state === 'ok' && b.state === 'ok' && c.state === 'ok')
}

// ── W. run watch on the execution plane ─────────────────────────────────────
section('W. cancellable run watch (finite fixture)')
{
  const owner = makeOwnerKey({ workspace: repo, sessionId: 'lathe-f2-proof', lane: 'main' })
  const started = await watchRun(owner, repo, '42')
  check('watch registers running', started.state === 'watching' && started.record.state === 'running', JSON.stringify(started))
  if (started.state === 'watching') {
    check('first observed view rides back', started.view?.status === 'in_progress')
    // The second poll (5s cadence) observes completed/success.
    await new Promise(r => setTimeout(r, 6_500))
    const settled = getExecution(owner, 'run-watch-42')
    check('watch settled succeeded from the OBSERVED conclusion', settled?.state === 'succeeded', settled?.state)
    check('outcome carries the conclusion', settled?.outcome?.reason === 'conclusion: success', settled?.outcome?.reason)
  }
  const missing = await watchRun(owner, repo, '999')
  check('a run the host does not know never mints a record', missing.state === 'unavailable')

  const forever = await watchRun(owner, repo, '77')
  check('never-ending run registers', forever.state === 'watching')
  const stopped = cancelRunWatch(owner, '77')
  check('cancel requests stop through the plane', stopped !== undefined)
  await new Promise(r => setTimeout(r, 100))
  const rec = getExecution(owner, 'run-watch-77')
  check('cancelled watch settles stopped', rec?.state === 'stopped', rec?.state)
  _resetRunWatchesForTesting()
}

// ── V. closing-wave regressions ─────────────────────────────────────────────
section('V. slashed refs · quotepath round-trip · binary honesty · bounded diff · disposal reaping')
{
  // Slashed refs: a feature/x branch addresses through the resource plane.
  g('branch', 'feature/x')
  const { splitRefPath, gitFileAtRef, gitTreeAtRef } = await import('../../src/services/gitGraph/observe.ts')
  const split = splitRefPath(repo, 'feature/x/lib/a.txt')
  check('splitRefPath resolves the LONGEST-needed ref prefix', split?.ref === 'feature/x' && split.path === 'lib/a.txt', JSON.stringify(split))
  const { gitAdapter } = await import('../../src/services/resources/adapters/git.ts')
  const viaResource = await gitAdapter.resolve(
    { kind: 'git', id: 'at/feature/x/lib/a.txt', selectors: {}, canonical: 'mercury://git/at/feature/x/lib/a.txt', raw: 'mercury://git/at/feature/x/lib/a.txt' } as never,
    { cwd: repo } as never,
  )
  check(
    'mercury://git/at with a slashed ref resolves',
    viaResource.state === 'ok' && (viaResource as { resource: { text?: string } }).resource.text === 'second version\n',
    JSON.stringify(viaResource).slice(0, 120),
  )

  // quotepath: listed non-ASCII names round-trip into gitFileAtRef.
  writeFileSync(join(repo, 'lib', 'café.txt'), 'accent\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'accent')
  const tree = gitTreeAtRef(repo, 'HEAD', 'lib')
  const accent = !('state' in tree) ? tree.entries.find(e => e.name.includes('caf')) : undefined
  check('tree names are unquoted (quotepath off)', accent?.name === 'café.txt', JSON.stringify(accent))
  if (accent) {
    const roundTrip = gitFileAtRef(repo, 'HEAD', `lib/${accent.name}`)
    check('listed name round-trips into fileAtRef', !('state' in roundTrip) && roundTrip.text === 'accent\n')
  }

  // binary honesty: a NUL-carrying blob is NAMED, bytes are real bytes.
  writeFileSync(join(repo, 'blob.bin'), Buffer.from([0x62, 0x00, 0x63, 0xc3, 0xa9]))
  g('add', '-A')
  g('commit', '-q', '-m', 'bin')
  const bin = gitFileAtRef(repo, 'HEAD', 'blob.bin')
  check('binary blob named as binary', !('state' in bin) && bin.binary === true, JSON.stringify(bin).slice(0, 100))

  // Bounded PR-diff parse: a >120-line hunk file pages HONESTLY incomplete.
  const bigHunk = [
    'diff --git a/big.txt b/big.txt',
    '--- a/big.txt',
    '+++ b/big.txt',
    '@@ -1,1 +1,200 @@',
    ' keep',
    ...Array.from({ length: 200 }, (_, i) => `+big-${i}`),
  ].join('\n')
  writeFileSync(join(stateDir, 'diff.txt'), `${bigHunk}\n`)
  _resetRepoHostCacheForTesting()
  const bigList = await fetchPrDiffFiles(repo)
  check('bounded parse FLAGGED on the listing', bigList.state === 'ok' && bigList.bounded === true, JSON.stringify(bigList).slice(0, 120))
  const bigPage = await fetchPrDiffPage(repo, 'big.txt', 0)
  check(
    'incomplete per-file pages SAY so',
    bigPage.state === 'ok' && typeof bigPage.incompleteNote === 'string' && bigPage.incompleteNote.includes('of 200'),
    JSON.stringify(bigPage.state === 'ok' ? bigPage.incompleteNote : bigPage),
  )
  writeFileSync(join(stateDir, 'diff.txt'), `${DIFF}\n`)
  _resetRepoHostCacheForTesting()

  // Owner disposal reaps a live watch — no gh polls after /clear.
  const { disposeOwner } = await import('../../src/services/run/ownerLifecycle.ts')
  const owner = makeOwnerKey({ workspace: repo, sessionId: 'lathe-f2-dispose', lane: 'main' })
  const watching = await watchRun(owner, repo, '77')
  check('disposal fixture watch registers', watching.state === 'watching')
  await disposeOwner(owner)
  writeFileSync(join(stateDir, 'calls.log'), '')
  await new Promise(r => setTimeout(r, 6_000))
  const polls = readFileSync(join(stateDir, 'calls.log'), 'utf8').split('\n').filter(l => l.includes('run view 77'))
  check('disposed owner spawns ZERO further polls', polls.length === 0, `${polls.length} poll(s) after disposal`)
}

// ── G. flag honesty ─────────────────────────────────────────────────────────
section('G. MERCURY_REPO_HOST=0 refuses host ops with zero gh calls')
{
  process.env.MERCURY_REPO_HOST = '0'
  writeFileSync(join(stateDir, 'calls.log'), '')
  const owner = makeOwnerKey({ workspace: repo, sessionId: 'lathe-f2-proof-off', lane: 'main' })
  const watch = await watchRun(owner, repo, '42')
  check('runWatch refuses by flag name', watch.state === 'unavailable' && watch.note.includes('MERCURY_REPO_HOST=0'))
  const calls = readFileSync(join(stateDir, 'calls.log'), 'utf8').trim()
  check('zero gh invocations while off', calls === '')
  delete process.env.MERCURY_REPO_HOST
}

console.log(failures === 0 ? '\nREPO OBSERVATION LAWS GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
