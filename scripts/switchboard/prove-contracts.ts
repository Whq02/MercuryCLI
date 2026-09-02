#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-contracts.ts — THE ADVISORY CONTRACT (the
//  coordinator-tooling contracts T1–T6), pinned at its seams.
//
//   A  THE RECORD LIFECYCLE (T2 confirmed): drafted → acknowledged by
//      worker → active (the delivery-seam promotion — the one named
//      invention) → amended (re-ACK) → closed; NEVER DELETED — close keeps
//      text and history, a re-draft over closed pushes the closed text into
//      amendments first (the retention law).
//   B  THE ONE VERB's four ops (set|ack|amend|close): typed refusals and
//      noops; the wire action 'contract' appended LAST on unreleased proto 3
//      with its payload OUTSIDE the shape extractor's action window.
//   C  BOOT-MENU-NEVER-ASKS (T2: "from the boot menu, it starts with no
//      contract"): the one birth door and the boot face know nothing of the
//      offer.
//   D  CONCOURSE-BIRTH-ASKS (T2 + ledger L25): n and the tab arm the
//      ask-each-time memoryless card, painted in the LIVE-VIEW pane,
//      composing the one consent frame VERBATIM; No/esc births plain; Yes
//      opens the card's OWN field ("What is the contract?") and its ↵ lands
//      the words through the one verb — the live composer is never the
//      door (the retired contract-compose context is the poison), and no
//      sibling transcript paints behind the standing card.
//   E  ADVISORY POISON (the deepest law): no code path lets contract state
//      block a tool, a dispatch, or an admission — a delivery lands on an
//      UN-acked draft exactly as on no contract; the record's readers are a
//      closed allowlist.
//   F  CLOSE-AGAINST WRITES THE SEAM: the 'contract-close' receipt goes
//      THROUGH the landed sessionReceipts append (the receipts estate owns
//      the module; the contract estate imports and calls), before the close.
//   G  WARM RE-SURFACING (T3 mechanism 1): the reminder producer rides the
//      estate's one attachment plumbing — at birth, then on cadence.
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'contracts-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
// Every store this prover touches lives in scratch — pinned BEFORE any
// src import so a missed dir default can never reach the real home.
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

const { applyConcourseContractOp, CONTRACT_TEXT_CAP } = await import('../../src/daemon/sessionContract.ts')
const { markConcourseWorkerDelivery, readSessionWorkers } = await import(
  '../../src/daemon/concourseSupervisor.ts'
)
const { appendSessionReceipt, readSessionReceipts } = await import('../../src/services/switchboard/sessionReceipts.ts')
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourseSupervisor.ts'

const NOW = Date.now()
const DIR = join(SCRATCH, 'daemon')
mkdirSync(DIR, { recursive: true })
const SID = 'sess-contract-0001'
const RUNNER = 'concourse-w1'

function seedWorker(): void {
  const rec = {
    schema: 1,
    runnerId: RUNNER,
    sessionId: SID,
    workspaceId: join(SCRATCH, 'ws'),
    isolation: 'exclusive',
    modelKey: 'fable',
    spawnedAt: NOW - 60_000,
    lastLiveAt: NOW,
    title: 'the contract session',
  } as ConcourseWorkerRecordV1
  writeFileSync(join(DIR, 'concourse-workers.json'), `${JSON.stringify({ version: 1, workers: { [RUNNER]: rec } }, null, 1)}\n`)
}
const rec = (): ConcourseWorkerRecordV1 => readSessionWorkers(DIR)[RUNNER]!
const contract = () => rec().contract

