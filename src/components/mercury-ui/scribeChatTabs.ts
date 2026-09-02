// ============================================================================
//  scribeChatTabs — pure classification for the WoW-style chat tabs docked to the
//  deck. Partitions the transcript by author/stream into the 4 tabs:
//    General   — both streams (everything)
//    Scribe    — the operator ↔ Scribe (the front seat) conversation
//    Implement — inbound Implementer (the executor seat) bus messages (scribe_protocol)
//    Trace     — messages carrying tool activity (tool_use / tool_result), both streams
//  Pure + defensive over the runtime message shape (the Message type is generated,
//  so we read `type` + `message.content` blocks structurally) ⇒ unit-testable under
//  `bun run`. The /chat rendering lives in screens/ChatTranscriptView.tsx (the
//  deck/ChatLine consume the same pure helpers).
// ============================================================================
import { parseScribeEnvelope, type ScribeEnvelope } from '../../utils/scribe/scribeBus.js'
import { GLYPH } from './glyphs.js'

export const SCRIBE_CHAT_TABS = ['general', 'scribe', 'implement', 'trace'] as const
export type ScribeChatTab = (typeof SCRIBE_CHAT_TABS)[number]

/** Display label for each tab (WoW channel-strip style). */
export const SCRIBE_CHAT_TAB_LABEL: Record<ScribeChatTab, string> = {
  general: 'General',
  scribe: 'Scribe',
  implement: 'Implement',
  trace: 'Trace',
}

/** The author/stream a transcript message belongs to. */
export type ScribeAuthor = 'operator' | 'scribe' | 'implement'
// (The old static SCRIBE_AUTHOR_LABEL map is deleted: it had zero consumers —
// every surface stamps nameplates through scribeStreamName(author, handle) —
// and it hardcoded one machine's operator handle as display copy.)

/**
 * The BARE nameplate name for a scribe stream (no brackets — the inline transcript
 * nameplate adds its own). The Scribe (the foreground front) is 'Mercury-Amanuensis';
 * the Implementer (the executor) is 'Mercury-Implement'; the operator is their OS handle.
 * Lets the inline transcript stamp `[Mercury-Amanuensis]` instead of a generic
 * `[Mercury]`, matching the deck chat-tabs labels.
 */
export function scribeStreamName(author: ScribeAuthor, userHandle: string): string {
  return author === 'scribe'
    ? 'Mercury-Amanuensis'
    : author === 'implement'
      ? 'Mercury-Implement'
      : userHandle
}

type LooseBlock = { type?: string; text?: string }
type LooseMsg = {
  type?: string
  // Synthetic/internal user turns (hook re-prompts, system injections) carry
  // isMeta — they are NOT real conversation and must not show as the operator.
  isMeta?: boolean
  message?: { role?: string; content?: unknown }
  content?: unknown
}

/** Synthetic/internal turns (isMeta) are excluded from the chat tabs entirely. */
export function isChatNoise(m: LooseMsg): boolean {
  return m?.isMeta === true
}

function blocks(m: LooseMsg): unknown {
  return m?.message?.content ?? m?.content
}

/** Defensively extract a message's plain text (string content OR text blocks). */
export function messageText(m: LooseMsg): string {
  const c = blocks(m)
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return (c as LooseBlock[])
      .filter(b => b && (b.type === 'text' || typeof b.text === 'string'))
      .map(b => b.text ?? '')
      .join(' ')
      .trim()
  }
  return ''
}

/** Does the message carry tool activity (tool_use / tool_result blocks)? */
export function hasToolActivity(m: LooseMsg): boolean {
  const c = blocks(m)
  if (!Array.isArray(c)) return false
  return (c as LooseBlock[]).some(b => b && (b.type === 'tool_use' || b.type === 'tool_result'))
}

