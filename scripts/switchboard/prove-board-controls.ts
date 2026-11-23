#!/usr/bin/env bun
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'board-controls-'))
delete process.env.MERCURY_HOME

const REPO = join(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  const shown = !cond && hint ? (detail ? `${detail} — ${hint}` : hint) : detail
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}


console.log('B — row controls i/p/m: manifest, selection-aware legend, receipts on the row')
{
  const manifest = await import('../../src/screen/concourse/controlManifest.ts')
  const byId = (id: string) => manifest.CONCOURSE_CONTROLS.find(c => c.id === id)
  check(
    'B1 the three controls are declared list-region controls with their keys and the row-control receipt',
    byId('board:interrupt')?.keys.includes('i') === true &&
      byId('board:pause-resume')?.keys.includes('p') === true &&
      byId('board:set-model')?.keys.includes('m') === true &&
      [byId('board:interrupt'), byId('board:pause-resume'), byId('board:set-model')].every(
        c => c?.region === 'list' && c.receipt === 'row-control',
      ),
    '',
    'fix the board:interrupt, board:pause-resume and board:set-model entries of CONCOURSE_CONTROLS in src/screen/concourse/controlManifest.ts (keys, region list, receipt row-control)',
  )
  const live = manifest.regionKeysFor('list', { newSession: true, selection: 'live' })
  const paused = manifest.regionKeysFor('list', { newSession: true, selection: 'paused' })
  const parked = manifest.regionKeysFor('list', { newSession: true, selection: 'parked' })
  const queued = manifest.regionKeysFor('list', { newSession: true, selection: 'queued' })
  const door = manifest.regionKeysFor('list', { newSession: true, selection: 'door' })
  check(
    'B2 a LIVE selection prints i interrupt · p pause · m model (the moves that exist)',
    live.some(k => k.keys === 'i' && k.label === 'interrupt') &&
      live.some(k => k.keys === 'p' && k.label === 'pause') &&
      live.some(k => k.keys === 'm' && k.label === 'model'),
    '',
    'fix the live case of regionKeysFor in src/screen/concourse/controlManifest.ts',
  )
  check('B2 a PAUSED selection flips p to resume (the toggle says its live half)', paused.some(k => k.keys === 'p' && k.label === 'resume'), '', 'fix the paused selection in regionKeysFor (p must read resume) in src/screen/concourse/controlManifest.ts')
  check(
    "B2 a PARKED selection dims to the reason — 'parked · ↵ brings it back' — and carries no i/p/m",
    parked.some(k => `${k.keys} ${k.label}` === 'parked · ↵ brings it back') &&
      parked.every(k => k.keys !== 'i' && k.keys !== 'p' && k.keys !== 'm'),
    '',
    'fix the parked case of regionKeysFor in src/screen/concourse/controlManifest.ts',
  )
  check(
    "B2 a QUEUED selection keeps m as 'message queued' and the close chord as 'withdraw' — never model, never stop",
    queued.some(k => k.keys === 'm' && k.label === 'message queued') &&
      queued.some(k => k.keys === '⌃x ⌃x' && k.label === 'withdraw') &&
      queued.every(k => k.keys !== 'i' && k.keys !== 'p' && k.label !== 'model' && k.label !== 'stop'),
    '',
    'fix the queued case of regionKeysFor in src/screen/concourse/controlManifest.ts',
  )
  check('B2 a DOOR selection says ↵ open and nothing session-shaped', door.some(k => k.keys === '↵' && k.label === 'open') && door.every(k => k.keys !== 'i' && k.keys !== 'p' && k.keys !== 'm' && k.keys !== '⌃x ⌃x' && k.keys !== 'x'), '', 'fix the door case of regionKeysFor in src/screen/concourse/controlManifest.ts')
  check(
    'B2 WITHOUT a selection the resolver answers the static census exactly (the older pins’ baseline)',
    JSON.stringify(manifest.regionKeysFor('list', { newSession: true })) === JSON.stringify(manifest.CONCOURSE_REGION_KEYS.list),
    '',
    'regionKeysFor with no selection must return CONCOURSE_REGION_KEYS.list unchanged; see src/screen/concourse/controlManifest.ts',
  )
  const cls = manifest.boardSelectionClassOf
  check(
    'B3 the ONE selection classifier: doors, queued, parked, attached, stopped, paused, live, none',
    cls(undefined) === 'none' &&
      cls({ sessionId: 'project:x', state: 'elsewhere', door: { kind: 'pick-project', more: 1 } }) === 'door' &&
      cls({ sessionId: 'older:/x', state: 'parked' }) === 'door' &&
      cls({ sessionId: 'dispatch:abc', state: 'queued' }) === 'queued' &&
      cls({ sessionId: 's1', state: 'parked' }) === 'parked' &&
      cls({ sessionId: 's1', state: 'attached' }) === 'attached' &&
      cls({ sessionId: 's1', state: 'stopped' }) === 'stopped' &&
      cls({ sessionId: 's1', state: 'paused' }) === 'paused' &&
      cls({ sessionId: 's1', state: 'working' }) === 'live' &&
      cls({ sessionId: 's1', state: 'needs-you' }) === 'live' &&
      cls({ sessionId: 's1', state: 'ready-to-review' }) === 'live',
    '',
    'fix boardSelectionClassOf in src/screen/concourse/controlManifest.ts so each state maps to the class named in the label',
  )
  check(
    "B9 the legend reads the line as the empty board's selection (no row under the cursor ⇒ n and the m phrase), never a session row's verbs",
    manifest.boardSelectionClassOf(undefined) === 'none' &&
      manifest.regionKeysFor('list', { newSession: true, selection: 'none', modelDefault: true }).some(k => k.keys === 'm' && k.label === 'to select model-default') &&
      manifest.regionKeysFor('list', { newSession: true, selection: 'none', modelDefault: true }).every(k => k.keys !== 'i' && k.keys !== 'p' && k.keys !== 'e'),
    '',
    'fix the none case of regionKeysFor and boardSelectionClassOf in src/screen/concourse/controlManifest.ts',
  )
  const manifest2 = manifest.regionKeysFor('list', { newSession: true, selection: 'live' })
  check('B2 a LIVE selection prints e effort beside m model (the WARMRUN rider’s key-map row)', manifest2.some(k => k.keys === 'e' && k.label === 'effort'), '', 'add the e effort key to the live case of regionKeysFor in src/screen/concourse/controlManifest.ts')
  const { publishSessionFacts } = await import('../../src/engine/connector/seatProjections.ts')
  const { DaemonSessionConnector } = await import('../../src/engine/connector/daemonConnector.ts')
  const plane = mkdtempSync(join(tmpdir(), 'board-controls-plane-'))
  const planeBefore = process.env.MERCURY_DAEMON_DIR
  process.env.MERCURY_DAEMON_DIR = plane
  const SETTLING = 'board-controls-settle'
  writeFileSync(join(plane, `${SETTLING}.jsonl`), '')
  const told = (atMs: number, more: Record<string, unknown>): void => publishSessionFacts({ schema: 1, sessionId: SETTLING, atMs, busy: false, pendingModel: null, model: { effective: 'claude-opus-5', setting: 'claude-opus-5' }, usage: {}, queue: [], ...more } as never)
  told(1_000, { pendingModel: 'fable' })
  const hosted = new DaemonSessionConnector({ sessionId: SETTLING, runnerId: 'runner-1', title: 'board controls', projectLabel: 'proof', workspaceId: plane, home: plane } as never, { rpc: async () => ({ ok: true }), armTranscriptWatcher: () => {}, armTranscriptTimer: () => {} })
  await hosted.attach()
  const settleNotes = (): Array<{ boundary?: string; resolution?: string; applied?: string | null }> => hosted.records().filter(m => (m as { type?: string }).type === 'system' && (m as { subtype?: string }).subtype === 'model_transition') as never
  told(2_000, { modelSettled: { from: 'claude-opus-5', to: 'fable', atMs: 1_900 } })
  for (let waited = 0; settleNotes().length === 0 && waited < 15_000; waited += 25) await new Promise(resolve => setTimeout(resolve, 25))
  const settled = settleNotes()
  hosted.detach()
  if (planeBefore === undefined) delete process.env.MERCURY_DAEMON_DIR
  else process.env.MERCURY_DAEMON_DIR = planeBefore
  check(
    'B7 the grey "model switched" note stays the connector’s own settle paint (the ruled shape — not rebuilt here)',
    settled.length === 1 && settled[0]!.boundary === 'turn-boundary' && settled[0]!.resolution === 'applied' && settled[0]!.applied === 'fable',
    `a hosted connector whose facts feed reads a settlement stamp paints ${JSON.stringify(settled)}: its facts read mints one model_transition row, applied at the turn boundary, naming the model as picked`,
    'the settle note comes from the DaemonSessionConnector in src/engine/connector/daemonConnector.ts reading modelSettled published by seatProjections.ts',
  )
}