// ── A: the record lifecycle — never deleted ─────────────────────────────────
console.log('A — the record lifecycle (drafted → acked → active → amended → re-acked → closed; never deleted)')
{
  seedWorker()
  check('A0 a fresh record carries NO contract (additive — old records unaffected)', contract() === undefined)
  const set1 = applyConcourseContractOp(SID, { op: 'set', text: 'Build the widget; touch nothing else.' }, 'operator', DIR)
  check("A1 set drafts: outcome applied, status 'draft', the words verbatim", set1.outcome === 'applied' && contract()?.status === 'draft' && contract()?.text === 'Build the widget; touch nothing else.')
  const set2 = applyConcourseContractOp(SID, { op: 'set', text: 'Build the widget and its tests; touch nothing else.' }, 'operator', DIR)
  check('A2 set on a standing draft REVISES in place (no history entry — the draft was never in force)', set2.outcome === 'applied' && contract()?.status === 'draft' && contract()?.amendments.length === 0 && (contract()?.text ?? '').includes('tests'))
  const ack1 = applyConcourseContractOp(SID, { op: 'ack' }, `worker:${SID.slice(0, 8)}`, DIR)
  check("A3 ack is the worker's signature: draft → 'acknowledged', ackAt stamped", ack1.outcome === 'applied' && contract()?.status === 'acknowledged' && typeof contract()?.ackAt === 'number')
  markConcourseWorkerDelivery(RUNNER, DIR)
  check("A4 the delivery-seam promotion (the ONE invention, strike-able): a delivery on an acknowledged contract lands 'active'", contract()?.status === 'active')
  const amend1 = applyConcourseContractOp(SID, { op: 'amend', text: 'Build the widget; the tests clause did not survive contact.' }, 'operator', DIR)
  check("A5 amend keeps history: status 'amended', amendedAt stamped, the OUTGOING text pushed into amendments", amend1.outcome === 'applied' && contract()?.status === 'amended' && typeof contract()?.amendedAt === 'number' && contract()?.amendments.length === 1 && (contract()?.amendments[0]?.text ?? '').includes('tests'))
  const reack = applyConcourseContractOp(SID, { op: 'ack' }, `worker:${SID.slice(0, 8)}`, DIR)
  markConcourseWorkerDelivery(RUNNER, DIR)
  check("A6 re-ack after amendment re-signs, and the next delivery re-promotes: 'active' again", reack.outcome === 'applied' && contract()?.status === 'active')
  const close1 = applyConcourseContractOp(SID, { op: 'close' }, 'operator', DIR)
  check("A7 close ends the agreement with EVERYTHING kept: status 'closed', text whole, history whole", close1.outcome === 'applied' && contract()?.status === 'closed' && (contract()?.text ?? '').includes('did not survive') && contract()?.amendments.length === 1)
  const set3 = applyConcourseContractOp(SID, { op: 'set', text: 'A second engagement.' }, 'operator', DIR)
  check('A8 NEVER DELETED: a re-draft over closed pushes the closed text into amendments first (2 superseded texts now)', set3.outcome === 'applied' && contract()?.status === 'draft' && contract()?.amendments.length === 2 && contract()?.text === 'A second engagement.')
  check('A9 the text cap is a bound, not a gate (the verb caps, never refuses length)', typeof CONTRACT_TEXT_CAP === 'number' && CONTRACT_TEXT_CAP >= 10_000)
}