/**
 * Classify a message into its author/stream. Assistant turns are the Scribe (the
 * foreground front). A user-type message is the operator UNLESS its text is an
 * inbound Implementer bus envelope (scribe_protocol from the implementer / an
 * escalate|progress), which is the Implementer's stream.
 */
// useInboxPoller XML-wraps every inbound teammate/bus message before it lands in
// the transcript: `<teammate-message teammate_id="…" …>\n<body>\n</teammate-message>`
// (constants/xml.ts TEAMMATE_MESSAGE_TAG). The body is the raw scribe envelope. We
// must unwrap before parsing — else parseScribeEnvelope JSON.parse's the wrapper,
// fails, and the Implementer's reply mislabels as the operator's own row.
const TEAMMATE_WRAP = /^<teammate-message teammate_id="([^"]*)"[^>]*>\n?([\s\S]*?)\n?<\/teammate-message>$/

/** The teammate_id of a wrapped message (the verified sender), or null. */
export function wrappedTeammateId(m: LooseMsg): string | null {
  return messageText(m).match(TEAMMATE_WRAP)?.[1] ?? null
}

/** The scribe bus envelope a message carries — unwrapping the teammate-message
 *  wrapper useInboxPoller adds — or null. */
export function scribeEnvelopeOf(m: LooseMsg): ScribeEnvelope | null {
  const raw = messageText(m)
  const wrap = raw.match(TEAMMATE_WRAP)
  return parseScribeEnvelope(wrap ? wrap[2]! : raw)
}

export function classifyAuthor(m: LooseMsg): ScribeAuthor {
  if (m?.type === 'assistant') return 'scribe'
  // The Implementer's own stream — by verified sender id (covers prose replies too)
  // OR by the inbound bus envelope kind/sender.
  if (wrappedTeammateId(m) === 'implementer') return 'implement'
  const env = scribeEnvelopeOf(m)
  // #47 /all: an operator note is the operator's voice — never the Implementer (even
  // if it somehow rode an implementer-tagged wrapper, the kind is authoritative here).
  if (env?.kind === 'note') return 'operator'
  if (env && (env.from === 'implementer' || env.kind === 'escalate' || env.kind === 'progress')) {
    return 'implement'
  }
  // The transcript format delivers tool_result blocks in USER-type turns. A turn carrying ONLY tool
  // activity (no operator prose) is the environment's reply to the Scribe's
  // tool_use — it belongs to the Scribe's working stream, not the operator.
  // Without this, mechanical tool-result rows mislabel as the operator (the human).
  if (!messageText(m) && hasToolActivity(m)) return 'scribe'
  return 'operator'
}

/** Does a message belong in the given tab? (author + tool-activity decide.) */
export function messageInTab(
  tab: ScribeChatTab,
  author: ScribeAuthor,
  hasTool: boolean,
): boolean {
  switch (tab) {
    case 'general':
      return true
    case 'scribe':
      return author === 'operator' || author === 'scribe'
    case 'implement':
      return author === 'implement'
    case 'trace':
      return hasTool
  }
}

/** Count the messages that belong in a tab (the WoW-style per-tab activity tally).
 *  Excludes synthetic/internal (isMeta) turns + empty no-tool rows, matching what
 *  rowsForTab would actually show. Pure. */
export function countForTab(messages: readonly unknown[], tab: ScribeChatTab): number {
  let n = 0
  for (const raw of messages) {
    const m = raw as LooseMsg
    if (isChatNoise(m)) continue
    const hasTool = hasToolActivity(m)
    if (!messageInTab(tab, classifyAuthor(m), hasTool)) continue
    if (!messageText(m) && !hasTool) continue
    n++
  }
  return n
}

/** A compact, classified view-row for the chat-tab panel. */
export type ScribeChatRow = { author: ScribeAuthor; text: string; hasTool: boolean }

/**
 * Build the filtered, most-recent rows for a tab from the transcript. Bounded by
 * `limit` (most recent first → returned oldest→newest for display). Pure.
 */
