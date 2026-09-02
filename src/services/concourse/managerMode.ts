// ============================================================================
//  services/concourse/managerMode — MANAGER MODE (coordinator-tooling ledger
//  T7+T8): the coordinator composer's shift+tab mode. A one-shot goal in,
//  a SEQUENTIAL interview of question cards (1–4 proposed answers, 5 always
//  the custom input), then ONE plan card — the lane split as draft
//  contracts (scope · deliverables · TERRITORY), two lanes by default —
//  whose single Yes sets the contracts through the landed contract verb and
//  dispatches the lanes through the landed dispatch door. No daemon verb is
//  added here: this module COMPOSES the landed estate (T1–T6) and owns only
//  the manager's typed shapes, its prompting, its two in-process tools, the
//  plan executor, and the supervising-light fold.
//
//  THE INTERVIEW IS THE MODEL'S OWN CONVERSATION: no hardcoded question
//  list lives here — the addendum below carries the question discipline
//  (T4's sufficiency standard: ASK with the named gap, or CONTINUE), and
//  ask_operator is only the card's landing. THE HARMONY LAW (T8) is
//  prompting + a required field: every lane's draft contract CARRIES its
//  territory, the plan card shows the fences, and the addendum forbids
//  redundant/overlapping estates — encouraged, in the estate's advisory
//  grammar, beside the worktrees' mechanical isolation.
// ============================================================================

import type { CoordinatorRpc, CoordinatorToolDef, CoordinatorToolReceiptV1 } from './coordinatorTools.js'
import { keyHintLabel } from '../../components/mercury-ui/keyHintLabel.js'

// ── the typed card shapes (bounded; the conversation entry carries them) ────

export const MAX_MANAGER_ASK_OPTIONS = 4
export const MAX_MANAGER_LANES = 6

export interface ManagerAskV1 {
  /** The question, the model's own words. */
  question: string
  /** 1–4 proposed answers — option 5 (the custom input) is the CARD's own,
   *  always present, never the model's to omit (T8). */
  options: string[]
  /** 1-based interview ordinal, display only ("question 3"). */
  index?: number
}

export interface ManagerLaneV1 {
  title: string
  /** What the lane is for — the draft contract's scope clause. */
  scope: string
  deliverables: string
  /** THE HARMONY FIELD (T8): the estate this lane ALONE owns — folders,
   *  files, features — concrete enough that no two lanes touch the same
   *  part. Required on every lane; the card paints the fences. */
  territory: string
}

export type ManagerPlanStateV1 = 'proposed' | 'declined' | 'dispatched'

export interface ManagerPlanV1 {
  /** The one-shot goal, restated. */
  goal: string
  /** TWO lanes by default; more only where the operator asked (≤6). */
  lanes: ManagerLaneV1[]
  /** The model's seat-math line, display only — the Yes-time gate reads the
   *  LIVE counts, never these words. */
  seats?: string
  /** T8 lead default (b), strike-able: supervising-light unless the
   *  operator toggles the calmer launch-only on the card. */
  supervision: 'supervising' | 'launch-only'
  state: ManagerPlanStateV1
  /** Stamped at dispatch, lane-ordered; null until the lane starts. */
  laneSessionIds?: Array<string | null>
  /** Lanes past the machine's reading at the Yes — they WAIT in the plan
   *  and start under their contracts as seats free (the walker's start
   *  half), never through a queue that would deliver a first frame with no
   *  contract on the record. */
  laneWaiting?: number[]
  /** Stamped at dispatch — the folder the lanes are born in, so a waiting
   *  lane can still start after a restart (the register re-seeds from the
   *  durable entry). */
  workspaceRoot?: string
}

const str = (v: unknown, cap: number): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, cap) : undefined

/** Strict decode — the conversation store's entry fields ride this (an
 *  unreadable card is dropped whole, never a half-painted one). */
export function decodeManagerAsk(raw: unknown): ManagerAskV1 | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<ManagerAskV1>
  const question = str(r.question, 300)
  if (question === undefined) return null
  const options = Array.isArray(r.options)
    ? r.options
        .map(o => str(o, 120))
        .filter((o): o is string => o !== undefined)
        .slice(0, MAX_MANAGER_ASK_OPTIONS)
    : []
  if (options.length === 0) return null
  const index =
    typeof r.index === 'number' && Number.isFinite(r.index) && r.index >= 1 && r.index <= 99
      ? Math.floor(r.index)
      : undefined
  return { question, options, ...(index !== undefined ? { index } : {}) }
}

function decodeLane(raw: unknown): ManagerLaneV1 | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<ManagerLaneV1>
  const title = str(r.title, 80)
  const scope = str(r.scope, 400)
  const deliverables = str(r.deliverables, 400)
  const territory = str(r.territory, 300)
  // The harmony field is load-bearing: a lane without its territory is not
  // a lawful plan lane (T8 — the card shows the fences).
  if (title === undefined || scope === undefined || deliverables === undefined || territory === undefined) return null
  return { title, scope, deliverables, territory }
}

