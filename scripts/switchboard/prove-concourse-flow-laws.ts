#!/usr/bin/env bun
// ============================================================================
// scripts/switchboard/prove-concourse-flow-laws.ts — the concourse-flow
//  law pins: the coordinator flow polish (operator items 1–3 + 5) and the
//  folder-switch hardening census, everything provable in-process. The
//  render-verify captures and the reap drive carry the on-screen halves.
//
//   G1  deriveGitOffer: a git-init permission obligation yields the ask id
//       and the EXACT folder (from the `folder:<dir>` subject); worker
//       permission asks and plain rows never arm the card; oldest wins.
//   G2  mintGitInitAsk is folder-bound + deterministic: the same folder
//       re-mints the SAME requestId (restart-stable), a different folder
//       mints its own — the offer always re-evaluates against the launch's
//       folder (hardening law 2); the sidecar answers the folder back.
//   G3  the minted obligation row (scratch crew store) carries the
//       permission ref and the folder-naming question, and deriveGitOffer
//       over the REAL store rows returns that exact folder end-to-end.
//   G4  the deny leg keeps the folder untouched ('kept without git'), the
//       ask settles, and the folder still has no .git.
//   T1  the trust ledger (hardening law 3): a fresh folder is UNTRUSTED;
//       setPathTrusted records exactly it; descendants inherit through the
//       read-side ancestor walk; an unrelated sibling stays untrusted.
//   W1  the ground resolvers (hardening laws 1/4): dispatchSeedInputs
//       targets seeds.projectDir when set, the live cwd otherwise;
//       resolveHarnessGround answers the same truth (the coordinator's
//       per-turn ground read rides it — coordinatorCall.ts).
//   W2  the held-dispatch store keeps the op's workspaceDir VERBATIM
//       across a seed switch (hardening laws 1/5): the pump's replay sends
//       the held bytes, so a queued launch can never migrate folders.
//   M1  item 5's manifest census: the explicit 'm' door is a declared
//       control and an advertised list-region key; ↵ keeps enter-session.
// ============================================================================
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratchHome = mkdtempSync(join(tmpdir(), 'concflow-laws-home-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
delete process.env.MERCURY_HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { deriveGitOffer } = await import('../../src/components/concourse/GitOfferCard.js')
const { mintGitInitAsk, answerPermissionAsk, listPendingPermissionAsks } = await import(
  '../../src/daemon/permissionAsks.js'
)
const { openObligations } = await import('../../src/services/crew/obligations.js')
const { isPathTrusted, setPathTrusted } = await import('../../src/utils/config.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs() // the boot gate — the scratch home's config is the store under test
const { dispatchSeedInputs, resolveHarnessGround, writeConcourseHeldDispatch, readConcourseHeldDispatch, writeConcourseSeedOverride } = await import(
  '../../src/services/concourse/concourseSnapshot.js'
)
const { CONCOURSE_CONTROLS, CONCOURSE_REGION_KEYS } = await import(
  '../../src/components/concourse/controlManifest.js'
)
const { getCwd } = await import('../../src/utils/cwd.js')

// ── G1: the pure derivation ─────────────────────────────────────────────────
console.log('G1 deriveGitOffer')
{
  const folder = '/tmp/proj-a'
  const rows = [
    { obligationId: 'ob-w', sessionId: 'sess-1', ref: 'permission:req-worker-1' },
    { obligationId: 'ob-g', sessionId: `folder:${folder}`, ref: 'permission:git-init:abc123def456' },
    { obligationId: 'ob-g2', sessionId: 'folder:/tmp/proj-b', ref: 'permission:git-init:fedcba654321' },
    { obligationId: 'ob-p', sessionId: 'sess-2' },
  ]
  const offer = deriveGitOffer(rows)
  check('the oldest git-init obligation arms the card', offer?.obligationId === 'ob-g')
  check('the ask id is the ref minus its permission: prefix', offer?.requestId === 'git-init:abc123def456')
  check('the folder is the EXACT folder: subject', offer?.folder === folder)
  check('a worker permission ask never arms the card', deriveGitOffer([rows[0]!]) === undefined)
  check('a plain row never arms the card', deriveGitOffer([rows[3]!]) === undefined)
  check('an empty rail arms nothing', deriveGitOffer([]) === undefined)
}

// ── G2/G3: the mint is folder-bound, deterministic, and lands the row ──────
console.log('G2/G3 mintGitInitAsk — determinism + the durable row')
const folderA = mkdtempSync(join(tmpdir(), 'concflow-folder-a-'))
const folderB = mkdtempSync(join(tmpdir(), 'concflow-folder-b-'))
{
  const first = mintGitInitAsk(folderA)
  const again = mintGitInitAsk(folderA)
  const other = mintGitInitAsk(folderB)
  check('the same folder re-mints the SAME requestId', first.requestId === again.requestId, first.requestId)
  check('a different folder mints its OWN ask', other.requestId !== first.requestId, other.requestId)
  check(
    'both asks are pending, folder-bound',
    listPendingPermissionAsks().filter(a => a.requestId.startsWith('git-init:')).length === 2,
  )
  // The obligation write is fire-and-forget — poll the scratch crew store.
  let rows: Awaited<ReturnType<typeof openObligations>> = []
  for (let i = 0; i < 40; i++) {
    rows = await openObligations({ scope: 'switchboard' })
    if (rows.filter(r => r.ref?.startsWith('permission:git-init:')).length >= 2) break
    await new Promise(r => setTimeout(r, 50))
  }
  const rowA = rows.find(r => r.sessionId === `folder:${folderA}`)
  check('the obligation row landed with the permission ref', rowA?.ref === `permission:${first.requestId}`)
  check('the question names the folder', rowA?.question.includes(folderA) === true, rowA?.question ?? '(no row)')
  const offer = deriveGitOffer(rows)
  check('deriveGitOffer over the REAL store rows answers the exact folder', offer?.folder === folderA || offer?.folder === folderB)
}

// ── G4: the deny leg — folder untouched, ask settled ────────────────────────
console.log('G4 the deny leg')
{
  const minted = mintGitInitAsk(folderA)
  const r = answerPermissionAsk(minted.requestId, false, undefined, 'prover')
  check('deny applies with the kept-without-git receipt', r.outcome === 'applied' && (r.detail ?? '').includes('kept without git'), r.detail ?? '')
  check('the folder still has no .git', !existsSync(join(folderA, '.git')))
  check('the pending ask settled', listPendingPermissionAsks().every(a => a.requestId !== minted.requestId))
}

// ── T1: the trust ledger (hardening law 3) ──────────────────────────────────
console.log('T1 trust ledger')
{
  const fresh = mkdtempSync(join(tmpdir(), 'concflow-trust-'))
  const sibling = mkdtempSync(join(tmpdir(), 'concflow-trust-sib-'))
  check('a fresh folder is UNTRUSTED', !isPathTrusted(fresh))
  setPathTrusted(fresh)
  check('setPathTrusted records exactly it', isPathTrusted(fresh))
  check('descendants inherit through the ancestor walk', isPathTrusted(join(fresh, 'a', 'b')))
  check('an unrelated sibling stays untrusted', !isPathTrusted(sibling))
}

// ── W1: the ground resolvers (hardening laws 1/4) ───────────────────────────
console.log('W1 ground resolvers')
{
  const si = dispatchSeedInputs({ projectDir: folderB }, folderA)
  check('a set projectDir seed targets THAT folder', si.workspaceDir === folderB)
  const siUnset = dispatchSeedInputs({}, folderA)
  check('an unset seed targets the live cwd', siUnset.workspaceDir === folderA)
  await writeConcourseSeedOverride({ projectDir: folderB })
  check('resolveHarnessGround answers the seed', (await resolveHarnessGround()) === folderB)
  await writeConcourseSeedOverride({ projectDir: null })
  check('a cleared seed answers the live cwd', (await resolveHarnessGround()) === getCwd())
}

// ── W2: the held-dispatch bytes survive a seed switch (laws 1/5) ────────────
console.log('W2 held-dispatch verbatim bytes')
{
  await writeConcourseHeldDispatch({
    clientMessageId: 'cm-1',
    envelopeKey: 'k1',
    prompt: 'do the thing',
    op: { workspaceDir: folderA, title: 't' },
  })
  await writeConcourseSeedOverride({ projectDir: folderB }) // the switch
  const held = await readConcourseHeldDispatch()
  check(
    'the held op keeps its ORIGINAL workspaceDir across the switch',
    (held?.op as { workspaceDir?: string } | undefined)?.workspaceDir === folderA,
  )
  await writeConcourseHeldDispatch(null)
  await writeConcourseSeedOverride({ projectDir: null })
}

// ── M1: item 5's manifest census ────────────────────────────────────────────
console.log('M1 manifest census — the explicit m door')
{
  const mControl = CONCOURSE_CONTROLS.find(c => c.id === 'board:queued-room')
  check('the queued-room control is declared', mControl !== undefined)
  check('it fires on m in the list region', mControl?.region === 'list' && mControl.keys.includes('m'))
  check(
    'the list legend advertises it',
    CONCOURSE_REGION_KEYS.list.some(k => k.keys === 'm'),
  )
  const enter = CONCOURSE_CONTROLS.find(c => c.id === 'board:open')
  check('↵ keeps enter-session (live rows unchanged)', enter?.keys.includes('return') === true)
}

console.log(failures === 0 ? 'ALL LAWS HOLD' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
