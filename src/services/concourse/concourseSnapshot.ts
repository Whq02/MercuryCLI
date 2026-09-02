// ============================================================================
//  services/concourse/concourseSnapshot — the LIVE
//  ConcourseSnapshotV1 builder over the REAL owners (one atomic
//  object per paint; bounded reads — the worker records file, the
//  obligations store, the governor's own held-permit truth — never a daemon
//  RPC, never a transcript walk, never a provider call).
//
//  HONESTY RULES (every cell owner-derived or '—'):
//  · session state: pid-alive worker → 'working'; a record without a live
//    pid but unsettled → 'starting'; settled → 'completed'. A session whose
//    OPEN obligation names it → 'needs-you' (the durable owner outranks the
//    liveness approximation). Richer per-turn truth (working vs
//    ready-to-review) joins when the worker delta channel lands.
//  · seats: cross-process seat truth does not exist yet — rows
//    paint the honest '—' (null), never a fabricated count; the
//    denominator still composes from live×2 (the ceiling law is code).
//  · scope: 'clear' iff no other LIVE record shares the workspace without
//    an isolating mode — computed from the records' own isolation fields.
//  · the DRAFT is durable: one bounded store, lifecycle-registered.
// ============================================================================

import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { defineStore } from '../../substrate/fileStore.js'
import { workerTranscriptPath } from './workerTranscript.js'
import { recordToEntry } from '../../fabric/entryCodec.js'
import { retiredNowLabel } from '../../daemon/idleRetirement.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { getGraphemeSegmenter } from '../../utils/intl.js'
import { getCwd } from '../../utils/cwd.js'
import { isEffortLevel } from '../../utils/effort.js'
import { workspaceKindOf } from '../../daemon/concourseWorktrees.js'
import { saturnSoonestFireMs } from '../../daemon/saturn.js'
import { GROUND_NOTE_MARK, stripGroundNote } from '../../daemon/isolationNote.js'
import {
  currentProject,
  inProject,
  isAuthFailureHusk,
  PARKED_CAP,
  PARKED_WEEK_MS,
  parkedSessionsOf,
  projectDisplayName,
  type ParkedSessionFact,
  type ProjectIdentity,
} from '../../utils/bootCardFacts.js'
import { getProjectDir } from '../../utils/sessionStoragePortable.js'
import type { ConcourseElsewhereV1, ConcourseRowV1, ConcourseSnapshotV1 } from '../../components/concourse/contracts.js'
import { ELSEWHERE_CAP, elsewhereLine, projectActivity } from './projectActivity.js'
import { sessionTitleOf } from './sessionNaming.js'
import { isCrossProjectFinishedRef } from './crossProjectPings.js'
import { keyHintLabel } from '../../components/mercury-ui/keyHintLabel.js'
import type { ConcourseWorkerRecordV1 } from '../../daemon/concourseSupervisor.js'
import type { DaemonSessionRecordV1 } from '../engine-connector/daemonConnector.js'

/** R7 C-LOW-3: THE session-state derivation — board rows, the peek header
 *  and the coordinator's board input all read this one truth (three
 *  divergent copies once let a single atomic snapshot say ready-to-review
 *  on the board and 'working' in the peek for the same session).
 *  Derivation order (adjudicated): an EXPLICIT pause outranks the
 * obligation projection (lists needs-you→paused as a lawful move),
 * then the durable obligation outranks the liveness approximation.
 * a live worker whose last turn SETTLED at/after its last delivery
 *  is ready-to-review, never a fabricated 'working'. */
export function concourseRecordState(
  rec: Pick<ConcourseWorkerRecordV1, 'pausedAt' | 'lastDeliveryAt' | 'lastTurnSettledAt' | 'attachedAt' | 'stoppedAt' | 'crash' | 'parkedAt' | 'bornBlankAt' | 'pid'>,
  liveness: { needsYou: boolean; alive: boolean },
): ConcourseRowV1['state'] {
  const turnSettled =
    rec.lastTurnSettledAt !== undefined &&
    (rec.lastDeliveryAt === undefined || rec.lastTurnSettledAt >= rec.lastDeliveryAt)
  // A session born BLANK (the one door's New Session) that has never been
  // handed a word is READY, not working: before the one door every birth
  // carried a prompt, so "alive and unsettled" always meant a turn in
  // flight — a wordless newborn has no turn, and its own chat says ready
  // (L16 stage 1). The board, the mirror and the chat read ONE fact.
  const wordlessNewborn = rec.bornBlankAt !== undefined && rec.lastDeliveryAt === undefined
  // attachedAt outranks everything — the operator's own
  // terminal owns the session. PARKED (the control-plane model) ranks next:
  // the operator CLOSED the chat, so whatever its pid, crash fact or turn
  // stamps say, the row is parked — never live, never NEEDS YOU (the park
  // verb clears the operator's other stamps; the reconcile never re-states
  // it). Drive-12 (the PAUSED-honesty law): the
  // enter valve (attachRequestedAt) is deliberately NOT read here — a
  // session finishing its thought while the operator watches it is
  // WORKING; only pausedAt (an operator/coordinator pause) paints paused.
  // The CRASH fact (session-end visibility law) sits under the operator's
  // own states (attached/parked/stopped/paused — each clears or outranks
  // it) and over the liveness guess: a crashed session paints NEEDS YOU
  // with its reason whether its runner respawned or died for good — never
  // ready-to-review off a settled-stamp the crash itself wrote, and never
  // 'starting' forever off a dead pid.
  // The last fork (TASK-017 supplement, S1): 'starting' is the state of a
  // record whose pid is NOT YET recorded (a spawn in flight). A RECORDED
  // pid that no longer answers is a process that died without settling —
  // on win32 a TerminateProcess'd worker fires no exit event, so no crash
  // fact is ever stamped and no daemon may exist to reconcile one (the
  // /halt stand-down); the client derives the death itself instead of
  // painting 'starting' forever with a climbing age.
  return rec.attachedAt !== undefined
    ? 'attached'
    : rec.parkedAt !== undefined
      ? 'parked'
      : rec.stoppedAt !== undefined
        ? 'stopped'
        : rec.pausedAt !== undefined
          ? 'paused'
          : rec.crash !== undefined
            ? 'needs-you'
            : liveness.needsYou
              ? 'needs-you'
              : liveness.alive
                ? turnSettled || wordlessNewborn
                  ? 'ready-to-review'
                  : 'working'
                : rec.pid !== undefined
                  ? 'needs-you'
                  : 'starting'
}

/** A transcript line projected to the in-memory `{type, message}` entry
 *  shape — MercuryRecord envelopes (the written format) project through
 *  the fabric's ONE codec, exactly as the mirror's fold does; a line
 *  outside the record format reads as nothing (the records carry
 *  `actor.role`/`payload.kind`, never a top-level `type`). */
function entryShapeOf(entry: unknown): { type?: unknown; message?: { content?: unknown }; timestamp?: unknown } | null {
  if (!entry || typeof entry !== 'object') return null
  const env = entry as { schemaVersion?: unknown; payload?: unknown }
  if (typeof env.schemaVersion === 'number' && env.payload && typeof env.payload === 'object') {
    try {
      return recordToEntry(entry as never) as { type?: unknown; message?: { content?: unknown }; timestamp?: unknown }
    } catch {
      return null
    }
  }
  return null
}

/** Bounded byte window of a worker transcript: the FIRST `span` bytes or
 *  the LAST `span` bytes, split into lines. null when the file is absent or
 *  empty (the worker may not have written yet — honest, not an error). */
function transcriptWindowLines(rec: { sessionId: string; workspaceId: string }, span: number, from: 'head' | 'tail'): string[] | null {
  const path = workerTranscriptPath(rec)
  if (!existsSync(path)) return null
  const size = statSync(path).size
  if (size === 0) return null
  const take = Math.min(size, span)
  const buf = Buffer.alloc(take)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, take, from === 'head' ? 0 : size - take)
  } finally {
    closeSync(fd)
  }
  return buf.toString('utf8').split('\n')
}

const timestampMsOf = (raw: unknown): number | undefined => {
  if (typeof raw !== 'string') return undefined
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : undefined
}

/** : the NOW cell's truth — the session's latest
 *  activity read from ITS OWN transcript tail (last assistant text head or
 *  tool call), never a fabricated story. Bounded: one ≤8KB tail read per
 *  live row per snapshot rebuild. Fail-soft null everywhere. `at` is the
 *  record's own timestamp when it carries one — the coordinator says how
 *  long ago a session last spoke instead of guessing whether it is done. */
export function tailActivity(rec: { sessionId: string; workspaceId: string }): { label: string; kind: 'tool' | 'text'; at?: number } | null {
  try {
    const lines = transcriptWindowLines(rec, 8192, 'tail')
    if (lines === null) return null
    for (let i = lines.length - 1; i >= 0; i--) {
      const raw = lines[i]
      if (raw === undefined || raw.length < 8) continue
      let entry: unknown
      try {
        entry = JSON.parse(raw)
      } catch {
        continue // the torn tail / a partial first line of the window
      }
      const e = entryShapeOf(entry)
      if (e === null || e.type !== 'assistant') continue
      const content = e.message?.content
      if (!Array.isArray(content)) continue
      const at = timestampMsOf(e.timestamp)
      for (let j = content.length - 1; j >= 0; j--) {
        const b = content[j] as { type?: unknown; name?: unknown; text?: unknown; input?: unknown }
        if (b.type === 'tool_use' && typeof b.name === 'string') {
          const input = (b.input ?? {}) as Record<string, unknown>
          const hint =
            typeof input.description === 'string'
              ? input.description
              : typeof input.file_path === 'string'
                ? basename(input.file_path)
                : typeof input.command === 'string'
                  ? input.command
                  : typeof input.pattern === 'string'
                    ? input.pattern
                    : ''
          return { label: sanitizeLabel(`${b.name}${hint.length > 0 ? ` · ${hint}` : ''}`.slice(0, 56)), kind: 'tool', ...(at !== undefined ? { at } : {}) }
        }
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
          return { label: sanitizeLabel(b.text.trim().replace(/\s+/g, ' ').slice(0, 56)), kind: 'text', ...(at !== undefined ? { at } : {}) }
        }
      }
    }
    return null
  } catch {
    return null
  }
}

export function tailActivityLabel(rec: { sessionId: string; workspaceId: string }): string | null {
  return tailActivity(rec)?.label ?? null
}

/** WHY a session runs: the head of its FIRST operator message (its brief),
 *  read from the transcript's own first bytes — the record ledgers keep
 *  digests, so the transcript is the one place the task text lives.
 *  Bounded: one ≤8KB head read; sanitized; null when unwritten. */
