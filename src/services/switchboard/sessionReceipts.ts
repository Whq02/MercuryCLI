import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { recordToEntry } from '../../fabric/entryCodec.js'
import { MAX_TRANSCRIPT_READ_BYTES } from '../../utils/sessionStorage/paths.js'
import { logForDebugging } from '../../utils/debug.js'
import { SHELL_TOOL_NAMES } from '../../utils/shell/shellToolUtils.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../tools/NotebookEditTool/constants.js'
import { AST_EDIT_TOOL_NAME } from '../../tools/AstEditTool/prompt.js'

/** One receipt entry for a session — the work's closing paper trail.
 *  This module owns derivation, the viewer and the machine floor; the
 *  contract estate writes its close-against through append.
 *  Receipts live beside the transcript and share its retention law:
 *  never auto-deleted; the operator's prune door takes them with the
 *  session's own files. */
export interface SessionReceiptEntry {
  readonly at: string
  readonly by: string
  /** 'kit-restamp' (the kit estate, daemon/sessionKit.ts): a reactivation
   *  re-stamped the session's kit from the current menu — the displaced kit
   *  rides `details.was`, history never reloaded (ledger L24(3)).
   *  'kit-refused' (sessionKitPin.ts): the runner's carried kit pin was
   *  MALFORMED — the session booted with the EMPTY kit (loads no
   *  extensions, never whole-config); the reason rides `details.reason`
   *  and the same typed line went to stderr (the lead's ruling 2).
   *  'kit-dial' (sessionKitOp.ts — the same ruling-6 widening
   *  precedent as its two siblings): the session's own /mcp or /skills dial
   *  landed through the one writer; the dials ride `details.dials`, the
   *  asker `by`.
   *  'schedule-set' (daemon/saturn.ts — SATURN, the same widening
   *  precedent): a set-schedule op landed through the one writer (add ·
   *  remove · pause · resume); the op and its facts ride `details`, the
   *  asker `by`.
   *  'schedule-fire' (saturnTicker.ts): one FIRE DECISION — fired ·
   *  fired-late (fork iv's catch-up window, lateMs in details) ·
   *  missed-expired (beyond the window; NOT fired — never silent).
   *  'schedule-held' (saturnTicker.ts): a due fire HELD, typed — the
   *  account reasons ("held: sign-in expired — /logins releases N held
   *  fires"), fork (i)'s parked-queued arm, or a refused birth admission;
   *  the replay rows its own schedule-fire when the hold lifts. */
  readonly kind: 'agent-close' | 'machine-floor' | 'contract-close' | 'kit-restamp' | 'kit-refused' | 'kit-dial' | 'schedule-set' | 'schedule-fire' | 'schedule-held'
  readonly summary: string
  readonly details?: Readonly<Record<string, unknown>>
}

function receiptsPathOf(home: string, sessionId: string): string {
  return join(home, `${sessionId}.receipts.jsonl`)
}

/** The sidecar's ONE spelling beside a transcript path — the same file
 *  receiptsPathOf names from (home, sessionId); the prune door derives its
 *  offer accounting through this, never a second spelling. */
export function receiptsPathBesideTranscript(transcriptPath: string): string {
  return transcriptPath.replace(/\.jsonl$/, '.receipts.jsonl')
}

export function appendSessionReceipt(home: string, sessionId: string, entry: SessionReceiptEntry): void {
  appendFileSync(receiptsPathOf(home, sessionId), `${JSON.stringify(entry)}\n`, 'utf8')
}

export function readSessionReceipts(home: string, sessionId: string): SessionReceiptEntry[] {
  const p = receiptsPathOf(home, sessionId)
  if (!existsSync(p)) return []
  const out: SessionReceiptEntry[] = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try {
      out.push(JSON.parse(line) as SessionReceiptEntry)
    } catch {
      // a torn tail line stays unread, never fatal — the writer is append-only
    }
  }
  return out
}