console.log('C — the L17 cut: a session ask routes INTO the chat; no board key answers it')

console.log('D — permission ids: stable from birth to answer, across repaint/re-subscribe')
{
  const recDir = mkdtempSync(join(tmpdir(), 'board-controls-recs-'))
  const o = await import('../../src/crew/crewmates/obligations.ts')
  const first = await o.upsertObligation({
    ref: 'permission:req-stable-1',
    sessionId: 'sess-stable',
    question: '"worker" asks to run Bash — allow?',
    owner: 'operator',
    scope: 'switchboard',
  })
  const again = await o.upsertObligation({
    ref: 'permission:req-stable-1',
    sessionId: 'sess-stable',
    question: '"worker" asks to run Bash — allow? (re-raised)',
    owner: 'operator',
    scope: 'switchboard',
  })
  check('D1 one OPEN row per ref: a re-raise answers the SAME obligationId', first.obligationId === again.obligationId, `${first.obligationId} vs ${again.obligationId}`, 'upsertObligation in src/crew/crewmates/obligations.ts must reuse the open row with the same ref')
  const readA = await o.openObligations({ scope: 'switchboard' })
  const readB = await o.openObligations({ scope: 'switchboard' })
  const rowA = readA.find(x => x.ref === 'permission:req-stable-1')
  const rowB = readB.find(x => x.ref === 'permission:req-stable-1')
  check(
    'D2 two reads (a repaint, a re-subscribe) carry the SAME id and ref — and the ref recovers the child-minted requestId',
    rowA !== undefined &&
      rowB !== undefined &&
      rowA.obligationId === rowB.obligationId &&
      rowA.ref === rowB.ref &&
      rowA.ref?.slice('permission:'.length) === 'req-stable-1',
    '',
    'openObligations in src/crew/crewmates/obligations.ts must return the same obligationId and ref on every read',
  )
  const asks = await import('../../src/daemon/session-seat/permissionAsks.ts')
  const { updateConcourseWorkers } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
  const sid = '550e8400-e29b-41d4-a716-446655440077'
  updateConcourseWorkers(ws => {
    ws['concourse-w1'] = {
      schema: 1, workerId: 'concourse-w1', sessionId: sid, workspaceId: recDir,
      isolation: 'exclusive', modelKey: 'claude-fable-5',
      spawnedAt: 1, lastLiveAt: Date.now(), pid: process.pid,
    }
  }, recDir)
  const held = asks.holdWorkerAsk('concourse-w1', { kind: 'tool', tool_use_id: 'tu-stable-2', tool_name: 'Bash', input: { command: 'echo stable' } }, recDir, 60_000, () => 'attached')
  const parkedIds = asks.listPendingPermissionAsks().filter(a => a.workerId === 'concourse-w1').map(a => a.requestId)
  check('D3 one held request parks exactly ONE ask under a daemon-minted id — nothing forks', parkedIds.length === 1 && /^[0-9a-f-]{36}$/.test(parkedIds[0] ?? ''), JSON.stringify(parkedIds), 'holdWorkerAsk in src/daemon/session-seat/permissionAsks.ts must park one ask with a uuid requestId')
  const stableId = parkedIds[0] ?? ''
  const answered = asks.answerPermissionAsk(stableId, true, 'operator')
  const landed = await Promise.race([held.answer, new Promise<null>(r => setTimeout(() => r(null), 1_000))])
  check(
    "D4 the answer keys by the id ALONE and lands on THE ask (the runner's request resolves allow)",
    answered.outcome === 'applied' && landed !== null && landed.outcome === 'allow',
    JSON.stringify({ answered, landed }),
    'answerPermissionAsk in src/daemon/session-seat/permissionAsks.ts must apply the answer by requestId and resolve the held ask allow',
  )
  check(
    'D4 a second answer on the settled id REFUSES — a stale click can never re-target another ask',
    asks.answerPermissionAsk(stableId, true, 'operator').outcome === 'refused',
    '',
    'answerPermissionAsk in src/daemon/session-seat/permissionAsks.ts must refuse an id that is already settled',
  )
  const g1 = asks.mintGitInitAsk('/tmp/board-controls-folder')
  const g2 = asks.mintGitInitAsk('/tmp/board-controls-folder')
  check('D5 the git-init twin: the folder mints ONE deterministic id — a re-mint converges', g1.requestId === g2.requestId && g1.requestId.startsWith('git-init:'), '', 'mintGitInitAsk in src/daemon/session-seat/permissionAsks.ts must mint the same git-init: id for the same folder')
}