export function rowsForTab(
  messages: readonly unknown[],
  tab: ScribeChatTab,
  limit: number,
): ScribeChatRow[] {
  const rows: ScribeChatRow[] = []
  for (let i = messages.length - 1; i >= 0 && rows.length < limit; i--) {
    const m = messages[i] as LooseMsg
    if (isChatNoise(m)) continue // synthetic/internal (isMeta) — never in the tabs
    const author = classifyAuthor(m)
    const hasTool = hasToolActivity(m)
    if (!messageInTab(tab, author, hasTool)) continue
    // Readable text — unwrap the teammate-message wrapper + prettify envelopes so a
    // relayed Implementer turn shows prose/status, never raw <teammate-message> JSON.
    const text = rowDisplayText(m)
    // Skip empty rows (e.g. a tool-only assistant turn shows in Trace via hasTool,
    // but in Scribe/General an empty-text turn is noise) — keep if it has tool
    // activity (Trace) or non-empty text.
    if (!text && !hasTool) continue
    rows.push({ author, text, hasTool })
  }
  return rows.reverse()
}

/**
 * Human-readable text for a row: unwrap the teammate-message wrapper and render a
 * scribe bus envelope as a compact line (status / reason / task), never raw JSON
 * or the XML wrapper. Falls back to the plain message text. Pure.
 */
export function rowDisplayText(m: LooseMsg): string {
  const env = scribeEnvelopeOf(m)
  if (env) return envelopeProse(env)
  const raw = messageText(m)
  const wrap = raw.match(TEAMMATE_WRAP)
  return wrap ? wrap[2]!.trim() : raw
}

/** Render a scribe envelope as a compact human line (status / reason / task / command).
 *  The single source for both the deck ledger (rowDisplayText) and the chatroom line
 *  (prettyEnvelope). Pure. */
export function envelopeProse(env: ScribeEnvelope): string {
  if (env.kind === 'dispatch') return env.title ? `${env.title}: ${env.task}` : env.task
  if (env.kind === 'progress') return `${env.status}${env.detail ? `: ${env.detail}` : ''}`
  if (env.kind === 'escalate') return `${GLYPH.fail} ${env.reason}`
  if (env.kind === 'control') return `[${env.command}]${env.detail ? ` ${env.detail}` : ''}`
  if (env.kind === 'note') return env.text
  return ''
}

/** Prettify a RAW scribe-envelope JSON string (already unwrapped from the teammate
 *  wrapper) into the chatroom prose, or null when it isn't a scribe envelope. #47:
 *  lets the unified chatroom render the Implementer's real progress/escalate as a
 *  readable chat line instead of dropping the scribe_protocol JSON. Pure. */
export function prettyEnvelope(rawEnvelopeText: string): string | null {
  const env = parseScribeEnvelope(rawEnvelopeText)
  return env ? envelopeProse(env) : null
}

/**
 * The ChatLine author for an inbound message, from its VERIFIED teammate_id + raw
 * envelope body. The SINGLE classifier the inline chatroom ChatLine sites
 * (UserTeammateMessage) share with the deck's classifyAuthor, so the anti-fabrication
 * guard can't drift between them. The note-kind override mirrors classifyAuthor: an
 * operator `/all` note is the operator's voice — NEVER the Implementer — even if it
 * somehow rode an implementer-tagged wrapper (the envelope kind is authoritative). Else
 * the author is the verified sender id. Pure. #47.
 */
export function chatLineAuthorFor(teammateId: string, rawEnvelopeText: string): ScribeAuthor {
  if (parseScribeEnvelope(rawEnvelopeText)?.kind === 'note') return 'operator'
  if (teammateId === 'implementer') return 'implement'
  if (teammateId === 'scribe' || teammateId === 'team-lead') return 'scribe'
  return 'operator'
}