// ═══ THE MACHINE FLOOR (ledger T5–T6, approved as proposed) ═════════════════
//
// At a session's close the floor certifies ONLY what the transcript grammar
// actually carries — every number below names its construction, and nothing
// is guessed:
//   · duration        = first→last timestamp of the session's own user and
//                       assistant entries;
//   · turns           = non-meta user prompts (a user entry carrying a
//                       tool_result block is a settlement, not a prompt) and
//                       non-meta real assistant replies;
//   · tool families   = tool_use blocks on assistant entries, named by the
//                       tools' own name constants (edits = Edit/NotebookEdit/
//                       AstEdit · writes = Write · shell = Bash/PowerShell ·
//                       other = the rest);
//   · files touched   = the file_path/notebook_path INPUT of edit/write
//                       calls whose paired settlement the harness recorded
//                       as non-error (queryHelpers' own pairing discipline),
//                       bounded with an honest "+N more";
//   · checks          = settled shell commands matching a conservative
//                       check spelling, quoted VERBATIM (clipped), with
//                       ok/failed taken from the harness's own settlement
//                       verdict (BashTool commandSemantics: non-zero exit
//                       settles as an error) — the matcher can only
//                       under-report, never invent;
//   · git commits     = settled-ok shell calls whose command says
//                       `git commit` — named gitCommitCalls because that is
//                       exactly what was derived (a GitTool plan or a hook
//                       commit is not counted).
//
// Transcript lines are the durable MercuryRecord envelope OR a legacy entry
// line — the dual-read goes through the fabric's ONE codec exactly as the
// supervisor's resumeModelKeyOf and the mirror's fold read; a reducer-era
// 'tool-settlement' envelope (no entry projection yet) is read envelope-side
// so tool outcomes stay counted whichever era wrote the line. A torn tail or
// an undecodable line is counted, disclosed, never fatal; a transcript past
// the 50MB raw-read ceiling derives from its tail window and says so.

/** Which close seam wrote the floor: the settle (release/kill) or the park
 *  (the close where finish never came). */
export type SessionCloseSeam = 'settle' | 'park'

/** The floor's typed facts — the viewer's fact rows read exactly this. */
export interface MachineFloorDetails {
  closedBy: SessionCloseSeam
  firstAt?: string
  lastAt?: string
  spanMs?: number
  turns: { user: number; assistant: number }
  toolCalls: { edits: number; writes: number; shell: number; other: number; total: number }
  filesTouched: string[]
  filesTouchedMore: number
  checks: Array<{ command: string; ok: boolean }>
  checksMore: number
  gitCommitCalls: number
  /** Lines the walk could not read (torn tail, foreign or future shapes) —
   *  disclosed whenever nonzero. */
  unreadLines?: number
  /** Bytes before the tail window when the transcript exceeded the raw-read
   *  ceiling — the floor then describes the window, and says so. */
  tailBytesSkipped?: number
}

/** Narrow a receipt entry to the floor's typed details (the viewer's read). */
export function machineFloorDetailsOf(entry: SessionReceiptEntry): MachineFloorDetails | null {
  if (entry.kind !== 'machine-floor' || entry.details === undefined) return null
  const d = entry.details as Partial<MachineFloorDetails>
  if (d.turns === undefined || d.toolCalls === undefined) return null
  return d as MachineFloorDetails
}

const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([FILE_EDIT_TOOL_NAME, NOTEBOOK_EDIT_TOOL_NAME, AST_EDIT_TOOL_NAME])
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([FILE_WRITE_TOOL_NAME])
const SHELL_TOOL_NAME_SET: ReadonlySet<string> = new Set(SHELL_TOOL_NAMES)

/** Conservative check spellings — a miss under-reports (honest), a match is
 *  quoted verbatim, so the floor never claims a check the transcript does
 *  not show. */
const CHECK_COMMAND_PATTERN =
  /\b(?:typecheck|tsc|lint|eslint|verify|vitest|jest|pytest|playwright|run-all|smoke)\b|\b(?:bun|npm|pnpm|yarn|deno)\s+(?:run\s+)?tests?\b|\b(?:cargo|go)\s+test\b/i

const GIT_COMMIT_PATTERN = /\bgit\s+commit\b/

const FILES_TOUCHED_CAP = 12
const CHECKS_CAP = 8
const CHECK_COMMAND_CLIP = 160
const AGENT_CLOSE_MAX_CHARS = 2000

