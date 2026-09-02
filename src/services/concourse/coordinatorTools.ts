// ============================================================================
// services/concourse/coordinatorTools — (sheet): the
//  coordinator's typed, in-process tool set. Each tool is a THIN wrapper over
//  an existing door — concourseDispatch / concourseControl / concourseRelease
//  through daemonControlRpc (the SAME doors the operator's own controls use;
//  never a parallel path), plus read-only repo access hard-sandboxed to the
//  workspace root. No shell, no writes, no reach inside a session's work —
//  the sandbox IS these functions' path checks and the doors' own typed
//  refusals.
//
//  Q3: stop on a workflows-allowed session is a
//  TWO-STEP — the tool returns a typed needs-your-confirmation result
//  instead of acting unless the call carries operatorConfirmed:true (the UI
//  relays the operator's y/n as a new message; the tool trusts the flag and
//  enforces the step, the persona owns "only when the operator asked").
//
//  Every state-changing verb settles as a receipt row (verb · object ·
//  outcome · durable opId) so the turn can row it on the feed and the
//  conversation as it lands — read-only tools return content only. Transport
//  loss is 'failed', never a refusal (advisor item 8): the minted op
//  identity replays through the daemon's idempotent ledgers on retry.
//
//  The awareness pass (the live tool-use guidance read that day:
//  descriptions carry when-and-when-not; error results carry what went wrong
//  AND what to try next): every description says when to use the tool and
//  when another one is right; list_sessions is the coordinatorBoard view
//  (the same world-state the turn opens with); launch_session's `sources`
//  writes each source's branch/worktree/commit state INTO the brief; and
//  finishToolResult (the post-tool seam, one call site in the turn loop)
//  guarantees a refusal reaches the model as a full sentence + a next move,
//  flagged is_error.
// ============================================================================

import { PROJECT_CONFIG_DIR_NAMES } from '../../utils/projectConfig.js'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod/v4'

// ── receipt + runtime shapes (the lane and the turn both import these) ──────

/** A settled tool verb. `verb` extends the kernel receipt vocabulary with the
 *  switchboard verbs (session.launch · session.stop · workflows.grant ·
 *  workflows.revoke · permission.answer); rows whose verb the kernel feed
 *  classifier already labels carry feedEligible so the lane rows them on the
 *  semantic activity feed live. */
export interface CoordinatorToolReceiptV1 {
  verb: string
  objectRef: string
  /** 'queued' is the HELD-OPEN outcome: the daemon holds a durable ledger
   *  row (typed heldReason) that acts when the hold lifts — a queue is not
   *  a refusal, and saying 'refused' for a session that later starts is the
   *  receipt lying (the live seat-ceiling sighting). */
  outcome: 'applied' | 'noop' | 'queued' | 'refused' | 'failed'
  detail?: string
  /** The minted durable operation identity (clientMessageId / clientOpId). */
  opId?: string
  /** Set when the verb is in the kernel feed classifier's vocabulary — the
   *  lane feed-rows exactly these (a foreign verb would lift label-less). */
  feedEligible?: true
}

/** The per-turn runtime the lane threads into the live call (IP-5): streaming
 *  deltas into the conversation store and receipts as each verb settles. */
export interface CoordinatorTurnRuntime {
  /** The acting seat (coordinator identity) stamped on every daemon op. */
  by?: string
  /** Fires with the ACCUMULATED visible text as deltas arrive. */
  onDelta?: (textSoFar: string) => void
  /** Fires once per settled state-changing verb. */
  onReceipt?: (receipt: CoordinatorToolReceiptV1) => void
  /** Proof seam — explicit store root for obligations reads. */
  crewDir?: string
}

/** Q3's typed two-step: returned as the tool RESULT (never an action) when a
 *  stop would reach a workflows-allowed session without operatorConfirmed.
 *  The model asks the operator in plain words; the confirmed re-call carries
 *  operatorConfirmed:true. */
export interface CoordinatorNeedsConfirmationV1 {
  ok: false
  needsConfirmation: true
  tool: 'stop_session'
  sessionId: string
  why: string
  next: string
}

export interface CoordinatorToolResult {
  /** JSON string handed back to the model as the tool_result content. */
  content: string
  /** Receipt rows for state-changing verbs (read tools return none). */
  receipts?: CoordinatorToolReceiptV1[]
}

// ── the execution context (injectable seams; defaults bind lazily) ──────────

type RpcReply = Record<string, unknown>
export type CoordinatorRpc = (req: unknown, opts?: { timeoutMs?: number }) => Promise<RpcReply>

interface WorkerRecordView {
  runnerId: string
  sessionId: string
  title?: string
  workspaceId?: string
  modelKey?: string
  effort?: string
  pid?: number
  endedAt?: number
  pausedAt?: number
  workflowsAllowed?: true
  /** Drive-12 (the coordinator-blindness law): where it runs and where its
   *  work is — attached = open in the operator's terminal (alive there,
   *  daemon child dead by design); the fork's branch + worktree path. */
  attachedAt?: number
  isolation?: string
  branchName?: string
  worktreePath?: string
  spawnedAt?: number
}

export interface CoordinatorToolContext {
  /** The repo the coordinator sits on — the read sandbox root. */
  workspaceRoot: string
  /** The acting seat stamped as `by` on every daemon op. */
  by: string
  crewDir?: string
  rpc: CoordinatorRpc
  /** The worker records (liveRecordBySession — the two-step's tag check);
   *  the board itself rides coordinatorBoardView, the one projection. */
  readWorkers: () => Promise<Record<string, WorkerRecordView>>
}

/** Production context: every seam binds lazily at CALL time so importing the
 *  tool layer never touches the daemon socket or the config home (proofs
 *  inject recorders instead). */
export function createCoordinatorToolContext(init: {
  workspaceRoot: string
  by: string
  crewDir?: string
  rpc?: CoordinatorRpc
  readWorkers?: () => Promise<Record<string, WorkerRecordView>>
}): CoordinatorToolContext {
  return {
    workspaceRoot: init.workspaceRoot,
    by: init.by,
    ...(init.crewDir !== undefined ? { crewDir: init.crewDir } : {}),
    rpc:
      init.rpc ??
      (async (req, opts) => {
        const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
        const reply = (await daemonControlRpc(req as never, opts)) as RpcReply
        if (reply.code !== 'ENOCONN') return reply
        // Live-drive finding 1: the MANAGER heals its own
        // daemon — spawn the owned daemon, wait for the socket, retry the
        // SAME request once. The op vocabulary is idempotent (dispatch
        // ledger / by-state controls), so one retry is safe; a heal that
        // fails returns the original honest ENOCONN.
        const { ensureOwnedDaemon } = await import('../switchboard/ensureDaemon.js')
        if (!(await ensureOwnedDaemon())) return reply
        return (await daemonControlRpc(req as never, opts)) as RpcReply
      }),
    readWorkers:
      init.readWorkers ??
      (async () => {
        // The supervisor reads records off disk; a missing daemon home
        // yields the honest empty (hermetic runs).
        try {
          const sup = await import('../../daemon/concourseSupervisor.js')
          return sup.readSessionWorkers() as unknown as Record<string, WorkerRecordView>
        } catch {
          return {}
        }
      }),
  }
}

// ── the read sandbox (exported for the prover) ──────────────────────────────