export function headBriefLabel(rec: { sessionId: string; workspaceId: string }, maxChars = 200): string | null {
  try {
    const lines = transcriptWindowLines(rec, 8192, 'head')
    if (lines === null) return null
    for (const raw of lines) {
      if (raw.length < 8) continue
      let entry: unknown
      try {
        entry = JSON.parse(raw)
      } catch {
        continue
      }
      const e = entryShapeOf(entry)
      if (e === null || e.type !== 'user') continue
      const content = e.message?.content
      // BOARD CONTROLS item 6: a dispatched prompt OPENS with the ground
      // note — framing, never the operator's words. The brief (and the
      // stage-2 title riding it) derives from the words alone.
      const text =
        typeof content === 'string'
          ? stripGroundNote(content)
          : Array.isArray(content)
            ? content
                .filter((b): b is { type: 'text'; text: string } => !!b && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
                .filter(b => !b.text.startsWith(GROUND_NOTE_MARK))
                .map(b => b.text)
                .join(' ')
            : ''
      const flat = text.replace(/\s+/g, ' ').trim()
      if (flat.length === 0) continue
      return sanitizeLabel(flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat)
    }
    return null
  } catch {
    return null
  }
}

// ── the durable new-session draft (the adjudication landed it
//    with its owner — the composer strip) ────────────────────────────────────

/** The structured seed OVERRIDES: the
 *  operator's editable new-session choices, durable beside the prompt text.
 *  Every field maps to a REAL dispatch input (workspaceDir / model /
 *   *  (agent identity, governor seat ceiling) is a FACT chip, not an override. */
export interface ConcourseSeedOverridesV1 {
  projectDir?: string
  /** THE CHIP IS BOOT-SCOPED (cross-project awareness, the seed-chip
   *  follow-up): the clock at which THIS projectDir was written. Both
   *  ground doors write the chip and move the cwd together, so within a
   *  boot the chip echoes the live ground; a chip an earlier boot left in
   *  the file was never applied by this process and must not outrank the
   *  folder the terminal opened in — the reader door drops a chip stamped
   *  before this process started (a stampless chip is a pre-law write:
   *  dropped the same way). Written beside projectDir, cleared with it. */
  projectDirAt?: number
  modelKey?: string
  /** Operator: the per-session effort pick (validated
   *  EffortLevel). Absent ⇒ the daemon-worker convention ('high'). */
  effort?: string
  isolation?: 'isolated-worktree' | 'exclusive' | 'shared-read-only'
  /** The advanced editor's session title (rides the dispatch op's title). */
  title?: string
  /** the worker's OWNER handle — a real dispatch input painted back
   *  as the board's OWNER column ('Mercury', '@test', …). */
  agentName?: string
  /** the per-session background-seat ceiling (rides the op). */
  seatsMax?: 1 | 2
}

interface ConcourseDraftFileV1 {
  draft: string
  /** the durable grapheme-boundary CURSOR into the draft — routing,
   *  resize and restart restore the exact edit point, not just the text. */
  draftCaret?: number
  updatedAtMs: number
  seedOverrides?: ConcourseSeedOverridesV1
  /** R4: per-ATTACHED-SESSION composer drafts, keyed by sessionId —
   *  isolated across sessions/projects and durable across routing, resize
   *  and restart (the same law the new-session draft already obeys).
   *  Bounded: the newest SESSION_DRAFT_CAP entries survive a write. */
  sessionDrafts?: Record<string, string>
  /** Phase-2 surface parity (CU-05+AR-11, the ONE-store decision): the
   *  per-session draft CARETS beside their texts — the text-only shape
   *  silently reset the edit point on every rehydration. Same key space as
   *  sessionDrafts; a caret without a text is dropped at decode. */
  sessionDraftCarets?: Record<string, number>
  /** Advisor item 8: the HELD/transport-lost submit identity survives a UI
   *  restart — rehydrating lets ↵ replay the SAME clientMessageId into the
   *  daemon's replay door instead of stranding the queued reservation.
   *  envelopeKey binds the identity to the exact draft + seed envelope it
   *  was minted for (an edit mints fresh). */
  heldDispatch?: {
    clientMessageId: string
    envelopeKey: string
    /** The held launch's CONTENT lives caller-side (the
     *  daemon ledger keeps digests only — the digest law) so the admission
     *  pump can replay 'it starts when one frees' into a TRUE sentence. */
    prompt?: string
    /** The exact op inputs the mint sent (minus id/prompt) — the pump
     *  replays these verbatim so the replay is never a material edit. */
    op?: Record<string, unknown>
  }
  /** The attached-session twin: per-session held DELIVERY identities
   *  (paused-target holds / transport loss), keyed by sessionId beside
   *  sessionDrafts — same restart-surviving replay law. */
  heldDeliveries?: Record<string, { clientMessageId: string; text: string }>
  /** The waiting room's stacked messages — a durable
   *  FIFO per QUEUED dispatch, delivered in order through the redirect
   *  replay door on admission (pre-minted ids ⇒ exactly-once). */
  queuedStacks?: Record<string, Array<{ clientMessageId: string; text: string; mintedAtMs: number }>>
  /** Fix 2: the hand-back's durable
   *  retry — a detach/valve-reopen that could not reach the daemon survives
   *  here and the board pump completes it, even across an app restart. */
  pendingHandback?: { kind: 'detach' | 'valve-resume' | 'grant-workflows'; sessionId: string; mintedAtMs: number }
  /** CU-05: the COORDINATOR composer's durable draft (the one concourse
   *  composer that had none — natively proven lost on esc→reopen). Rides
   *  the same store + caret grammar as the new-session draft above. */
  coordinatorDraft?: string
  coordinatorDraftCaret?: number
  /** THE CLEARED MARK (the concourse-as-resume rule, 3): the double-x on a
   *  PARKED row clears it from the board exactly as a release leaves a
   *  live row — the transcript survives, the board remembers. Keyed by
   *  sessionId → the clearing's clock; a chat that runs again (a live
   *  record) paints live regardless, and a release marks the same way so a
   *  removed row never bounces back as parked. Bounded: the newest
   *  PARKED_CLEARED_CAP marks survive a write. A view preference, never
   *  session truth (Law 9): the boot menu and /resume still offer the chat. */
  parkedCleared?: Record<string, number>
}

const PARKED_CLEARED_CAP = 256

const decodeParkedCleared = (raw: unknown): Record<string, number> | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const entries = Object.entries(raw as Record<string, unknown>)
    .filter((e): e is [string, number] => e[0].length > 0 && e[0].length <= 128 && typeof e[1] === 'number' && Number.isFinite(e[1]))
    .sort((a, b) => a[1] - b[1])
    .slice(-PARKED_CLEARED_CAP)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/** the agent-name budget is 24 GRAPHEMES — the same budget the
 *  composer enforces at type time. A UTF-16 `.slice(0, 24)` disagrees with
 *  the type-time clamp on any multi-unit cluster and can split a surrogate
 *  pair, corrupting a legal name on read. Exported so the composer's
 *  pending-write ledger can mirror the exact store echo. */
export function clampAgentNameGraphemes(raw: string): string {
  let end = 0
  let n = 0
  for (const seg of getGraphemeSegmenter().segment(raw)) {
    if (n === 24) break
    end = seg.index + seg.segment.length
    n += 1
  }
  return raw.slice(0, end)
}

const decodeOverrides = (raw: unknown): ConcourseSeedOverridesV1 | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Partial<ConcourseSeedOverridesV1>
  const out: ConcourseSeedOverridesV1 = {}
  if (typeof r.projectDir === 'string' && r.projectDir.length > 0) {
    // The composer's Project chip accepts '~/x' spoken paths too.
    const p = r.projectDir.slice(0, 1024)
    out.projectDir = p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
    if (typeof r.projectDirAt === 'number' && Number.isFinite(r.projectDirAt)) out.projectDirAt = r.projectDirAt
  }
  if (typeof r.modelKey === 'string' && r.modelKey.length > 0) out.modelKey = r.modelKey.slice(0, 128)
  if (typeof r.effort === 'string' && isEffortLevel(r.effort)) out.effort = r.effort
  if (typeof r.title === 'string' && r.title.length > 0) out.title = r.title.slice(0, 200)
  if (r.isolation === 'isolated-worktree' || r.isolation === 'exclusive' || r.isolation === 'shared-read-only')
    out.isolation = r.isolation
  if (typeof r.agentName === 'string' && r.agentName.length > 0) out.agentName = clampAgentNameGraphemes(r.agentName)
  if (r.seatsMax === 1 || r.seatsMax === 2) out.seatsMax = r.seatsMax
  return Object.keys(out).length > 0 ? out : undefined
}

const SESSION_DRAFT_CAP = 24

const decodeSessionDrafts = (raw: unknown): Record<string, string> | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0 && k.length > 0 && k.length <= 128) out[k] = v.slice(0, 4000)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

const draftStore = defineStore<ConcourseDraftFileV1, [dir?: string]>({
  name: 'concourse-draft',
  path: (dir?: string) => join(dir ?? getMercuryHome(), 'concourse-draft.json'),
  schemaVersion: 1,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as Partial<ConcourseDraftFileV1>
    const overrides = decodeOverrides(r.seedOverrides)
    const sessionDrafts = decodeSessionDrafts(r.sessionDrafts)
    const draft = typeof r.draft === 'string' ? r.draft.slice(0, 4000) : ''
    // Session-draft carets: kept only where a draft text exists, clamped
    // into that text (the same clamp the top-level draftCaret carries).
    let sessionDraftCarets: Record<string, number> | undefined
    if (sessionDrafts !== undefined && r.sessionDraftCarets && typeof r.sessionDraftCarets === 'object') {
      const out: Record<string, number> = {}
      for (const [k, v] of Object.entries(r.sessionDraftCarets as Record<string, unknown>)) {
        const text = sessionDrafts[k]
        if (text !== undefined && typeof v === 'number' && Number.isFinite(v)) {
          out[k] = Math.max(0, Math.min(text.length, Math.floor(v)))
        }
      }
      if (Object.keys(out).length > 0) sessionDraftCarets = out
    }
    const coordinatorDraft =
      typeof r.coordinatorDraft === 'string' && r.coordinatorDraft.length > 0
        ? r.coordinatorDraft.slice(0, 4000)
        : undefined
    const heldDispatch =
      r.heldDispatch &&
      typeof r.heldDispatch === 'object' &&
      typeof r.heldDispatch.clientMessageId === 'string' &&
      r.heldDispatch.clientMessageId.length > 0 &&
      typeof r.heldDispatch.envelopeKey === 'string'
        ? {
            clientMessageId: r.heldDispatch.clientMessageId.slice(0, 128),
            envelopeKey: r.heldDispatch.envelopeKey.slice(0, 8192),
            ...(typeof r.heldDispatch.prompt === 'string' && r.heldDispatch.prompt.length > 0
              ? { prompt: r.heldDispatch.prompt.slice(0, 8192) }
              : {}),
            ...(r.heldDispatch.op && typeof r.heldDispatch.op === 'object' && !Array.isArray(r.heldDispatch.op)
              ? { op: r.heldDispatch.op as Record<string, unknown> }
              : {}),
          }
        : undefined
    let queuedStacks: Record<string, Array<{ clientMessageId: string; text: string; mintedAtMs: number }>> | undefined
    if (r.queuedStacks && typeof r.queuedStacks === 'object' && !Array.isArray(r.queuedStacks)) {
      const out: Record<string, Array<{ clientMessageId: string; text: string; mintedAtMs: number }>> = {}
      for (const [k, v] of Object.entries(r.queuedStacks as Record<string, unknown>).slice(0, 8)) {
        if (k.length === 0 || k.length > 128 || !Array.isArray(v)) continue
        const list = (v as unknown[])
          .slice(0, 10)
          .map(e => e as { clientMessageId?: unknown; text?: unknown; mintedAtMs?: unknown })
          .filter(
            e =>
              typeof e?.clientMessageId === 'string' &&
              e.clientMessageId.length > 0 &&
              typeof e.text === 'string' &&
              e.text.length > 0,
          )
          .map(e => ({
            clientMessageId: (e.clientMessageId as string).slice(0, 160),
            text: (e.text as string).slice(0, 4000),
            mintedAtMs: typeof e.mintedAtMs === 'number' && Number.isFinite(e.mintedAtMs) ? e.mintedAtMs : 0,
          }))
        if (list.length > 0) out[k] = list
      }
      if (Object.keys(out).length > 0) queuedStacks = out
    }
    let heldDeliveries: Record<string, { clientMessageId: string; text: string }> | undefined
    if (r.heldDeliveries && typeof r.heldDeliveries === 'object' && !Array.isArray(r.heldDeliveries)) {
      const out: Record<string, { clientMessageId: string; text: string }> = {}
      // Decode-side cap (3-3-3 validator): the write-side trim bounds only
      // what THIS process writes — a hand-edited/foreign file must not
      // hydrate unbounded entries.
      for (const [k, v] of Object.entries(r.heldDeliveries as Record<string, unknown>).slice(0, SESSION_DRAFT_CAP)) {
        const h = v as { clientMessageId?: unknown; text?: unknown }
        if (
          k.length > 0 &&
          k.length <= 128 &&
          typeof h?.clientMessageId === 'string' &&
          h.clientMessageId.length > 0 &&
          typeof h.text === 'string'
        )
          out[k] = { clientMessageId: h.clientMessageId.slice(0, 128), text: h.text.slice(0, 4000) }
      }
      if (Object.keys(out).length > 0) heldDeliveries = out
    }
    return {
      draft,
      ...(typeof r.draftCaret === 'number' && Number.isFinite(r.draftCaret)
        ? { draftCaret: Math.max(0, Math.min(draft.length, Math.floor(r.draftCaret))) }
        : {}),
      updatedAtMs: typeof r.updatedAtMs === 'number' ? r.updatedAtMs : 0,
      ...(overrides !== undefined ? { seedOverrides: overrides } : {}),
      ...(sessionDrafts !== undefined ? { sessionDrafts } : {}),
      ...(sessionDraftCarets !== undefined ? { sessionDraftCarets } : {}),
      ...(coordinatorDraft !== undefined ? { coordinatorDraft } : {}),
      ...(coordinatorDraft !== undefined &&
      typeof r.coordinatorDraftCaret === 'number' &&
      Number.isFinite(r.coordinatorDraftCaret)
        ? { coordinatorDraftCaret: Math.max(0, Math.min(coordinatorDraft.length, Math.floor(r.coordinatorDraftCaret))) }
        : {}),
      ...(heldDispatch !== undefined ? { heldDispatch } : {}),
      ...(heldDeliveries !== undefined ? { heldDeliveries } : {}),
      ...(queuedStacks !== undefined ? { queuedStacks } : {}),
      ...(() => {
        const parkedCleared = decodeParkedCleared(r.parkedCleared)
        return parkedCleared !== undefined ? { parkedCleared } : {}
      })(),
      ...(r.pendingHandback &&
      typeof r.pendingHandback === 'object' &&
      (r.pendingHandback.kind === 'detach' ||
        r.pendingHandback.kind === 'valve-resume' ||
        r.pendingHandback.kind === 'grant-workflows') &&
      typeof r.pendingHandback.sessionId === 'string' &&
      r.pendingHandback.sessionId.length > 0
        ? {
            pendingHandback: {
              kind: r.pendingHandback.kind,
              sessionId: r.pendingHandback.sessionId.slice(0, 128),
              mintedAtMs:
                typeof r.pendingHandback.mintedAtMs === 'number' && Number.isFinite(r.pendingHandback.mintedAtMs)
                  ? r.pendingHandback.mintedAtMs
                  : 0,
            },
          }
        : {}),
    }
  },
  empty: () => ({ draft: '', updatedAtMs: 0 }),
  onReadFailure: 'empty',
})