console.log('E — the seats cell: demand over the reading wears the warning ink; the strip paints context, receipt, hint in that order')
{
  const strips = await import('../../src/screen/concourse/ConcourseStrips.tsx')
  const overSnap = {
    counts: { live: 4 },
    groups: [
      { id: 'working', label: 'WORKING', rows: [{ sessionId: 'a', state: 'working' }] },
      {
        id: 'queued',
        label: 'QUEUED',
        rows: [
          { sessionId: 'dispatch:x', state: 'queued' },
          { sessionId: 'dispatch:y', state: 'queued', waitReason: 'repo-held' },
        ],
      },
    ],
  } as never
  check('E1 the demand fold counts live + seat-queued (a repo-held wait is not seat demand)', strips.seatDemandOf(overSnap) === 5, '', 'fix seatDemandOf in src/screen/concourse/ConcourseStrips.tsx (live plus seat-queued, not repo-held)')
  check(
    "E1 the chip reads `5/4` while over (the warning ink carries it, no words) and the plain live/reading when the demand fits",
    strips.seatsCellText(5, 4, 4).text === '5/4' &&
      strips.seatsCellText(5, 4, 4).over === true &&
      strips.seatsCellText(2, 2, 4).text === '2/4' &&
      strips.seatsCellText(2, 2, 4).over === false,
    '',
    'fix seatsCellText in src/screen/concourse/ConcourseStrips.tsx',
  )
}