function safeRealpath(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

/** Realpath of the deepest EXISTING ancestor, re-joined with the missing
 *  tail — a nonexistent leaf must not dodge the symlink-escape check by
 *  making realpath throw. */
function nearestRealpath(p: string): string | null {
  let base = p
  const tail: string[] = []
  for (let hops = 0; hops < 128; hops++) {
    const real = safeRealpath(base)
    if (real !== null) return tail.length > 0 ? join(real, ...tail.slice().reverse()) : real
    const up = dirname(base)
    if (up === base) return null
    tail.push(basename(base))
    base = up
  }
  return null
}

/** '~'/'~/x' spoken paths expand to the real home — launch_session
 *  only (the read sandbox below deliberately keeps its root discipline). */
export function expandTildePath(p: string): string {
  if (p === '~') return homedir()
  // WIN-4: both separators — '~\\Desktop\\x' is the same spoken intent
  // (house idiom: the dirt-law splitter accepts both too).
  if (/^~[\\/]/.test(p)) return join(homedir(), p.slice(2))
  return p
}

// ── THE GROUND LAW's folder memory ──────────────
//  "If Mercury has worked there before, Mercury can work there again": the
//  known-folder set = every workspace the concourse ledgers ever carried +
//  a BOUNDED shallow scan of the operator's usual roots for Mercury marks
//  (MERCURY.md / CLAUDE.md / .mercury). Cached briefly;
//  never a deep walk.
let knownDirsCache: { at: number; dirs: string[] } | null = null
export async function knownProjectDirs(): Promise<string[]> {
  if (knownDirsCache !== null && Date.now() - knownDirsCache.at < 60_000) return knownDirsCache.dirs
  const out = new Set<string>()
  const addIfDir = (p: unknown): void => {
    if (typeof p !== 'string' || p.length === 0) return
    try {
      if (statSync(p).isDirectory()) out.add(resolve(p))
    } catch {
      /* gone — not a candidate */
    }
  }
  try {
    // Ledger memory: exact absolute workspaceIds from past launches.
    const dispatch = await import('../../daemon/concourseDispatch.js')
    for (const rec of Object.values(dispatch.readConcourseDispatches())) addIfDir(rec.workspaceId)
    const sup = await import('../../daemon/concourseSupervisor.js')
    for (const rec of Object.values(sup.readSessionWorkers())) addIfDir(rec.workspaceId)
  } catch {
    /* ledgers are projections */
  }
  try {
    // projectdirs ratchet: the home-dir names ride the ONE seam, never
    // re-quoted literals (the guide names are files, not homes).
    const MARKS = ['MERCURY.md', 'CLAUDE.md', ...PROJECT_CONFIG_DIR_NAMES]
    const roots = [
      homedir(),
      join(homedir(), 'Developer'),
      join(homedir(), 'Desktop'),
      join(homedir(), 'Documents'),
      join(homedir(), 'projects'),
      join(homedir(), 'code'),
    ]
    let statBudget = 400
    for (const root of roots) {
      let entries: string[] = []
      try {
        entries = readdirSync(root)
          .filter(n => !n.startsWith('.'))
          .slice(0, 120)
      } catch {
        continue
      }
      for (const name of entries) {
        if (statBudget <= 0) break
        const p = join(root, name)
        try {
          if (!statSync(p).isDirectory()) continue
        } catch {
          continue
        }
        statBudget -= 1
        if (MARKS.some(m => existsSync(join(p, m)))) out.add(p)
      }
    }
  } catch {
    /* the scan is a convenience — ledger memory stands alone */
  }
  const dirs = [...out]
  knownDirsCache = { at: Date.now(), dirs }
  return dirs
}

/** Resolve a SPOKEN folder ("fuck-u", "~/x", "backup/tools") to a real
 *  directory: absolute/~ → against the ground → the ground's parent → the
 *  home folder → the known-folder memory (unique basename match). null =
 *  genuinely unknown; the caller names the memory so one reply fixes it. */
export async function resolveSpokenProjectPath(spoken: string, ground: string): Promise<string | null> {
  const s = expandTildePath(spoken.trim())
  const candidates = isAbsolute(s)
    ? [resolve(s)]
    : [resolve(ground, s), resolve(dirname(ground), s), resolve(homedir(), s)]
  for (const c of candidates) {
    try {
      if (statSync(c).isDirectory()) return c
    } catch {
      /* next candidate */
    }
  }
  // WIN-4: strip trailing separators of either spelling; a compound path
  // (any interior separator) never fuzzy-matches by basename.
  const base = spoken
    .trim()
    .toLowerCase()
    .replace(/[\\/]+$/, '')
  if (base.length === 0 || /[\\/]/.test(base)) return null
  const hits = (await knownProjectDirs()).filter(p => basename(p).toLowerCase() === base)
  return hits.length === 1 ? (hits[0] ?? null) : null
}

/** THE sandbox: resolves `requested` (relative to the workspace root) and
 *  refuses anything whose lexical OR real path lands outside the root — a
 *  `..` walk and a symlink escape both return null. Read-only callers only;
 *  there is no write path through this module. */
export function resolveReadSandboxPath(workspaceRoot: string, requested: string): string | null {
  if (typeof requested !== 'string' || requested.length === 0 || requested.includes('\0')) return null
  const rootLex = resolve(workspaceRoot)
  const rootReal = safeRealpath(rootLex) ?? rootLex
  const absLex = isAbsolute(requested) ? resolve(requested) : resolve(rootLex, requested)
  const inside = (p: string, root: string): boolean => p === root || p.startsWith(root + sep)
  if (!inside(absLex, rootLex) && !inside(absLex, rootReal)) return null
  const real = nearestRealpath(absLex)
  if (real === null) return null
  if (!inside(real, rootLex) && !inside(real, rootReal)) return null
  return absLex
}

// ── shared folds ────────────────────────────────────────────────────────────

const lostReply = (reply: RpcReply): boolean => reply.code === 'ETIMEOUT' || reply.code === 'ENOCONN'

const rpcOutcome = (reply: RpcReply): CoordinatorToolReceiptV1['outcome'] => {
  if (reply.ok === true) {
    const o = reply.outcome
    return o === 'noop' ? 'noop' : 'applied'
  }
  return lostReply(reply) ? 'failed' : 'refused'
}

const rpcDetail = (reply: RpcReply): string | undefined => {
  if (reply.ok === true) return typeof reply.detail === 'string' ? reply.detail : undefined
  if (typeof reply.error === 'string' && reply.error.length > 0) return reply.error
  return lostReply(reply) ? 'the daemon did not answer' : 'the daemon refused'
}

/** The daemon's typed moves beside a refusal (ConcourseMoveV1 labels) — the
 *  "next" every refusal carries, in the daemon's own words. */
const rpcNext = (reply: RpcReply): string | undefined => {
  if (reply.ok === true) return undefined
  const moves = Array.isArray(reply.moves) ? (reply.moves as Array<{ label?: unknown }>) : []
  const labels = moves.map(m => (typeof m.label === 'string' ? m.label : '')).filter(l => l.length > 0)
  if (labels.length > 0) return labels.join(' / ')
  return lostReply(reply) ? 'retry the same call — the minted id replays exactly once' : undefined
}

const jsonResult = (value: unknown): string => JSON.stringify(value)

const refusalResult = (why: string, next?: string): CoordinatorToolResult => ({
  content: jsonResult({ ok: false, refused: why, ...(next !== undefined ? { next } : {}) }),
})

/** The refused/failed receipt row's detail: the reason as a full sentence
 *  plus the next move — the same words the tool result carries. */
const refusalDetail = (why: string | undefined, next: string | undefined): string | undefined =>
  why === undefined ? undefined : next !== undefined ? `${why} · next: ${next}` : why

/** THE POST-TOOL NORMALIZER (one call site: the turn loop). Every result
 *  leaves here in the shape the model can act on: a refused/failed result
 *  carries `refused`/`error` as a full sentence AND a `next` move, is
 *  flagged is_error so no runtime reads it as success, and its receipt rows
 *  carry the same sentence — a refusal is a negotiation, never a bare no. */
export function finishToolResult(
  toolName: string,
  out: CoordinatorToolResult,
): CoordinatorToolResult & { isError: boolean } {
  let parsed: Record<string, unknown> | null = null
  try {
    const v = JSON.parse(out.content) as unknown
    parsed = v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    parsed = null
  }
  // Q3's needs-your-confirmation is a protocol result, not an error — it
  // already carries why + next.
  if (parsed === null || parsed.ok !== false || parsed.needsConfirmation === true) return { ...out, isError: false }
  const failedReceipt = (out.receipts ?? []).find(r => r.outcome === 'failed')
  const refusedReceipt = (out.receipts ?? []).find(r => r.outcome === 'refused')
  const why =
    str(parsed.refused) ?? str(parsed.error) ?? failedReceipt?.detail ?? refusedReceipt?.detail ?? `${toolName} did not go through`
  const next =
    str(parsed.next) ?? (failedReceipt !== undefined ? 'retry the same call — the minted id replays exactly once' : undefined)
  const content = jsonResult({
    ...parsed,
    ...(str(parsed.refused) === undefined && str(parsed.error) === undefined ? { refused: why } : {}),
    ...(next !== undefined && str(parsed.next) === undefined ? { next } : {}),
  })
  const receipts = out.receipts?.map(r =>
    r.outcome === 'refused' || r.outcome === 'failed'
      ? { ...r, detail: r.detail !== undefined && r.detail.length > 0 ? r.detail : refusalDetail(why, next) }
      : r,
  )
  return { content, ...(receipts !== undefined ? { receipts } : {}), isError: true }
}

async function liveRecordBySession(ctx: CoordinatorToolContext, sessionId: string): Promise<WorkerRecordView | undefined> {
  return Object.values(await ctx.readWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

/** THE ONE launch-receipt effort clause (both launch arms — plain and
 *  contracted — speak it; the cross-model matrix pinned the split).
 *  `runsWord` is the stamped-truth label ONLY when it is a real ladder
 *  tier different from the stamp: the asked-vs-runs sentence exists for
 *  the KNOWN step-down (a ladder word to a ladder word). An external
 *  family's catalogue-cold truth answers 'default' — not a tier — and the
 *  old comparison turned that into a FABRICATED downgrade notice ("asked
 *  max; this model's ladder tops at default") on every engine launch: the
 *  stamp IS the record (the child resolves its provider's own vocabulary
 *  live), so the clause then speaks the stamp plain and claims no cap. */
function launchEffortClause(
  stamped: string,
  runsWord: string | undefined,
  tierWasAsked: boolean,
): { clause: string; runs?: string } {
  if (runsWord !== undefined && runsWord !== stamped) {
    return {
      clause: `@ ${runsWord} effort — asked ${stamped}; this model's ladder tops at ${runsWord}`,
      runs: runsWord,
    }
  }
  return { clause: `@ ${stamped} effort${tierWasAsked ? '' : ' (the default — no tier was asked)'}` }
}

// ── the tool definitions ────────────────────────────────────────────────────

export interface CoordinatorToolDef {
  name: string
  description: string
  inputJSONSchema: Record<string, unknown>
  run: (input: unknown, ctx: CoordinatorToolContext) => Promise<CoordinatorToolResult>
}

const CONTROL_TIMEOUT_MS = 15_000
const DISPATCH_TIMEOUT_MS = 20_000

function schema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false }
}

/** The workflows-allowed tag after a launch — its own door, its own receipt
 *  (the daemon owns the one-tag cap and refuses a second grant typed). */
async function grantWorkflowsTag(
  sessionId: string,
  ctx: CoordinatorToolContext,
): Promise<{ grant: { outcome: string; detail?: string }; receipt: CoordinatorToolReceiptV1 }> {
  let grantReply: RpcReply
  try {
    grantReply = await ctx.rpc(
      { op: 'sessionControl', action: 'grant-workflows', sessionId, by: ctx.by },
      { timeoutMs: CONTROL_TIMEOUT_MS },
    )
  } catch (e) {
    grantReply = { ok: false, code: 'ENOCONN', error: e instanceof Error ? e.message : String(e) }
  }
  const outcome = rpcOutcome(grantReply)
  const detail = rpcDetail(grantReply)
  return {
    grant: { outcome, ...(detail !== undefined ? { detail } : {}) },
    receipt: { verb: 'workflows.grant', objectRef: sessionId, outcome, ...(detail !== undefined ? { detail } : {}) },
  }
}

/** THE CONTRACTED LAUNCH — the manager executor's road, to the letter. The
 *  dispatch door admits AND delivers at admit, so a set_contract behind a
 *  plain launch always lands after the session's first frame: the worker's
 *  own acknowledge reads a record that had nothing at birth. A contract on
 *  the call therefore walks the three landed doors in the only lawful order:
 *  (1) the BIRTH door — sessionAdmit with bornBlank (a live runner, a board
 *  row, no words sent), (2) the landed contract verb on the born session,
 *  (3) the first turn through the redirect leg of the one dispatch door
 *  (targetSessionId — the same idempotent owner every steering message
 *  rides). No seat ⇒ a typed refusal, never a queue: a queued reservation
 *  delivers its first frame from the pump with nothing on the record (the
 *  exact poison). A refused set never un-births (the offer card's law): the
 *  first turn still delivers and the receipt names the miss. */
async function launchUnderContract(
  args: {
    task: string
    workspaceDir: string
    contract: string
    workflows: boolean
    sourcesNamed: Array<{ title: string; branch?: string }>
    title?: string
    model?: string
    effort?: string
    /** A saved preset the born session wears: resolved at
     *  the admit; unknown refuses typed before any birth. */
    preset?: string
  },
  ctx: CoordinatorToolContext,
): Promise<CoordinatorToolResult> {
  const { randomUUID } = await import('../../utils/crypto.js')
  // The durable identity of the first turn (door 3) — minted first so every
  // receipt of this launch, a refused birth included, carries one opId.
  const clientMessageId = `coord-launch-${randomUUID()}`
  const titleWord = `"${(args.title ?? args.task.split('\n')[0] ?? args.task).slice(0, 80)}"`
  const receipts: CoordinatorToolReceiptV1[] = []
  // (1) THE BIRTH — blank. The defaulted fold applies (a held repo forks the
  // session onto its own worktree), and the birth answer names the fork and
  // the model the way the dispatch door's does.
  let born: RpcReply
  try {
    born = await ctx.rpc(
      {
        op: 'sessionAdmit',
        workspaceDir: args.workspaceDir,
        bornBlank: true,
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.effort !== undefined ? { effort: args.effort } : {}),
        // The preset rides the birth door itself: the daemon
        // derives from ITS deltas; an unknown name refuses the birth typed.
        ...(args.preset !== undefined ? { kitPreset: args.preset } : {}),
      },
      { timeoutMs: DISPATCH_TIMEOUT_MS },
    )
  } catch (e) {
    born = { ok: false, code: 'ENOCONN', error: e instanceof Error ? e.message : String(e) }
  }
  const sessionId = born.ok === true ? str(born.sessionId) : undefined
  if (sessionId === undefined) {
    const noSeat = born.refusal === 'runtime-ceiling'
    const why = noSeat
      ? 'no seat is free — a contracted launch never queues (a queued start would take its first words with no agreement on the record)'
      : (rpcDetail(born) ?? 'the birth was refused')
    const next = noSeat
      ? 'wait for a seat (stop_session frees one), or launch without `contract` — that queues — and set_contract once it has started'
      : rpcNext(born)
    receipts.push({
      verb: 'session.launch',
      objectRef: clientMessageId,
      outcome: lostReply(born) ? 'failed' : 'refused',
      detail: refusalDetail(`${titleWord} — ${why}`, next),
      opId: clientMessageId,
    })
    return {
      content: jsonResult({ ok: false, clientMessageId, refused: why, ...(next !== undefined ? { next } : {}), ...(noSeat ? { noSeat: true } : {}) }),
      receipts,
    }
  }
  // (2) THE LANDED VERB on the born session — BEFORE any word reaches it.
  let setReply: RpcReply
  try {
    setReply = await ctx.rpc(
      { op: 'sessionControl', action: 'contract', sessionId, by: ctx.by, contract: { op: 'set', text: args.contract } },
      { timeoutMs: CONTROL_TIMEOUT_MS },
    )
  } catch (e) {
    setReply = { ok: false, code: 'ENOCONN', error: e instanceof Error ? e.message : String(e) }
  }
  const contractSet = setReply.ok === true
  const setMiss = rpcDetail(setReply) ?? 'the contract was not set'
  receipts.push({
    verb: 'contract.set',
    objectRef: sessionId,
    outcome: contractSet ? 'applied' : lostReply(setReply) ? 'failed' : 'refused',
    detail: contractSet
      ? `${titleWord} — contract on the record before its first turn; the worker acknowledges in its own words`
      : `${setMiss} · the session is born and gets its task; set_contract retries once it has started`,
  })
  // (3) THE FIRST TURN — the redirect leg of the one dispatch door: the task
  // delivered INTO the born session. A refused set never un-births.
  let delivered: RpcReply
  try {
    delivered = await ctx.rpc(
      { op: 'sessionDispatch', clientMessageId, prompt: args.task, workspaceDir: '', targetSessionId: sessionId, by: ctx.by },
      { timeoutMs: DISPATCH_TIMEOUT_MS },
    )
  } catch (e) {
    delivered = { ok: false, code: 'ENOCONN', error: e instanceof Error ? e.message : String(e) }
  }
  const ok = delivered.ok === true
  const state = str(delivered.state)
  const heldReason = str(delivered.heldReason)
  const branchName = str(born.branchName)
  const mainHolderTitle = str(born.mainHolderTitle)
  const launchedModel = str(born.modelDisplayName) ?? str(born.modelId)
  // The kit-source line: the birth answer names it —
  // and when the launch named a PRESET, the receipt names the
  // preset and carries the derivation's honesty note.
  const kitSource = str(born.kitSource)
  const presetWorn = str(born.presetName)
  const presetNote = str(born.presetNote)
  // The effort the birth stamped, spoken beside the model — with the
  // asked-vs-runs sentence when the model's own ladder tops below it (the
  // plain launch's law, on the contracted road). Env-free: the sentence is
  // about the BORN session, never this process's own pin.
  const bornEffort = str(born.effort)
  let effortClause: string | undefined
  let effortRuns: string | undefined
  if (bornEffort !== undefined) {
    const { resolveStampedEffortTruth, isEffortLevel } = await import('../../utils/effort.js')
    const modelForTruth = str(born.modelId)
    const truthLabel =
      modelForTruth !== undefined && isEffortLevel(bornEffort)
        ? resolveStampedEffortTruth(modelForTruth, bornEffort).label
        : undefined
    // A non-ladder truth label ('default' — the external catalogue-cold
    // states) claims no cap: the stamp is the record.
    const built = launchEffortClause(bornEffort, truthLabel !== undefined && isEffortLevel(truthLabel) ? truthLabel : undefined, args.effort !== undefined)
    effortClause = built.clause
    effortRuns = built.runs
  }
  const appliedDetail = [
    titleWord,
    launchedModel !== undefined ? `on ${launchedModel}` : undefined,
    effortClause,
    contractSet ? 'born blank, contract set, first turn delivered under it' : 'born blank, first turn delivered — the contract did NOT set',
    state,
    presetWorn !== undefined ? `wearing preset '${presetWorn}'` : kitSource !== undefined ? `kit ${kitSource}` : undefined,
    presetNote,
    branchName !== undefined ? `forked onto ${branchName}${mainHolderTitle !== undefined ? ` (main checkout held by "${mainHolderTitle}")` : ''}` : undefined,
    args.sourcesNamed.length > 0
      ? `brief names ${args.sourcesNamed.length} source${args.sourcesNamed.length === 1 ? '' : 's'}: ${args.sourcesNamed.map(s => s.branch ?? `"${s.title}" (main checkout)`).join(', ')}`
      : undefined,
  ]
    .filter((s): s is string => s !== undefined)
    .join(' · ')
  receipts.push({
    verb: 'session.launch',
    objectRef: sessionId,
    outcome: ok ? 'applied' : lostReply(delivered) ? 'failed' : heldReason !== undefined ? 'noop' : 'refused',
    detail: ok
      ? appliedDetail
      : heldReason !== undefined
        ? `${titleWord} — born under its contract; the first turn holds (${heldReason}) and delivers on its own`
        : refusalDetail(
            `${titleWord} — born under its contract, but the first turn did not deliver: ${rpcDetail(delivered) ?? 'the daemon refused'}`,
            rpcNext(delivered) ?? 'message_session delivers the task into it',
          ),
    opId: clientMessageId,
  })
  let workflowsGrant: { outcome: string; detail?: string } | undefined
  if (ok && args.workflows) {
    const tag = await grantWorkflowsTag(sessionId, ctx)
    workflowsGrant = tag.grant
    receipts.push(tag.receipt)
  }
  return {
    content: jsonResult({
      ok,
      clientMessageId,
      sessionId,
      road: 'born blank → contract set → first turn',
      contract: contractSet ? { set: true } : { set: false, error: setMiss, next: 'set_contract once it has started' },
      ...(state !== undefined ? { state, queued: false } : {}),
      ...(str(born.runnerId) !== undefined ? { workerId: str(born.runnerId) } : {}),
      ...(str(born.modelId) !== undefined ? { model: str(born.modelId) } : {}),
      ...(launchedModel !== undefined ? { modelName: launchedModel } : {}),
      ...(bornEffort !== undefined ? { effort: bornEffort } : {}),
      ...(effortRuns !== undefined && effortRuns !== bornEffort ? { effortRuns } : {}),
      ...(kitSource !== undefined ? { kitSource } : {}),
      ...(presetWorn !== undefined ? { preset: presetWorn } : {}),
      ...(presetNote !== undefined ? { presetNote } : {}),
      ...(branchName !== undefined ? { branchName } : {}),
      ...(mainHolderTitle !== undefined ? { mainHolderTitle } : {}),
      ...(heldReason !== undefined ? { heldReason } : {}),
      ...(args.sourcesNamed.length > 0 ? { sourcesNamed: args.sourcesNamed } : {}),
      ...(ok ? {} : { error: rpcDetail(delivered), ...(rpcNext(delivered) !== undefined ? { next: rpcNext(delivered) } : {}) }),
      ...(workflowsGrant !== undefined ? { workflowsGrant } : {}),
    }),
    receipts,
  }
}

