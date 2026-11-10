#!/usr/bin/env bun
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
enableConfigs()
const { dispatchSeedInputs, resolveHarnessGround, writeConcourseHeldDispatch, readConcourseHeldDispatch, writeConcourseSeedOverride } = await import(
  '../../src/services/concourse/concourseSnapshot.js'
)
const { CONCOURSE_CONTROLS, CONCOURSE_REGION_KEYS } = await import(
  '../../src/components/concourse/controlManifest.js'
)
const { getCwd } = await import('../../src/utils/cwd.js')

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

console.log('G4 the deny leg')
{
  const minted = mintGitInitAsk(folderA)
  const r = answerPermissionAsk(minted.requestId, false, 'prover')
  check('deny applies with the kept-without-git receipt', r.outcome === 'applied' && (r.detail ?? '').includes('kept without git'), r.detail ?? '')
  check('the folder still has no .git', !existsSync(join(folderA, '.git')))
  check('the pending ask settled', listPendingPermissionAsks().every(a => a.requestId !== minted.requestId))
}

console.log('G5 an answer for a git offer the daemon does not hold')
{
  const { upsertObligation, obligationOf } = await import('../../src/services/crew/obligations.js')
  const statusSoon = async (obligationId: string, want: string): Promise<string> => {
    let status = 'unknown'
    for (let i = 0; i < 40; i++) {
      status = (await obligationOf(obligationId, { scope: 'switchboard' }))?.status ?? 'unknown'
      if (status === want) break
      await new Promise(r => setTimeout(r, 50))
    }
    return status
  }
  const unheld = await upsertObligation({
    ref: 'permission:git-init:deadbeef0001',
    sessionId: `folder:${folderB}-unheld`,
    question: `this folder has no git — start one in ${folderB}-unheld so sessions can fork it?`,
    owner: 'operator',
    scope: 'switchboard',
  })
  const refused = answerPermissionAsk('git-init:deadbeef0001', false, 'prover')
  check('the daemon refuses it: it holds no such ask', refused.outcome === 'refused' && /unknown or already-answered/.test(refused.detail ?? ''), JSON.stringify(refused))
  check('the obligation behind the card is withdrawn, so the card that can never be answered leaves the board', (await statusSoon(unheld.obligationId, 'withdrawn')) === 'withdrawn', (await obligationOf(unheld.obligationId, { scope: 'switchboard' }))?.status ?? '(no row)')
  const held = mintGitInitAsk(folderB)
  let heldRow: Awaited<ReturnType<typeof openObligations>>[number] | undefined
  for (let i = 0; i < 40 && heldRow === undefined; i++) {
    heldRow = (await openObligations({ scope: 'switchboard' })).find(r => r.ref === `permission:${held.requestId}`)
    if (heldRow === undefined) await new Promise(r => setTimeout(r, 50))
  }
  answerPermissionAsk('git-init:deadbeef0002', false, 'prover')
  await new Promise(r => setTimeout(r, 300))
  check('a held offer is untouched by an answer aimed at another reference', heldRow !== undefined && (await obligationOf(heldRow.obligationId, { scope: 'switchboard' }))?.status === 'open' && listPendingPermissionAsks().some(a => a.requestId === held.requestId))
  const runnerAsk = await upsertObligation({
    ref: 'permission:0d0f6c0e-0000-4000-8000-00000000beef',
    sessionId: 'session-of-a-runner',
    question: '"probe" asked to run Bash',
    owner: 'operator',
    scope: 'switchboard',
  })
  const runnerRefused = answerPermissionAsk('0d0f6c0e-0000-4000-8000-00000000beef', true, 'prover')
  await new Promise(r => setTimeout(r, 300))
  check("a runner's ask this daemon does not hold is refused and its row stays (the board's own sweep retires it with its session)", runnerRefused.outcome === 'refused' && (await obligationOf(runnerAsk.obligationId, { scope: 'switchboard' }))?.status === 'open')
}