/** The double-x's durable effect on a PARKED row (and a release's, so a
 *  removed live row never returns as parked): remember the clearing.
 *  Delete-then-set keeps a re-cleared id newest; the cap sheds the oldest. */
export async function markParkedCleared(sessionId: string, dir?: string): Promise<void> {
  await draftStore(dir).mutate(prev => {
    const map = { ...(prev.parkedCleared ?? {}) }
    delete map[sessionId]
    map[sessionId] = Date.now()
    const entries = Object.entries(map).sort((a, b) => a[1] - b[1]).slice(-PARKED_CLEARED_CAP)
    return { ...prev, updatedAtMs: Date.now(), parkedCleared: Object.fromEntries(entries) }
  })
}

/** The cleared ids (the builder's subtraction; the pins read it). */
export async function readParkedCleared(dir?: string): Promise<ReadonlySet<string>> {
  return new Set(Object.keys((await draftStore(dir).read()).parkedCleared ?? {}))
}

/** Advisor item 8: persist/clear the held submit identity (see the field's
 *  doc on ConcourseDraftFileV1). */
export async function writeConcourseHeldDispatch(
  held: { clientMessageId: string; envelopeKey: string; prompt?: string; op?: Record<string, unknown> } | null,
  dir?: string,
): Promise<void> {
  await draftStore(dir).mutate(prev => {
    const next = { ...prev, updatedAtMs: Date.now() }
    if (held === null) delete (next as { heldDispatch?: unknown }).heldDispatch
    else next.heldDispatch = held
    return next
  })
}

export async function readConcourseHeldDispatch(
  dir?: string,
): Promise<{ clientMessageId: string; envelopeKey: string; prompt?: string; op?: Record<string, unknown> } | null> {
  return (await draftStore(dir).read()).heldDispatch ?? null
}

/** The waiting room's stack — append one message (cap 10 per
 *  dispatch, 8 rooms); the minted id is DURABLE (AT-07: a retry replays the
 *  same identity through the redirect door — exactly-once by ledger). */
export async function appendConcourseQueuedStackEntry(
  dispatchId: string,
  text: string,
  dir?: string,
): Promise<{ clientMessageId: string } | null> {
  let minted: { clientMessageId: string } | null = null
  await draftStore(dir).mutate(prev => {
    const stacks = { ...(prev.queuedStacks ?? {}) }
    const list = [...(stacks[dispatchId] ?? [])]
    if (list.length >= 10) return prev
    if (stacks[dispatchId] === undefined && Object.keys(stacks).length >= 8) {
      const oldest = Object.keys(stacks)[0]
      if (oldest !== undefined) delete stacks[oldest]
    }
    const clientMessageId = `${dispatchId}-stack-${Date.now().toString(36)}-${list.length}`
    minted = { clientMessageId }
    list.push({ clientMessageId, text: text.slice(0, 4000), mintedAtMs: Date.now() })
    stacks[dispatchId] = list
    return { ...prev, queuedStacks: stacks, updatedAtMs: Date.now() }
  })
  return minted
}

export async function readConcourseQueuedStack(
  dispatchId: string,
  dir?: string,
): Promise<Array<{ clientMessageId: string; text: string }>> {
  return (await draftStore(dir).read()).queuedStacks?.[dispatchId] ?? []
}

/** Fix 2: the hand-back retry marker (single slot — one leave at a time). */
export async function writeConcoursePendingHandback(
  h: { kind: 'detach' | 'valve-resume' | 'grant-workflows'; sessionId: string; mintedAtMs: number } | null,
  dir?: string,
): Promise<void> {
  await draftStore(dir).mutate(prev => {
    const next = { ...prev, updatedAtMs: Date.now() }
    if (h === null) delete (next as { pendingHandback?: unknown }).pendingHandback
    else next.pendingHandback = h
    return next
  })
}

export async function readConcoursePendingHandback(
  dir?: string,
): Promise<{ kind: 'detach' | 'valve-resume' | 'grant-workflows'; sessionId: string; mintedAtMs: number } | null> {
  return (await draftStore(dir).read()).pendingHandback ?? null
}

/** Remove one delivered entry (positive receipt only — the caller's law). */
export async function removeConcourseQueuedStackEntry(
  dispatchId: string,
  clientMessageId: string,
  dir?: string,
): Promise<void> {
  await draftStore(dir).mutate(prev => {
    const stacks = { ...(prev.queuedStacks ?? {}) }
    const list = (stacks[dispatchId] ?? []).filter(e => e.clientMessageId !== clientMessageId)
    if (list.length === 0) delete stacks[dispatchId]
    else stacks[dispatchId] = list
    const next = { ...prev, updatedAtMs: Date.now() }
    if (Object.keys(stacks).length === 0) delete (next as { queuedStacks?: unknown }).queuedStacks
    else next.queuedStacks = stacks
    return next
  })
}

/** The attached-session twin (advisor item 8): persist/clear one held
 *  delivery identity per session (bounded by the sessionDrafts cap). */
export async function writeConcourseHeldDelivery(
  sessionId: string,
  held: { clientMessageId: string; text: string } | null,
  dir?: string,
): Promise<void> {
  await draftStore(dir).mutate(prev => {
    const map = { ...(prev.heldDeliveries ?? {}) }
    if (held === null) delete map[sessionId]
    else {
      // Delete-then-set: a re-written key must be NEWEST in insertion order
      // or the cap trim below could shed the entry it just wrote.
      delete map[sessionId]
      map[sessionId] = held
      const keys = Object.keys(map)
      if (keys.length > SESSION_DRAFT_CAP) for (const k of keys.slice(0, keys.length - SESSION_DRAFT_CAP)) delete map[k]
    }
    const next = { ...prev, updatedAtMs: Date.now() }
    if (Object.keys(map).length === 0) delete (next as { heldDeliveries?: unknown }).heldDeliveries
    else next.heldDeliveries = map
    return next
  })
}

export async function readConcourseHeldDelivery(
  sessionId: string,
  dir?: string,
): Promise<{ clientMessageId: string; text: string } | null> {
  return (await draftStore(dir).read()).heldDeliveries?.[sessionId] ?? null
}

/** The pump's sweep input: every held delivery identity at once —
 *  'it delivers on its own' is only true if something actually replays. */
export async function readConcourseHeldDeliveries(
  dir?: string,
): Promise<Record<string, { clientMessageId: string; text: string }>> {
  return (await draftStore(dir).read()).heldDeliveries ?? {}
}

export async function readConcourseDraft(dir?: string): Promise<string> {
  return (await draftStore(dir).read()).draft
}

/** This process's start — the chip's boot-scope basis (see projectDirAt). */
const PROCESS_START_MS = Date.now() - Math.floor(process.uptime() * 1000)

/** The chip through its boot scope: a projectDir stamped by THIS boot stands;
 *  one an earlier boot left behind (or a stampless pre-law write) reads as
 *  unset. Pure — the pins feed it a clock. */
export function bootScopedSeedOverrides(
  seeds: ConcourseSeedOverridesV1,
  processStartMs: number = PROCESS_START_MS,
): ConcourseSeedOverridesV1 {
  if (seeds.projectDir === undefined) return seeds
  if (seeds.projectDirAt !== undefined && seeds.projectDirAt >= processStartMs) return seeds
  const { projectDir: _stale, projectDirAt: _staleAt, ...rest } = seeds
  return rest
}

/** THE ONE READER DOOR for the seeds — every consumer (the builder, the
 *  dispatch mapping, the ground resolver) sees the chip through its boot
 *  scope, so a stale chip can never steer a launch before the route's mount
 *  clears the file. */
export async function readConcourseSeedOverrides(dir?: string): Promise<ConcourseSeedOverridesV1> {
  return bootScopedSeedOverrides((await draftStore(dir).read()).seedOverrides ?? {})
}

/** THE GROUND LAW's resolver: the selected repo
 *  (the Project chip) IS the harness ground; unset ⇒ the process's current
 *  folder. Every launch door and the coordinator read THIS live — never a
 *  frozen boot cwd, and never a chip this boot did not write (the reader
 *  door's boot scope). */