export function decodeManagerPlan(raw: unknown): ManagerPlanV1 | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<ManagerPlanV1>
  const goal = str(r.goal, 300)
  if (goal === undefined) return null
  const lanes = Array.isArray(r.lanes)
    ? r.lanes.map(decodeLane).filter((l): l is ManagerLaneV1 => l !== null).slice(0, MAX_MANAGER_LANES)
    : []
  if (lanes.length === 0) return null
  const supervision = r.supervision === 'launch-only' ? 'launch-only' : 'supervising'
  const state = r.state === 'declined' || r.state === 'dispatched' ? r.state : 'proposed'
  const seats = str(r.seats, 160)
  const laneSessionIds = Array.isArray(r.laneSessionIds)
    ? r.laneSessionIds
        .slice(0, MAX_MANAGER_LANES)
        .map(v => (typeof v === 'string' && v.length > 0 ? v.slice(0, 128) : null))
    : undefined
  const laneWaiting = Array.isArray(r.laneWaiting)
    ? r.laneWaiting
        .filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < lanes.length)
        .slice(0, MAX_MANAGER_LANES)
    : undefined
  const workspaceRoot = str(r.workspaceRoot, 1024)
  return {
    goal,
    lanes,
    supervision,
    state,
    ...(seats !== undefined ? { seats } : {}),
    ...(laneSessionIds !== undefined ? { laneSessionIds } : {}),
    ...(laneWaiting !== undefined && laneWaiting.length > 0 ? { laneWaiting } : {}),
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
  }
}

// ── THE DIGIT LAW (T8, the operator's words: "pressing four shouldn't just,
//    like, go next — it should select") as ONE pure fold the card calls and
//    the prover runs. The action type has NO commit variant: a digit can
//    only select (highlight), fire the footer exit, or be ignored — a digit
//    landing on the already-selected option re-selects it (idempotent) and
//    never commits; a double press is never a commit shortcut. Only ↵, the
//    select owner's own accept, commits. ────────────────────────────────────

export type AskCardKeyAction =
  | { kind: 'select'; index: number }
  | { kind: 'enough' }
  | { kind: 'ignore' }

export function askCardKeyAction(
  input: string,
  facts: {
    /** Proposed answers + the custom row (the select's option count). */
    optionCount: number
    /** The custom row is typing — digits are its text, never a move. */
    inInput: boolean
  },
): AskCardKeyAction {
  if (!/^[0-9]$/.test(input)) return { kind: 'ignore' }
  if (facts.inInput) return { kind: 'ignore' }
  const n = parseInt(input, 10)
  if (n >= 1 && n <= facts.optionCount) return { kind: 'select', index: n - 1 }
  if (n === facts.optionCount + 1) return { kind: 'enough' }
  return { kind: 'ignore' }
}

// ── the manager's prompting (rides the system prompt BEHIND the persona on
//    manager-mode turns only; the persona's own laws keep holding) ──────────

export const MANAGER_MODE_ADDENDUM = `MANAGER MODE is on: the operator hands you ONE goal and you turn it into a plan of
lanes — sessions working in harmony. Interview first, then plan; both through your two
manager tools, never as loose prose.

The interview: ONE question per turn through ask_operator, with 2–4 proposed answers —
the card itself adds the custom option, so never write an "other" of your own. Ask the
question that most narrows the plan; never re-ask what an earlier answer or the board
already settles. After the tool call, end your turn — the answer arrives as the next
message. Sufficiency is the contract standard: after each answer, judge whether you can
already write honest contracts for the lanes — the outcomes are exactly two: ASK, naming
the specific gap the next question closes, or CONTINUE to the plan. Push toward ten
questions only while the goal stays genuinely fuzzy; most goals need far fewer. When the
operator says enough — plan it (however they phrase it), the interview is over: propose
the plan NOW from what you hold.

The plan: propose_plan with TWO lanes by default — more only where the operator asked
for more. Each lane is a draft contract in short form: scope (what the lane is for),
deliverables, and TERRITORY. THE HARMONY LAW: lanes own NON-OVERLAPPING parts — name
each territory concretely (folders, features, layers) so no two lanes touch the same
estate; never redundant or overlapping work. The worktrees isolate mechanically; the
harmony is yours to plan. After the tool call, end your turn — the card is the consent:
one Yes sets the contracts and dispatches the lanes through the harness (you never
launch the plan's lanes yourself); No keeps the draft, and the operator's next words
revise it through another propose_plan.

After a dispatch under supervising: on every later turn, read your lanes from the board
first — report a land plainly when its row shows finished, nudge a stalled lane through
message_session with one concrete steer, and relay a needs-you question instead of
sitting on it. Under launch-only, stay quiet about the lanes unless asked.`

// ── the two manager tools (in-process; the card is the landing) ─────────────