console.log('G6 a settlement never takes the row of an offer raised again for the same folder')
{
  const { upsertObligation, obligationOf } = await import('../../src/services/crew/obligations.js')
  const openFor = async (requestId: string): Promise<Awaited<ReturnType<typeof openObligations>>> =>
    (await openObligations({ scope: 'switchboard' })).filter(r => r.ref === `permission:${requestId}`)
  const openSoon = async (requestId: string): Promise<boolean> => {
    for (let i = 0; i < 40; i++) {
      if ((await openFor(requestId)).length > 0) return true
      await new Promise(r => setTimeout(r, 50))
    }
    return false
  }
  const settledSoon = async (obligationId: string): Promise<string> => {
    let status = 'open'
    for (let i = 0; i < 40 && status === 'open'; i++) {
      status = (await obligationOf(obligationId, { scope: 'switchboard' }))?.status ?? 'unknown'
      if (status === 'open') await new Promise(r => setTimeout(r, 50))
    }
    return status
  }
  const heldNow = (requestId: string): boolean => listPendingPermissionAsks().some(a => a.requestId === requestId)

  const folderC = mkdtempSync(join(tmpdir(), 'concflow-folder-c-'))
  const first = mintGitInitAsk(folderC) as { requestId: string }
  await openSoon(first.requestId)
  const firstRow = (await openFor(first.requestId))[0]
  answerPermissionAsk(first.requestId, false, 'prover')
  check('the scene: the first offer for the folder is answered and its row settles', firstRow !== undefined && (await settledSoon(firstRow.obligationId)) === 'answered')
  await upsertObligation({ ref: `permission:${first.requestId}`, sessionId: `folder:${folderC}`, question: 'this folder has no git — start one?', owner: 'operator', scope: 'switchboard' })
  const unheldAnswer = answerPermissionAsk(first.requestId, false, 'prover')
  const raisedAgain = mintGitInitAsk(folderC) as { requestId: string }
  await new Promise(r => setTimeout(r, 700))
  check('an unheld offer is refused, and the offer raised again in the same breath keeps its one card (the withdrawal decides inside the store, on an offer still unheld)', unheldAnswer.outcome === 'refused' && raisedAgain.requestId === first.requestId && heldNow(first.requestId) && (await openFor(first.requestId)).length === 1, JSON.stringify({ held: heldNow(first.requestId), open: (await openFor(first.requestId)).length }))

  const folderD = mkdtempSync(join(tmpdir(), 'concflow-folder-d-'))
  const offer = mintGitInitAsk(folderD) as { requestId: string }
  await openSoon(offer.requestId)
  const said = answerPermissionAsk(offer.requestId, false, 'prover')
  const offeredAgain = mintGitInitAsk(folderD) as { requestId: string }
  await new Promise(r => setTimeout(r, 700))
  check('a held offer answered No, and the offer raised again in the same breath keeps its one card (the answer settles its own offer, never the next one)', said.outcome === 'applied' && offeredAgain.requestId === offer.requestId && heldNow(offer.requestId) && (await openFor(offer.requestId)).length === 1, JSON.stringify({ held: heldNow(offer.requestId), open: (await openFor(offer.requestId)).length }))
  answerPermissionAsk(offer.requestId, false, 'prover')
  await new Promise(r => setTimeout(r, 700))
  check('…and with nothing raised after it, the answer settles the row as before', !heldNow(offer.requestId) && (await openFor(offer.requestId)).length === 0, JSON.stringify({ open: (await openFor(offer.requestId)).length }))

  const folderE = mkdtempSync(join(tmpdir(), 'concflow-folder-e-'))
  const early = mintGitInitAsk(folderE) as { requestId: string }
  await openSoon(early.requestId)
  answerPermissionAsk(early.requestId, false, 'prover')
  await new Promise(r => setTimeout(r, 700))
  const stale = await upsertObligation({ ref: `permission:${early.requestId}`, sessionId: `folder:${folderE}`, question: 'this folder has no git — start one?', owner: 'operator', scope: 'switchboard' })
  answerPermissionAsk(early.requestId, false, 'prover')
  const staleStatus = await settledSoon(stale.obligationId)
  const later = mintGitInitAsk(folderE) as { requestId: string }
  const fresh = (await openSoon(later.requestId)) ? (await openFor(later.requestId))[0] : undefined
  check('an unheld offer answered with nothing raised beside it is withdrawn, and the offer raised after that gets a fresh card', staleStatus === 'withdrawn' && heldNow(later.requestId) && fresh !== undefined && fresh.obligationId !== stale.obligationId, JSON.stringify({ staleStatus, fresh: fresh?.obligationId, stale: stale.obligationId }))

  const folderF = mkdtempSync(join(tmpdir(), 'concflow-folder-f-'))
  const twice = mintGitInitAsk(folderF) as { requestId: string }
  await openSoon(twice.requestId)
  const twiceRow = (await openFor(twice.requestId))[0]
  const firstSay = answerPermissionAsk(twice.requestId, false, 'operator')
  const secondSay = answerPermissionAsk(twice.requestId, false, 'operator')
  await new Promise(r => setTimeout(r, 700))
  const twiceAfter = twiceRow !== undefined ? await obligationOf(twiceRow.obligationId, { scope: 'switchboard' }) : null
  check("a held offer answered twice in one breath ends answered by the operator: the second answer's withdrawal never wins", firstSay.outcome === 'applied' && secondSay.outcome === 'refused' && twiceAfter?.status === 'answered' && twiceAfter.settlement?.by === 'operator', JSON.stringify({ status: twiceAfter?.status, by: twiceAfter?.settlement?.by }))
}

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

console.log('W2 held-dispatch verbatim bytes')
{
  await writeConcourseHeldDispatch({
    clientMessageId: 'cm-1',
    envelopeKey: 'k1',
    prompt: 'do the thing',
    op: { workspaceDir: folderA, title: 't' },
  })
  await writeConcourseSeedOverride({ projectDir: folderB })
  const held = await readConcourseHeldDispatch()
  check(
    'the held op keeps its ORIGINAL workspaceDir across the switch',
    (held?.op as { workspaceDir?: string } | undefined)?.workspaceDir === folderA,
  )
  await writeConcourseHeldDispatch(null)
  await writeConcourseSeedOverride({ projectDir: null })
}

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