function clip(text: string, max: number): { text: string; clippedFromChars?: number } {
  if (text.length <= max) return { text }
  return { text: `${text.slice(0, max)}…`, clippedFromChars: text.length }
}

function fmtSpan(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

interface WalkedTranscript {
  floor: MachineFloorDetails
  finalAssistant?: { text: string; at?: string; clippedFromChars?: number }
  /** Anything conversational at all — a wordless record (the newborn class)
   *  leaves no paper trail. */
  hasConversation: boolean
}

/** Read the transcript bytes under the raw-read ceiling: the whole file, or
 *  its tail window with the skipped bytes counted (never an OOM, never a
 *  silent partial). */
function readTranscriptWindow(path: string): { text: string; tailBytesSkipped: number } {
  const size = statSync(path).size
  if (size <= MAX_TRANSCRIPT_READ_BYTES) {
    return { text: readFileSync(path, 'utf8'), tailBytesSkipped: 0 }
  }
  const from = size - MAX_TRANSCRIPT_READ_BYTES
  const fd = openSync(path, 'r')
  let raw: string
  try {
    const buf = Buffer.alloc(MAX_TRANSCRIPT_READ_BYTES)
    const n = readSync(fd, buf, 0, buf.length, from)
    raw = buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
  // Drop the window's leading partial line — its head is outside the window.
  const nl = raw.indexOf('\n')
  const dropped = nl === -1 ? raw.length : nl + 1
  return { text: raw.slice(dropped), tailBytesSkipped: from + dropped }
}

/**
 * Derive the floor from the transcript at `<home>/<sessionId>.jsonl`.
 * Returns null when no transcript exists — a session that never spoke
 * (one-door's released newborn) leaves no orphan paper trail.
 */
export function deriveSessionFloor(home: string, sessionId: string, closedBy: SessionCloseSeam): WalkedTranscript | null {
  const transcriptPath = join(home, `${sessionId}.jsonl`)
  if (!existsSync(transcriptPath)) return null
  const { text, tailBytesSkipped } = readTranscriptWindow(transcriptPath)
  const lines = text.split('\n')
  let unreadLines = 0
  let userTurns = 0
  let assistantTurns = 0
  const families = { edits: 0, writes: 0, shell: 0, other: 0 }
  /** callId → the issued call, in first-issue order. */
  const toolCalls = new Map<string, { name: string; input: unknown }>()
  /** callId → the harness's settlement verdict (true = non-error). */
  const settlements = new Map<string, boolean>()
  let firstAtMs: number | undefined
  let lastAtMs: number | undefined
  let finalAssistant: WalkedTranscript['finalAssistant']

  const noteTimestamp = (ts: unknown): void => {
    if (typeof ts !== 'string') return
    const ms = Date.parse(ts)
    if (Number.isNaN(ms)) return
    if (firstAtMs === undefined || ms < firstAtMs) firstAtMs = ms
    if (lastAtMs === undefined || ms > lastAtMs) lastAtMs = ms
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, '')
    if (line.trim().length === 0) continue
    // The torn-tail law: an in-flight append can leave a partial last line —
    // never parsed as truth, counted as unread, never fatal.
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      unreadLines++
      continue
    }
    // Dual-read through the ONE codec (the supervisor's resumeModelKeyOf
    // pattern): an envelope decodes via recordToEntry; a reducer-era
    // tool-settlement (no entry projection) is read envelope-side so its
    // outcome still counts; a legacy line already IS the entry.
    let entry: Record<string, unknown>
    if (typeof row.recordId === 'string' && row.payload !== undefined) {
      const payload = row.payload as { kind?: unknown; callId?: unknown; outcome?: unknown }
      if (payload.kind === 'tool-settlement') {
        if (typeof payload.callId === 'string') settlements.set(payload.callId, payload.outcome === 'ok')
        continue
      }
      try {
        entry = recordToEntry(row as never) as Record<string, unknown>
      } catch {
        unreadLines++
        continue
      }
    } else {
      entry = row
    }
    const type = entry.type
    if (type === 'assistant') {
      if (entry.isMeta === true || entry.isApiErrorMessage === true || entry.isVirtual === true) continue
      const content = (entry.message as { content?: unknown } | undefined)?.content
      const texts: string[] = []
      if (Array.isArray(content)) {
        for (const b of content) {
          const block = b as { type?: unknown; id?: unknown; name?: unknown; input?: unknown; text?: unknown }
          if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
            toolCalls.set(block.id, { name: block.name, input: block.input })
            if (EDIT_TOOL_NAMES.has(block.name)) families.edits++
            else if (WRITE_TOOL_NAMES.has(block.name)) families.writes++
            else if (SHELL_TOOL_NAME_SET.has(block.name)) families.shell++
            else families.other++
          } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
            texts.push(block.text)
          }
        }
      }
      assistantTurns++
      noteTimestamp(entry.timestamp)
      if (texts.length > 0) {
        const c = clip(texts.join('\n').trim(), AGENT_CLOSE_MAX_CHARS)
        finalAssistant = {
          text: c.text,
          ...(typeof entry.timestamp === 'string' ? { at: entry.timestamp } : {}),
          ...(c.clippedFromChars !== undefined ? { clippedFromChars: c.clippedFromChars } : {}),
        }
      }
      continue
    }
    if (type === 'user') {
      if (entry.isMeta === true) continue
      const content = (entry.message as { content?: unknown } | undefined)?.content
      let carriedResult = false
      if (Array.isArray(content)) {
        for (const b of content) {
          const block = b as { type?: unknown; tool_use_id?: unknown; is_error?: unknown }
          if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            carriedResult = true
            settlements.set(block.tool_use_id, block.is_error !== true)
          }
        }
      }
      if (carriedResult) {
        noteTimestamp(entry.timestamp)
        continue
      }
      if (entry.isVirtual === true || entry.isCompactSummary === true) continue
      userTurns++
      noteTimestamp(entry.timestamp)
    }
  }

  // Files and checks pair issue with settlement (the queryHelpers pairing
  // discipline): a call that errored or never settled names no file.
  const files: string[] = []
  const seenFiles = new Set<string>()
  let filesTouchedMore = 0
  const checks: MachineFloorDetails['checks'] = []
  let checksMore = 0
  let gitCommitCalls = 0
  for (const [callId, call] of toolCalls) {
    const settledOk = settlements.get(callId) === true
    if (settledOk && (EDIT_TOOL_NAMES.has(call.name) || WRITE_TOOL_NAMES.has(call.name))) {
      const input = call.input as { file_path?: unknown; notebook_path?: unknown } | undefined
      const p = typeof input?.file_path === 'string' ? input.file_path : typeof input?.notebook_path === 'string' ? input.notebook_path : undefined
      if (p !== undefined && !seenFiles.has(p)) {
        seenFiles.add(p)
        if (files.length < FILES_TOUCHED_CAP) files.push(p)
        else filesTouchedMore++
      }
    }
    if (SHELL_TOOL_NAME_SET.has(call.name) && settlements.has(callId)) {
      const command = (call.input as { command?: unknown } | undefined)?.command
      if (typeof command === 'string') {
        if (CHECK_COMMAND_PATTERN.test(command)) {
          if (checks.length < CHECKS_CAP) checks.push({ command: clip(command, CHECK_COMMAND_CLIP).text, ok: settledOk })
          else checksMore++
        }
        if (settledOk && GIT_COMMIT_PATTERN.test(command)) gitCommitCalls++
      }
    }
  }

  const total = families.edits + families.writes + families.shell + families.other
  const floor: MachineFloorDetails = {
    closedBy,
    ...(firstAtMs !== undefined ? { firstAt: new Date(firstAtMs).toISOString() } : {}),
    ...(lastAtMs !== undefined ? { lastAt: new Date(lastAtMs).toISOString() } : {}),
    ...(firstAtMs !== undefined && lastAtMs !== undefined ? { spanMs: lastAtMs - firstAtMs } : {}),
    turns: { user: userTurns, assistant: assistantTurns },
    toolCalls: { ...families, total },
    filesTouched: files,
    filesTouchedMore,
    checks,
    checksMore,
    gitCommitCalls,
    ...(unreadLines > 0 ? { unreadLines } : {}),
    ...(tailBytesSkipped > 0 ? { tailBytesSkipped } : {}),
  }
  return {
    floor,
    ...(finalAssistant !== undefined ? { finalAssistant } : {}),
    hasConversation: userTurns + assistantTurns + total > 0,
  }
}