export function coordinatorToolSet(): CoordinatorToolDef[] {
  return [
    {
      name: 'list_sessions',
      description:
        'Re-read the whole board now — the same rows the <switchboard> block already gave you at the start of this turn, refreshed. Use it after one of your verbs changed the board (a launch, stop, resume, answer) or when the operator names a session that is not on the block; do not call it just to confirm what the block already shows. Returns every session with its state and what the state means in plain words, its brief (why it runs), its latest activity and how long ago, age, project folder, model and effort, stamp branch + worktree path + commit state, whether it holds workflows-allowed, and each open question with its answerable permission ref; plus finishedForks (branches ready to merge) and counts (with-you sessions count as live). Read-only.',
      inputJSONSchema: schema({}),
      run: async (_input, ctx) => {
        try {
          const { coordinatorBoardView } = await import('./coordinatorBoard.js')
          const board = await coordinatorBoardView({
            ...(ctx.crewDir !== undefined ? { crewDir: ctx.crewDir } : {}),
            ground: resolve(ctx.workspaceRoot),
          })
          return { content: jsonResult({ ok: true, ...board }) }
        } catch (e) {
          return refusalResult(`the board could not be read — ${e instanceof Error ? e.message : String(e)}`, 'answer from the <switchboard> block you already have')
        }
      },
    },
    {
      name: 'launch_session',
      description:
        'Start a NEW full Mercury session on a task in a folder — the session gets `task` as its first message and knows nothing else: not the board, not other sessions, not their branches. Use it when the operator wants new work started; not to talk to an existing session (message_session), not to answer a permission ask (answer_permission), not to bring a stopped session back (resume_session). project defaults to this repo; a spoken folder resolves through Mercury’s folder memory. When the operator asks a session to consolidate, merge, review or continue OTHER sessions’ work, pass those sessions in `sources` (their titles, session ids or branch names) — the tool appends each one’s exact branch, worktree path and commit state to the brief so the new session can find the work; a brief that does not name them fails. On a repo another live session holds, the launch forks onto its own branch (mercury/<slug>) off main — the receipt names the fork; at the seat limit it queues and starts when a seat frees; a git-less folder holds behind the git offer (answer_permission on the board’s permission ref). Optional title (defaults from the task). THE EFFORT: the ladder is low | medium | high | xhigh | max (max IS the top tier — it exists and this road carries it end to end). When the operator names a tier, pass their word; omitted, the session starts at the convention (high) and the receipt says so. The receipt names the model AND the effort the session started at — relay both, and when it says the model runs a lower tier than asked, say so plainly; never let a downgrade pass silently. THE MODEL: leave `model` out and the session starts on the operator’s own default (else the neutral default — the most recent sign-in’s provider, its newest usable row; no family is favoured) — never name a pricier family or a tighter-usage pool yourself; a family word (anthropic, openai, zai, openrouter, gemini, …) picks that family’s newest signed-in row when the operator names a family rather than a model; when their ask implies a particular model, or the one they asked for comes back refused, put it to them as one plain question instead of choosing — a refusal names the family that IS signed in as the way out, relay that. The receipt names the model the session started on — relay that name when you report the launch. workflows:true asks for the workflows-allowed tag after a successful start — only when the operator’s own words asked for workflows. A CONTRACTED launch: pass `contract` (the agreement’s words, after the operator agreed — the coordinator offers and interviews first, never imposes) and the session is born blank, the contract is set on its record, and only then does the task reach it as its first message, so the worker’s first read finds the agreement (set_contract after a plain launch always lands AFTER the first frame). At the seat limit a contracted launch refuses instead of queueing — a queued start cannot carry a contract — and the refusal names the two moves.',
      inputJSONSchema: schema(
        {
          project: { type: 'string', description: 'Folder of the repo the session works in (absolute, ~/…, or a folder Mercury has worked in before). Default: this repo.' },
          task: { type: 'string', description: 'What the session should do — its first message; complete on its own, it sees nothing else.' },
          title: { type: 'string', description: 'Board title; defaults from the task.' },
          model: { type: 'string', description: 'Model id or spoken model name for the session — pass it only when the operator named one. Omitted, the session runs on their own default.' },
          effort: {
            type: 'string',
            description:
              'Effort tier for the session — the ladder is low | medium | high | xhigh | max, and max is the real top tier. Pass it exactly when the operator named one, in their own words ("max effort", "x high" and "extra high" resolve); an off-ladder word refuses typed and NO session starts. Omitted, the session starts at the convention (high). The receipt names the tier the session started at — relay it, and when the receipt says the model runs a lower tier than asked, tell the operator that plainly.',
          },
          workflows: { type: 'boolean', description: 'Ask for the workflows-allowed tag after launch (only when the operator asked for workflows).' },
          contract: {
            type: 'string',
            description:
              'The session’s ADVISORY contract — the agreement’s words, set on the record BEFORE the task reaches the session (born blank → contract set → first turn). Omit for a plain launch; set_contract later is only for a session that launched without one.',
          },
          preset: {
            type: 'string',
            description:
              'A SAVED KIT PRESET the session is born wearing — its MCPs, skills and extensions derive from the preset’s saved deltas instead of the boot menu’s. Pass it only when the operator named one; the saved presets are the closed roster — an unknown name refuses with the roster and NO session starts. The receipt names the preset and says when some of its deltas name members this repo lacks (they simply don’t bite).',
          },
          sources: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Sessions whose work this session must gather: titles, session ids or branch names from the board. Their branch, worktree path and commit state are appended to the task verbatim.',
          },
        },
        ['task'],
      ),
      run: async (input, ctx) => {
        const p = (input ?? {}) as {
          project?: unknown
          task?: unknown
          title?: unknown
          model?: unknown
          effort?: unknown
          workflows?: unknown
          sources?: unknown
          contract?: unknown
          preset?: unknown
        }
        let task = str(p.task)?.trim()
        if (task === undefined || task.length === 0) return refusalResult('launch_session needs a task', 'say what the session should do')
        // Sources → the brief names every branch/worktree/commit state from
        // the board (one home: the same view the turn read); an unknown
        // source refuses instead of launching a session that cannot find it.
        const sources = Array.isArray(p.sources) ? p.sources.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : []
        let sourcesNamed: Array<{ title: string; branch?: string }> = []
        if (sources.length > 0) {
          const board = await import('./coordinatorBoard.js')
          const view = await board.coordinatorBoardView({
            ...(ctx.crewDir !== undefined ? { crewDir: ctx.crewDir } : {}),
            ground: resolve(ctx.workspaceRoot),
          })
          const resolved = board.resolveBoardSources(view, sources)
          if (resolved.unknown.length > 0) {
            return refusalResult(
              `no session or branch on the board matches ${resolved.unknown.map(u => `'${u}'`).join(', ')}`,
              `name sources exactly as the board shows them (title, session id or branch) — on the board now: ${view.sessions.map(s => s.title).slice(0, 8).join(' · ') || 'nothing'}`,
            )
          }
          sourcesNamed = resolved.named.map(n => ({ title: n.title, ...(n.branch !== undefined ? { branch: n.branch } : {}) }))
          task = `${task}\n\n${board.sourcesBriefBlock(resolved.named)}`
        }
        const project = str(p.project)
        // THE GROUND LAW: no project spoken ⇒ the live harness ground
        // (ctx.workspaceRoot now IS the selected repo). A spoken folder
        // resolves through the full memory chain — absolute/~ → the ground
        // → its parent → home → every folder Mercury has worked before.
        const workspaceDir =
          project === undefined ? resolve(ctx.workspaceRoot) : await resolveSpokenProjectPath(project, ctx.workspaceRoot)
        if (workspaceDir === null) {
          const known = (await knownProjectDirs()).map(d => basename(d)).slice(0, 6)
          return refusalResult(
            `no folder matches '${project ?? ''}'`,
            `${known.length > 0 ? `folders Mercury knows: ${known.join(' · ')} — ` : ''}give the full path, like /Users/…`,
          )
        }
        try {
          if (!statSync(workspaceDir).isDirectory()) return refusalResult(`${workspaceDir} is not a folder`, 'give the folder path, not a file')
        } catch {
          return refusalResult(`no folder at ${workspaceDir}`, 'give the full path, like /Users/…')
        }
        // THE EFFORT INTAKE (the chain-of-custody law): the operator's word
        // resolves through the ONE normalizer — a plain spelling ('max
        // effort', 'x high') is its ladder tier; what cannot normalize
        // refuses TYPED, naming the ladder, before any birth or queue. A
        // session can never quietly start on a tier nobody asked for.
        const effortAsked = str(p.effort)?.trim()
        let effort: string | undefined
        if (effortAsked !== undefined && effortAsked.length > 0) {
          const { normalizeEffortLevelString, EFFORT_LEVELS } = await import('../../utils/effort.js')
          effort = normalizeEffortLevelString(effortAsked)
          if (effort === undefined) {
            return refusalResult(
              `'${effortAsked}' is not an effort level — the ladder is ${EFFORT_LEVELS.join(' | ')} (max is the top tier)`,
              'pass the tier the operator named, in any plain spelling ("max effort" and "x high" resolve); no session started',
            )
          }
        }
        // A contract on the call takes the manager's road (born blank →
        // contract set → the first turn); the plain launch below is the
        // admit-and-deliver door, byte-unchanged.
        const contract = str(p.contract)?.trim()
        if (contract !== undefined && contract.length > 0) {
          return launchUnderContract(
            {
              task,
              workspaceDir,
              contract,
              workflows: p.workflows === true,
              sourcesNamed,
              ...(str(p.title) !== undefined ? { title: str(p.title) } : {}),
              ...(str(p.model) !== undefined ? { model: str(p.model) } : {}),
              ...(effort !== undefined ? { effort } : {}),
              ...(str(p.preset) !== undefined ? { preset: str(p.preset) } : {}),
            },
            ctx,
          )
        }
        const { randomUUID } = await import('../../utils/crypto.js')
        // The durable op identity: minted per call — the daemon's
        // reservation-first ledger makes any replay of THIS id exactly-once.
        const clientMessageId = `coord-launch-${randomUUID()}`
        let reply: RpcReply
        try {
          reply = await ctx.rpc(
            {
              op: 'sessionDispatch',
              clientMessageId,
              prompt: task,
              workspaceDir,
              ...(str(p.title) !== undefined ? { title: str(p.title) } : {}),
              ...(str(p.model) !== undefined ? { model: str(p.model) } : {}),
              ...(effort !== undefined ? { effort } : {}),
              // The preset rides the dispatch to the admit:
              // the born session derives from ITS deltas; unknown refuses
              // typed before any birth or queue.
              ...(str(p.preset) !== undefined ? { kitPreset: str(p.preset) } : {}),
              by: ctx.by,
            },
            { timeoutMs: DISPATCH_TIMEOUT_MS },
          )
        } catch (e) {
          reply = { ok: false, code: 'ENOCONN', error: e instanceof Error ? e.message : String(e) }
        }
        const ok = reply.ok === true
        const state = str(reply.state)
        const sessionId = str(reply.sessionId)
        // The applied detail names what the daemon said back — a fork's
        // branch and the main holder, a queue and its reason — in the same
        // words the operator's board paints (the receipt row is what the
        // operator reads first).
        const branchName = str(reply.branchName)
        const mainHolderTitle = str(reply.mainHolderTitle)
        const heldReason = str(reply.heldReason)
        // THE LAUNCH RECEIPT NAMES THE MODEL: the daemon answers with the
        // model it actually admitted the session on — named or defaulted —
        // so the operator reads where the launch landed from the receipt
        // row itself, never from a later surprise.
        const launchedModel = str(reply.modelDisplayName) ?? str(reply.modelId)
        // The kit-source line: the daemon names where
        // the born session's kit came from — 'derived' on every coordinator
        // birth (the screen never saw it), so the receipt says what the
        // lane loads without a mystery.
        const kitSource = str(reply.kitSource)
        const presetWorn = str(reply.presetName)
        const presetNote = str(reply.presetNote)
        // THE EFFORT THE SESSION STARTED AT — the daemon's stamped word,
        // named beside the model; and when the launched model's own ladder
        // tops below it (the child steps a max ask down to its ceiling),
        // the receipt says asked-vs-runs at the moment it happens, never a
        // silent swap. resolveStampedEffortTruth keeps THIS process's env
        // pin out of a sentence about ANOTHER session.
        const launchedEffort = str(reply.effort)
        let effortClause: string | undefined
        let effortRuns: string | undefined
        if (launchedEffort !== undefined) {
          const { resolveStampedEffortTruth, isEffortLevel } = await import('../../utils/effort.js')
          const modelForTruth = str(reply.modelId)
          const truthLabel =
            modelForTruth !== undefined && isEffortLevel(launchedEffort)
              ? resolveStampedEffortTruth(modelForTruth, launchedEffort).label
              : undefined
          // A non-ladder truth label ('default' — the external
          // catalogue-cold states) claims no cap: the stamp is the record.
          const built = launchEffortClause(launchedEffort, truthLabel !== undefined && isEffortLevel(truthLabel) ? truthLabel : undefined, effort !== undefined)
          effortClause = built.clause
          effortRuns = built.runs
        }
        const appliedDetail = [
          `"${(str(p.title) ?? task.split('\n')[0] ?? task).slice(0, 80)}"`,
          // The model rides SECOND, right behind the name: the pane clips a
          // long row from the tail, and where a launch landed is the fact the
          // operator most needs back from it.
          launchedModel !== undefined ? `on ${launchedModel}` : undefined,
          effortClause,
          state !== undefined ? state : undefined,
          presetWorn !== undefined ? `wearing preset '${presetWorn}'` : kitSource !== undefined ? `kit ${kitSource}` : undefined,
          presetNote,
          branchName !== undefined ? `forked onto ${branchName}${mainHolderTitle !== undefined ? ` (main checkout held by "${mainHolderTitle}")` : ''}` : undefined,
          state === 'queued' && heldReason !== undefined ? `waits: ${heldReason}` : undefined,
          sourcesNamed.length > 0 ? `brief names ${sourcesNamed.length} source${sourcesNamed.length === 1 ? '' : 's'}: ${sourcesNamed.map(s => s.branch ?? `"${s.title}" (main checkout)`).join(', ')}` : undefined,
        ]
          .filter((s): s is string => s !== undefined)
          .join(' · ')
        // THE HELD-OPEN LAUNCH (live seat-ceiling sighting): the daemon
        // answers a held dispatch ok:false + state 'queued' + a typed
        // heldReason — the ledger row is DURABLE and the session starts when
        // the hold lifts. That is a QUEUE, never a refusal: an operator told
        // "refused" watches a session start later. The receipt says queued,
        // leads with the launch's own title (no session id exists yet, and a
        // minted op-id never leads a row), and carries the daemon's reason
        // beside the starts-when move.
        const heldOpen = !ok && state === 'queued' && str(reply.heldReason) !== undefined
        const heldTitle = (str(p.title) ?? task.split('\n')[0] ?? task).slice(0, 80)
        const receipts: CoordinatorToolReceiptV1[] = [
          {
            verb: 'session.launch',
            objectRef: sessionId ?? clientMessageId,
            outcome: ok ? 'applied' : heldOpen ? 'queued' : lostReply(reply) ? 'failed' : 'refused',
            detail: ok
              ? appliedDetail
              : heldOpen
                ? `"${heldTitle}" · ${refusalDetail(rpcDetail(reply), rpcNext(reply))}`
                : refusalDetail(rpcDetail(reply), rpcNext(reply)),
            opId: clientMessageId,
          },
        ]
        let workflowsGrant: { outcome: string; detail?: string } | undefined
        if (ok && p.workflows === true && sessionId !== undefined) {
          // The tag rides a SEPARATE door AFTER a successful launch — the
          // daemon owns the one-tag cap and refuses a second grant typed.
          const tag = await grantWorkflowsTag(sessionId, ctx)
          workflowsGrant = tag.grant
          receipts.push(tag.receipt)
        }
        return {
          content: jsonResult({
            ok,
            clientMessageId,
            ...(state !== undefined ? { state, queued: state === 'queued' } : {}),
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(str(reply.runnerId) !== undefined ? { workerId: str(reply.runnerId) } : {}),
            ...(str(reply.modelId) !== undefined ? { model: str(reply.modelId) } : {}),
            ...(launchedModel !== undefined ? { modelName: launchedModel } : {}),
            ...(launchedEffort !== undefined ? { effort: launchedEffort } : {}),
            ...(effortRuns !== undefined && effortRuns !== launchedEffort ? { effortRuns } : {}),
            ...(kitSource !== undefined ? { kitSource } : {}),
            ...(presetWorn !== undefined ? { preset: presetWorn } : {}),
            ...(presetNote !== undefined ? { presetNote } : {}),
            ...(branchName !== undefined ? { branchName } : {}),
            ...(mainHolderTitle !== undefined ? { mainHolderTitle } : {}),
            ...(heldReason !== undefined ? { heldReason } : {}),
            ...(sourcesNamed.length > 0 ? { sourcesNamed } : {}),
            ...(ok ? {} : { error: rpcDetail(reply), ...(rpcNext(reply) !== undefined ? { next: rpcNext(reply) } : {}) }),
            ...(workflowsGrant !== undefined ? { workflowsGrant } : {}),
          }),
          receipts,
        }
      },
    },
    {
      name: 'message_session',
      description:
        'Deliver text INTO an existing session’s chat — an instruction, an answer, a nudge, a redirect. Use it to steer or relay to a session that is working, idle, paused or with the operator; never to do the session’s work for it. Delivery truth: a working/idle session gets it now (state comes back); a paused session HOLDS it until resume; a session that is with the operator in their terminal holds it until they leave — say "held until you leave", never "delivered"; a stopped session refuses — resume_session first, then message. Not for starting new work (launch_session) and not for permission asks (answer_permission).',
      inputJSONSchema: schema(
        {
          sessionId: { type: 'string', description: 'The target session’s id from the board.' },
          text: { type: 'string', description: 'The message delivered into the session, complete on its own.' },
        },
        ['sessionId', 'text'],
      ),
      run: async (input, ctx) => {
        const p = (input ?? {}) as { sessionId?: unknown; text?: unknown }
        const sessionId = str(p.sessionId)
        const text = str(p.text)
        if (sessionId === undefined || text === undefined) return refusalResult('message_session needs sessionId and text', 'take the sessionId from the board')
        const { randomUUID } = await import('../../utils/crypto.js')
        const clientMessageId = `coord-msg-${randomUUID()}`
        let reply: RpcReply
        try {
          reply = await ctx.rpc(
            {
              op: 'sessionDispatch',
              clientMessageId,
              prompt: text,
              workspaceDir: '',
              targetSessionId: sessionId,
              by: ctx.by,
            },
            { timeoutMs: DISPATCH_TIMEOUT_MS },
          )
        } catch (e) {
          reply = { ok: false, code: 'ENOCONN', error: e instanceof Error ? e.message : String(e) }
        }
        const ok = reply.ok === true
        // A HELD delivery (with-you / paused target) is the daemon saying
        // "not yet, and here is when" — held, not delivered: the model must
        // never say it landed.
        const heldReason = str(reply.heldReason)
        const held = !ok && heldReason !== undefined
        return {
          content: jsonResult({
            ok,
            clientMessageId,
            ...(str(reply.state) !== undefined ? { state: str(reply.state) } : {}),
            ...(held ? { held: true, heldReason } : {}),
            ...(ok ? {} : { error: rpcDetail(reply), ...(rpcNext(reply) !== undefined ? { next: rpcNext(reply) } : {}) }),
          }),
          receipts: [
            {
              verb: 'session.redirect',
              objectRef: sessionId,
              outcome: ok ? 'applied' : lostReply(reply) ? 'failed' : 'refused',
              detail: ok ? `delivered (${str(reply.state) ?? 'working'})` : refusalDetail(rpcDetail(reply), rpcNext(reply)),
              opId: clientMessageId,
              feedEligible: true,
            },
          ],
        }
      },
    },
    {
      name: 'pause_session',
      description:
        'Close a session’s delivery valve: its in-flight turn finishes on its own, nothing is destroyed, and new deliveries hold until resume. Use it when the operator wants a session to stop taking new instructions for a while (quiet hours, a clobber risk, "hold that one"); it is reversible and never a stop. Not for ending a session (stop_session).',
      inputJSONSchema: schema(
        {
          sessionId: { type: 'string', description: 'The session’s id from the board.' },
          reason: { type: 'string', description: 'Why it is paused — shown on the board beside the pause.' },
        },
        ['sessionId'],
      ),
      run: (input, ctx) => controlVerb(input, ctx, 'pause'),
    },
    {
      name: 'resume_session',
      description:
        'Re-open a paused session’s delivery valve so held deliveries replay — and revive a session whose runner died or was stopped, in place: same session, same chat, nothing lost. Use it for "resume", "bring it back", "wake it up", or before messaging a stopped session. Not for a session that is with the operator in their terminal (nothing to resume — it is alive with them).',
      inputJSONSchema: schema({ sessionId: { type: 'string', description: 'The session’s id from the board.' } }, ['sessionId']),
      run: (input, ctx) => controlVerb(input, ctx, 'resume'),
    },
    {
      name: 'stop_session',
      description:
        'End a session’s runner outright — the hardest verb; only when the operator asked for exactly that. The row stays on the board as stopped and resume_session brings it back with its chat intact. On a session holding workflows-allowed this returns needs-your-confirmation instead of acting: ask the operator in one plain sentence, then repeat the call with operatorConfirmed:true on their yes. Not for "quiet it down" (pause_session) and never for tidying stale sessions without asking first.',
      inputJSONSchema: schema(
        {
          sessionId: { type: 'string', description: 'The session’s id from the board.' },
          reason: { type: 'string', description: 'Why it is stopped — shown on the receipt.' },
          operatorConfirmed: {
            type: 'boolean',
            description: 'True only after the operator answered yes to this exact stop.',
          },
        },
        ['sessionId'],
      ),
      run: async (input, ctx) => {
        const p = (input ?? {}) as { sessionId?: unknown; reason?: unknown; operatorConfirmed?: unknown }
        const sessionId = str(p.sessionId)
        if (sessionId === undefined) return refusalResult('stop_session needs sessionId', 'take the sessionId from the board')
        const rec = await liveRecordBySession(ctx, sessionId)
        if (rec === undefined) return refusalResult(`no live session ${sessionId} is on the board`, 'check the board — a finished or removed session has nothing left to stop')
        if (rec.workflowsAllowed === true && p.operatorConfirmed !== true) {
          // Q3: the two-step — a typed result, no action, no daemon call.
          const ask: CoordinatorNeedsConfirmationV1 = {
            ok: false,
            needsConfirmation: true,
            tool: 'stop_session',
            sessionId,
            why: 'this session holds workflows allowed — stopping it may end live workflows',
            next: 'ask the operator in one plain sentence; on their yes, call stop_session again with operatorConfirmed: true',
          }
          return {
            content: jsonResult(ask),
            receipts: [
              {
                verb: 'session.stop',
                objectRef: sessionId,
                outcome: 'noop',
                detail: 'needs your confirmation — this session holds workflows allowed',
              },
            ],
          }
        }
        let reply: RpcReply
        try {
          // Operator fix 4: the coordinator's stop is the SAME
          // stop the operator's x performs — the runner ends, the row STAYS
          // on the board (◇ STOPPED, resumable); removal is a separate,
          // explicit ask. The old concourseRelease here settled the record
          // outright, which read as sessions "not persisting".
          reply = await ctx.rpc(
            { op: 'sessionControl', action: 'stop', sessionId, by: ctx.by },
            { timeoutMs: CONTROL_TIMEOUT_MS },
          )
        } catch (e) {
          reply = { ok: false, code: 'ENOCONN', error: e instanceof Error ? e.message : String(e) }
        }
        const ok = reply.ok === true && (str(reply.outcome) === 'applied' || str(reply.outcome) === 'noop')
        const detail = ok
          ? `stopped — the row stays on the board; resume brings it back${str(p.reason) !== undefined ? ` — ${str(p.reason)}` : ''}`
          : refusalDetail(rpcDetail(reply), rpcNext(reply))
        return {
          content: jsonResult({
            ok,
            sessionId,
            ...(ok ? { stopped: true, rowStays: true } : { error: rpcDetail(reply), ...(rpcNext(reply) !== undefined ? { next: rpcNext(reply) } : {}) }),
          }),
          receipts: [
            {
              verb: 'session.stop',
              objectRef: sessionId,
              outcome: ok ? 'applied' : lostReply(reply) ? 'failed' : 'refused',
              ...(detail !== undefined ? { detail } : {}),
            },
          ],
        }
      },
    },
    {
      name: 'grant_workflows',
      description:
        'Grant the ONE standing workflows-allowed tag to a background session, so it may launch workflows and delegate while backgrounded — only when the operator’s own words asked for workflows on that session; merely visiting or mentioning it never grants. The daemon refuses a second grant while one stands: relay that plainly, naming the holder (the board row carries workflowsAllowed). Not needed for a session the operator is inside — a session with them keeps its own doctrine.',
      inputJSONSchema: schema({ sessionId: { type: 'string', description: 'The session’s id from the board.' } }, ['sessionId']),
      run: (input, ctx) => workflowsVerb(input, ctx, 'grant-workflows'),
    },
    {
      name: 'revoke_workflows',
      description:
        'Take the workflows-allowed tag back from its holder: new workflow launches stop; anything already running is untouched (ending live workflows is a different, operator-asked act that goes through stop_session). Use it when the operator wants the tag moved or withdrawn.',
      inputJSONSchema: schema({ sessionId: { type: 'string', description: 'The holder’s session id from the board.' } }, ['sessionId']),
      run: (input, ctx) => workflowsVerb(input, ctx, 'revoke-workflows'),
    },
    {
      name: 'set_contract',
      description:
        'Write, amend or close a session’s ADVISORY contract — the work agreement (coordinator-tooling T2: the coordinator OFFERS and interviews in its own words first, never imposes; a few follow-up questions in chat are the drafting, this verb is only the landing). op "set" drafts (or revises a draft); "amend" changes an acknowledged agreement (history is kept and the worker re-acknowledges through its own contract tool); "close" ends it with text and history kept. The contract is advisory always — it encourages the agent and never gates anything, so never present it as a fence. Acknowledgment belongs to the WORKER alone (its restatement in its own words); there is no coordinator ack.',
      inputJSONSchema: schema(
        {
          sessionId: { type: 'string', description: 'The session’s id from the board.' },
          op: { type: 'string', enum: ['set', 'amend', 'close'], description: 'set = draft/revise · amend = change under acknowledgment · close = end it. Default set.' },
          text: { type: 'string', description: 'The agreement’s words (set/amend; close takes none).' },
        },
        ['sessionId'],
      ),
      run: async (input, ctx) => {
        const p = (input ?? {}) as { sessionId?: unknown; op?: unknown; text?: unknown }
        const sessionId = str(p.sessionId)
        const op = p.op === 'amend' || p.op === 'close' ? p.op : 'set'
        const text = str(p.text)
        if (sessionId === undefined) return refusalResult('set_contract needs sessionId', 'take the sessionId from the board')
        if (op !== 'close' && (text === undefined || text.trim().length === 0))
          return refusalResult(`set_contract op ${op} needs text`, 'the agreement’s words ride text')
        let reply: RpcReply
        try {
          reply = await ctx.rpc(
            { op: 'sessionControl', action: 'contract', sessionId, by: ctx.by, contract: { op, ...(text !== undefined ? { text } : {}) } },
            { timeoutMs: CONTROL_TIMEOUT_MS },
          )
        } catch (e) {
          reply = { ok: false, code: 'ENOCONN', error: e instanceof Error ? e.message : String(e) }
        }
        const outcome = rpcOutcome(reply)
        const detail = outcome === 'refused' || outcome === 'failed' ? refusalDetail(rpcDetail(reply), rpcNext(reply)) : rpcDetail(reply)
        return {
          content: jsonResult({
            ok: reply.ok === true,
            sessionId,
            op,
            ...(reply.ok === true ? { detail: rpcDetail(reply) } : { error: rpcDetail(reply) }),
          }),
          receipts: [
            {
              verb: `contract.${op}`,
              objectRef: sessionId,
              outcome,
              ...(detail !== undefined ? { detail } : {}),
            },
          ],
        }
      },
    },
    {
      name: 'answer_permission',
      description:
        'Answer a parked PERMISSION ask with the operator’s verdict — the git offer for a folder without a repository, or a background session’s parked permission request. Use it exactly when the board shows an open question whose ref starts with permission: (the row’s permissionRef / openObligations[].ref) and the operator has said yes or no; the operator’s yes to the git offer means THIS verb, never a relaunch and never a message quizzing a session about git. requestId is the ref without the permission: prefix; sessionId is the question’s sessionId (a folder ask carries a folder:… id). allow:true lets the parked action proceed (for the git offer: git init runs and every launch held on that folder starts on its own — the receipt names what starts); allow:false refuses it plainly. A plain board notice with no live ask behind it is dismissed instead, and the receipt says so.',
      inputJSONSchema: schema(
        {
          sessionId: { type: 'string', description: 'The question’s sessionId from the board (or its folder:… id).' },
          requestId: { type: 'string', description: 'The parked ask being answered — the permission:<requestId> ref without its prefix.' },
          allow: { type: 'boolean', description: 'true = the operator said yes; false = the operator said no.' },
        },
        ['sessionId', 'requestId', 'allow'],
      ),
      run: async (input, ctx) => {
        const p = (input ?? {}) as { sessionId?: unknown; requestId?: unknown; allow?: unknown }
        const sessionId = str(p.sessionId)
        const rawRequestId = str(p.requestId)
        // The board's ref is `permission:<requestId>`; a model that passes
        // the whole ref meant the same ask.
        const requestId = rawRequestId !== undefined && rawRequestId.startsWith('permission:') ? rawRequestId.slice('permission:'.length) : rawRequestId
        if (sessionId === undefined || requestId === undefined || requestId.length === 0 || typeof p.allow !== 'boolean')
          return refusalResult('answer_permission needs sessionId, requestId and allow', 'take the sessionId and the permission:<requestId> ref from the board’s open questions')
        let reply: RpcReply
        try {
          reply = await ctx.rpc(
            { op: 'sessionControl', action: 'answer-permission', sessionId, requestId, allow: p.allow, by: ctx.by },
            { timeoutMs: CONTROL_TIMEOUT_MS },
          )
        } catch (e) {
          reply = { ok: false, code: 'ENOCONN', error: e instanceof Error ? e.message : String(e) }
        }
        if (reply.ok !== true && !lostReply(reply)) {
          // Operator finding 3: the verb must never REPORT
          // success on rows that are not permission asks while the rows
          // survive — a false "Cleared". A refused answer falls back
          // to the obligations owner: a plain board notice (a refused-
          // launch row, a dead session's leftover) dismisses honestly;
          // anything else refuses honestly.
          try {
            const o = await import('../crew/obligations.js')
            const row = await o.obligationOf(requestId, { scope: 'switchboard' })
            if (row !== null && row !== undefined && row.status === 'open') {
              const res = await o.resolveObligation(requestId, { kind: 'withdrawn', by: ctx.by, scope: 'switchboard' })
              if (res.settled) {
                return {
                  content: jsonResult({ ok: true, requestId, dismissed: true }),
                  receipts: [
                    {
                      verb: 'permission.answer',
                      objectRef: requestId,
                      outcome: 'applied',
                      detail: 'dismissed the notice (no live ask behind it)',
                      feedEligible: true,
                    },
                  ],
                }
              }
            }
          } catch {
            /* fall through to the honest refusal below */
          }
        }
        return {
          content: jsonResult({
            ok: reply.ok === true,
            requestId,
            allowed: p.allow,
            ...(reply.ok === true ? {} : { error: rpcDetail(reply), ...(rpcNext(reply) !== undefined ? { next: rpcNext(reply) } : {}) }),
          }),
          receipts: [
            {
              verb: 'permission.answer',
              objectRef: requestId,
              outcome: rpcOutcome(reply),
              detail:
                reply.ok === true
                  ? (rpcDetail(reply) ?? (p.allow ? 'allowed' : 'refused the ask'))
                  : refusalDetail(rpcDetail(reply), rpcNext(reply)),
              opId: requestId,
            },
          ],
        }
      },
    },
    {
      name: 'read_file',
      description:
        'Read a file inside the repo the coordinator sits on, to answer the operator’s questions about it (read-only; paths outside the workspace root are refused). offset/limit select lines; large files truncate. Not for looking inside a session’s work — sessions think for themselves; the board block already carries what each is doing.',
      inputJSONSchema: schema(
        {
          path: { type: 'string' },
          offset: { type: 'number', description: '1-based first line (default 1).' },
          limit: { type: 'number', description: 'Max lines (default 400, cap 2000).' },
        },
        ['path'],
      ),
      run: async (input, ctx) => {
        const p = (input ?? {}) as { path?: unknown; offset?: unknown; limit?: unknown }
        const rel = str(p.path)
        if (rel === undefined) return refusalResult('read_file needs a path')
        const abs = resolveReadSandboxPath(ctx.workspaceRoot, rel)
        if (abs === null) return refusalResult(`the path escapes the workspace root — reads are limited to ${resolve(ctx.workspaceRoot)}`)
        try {
          if (!statSync(abs).isFile()) return refusalResult(`${rel} is not a file`)
          const raw = readFileSync(abs, 'utf8')
          const lines = raw.split('\n')
          const offset = Math.max(1, typeof p.offset === 'number' && Number.isFinite(p.offset) ? Math.floor(p.offset) : 1)
          const limit = Math.min(2000, Math.max(1, typeof p.limit === 'number' && Number.isFinite(p.limit) ? Math.floor(p.limit) : 400))
          const slice = lines.slice(offset - 1, offset - 1 + limit).map(l => (l.length > 500 ? `${l.slice(0, 500)}…` : l))
          let text = slice.map((l, i) => `${offset + i}\t${l}`).join('\n')
          let clipped = false
          if (text.length > 49_152) {
            text = text.slice(0, 49_152)
            clipped = true
          }
          return {
            content: jsonResult({
              ok: true,
              path: rel,
              totalLines: lines.length,
              from: offset,
              to: Math.min(lines.length, offset - 1 + limit),
              truncated: clipped || lines.length > offset - 1 + limit,
              text,
            }),
          }
        } catch (e) {
          return refusalResult(`read failed — ${e instanceof Error ? e.message : String(e)}`)
        }
      },
    },
    {
      name: 'grep',
      description:
        'Search file contents inside the repo the coordinator sits on with ripgrep, to answer the operator’s questions about it (read-only, sandboxed to the workspace root). Use it before claiming anything about the repository you have not read; not for a session’s work or its transcript. pattern is a regex; optional path narrows the start folder, glob filters filenames; results cap at 200 lines.',
      inputJSONSchema: schema(
        {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Folder or file to search under (default the repo root).' },
          glob: { type: 'string', description: "Filename filter, e.g. '*.ts'." },
        },
        ['pattern'],
      ),
      run: async (input, ctx) => {
        const p = (input ?? {}) as { pattern?: unknown; path?: unknown; glob?: unknown }
        const pattern = str(p.pattern)
        if (pattern === undefined) return refusalResult('grep needs a pattern')
        const target = resolveReadSandboxPath(ctx.workspaceRoot, str(p.path) ?? '.')
        if (target === null) return refusalResult(`the path escapes the workspace root — reads are limited to ${resolve(ctx.workspaceRoot)}`)
        try {
          const { ripGrepAnswer } = await import('../../utils/ripgrep.js')
          const args = ['-n', '--no-heading', '-m', '50', ...(str(p.glob) !== undefined ? ['-g', str(p.glob) as string] : []), '-e', pattern]
          // The bounded walk carries its own completeness: a search cut off
          // at the deadline must not read as one that found this much and
          // no more (FN-015 rank 10).
          const answer = await ripGrepAnswer(args, target, AbortSignal.timeout(10_000))
          const lines = answer.lines
          const capped = lines.slice(0, 200).map(l => (l.length > 400 ? `${l.slice(0, 400)}…` : l))
          return {
            content: jsonResult({
              ok: true,
              matches: lines.length,
              truncated: lines.length > 200,
              text: capped.join('\n'),
              ...(answer.complete ? {} : { incomplete: answer.reason ?? 'the search did not finish' }),
            }),
          }
        } catch (e) {
          return refusalResult(`search failed — ${e instanceof Error ? e.message : String(e)}`)
        }
      },
    },
    {
      name: 'list_dir',
      description:
        'List a folder inside the repo the coordinator sits on (read-only, sandboxed to the workspace root). Use it to orient before read_file or grep when the operator asks about the repository’s layout; folders carry a trailing slash, entries cap at 300. Not for a session’s worktree — sessions own their work.',
      inputJSONSchema: schema({ path: { type: 'string', description: 'Default: the repo root.' } }),
      run: async (input, ctx) => {
        const p = (input ?? {}) as { path?: unknown }
        const abs = resolveReadSandboxPath(ctx.workspaceRoot, str(p.path) ?? '.')
        if (abs === null) return refusalResult(`the path escapes the workspace root — reads are limited to ${resolve(ctx.workspaceRoot)}`)
        try {
          const entries = readdirSync(abs, { withFileTypes: true })
            .map(d => (d.isDirectory() ? `${d.name}/` : d.name))
            .sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b))
          return {
            content: jsonResult({ ok: true, path: str(p.path) ?? '.', truncated: entries.length > 300, entries: entries.slice(0, 300) }),
          }
        } catch (e) {
          return refusalResult(`list failed — ${e instanceof Error ? e.message : String(e)}`)
        }
      },
    },
  ]
}