export async function resolveHarnessGround(dir?: string): Promise<string> {
  try {
    const seeds = await readConcourseSeedOverrides(dir)
    if (typeof seeds.projectDir === 'string' && seeds.projectDir.length > 0) return seeds.projectDir
  } catch {
    /* the chip is a projection — the live cwd stands */
  }
  return getCwd()
}

/** Write-through draft persistence — survives navigation/resize/restart;
 * cleared only by the caller on a positive dispatch receipt. The
 *  seed overrides survive a text clear (the operator's setup outlives one
 *  dispatched prompt). */
export async function writeConcourseDraft(draft: string, dir?: string, caret?: number): Promise<void> {
  const text = draft.slice(0, 4000)
  await draftStore(dir).mutate(prev => ({
    ...prev,
    draft: text,
    draftCaret: Math.max(0, Math.min(text.length, Math.floor(caret ?? text.length))),
    updatedAtMs: Date.now(),
  }))
}

/** Merge one seed override (null clears the field back to its default). */
export async function writeConcourseSeedOverride(
  patch: { [K in keyof ConcourseSeedOverridesV1]?: ConcourseSeedOverridesV1[K] | null },
  dir?: string,
): Promise<void> {
  await draftStore(dir).mutate(prev => {
    const next: ConcourseSeedOverridesV1 = { ...(prev.seedOverrides ?? {}) }
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined) delete next[k as keyof ConcourseSeedOverridesV1]
      else (next as Record<string, unknown>)[k] = v
    }
    // The chip's boot stamp rides every projectDir write and leaves with it.
    if ('projectDir' in patch) {
      if (next.projectDir !== undefined) next.projectDirAt = Date.now()
      else delete next.projectDirAt
    }
    // Default-equivalence normalization (operator, the bricked
    // home): cycling isolation AWAY and BACK would otherwise strand the default's
    // value as an EXPLICIT override — the store then pinned worktree
    // isolation forever, so the workspace-aware default (git → worktree,
    // plain folder → exclusive) could never apply again. An isolation write
    // that equals what the unset default resolves to IS the default: store
    // nothing. The chip paints identically either way (resolveIsolationSeed
    // is the one painter); only future-default liveness differs.
    if (
      next.isolation !== undefined &&
      next.isolation === resolveIsolationSeed({ ...next, isolation: undefined }, getCwd())
    ) {
      delete next.isolation
    }
    // Same law for effort: a write that equals the daemon-worker convention
    // IS the default — store nothing (the chip yields to the rail again).
    if (next.effort === 'high') delete next.effort
    return {
      ...prev,
      updatedAtMs: Date.now(),
      ...(Object.keys(next).length > 0 ? { seedOverrides: next } : { seedOverrides: undefined }),
    }
  })
}

export function subscribeConcourseDraft(cb: () => void, dir?: string): () => void {
  return draftStore(dir).subscribe(() => cb(), { immediate: false })
}

/** The composer's cause-aware draft watch (the mid-type wipe):
 *  every emission carries the committed VALUE and its CAUSE from the store's
 *  revision channel, so the composer can tell a FOREIGN consume (another
 *  process emptied the slot — cause 'watch'/'catch-up'/'recovery') from this
 *  runtime's own commits ('local-commit'). The old notify-then-reread seam
 *  had no cause and no value: any co-tenant field's commit racing the
 *  composer's first in-flight write read back as an empty slot and wiped the
 *  operator's typing. */
export function subscribeCoordinatorDraftChanges(
  cb: (change: { text: string; caret: number; cause: import('../../substrate/storeRevision.js').StoreChangeCause }) => void,
  dir?: string,
): () => void {
  return draftStore(dir).subscribeChanges(
    change => {
      const text = change.value.coordinatorDraft ?? ''
      const caret = change.value.coordinatorDraftCaret
      cb({
        text,
        caret: caret !== undefined ? Math.max(0, Math.min(text.length, caret)) : text.length,
        cause: change.cause,
      })
    },
    { immediate: false },
  )
}

/** R4: the attached session's OWN durable composer draft. */
export async function readConcourseSessionDraft(sessionId: string, dir?: string): Promise<string> {
  return (await draftStore(dir).read()).sessionDrafts?.[sessionId] ?? ''
}

/** CU-05+AR-11: the draft WITH its caret — rehydration restores the exact
 *  edit point, not end-of-text. A stored draft without a caret (a pre-caret
 *  write) resolves caret = end-of-text. */
export async function readConcourseSessionDraftState(
  sessionId: string,
  dir?: string,
): Promise<{ text: string; caret: number }> {
  const file = await draftStore(dir).read()
  const text = file.sessionDrafts?.[sessionId] ?? ''
  const caret = file.sessionDraftCarets?.[sessionId]
  return { text, caret: caret !== undefined ? Math.max(0, Math.min(text.length, caret)) : text.length }
}

/** Write-through per-session draft; empty text clears the key. The map is
 *  bounded to SESSION_DRAFT_CAP entries — oldest keys shed first (insertion
 *  order; a rewrite re-inserts at the tail). The caret rides beside the
 *  text (CU-05+AR-11); an absent caret keeps the legacy end-of-text read. */
export async function writeConcourseSessionDraft(sessionId: string, text: string, dir?: string, caret?: number): Promise<void> {
  await draftStore(dir).mutate(prev => {
    const next: Record<string, string> = { ...(prev.sessionDrafts ?? {}) }
    delete next[sessionId]
    if (text.length > 0) next[sessionId] = text.slice(0, 4000)
    const keys = Object.keys(next)
    for (const k of keys.slice(0, Math.max(0, keys.length - SESSION_DRAFT_CAP))) delete next[k]
    // Carets shadow the draft keys exactly — a shed/cleared text sheds its caret.
    const carets: Record<string, number> = {}
    for (const [k, v] of Object.entries(prev.sessionDraftCarets ?? {})) {
      if (next[k] !== undefined) carets[k] = v
    }
    if (next[sessionId] !== undefined && caret !== undefined && Number.isFinite(caret)) {
      carets[sessionId] = Math.max(0, Math.min(next[sessionId].length, Math.floor(caret)))
    }
    return {
      ...prev,
      updatedAtMs: Date.now(),
      ...(Object.keys(next).length > 0 ? { sessionDrafts: next } : { sessionDrafts: undefined }),
      ...(Object.keys(carets).length > 0 ? { sessionDraftCarets: carets } : { sessionDraftCarets: undefined }),
    }
  })
}

/** CU-05: the coordinator composer's durable draft (text + caret). */
export async function readCoordinatorComposerDraft(dir?: string): Promise<{ text: string; caret: number }> {
  const file = await draftStore(dir).read()
  const text = file.coordinatorDraft ?? ''
  const caret = file.coordinatorDraftCaret
  return { text, caret: caret !== undefined ? Math.max(0, Math.min(text.length, caret)) : text.length }
}

/** Write-through coordinator draft; empty text clears (accepted-send-only
 *  clears are the CALLER's law — this store just persists what it is told). */
export async function writeCoordinatorComposerDraft(text: string, caret: number, dir?: string): Promise<void> {
  const clamped = text.slice(0, 4000)
  await draftStore(dir).mutate(prev => ({
    ...prev,
    updatedAtMs: Date.now(),
    ...(clamped.length > 0
      ? {
          coordinatorDraft: clamped,
          coordinatorDraftCaret: Math.max(0, Math.min(clamped.length, Math.floor(caret))),
        }
      : { coordinatorDraft: undefined, coordinatorDraftCaret: undefined }),
  }))
}

/** The painted-truth mapping: the dispatch inputs ARE the strip's
 *  painted seeds — ONE mapping consumed by both the submit op and the
 *  preflight preview, so the chips can never claim one dispatch while
 *  another rides. Isolation always materializes (painted default included):
 *  the op's absent-field default ('exclusive') is not a state the strip
 *  offers, so omitting the field would dispatch something the chip does
 *  not say. */
/** The workspace-aware isolation DEFAULT:
 *  an unset isolation seed resolves against the workspace the dispatch will
 *  actually target — a git repository defaults to the reference's isolated
 * worktree; a plain folder defaults to the exclusive owner lease,
 *  the one mutating mode a folder without a repository can honor. The old
 *  unconditional worktree default made ↵ in a plain folder a dead end: the
 *  refusal named modes the strip could not even express. One resolver feeds
 *  the painted chip, the preflight preview and the dispatch op (display ≡
 *  dispatch across all three). */
export function resolveIsolationSeed(
  seeds: ConcourseSeedOverridesV1,
  cwd: string,
): 'isolated-worktree' | 'exclusive' | 'shared-read-only' {
  if (seeds.isolation !== undefined) return seeds.isolation
  // the default posture is the MAIN checkout — the
  // daemon forks a worktree on its own when the repo is already held. The
  // pre-ruling git→isolated default forked even the FIRST session, against
  // "the first session keeps the real checkout".
  return 'exclusive'
}

export function dispatchSeedInputs(
  seeds: ConcourseSeedOverridesV1,
  cwd: string,
  /** The snapshot's RESOLVED canonical model id (newSession.seeds.modelId):
   *  an unset seed sends THIS instead of nothing, so the daemon can never
   *  resolve a divergent default of its own (cross-process account/env
   *  drift becomes a typed refusal, never a silent substitute). */
  resolvedModelId?: string,
): {
  workspaceDir: string
  modelKey?: string
  effort?: string
  title?: string
  isolation: 'worktree-isolated' | 'read-only' | 'exclusive'
  agentName?: string
  seatsMax?: 1 | 2
} {
  const isolation = resolveIsolationSeed(seeds, cwd)
  return {
    workspaceDir: seeds.projectDir ?? cwd,
    ...(seeds.modelKey !== undefined
      ? { modelKey: seeds.modelKey }
      : resolvedModelId !== undefined
        ? { modelKey: resolvedModelId }
        : {}),
    ...(seeds.effort !== undefined ? { effort: seeds.effort } : {}),
    ...(seeds.title !== undefined ? { title: seeds.title } : {}),
    ...(seeds.agentName !== undefined ? { agentName: seeds.agentName } : {}),
    ...(seeds.seatsMax !== undefined ? { seatsMax: seeds.seatsMax } : {}),
    isolation:
      isolation === 'shared-read-only' ? 'read-only' : isolation === 'exclusive' ? 'exclusive' : 'worktree-isolated',
  }
}

// ── the snapshot fold ───────────────────────────────────────────────────────

/** THE CURRENT PROJECT'S PARKED CHATS (the concourse is the control plane
 *  and shows the current project's chats, not everything — the operator's
 *  word): the transcripts in the current project's session home
 *  (bootCardFacts.parkedSessionsOf — the Boot face's own store, husk
 *  filter and ≤10 bound), newest first, MINUS every session a live record
 *  owns (a live session is its own row; the same id never paints twice),
 *  the board's CLEARED marks (the double-x's durable effect), the host's
 *  own file, and any file with no first words (a blank newborn's leftover
 *  is not a chat). Each row is honest about what it is: state 'parked', a
 *  still NOW cell ("parked · <age>"), its brief as its title, the
 *  transcript on the row for the resume door, and its project as the
 *  mirror home (the file sits exactly where the mirror's path law looks —
 *  by construction). Never a global pile: pick another project and THAT
 *  project's parked chats stand here. Bounded: the listing's own budget
 *  plus one ≤8KB head read per row. Fail-soft: an unreadable store yields
 *  no rows, never a broken board. */
/** Wordless leftovers (a blank newborn's file) the listing may meet before
 *  the cap fills — the scan reaches this many past the subtractions. */
const PARKED_SCAN_SLACK = 4