// ── B: the one verb's four ops — typed refusals, the wire ───────────────────
console.log("B — the one verb's four ops (typed refusals; the wire's appended action)")
{
  check('B1 unknown session refuses typed', applyConcourseContractOp('no-such', { op: 'set', text: 'x' }, 'operator', DIR).outcome === 'refused')
  seedWorker() // reset: no contract
  check('B2 ack with no contract refuses', applyConcourseContractOp(SID, { op: 'ack' }, 'w', DIR).outcome === 'refused')
  check('B3 amend with no contract refuses toward set', applyConcourseContractOp(SID, { op: 'amend', text: 'x' }, 'o', DIR).outcome === 'refused')
  check('B4 close with no contract refuses', applyConcourseContractOp(SID, { op: 'close' }, 'o', DIR).outcome === 'refused')
  check('B5 set without words refuses', applyConcourseContractOp(SID, { op: 'set', text: '   ' }, 'o', DIR).outcome === 'refused')
  applyConcourseContractOp(SID, { op: 'set', text: 'the agreement' }, 'o', DIR)
  check('B6 amend on a DRAFT refuses (a draft is not in force — set revises it)', applyConcourseContractOp(SID, { op: 'amend', text: 'y' }, 'o', DIR).outcome === 'refused')
  applyConcourseContractOp(SID, { op: 'ack' }, 'w', DIR)
  check('B7 set on an IN-FORCE contract refuses toward amend (history must be kept)', applyConcourseContractOp(SID, { op: 'set', text: 'z' }, 'o', DIR).outcome === 'refused')
  check('B8 a second ack is a noop, never an error', applyConcourseContractOp(SID, { op: 'ack' }, 'w', DIR).outcome === 'noop')
  applyConcourseContractOp(SID, { op: 'close' }, 'o', DIR)
  check('B9 a second close is a noop; ack on closed refuses', applyConcourseContractOp(SID, { op: 'close' }, 'o', DIR).outcome === 'noop' && applyConcourseContractOp(SID, { op: 'ack' }, 'w', DIR).outcome === 'refused')

  const protocol = read('src/daemon/protocol.ts')
  const actionsAt = protocol.indexOf("op: 'sessionControl'", protocol.indexOf('export type DaemonRequest ='))
  const window = protocol.slice(protocol.indexOf('action:', actionsAt), protocol.indexOf('sessionId: string', actionsAt))
  // AMENDED (lead-ruled: exemption-with-teeth over a spelling
  // dodge): 'contract' was appended after 'set-effort' and stays there by
  // ADJACENCY; later verbs append after it — 'set-kit' is pinned LAST by
  // prove-session-kit S10, never inserted mid-union.
  check("B10 the wire action 'contract' was APPENDED after set-effort (the shape reads source order; later verbs append after it)", /\|\s*'set-effort'\s*\|\s*'contract'/.test(window))
  check("B11 the contract payload rides OUTSIDE the shape extractor's action window (after sessionId)", !window.includes("{ op: 'set' | 'ack' | 'amend' | 'close'") && protocol.includes("contract?: { op: 'set' | 'ack' | 'amend' | 'close'; text?: string }"))
  // B12 re-anchored off the literal (the saturn-core W3 sibling): the
  // daemon-wire re-registration bumped the proto with the shape registered
  // at its owner; THIS verb forced no bump then and forces none now — bump
  // discipline lives in prove-protocol-shape. The pin keeps the constant
  // single-sourced, spelling the exported value, beside its shape row.
  const { MERCURY_DAEMON_PROTO: liveProto } = await import('../../src/daemon/protocol.ts')
  check('B12 ONE wire proto beside its registered shape (bump discipline is prove-protocol-shape\'s)', (protocol.match(/export const MERCURY_DAEMON_PROTO = /g) ?? []).length === 1 && protocol.includes(`export const MERCURY_DAEMON_PROTO = ${liveProto}`) && protocol.includes("export const DAEMON_PROTO_SHAPE = 'sha256:"))
  const server = read('src/daemon/controlServer.ts')
  check("B13 the server routes the action and passes the typed payload through", server.includes("raw.action === 'contract'") && server.includes('...(contract !== undefined ? { contract } : {})'))
  const main = read('src/daemon/main.ts')
  const arm = main.slice(main.indexOf("if (action === 'contract')"), main.indexOf('applyConcourseContractOp(sessionId, contract, by)'))
  check('B14 the daemon arm adjudicates through the ONE writer and rides the applied-ops settle (exactly-once for a retried agent ack/close)', arm.includes('settle(') || main.includes('return settle(applyConcourseContractOp(sessionId, contract, by))'))
}

// ── C: boot-menu births never ask ───────────────────────────────────────────
console.log('C — boot-menu births never ask (T2: "from the boot menu, it starts with no contract")')
{
  const born = read('src/services/switchboard/bornSession.ts')
  check('C1 the ONE birth door knows nothing of the offer (no contract reference at all)', !/contract/i.test(born))
  const face = read('src/components/BootSplashScreen.tsx')
  check('C2 the boot face carries neither the card nor the arm', !face.includes('ContractOfferCard') && !face.includes('armContractAsk'))
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  const armWrites = screen.split('armContractAsk()').length - 1
  // THREE since the SP-1 fix: the n key · the New Session
  // tab · the split chat pane's ↵ with no focused session ("the board's
  // own New Session birth, staying in split — through the ONE birth
  // door", the screen's own comment). All three are concourse-side and
  // every concourse birth still rides the offer — the count is a census;
  // T2's law itself is the D block's. Re-pinned at
  // the walk that first ran this pin against the landed split view.
  check('C3 the ask arms from exactly THREE gestures — the n key, the New Session tab, and the split pane’s ↵ birth (all concourse-side)', armWrites === 3)
}