/** The per-turn collector the call loop hands the tools — one card per
 *  turn, whichever kind lands first (the sequential law). */
export interface ManagerTurnCollector {
  ask?: ManagerAskV1
  plan?: ManagerPlanV1
}

const jsonResult = (value: unknown): string => JSON.stringify(value)

export function managerToolSet(collected: ManagerTurnCollector): CoordinatorToolDef[] {
  const oneCardStands = (): string | null =>
    collected.ask !== undefined
      ? 'one card per turn — your question card already stands; end the turn'
      : collected.plan !== undefined
        ? 'one card per turn — your plan card already stands; end the turn'
        : null
  return [
    {
      name: 'ask_operator',
      description:
        'Put ONE interview question in front of the operator as a card — manager mode only. Pass the question and 2–4 proposed answers (short, concrete, mutually distinct); the card itself adds option 5, the custom input, so never include an "other"/"custom" answer of your own. One question per turn: after this call, end your turn — the operator’s pick arrives as the next message. Not for plan proposals (propose_plan) and never for a question an earlier answer or the board already settles.',
      inputJSONSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The one question, plain words (≤300 chars).' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: '2–4 proposed answers, each ≤120 chars. The card adds the custom option itself.',
          },
          index: { type: 'number', description: '1-based interview ordinal, display only.' },
        },
        required: ['question', 'options'],
        additionalProperties: false,
      },
      run: async input => {
        const standing = oneCardStands()
        if (standing !== null) return { content: jsonResult({ ok: false, refused: standing }) }
        const ask = decodeManagerAsk(input)
        if (ask === null)
          return {
            content: jsonResult({
              ok: false,
              refused: 'ask_operator needs a question and 2–4 proposed answers',
              next: 'pass question + options (the card adds the custom option itself)',
            }),
          }
        if (ask.options.length < 2)
          return {
            content: jsonResult({
              ok: false,
              refused: 'one proposed answer is not an interview — pass 2–4',
              next: 'offer the plausible answers; the card adds the custom option itself',
            }),
          }
        collected.ask = ask
        return {
          content: jsonResult({
            ok: true,
            asked: ask.question,
            note: 'the card is in front of the operator — end your turn now; their answer arrives as the next message',
          }),
        }
      },
    },
    {
      name: 'propose_plan',
      description:
        'Put THE PLAN CARD in front of the operator — manager mode only, after the interview says enough. Pass the goal and the lane split: TWO lanes by default (more only where the operator asked), each lane a draft contract in short form — title, scope (what it is for), deliverables, and territory (THE HARMONY LAW: the estate this lane alone owns, concrete — folders, features, layers — so no two lanes overlap; the card shows the fences). Optional seats line (your own seat math, display only) and supervision ("supervising" default · "launch-only"). One Yes on the card sets every contract and dispatches every lane through the harness — you never launch them yourself; after this call, end your turn. No keeps the draft for editing.',
      inputJSONSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The one-shot goal, restated (≤300 chars).' },
          lanes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Board title (≤80).' },
                scope: { type: 'string', description: 'What the lane is for (≤400).' },
                deliverables: { type: 'string', description: 'What it hands back (≤400).' },
                territory: { type: 'string', description: 'The estate this lane ALONE owns (≤300) — the harmony fence.' },
              },
              required: ['title', 'scope', 'deliverables', 'territory'],
              additionalProperties: false,
            },
            description: 'The lane split — two by default, ≤6; non-overlapping territories.',
          },
          seats: { type: 'string', description: 'Your seat-math line, display only (≤160).' },
          supervision: { type: 'string', enum: ['supervising', 'launch-only'], description: 'Default supervising.' },
        },
        required: ['goal', 'lanes'],
        additionalProperties: false,
      },
      run: async input => {
        const standing = oneCardStands()
        if (standing !== null) return { content: jsonResult({ ok: false, refused: standing }) }
        const plan = decodeManagerPlan({ ...(input as object), state: 'proposed' })
        if (plan === null)
          return {
            content: jsonResult({
              ok: false,
              refused:
                'propose_plan needs the goal and 1–6 lanes, each with title, scope, deliverables AND territory (the harmony field)',
              next: 'name every lane’s own estate — the territory is what keeps the lanes from clobbering each other',
            }),
          }
        collected.plan = { ...plan, state: 'proposed' }
        return {
          content: jsonResult({
            ok: true,
            lanes: plan.lanes.length,
            note: 'the plan card is in front of the operator — end your turn now; one Yes dispatches it, No keeps the draft for editing',
          }),
        }
      },
    },
  ]
}

// ── the lane brief + contract text (pure — the prover reads these) ──────────

/** The draft contract's words, as the landed contract verb stores them —
 *  short form: scope · deliverables · territory (T7). */
export function managerContractTextOf(plan: ManagerPlanV1, lane: ManagerLaneV1): string {
  return [
    `Goal: ${plan.goal}`,
    `Scope: ${lane.scope}`,
    `Deliverables: ${lane.deliverables}`,
    `Territory: ${lane.territory}`,
  ].join('\n')
}

