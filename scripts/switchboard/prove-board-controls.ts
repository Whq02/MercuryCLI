#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-board-controls.ts — the BOARD CONTROLS contract,
//  pinned.
//
//  ITEM 1 — row controls i/p/m on the selected LIVE row: the verbs ride the
//  EXISTING concourseControl family (no verb added — the no-new-verb poison
//  is A-class below); the key-map row says only the moves that exist here
//  and now (the present-moves law, selection-aware); every control paints a
//  typed who/what/when receipt ON the row; a parked selection dims to its
//  reason. The chat's grey "model switched" note stays the connector's own
//  settle paint (the ruled shape) — verified, never rebuilt.
//
//  ITEM 2 — the L17 cut: no board key answers a SESSION permission ask; a
//  needs-you row routes INTO the chat; answer-permission stays chat-side
//  plumbing (the folder-scoped git-init offer card is the one named
//  exception — no chat exists behind it).
//
//  ITEM 3 — the permission-id stability law: one id from ask-birth to
//  answer, across repaint and re-subscribe.
//
//  ITEM 4 — the seat-overload ask: dispatching past the machine reading is
//  a consent card EVERY TIME (never silent, never remembered-away);
//  declining dispatches nothing; the rail chip reads `5/4·` while over.
//
//  ITEM 6 — the isolation-awareness note: every dispatched agent's prompt
//  opens with the 2–4 line ground note composed from the admission's REAL
//  isolation fact (both shapes), and the crew pack opens with the shared-
//  folder shape.
//
//  Pure calls where a pure fold exists; composed source needles where the
//  law is wiring. Hermetic: scratch config home; no daemon, no wire.
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'board-controls-'))
delete process.env.MERCURY_HOME