/** THE OLDER LINE's id prefix — a door row, never a session: ↵ opens the
 *  project's own session list (the /sessions picker, project scope). */
export const OLDER_CHATS_ROW_PREFIX = 'older:'

/** THE OLDER LINE (operator, L11): the project's chats that are not on the
 *  board — beyond the week, beyond the cap, cleared — collapse into ONE
 *  honest line beneath the parked rows; they are never removed. */
export function olderChatsRow(projectDir: string, projectLabel: string, older: number): ConcourseRowV1 {
  return {
    sessionId: `${OLDER_CHATS_ROW_PREFIX}${projectDir}`,
    title: `${older} older chat${older === 1 ? '' : 's'} · ↵ to browse`,
    state: 'parked',
    projectLabel,
    ownerLabel: null,
    ageLabel: null,
    seats: null,
    nowLabel: null,
  }
}

// ── THE OLDER-CHATS CENSUS (operator, L20 — one scope truth) ────────────────
//
// The bug this owner retires: the line's N came from file arithmetic
// (projectChatCount − painted − a live estimate) while its ↵ opened the
// /sessions switcher, whose project scope subtracts board-homed sessions
// and cleared marks and partitions by each transcript's RECORDED cwd — two
// unrelated folds, so the board said "21 older chats" over a panel reading
// "No other sessions in this project". ONE owner now ENUMERATES the older
// chats and the painted N is that enumeration's length: the count can never
// again promise what no browse can show.

/** One browsable older chat — the count's unit and the drop-down's row. */
export interface OlderChatFact {
  sessionId: string
  /** The transcript file — the one resume door's input. */
  transcriptPath: string
  ageMs: number
  /** The L16 title at its best available for a record-less transcript: the
   *  chat's own first words (stage 2 — the same brief the parked rows wear). */
  title: string
}

export interface OlderChatsCensusV1 {
  /** THE line's N — exactly the chats this census enumerates. */
  total: number
  /** Newest-first, bounded by `entryCap`; `total - entries.length` is the
   *  browse door's honest "+N more" tail. */
  entries: OlderChatFact[]
}

/** The census walks every transcript in the project's store; heads are read
 *  once per (mtime,size) and remembered — an old chat never changes, so the
 *  steady state costs one stat per file, the same as the retired count. */
const olderFactCache = new Map<string, { mtimeMs: number; size: number; husk: boolean; title: string | null }>()
const OLDER_FACT_CACHE_CAP = 2048

function olderFactOf(projectDir: string, file: string, mtimeMs: number, size: number): { husk: boolean; title: string | null } {
  const held = olderFactCache.get(file)
  if (held !== undefined && held.mtimeMs === mtimeMs && held.size === size) return held
  const sessionId = basename(file).replace(/\.jsonl$/, '')
  const husk = isAuthFailureHusk(file, size)
  const title = husk ? null : headBriefLabel({ sessionId, workspaceId: projectDir }, 48)
  if (olderFactCache.size >= OLDER_FACT_CACHE_CAP) olderFactCache.clear()
  const fact = { mtimeMs, size, husk, title }
  olderFactCache.set(file, fact)
  return fact
}

/** THE ONE SCOPE TRUTH (L20): the project's older chats — every transcript
 *  in ITS session-store home that is not excluded (a standing record's
 *  session, a painted parked row, the host's own file) and is a real chat
 *  (not an auth husk, not a wordless leftover). Cleared and beyond-the-week
 *  chats are HERE — hidden from the rows, never from the count or the
 *  browse (L11: nothing is ever removed). Newest first; `entries` bounded
 *  by `entryCap` (0 = count only); fail-soft ⇒ an empty census. */