// ── shared verb bodies ──────────────────────────────────────────────────────

async function controlVerb(
  input: unknown,
  ctx: CoordinatorToolContext,
  action: 'pause' | 'resume',
): Promise<CoordinatorToolResult> {
  const p = (input ?? {}) as { sessionId?: unknown; reason?: unknown }
  const sessionId = str(p.sessionId)
  if (sessionId === undefined) return refusalResult(`${action}_session needs sessionId`, 'take the sessionId from the board')
  const { randomUUID } = await import('../../utils/crypto.js')
  const clientOpId = `coord-ctl-${randomUUID()}`
  let reply: RpcReply
  try {
    reply = await ctx.rpc(
      {
        op: 'sessionControl',
        action,
        sessionId,
        by: ctx.by,
        ...(action === 'pause' ? { reason: str(p.reason) ?? 'coordinator pause' } : {}),
        clientOpId,
      },
      { timeoutMs: CONTROL_TIMEOUT_MS },
    )
  } catch (e) {
    reply = { ok: false, code: 'ENOCONN', error: e instanceof Error ? e.message : String(e) }
  }
  const outcome = rpcOutcome(reply)
  const detail = outcome === 'refused' || outcome === 'failed' ? refusalDetail(rpcDetail(reply), rpcNext(reply)) : rpcDetail(reply)
  return {
    content: jsonResult({
      ok: reply.ok === true,
      sessionId,
      ...(str(reply.outcome) !== undefined ? { outcome: str(reply.outcome) } : {}),
      ...(reply.ok === true ? {} : { error: rpcDetail(reply), ...(rpcNext(reply) !== undefined ? { next: rpcNext(reply) } : {}) }),
    }),
    receipts: [
      {
        verb: action === 'pause' ? 'session.pause' : 'session.resume',
        objectRef: sessionId,
        outcome,
        ...(detail !== undefined ? { detail } : {}),
        opId: clientOpId,
        feedEligible: true,
      },
    ],
  }
}

