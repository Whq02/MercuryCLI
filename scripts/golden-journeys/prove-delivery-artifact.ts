
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

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

const { makeOwnerKey } = await import('../../src/engine/run-owner/ownerKey.ts')
const { acceptUserRequest, getRunSnapshot, noteRunEvent } = await import(
  '../../src/engine/run/runCoordinator.ts'
)
const { mintDeliveryArtifact, _resetDeliveryLatchForTesting, headlessMintAllowed } = await import(
  '../../src/permissions/guards/runStopAdapter.ts'
)
const { listReviewArtifactHeads } = await import('../../src/sessions/artifact-reviews/reviewStore.ts')
const { setIsInteractive } = await import('../../src/boot/process-state/processState.ts')
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

mintDeliveryArtifact(owner, snap.runId, true)
let heads: ReturnType<typeof listReviewArtifactHeads> = []
for (let i = 0; i < 40 && heads.length === 0; i++) {
  await sleep(50)
  heads = listReviewArtifactHeads({ root: WORKDIR })
}
check('the walkthrough artifact is minted at completion', heads.length === 1,
  `${heads.length} review artifact heads after the completion settle; read mintDeliveryArtifact in src/permissions/guards/runStopAdapter.ts and why it wrote none or more than one`)
const head = heads[0]
check('…kind walkthrough', head?.kind === 'walkthrough', `kind is ${String(head?.kind)}; mintDeliveryArtifact in src/permissions/guards/runStopAdapter.ts must mint a walkthrough`)
check('…offered for review (ready-for-review)', head?.status === 'ready-for-review', `status is ${String(head?.status)}; mintDeliveryArtifact in src/permissions/guards/runStopAdapter.ts must leave the artifact ready-for-review`)
check('…carries the tree digest for the staleness law', typeof head?.treeDigest === 'string' && head.treeDigest.length > 0,
  `treeDigest is ${String(head?.treeDigest)}; the minted walkthrough must carry the tree digest (mintDeliveryArtifact in src/permissions/guards/runStopAdapter.ts)`)

for (let i = 0; i < 20 && !(getRunSnapshot(owner)?.nextAction ?? '').includes('walkthrough'); i++) {
  await sleep(50)
}
const next = getRunSnapshot(owner)?.nextAction ?? ''
check('the next action names the delivered walkthrough + routes', next.includes('walkthrough') && next.includes('/diff'),
  `nextAction was: ${next}; the action text set in mintDeliveryArtifact (src/permissions/guards/runStopAdapter.ts) must name the walkthrough and /diff`)

mintDeliveryArtifact(owner, snap.runId, true)
await sleep(300)
check('a second completion settle for the same run mints nothing', listReviewArtifactHeads({ root: WORKDIR }).length === 1,
  'the same run minted twice; the once-per-run latch in mintDeliveryArtifact (src/permissions/guards/runStopAdapter.ts) must refuse the repeat')

_resetDeliveryLatchForTesting()
mintDeliveryArtifact(owner, 'run-nochange', false)
await sleep(300)
check('a completion with no changed files mints nothing', listReviewArtifactHeads({ root: WORKDIR }).length === 1,
  'a run with no changed files minted an artifact; mintDeliveryArtifact in src/permissions/guards/runStopAdapter.ts must return when hasChanges is false')

_resetDeliveryLatchForTesting()
process.env.MERCURY_DELIVERY_ARTIFACT = '0'
mintDeliveryArtifact(owner, 'run-gated', true)
await sleep(300)
check('MERCURY_DELIVERY_ARTIFACT=0 kills the mint', listReviewArtifactHeads({ root: WORKDIR }).length === 1,
  'a mint happened with MERCURY_DELIVERY_ARTIFACT=0; mintDeliveryArtifact in src/permissions/guards/runStopAdapter.ts must honour that flag')
delete process.env.MERCURY_DELIVERY_ARTIFACT

setIsInteractive(false)
_resetDeliveryLatchForTesting()
mintDeliveryArtifact(owner, 'run-headless', true)
await sleep(300)
check('headless completion (default-on flag) mints nothing', listReviewArtifactHeads({ root: WORKDIR }).length === 1,
  'a headless run minted without the opt-in; headlessMintAllowed in src/permissions/guards/runStopAdapter.ts must refuse an unset flag when not interactive')
process.env.MERCURY_DELIVERY_ARTIFACT = '1'
_resetDeliveryLatchForTesting()
mintDeliveryArtifact(owner, 'run-headless-optin', true)
await sleep(400)
check('explicit truthy opt-in mints on headless runs (review mode)', listReviewArtifactHeads({ root: WORKDIR }).length === 2,
  'a headless run with MERCURY_DELIVERY_ARTIFACT=1 did not mint; headlessMintAllowed in src/permissions/guards/runStopAdapter.ts must accept a truthy flag')
delete process.env.MERCURY_DELIVERY_ARTIFACT
check('the gate function pins all three postures',
  headlessMintAllowed(undefined) === false && headlessMintAllowed('1') === true &&
    (setIsInteractive(true), headlessMintAllowed(undefined) === true),
  'headlessMintAllowed (src/permissions/guards/runStopAdapter.ts) must return false for undefined when headless, true for 1, and true for undefined when interactive')
setIsInteractive(false)

rmSync(SCRATCH, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-delivery-artifact: RED (${failures})`)
  process.exit(1)
}
console.log('\nprove-delivery-artifact: green')