console.log('F — the ground note: composed at dispatch from the REAL isolation fact, both shapes')

console.log('G — the git-offer No leg: deny proceeds lawfully; the copy tells each truth')
{
  const { mkdirSync: mkDir, writeFileSync: writeF } = await import('node:fs')
  const d = await import('../../src/daemon/concourse-workers/concourseDispatch.ts')
  const sup = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
  const denyDir = mkdtempSync(join(tmpdir(), 'board-controls-deny-'))
  const folder = mkdtempSync(join(tmpdir(), 'board-controls-plain-'))
  const canonical = sup.canonicalWorkspaceId(folder)
  mkDir(denyDir, { recursive: true })
  const heldRow = (id: string, acceptedAt: number, isolation?: string): Record<string, unknown> => ({
    schema: 1,
    clientMessageId: id,
    promptDigest: 'x',
    envelopeDigest: 'x',
    state: 'queued',
    stateRevision: 1,
    acceptedAt,
    workspaceId: canonical,
    heldReason: 'no-repository',
    title: `t-${id}`,
    heldOp: { prompt: 'p', workspaceDir: folder, ...(isolation !== undefined ? { isolation } : {}) },
  })
  writeF(
    join(denyDir, 'concourse-dispatches.json'),
    JSON.stringify({
      version: 1,
      dispatches: {
        'cm-default-new': heldRow('cm-default-new', 200),
        'cm-default-old': heldRow('cm-default-old', 100),
        'cm-explicit': heldRow('cm-explicit', 50, 'worktree-isolated'),
      },
    }),
  )
  check('G1 a claim-free folder frees exactly the OLDEST defaulted launch — one row, alone by design', JSON.stringify(d.denyProceedLaunchesFor(folder, denyDir).map(r => r.clientMessageId)) === JSON.stringify(['cm-default-old']), '', 'fix denyProceedLaunchesFor in src/daemon/concourse-workers/concourseDispatch.ts')
  check('G1 an explicit worktree pick is never overridden to exclusive — it is not in the gate', d.denyProceedLaunchesFor(folder, denyDir).every(r => r.clientMessageId !== 'cm-explicit'), '', 'denyProceedLaunchesFor in src/daemon/concourse-workers/concourseDispatch.ts must skip rows with an explicit isolation')
  const calls: Array<Record<string, unknown>> = []
  const stub = (async (req: Record<string, unknown>) => {
    calls.push(req)
    return { ok: true, clientMessageId: String(req.clientMessageId), state: 'working', stateRevision: 2, sessionId: 'sess-deny-1' }
  }) as never
  await d.replayDenyProceedDispatches(folder, stub, denyDir)
  check(
    'G2 the replay is VERBATIM — one call, the same id, and NO isolation injected (the defaulted fold admits it exclusive)',
    calls.length === 1 && calls[0]?.clientMessageId === 'cm-default-old' && !('isolation' in (calls[0] ?? {})),
    '',
    'fix replayDenyProceedDispatches in src/daemon/concourse-workers/concourseDispatch.ts to replay one call without adding isolation',
  )
  check('G2 the claim fold: a live record on the folder gates everything off', (() => {
    sup.updateConcourseWorkers(ws => {
      ws['concourse-w9'] = {
        schema: 1, workerId: 'concourse-w9', sessionId: 'sess-claim', workspaceId: canonical,
        isolation: 'exclusive', modelKey: 'claude-fable-5', spawnedAt: 1, lastLiveAt: Date.now(), pid: process.pid,
      }
    }, denyDir)
    const gated = d.folderClaimHeld(folder, denyDir) && d.denyProceedLaunchesFor(folder, denyDir).length === 0
    sup.updateConcourseWorkers(ws => {
      const w = ws['concourse-w9']
      if (w) w.parkedAt = Date.now()
    }, denyDir)
    return gated && d.folderClaimHeld(folder, denyDir) === false
  })(), '', 'fix folderClaimHeld and denyProceedLaunchesFor in src/daemon/concourse-workers/concourseDispatch.ts')
  const asks = await import('../../src/daemon/session-seat/permissionAsks.ts')
  const minted = asks.mintGitInitAsk(folder)
  const denied = asks.answerPermissionAsk(minted.requestId, false, 'operator', {
    onDenyProceed: () => [{ clientMessageId: 'cm-default-old', title: 'fix the parser' }],
  })
  check("G3 the deny receipt names what starts — 'in the folder as it is, alone'", denied.outcome === 'applied' && (denied.detail ?? '').includes('starting in the folder as it is, alone: fix the parser'), '', 'fix the deny receipt text of answerPermissionAsk in src/daemon/session-seat/permissionAsks.ts')
  const minted2 = asks.mintGitInitAsk(folder)
  const denied2 = asks.answerPermissionAsk(minted2.requestId, false, 'operator', { onDenyProceed: () => [] })
  check('G3 a held folder speaks the queued truth', denied2.outcome === 'applied' && (denied2.detail ?? '').includes('stays queued until the folder frees or git lands'), '', 'fix the held-folder receipt text of answerPermissionAsk in src/daemon/session-seat/permissionAsks.ts')
  const card = await import('../../src/screen/concourse/GitOfferCard.tsx')
  check(
    'G4 the No label splits by the folder state (short enough for the wide pane row)',
    card.gitOfferNoLabel(false) === 'No — run here as it is, alone (esc)' && card.gitOfferNoLabel(true) === 'No, keep the folder as it is (esc)',
    '',
    'fix gitOfferNoLabel in src/screen/concourse/GitOfferCard.tsx',
  )
  check(
    "G4 the description tells each leg's whole ruled truth",
    card.gitOfferDescription('/x', false).includes('runs the session in this folder as it is, alone — no isolated copy is made') &&
      card.gitOfferDescription('/x', true).includes('stays queued until the folder frees or git lands'),
    '',
    'fix gitOfferDescription in src/screen/concourse/GitOfferCard.tsx',
  )
  const heldSnap = {
    groups: [{ id: 'working', label: 'W', rows: [{ sessionId: 's', state: 'working', workspaceDir: '/x/plain' }] }],
  } as never
  const parkedSnap = {
    groups: [{ id: 'parked', label: 'P', rows: [{ sessionId: 's', state: 'parked', workspaceDir: '/x/plain' }] }],
  } as never
  const elsewhereSnap = { groups: [], elsewhere: [{ dir: '/x/plain', key: 'k', name: 'plain', running: 1, needsYou: 0, finished: 0 }] } as never
  check(
    "G5 the board's split fact mirrors the claim fold: a live row or another project's runners hold; parked holds nothing",
    card.gitOfferFolderHeld(heldSnap, '/x/plain') === true &&
      card.gitOfferFolderHeld(parkedSnap, '/x/plain') === false &&
      card.gitOfferFolderHeld(elsewhereSnap, '/x/plain') === true,
    '',
    'fix gitOfferFolderHeld in src/screen/concourse/GitOfferCard.tsx to mirror folderClaimHeld',
  )
}

console.log('H — the session model picker follows the selected session facts')
{
}

process.exit(failures === 0 ? 0 : 1)