const REPO = join(import.meta.dir, '..', '..')
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── A: the no-new-verb law (the handshake law's poison) ─────────────────────
console.log('A — the verb family is the LANDED one; this lane added no daemon verb')
{
  const protocol = read('src/daemon/protocol.ts')
  const server = read('src/daemon/controlServer.ts')
  for (const verb of ['pause', 'resume', 'interrupt', 'set-model', 'session-facts']) {
    check(`A1 concourseControl carries '${verb}' (the controls build on it)`, protocol.includes(`'${verb}'`) && server.includes(`'${verb}'`))
  }
  // THE e DOOR (lead-ruled): the wire's 'set-effort' action is LANE
  // the daemon registration — its proto bump folds BEFORE this key, so
  // main never carries the e key without the door. On this branch ALONE
  // the door is absent and this row is expected red (written, never run;
  // the pool runs after both folds).
  check("A2 the wire carries 'set-effort' (the daemon door — fold-ordered before this key)", protocol.includes("'set-effort'") && server.includes("'set-effort'"))
  const route = read('src/components/concourse/ConcourseRoute.tsx')
  // The lead's poison for e: on a live row the key fires EXACTLY ONE
  // set-effort with the field — one call site, one in-flight latch, the
  // effort field on the call.
  const effortCalls = route.split("action: 'set-effort'").length - 1
  check(
    "A5 poison — e fires exactly one set-effort with the `effort` field, latched against duplicates",
    effortCalls === 1 &&
      route.includes("{ op: 'concourseControl', action: 'set-effort', sessionId, by: 'operator', effort }") &&
      route.includes("peekOpInFlight.current.has('row:effort')"),
  )
  check(
    'A3 the row controls speak the EXISTING verbs — i → interrupt, m → set-model, both op concourseControl',
    route.includes("{ op: 'concourseControl', action: 'interrupt', sessionId, by: 'operator', clientOpId }") &&
      route.includes("{ op: 'concourseControl', action: 'set-model', sessionId, by: 'operator', model: modelId }"),
  )
  check(
    'A4 p rides the kernel pair (session.pause / session.resume) — the parity path, not a second owner',
    route.includes("verb: 'session.pause'") && route.includes("verb: 'session.resume'"),
  )
}

// ── B: item 1 — the row controls, the present-moves key-map, the receipts ───
console.log('B — row controls i/p/m: manifest, selection-aware legend, receipts on the row')
{
  const manifest = await import('../../src/components/concourse/controlManifest.ts')
  const byId = (id: string) => manifest.CONCOURSE_CONTROLS.find(c => c.id === id)
  check(
    'B1 the three controls are declared list-region controls with their keys and the row-control receipt',
    byId('board:interrupt')?.keys.includes('i') === true &&
      byId('board:pause-resume')?.keys.includes('p') === true &&
      byId('board:set-model')?.keys.includes('m') === true &&
      [byId('board:interrupt'), byId('board:pause-resume'), byId('board:set-model')].every(
        c => c?.region === 'list' && c.receipt === 'row-control',
      ),
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
  )
  check('B2 a PAUSED selection flips p to resume (the toggle says its live half)', paused.some(k => k.keys === 'p' && k.label === 'resume'))
  check(
    "B2 a PARKED selection dims to the reason — 'parked · ↵ brings it back' — and carries no i/p/m",
    parked.some(k => `${k.keys} ${k.label}` === 'parked · ↵ brings it back') &&
      parked.every(k => k.keys !== 'i' && k.keys !== 'p' && k.keys !== 'm'),
  )
  check(
    "B2 a QUEUED selection keeps m as 'message queued' and the close chord as 'withdraw' — never model, never stop",
    queued.some(k => k.keys === 'm' && k.label === 'message queued') &&
      queued.some(k => k.keys === '⌃x ⌃x' && k.label === 'withdraw') &&
      queued.every(k => k.keys !== 'i' && k.keys !== 'p' && k.label !== 'model' && k.label !== 'stop'),
  )
  check('B2 a DOOR selection says ↵ open and nothing session-shaped', door.some(k => k.keys === '↵' && k.label === 'open') && door.every(k => k.keys !== 'i' && k.keys !== 'p' && k.keys !== 'm' && k.keys !== '⌃x ⌃x' && k.keys !== 'x'))
  check(
    'B2 WITHOUT a selection the resolver answers the static census exactly (the older pins’ baseline)',
    JSON.stringify(manifest.regionKeysFor('list', { newSession: true })) === JSON.stringify(manifest.CONCOURSE_REGION_KEYS.list),
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
  )
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check(
    'B4 the screen guards through the same classifier — one fold for keys and legend',
    screen.includes('const rowControlSel = ') && screen.includes('boardSelectionClassOf(sel)'),
  )
  check(
    'B4 i fires only in the list region with the door wired; p toggles by the paused state; m keeps its queued meaning first',
    screen.includes("if (input === 'i' && !key.ctrl && !key.meta && callbacks.interruptSession !== undefined && pastGate())") &&
      screen.includes("if (target.row.state === 'paused') callbacks.resumeSession(target.row.sessionId)") &&
      screen.indexOf("sel?.sessionId.startsWith('dispatch:') === true") !== -1 && screen.indexOf("sel?.sessionId.startsWith('dispatch:') === true") < screen.indexOf("setRowPick({ kind: 'model', sessionId: target.row.sessionId"),
  )
  check(
    'B4 the row pick modal (model AND effort — one grammar) is declared and owns the keys while open (through the ONE modal owner)',
    screen.includes('rowPick: rowPickRef.current !== null,') &&
      screen.includes("if (modalOwner !== null && modalOwner !== 'manager-seat-ask' && modalOwner !== 'manager-card') return") &&
      // The one grammar now lives in its own home (the coordinator effort
      // dial made it a two-doorway UI): the screen mounts the SAME moved
      // component, never a second declaration.
      screen.includes("import { RowPickModal } from './RowPickModal.js'") &&
      !screen.includes('function RowPickModal('),
  )
  check(
    "B4 the model rows are the SESSION-dispatchable set from the one snapshot owner; the effort rows are the shared ladder",
    screen.includes('(snapshot.newSession.modelOptions ?? []).map(o => ({ id: o.modelId, label: o.displayName }))') &&
      screen.includes('EFFORT_LEVELS.map(l => ({ id: l, label: l }))'),
  )
  check(
    'B4 e fires only in the list region with the door wired, through the same live-row guard as i/p/m',
    screen.includes("if (input === 'e' && !key.ctrl && !key.meta && callbacks.setSessionEffort !== undefined && pastGate())"),
  )
  const manifest2 = manifest.regionKeysFor('list', { newSession: true, selection: 'live' })
  check('B2 a LIVE selection prints e effort beside m model (the WARMRUN rider’s key-map row)', manifest2.some(k => k.keys === 'e' && k.label === 'effort'))
  const route = read('src/components/concourse/ConcourseRoute.tsx')
  check(
    "B5 every row control settles on the row's ONE receipt slot (board:row-control) with who/what/when",
    route.includes("const rowReceipt = (what: string): string => `${what} — you · ${rowReceiptClock()}`") &&
      route.includes("reason: `paused by you · ${rowReceiptClock()}`") &&
      route.includes("rowReceipt('resumed')") &&
      route.includes("rowReceipt('interrupted · idle')") &&
      route.includes('rowReceipt(`model → ${spoken}`)'),
  )
  check(
    'B5 the retired peek note keys are gone — the receipts paint where the operator looks',
    !route.includes("'peek:pause-after-turn'") && !route.includes("'peek:resume'"),
  )
  check(
    'B6 the receipt line rides the selected row (the chip slot), keyed BY ROW so it never follows the cursor; it outranks the chip for its beat',
    screen.includes("controlNotes?.[`board:row-control:${peekSelRow?.sessionId ?? 'none'}`]") &&
      route.includes('noteControl(`board:row-control:${sessionId}`,') &&
      screen.includes('const receiptNode = (() => {') &&
      screen.includes('it outranks the chip for its beat') &&
      screen.includes(
        "!rowPeekOpen && (chipLine !== null || rowControlNote !== undefined || boardArmed === peekSelRow?.sessionId || closeChordHint !== null) ? 1 : 0",
      ),
  )
  check(
    'B5 a parked model switch stays the daemon’s HELD truth on the row (queued → held, the daemon’s own sentence)',
    route.includes("reply.ok === true && reply.outcome === 'queued'") && route.includes('applies when this turn ends'),
  )
  const connector = read('src/services/engine-connector/daemonConnector.ts')
  check(
    'B7 the grey "model switched" note stays the connector’s own settle paint (the ruled shape — not rebuilt here)',
    connector.includes('createModelTransitionMessage({') && connector.includes("boundary: 'turn-boundary'"),
  )
  const workerModels = read('src/services/concourse/workerModels.ts')
  check(
    'B8 haiku rides the SESSION arm wherever its family is credentialed — the never-Haiku law binds the crew arm only',
    workerModels.includes('holds for the AUTONOMOUS crew only') && workerModels.includes("refusal: 'worker-policy:frontier-only'"),
  )
}

// ── C: item 2 — the L17 cut (no answering from the board) ───────────────────
console.log('C — the L17 cut: a session ask routes INTO the chat; no board key answers it')
{
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  // The retired grammar is GONE, structurally: no permission compose
  // context, no y/n permission handler, no permission context line.
  check("C1 the ComposeContext union carries no 'permission' member", !screen.includes("kind: 'permission'"))
  check(
    'C1 no y/n permission grammar on the board (the handler and its context line are gone)',
    !screen.includes("ctx.kind === 'permission'") && !screen.includes('y allows · n denies'),
  )
  check(
    "C2 a needs-you permission row ROUTES into the chat — beginAnswer's permission branch opens the session, never a context",
    screen.includes('// THE L17 CUT: a session\'s permission ask is never answered from the') &&
      screen.indexOf("if (ref.startsWith('permission:git-init:')) {") !== -1 && screen.indexOf("if (ref.startsWith('permission:')) {") > screen.indexOf("if (ref.startsWith('permission:git-init:')) {") &&
      /if \(ref\.startsWith\('permission:'\)\) \{[\s\S]{0,400}?openObligationOrDoor\(obligationId\)[\s\S]{0,40}?return/.test(screen),
  )
  // THE POISON: the ONLY board call sites of the answer-permission door are
  // the git-offer card's two mounts — and the card derives EXCLUSIVELY from
  // folder-scoped git-init obligations, so no SESSION ask can reach the
  // verb from any board keypress.
  const answerSites = screen.split('callbacks.answerPermission?.(').length - 1
  check('C3 poison — exactly two answer-permission call sites remain on the screen (both the git card wires)', answerSites === 2)
  const gitCard = read('src/components/concourse/GitOfferCard.tsx')
  check(
    'C3 poison — the card derives ONLY from folder-scoped git-init asks (ref + folder: subject, both required)',
    gitCard.includes("o.ref?.startsWith('permission:git-init:') === true && o.sessionId.startsWith('folder:')"),
  )
  const { deriveGitOffer } = await import('../../src/components/concourse/GitOfferCard.tsx')
  check(
    'C3 poison — a SESSION permission ask derives NO card (the verb is unreachable for it)',
    deriveGitOffer([{ obligationId: 'o1', sessionId: 'session-1', ref: 'permission:req-77' }]) === undefined &&
      deriveGitOffer([{ obligationId: 'o2', sessionId: 'folder:/tmp/x', ref: 'permission:git-init:abc' }]) !== undefined,
  )
  // The verb stays CHAT-SIDE plumbing: the wire keeps answer-permission
  // (the chat's consent card and the folder card ride it) — the cut removes
  // reachability from board keys, never the door itself.
  check("C4 the answer-permission verb itself stands (chat-side plumbing)", read('src/daemon/protocol.ts').includes("'answer-permission'"))
  const contracts = read('src/components/concourse/contracts.ts')
  check('C4 the contract records the cut beside the door', contracts.includes('THE L17 CUT (board controls, item 2)'))
}

// ── D: item 3 — the permission-id stability law ─────────────────────────────
//  One id from ask-birth to answer, across repaint and re-subscribe: the
//  child mints the requestId once; the obligation ref carries it (ONE open
//  row per ref); every snapshot rebuild re-reads the same durable row; the
//  answer keys by the id ALONE — an answer sent after a board repaint can
//  never land on a different ask than the one painted.
console.log('D — permission ids: stable from birth to answer, across repaint/re-subscribe')
{
  const recDir = mkdtempSync(join(tmpdir(), 'board-controls-recs-'))
  const o = await import('../../src/services/crew/obligations.ts')
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
  check('D1 one OPEN row per ref: a re-raise answers the SAME obligationId', first.obligationId === again.obligationId, `${first.obligationId} vs ${again.obligationId}`)
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
  )
  // The mint side: a re-published frame after a repaint parks NOTHING new —
  // the pending identity guard makes the id unforkable.
  const asks = await import('../../src/daemon/permissionAsks.ts')
  const { updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
  const sid = '550e8400-e29b-41d4-a716-446655440077'
  updateConcourseWorkers(ws => {
    ws['concourse-w1'] = {
      schema: 1, workerId: 'concourse-w1', sessionId: sid, workspaceId: recDir,
      isolation: 'exclusive', modelKey: 'claude-fable-5',
      spawnedAt: 1, lastLiveAt: Date.now(), pid: process.pid,
    }
  }, recDir)
  const frame = {
    type: 'control_request',
    request_id: 'req-stable-2',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo stable' } },
  }
  asks.onWorkerControlRequest('concourse-w1', frame, recDir)
  const before = asks.listPendingPermissionAsks().filter(a => a.requestId === 'req-stable-2').length
  asks.onWorkerControlRequest('concourse-w1', frame, recDir)
  const after = asks.listPendingPermissionAsks().filter(a => a.requestId === 'req-stable-2').length
  check('D3 a duplicate control_request (the same minted id) parks nothing new — the id cannot fork', before === 1 && after === 1)
  const frames: Array<{ short: string; frame: string }> = []
  const roster = { control: (short: string, f: string) => (frames.push({ short, frame: f }), true) }
  const answered = asks.answerPermissionAsk('req-stable-2', true, roster, 'operator')
  const sent = JSON.parse(frames[0]?.frame ?? '{}') as { response?: { request_id?: string } }
  check(
    'D4 the answer keys by the id ALONE and lands on THE ask (the response carries the same request_id)',
    answered.outcome === 'applied' && sent.response?.request_id === 'req-stable-2',
  )
  check(
    'D4 a second answer on the settled id REFUSES — a stale click can never re-target another ask',
    asks.answerPermissionAsk('req-stable-2', true, roster, 'operator').outcome === 'refused',
  )
  const g1 = asks.mintGitInitAsk('/tmp/board-controls-folder')
  const g2 = asks.mintGitInitAsk('/tmp/board-controls-folder')
  check('D5 the git-init twin: the folder mints ONE deterministic id — a re-mint converges', g1.requestId === g2.requestId && g1.requestId.startsWith('git-init:'))
  const snapshotSrc = read('src/services/concourse/concourseSnapshot.ts')
  check(
    'D6 the board carries the ref VERBATIM into needsYou (the painted id IS the durable id)',
    snapshotSrc.includes("...(o.ref !== undefined ? { ref: o.ref } : {})"),
  )
  check(
    "D6 the chat's card answers by the SAME id — the seat projection publishes each ask under its requestId",
    read('src/daemon/permissionAsks.ts').includes('toolUseId: a.toolUseId ?? requestId,'),
  )
}

// ── E: item 4 — the seat-overload ask + the `5/4·` chip ─────────────────────
console.log('E — the seat-overload ask: every time, never silent, never remembered; declining dispatches nothing')
{
  const card = await import('../../src/components/concourse/SeatOverloadCard.tsx')
  check(
    'E1 the pure gate: at the reading the ask arms; under it nothing asks; past it it still asks',
    card.needsSeatOverloadAsk(4, 4) === true && card.needsSeatOverloadAsk(3, 4) === false && card.needsSeatOverloadAsk(5, 4) === true && card.needsSeatOverloadAsk(0, 2) === false,
  )
  const cardSrc = read('src/components/concourse/SeatOverloadCard.tsx')
  check(
    'E2 the consent card IS PermissionDialog composed (item 7) — the estate’s real owners, verbatim, with the one reading sentence',
    cardSrc.includes("from '../permissions/PermissionDialog.js'") &&
      cardSrc.includes("from '../permissions/PermissionPrompt.js'") &&
      cardSrc.includes('describeSeatReading(ceiling)'),
  )
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check(
    'E3 the submit gates EVERY TIME — the gate is the pure fold at the gesture, and no answer persists anywhere',
    screen.includes('if (needsSeatOverloadAsk(snapshot.counts.live, effectiveSeatCeiling()))') &&
      (() => {
        const at = screen.indexOf('const answerSeatAsk = ')
        const body = screen.slice(at, screen.indexOf('// ── the ONE-TIME capacity ask', at))
        return at > 0 && !body.includes('saveGlobalConfig') && !body.includes('recordCapacityDecision') && !body.includes('writeConcourse')
      })(),
  )
  check(
    'E4 declining dispatches NOTHING — the decline leg returns before any dispatch call, the draft stays',
    (() => {
      const at = screen.indexOf('if (!allowed) {')
      const decline = at > 0 ? screen.slice(at, screen.indexOf('}', screen.indexOf('return', at))) : ''
      return decline.includes('nothing dispatched') && !decline.includes('submitSessionDraft')
    })(),
  )
  check(
    'E5 allowing proceeds through the SAME pair the ungated submit rides — never a second dispatch door',
    screen.includes('void callbacks.sendCoordinatorMessage?.(ask.text).catch(() => {})') &&
      screen.includes('callbacks.submitSessionDraft(ask.text)'),
  )
  check(
    'E6 one Select listens at a time — the git offer’s two mounts yield while the seat card stands, and the key stream has ONE declared owner (seat-ask outranks git-offer in boardModalOwner)',
    screen.includes("gitOffer !== undefined && seatAsk === null && !contractAsk && geo.profile === 'wide'") &&
      // The narrow (stacked) mount asks the ONE owner table whether the git
      // offer holds the keys — the seat ask, the pickers and the asks that
      // outrank it all answer through boardModalOwner, never a second guard.
      /gitOffer !== undefined &&\s*\n\s*!contractAsk &&\s*\n\s*geo\.profile !== 'wide' &&/.test(screen) &&
      screen.includes('gitOfferOwnsTheKeys({') &&
      screen.includes('seatAsk: seatAsk !== null,') &&
      screen.includes('seatAsk: seatAskRef.current !== null,') &&
      screen.includes('const modalOwner = boardModalOwner({') &&
      (() => {
        const owner = read('src/components/concourse/boardModalOwner.ts')
        return owner.includes("return boardModalOwner(facts) === 'git-offer'") && owner.includes("if (facts.seatAsk) return 'seat-ask'") && owner.indexOf("if (facts.seatAsk) return 'seat-ask'") < owner.indexOf("if (facts.gitOffer) return 'git-offer'")
      })(),
  )
  const strips = await import('../../src/components/concourse/ConcourseStrips.tsx')
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
  check('E7 the demand fold counts live + seat-queued (a repo-held wait is not seat demand)', strips.seatDemandOf(overSnap) === 5)
  check(
    "E7 the chip reads `5/4·` while over and the plain live/reading when the demand fits",
    strips.seatsCellText(5, 4, 4).text === '5/4·' &&
      strips.seatsCellText(5, 4, 4).over === true &&
      strips.seatsCellText(2, 2, 4).text === '2/4' &&
      strips.seatsCellText(2, 2, 4).over === false,
  )
  const stripsSrc = read('src/components/concourse/ConcourseStrips.tsx')
  check(
    'E7 the rail wears the over mark in warning ink on the ONE seats cell (and the budget line carries the same spelling)',
    stripsSrc.includes('seatsCell.over ? t.warning : t.textSecondary') &&
      stripsSrc.includes('${seatsCell.text} seats'),
  )
  // THE META-ROW SLOT LAW: one slot, three claimants — the broadcast arm
  // (contextLine) on top, a card's self-expiring receipt (composerNote)
  // next, the derived composer hint (note) last. The hint stands on every
  // door row, so a receipt beneath it was never seen.
  check(
    'E8 the strip paints context > receipt > hint (a self-expiring receipt outranks the standing door hint)',
    (() => {
      const ctx = stripsSrc.indexOf('contextLine !== null && contextLine !== undefined ? (')
      const receipt = stripsSrc.indexOf(') : composerNote !== undefined ? (')
      const hint = stripsSrc.indexOf(') : note !== null ? (')
      return ctx !== -1 && receipt > ctx && hint > receipt
    })(),
  )
}

// ── F: item 6 — the isolation-awareness note (both shapes, at dispatch) ─────
console.log('F — the ground note: composed at dispatch from the REAL isolation fact, both shapes')
{
  const { isolationAwarenessNote } = await import('../../src/daemon/isolationNote.ts')
  const fork = isolationAwarenessNote({ isolation: 'worktree-isolated', workspaceId: '/x/repo', branchName: 'mercury/fork-1' })
  const shared = isolationAwarenessNote({ isolation: 'exclusive', workspaceId: '/x/repo' })
  const readonly = isolationAwarenessNote({ isolation: 'read-only', workspaceId: '/x/repo' })
  const lines = (s: string): number => s.split('\n').length
  check(
    'F1 the WORKTREE shape: your own copy · commit/push · never touch the base — 2–4 lines, the branch named',
    fork.includes('your own copy') && fork.includes('Commit and push') && fork.includes('never touch the base checkout') && fork.includes('mercury/fork-1') && lines(fork) >= 2 && lines(fork) <= 4,
  )
  check(
    'F1 the SHARED-FOLDER shape: others may edit the same files · announce and confine · never reformat/mass-rewrite — 2–4 lines',
    shared.includes('may edit the same files') && shared.includes('Announce and confine') && shared.includes('never reformat or mass-rewrite') && lines(shared) >= 2 && lines(shared) <= 4,
  )
  check(
    'F1 a read-only lease speaks the shared shape with its no-writes fact',
    readonly.includes('READ-ONLY') && readonly.includes('Write nothing here') && lines(readonly) >= 2 && lines(readonly) <= 4,
  )
  const { buildConcoursePromptFrame } = await import('../../src/daemon/concourseDispatch.ts')
  type Frame = { message?: { content?: unknown }; mode?: string }
  const plain = JSON.parse(buildConcoursePromptFrame('do the task', undefined, shared)) as Frame
  check('F2 a plain prompt OPENS with the note (top of the dispatched agent\'s prompt)', typeof plain.message?.content === 'string' && (plain.message.content as string).startsWith('[ground] ') && (plain.message.content as string).endsWith('do the task'))
  const rich = JSON.parse(buildConcoursePromptFrame('ignored', { content: [{ type: 'image' }] }, fork)) as Frame
  check(
    'F2 rich content leads with the note as its first text block',
    Array.isArray(rich.message?.content) &&
      (rich.message.content as Array<{ type?: string; text?: string }>)[0]?.type === 'text' &&
      (rich.message.content as Array<{ type?: string; text?: string }>)[0]?.text?.startsWith('[ground]') === true,
  )
  const bash = JSON.parse(buildConcoursePromptFrame('ls -la', { mode: 'bash' }, shared)) as Frame
  check('F2 a bash line is a COMMAND, not a prompt — the note never rides it', bash.message?.content === 'ls -la' && bash.mode === 'bash')
  const dispatchSrc = read('src/daemon/concourseDispatch.ts')
  check(
    'F3 the admit-leg delivery composes from the ADMITTED record — the REAL fact, never a guess from the request',
    dispatchSrc.includes('const admittedRec = readSessionWorkers(deps.dir)[admitted.runnerId]') &&
      dispatchSrc.includes('isolationAwarenessNote({') &&
      dispatchSrc.includes('buildConcoursePromptFrame(prompt, { ...promptExtrasOf(req), identity: req.clientMessageId }, groundNote)'),
  )
  check(
    'F3 the redirect leg composes NONE (an existing session was briefed at its birth)',
    dispatchSrc.includes('attemptRedirectDelivery(rec, dispatches, req.targetSessionId, req.prompt, promptExtrasOf(req))'),
  )
  const { buildCrewPack, buildCrewSpec } = await import('../../src/daemon/crewSpawn.ts')
  const pack = buildCrewPack('scout', '/x/repo')
  check('F4 the crew pack OPENS with the shared-folder shape (a teammate always shares the repo)', pack.startsWith('[ground] You work directly in the shared folder repo'))
  check('F4 the spawn spec carries it (respawns keep the note verbatim)', buildCrewSpec('scout', 'fable', '/x/repo').appendSystemPrompt?.startsWith('[ground]') === true)
  check('F4 without a dir the pack stands unchanged (no fabricated ground)', buildCrewPack('scout').startsWith('You are @scout'))
  // The naming half: the note is FRAMING, never the operator's words — no
  // title, brief or picker row may wear it.
  const { stripGroundNote, GROUND_NOTE_MARK } = await import('../../src/daemon/isolationNote.ts')
  check(
    'F5 stripGroundNote: framed words yield the words, bare words pass through, a lone note yields nothing',
    stripGroundNote(`${shared}\n\nfix the login bug`) === 'fix the login bug' &&
      stripGroundNote('fix the login bug') === 'fix the login bug' &&
      stripGroundNote(shared) === '' &&
      shared.startsWith(GROUND_NOTE_MARK),
  )
  const snapSrc = read('src/services/concourse/concourseSnapshot.ts')
  check(
    'F5 the board brief (and its stage-2 title) derive from the words alone — both content shapes strip the note',
    snapSrc.includes('stripGroundNote(content)') && snapSrc.includes('.filter(b => !b.text.startsWith(GROUND_NOTE_MARK))'),
  )
  const logsSrc = read('src/utils/sessionStorage/logs.ts')
  check(
    "F5 the /resume and /sessions pickers' first-prompt reader strips it too — one mark, every namer",
    logsSrc.includes('texts.push(stripGroundNote(content))') && logsSrc.includes('!(b.text as string).startsWith(GROUND_NOTE_MARK)'),
  )
}

// ── G: item 5 — the ruled No leg (lead, option ii) ───────────────
//  Deny proceeds LAWFULLY: where the folder is FREE the oldest DEFAULTED
//  launch replays through the same door and runs there as it is, alone
//  (exclusive); a held folder starts nothing (stays queued, no re-ask).
//  Copy split to those two truths; the clobber sentence retired (exclusive
//  occupancy shares nothing — its spirit lives in the item-6 ground notes).
console.log('G — the git-offer No leg: deny proceeds lawfully; the copy tells each truth')
{
  const { mkdirSync: mkDir, writeFileSync: writeF } = await import('node:fs')
  const d = await import('../../src/daemon/concourseDispatch.ts')
  const sup = await import('../../src/daemon/concourseSupervisor.ts')
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
  check('G1 a claim-free folder frees exactly the OLDEST defaulted launch — one row, alone by design', JSON.stringify(d.denyProceedLaunchesFor(folder, denyDir).map(r => r.clientMessageId)) === JSON.stringify(['cm-default-old']))
  check('G1 an explicit worktree pick is never overridden to exclusive — it is not in the gate', d.denyProceedLaunchesFor(folder, denyDir).every(r => r.clientMessageId !== 'cm-explicit'))
  const calls: Array<Record<string, unknown>> = []
  const stub = (async (req: Record<string, unknown>) => {
    calls.push(req)
    return { ok: true, clientMessageId: String(req.clientMessageId), state: 'working', stateRevision: 2, sessionId: 'sess-deny-1' }
  }) as never
  await d.replayDenyProceedDispatches(folder, stub, denyDir)
  check(
    'G2 the replay is VERBATIM — one call, the same id, and NO isolation injected (the defaulted fold admits it exclusive)',
    calls.length === 1 && calls[0]?.clientMessageId === 'cm-default-old' && !('isolation' in (calls[0] ?? {})),
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
    // A PARKED record holds no claim — the gate opens again.
    return gated && d.folderClaimHeld(folder, denyDir) === false
  })())
  const asks = await import('../../src/daemon/permissionAsks.ts')
  const minted = asks.mintGitInitAsk(folder)
  const denied = asks.answerPermissionAsk(minted.requestId, false, undefined, 'operator', {
    onDenyProceed: () => [{ clientMessageId: 'cm-default-old', title: 'fix the parser' }],
  })
  check("G3 the deny receipt names what starts — 'in the folder as it is, alone'", denied.outcome === 'applied' && (denied.detail ?? '').includes('starting in the folder as it is, alone: fix the parser'))
  const minted2 = asks.mintGitInitAsk(folder)
  const denied2 = asks.answerPermissionAsk(minted2.requestId, false, undefined, 'operator', { onDenyProceed: () => [] })
  check('G3 a held folder speaks the queued truth', denied2.outcome === 'applied' && (denied2.detail ?? '').includes('stays queued until the folder frees or git lands'))
  const card = await import('../../src/components/concourse/GitOfferCard.tsx')
  check(
    'G4 the No label splits by the folder state (short enough for the wide pane row)',
    card.gitOfferNoLabel(false) === 'No — run here as it is, alone (esc)' && card.gitOfferNoLabel(true) === 'No, keep the folder as it is (esc)',
  )
  check(
    "G4 the description tells each leg's whole ruled truth",
    card.gitOfferDescription('/x', false).includes('runs the session in this folder as it is, alone — no isolated copy is made') &&
      card.gitOfferDescription('/x', true).includes('stays queued until the folder frees or git lands'),
  )
  check(
    'G4 poison — the clobber sentence is RETIRED from the card (exclusive occupancy shares nothing; the spirit lives in the item-6 ground notes)',
    !read('src/components/concourse/GitOfferCard.tsx').toLowerCase().includes('clobber'),
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
  )
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check(
    'G6 the height mirror DERIVES from the one description composer — the duplicated literal is gone from the screen',
    screen.includes('gitOfferDescription(folder, folderHeld).length') && !screen.includes('creates the repository (plus one base commit)'),
  )
  check(
    'G6 the daemon wires the deny-proceed hook beside the git-ready one',
    read('src/daemon/main.ts').includes('onDenyProceed: folder => {') &&
      read('src/daemon/permissionAsks.ts').includes('hooks?.onDenyProceed?.(ask.workspaceId)'),
  )
}

process.exit(failures === 0 ? 0 : 1)