// Raw slash-command scaffolding the REPL renders as chrome, not reasoning — a
// command turn lands in the transcript as <command-name>/<command-message>/
// <command-args> (the echoed invocation) or <local-command-stdout> (its output).
// None of it is the Scribe "thinking"; the deck feed drops it.
const COMMAND_XML = /^<(local-command|command-name|command-message|command-args|command-stdout)/

/**
 * The Scribe's REASONING FEED for the deck — ONLY the Scribe's own operator-facing
 * prose, oldest→newest, bounded by `limit`. This is the "what is the Scribe saying /
 * thinking" glance, NOT the transcript (that lives in the REPL). Excludes: the
 * operator's own input turns, raw slash-command XML scaffolding, tool-only rows, and
 * bus envelopes (dispatch/progress/escalate surface in the ledger, not here). Each
 * row is whitespace-collapsed to a single line for the compact strip. Pure.
 */
export function scribeReasoningFeed(messages: readonly unknown[], limit: number): string[] {
  const out: string[] = []
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = messages[i] as LooseMsg
    if (isChatNoise(m)) continue
    // Scribe prose only — the assistant (foreground Scribe) stream, never the
    // operator's input nor a relayed Implementer envelope (classifyAuthor maps an
    // assistant turn → 'scribe'; a tool-only turn → 'scribe' but yields no text).
    if (classifyAuthor(m) !== 'scribe') continue
    // A turn that is purely a bus envelope (e.g. the Scribe's own dispatch JSON) is
    // ledger material, not feed prose — drop it so the feed stays human-readable.
    if (scribeEnvelopeOf(m)) continue
    const text = rowDisplayText(m).replace(/\s+/g, ' ').trim()
    if (!text || COMMAND_XML.test(text)) continue
    out.push(text)
  }
  return out.reverse()
}

// ── The dispatch/work LEDGER (the "separate ledger" surface) ─────────────────
// A live log of what the Scribe dispatched to the Implementer and what came back,
// derived purely from the scribe bus envelopes in the transcript: each `dispatch`
// opens an entry (keyed by request_id); a `progress` with refRequestId advances its
// status; an `escalate` flags it. Honest by construction — no work item exists
// unless a real dispatch envelope was sent.

export type ScribeLedgerStatus =
  | 'dispatched'
  | 'started'
  | 'working'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'escalated'
  | 'superseded'

export type ScribeLedgerEntry = {
  requestId: string
  title: string
  status: ScribeLedgerStatus
  detail?: string
  /** Envelope timestamps: when
   *  the dispatch was sent + the last progress/escalate touch. Absent when
   *  the envelope carried no parseable timestamp — such entries render no age
   *  rather than a fabricated one. */
  dispatchedTs?: number
  lastUpdateTs?: number
}

/** Delivery-failure signature: a dispatch NOTHING ever acknowledged (still
 *  'dispatched') older than this reads AMBER — the bus may be deaf (the
 *  ledgered chokidar subscribe-before-first-write class). A long-running
 *  'working' entry is legitimate work and is never flagged. */
export const SCRIBE_UNACKED_AMBER_MS = 90_000

export function isDispatchUnacked(e: ScribeLedgerEntry, nowMs: number): boolean {
  return (
    e.status === 'dispatched' &&
    e.dispatchedTs !== undefined &&
    nowMs - e.dispatchedTs > SCRIBE_UNACKED_AMBER_MS
  )
}