export function olderChatsCensus(
  projectDir: string,
  excludedSessionIds: ReadonlySet<string>,
  nowMs: number,
  opts: { excludeSessionId?: string; entryCap?: number; sessions?: readonly ParkedSessionFact[] } = {},
): OlderChatsCensusV1 {
  try {
    const entryCap = Math.max(0, opts.entryCap ?? 0)
    const skip = opts.excludeSessionId !== undefined ? `${opts.excludeSessionId}.jsonl` : null
    // The fixture seam (`sessions`) hands the candidates directly — the
    // same husk/wordless law walks them; the live path scans the ONE
    // session-store home the painted rows list.
    const candidates: Array<{ sessionId: string; file: string; mtimeMs: number; size: number; ageMs: number }> = []
    if (opts.sessions !== undefined) {
      for (const s of opts.sessions) {
        let st: { mtimeMs: number; size: number }
        try {
          st = statSync(s.transcriptPath)
        } catch {
          continue
        }
        candidates.push({ sessionId: s.sessionId, file: s.transcriptPath, mtimeMs: st.mtimeMs, size: st.size, ageMs: s.ageMs })
      }
    } else {
      const home = getProjectDir(projectDir)
      for (const f of readdirSync(home)) {
        if (!f.endsWith('.jsonl') || f === skip) continue
        try {
          const st = statSync(join(home, f))
          if (st.size === 0) continue
          candidates.push({
            sessionId: f.slice(0, -'.jsonl'.length),
            file: join(home, f),
            mtimeMs: st.mtimeMs,
            size: st.size,
            ageMs: Math.max(0, nowMs - st.mtimeMs),
          })
        } catch {
          /* racing delete */
        }
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
    let total = 0
    const entries: OlderChatFact[] = []
    for (const c of candidates) {
      if (excludedSessionIds.has(c.sessionId)) continue
      const fact = olderFactOf(projectDir, c.file, c.mtimeMs, c.size)
      if (fact.husk || fact.title === null) continue
      total += 1
      if (entries.length < entryCap) {
        entries.push({ sessionId: c.sessionId, transcriptPath: c.file, ageMs: c.ageMs, title: fact.title })
      }
    }
    return { total, entries }
  } catch {
    return { total: 0, entries: [] }
  }
}

export function parkedBoardRows(
  projectDir: string,
  liveSessionIds: ReadonlySet<string>,
  cleared: ReadonlySet<string>,
  nowMs: number,
  excludeSessionId?: string,
  sessions?: readonly ParkedSessionFact[],
): ConcourseRowV1[] {
  const rows: ConcourseRowV1[] = []
  try {
    const projectLabel = sanitizeLabel(projectDisplayName(projectDir))
    // The bound is PARKED ROWS (the one owner's cap) over THE WEEK TIER: the
    // listing reaches past the files the subtraction will drop — the
    // project's live sessions, its cleared marks, a few wordless leftovers
    // — so the board still shows up to the cap of REAL parked chats touched
    // this week.
    const listed =
      sessions ??
      parkedSessionsOf(projectDir, {
        ...(excludeSessionId !== undefined ? { excludeSessionId } : {}),
        cap: PARKED_CAP + liveSessionIds.size + cleared.size + PARKED_SCAN_SLACK,
        withinMs: PARKED_WEEK_MS,
        nowMs,
      })
    for (const s of listed) {
      if (rows.length >= PARKED_CAP) break
      if (liveSessionIds.has(s.sessionId) || cleared.has(s.sessionId)) continue
      const brief = headBriefLabel({ sessionId: s.sessionId, workspaceId: projectDir }, 48)
      if (brief === null) continue
      const ageLabel = ageLabelOf(nowMs, nowMs - s.ageMs)
      rows.push({
        sessionId: s.sessionId,
        title: brief,
        state: 'parked',
        projectLabel,
        ownerLabel: 'Mercury',
        ageLabel,
        seats: null,
        nowLabel: `parked · ${ageLabel}`,
        workspaceDir: projectDir,
        transcriptPath: s.transcriptPath,
      })
    }
    // The older line: cap first, then the line counts the rest through THE
    // CENSUS (L20 — one scope truth): every real chat of the project not
    // painted as a row and not owned by a standing record — older than a
    // week, past the cap, cleared — all of them browsable behind the line.
    // The N and the browse enumerate the SAME set by construction.
    const excluded = new Set<string>(liveSessionIds)
    for (const r of rows) excluded.add(r.sessionId)
    const census = olderChatsCensus(projectDir, excluded, nowMs, {
      ...(excludeSessionId !== undefined ? { excludeSessionId } : {}),
      ...(sessions !== undefined ? { sessions } : {}),
    })
    if (census.total > 0) rows.push(olderChatsRow(projectDir, projectLabel, census.total))
  } catch {
    /* the store is a projection — no parked chats is an honest answer */
  }
  return rows
}

/** Hostile-input floor: labels reaching the frame carry NO control
 *  bytes (a worker id / question with a raw ESC would corrupt the paint)
 *  and are length-clamped — truncation stays the renderer's job. */
export function sanitizeLabel(raw: string): string {
  let out = ''
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue
    out += ch
    if (out.length >= 160) break
  }
  return out
}

export function ageLabelOf(nowMs: number, sinceMs: number): string {
  const mins = Math.max(0, Math.round((nowMs - sinceMs) / 60_000))
  if (mins < 60) return `${String(mins).padStart(2, '0')}m`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

function clockOf(nowMs: number): string {
  const d = new Date(nowMs)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function resolvedCoordinator(): Promise<{
  mode: 'off' | 'rules-only' | 'agent-assisted'
  assistModelLabel?: string
  assistModelAvailability?: import('./coordinatorModels.js').CoordinatorModelAvailability
  assistModelStatus?: string
  fallbackReason?: string
}> {
  try {
    // ONE composition owner: mode × the composed-registry validation
    // resolve together — agent-assisted holds with any listed model, whose
    // truthful label rides beside it; the chip paints the VALIDATED choice
    // even under Rules only. The resolver's fallbackReason rides the
    // snapshot and the label is ALWAYS the registry displayName — never
    // the raw model id.
    const { resolveEffectiveCoordinator } = await import('./coordinatorLane.js')
    const effective = await resolveEffectiveCoordinator()
    const mode = effective.resolution.effective
    const fallbackReason = effective.resolution.fallbackReason
    if (effective.assistModelId !== undefined) {
      return {
        mode,
        assistModelLabel: effective.assistModelLabel ?? effective.assistModelId,
        ...(effective.assistModelStatus !== undefined && effective.assistModelAvailability !== undefined
          ? { assistModelAvailability: effective.assistModelAvailability, assistModelStatus: effective.assistModelStatus }
          : {}),
      }
    }
    if (mode !== 'off') {
      const { getGlobalConfig } = await import('../../utils/config.js')
      const cfg = getGlobalConfig().concourseCoordinator
      if (cfg?.assistModel) {
        const { validateCoordinatorModelChoice, coordinatorModelStatusLabel } = await import('./coordinatorModels.js')
        const validated = await validateCoordinatorModelChoice(cfg.assistModel)
        if (validated.ok) {
          const status = coordinatorModelStatusLabel(validated.entry)
          return {
            mode,
            assistModelLabel: validated.entry.displayName,
            ...(status.length > 0 ? { assistModelAvailability: validated.entry.availability, assistModelStatus: status } : {}),
            ...(fallbackReason !== undefined ? { fallbackReason } : {}),
          }
        }
      }
    }
    return { mode, ...(fallbackReason !== undefined ? { fallbackReason } : {}) }
  } catch {
    return { mode: 'rules-only' } // config unavailable (headless/fixture) — the default truth
  }
}

export interface BuildConcourseSnapshotOpts {
  recordsDir?: string
  crewDir?: string
  draftDir?: string
  /** The peeked session (the board selection); absent ⇒ the first live row. */
  peekSessionId?: string
  /** event states the surface layers on (handoff wink, typed refusal). */
  residentOverride?: 'wink' | 'refused' | 'held'
  nowMs?: number
  /** THE BOARD'S PROJECT (the concourse is the control plane and shows the
   *  current project's chats): absent ⇒ the catalog door's identity of the
   *  live ground (currentProject); a proof hands one in (projectIdentity). */
  project?: ProjectIdentity
}

export async function buildConcourseSnapshot(
  opts: BuildConcourseSnapshotOpts = {},
): Promise<ConcourseSnapshotV1> {
  const nowMs = opts.nowMs ?? Date.now()
  const supervisor = await import('../../daemon/concourseSupervisor.js')
  const obligations = await import('../crew/obligations.js')
  const { isProcessAlive } = await import('../../daemon/ownerWatch.js')

  // THE BOARD'S PROJECT — the catalog door's identity of the live ground
  // (never null; the proof seam hands one in). THE SCOPE: only records
  // whose ORIGIN workspace is this project's paint rows here (inProject —
  // realpath/NFC/symlink-safe on the store-dir key); every other project's
  // sessions keep running out of view (the machine's counts still carry
  // them; a sibling lane paints the door to them). Never a global pile.
  const project = opts.project ?? currentProject()
  const allRecords = supervisor.listConcourseWorkers(null, opts.recordsDir)
  const records = allRecords.filter(r => inProject(project, r.workspaceId))
  // the board reads thescope (one cwd-independent file);
  // the one-time fold carries any open rows minted under the retired
  // ambient-hash name across — the operator was mid-drive at the switch.
  await obligations
    .foldLegacyObligationsIntoSwitchboardScope(opts.crewDir)
    .catch(() => 0)
  const openObl = await obligations.openObligations({
    scope: 'switchboard',
    ...(opts.crewDir !== undefined ? { dir: opts.crewDir } : {}),
  })
  const needsYouSessions = new Set(openObl.map(o => o.sessionId))

  // THE INVARIANT (the operator's word): the board = the current
  // project's sessions + the one FOCUSED session (★ if foreign) + a
  // running-count line per other project with activity. The project filter
  // is a VIEW; focus is a FACT — the board filters by project (above), then
  // always adds the session the slot holds, wherever it lives (cross-project
  // awareness, law 2). Every other project's sessions keep running untouched
  // and simply do not paint as rows here. The slot is a projection of the
  // visible process: a headless builder (a fixture, the coordinator's own
  // process) carries no focus.
  let focusedSessionId: string | null = null
  let focusedRecord: DaemonSessionRecordV1 | undefined
  try {
    const slot = await import('../engine-connector/focusedConnector.js')
    if (slot.hasFocusedSession()) {
      focusedSessionId = slot.getFocusedSessionConnector().sessionId()
      const seat = await import('../engine-connector/daemonConnector.js')
      focusedRecord = seat.getDaemonSessionConnector(focusedSessionId)?.record
    }
  } catch {
    /* no slot here — the board scopes without a carry-over */
  }
  /** The project's name when `workspaceId` lies OUTSIDE the board's
   *  project; undefined for the project's own sessions. */
  const foreignOf = (workspaceId: string): string | undefined =>
    inProject(project, workspaceId) ? undefined : sanitizeLabel(projectDisplayName(workspaceId))

  // Every record folds ONCE (the machine's counts read them all); the
  // board's rows are the scoped subset below. Liveness per session rides
  // beside it for the activity owner (a waiting session counts as running
  // only while its runner is alive).
  const aliveById = new Map<string, boolean>()
  const workspaceOfRow = new Map<string, string>()
  const allRows: ConcourseRowV1[] = allRecords.map(rec => {
    const alive = rec.pid !== undefined && isProcessAlive(rec.pid)
    aliveById.set(rec.sessionId, alive)
    const state = concourseRecordState(rec, { needsYou: needsYouSessions.has(rec.sessionId), alive })
    const projectName = basename(rec.workspaceId) || rec.workspaceId
    workspaceOfRow.set(rec.sessionId, rec.workspaceId)
    // (the NOW cell): live rows carry their latest
    // activity from the transcript tail itself — never a fabricated story.
    // A CRASH row's cell IS the reason line (the visibility law): the
    // operator reads what happened where the activity would be.
    // A PARKED row's cell is still — "parked · <age since the close>" — or
    // the one-line reason a failed reactivate left on it; no tail read.
    const nowLabel =
      state === 'parked'
        ? rec.parkReason !== undefined
          ? sanitizeLabel(rec.parkReason)
          : `parked · ${ageLabelOf(nowMs, rec.parkedAt ?? rec.spawnedAt)}`
        : rec.crash !== undefined && state === 'needs-you'
          ? sanitizeLabel(rec.crash.reason)
          : state === 'needs-you' && !alive && rec.pid !== undefined
            ? // The client-derived death (no crash fact was ever stamped —
              // a hard kill fires no exit event on win32): the cell says
              // what happened, never a stale tail with a climbing age.
              'its process is gone'
            : state === 'working' || state === 'ready-to-review' || state === 'needs-you'
              ? tailActivityLabel(rec)
            : state === 'attached'
              ? 'with you'
              : state === 'stopped' && rec.retired !== undefined
                ? retiredNowLabel(rec.retired)
                : null
    return {
      sessionId: rec.sessionId,
      // SESSION-AWARE NAMING (L16): the one owner's three stages — the
      // stored title, else the chat's first words, else "new session ·
      // <project> · ready"; the worker short is a detail-column fact and
      // NEVER a title, in any world (covers the parked title-loss class).
      title: sanitizeLabel(sessionTitleOf(rec, () => headBriefLabel(rec, 48))),
      state,
      projectLabel: sanitizeLabel(projectName),
      // retired from paint (the word 'agent' ban): the label field
      // stays for derivations (nameplates default 'Mercury').
      ownerLabel: sanitizeLabel(rec.agentName ?? 'Mercury'),
      ageLabel: ageLabelOf(nowMs, rec.spawnedAt),
      seats: null, // RECORDED POSTURE (close-sanity P3): worker permits are cross-process truth this process deliberately does NOT fabricate — rows render '—'; the counts numerator below expresses the SAME honesty as the coordinator's own in-process lane only
      nowLabel,
      ...(rec.workflowsAllowed === true ? { workflowsAllowed: true } : {}),
      // SATURN (the banked spec): the row's "next fire" fact through the
      // landed projection — present exactly when a future fire stands.
      ...((): { scheduleNextFireMs?: number } => {
        const next = saturnSoonestFireMs(rec, nowMs)
        return next !== null ? { scheduleNextFireMs: next } : {}
      })(),
      workspaceDir: rec.workspaceId,
      // The credential wall's row-receipt input (L25): the record's model,
      // so the live composer can name the family a send would fail on.
      ...(typeof rec.modelKey === 'string' && rec.modelKey !== '' ? { modelId: rec.modelKey } : {}),
      ...(rec.branchName !== undefined ? { worktreeBranch: sanitizeLabel(rec.branchName) } : {}),
      // The resume door's input rides a parked row (the transcript-derived
      // parked rows carry theirs the same way).
      ...(state === 'parked' ? { transcriptPath: workerTranscriptPath(rec) } : {}),
    }
  })

  // ADMISSION-HELD
  // dispatches are board rows, not invisible ledger entries — the reference's
  // QUEUED band ('waits'). A held row has no session/worker yet: owner '—',
  // age from its reservation, seats 'waits' via the queued state.
  try {
    const { readConcourseDispatches, normalizeHoldReason } = await import('../../daemon/concourseDispatch.js')
    const heldRows = Object.values(readConcourseDispatches(opts.recordsDir))
      .filter(d => d.state === 'queued' && d.sessionId === undefined && d.heldReason !== undefined)
      // The scope: a held launch belongs to the project it was aimed at; a
      // reservation with no workspace on record stays visible (unscopable).
      .filter(d => d.workspaceId === undefined || inProject(project, d.workspaceId))
      .map(d => {
        // The typed reason rides the row — 'seat' and 'repo-held'
        // paint differently everywhere downstream.
        let waitReason: ConcourseRowV1['waitReason'] = normalizeHoldReason(d.heldReason) as Exclude<
          ReturnType<typeof normalizeHoldReason>,
          'session-with-you'
        >
        // Operator fix 4: a repo-held row whose holder is ABSENT
        // must stop claiming a live holder — re-derive at paint time.
        if (waitReason === 'repo-held') {
          // SB-C1: an attached holder's child is dead by design — the claim
          // is the operator's terminal; 'unblocked' on a with-you holder
          // invited the ↵ that lands a duplicate on the held checkout.
          const holderLive = allRecords.some(
            r =>
              r.endedAt === undefined &&
              r.workspaceId === d.workspaceId &&
              (r.isolation ?? 'exclusive') === 'exclusive' &&
              ((r.pid !== undefined && isProcessAlive(r.pid)) || r.attachedAt !== undefined),
          )
          if (!holderLive) waitReason = 'unblocked'
        }
        if (d.workspaceId !== undefined) workspaceOfRow.set(`dispatch:${d.clientMessageId}`, d.workspaceId)
        return {
          sessionId: `dispatch:${d.clientMessageId}`,
          title: sanitizeLabel(d.title ?? 'queued dispatch'),
          state: 'queued' as const,
          projectLabel: sanitizeLabel(d.workspaceId !== undefined ? basename(d.workspaceId) || d.workspaceId : '—'),
          ownerLabel: '—',
          ageLabel: ageLabelOf(nowMs, d.acceptedAt),
          seats: null,
          ...(waitReason !== undefined ? { waitReason } : {}),
          ...(waitReason !== 'unblocked' && d.heldByTitle !== undefined
            ? { waitDetail: sanitizeLabel(d.heldByTitle) }
            : {}),
        }
      })
    allRows.push(...heldRows)
  } catch {
    /* the ledger is a projection — an unreadable file never blanks the board */
  }

  // finished forks awaiting their merge are BOARD ROWS —
  // unconsumed retained evidence paints READY TO REVIEW ('ready to merge')
  // instead of stranding silently in a file no reader renders.
  try {
    const { readCollisionEvidence } = await import('../../daemon/concourseSupervisor.js')
    const retainedRows = readCollisionEvidence(opts.recordsDir)
      .filter(e => e.kind === 'authored-work-retained' && e.consumedAt === undefined && e.branchName !== undefined)
      // The scope: a finished fork belongs to the project it was carved from.
      .filter(e => inProject(project, e.workspaceId))
      .slice(-6)
      .map(e => ({
        sessionId: e.holders[0]?.sessionId ?? `retained:${e.holders[0]?.workerId ?? e.observedAt}`,
        title: sanitizeLabel(e.branchName ?? 'finished fork'),
        state: 'ready-to-review' as const,
        projectLabel: sanitizeLabel(basename(e.workspaceId) || e.workspaceId),
        ownerLabel: '—',
        ageLabel: ageLabelOf(nowMs, e.observedAt),
        seats: null,
        nowLabel: 'ready to merge',
        workspaceDir: e.workspaceId,
        worktreeBranch: sanitizeLabel(e.branchName ?? ''),
      }))
    for (const r of retainedRows) {
      if (!allRows.some(x => x.sessionId === r.sessionId)) allRows.push(r)
    }
  } catch {
    /* evidence is a projection too */
  }

  // THE BOARD'S ROWS: the project's own (a row with no workspace on record
  // — a finished fork's, a workspace-less reservation — was scoped at its
  // source or cannot be, and stands) — PLUS THE ONE EXCEPTION to the filter:
  // the focused session wherever it lives, wearing its own project's name
  // as the ★ mark (law 2).
  const rows = allRows.flatMap(r => {
    const workspace = workspaceOfRow.get(r.sessionId)
    if (workspace === undefined || inProject(project, workspace)) return [r]
    return r.sessionId === focusedSessionId ? [{ ...r, foreignProject: foreignOf(workspace) ?? '' }] : []
  })
  // The focused chat of ANOTHER project with no live record — a parked chat
  // brought back and not yet admitted, or a runner that died — stays on the
  // board as the ★ row too: parked, with its transcript on the row, so ↵
  // rides the same parked arm every parked row rides (never a second door).
  let foreignParkedRow: ConcourseRowV1 | undefined
  if (
    focusedSessionId !== null &&
    focusedRecord !== undefined &&
    !rows.some(r => r.sessionId === focusedSessionId) &&
    foreignOf(focusedRecord.workspaceId) !== undefined
  ) {
    const name = foreignOf(focusedRecord.workspaceId) ?? ''
    foreignParkedRow = {
      sessionId: focusedSessionId,
      title: sanitizeLabel(focusedRecord.title.length > 0 ? focusedRecord.title : focusedSessionId.slice(0, 8)),
      state: 'parked',
      projectLabel: name,
      ownerLabel: 'Mercury',
      ageLabel: null,
      seats: null,
      nowLabel: 'parked',
      workspaceDir: focusedRecord.workspaceId,
      transcriptPath: join(focusedRecord.home, `${focusedSessionId}.jsonl`),
      foreignProject: name,
    }
  }

  const byBucket = (bucket: ConcourseRowV1['state'][]): ConcourseRowV1[] =>
    rows.filter(r => bucket.includes(r.state))
  const groups: ConcourseSnapshotV1['groups'] = []
  // Sessions THIS terminal owns through an attach lead the board.
  const attachedRows = byBucket(['attached'])
  if (attachedRows.length > 0) groups.push({ id: 'attached', label: 'WITH YOU', rows: attachedRows })
  const needsYouRows = byBucket(['needs-you'])
  const reviewRows = byBucket(['ready-to-review'])
  const workingRows = byBucket(['working'])
  const startingRows = byBucket(['starting'])
  const queuedRows = byBucket(['queued'])
  const pausedRows = byBucket(['paused'])
  const stoppedRows = byBucket(['stopped'])
  if (needsYouRows.length > 0) groups.push({ id: 'needs-you', label: 'NEEDS YOU', rows: needsYouRows })
  // a live worker whose turn settled is
  // READY TO REVIEW — attention still outranks it above.
  if (reviewRows.length > 0) groups.push({ id: 'ready-to-review', label: 'READY TO REVIEW', rows: reviewRows })
  if (workingRows.length > 0) groups.push({ id: 'working', label: 'WORKING', rows: workingRows })
  if (startingRows.length > 0) groups.push({ id: 'starting', label: 'STARTING', rows: startingRows })
  // The reference's QUEUED band: admission-held dispatches waiting a seat/
  // workspace — distinct from STARTING (spawn in progress).
  if (queuedRows.length > 0) groups.push({ id: 'queued', label: 'QUEUED', rows: queuedRows })
  if (pausedRows.length > 0) groups.push({ id: 'paused', label: 'PAUSED', rows: pausedRows })
  // Operator x-gesture: stopped rows stay VISIBLE until the second x
  // releases them — the operator sees what they stopped.
  if (stoppedRows.length > 0) groups.push({ id: 'stopped', label: 'STOPPED', rows: stoppedRows })
  // THE RUNNING-COUNT LINE, A DOOR (cross-project awareness, law 4): for
  // every OTHER project with activity the board paints ONE small line —
  // "N running in foo" with "switch to see them" in its NOW cell — from the
  // ONE activity owner over the daemon's whole roster; ↵ on it switches the
  // view through the REPO picker's own path. Its own group, after the
  // current project's live groups and BEFORE the parked pile (running
  // things elsewhere outrank dormant chats here); bounded to ELSEWHERE_CAP
  // lines by activity, painted in NAME order so a count change never
  // re-sorts (content-keyed by the project key); "+N more" stays honest and
  // opens the picker. The carried-over focused session is not counted where
  // it came from — it is on this board already; the line counts what you
  // do not see.
  const elsewhere: ConcourseElsewhereV1[] = projectActivity(allRows, {
    current: project,
    excludeSessionId: focusedSessionId,
    aliveOf: sessionId => aliveById.get(sessionId) ?? false,
  })
  const shownElsewhere = elsewhere.slice(0, ELSEWHERE_CAP).sort((a, b) => a.name.localeCompare(b.name))
  const doorRows: ConcourseRowV1[] = shownElsewhere.map(p => ({
    sessionId: `project:${p.key}`,
    title: sanitizeLabel(elsewhereLine(p)),
    state: 'elsewhere',
    projectLabel: sanitizeLabel(p.name),
    ownerLabel: null,
    ageLabel: null,
    seats: null,
    nowLabel: 'switch to see them',
    door: { kind: 'switch-project', dir: p.dir, running: p.running, needsYou: p.needsYou, finished: p.finished },
  }))
  const moreElsewhere = elsewhere.length - shownElsewhere.length
  if (moreElsewhere > 0) {
    doorRows.push({
      sessionId: 'project:+more',
      title: `+${moreElsewhere} more project${moreElsewhere === 1 ? '' : 's'} with activity`,
      state: 'elsewhere',
      projectLabel: '—',
      ownerLabel: null,
      ageLabel: null,
      seats: null,
      // Class 5: an authored KEY HINT folds to the host's spelling at its
      // authoring site (the snapshot is same-process render state; the
      // generic nowLabel painter must never fold arbitrary data text).
      nowLabel: keyHintLabel('⌃g picks one'),
      door: { kind: 'pick-project', more: moreElsewhere },
    })
  }
  if (doorRows.length > 0) groups.push({ id: 'elsewhere', label: 'OTHER PROJECTS', rows: doorRows })
  rows.push(...doorRows)

  // Drive-12 amend (A-5, the reviewer): ONE seat truth with admission — a
  // WITH-YOU (attached) session and a STARTING one both hold their seat
  // (admission's liveWorkers = roster-live OR attachedAt); the old tally
  // read them as absent ('1 live · 1/5 seats' with three sessions, two with
  // you) and the pump replayed seat-held dispatches into a full board.
  //
  // AND the fold runs the other way too (TASK-017 supplement, S1): a row in
  // a live-shaped STATE whose process is GONE holds no seat at admission's
  // door (`pid alive OR attachedAt`, concourseDispatch), so it must hold
  // none here — dead-pid records once tallied as live wedged the replay
  // pump ('cleared' never true) and raised the "every seat is taken" card
  // off phantoms a hard-killed daemon could no longer reconcile. 'starting'
  // rows are pre-pid by derivation (a recorded-dead pid paints needs-you),
  // so they keep their seat exactly as Drive-12 ruled.
  const LIVE_STATES: ReadonlyArray<ConcourseRowV1['state']> = ['working', 'needs-you', 'stalled', 'paused', 'ready-to-review', 'attached', 'starting']
  const holdsSeat = (r: ConcourseRowV1): boolean =>
    LIVE_STATES.includes(r.state) &&
    (r.state === 'attached' || r.state === 'starting' || aliveById.get(r.sessionId) === true)
  const live = rows.filter(holdsSeat)
  // THE COUNTS ARE THE MACHINE'S: the seats fraction and the admission pump
  // read them — a project-scoped board must not say "1 live" while the
  // daemon holds five seats.
  const liveAll = allRows.filter(holdsSeat)
  const peekRecord =
    records.find(r => r.sessionId === (opts.peekSessionId ?? '')) ??
    records.find(r => live.some(l => l.sessionId === r.sessionId)) ??
    null

  const scopeClear =
    peekRecord === null ||
    !allRecords.some(
      other =>
        other !== peekRecord &&
        other.workspaceId === peekRecord.workspaceId &&
        (other.isolation ?? 'exclusive') === 'exclusive' &&
        (peekRecord.isolation ?? 'exclusive') === 'exclusive',
    )

  const draftFile = await draftStore(opts.draftDir).read()
  const draft = draftFile.draft
  const draftCaret = Math.max(0, Math.min(draft.length, draftFile.draftCaret ?? draft.length))
  // The operator's durable seed overrides resolve into the painted seeds —
  // every override maps to a real dispatch input.
  const seedOverrides = await readConcourseSeedOverrides(opts.draftDir)
  // THE PROJECT'S NAME rides the ONE catalog owner (the folder-as-project
  // law): the live harness ground by its folder's name — a `.mercury`
  // ground wears its parent's — with no history needed. Both ground doors
  // move getCwd with the seed chip, and a chip persisted by an earlier boot
  // is cleared at the route's mount, so the chip never outranks the ground.
  const projectLabel = project.name
  // THE CURRENT PROJECT'S PARKED CHATS (the concourse is the control plane
  // and shows the current project's chats): the LAST group — beneath every
  // live row, bounded per project by the store's own ≤10, the catalog
  // door's project (the ground the REPO picker and the boot menu's
  // Projects both move) — never a global pile.
  let hostSessionId: string | undefined
  try {
    const state = await import('../../bootstrap/state.js')
    hostSessionId = String(state.getSessionId())
  } catch {
    hostSessionId = undefined
  }
  // ONE parked group, two sources: the records own every session with a
  // standing record (a PARKED record — the operator closed that chat — is
  // a parked row from the ladder, newest close first), and the transcript
  // listing fills in the record-less history beneath them. The listing
  // subtracts every standing record's id (this project's and every
  // other's), so no session paints twice.
  const parkedRecordRows = byBucket(['parked']).sort((a, b) => {
    const at = (row: ConcourseRowV1): number => records.find(r => r.sessionId === row.sessionId)?.parkedAt ?? 0
    return at(b) - at(a)
  })
  const parkedTranscriptRows = parkedBoardRows(
    project.dir,
    new Set(allRecords.map(r => r.sessionId)),
    new Set(Object.keys(draftFile.parkedCleared ?? {})),
    nowMs,
    hostSessionId,
  )
  const parkedRows = [...parkedRecordRows, ...parkedTranscriptRows]
  // The carried-over focused chat with no runner leads the parked group
  // (it is the one row the operator is inside); the current project's
  // parked chats follow, newest first. Record-backed parked rows are
  // already in `rows` (byBucket); only the synthesized rows join it here.
  const parkedGroupRows = [...(foreignParkedRow !== undefined ? [foreignParkedRow] : []), ...parkedRows]
  if (parkedGroupRows.length > 0) groups.push({ id: 'parked', label: 'PARKED', rows: parkedGroupRows })
  rows.push(...parkedTranscriptRows)
  if (foreignParkedRow !== undefined) rows.push(foreignParkedRow)
  // The worker-role model space is the ONE provider-neutral callable-model
  // owner: the strip
  // paints the canonical entry's display name and cycles the registry's
  // AVAILABLE rows; the admission validates against the same composition.
  const { composeWorkerModelRegistry, canonicalWorkerModelId, defaultWorkerModelId } = await import('./workerModels.js')
  const workerRegistry = await composeWorkerModelRegistry()
  // The unset-seed default derives from the registry (owner-side law): the
  // strip never advertises a default this account cannot dispatch.
  const chosenModelId =
    seedOverrides.modelKey !== undefined
      ? await canonicalWorkerModelId(seedOverrides.modelKey)
      : defaultWorkerModelId(workerRegistry, 'session')
  const modelLabel =
    workerRegistry.entries.find(e => e.modelId === chosenModelId)?.displayName ?? chosenModelId
  // The peeked session's scope line upgrades from the
  // boolean to the TYPED evidence when a recorded collision names this
  // workspace — the newest row carries who held it.
  let scopeDetail = 'shares a workspace exclusively'
  if (!scopeClear && peekRecord !== null) {
    try {
      const evidence = supervisor
        .readCollisionEvidence(opts.recordsDir)
        .filter(e => e.workspaceId === peekRecord.workspaceId && e.kind === 'exclusive-overlap')
      const latest = evidence[evidence.length - 1]
      if (latest !== undefined) {
        scopeDetail = `exclusive overlap · ${latest.holders.length} holder(s) · ${clockOf(latest.observedAt)}`
      }
    } catch {
      /* the boolean truth stands */
    }
  }
  // The strip's dispatch PREVIEW — every preflight term
  // named BEFORE any provider use, recomputed with the snapshot (bounded:
  // records ∩ liveness, zero writes). Only meaningful while a draft exists.
  let preflight: { ok: boolean; refusals: string[] } | undefined
  if (draft.length > 0) {
    try {
      const { preflightConcourseDispatch } = await import('../../daemon/concourseDispatch.js')
      // The preview previews THE dispatch the seeds describe — the same
      // painted-truth mapping the submit rides (dispatchSeedInputs), never
      // a pinned default one (a preview pinned to
      // getCwd()+worktree-isolated claims a dispatch the
      // operator's cycled project/isolation would not make).
      // an UNCHOSEN isolation is the daemon's decision (main
      // first, fork when held) — the preview mirrors the same defaulting by
      // omitting the field exactly as the submit op does.
      const previewReq: Omit<ReturnType<typeof dispatchSeedInputs>, 'isolation'> & {
        isolation?: 'worktree-isolated' | 'read-only' | 'exclusive'
      } = { ...dispatchSeedInputs(seedOverrides, getCwd()) }
      if (seedOverrides.isolation === undefined) delete previewReq.isolation
      const pf = await preflightConcourseDispatch(previewReq, opts.recordsDir)
      preflight = pf.ok ? { ok: true, refusals: [] } : { ok: false, refusals: pf.refusals.map(r => r.reason).slice(0, 3) }
    } catch {
      preflight = undefined // preview unavailable ⇒ no claim (never a fake ok)
    }
  }
  const coordinator = await resolvedCoordinator()
  // '+1 iff the Agent-assisted Coordinator is enabled' (the ONE
  // global lane joins the denominator); its held permit joins the numerator
  // from the governor's in-process truth.
  let coordinatorHeld = 0
  if (coordinator.mode === 'agent-assisted') {
    try {
      const governor = await import('../capacity/governor.js')
      coordinatorHeld = governor.heldPermits().filter(g => g.lane === 'coordinator').length
    } catch {
      coordinatorHeld = 0
    }
  }

  // The rail's model + effort speak ONE row — the peeked record when present,
  // else the seed default — both resolved through the registry (records store
  // canonical ids post-F1; the surface speaks display names, raw only when a
  // key is unknown to this account's registry).
  const railModelId =
    peekRecord !== null ? await canonicalWorkerModelId(peekRecord.modelKey ?? 'fable') : chosenModelId
  // Effort follows the same ONE-row law: the peeked record's spawn-captured
  // effort when present, else the SEED's resolved effort (override ??
  // registry convention) — display ≡ dispatch.
  const railEffort =
    (peekRecord !== null ? peekRecord.effort : seedOverrides.effort) ??
    workerRegistry.entries.find(e => e.modelId === railModelId)?.effort
  return {
    schema: 1,
    revision: nowMs,
    clock: clockOf(nowMs),
    context: {
      projectLabel,
      operatorHandle: (await import('../../utils/cockpit/presenceLive.js')).getOperatorName(),
      ...(railEffort ? { effortLabel: railEffort } : {}),
    },
    breadcrumb: { active: 'concourse' },
    // ONE mode owner: the kernel's resolver over the per-user
    // config — a configured agent-assisted downgrades honestly until the
    // lane lands. No assist model until the composed picker exists (never
    // advertise an unavailable capability).
    coordinator,
    // the host root-REPL disclosure — structural truth of this
    // surface (the concourse paints only while RouteSurfaceHost parks the
    // root REPL; submissions reach workers), typed so capacity/session
    // truth can never hide a model-capable root.
    mainRepl: {
      kind: 'non-model-controller',
      counted: false,
      submission: 'disabled-while-parked',
      reachedBy: 'esc',
    },
    counts: {
      live: liveAll.length,
      needsYou: openObl.length,
      working: allRows.filter(r => r.state === 'working').length,
      queued: allRows.filter(r => r.state === 'starting').length,
      seatsHeld: coordinatorHeld, // RECORDED POSTURE: the numerator is the coordinator's OWN lane — worker-held permits are cross-process truth deliberately NOT fabricated in-process (the peek's seats:null is the same law); the denominator carries the formula
      // The denominator honors each session's RECORDED ceiling (a
      // seatsMax=1 session must not contribute 2 to the painted capacity).
      seatsDenominator:
        liveAll.reduce((sum, row) => {
          const rec = allRecords.find(r => r.sessionId === row.sessionId)
          return sum + (rec?.seatsMax ?? 2)
        }, 0) + (coordinator.mode === 'agent-assisted' ? 1 : 0),
      admission: 'auto-balanced',
    },
    needsYou: openObl.map(o => {
      // THE CROSS-PROJECT PING IS A DOOR (law 5): a need raised by a session
      // of ANOTHER project reads "switch to <name> · needs you / finished"
      // and carries that project as its door; every row names ITS OWN
      // project (the record's), never the board's.
      // ALL records, never the project-scoped list: a FOREIGN session's
      // record is exactly what the scope drops, and reading the scoped list
      // here painted every cross-project ask as an ordinary door-less row
      // (no "switch to <name>", the board's own project label) — the law
      // says the row names ITS project and carries the door.
      const rec = allRecords.find(r => r.sessionId === o.sessionId)
      const home = rec !== undefined ? foreignOf(rec.workspaceId) : undefined
      const finished = isCrossProjectFinishedRef(o.ref)
      return {
        obligationId: o.obligationId,
        // Q2: a `permission:<requestId>` ref marks a parked PERMISSION ask —
        // the rail answers it y/n through the answer-permission door.
        ...(o.ref !== undefined ? { ref: o.ref } : {}),
        sessionId: o.sessionId,
        title:
          home !== undefined
            ? sanitizeLabel(`switch to ${home} · ${finished ? 'finished' : 'needs you'}`)
            : sanitizeLabel(o.question.length > 24 ? `${o.question.slice(0, 24)}…` : o.question),
        question: sanitizeLabel(o.question),
        projectLabel: rec !== undefined ? sanitizeLabel(projectDisplayName(rec.workspaceId)) : projectLabel,
        agentLabel: sanitizeLabel(o.owner),
        ageLabel: ageLabelOf(nowMs, o.createdAtMs),
        ...(home !== undefined && rec !== undefined ? { foreignProject: { dir: rec.workspaceId, name: home } } : {}),
      }
    }),
    groups,
    elsewhere,
    peek: peekRecord
      ? {
          sessionId: peekRecord.sessionId,
          title: sanitizeLabel(sessionTitleOf(peekRecord, () => headBriefLabel(peekRecord, 48))),
          // R7 C-LOW-3: the SAME derivation as the board rows — one atomic
          // snapshot must never say ready-to-review on the board and
          // 'working' in the peek for the same session.
          state: concourseRecordState(peekRecord, {
            needsYou: needsYouSessions.has(peekRecord.sessionId),
            alive: peekRecord.pid !== undefined && isProcessAlive(peekRecord.pid),
          }),
          // a plain folder is an HONEST typed capability —
          // the project fact says so (zero contract/geometry change; the
          // reference sessions are all repositories, frame untouched).
          projectLabel: sanitizeLabel(
            (basename(peekRecord.workspaceId) || peekRecord.workspaceId) +
              (peekRecord.workspaceKind === 'plain-folder' ? ' · plain folder' : ''),
          ),
          agentLabel: sanitizeLabel(peekRecord.agentName ?? 'Mercury'),
          modelLabel:
            workerRegistry.entries.find(e => e.modelId === railModelId)?.displayName ?? peekRecord.modelKey,
          // the immutable capture vs the LIVE profile revision
          // (Boot edits reach new sessions only — the peek says which side
          // of that line this session sits on). Only when the record
          // carries the capture; never fabricated for legacy/fixture rows.
          ...(await (async () => {
            const cap = peekRecord.settingsSnapshot
            if (cap === undefined) return {}
            try {
              const { readBootDefaultsProfile } = await import('../../substrate/startupMenu.js')
              const nowRev = readBootDefaultsProfile()?.revision ?? 0
              return {
                settings: {
                  revisionLabel: `r${cap.profileRevision}`,
                  profileRevision: cap.profileRevision,
                  current: cap.profileRevision === nowRev,
                },
              }
            } catch {
              return {}
            }
          })()),
          seats: null, // same cross-process honesty as the counts numerator — never fabricated
          timeline: [{ clock: clockOf(peekRecord.spawnedAt), label: 'started' }],
          scope: scopeClear ? { kind: 'clear' } : { kind: 'overlap', detail: scopeDetail },
          // The receipts are REAL now — the actions derive from the
          // record's truth: a live unpaused session may pause or take a
          // redirect; a paused one may resume; entering is always lawful.
          actions: [
            'enter-full-session',
            ...(peekRecord.pausedAt === undefined && peekRecord.pid !== undefined && isProcessAlive(peekRecord.pid)
              ? (['pause-after-turn', 'redirect'] as const)
              : []),
            ...(peekRecord.pausedAt !== undefined ? (['resume'] as const) : []),
          ],
          // identityColor stays absent here: the RENDER side derives it from
          // the token palette (agentAccents by stable session hash) — data
          // carries identity, tokens carry color (the role law).
          residentState:
            opts.residentOverride ??
            (rows.find(r => r.sessionId === peekRecord.sessionId)?.state === 'starting' ? 'molt' : 'settled'),
        }
      : null,
    newSession: {
      seeds: {
        projectLabel,
        // agent + seats are REAL editable overrides riding the op.
        agentLabel: sanitizeLabel(seedOverrides.agentName ?? 'Mercury'),
        modelLabel,
        modelId: chosenModelId,
        // The chip paints only when focused or non-default (the rail is the
        // one always-on model location); equality vs the registry default
        // covers an explicit override that lands back ON the default.
        modelIsDefault: chosenModelId === defaultWorkerModelId(workerRegistry, 'session'),
        // Operator: the effort seed — the convention ('high')
        // when unset; the chip paints only focused-or-overridden.
        effortLevel: seedOverrides.effort ?? 'high',
        effortIsDefault: (seedOverrides.effort ?? 'high') === 'high',
        isolation: resolveIsolationSeed(seedOverrides, getCwd()),
        seatsMax: seedOverrides.seatsMax ?? 2,
      },
      draft,
      draftCaret,
      // The SESSION-dispatchable worker rows from the one callable-model
      // owner — the strip's model chip cycles exactly these (display ≡
      // dispatch on the arm this strip dispatches).
      modelOptions: workerRegistry.entries
        .filter(e => e.session.availability === 'available')
        .map(e => ({ modelId: e.modelId, displayName: e.displayName })),
      // The advanced affordance is REAL (title rides op.title; the advanced
      // panel shows the ratified effort/profile facts).
      advancedAvailable: true,
      ...(seedOverrides.title !== undefined ? { titleSeed: seedOverrides.title } : {}),
      ...(preflight !== undefined ? { preflight } : {}),
    },
  }
}
