// =============================================================================
// WorkflowTool/agentTranscriptReader.ts — bounded reader over a workflow
// agent's persisted transcript (agent-<agentId>.jsonl).
//
// The inspector's data source. A workflow run persists each agent's FULL message
// stream via runAgent → recordSidechainTranscript (sessionStorage.ts): the
// verbatim initial prompt (first user message), every assistant content block
// (text · tool_use with full input · thinking/redacted_thinking when the model
// emitted them), tool_result user entries, and per-API-turn usage. This module
// projects that stream into a BOUNDED view for the /workflows agent inspector:
//   PROMPT (verbatim, capped) → ACTIVITY (last N tool calls, joined to their
//   results) → REASONING (thinking texts, capped; honest-empty — workflow
//   subagents run with thinking disabled unless the effort opt enables it) →
//   OUTCOME (last assistant text, capped) + usage/model rollup.
// Caps are display-bounded, never
// silently lossy about COUNTS (totals always reported), honest '— none
// captured' left to the UI (empty arrays / undefined here, never fabricated).
//
// Line decoding goes through the ONE transcript fold
// (fabric/transcriptDecode): agent files are written in the vNext
// MercuryRecord envelope by default (sessionStorage/vnext, per-file,
// dual-read), and a reader that hand-parses only the legacy `{type,message}`
// shape reads a healthy vNext transcript as ZERO activity — the /workflows
// inspector's "0 of N tool calls this attempt" lying-counter incident.
// The decoder projects record lines back to the legacy entry
// shape and passes legacy lines through, so mixed files fold once.
// Bun-loadable so proof scripts can import it directly. The transcript file
// path comes from the caller (the run manifest's transcriptDir + agentId, or
// getAgentTranscriptPath live).
// =============================================================================

import { existsSync } from 'node:fs'
import { readFile, stat, open } from 'node:fs/promises'
import path from 'node:path'

import { decodeTranscriptBuffer } from '../../fabric/transcriptDecode.js'

// ── display bounds (exported for proofs + the UI's honesty notes) ────────────
export const PROMPT_CAP_CHARS = 8_000
// 16 → 40: the inspector
// now sizes its activity section to the TERMINAL — a tall window showed a
// 16-call ceiling as a void. Still bounded; the UI slices to its own height.
export const ACTIVITY_LAST_N = 40
export const ACTIVITY_INPUT_SUMMARY_CHARS = 120
export const ACTIVITY_RESULT_PREVIEW_CHARS = 200
export const REASONING_LAST_N = 8
export const REASONING_EACH_CAP_CHARS = 2_000
export const OUTCOME_CAP_CHARS = 4_000

// Full-file read ceiling; above it we read head (prompt) + tail (recent
// activity/outcome) and flag truncatedRead so the UI can say so.
export const MAX_FULL_READ_BYTES = 16 * 1024 * 1024
const HEAD_READ_BYTES = 64 * 1024
const TAIL_READ_BYTES = 2 * 1024 * 1024

export type AgentToolCallView = {
  name: string
  /** `name(firstArg…)`-style clip of the tool_use input. */
  inputSummary: string
  resultPreview?: string
  isError?: boolean
  timestamp?: string
}

export type AgentUsageRollup = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** API turns observed (unique assistant message ids). */
  apiTurns: number
}

export type AgentTranscriptView = {
  /** Verbatim initial prompt (first user message), capped. */
  prompt?: string
  promptTruncated?: boolean
  /** Last ACTIVITY_LAST_N tool calls in stream order, results joined by id. */
  toolCalls: AgentToolCallView[]
  toolCallsTotal: number
  /** thinking-block texts (last REASONING_LAST_N, each capped). */
  reasoning: string[]
  reasoningTotal: number
  /**
   * Reasoning that happened but has no readable text: redacted_thinking
   * blocks + signature-only thinking blocks (some harnesses persist the
   * signed placeholder without the text). Counted, never rendered — the UI
   * says 'N reasoning spans (text not persisted)' instead of fabricating.
   */
  unreadableReasoningTotal: number
  /** The last assistant text block, capped — the agent's outcome/answer. */
  finalText?: string
  finalTextTruncated?: boolean
  model?: string
  usage?: AgentUsageRollup
  entryCount: number
  /** File exceeded MAX_FULL_READ_BYTES — head+tail windows were read instead. */
  truncatedRead?: boolean
}

