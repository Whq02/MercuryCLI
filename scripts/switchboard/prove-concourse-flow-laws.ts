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
  const r = answerPermissionAsk(minted.requestId, false, undefined, 'prover')
  check('deny applies with the kept-without-git receipt', r.outcome === 'applied' && (r.detail ?? '').includes('kept without git'), r.detail ?? '')
  check('the folder still has no .git', !existsSync(join(folderA, '.git')))
  check('the pending ask settled', listPendingPermissionAsks().every(a => a.requestId !== minted.requestId))
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