/** The lane's first message: its own contract plus THE FENCES — the sibling
 *  lanes' territories, so the harmony law rides the brief even before the
 *  worker's contract tool reads the agreement off the record. */
export function managerLaneBriefOf(plan: ManagerPlanV1, laneIndex: number): string {
  const lane = plan.lanes[laneIndex]!
  const siblings = plan.lanes.filter((_, i) => i !== laneIndex)
  const fences =
    siblings.length > 0
      ? `\n\nLanes working beside you own: ${siblings.map(s => `"${s.title}" — ${s.territory}`).join(' · ')}. Stay off their estate; your work lives inside your own territory.`
      : ''
  return `${lane.scope}\n\nDeliverables: ${lane.deliverables}\nYour territory: ${lane.territory}${fences}`
}

// ── THE MANAGER'S MODEL (ledger L22) ─────────────────────────────────────────
//  Manager mode is the composer's own gesture whatever the coordinator's
//  mode: its turn still needs a model, and the composed coordinator model —
//  the assistModel choice validated against the composed registry, exactly
//  as agent-assisted validates it — serves in every mode. With none chosen
//  (or an unlisted id) the callers say so and name the pick: the composer's
//  note line, the pane's harness row. Never a silent no-op, never a session
//  launched in the mode's name, never a crash.

/** The one honest line for a manager turn with no model to run on. */
// The note row truncates its MIDDLE, so the key
// must live in the TAIL the cut preserves — the old wording parked ⌃s
// mid-line and the ellipsis ate exactly the key the line exists to teach
// (manager mode needs…tor chip) picks one).
export const MANAGER_NEEDS_MODEL_LINE =
  'manager mode needs a coordinator model — the rail’s coordinator chip or ⌃s picks one'

export type ManagerModelResolution =
  | { ok: true; modelId: string; label: string }
  | { ok: false; reason: 'no-choice' | 'unknown-model' | 'unreadable'; line: string }

export async function resolveManagerModel(): Promise<ManagerModelResolution> {
  let choice: string | undefined
  try {
    const { getGlobalConfig } = await import('../../utils/config.js')
    choice = getGlobalConfig().concourseCoordinator?.assistModel
  } catch {
    // Config unavailable (headless/fixture): the honest answer is "no pick",
    // never a guessed model.
    // Class 5: the authored line is a KEY HINT — it folds to the host's
    // spelling where the resolution is built (per call, never at import),
    // so the exported authored const stays pin-stable on every host.
    return { ok: false, reason: 'unreadable', line: keyHintLabel(MANAGER_NEEDS_MODEL_LINE) }
  }
  const { validateCoordinatorModelChoice } = await import('./coordinatorModels.js')
  const validated = await validateCoordinatorModelChoice(choice)
  if (!validated.ok) {
    return {
      ok: false,
      reason: validated.reason,
      line:
        validated.reason === 'no-choice'
          ? keyHintLabel(MANAGER_NEEDS_MODEL_LINE)
          : `manager mode needs a coordinator model — "${choice ?? ''}" is not in the composed registry; ${keyHintLabel('⌃s')} picks one`,
    }
  }
  return { ok: true, modelId: validated.entry.modelId, label: validated.entry.displayName }
}

// ── the plan executor (the ONE Yes — landed doors only) ─────────────────────
//
//  CONTRACT BEFORE THE FIRST TURN (the lead's hold, built to the letter):
//  the dispatch door admits AND delivers at admit — a contract verb behind
//  it would land on a lane whose first turn is already armed, and the
//  worker would acknowledge an agreement it never saw at birth. So a plan
//  lane starts the way the ContractOfferCard's Yes leg starts a session,
//  exactly: (1) the BIRTH door — sessionAdmit with bornBlank (a live runner,
//  no words sent), (2) the landed contract verb on the born session, (3) the
//  first turn delivered through the redirect leg of the one dispatch door
//  (targetSessionId — the same idempotent owner every steering message
//  rides). The first frame a plan lane ever receives finds its contract on
//  the record. No lane of a plan EVER rides the admit-and-deliver form.
//
//  The birth door refuses past the machine's reading instead of queueing
//  (a queued dispatch would deliver its first frame from the pump with no
//  contract on the record — the exact poison). Lanes past the reading WAIT
//  in the plan and start, under their contracts, as seats free.

export interface ManagerPlanExecutionV1 {
  receipts: CoordinatorToolReceiptV1[]
  laneSessionIds: Array<string | null>
  /** Lanes held back for a seat (lane-ordered indices). */
  laneWaiting: number[]
}

export interface ManagerLaneStartV1 {
  receipts: CoordinatorToolReceiptV1[]
  /** The born session, or null when the birth refused. */
  sessionId: string | null
  /** The birth refused for want of a seat — the lane waits. */
  noSeat: boolean
}