async function workflowsVerb(
  input: unknown,
  ctx: CoordinatorToolContext,
  action: 'grant-workflows' | 'revoke-workflows',
): Promise<CoordinatorToolResult> {
  const p = (input ?? {}) as { sessionId?: unknown }
  const sessionId = str(p.sessionId)
  if (sessionId === undefined) return refusalResult(`${action === 'grant-workflows' ? 'grant' : 'revoke'}_workflows needs sessionId`, 'take the sessionId from the board')
  let reply: RpcReply
  try {
    reply = await ctx.rpc({ op: 'sessionControl', action, sessionId, by: ctx.by }, { timeoutMs: CONTROL_TIMEOUT_MS })
  } catch (e) {
    reply = { ok: false, code: 'ENOCONN', error: e instanceof Error ? e.message : String(e) }
  }
  const outcome = rpcOutcome(reply)
  const detail = outcome === 'refused' || outcome === 'failed' ? refusalDetail(rpcDetail(reply), rpcNext(reply)) : rpcDetail(reply)
  return {
    content: jsonResult({
      ok: reply.ok === true,
      sessionId,
      ...(reply.ok === true ? {} : { error: rpcDetail(reply), ...(rpcNext(reply) !== undefined ? { next: rpcNext(reply) } : {}) }),
    }),
    receipts: [
      {
        verb: action === 'grant-workflows' ? 'workflows.grant' : 'workflows.revoke',
        objectRef: sessionId,
        outcome,
        ...(detail !== undefined ? { detail } : {}),
      },
    ],
  }
}

// ── API declarations (the provider boundary) ────────────────────────────────

/** The Tool-shaped projection the provider machinery serializes
 *  (toolToAPISchema reads exactly name · prompt() · inputJSONSchema): the
 *  coordinator's tools are in-process and permission-free by construction —
 *  the sandbox and the two-step live in run(), not in a permission layer.
 *
 *  inputSchema is the PERMISSIVE zod object (the MCPTool convention for
 *  tools whose real validation lives past the transport): the engine
 *  dialects' toolCallGate judges every settled call through it, and each
 *  run() owns its own argument refusals. Without it the gate's safeParse
 *  read throws and EVERY switchboard verb on a non-Anthropic coordinator
 *  settles as a malformed-call refusal — the cross-family chair could
 *  read its board but never act on it. */
const permissiveToolInput = z.looseObject({})
export function toolApiDeclarations(defs: readonly CoordinatorToolDef[]): Array<{
  name: string
  inputJSONSchema: Record<string, unknown>
  inputSchema: typeof permissiveToolInput
  prompt: () => Promise<string>
}> {
  return defs.map(d => ({
    name: d.name,
    inputJSONSchema: d.inputJSONSchema,
    inputSchema: permissiveToolInput,
    prompt: async () => d.description,
  }))
}