/** Build the dispatch→result ledger from the transcript (dispatch order). Pure. */
export function buildScribeLedger(messages: readonly unknown[]): ScribeLedgerEntry[] {
  const order: string[] = []
  const byId = new Map<string, ScribeLedgerEntry>()
  for (const raw of messages) {
    const env = scribeEnvelopeOf(raw as LooseMsg)
    if (!env) continue
    if (env.kind === 'dispatch') {
      // A dispatch carrying refRequestId SUPERSEDES the earlier one (scribeBus.ts:57-61):
      // close the prior entry so it stops counting as an open in-flight slot (else the
      // source one-at-a-time gate degrades to a permanent hold). 'superseded' is terminal.
      if (env.refRequestId) {
        const prev = byId.get(env.refRequestId)
        if (prev && prev.status !== 'done' && prev.status !== 'failed') prev.status = 'superseded'
      }
      if (!byId.has(env.request_id)) {
        order.push(env.request_id)
        const ts = Date.parse(env.timestamp)
        byId.set(env.request_id, {
          requestId: env.request_id,
          title: env.title || env.task,
          status: 'dispatched',
          ...(Number.isFinite(ts) ? { dispatchedTs: ts } : {}),
        })
      }
    } else if (env.kind === 'progress' && env.refRequestId) {
      const e = byId.get(env.refRequestId)
      if (e) {
        e.status = env.status
        if (env.detail) e.detail = env.detail
        const ts = Date.parse(env.timestamp)
        if (Number.isFinite(ts)) e.lastUpdateTs = ts
      }
    } else if (env.kind === 'escalate' && env.refRequestId) {
      const e = byId.get(env.refRequestId)
      if (e) {
        e.status = 'escalated'
        e.detail = env.reason
        const ts = Date.parse(env.timestamp)
        if (Number.isFinite(ts)) e.lastUpdateTs = ts
      }
    }
  }
  return order.map(id => byId.get(id)!)
}

/** Dispatch ledger counted into status buckets — the SHARED signal for dispatch
 *  back-pressure (#29: an open dispatch ⇒ the Implementer is mid-task, hold) and
 *  batching (#30: fold/supersede when the operator piles on while work is open).
 *  `open` = in-flight (anything not terminal done/failed); `working` = actively
 *  started/working. Pure (built from buildScribeLedger). */
export type ScribeDispatchCounts = { total: number; open: number; working: number; done: number }
export function countOpenDispatches(messages: readonly unknown[]): ScribeDispatchCounts {
  const ledger = buildScribeLedger(messages)
  let open = 0
  let working = 0
  let done = 0
  for (const e of ledger) {
    if (e.status === 'done') done++
    else if (e.status === 'failed' || e.status === 'superseded') continue // terminal — not open, not a held slot
    else {
      open++
      if (e.status === 'started' || e.status === 'working') working++
    }
  }
  return { total: ledger.length, open, working, done }
}

// ── #47 the deck's BATCH ledger — queued prompts grouped into category batches ──
// The operator's three-ledger deck: the TASK ledger (buildScribeLedger — what is in
// flight / done), and this BATCH ledger — the prompts the operator PILED UP that have
// NOT been dispatched yet, grouped into category batches so the Scribe can phase them
// out one batch at a time. Sourced from the COMMAND QUEUE, never the transcript.

export type ScribeBatch = { category: string; items: string[] }

/** The plain text of a queued command (string value, or the joined text of its
 *  content blocks); '' for an image-only / non-text entry. Pure + defensive. */
function queuedText(q: { value: unknown }): string {
  const v = q.value
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    return v
      .map(b =>
        b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
          ? (b as { text: string }).text
          : '',
      )
      .join(' ')
      .trim()
  }
  return ''
}

/** A cheap, deterministic category bucket for a queued task prompt — the dominant
 *  intent verb, else 'task'. Pure; this is UI grouping only (no model call). */
export function categorizeQueued(text: string): string {
  const t = text.trim().toLowerCase()
  const RULES: Array<[RegExp, string]> = [
    [/\b(fix|bug|repair|patch|broken|fails?|errors?)\b/, 'fix'],
    [/\b(add|implement|build|create|feat|feature|wire|support)\b/, 'feature'],
    [/\b(refactor|clean|rename|moves?|extract|simplify|tidy)\b/, 'refactor'],
    [/\b(tests?|testing|verify|prove|checks?|assert|cover)\b/, 'test'],
    [/\b(docs?|document|readme|comment|explain)\b/, 'docs'],
    [/\b(remove|delete|drop|prune|deprecate)\b/, 'cleanup'],
  ]
  for (const [re, cat] of RULES) if (re.test(t)) return cat
  return 'task'
}