const lostReply = (reply: Record<string, unknown>): boolean =>
  reply.code === 'ETIMEOUT' || reply.code === 'ENOCONN'

const liveRpc: CoordinatorRpc = async (req, opts) => {
  const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
  return (await daemonControlRpc(req as never, opts)) as Record<string, unknown>
}

async function actingSeat(by: string | undefined): Promise<string> {
  if (by !== undefined) return by
  const { coordinatorAgentId } = await import('./coordinatorIdentity.js')
  return coordinatorAgentId().catch(() => 'coordinator-unresolved' as never)
}

/** ONE lane's start — the three landed doors in the only lawful order:
 *  birth blank → contract set → first turn delivered. */
export async function startManagerLane(
  plan: ManagerPlanV1,
  laneIndex: number,
  init: { workspaceRoot: string; by?: string; rpc?: CoordinatorRpc },
): Promise<ManagerLaneStartV1> {
  const rpc = init.rpc ?? liveRpc
  const by = await actingSeat(init.by)
  const lane = plan.lanes[laneIndex]!
  const receipts: CoordinatorToolReceiptV1[] = []
  // (1) THE BIRTH — the one birth door's own op, blank: a live runner and a
  // board row, no words. The defaulted fold applies (a held repo forks the
  // lane onto its own worktree — the mechanical isolation beside harmony).
  let born: Record<string, unknown>
  try {
    born = await rpc(
      { op: 'sessionAdmit', workspaceDir: init.workspaceRoot, title: lane.title, bornBlank: true },
      { timeoutMs: 30_000 },
    )
  } catch (e) {
    born = { ok: false, code: 'ENOCONN', error: e instanceof Error ? e.message : String(e) }
  }
  const sessionId = born.ok === true && typeof born.sessionId === 'string' && born.sessionId.length > 0 ? born.sessionId : null
  // The kit-source line: a board lane's birth is a derivation
  // road — the lane receipt names it so the plan card's launch row says
  // what the lane loads.
  const laneKitSource = born.ok === true && typeof born.kitSource === 'string' && born.kitSource.length > 0 ? born.kitSource : undefined
  if (sessionId === null) {
    const noSeat = born.refusal === 'runtime-ceiling'
    receipts.push({
      verb: 'session.launch',
      objectRef: `lane:${laneIndex + 1}`,
      outcome: lostReply(born) ? 'failed' : 'refused',
      detail: noSeat
        ? `"${lane.title}" waits for a seat — it starts under its contract when one frees`
        : `"${lane.title}" — ${typeof born.error === 'string' ? born.error : 'the birth was refused'}`,
      feedEligible: true,
    })
    return { receipts, sessionId: null, noSeat }
  }
  // (2) THE LANDED VERB (T2–T4) on the born session — BEFORE any word
  // reaches it: the worker's first read finds the agreement on the record.
  let contractReply: Record<string, unknown>
  try {
    contractReply = await rpc(
      {
        op: 'sessionControl',
        action: 'contract',
        sessionId,
        by,
        contract: { op: 'set', text: managerContractTextOf(plan, lane) },
      },
      { timeoutMs: 10_000 },
    )
  } catch (e) {
    contractReply = { ok: false, code: 'ENOCONN', error: e instanceof Error ? e.message : String(e) }
  }
  const contractOk = contractReply.ok === true
  receipts.push({
    verb: 'contract.set',
    objectRef: sessionId,
    outcome: contractOk ? 'applied' : lostReply(contractReply) ? 'failed' : 'refused',
    detail: contractOk
      ? `"${lane.title}" — contract on the record before its first turn; the worker acknowledges in its own words`
      : `${typeof contractReply.error === 'string' ? contractReply.error : 'the contract was not set'} · the brief still carries the agreement; /contract retries`,
  })
  // (3) THE FIRST TURN — the redirect leg of the one dispatch door: the
  // lane brief (its contract + the sibling fences) delivered INTO the born
  // session. A refused set never un-births (the offer card's law): the
  // brief carries the agreement's words either way.
  const { randomUUID } = await import('../../utils/crypto.js')
  const clientMessageId = `mgr-launch-${randomUUID()}`
  let delivered: Record<string, unknown>
  try {
    delivered = await rpc(
      {
        op: 'sessionDispatch',
        clientMessageId,
        prompt: managerLaneBriefOf(plan, laneIndex),
        workspaceDir: '',
        targetSessionId: sessionId,
        by,
      },
      { timeoutMs: 20_000 },
    )
  } catch (e) {
    delivered = { ok: false, code: 'ENOCONN', error: e instanceof Error ? e.message : String(e) }
  }
  const deliveredOk = delivered.ok === true
  const heldReason = typeof delivered.heldReason === 'string' ? delivered.heldReason : undefined
  receipts.push({
    verb: 'session.launch',
    objectRef: sessionId,
    outcome: deliveredOk ? 'applied' : lostReply(delivered) ? 'failed' : heldReason !== undefined ? 'noop' : 'refused',
    detail: deliveredOk
      ? `"${lane.title}" — born blank, contract set, first turn delivered under it${typeof delivered.state === 'string' ? ` · ${delivered.state}` : ''}${laneKitSource !== undefined ? ` · kit ${laneKitSource}` : ''}`
      : heldReason !== undefined
        ? `"${lane.title}" — born under its contract; the first turn holds (${heldReason}) and delivers on its own`
        : `"${lane.title}" — born under its contract, but the first turn did not deliver: ${typeof delivered.error === 'string' ? delivered.error : 'the daemon refused'} · ↵ replays it`,
    opId: clientMessageId,
    feedEligible: true,
  })
  return { receipts, sessionId, noSeat: false }
}

