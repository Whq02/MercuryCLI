// ============================================================================
//  scripts/golden-journeys/prove-delivery-artifact.ts — the proven-delivery mint
//
//
//  Drives the REAL chain: seeded run-coordinator state → mintDeliveryArtifact
//  → the review-artifact store (hermetic root) → the run's next action names
//  the review route. Laws: mint only for changed-file completions ·
//  ready-for-review with evidence-backed claims · the tree digest rides for
//  staleness · exactly once per runId · =0 kills the mint entirely.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

// Hermetic BEFORE imports that snapshot config paths: the review store root
// and the working directory both point at scratch (proof-hygiene rule — the
// mint's gather walks the cwd's git facts + tree digest).
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'momentum-delivery-'))
process.env.MERCURY_REVIEW_ARTIFACTS_DIR = path.join(SCRATCH, 'review-artifacts')
const WORKDIR = path.join(SCRATCH, 'repo')
execFileSync('git', ['init', '-q', '-b', 'main', WORKDIR], { stdio: 'pipe' })
const git = (...args: string[]) => execFileSync('git', ['-C', WORKDIR, ...args], { stdio: 'pipe' })
git('config', 'user.email', 'momentum@fixture.local')
git('config', 'user.name', 'Momentum Fixture')
const { writeFileSync, mkdirSync } = await import('node:fs')
mkdirSync(path.join(WORKDIR, 'src'), { recursive: true })
writeFileSync(path.join(WORKDIR, 'src/widget.ts'), 'export const widget = 1\n')
git('add', '-A')
git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture baseline')
process.chdir(WORKDIR)

const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const { acceptUserRequest, getRunSnapshot, noteRunEvent } = await import(
  '../../src/services/run/runCoordinator.ts'
)
const { mintDeliveryArtifact, _resetDeliveryLatchForTesting, headlessMintAllowed } = await import(
  '../../src/utils/hooks/runStopAdapter.ts'
)
const { listReviewArtifactHeads } = await import('../../src/utils/artifacts/reviewStore.ts')
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
// the mint is INTERACTIVE-gated by default — ordinary headless
// completion mints nothing. The positive legs below run as an interactive
// session (the unchanged behavior); §6 pins the headless gate itself.
setIsInteractive(true)

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

console.log('prove-delivery-artifact — the M4 proven-delivery laws')

const owner = makeOwnerKey({ workspace: WORKDIR, sessionId: 'momentum-m4', lane: 'main' })
const snap = acceptUserRequest(owner, { objective: 'deliver the widget', rootMessageId: null })
noteRunEvent(owner, { type: 'substantive', at: Date.now(), reason: 'invoked Edit' })
noteRunEvent(owner, {
  type: 'tool-effected',
  at: Date.now(),
  toolName: 'Edit',
  toolUseId: 'toolu_m4',
  operation: 'edit apply',
  outcome: 'succeeded',
  changedPaths: [path.join(WORKDIR, 'src/widget.ts')],
})
noteRunEvent(owner, { type: 'completed', at: Date.now(), satisfied: ['widget delivered'] })

// ── 1 · the mint lands as a ready-for-review walkthrough with the digest ────
mintDeliveryArtifact(owner, snap.runId, true)
let heads: ReturnType<typeof listReviewArtifactHeads> = []
for (let i = 0; i < 40 && heads.length === 0; i++) {
  await sleep(50)
  heads = listReviewArtifactHeads({ root: WORKDIR })
}
check('the walkthrough artifact is minted at completion', heads.length === 1)
const head = heads[0]
check('…kind walkthrough', head?.kind === 'walkthrough')
check('…offered for review (ready-for-review)', head?.status === 'ready-for-review')
check('…carries the tree digest for the staleness law', typeof head?.treeDigest === 'string' && head.treeDigest.length > 0)

// ── 2 · the run's next action names the review route ────────────────────────
for (let i = 0; i < 20 && !(getRunSnapshot(owner)?.nextAction ?? '').includes('walkthrough'); i++) {
  await sleep(50)
}
const next = getRunSnapshot(owner)?.nextAction ?? ''
check('the next action names the delivered walkthrough + routes', next.includes('walkthrough') && next.includes('/diff'))

// ── 3 · exactly once per runId ──────────────────────────────────────────────
mintDeliveryArtifact(owner, snap.runId, true)
await sleep(300)
check('a second completion settle for the same run mints nothing', listReviewArtifactHeads({ root: WORKDIR }).length === 1)

// ── 4 · no-change completions stay artifact-free ────────────────────────────
_resetDeliveryLatchForTesting()
mintDeliveryArtifact(owner, 'run-nochange', false)
await sleep(300)
check('a completion with no changed files mints nothing', listReviewArtifactHeads({ root: WORKDIR }).length === 1)

// ── 5 · the =0 kill switch ──────────────────────────────────────────────────
_resetDeliveryLatchForTesting()
process.env.MERCURY_DELIVERY_ARTIFACT = '0'
mintDeliveryArtifact(owner, 'run-gated', true)
await sleep(300)
check('MERCURY_DELIVERY_ARTIFACT=0 kills the mint', listReviewArtifactHeads({ root: WORKDIR }).length === 1)
delete process.env.MERCURY_DELIVERY_ARTIFACT

// ── 6 ·: ordinary headless completion mints NOTHING ────────────────────
// The review store is durable + prune-exempt; a `-p` run's operator never
// sees the review queue (the field's mystery journal). Explicit truthy
// opt-in restores review mode on headless runs.
setIsInteractive(false)
_resetDeliveryLatchForTesting()
mintDeliveryArtifact(owner, 'run-headless', true)
await sleep(300)
check('headless completion (default-on flag) mints nothing', listReviewArtifactHeads({ root: WORKDIR }).length === 1)
process.env.MERCURY_DELIVERY_ARTIFACT = '1'
_resetDeliveryLatchForTesting()
mintDeliveryArtifact(owner, 'run-headless-optin', true)
await sleep(400)
check('explicit truthy opt-in mints on headless runs (review mode)', listReviewArtifactHeads({ root: WORKDIR }).length === 2)
delete process.env.MERCURY_DELIVERY_ARTIFACT
check('the gate function pins all three postures',
  headlessMintAllowed(undefined) === false && headlessMintAllowed('1') === true &&
    (setIsInteractive(true), headlessMintAllowed(undefined) === true))
setIsInteractive(false)

rmSync(SCRATCH, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-delivery-artifact: RED (${failures})`)
  process.exit(1)
}
console.log('\nprove-delivery-artifact: green')