/** Group the QUEUED command prompts into category batches (the deck BATCH ledger,
 *  #47). Slash-commands and empty / image-only entries are skipped (not batchable
 *  task intent). Order preserved within a category; categories in first-seen order.
 *  Pure — takes a structural {value} list (the useCommandQueue snapshot). */
export function buildScribeBatchLedger(queued: readonly { value: unknown }[]): ScribeBatch[] {
  const order: string[] = []
  const groups = new Map<string, string[]>()
  for (const q of queued) {
    const text = queuedText(q).trim()
    if (!text || text.startsWith('/')) continue
    const cat = categorizeQueued(text)
    if (!groups.has(cat)) {
      order.push(cat)
      groups.set(cat, [])
    }
    groups.get(cat)!.push(text)
  }
  return order.map(cat => ({ category: cat, items: groups.get(cat)! }))
}

/** #6: which OPEN ledger entries are STUCK — queued but currently UNDELIVERABLE — given
 *  the daemon's live delivery health. A dispatch held because the Implementer is mid-task
 *  is a HEALTHY hold (progress); a dispatch held because the Implementer can't RECEIVE
 *  (mid-respawn / closed pipe — roster.isWorkerDeliverable false) OR the supervisor is
 *  degraded (getSupervisorState().degraded) is STUCK and must surface distinctly, not be
 *  silently shown as "in flight". Returns the set of requestIds to flag; the deck renders
 *  those with its existing stalled affordance. Pure — takes the daemon signal explicitly;
 *  delivering:true & degraded:false ⇒ ∅ (no entry flagged ⇒ a no-op). */
export function stuckDispatchIds(
  entries: readonly ScribeLedgerEntry[],
  daemon: { delivering: boolean; degraded: boolean },
): Set<string> {
  const stuck = new Set<string>()
  if (daemon.delivering && !daemon.degraded) return stuck
  const TERMINAL: ReadonlySet<ScribeLedgerStatus> = new Set(['done', 'failed'])
  for (const e of entries) if (!TERMINAL.has(e.status)) stuck.add(e.requestId)
  return stuck
}

/** A just-landed Implementer signal that needs the Scribe's attention (#33). */
export type ScribeAttention = {
  kind: 'escalate' | 'blocked' | 'failed' | 'done' | 'none'
  detail?: string
  needsOperator?: boolean
}

/**
 * Scan the recent transcript TAIL for a just-landed Implementer signal the Scribe
 * must act on — an `escalate` (esp. needsOperator) or a `progress` whose status is
 * blocked/failed/done. Returns the MOST RECENT such signal (latest wins, so a later
 * `done` supersedes an earlier `escalate` it resolved), or {kind:'none'}. Recency-
 * bounded by `k` so it surfaces for the turn(s) right after it lands, then stops (no
 * perpetual nag — the turn-end-tied attention the operator asked for, not a blind
 * timer). Structured kind/status is the detector — zero keyword ambiguity. Pure. */
export function computeScribeAttention(messages: readonly unknown[], k = 8): ScribeAttention {
  let found: ScribeAttention = { kind: 'none' }
  for (const raw of messages.slice(-k)) {
    const env = scribeEnvelopeOf(raw as LooseMsg)
    if (!env) continue
    if (env.kind === 'escalate') {
      found = { kind: 'escalate', detail: env.reason, needsOperator: env.needsOperator }
    } else if (
      env.kind === 'progress' &&
      (env.status === 'blocked' || env.status === 'failed' || env.status === 'done')
    ) {
      found = { kind: env.status, detail: env.detail }
    }
  }
  return found
}