/** Execute a consented plan: lanes [0, fits) start now (the caller derived
 *  `fits` from the machine's reading at the Yes — the seat-overload ask
 *  already consented to the rest waiting); the rest WAIT in the plan and
 *  the walker starts them as seats free. A birth the daemon refuses for a
 *  seat mid-run joins the waiting set (never a queued first frame). */
export async function executeManagerPlan(
  plan: ManagerPlanV1,
  init: { workspaceRoot: string; by?: string; rpc?: CoordinatorRpc; fits?: number },
): Promise<ManagerPlanExecutionV1> {
  const fits = Math.max(0, Math.min(plan.lanes.length, init.fits ?? plan.lanes.length))
  const receipts: CoordinatorToolReceiptV1[] = []
  const laneSessionIds: Array<string | null> = []
  const laneWaiting: number[] = []
  for (let i = 0; i < plan.lanes.length; i++) {
    if (i >= fits) {
      laneSessionIds.push(null)
      laneWaiting.push(i)
      receipts.push({
        verb: 'session.launch',
        objectRef: `lane:${i + 1}`,
        outcome: 'noop',
        detail: `"${plan.lanes[i]!.title}" waits for a seat — it starts under its contract when one frees`,
      })
      continue
    }
    const started = await startManagerLane(plan, i, init)
    receipts.push(...started.receipts)
    laneSessionIds.push(started.sessionId)
    // EVERY unlaunched lane stays in the plan's books (FC-061): only the
    // runtime-ceiling refusal joined laneWaiting, so any other refusal
    // (a birth-door refusal, a lost connection) fell out of BOTH books —
    // the dispatch count stopped adding up and the lane was gone for good.
    // A waiting non-seat lane re-attempts when a seat frees; a door that
    // still refuses answers a fresh receipt and the lane keeps waiting —
    // bounded, and never a silent loss.
    if (started.sessionId === null) laneWaiting.push(i)
  }
  return { receipts, laneSessionIds, laneWaiting }
}

// ── supervising-light (T8 lead default b — no new watcher machinery) ────────

/** The in-process supervision register: the last DISPATCHED plan — its
 *  started lanes (the rows half) and its WAITING lanes (the start half).
 *  Seeded by the Yes handler in the same process; after a restart it
 *  re-seeds lazily from the durable conversation (one read). */
interface SupervisedLaneV1 {
  sessionId: string
  title: string
}
interface SupervisedPlanV1 {
  lanes: SupervisedLaneV1[]
  supervision: 'supervising' | 'launch-only'
  /** The plan as stored, plus where it lives — the start half re-runs the
   *  three doors for a waiting lane and writes the lane id back. */
  plan: ManagerPlanV1
  entryId?: string
  workspaceRoot?: string
}
let supervised: SupervisedPlanV1 | null = null
let seededFromStore = false
/** Rows this process already appended (or found present) — a finished lane
 *  lingering on the board must not cost a store read every snapshot beat. */
const appliedRowIds = new Set<string>()
/** The start half runs ONE lane at a time — a beat that lands while a
 *  birth is in flight must not birth the same lane twice. */
let startingLane = false

export function registerDispatchedManagerPlan(
  plan: ManagerPlanV1,
  home: { entryId?: string; workspaceRoot?: string } = {},
): void {
  const lanes: SupervisedLaneV1[] = []
  plan.lanes.forEach((lane, i) => {
    const sid = plan.laneSessionIds?.[i]
    if (typeof sid === 'string' && sid.length > 0) lanes.push({ sessionId: sid, title: lane.title })
  })
  supervised = {
    lanes,
    supervision: plan.supervision,
    plan,
    ...(home.entryId !== undefined ? { entryId: home.entryId } : {}),
    ...(home.workspaceRoot !== undefined ? { workspaceRoot: home.workspaceRoot } : {}),
  }
  seededFromStore = true
}

/** A waiting lane whose birth was refused for a reason other than the seat
 *  waits THIS long before the walker tries it again (the board rebuilds on
 *  every snapshot beat; without the backoff the walker issued an unbounded
 *  series of 30 s birth RPCs while the plan card showed the lane waiting
 *  with no reason given — FN-017 rank 9). Keyed per plan entry + lane. */