const clip = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}…`

/** `Tool(firstArg…)` — first meaningful scalar of the input, clipped. */
export function summarizeToolInput(input: unknown): string {
  if (input === null || input === undefined) return ''
  if (typeof input !== 'object') return clip(String(input), ACTIVITY_INPUT_SUMMARY_CHARS)
  const obj = input as Record<string, unknown>
  for (const key of [
    'command',
    'file_path',
    'path',
    'pattern',
    'query',
    'prompt',
    'description',
    'url',
  ]) {
    const v = obj[key]
    if (typeof v === 'string' && v.length > 0) {
      return clip(v.replace(/\s+/g, ' '), ACTIVITY_INPUT_SUMMARY_CHARS)
    }
  }
  const first = Object.values(obj).find(
    v => typeof v === 'string' && (v as string).length > 0,
  )
  if (typeof first === 'string') {
    return clip(first.replace(/\s+/g, ' '), ACTIVITY_INPUT_SUMMARY_CHARS)
  }
  try {
    return clip(JSON.stringify(obj) ?? '', ACTIVITY_INPUT_SUMMARY_CHARS)
  } catch {
    return '<unserializable input>'
  }
}

/** Flatten a tool_result content (string | block[]) to preview text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(b =>
        b && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
          ? String((b as { text?: unknown }).text ?? '')
          : '',
      )
      .join(' ')
  }
  return ''
}

type RawEntry = {
  type?: unknown
  timestamp?: unknown
  message?: {
    id?: unknown
    role?: unknown
    model?: unknown
    content?: unknown
    usage?: Record<string, unknown>
  }
}

/**
 * Read + project one agent transcript. Returns undefined when the file is
 * missing/unreadable — the UI renders an honest 'transcript not found' state.
 */
export async function readAgentTranscript(
  file: string,
): Promise<AgentTranscriptView | undefined> {
  let raw: string
  let truncatedRead = false
  try {
    const st = await stat(file)
    if (st.size <= MAX_FULL_READ_BYTES) {
      raw = await readFile(file, 'utf8')
    } else {
      truncatedRead = true
      const fh = await open(file, 'r')
      try {
        const head = Buffer.alloc(HEAD_READ_BYTES)
        const tail = Buffer.alloc(TAIL_READ_BYTES)
        await fh.read(head, 0, HEAD_READ_BYTES, 0)
        await fh.read(tail, 0, TAIL_READ_BYTES, st.size - TAIL_READ_BYTES)
        // Drop the partial line at each window's cut edge.
        const headStr = head.toString('utf8')
        const tailStr = tail.toString('utf8')
        raw = `${headStr.slice(0, headStr.lastIndexOf('\n') + 1)}${tailStr.slice(
          tailStr.indexOf('\n') + 1,
        )}`
      } finally {
        await fh.close()
      }
    }
  } catch {
    return undefined
  }

  // The ONE fold: vNext record lines project to the legacy entry shape,
  // legacy lines pass through, torn/partial lines (live tail, window cuts)
  // classify as malformed and are skipped — never fail the whole read.
  const entries = decodeTranscriptBuffer<RawEntry>(raw).entries

  let prompt: string | undefined
  let promptTruncated = false
  const toolCallsAll: AgentToolCallView[] = []
  const pendingResults = new Map<string, AgentToolCallView>()
  const reasoningAll: string[] = []
  let unreadableReasoningTotal = 0
  let finalText: string | undefined
  let model: string | undefined
  const usage: AgentUsageRollup = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    apiTurns: 0,
  }
  const seenUsageIds = new Set<string>()

  for (const e of entries) {
    const msg = e.message
    const content = msg?.content
    if (e.type === 'user') {
      if (prompt === undefined && typeof content === 'string') {
        promptTruncated = content.length > PROMPT_CAP_CHARS
        prompt = clip(content, PROMPT_CAP_CHARS)
        continue
      }
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== 'object') continue
          const block = b as Record<string, unknown>
          if (prompt === undefined && block.type === 'text') {
            const t = String(block.text ?? '')
            promptTruncated = t.length > PROMPT_CAP_CHARS
            prompt = clip(t, PROMPT_CAP_CHARS)
          }
          if (block.type === 'tool_result') {
            const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
            const call = pendingResults.get(id)
            if (call) {
              call.resultPreview = clip(
                toolResultText(block.content).replace(/\s+/g, ' ').trim(),
                ACTIVITY_RESULT_PREVIEW_CHARS,
              )
              call.isError = block.is_error === true
              pendingResults.delete(id)
            }
          }
        }
      }
      continue
    }
    if (e.type !== 'assistant') continue

    if (typeof msg?.model === 'string') model = msg.model
    const mid = typeof msg?.id === 'string' ? msg.id : undefined
    const u = msg?.usage
    if (u && (mid === undefined || !seenUsageIds.has(mid))) {
      if (mid !== undefined) seenUsageIds.add(mid)
      usage.apiTurns += 1
      const n = (v: unknown): number => (typeof v === 'number' ? v : 0)
      usage.inputTokens += n(u.input_tokens)
      usage.outputTokens += n(u.output_tokens)
      usage.cacheReadTokens += n(u.cache_read_input_tokens)
      usage.cacheCreationTokens += n(u.cache_creation_input_tokens)
    }
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (!b || typeof b !== 'object') continue
      const block = b as Record<string, unknown>
      if (block.type === 'tool_use') {
        const call: AgentToolCallView = {
          name: String(block.name ?? '?'),
          inputSummary: summarizeToolInput(block.input),
          timestamp: typeof e.timestamp === 'string' ? e.timestamp : undefined,
        }
        toolCallsAll.push(call)
        if (typeof block.id === 'string') pendingResults.set(block.id, call)
      } else if (block.type === 'thinking') {
        const t = String(block.thinking ?? '')
        if (t.length > 0) reasoningAll.push(clip(t, REASONING_EACH_CAP_CHARS))
        else unreadableReasoningTotal += 1
      } else if (block.type === 'redacted_thinking') {
        unreadableReasoningTotal += 1
      } else if (block.type === 'text') {
        const t = String(block.text ?? '')
        if (t.trim().length > 0) finalText = t
      }
    }
  }

  return {
    prompt,
    promptTruncated: promptTruncated || undefined,
    toolCalls: toolCallsAll.slice(-ACTIVITY_LAST_N),
    toolCallsTotal: toolCallsAll.length,
    reasoning: reasoningAll.slice(-REASONING_LAST_N),
    reasoningTotal: reasoningAll.length,
    unreadableReasoningTotal,
    finalText: finalText === undefined ? undefined : clip(finalText, OUTCOME_CAP_CHARS),
    finalTextTruncated:
      finalText !== undefined && finalText.length > OUTCOME_CAP_CHARS
        ? true
        : undefined,
    model,
    usage: usage.apiTurns > 0 ? usage : undefined,
    entryCount: entries.length,
    truncatedRead: truncatedRead || undefined,
  }
}

/** Path helper: the transcript file for one agent inside a run's transcriptDir. */
export function agentTranscriptFile(
  transcriptDir: string,
  agentId: string,
): string {
  return path.join(transcriptDir, `agent-${agentId}.jsonl`)
}

/**
 * Resolve an agent's transcript across EVERY destination the run has written
 * under: /clear or a cross-session resume moves the live
 * destination, and the manifest's append-only transcriptDirs list preserves
 * the older ones. Returns the first EXISTING candidate, else the primary
 * path (so a missing-state message still names the expected location).
 */
export function resolveAgentTranscriptFile(
  dirs: readonly (string | undefined)[],
  agentId: string,
): string | undefined {
  let primary: string | undefined
  for (const d of dirs) {
    if (!d) continue
    const p = agentTranscriptFile(d, agentId)
    primary ??= p
    try {
      if (existsSync(p)) return p
    } catch {
      /* unreadable candidate — try the next */
    }
  }
  return primary
}

/** Sidecar metadata (agentType/worktreePath/description); undefined if absent. */
export async function readAgentMeta(
  transcriptDir: string,
  agentId: string,
): Promise<
  { agentType?: string; worktreePath?: string; description?: string } | undefined
> {
  try {
    const raw = await readFile(
      path.join(transcriptDir, `agent-${agentId}.meta.json`),
      'utf8',
    )
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      agentType:
        typeof parsed.agentType === 'string' ? parsed.agentType : undefined,
      worktreePath:
        typeof parsed.worktreePath === 'string' ? parsed.worktreePath : undefined,
      description:
        typeof parsed.description === 'string' ? parsed.description : undefined,
    }
  } catch {
    return undefined
  }
}