// ── D: concourse births ask — the live-view card, the one consent frame ─────
console.log('D — concourse births ask (the live-view card composes the one consent frame; No/esc births plain; Yes opens the card\'s own field — L25)')
{
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  const card = read('src/components/concourse/ContractOfferCard.tsx')
  // The banned-substring sweeps below (D5/D12) read the screen with its
  // comment lines dropped: ConcourseScreen documents the L25 CUT in a
  // comment that NAMES the retired 'contract-compose' context — the
  // lawful voice, a comment naming the dead disease — while the ban is on
  // CODE still carrying the context. The needles must not trip on the
  // obituary (re-pinned at the pin's first run).
  const screenCode = screen.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
  // D1's anchor is the LETTER-VERB's own spelling — the bare "if (input
  // === 'n'" needle had aged onto the daemon-offer/capacity y-n handlers
  // that landed above it (the stale-anchor class; re-toothed when
  // its first real red surfaced).
  const nVerbAt = screen.indexOf("if (input === 'n' && !key.ctrl")
  check('D1 n arms the ask instead of birthing directly', nVerbAt > 0 && /armContractAsk\(\)/.test(screen.slice(nVerbAt, nVerbAt + 1100)) && !/callbacks\.newSession\(\)/.test(screen.slice(nVerbAt, nVerbAt + 900)))
  check('D2 the tab wiring arms the same ask', screen.includes('{ newSession: () => armContractAsk() }'))
  const mirrorAt = screen.indexOf('const mirrorSlot = ')
  check('D3 the card paints IN THE LIVE-VIEW PANE (mirrorSlot) with the pane’s geometry, never centered over the board', screen.slice(mirrorAt, mirrorAt + 700).includes('<ContractOfferCard onAnswer={answerContractAsk} width={width} rows={rows} />'))
  // D3b (L25's second screenshot): the slot answers the CARD before any row
  // lookup — while the ask stands no sibling's transcript can paint behind
  // it (the pre-fix Yes unmounted the card and the pane fell to the
  // selected row's mirror under the compose).
  check('D3b the slot returns the standing card BEFORE the selected row’s mirror (no sibling transcript behind it)', screen.indexOf('<ContractOfferCard', mirrorAt) > 0 && screen.indexOf('<ContractOfferCard', mirrorAt) < screen.indexOf('const sel = sessionRows.find(r => r.sessionId === boardSel)', mirrorAt))
  check('D4 No (esc lands there too, from either face) births PLAIN through the same door', /if \(contractText === null\) \{[^]{0,400}?callbacks\.newSession\?\.\(\)/.test(screen))
  check('D5 Yes opens the FIELD INSIDE THE CARD — "What is the contract?" (L25) — never the live composer', card.includes('What is the contract?') && card.includes("setFace('field')") && card.includes("import TextInput from '../TextInput.js'") && !screenCode.includes('contract-compose') && !screenCode.includes('write the contract here'))
  check('D6 the card’s ↵ births WITH the words through the one door; an empty ↵ keeps the card (never a blank contract)', screen.includes('callbacks.newSession?.({ contractText })') && card.includes('onSubmit={submit}') && card.includes('if (words.length === 0)') && card.includes('onAnswer(words)'))
  check('D7 MEMORYLESS ask-each-time: plain state, no persisted decline anywhere near the ask', screen.includes('const [contractAsk, setContractAsk] = useState(false)') && !/contractAsk[^]{0,200}(getGlobalConfig|saveGlobalConfig|localStorage)/.test(screen))
  check('D8 the card COMPOSES the estate’s owners verbatim — PermissionDialog + PermissionPrompt + TextInput, no lookalike frame, no hand-rolled editor', card.includes('<PermissionDialog title="Start with a contract?">') && card.includes('<PermissionPrompt') && card.includes('<TextInput') && !/border|round|box-drawing/i.test(card) && !/useInput\(/.test(card))
  check('D9 the card’s esc is the No leg from BOTH faces (the option grammar’s cancel and the field’s escape)', card.includes('onCancel={() => onAnswer(null)}') && card.includes('onEscape={() => onAnswer(null)}'))
  // D11 (L25's poison): the words never touch the live composer — the
  // answer door births or hands the text on, and writes neither the live
  // draft, the compose context nor the region.
  const answerAt = screen.indexOf('const answerContractAsk = ')
  const answerBody = screen.slice(answerAt, screen.indexOf('\n  }\n', answerAt))
  check('D11 POISON: the answer door touches no composer — no live draft, no compose context, no region move', answerAt > 0 && !/setComposeContext|liveDraft|setRegion|clearLiveDraft/.test(answerBody))
  check('D12 the contract-compose context is gone WHOLE (type member · send branch · esc branch · context line)', !screenCode.includes("'contract-compose'") && !screenCode.includes('contract-compose'))
  check('D13 every printed key on the field is true: ↵ = onSubmit · ⇧↵ = the text input’s own shift-enter newline · esc = onEscape', card.includes('↵ starts the session under it') && card.includes('⇧↵ newline') && card.includes('esc starts it plain') && card.includes('multiline') && read('src/hooks/useTextInput.ts').includes("if (key.meta || key.shift) return cursor.insert('\\n')"))
  // D9b (the find — a GREEN PIN OVER A RED FACT until
  // driven): D4/D9 pinned the No-leg WIRING while the screen's LIST region
  // shadowed every key beneath the card — ↑↓ moved the board selection, ↵
  // ENTERED the selected session, esc LEFT for the chat, so the card was
  // keyboard-unanswerable and esc cancelled the birth its own row promises.
  // The screen yields whole while the ask stands, the seat/git cards' law,
  // ordered right after their two yields.
  check('D9b the screen YIELDS the keys while the ask stands (the one-Select modality — the ONE modal owner; git-offer outranks contract-ask exactly as the old ladder did)', screen.includes('contractAsk: contractAskRef.current,') && screen.includes("if (modalOwner !== null && modalOwner !== 'manager-seat-ask' && modalOwner !== 'manager-card') return") && (() => { const owner = read('src/components/concourse/boardModalOwner.ts'); return owner.includes("if (facts.gitOffer) return 'git-offer'") && owner.indexOf("if (facts.gitOffer) return 'git-offer'") !== -1 && owner.indexOf("if (facts.gitOffer) return 'git-offer'") < owner.indexOf("if (facts.contractAsk) return 'contract-ask'") })())
  const route = read('src/components/concourse/ConcourseRoute.tsx')
  check('D10 the route lands the composed words as the DRAFT through the one verb, after the admit, before the enter — and a refused set never un-births', route.includes("action: 'contract', sessionId: born.sessionId, by: 'operator', contract: { op: 'set', text: contractText }") && route.includes('the contract was not set'))
}

// ── E: the advisory poison — nothing gates on a contract ────────────────────
console.log('E — ADVISORY ALWAYS (the poison: contract state blocking a tool, a dispatch, or an admission)')
{
  seedWorker()
  applyConcourseContractOp(SID, { op: 'set', text: 'un-acked draft' }, 'o', DIR)
  const before = rec().lastDeliveryAt
  markConcourseWorkerDelivery(RUNNER, DIR)
  check('E1 a delivery lands on an UN-ACKED draft exactly as on no contract (nothing valves on contract state)', before === undefined && typeof rec().lastDeliveryAt === 'number')
  // The record's readers are a CLOSED allowlist — any new `.contract` read
  // in the daemon/switchboard estates must face this pin and justify itself.
  const allowed = new Set([
    'src/daemon/sessionContract.ts',
    'src/daemon/concourseSupervisor.ts',
    'src/daemon/main.ts',
    'src/daemon/controlServer.ts',
    'src/daemon/protocol.ts',
    // Exemption-with-teeth: saturn.ts's `.contract` hits
    // are its OWN birth-spec payload (SaturnBirthSpecV1.contract — the
    // pre-answered contract door a schedule-born session admits with) plus
    // the CONTRACT_TEXT_CAP import; it never reads the RECORD's contract
    // field. E2b below holds that law with its own needle.
    'src/daemon/saturn.ts',
    // The same exemption-with-teeth: saturnBirth.ts's
    // `.contract` hits are the birth-spec payload (spec.contract — the
    // pre-answered door a schedule-born session admits with) and the
    // injected contract WRITER (doors.contract, the one verb applying the
    // pre-answer). It never reads the RECORD's field; E2c holds that law.
    // The allowlist predated the birth tier.
    'src/daemon/saturnBirth.ts',
  ])
  const { readdirSync } = await import('node:fs')
  const hits: string[] = []
  for (const root of ['src/daemon', 'src/services/switchboard']) {
    for (const name of readdirSync(join(process.cwd(), root), { recursive: true }) as string[]) {
      if (!name.endsWith('.ts')) continue
      const rel = join(root, name)
      if (/\.contract\b/.test(readFileSync(join(process.cwd(), rel), 'utf8'))) hits.push(rel)
    }
  }
  check('E2 the contract field’s daemon/switchboard readers are the closed allowlist (no admission, dispatch, capacity, permission or launch-authority path reads it)', hits.every(h => allowed.has(h)), hits.filter(h => !allowed.has(h)).join(', ') || 'clean')
  // E2b THE TEETH for saturn.ts's row above: its `.contract` spellings are
  // its own payload's — a RECORD contract read there would be the gating
  // class E2 exists to refuse.
  const saturnSrc = readFileSync(join(process.cwd(), 'src/daemon/saturn.ts'), 'utf8')
  check('E2b saturn.ts never reads the RECORD contract field (its hits are the birth-spec payload + the text cap)', !/\brec\.contract\b|\brecord\.contract\b|\bstanding\.contract\b/.test(saturnSrc) && saturnSrc.includes('CONTRACT_TEXT_CAP'))
  // E2c THE TEETH for saturnBirth.ts's row: every dotted contract read in
  // the birth door is the spec payload or the injected writer — a record
  // read would be the gating class E2 exists to refuse.
  const birthSrc = readFileSync(join(process.cwd(), 'src/daemon/saturnBirth.ts'), 'utf8')
  check('E2c saturnBirth.ts never reads the RECORD contract field (its hits are spec.contract + the doors.contract writer)', (birthSrc.match(/\w+\.contract\b/g) ?? []).every(h => h === 'spec.contract' || h === 'doors.contract'))
  for (const guarded of ['src/daemon/concourseDispatch.ts', 'src/services/switchboard/capacityCheck.ts', 'src/services/switchboard/launchAuthority.ts', 'src/daemon/permissionAsks.ts']) {
    check(`E3 ${guarded.split('/').pop()} never reads contract state`, !/\.contract\b/.test(read(guarded)))
  }
  const tool = read('src/tools/ContractTool/ContractTool.ts')
  check('E4 the abide tool never refuses WORK — its only throws are its own malformed-input asks, and every contract-state face is words, not a gate', !/throw new Error\((?!'(acknowledge needs|check-in needs|propose-amend needs|close-against needs))/.test(tool))
  const toolsCat = read('src/tools.ts')
  check('E5 the catalogue gates ONLY the contract tool on the role stamp — no other tool’s membership mentions contract', (toolsCat.match(/contractToolHosted\(\)/g) ?? []).length === 1)
}

// ── F: close-against writes THROUGH the landed seam ─────────────────────────
console.log('F — close-against writes the contract-close receipt through the landed seam')
{
  const home = join(SCRATCH, 'receipts-home')
  mkdirSync(home, { recursive: true })
  appendSessionReceipt(home, SID, {
    at: new Date(NOW).toISOString(),
    by: `worker:${SID.slice(0, 8)}`,
    kind: 'contract-close',
    summary: 'delivered the widget; the tests clause was amended away',
    details: { status: 'active', amendments: 1 },
  })
  const entries = readSessionReceipts(home, SID)
  check("F1 the seam round-trips the 'contract-close' entry (at · by · kind · summary · details)", entries.length === 1 && entries[0]?.kind === 'contract-close' && entries[0]?.by === `worker:${SID.slice(0, 8)}` && (entries[0]?.details as { amendments?: number } | undefined)?.amendments === 1)
  const tool = read('src/tools/ContractTool/ContractTool.ts')
  check('F2 the tool imports the LANDED seam and only calls append (the receipts estate owns the module internals)', tool.includes("import('../../services/switchboard/sessionReceipts.js')") && tool.includes("kind: 'contract-close'") && !tool.includes('receipts.jsonl'))
  const closeArm = tool.slice(tool.indexOf("case 'close-against'"), tool.indexOf('} satisfies ToolDef'))
  check('F3 the receipt files FIRST, the verb closes second (a crash between leaves a receipted, re-closable contract — benign)', closeArm.indexOf('appendSessionReceipt(') !== -1 && closeArm.indexOf('appendSessionReceipt(') < closeArm.indexOf("contractVerb('close')"))
}

// ── G: warm re-surfacing rides the one reminder plumbing ────────────────────
console.log('G — warm re-surfacing (T3 mechanism 1: at birth, then on cadence, through the estate’s own plumbing)')
{
  const reminders = read('src/utils/attachments/reminders.ts')
  check('G1 the birth ride: a contract never surfaced and never touched is due IMMEDIATELY', reminders.includes('turnsSinceLastReminder === null && turnsSinceLastTouch === null'))
  check('G2 the producer rides the ONE orchestrator fan-out (no parallel channel)', read('src/utils/attachments/orchestrator.ts').includes("maybe('contract_reminder'"))
  check('G3 the reminder renders through the estate’s system-reminder envelope and never claims force', read('src/utils/messages/attachmentText.ts').includes("case 'contract_reminder'") && read('src/utils/messages/attachmentText.ts').includes('never blocks'))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-contracts: ALL LAWS HOLD' : `\nprove-contracts: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