/** The floor's one honest sentence — every number is in the details. */
export function machineFloorSummaryOf(d: MachineFloorDetails): string {
  const parts: string[] = []
  parts.push(`${d.closedBy === 'settle' ? 'settled' : 'parked'}${d.spanMs !== undefined ? ` after ${fmtSpan(d.spanMs)}` : ''}`)
  parts.push(`${d.turns.user} prompt${d.turns.user === 1 ? '' : 's'} · ${d.turns.assistant} repl${d.turns.assistant === 1 ? 'y' : 'ies'}`)
  if (d.toolCalls.total > 0) {
    const fam: string[] = []
    if (d.toolCalls.edits > 0) fam.push(`${d.toolCalls.edits} edit${d.toolCalls.edits === 1 ? '' : 's'}`)
    if (d.toolCalls.writes > 0) fam.push(`${d.toolCalls.writes} write${d.toolCalls.writes === 1 ? '' : 's'}`)
    if (d.toolCalls.shell > 0) fam.push(`${d.toolCalls.shell} shell`)
    if (d.toolCalls.other > 0) fam.push(`${d.toolCalls.other} other`)
    parts.push(`${d.toolCalls.total} tool call${d.toolCalls.total === 1 ? '' : 's'}${fam.length > 0 ? ` (${fam.join(' · ')})` : ''}`)
  }
  const nFiles = d.filesTouched.length + d.filesTouchedMore
  if (nFiles > 0) parts.push(`${nFiles} file${nFiles === 1 ? '' : 's'} touched`)
  const okChecks = d.checks.filter(c => c.ok).length
  const failedChecks = d.checks.length - okChecks
  if (d.checks.length + d.checksMore > 0) {
    parts.push(`checks: ${okChecks} ok${failedChecks > 0 ? ` · ${failedChecks} failed` : ''}${d.checksMore > 0 ? ` +${d.checksMore} more` : ''}`)
  }
  if (d.gitCommitCalls > 0) parts.push(`${d.gitCommitCalls} git commit call${d.gitCommitCalls === 1 ? '' : 's'}`)
  if (d.tailBytesSkipped !== undefined) parts.push('derived from the tail window')
  return parts.join(' · ')
}

