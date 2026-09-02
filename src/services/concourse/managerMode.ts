
import type { CoordinatorRpc, CoordinatorToolDef, CoordinatorToolReceiptV1 } from './coordinatorTools.js'
import { keyHintLabel } from '../../components/mercury-ui/keyHintLabel.js'


export const MAX_MANAGER_ASK_OPTIONS = 4
export const MAX_MANAGER_LANES = 6

export interface ManagerAskV1 {
  question: string
  options: string[]
  index?: number
}

export interface ManagerLaneV1 {
  title: string
  scope: string
  deliverables: string
  territory: string
}

export type ManagerPlanStateV1 = 'proposed' | 'declined' | 'dispatched'

export interface ManagerPlanV1 {
  goal: string
  lanes: ManagerLaneV1[]
  seats?: string
  supervision: 'supervising' | 'launch-only'
  state: ManagerPlanStateV1
  laneSessionIds?: Array<string | null>
  laneWaiting?: number[]
  workspaceRoot?: string
}

const str = (v: unknown, cap: number): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, cap) : undefined

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


export type AskCardKeyAction =
  | { kind: 'select'; index: number }
  | { kind: 'enough' }
  | { kind: 'ignore' }

export function askCardKeyAction(
  input: string,
  facts: {
    optionCount: number
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


export function managerContractTextOf(plan: ManagerPlanV1, lane: ManagerLaneV1): string {
  return [
    `Goal: ${plan.goal}`,
    `Scope: ${lane.scope}`,
    `Deliverables: ${lane.deliverables}`,
    `Territory: ${lane.territory}`,
  ].join('\n')
}

export function managerLaneBriefOf(plan: ManagerPlanV1, laneIndex: number): string {
  const lane = plan.lanes[laneIndex]!
  const siblings = plan.lanes.filter((_, i) => i !== laneIndex)
  const fences =
    siblings.length > 0
      ? `\n\nLanes working beside you own: ${siblings.map(s => `"${s.title}" — ${s.territory}`).join(' · ')}. Stay off their estate; your work lives inside your own territory.`
      : ''
  return `${lane.scope}\n\nDeliverables: ${lane.deliverables}\nYour territory: ${lane.territory}${fences}`
}


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


export interface ManagerPlanExecutionV1 {
  receipts: CoordinatorToolReceiptV1[]
  laneSessionIds: Array<string | null>
  laneWaiting: number[]
}

export interface ManagerLaneStartV1 {
  receipts: CoordinatorToolReceiptV1[]
  sessionId: string | null
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

export async function startManagerLane(
  plan: ManagerPlanV1,
  laneIndex: number,
  init: { workspaceRoot: string; by?: string; rpc?: CoordinatorRpc },
): Promise<ManagerLaneStartV1> {
  const rpc = init.rpc ?? liveRpc
  const by = await actingSeat(init.by)
  const lane = plan.lanes[laneIndex]!
  const receipts: CoordinatorToolReceiptV1[] = []
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
    if (started.sessionId === null) laneWaiting.push(i)
  }
  return { receipts, laneSessionIds, laneWaiting }
}


interface SupervisedLaneV1 {
  sessionId: string
  title: string
}
interface SupervisedPlanV1 {
  lanes: SupervisedLaneV1[]
  supervision: 'supervising' | 'launch-only'
  plan: ManagerPlanV1
  entryId?: string
  workspaceRoot?: string
}
let supervised: SupervisedPlanV1 | null = null
let seededFromStore = false
const appliedRowIds = new Set<string>()
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
  const laneIndex = waiting.find(i => (laneRetryAfter.get(laneKey(entryId, i)) ?? 0) <= now)
  if (laneIndex === undefined) return null
  startingLane = true
  try {
    const started = await startManagerLane(supervised.plan, laneIndex, { workspaceRoot, ...init })
    if (started.sessionId === null) {
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
      }
    }
    return laneIndex
  } finally {
    startingLane = false
  }
}

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

export async function appendManagerSupervisionRows(
  rows: ReadonlyArray<{ sessionId: string; state: string }>,
  dir?: string,
): Promise<number> {
  if (!seededFromStore && supervised === null) {
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

export async function markManagerPlanState(
  entryId: string,
  next: {
    state: ManagerPlanStateV1
    laneSessionIds?: Array<string | null>
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