const WAITING_LANE_BACKOFF_MS = 60_000
const laneRetryAfter = new Map<string, number>()
const laneKey = (entryId: string | undefined, laneIndex: number): string => `${entryId ?? 'plan'}:${laneIndex}`

export function _resetManagerSupervisionForTesting(): void {
  supervised = null
  seededFromStore = false
  startingLane = false
  appliedRowIds.clear()
  laneRetryAfter.clear()
}

/** THE START HALF (the seat-overload consent's second clause): a waiting
 *  lane starts under its contract the moment the machine's reading affords
 *  it — one lane per beat, through the same three doors the Yes used; the
 *  plan entry and the register take the lane id, and a harness row says
 *  so. Independent of the supervision toggle (starting is the launch the
 *  operator consented to, not supervision). Returns the started lane
 *  index, or null. */
export async function startWaitingManagerLane(
  counts: { live: number; ceiling: number },
  init: { rpc?: CoordinatorRpc; by?: string } = {},
  dir?: string,
): Promise<number | null> {
  if (supervised === null || startingLane) return null
  const waiting = supervised.plan.laneWaiting ?? []
  if (waiting.length === 0 || counts.live >= counts.ceiling) return null
  const workspaceRoot = supervised.workspaceRoot
  if (workspaceRoot === undefined) return null
  const now = Date.now()
  const entryId = supervised.entryId
  // The first waiting lane that is not inside its refusal backoff.
  const laneIndex = waiting.find(i => (laneRetryAfter.get(laneKey(entryId, i)) ?? 0) <= now)
  if (laneIndex === undefined) return null
  startingLane = true
  try {
    const started = await startManagerLane(supervised.plan, laneIndex, { workspaceRoot, ...init })
    if (started.sessionId === null) {
      // A refusal for the seat keeps waiting exactly as before (the seat
      // rule is the walker's own contract). Any OTHER refusal — the daemon
      // unreachable, no repository, a typed refusal — carries its receipts
      // out as a harness row under an id stable per lane (a repeated
      // identical refusal replaces its own row, never a second one) and
      // backs the walker off, so the one sentence explaining why the lane
      // waits is never minted and thrown away (FN-017 rank 9).
      if (!started.noSeat) {
        laneRetryAfter.set(laneKey(entryId, laneIndex), now + WAITING_LANE_BACKOFF_MS)
        if (entryId !== undefined) {
          try {
            const conv = await import('./coordinatorConversation.js')
            await conv.appendCoordinatorConversation(
              {
                id: `mgr:wait:${entryId}:${laneIndex}`,
                role: 'coordinator',
                text: `lane "${supervised.plan.lanes[laneIndex]!.title}" still waits — its start was refused; the walker retries in ${Math.round(WAITING_LANE_BACKOFF_MS / 1000)}s`,
                ts: now,
                harness: true,
                receipts: started.receipts.map(r => ({
                  verb: r.verb,
                  outcome: r.outcome,
                  label: `${r.verb} ${r.outcome}${r.detail !== undefined ? ` — ${r.detail}` : ''}`.slice(0, 220),
                })),
              },
              dir,
            )
          } catch {
            /* the receipt row is best-effort; the backoff already holds */
          }
        }
      }
      return null
    }
    const laneSessionIds = [...(supervised.plan.laneSessionIds ?? supervised.plan.lanes.map(() => null))]
    laneSessionIds[laneIndex] = started.sessionId
    const laneWaiting = waiting.filter(i => i !== laneIndex)
    supervised.plan = { ...supervised.plan, laneSessionIds, ...(laneWaiting.length > 0 ? { laneWaiting } : {}) }
    if (laneWaiting.length === 0) delete supervised.plan.laneWaiting
    supervised.lanes.push({ sessionId: started.sessionId, title: supervised.plan.lanes[laneIndex]!.title })
    if (supervised.entryId !== undefined) {
      await markManagerPlanState(supervised.entryId, { state: 'dispatched', laneSessionIds, laneWaiting }, dir)
      try {
        const conv = await import('./coordinatorConversation.js')
        await conv.appendCoordinatorConversation(
          {
            id: `mgr:start:${supervised.entryId}:${laneIndex}`,
            role: 'coordinator',
            text: `a seat freed — lane "${supervised.plan.lanes[laneIndex]!.title}" started under its contract`,
            ts: Date.now(),
            harness: true,
            receipts: started.receipts.map(r => ({
              verb: r.verb,
              outcome: r.outcome,
              label: `${r.verb} ${r.outcome}${r.detail !== undefined ? ` — ${r.detail}` : ''}`.slice(0, 220),
            })),
          },
          dir,
        )
      } catch {
        /* the row is a courtesy; the lane started */
      }
    }
    return laneIndex
  } finally {
    startingLane = false
  }
}