/**
 * THE ONE CLOSE WRITER — called at exactly two seams (the settle and the
 * park stamp; each caller fires once per close episode). Appends the
 * machine floor, then the agent's own close where a real final assistant
 * message exists (honestly absent otherwise). A session with no transcript
 * or no conversation (the released-newborn class) writes nothing — no
 * orphan receipts beside no transcript. Returns the entries written; never
 * throws (the paper trail is a projection, not a gate on the close).
 */
export function writeSessionCloseReceipts(
  home: string,
  sessionId: string,
  closedBy: SessionCloseSeam,
  agentName?: string,
): number {
  try {
    const walked = deriveSessionFloor(home, sessionId, closedBy)
    if (walked === null || !walked.hasConversation) return 0
    const at = new Date().toISOString()
    appendSessionReceipt(home, sessionId, {
      at,
      by: 'daemon',
      kind: 'machine-floor',
      summary: machineFloorSummaryOf(walked.floor),
      details: walked.floor as unknown as Record<string, unknown>,
    })
    if (walked.finalAssistant === undefined) return 1
    appendSessionReceipt(home, sessionId, {
      at,
      by: agentName ?? 'session',
      kind: 'agent-close',
      summary: walked.finalAssistant.text,
      details: {
        ...(walked.finalAssistant.at !== undefined ? { messageAt: walked.finalAssistant.at } : {}),
        ...(walked.finalAssistant.clippedFromChars !== undefined
          ? { clippedFromChars: walked.finalAssistant.clippedFromChars }
          : {}),
      },
    })
    return 2
  } catch (err) {
    logForDebugging(`[receipts] close write failed for ${sessionId}: ${err}`)
    return 0
  }
}