/** PURE fold — the prover's leg: which idempotent harness rows a snapshot
 *  beat owes the conversation for the supervised lanes. Row ids are stable
 *  per (lane, kind), so re-appending is structurally impossible for a
 *  caller that skips ids already present. */
export function superviseLandEntries(
  lanes: readonly SupervisedLaneV1[],
  rows: ReadonlyArray<{ sessionId: string; state: string }>,
): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = []
  for (const lane of lanes) {
    const row = rows.find(r => r.sessionId === lane.sessionId)
    if (row === undefined) continue
    if (row.state === 'ready-to-review' || row.state === 'completed') {
      out.push({
        id: `mgr:land:${lane.sessionId}`,
        text: `lane "${lane.title}" finished — its receipt is on the row (ready to review)`,
      })
    } else if (row.state === 'failed') {
      out.push({
        id: `mgr:land:${lane.sessionId}`,
        text: `lane "${lane.title}" failed — its row has the reason`,
      })
    } else if (row.state === 'needs-you' || row.state === 'stalled') {
      out.push({
        id: `mgr:needs:${lane.sessionId}`,
        text: `lane "${lane.title}" needs you — answer on its row`,
      })
    }
  }
  return out
}

/** The impure walker the pane's EXISTING snapshot subscription calls (no
 *  timers, no watchers of its own): reads the conversation once, appends
 *  only the rows whose ids are absent, in the HARNESS voice. launch-only
 *  appends nothing (the calmer toggle). */
export async function appendManagerSupervisionRows(
  rows: ReadonlyArray<{ sessionId: string; state: string }>,
  dir?: string,
): Promise<number> {
  if (!seededFromStore && supervised === null) {
    // One lazy seed after a restart: the last dispatched plan in the
    // durable conversation carries the lanes.
    seededFromStore = true
    try {
      const conv = await import('./coordinatorConversation.js')
      const entries = await conv.readCoordinatorConversation(dir)
      for (let i = entries.length - 1; i >= 0; i--) {
        const plan = (entries[i] as { plan?: unknown }).plan
        const decoded = plan !== undefined ? decodeManagerPlan(plan) : null
        if (decoded !== null && decoded.state === 'dispatched') {
          registerDispatchedManagerPlan(decoded, {
            entryId: entries[i]!.id,
            ...(decoded.workspaceRoot !== undefined ? { workspaceRoot: decoded.workspaceRoot } : {}),
          })
          break
        }
      }
    } catch {
      /* the register stays empty — supervision is a convenience */
    }
  }
  if (supervised === null || supervised.supervision !== 'supervising' || supervised.lanes.length === 0) return 0
  const owed = superviseLandEntries(supervised.lanes, rows).filter(r => !appliedRowIds.has(r.id))
  if (owed.length === 0) return 0
  try {
    const conv = await import('./coordinatorConversation.js')
    const present = new Set((await conv.readCoordinatorConversation(dir)).map(e => e.id))
    let appended = 0
    for (const row of owed) {
      appliedRowIds.add(row.id)
      if (present.has(row.id)) continue
      await conv.appendCoordinatorConversation(
        { id: row.id, role: 'coordinator', text: row.text, ts: Date.now(), harness: true },
        dir,
      )
      appended++
    }
    return appended
  } catch {
    return 0
  }
}

/** Update a stored plan entry's state in place (No → declined-kept; Yes →
 *  dispatched with the lane ids). Same id, same ts — the store's
 *  filter-replace keeps ONE row; the entry was the conversation's last, so
 *  the re-append keeps its seat. */
export async function markManagerPlanState(
  entryId: string,
  next: {
    state: ManagerPlanStateV1
    laneSessionIds?: Array<string | null>
    /** The waiting set as it stands (an empty array clears it). */
    laneWaiting?: number[]
    workspaceRoot?: string
  },
  dir?: string,
): Promise<boolean> {
  try {
    const conv = await import('./coordinatorConversation.js')
    const entries = await conv.readCoordinatorConversation(dir)
    const entry = entries.find(e => e.id === entryId) as
      | (import('./coordinatorConversation.js').CoordinatorConversationEntryV1 & { plan?: unknown })
      | undefined
    if (entry === undefined) return false
    const plan = entry.plan !== undefined ? decodeManagerPlan(entry.plan) : null
    if (plan === null) return false
    const { laneWaiting: standingWaiting, ...rest } = plan
    const laneWaiting = next.laneWaiting ?? standingWaiting
    await conv.appendCoordinatorConversation(
      {
        ...entry,
        plan: {
          ...rest,
          state: next.state,
          ...(next.laneSessionIds !== undefined ? { laneSessionIds: next.laneSessionIds } : {}),
          ...(laneWaiting !== undefined && laneWaiting.length > 0 ? { laneWaiting } : {}),
          ...(next.workspaceRoot !== undefined ? { workspaceRoot: next.workspaceRoot } : {}),
        },
      } as never,
      dir,
    )
    return true
  } catch {
    return false
  }
}
