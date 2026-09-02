import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { asSystemPrompt } from '../utils/systemPrompt.js'
import type { Command } from '../types/command.js'
import type { ContentBlockParam } from '../types/wire.js'
import type { ToolUseContext } from '../Tool.js'
import { query } from '../query.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { getMercuryHome } from '../utils/envUtils.js'
import { binaryName } from '../utils/config/derived.js'
import { getBestModel } from '../utils/model/model.js'
import { createUserMessage } from '../utils/messages.js'
import { escapeXmlAttr } from '../utils/xml.js'
import { logError } from '../utils/log.js'
import { logForDebugging } from '../utils/debug.js'
import { getProjectsDir } from '../utils/sessionStorage/paths.js'
import { loadTranscriptFromFile } from '../utils/sessionStorage.js'
import type { LogOption } from '../types/logs.js'

// ---------------------------------------------------------------------------
// Data model (field names are contract data: persisted + re-read)
// ---------------------------------------------------------------------------

export type SessionMeta = {
  session_id: string
  project_path: string
  start_time: string
  duration_minutes: number
  user_message_count: number
  assistant_message_count: number
  tool_counts: Record<string, number>
  languages: Record<string, number>
  git_commits: number
  git_pushes: number
  input_tokens: number
  output_tokens: number
  first_prompt: string
  summary?: string
  user_interruptions: number
  user_response_times: number[]
  tool_errors: number
  tool_error_categories: Record<string, number>
  uses_task_agent: boolean
  uses_mcp: boolean
  uses_web_search: boolean
  uses_web_fetch: boolean
  lines_added: number
  lines_removed: number
  files_modified: number
  message_hours: number[]
  user_message_timestamps: string[]
}

export type SessionFacets = {
  session_id: string
  underlying_goal: string
  goal_categories: Record<string, number>
  outcome: string
  user_satisfaction_counts: Record<string, number>
  claude_helpfulness: string
  session_type: string
  friction_counts: Record<string, number>
  friction_detail: string
  primary_success: string
  brief_summary: string
  user_instructions_to_claude?: string[]
}

export type AggregatedData = {
  total_sessions: number
  total_sessions_scanned: number
  sessions_with_facets: number
  date_range: { start: string; end: string }
  total_messages: number
  total_duration_hours: number
  total_input_tokens: number
  total_output_tokens: number
  tool_counts: Record<string, number>
  languages: Record<string, number>
  git_commits: number
  git_pushes: number
  projects: Record<string, number>
  goal_categories: Record<string, number>
  outcomes: Record<string, number>
  satisfaction: Record<string, number>
  helpfulness: Record<string, number>
  session_types: Record<string, number>
  friction: Record<string, number>
  success: Record<string, number>
  session_summaries: Array<{ id: string; date: string; summary: string; goal?: string }>
  total_interruptions: number
  total_tool_errors: number
  tool_error_categories: Record<string, number>
  user_response_times: number[]
  median_response_time: number
  avg_response_time: number
  sessions_using_task_agent: number
  sessions_using_mcp: number
  sessions_using_web_search: number
  sessions_using_web_fetch: number
  total_lines_added: number
  total_lines_removed: number
  total_files_modified: number
  days_active: number
  messages_per_day: number
  message_hours: number[]
  multi_clauding: {
    overlap_events: number
    sessions_involved: number
    user_messages_during: number
  }
}

type SectionRecord = Record<string, unknown>

export type Insights = {
  project_areas?: SectionRecord
  interaction_style?: SectionRecord
  what_works?: SectionRecord
  friction_analysis?: SectionRecord
  suggestions?: SectionRecord
  on_the_horizon?: SectionRecord
  fun_ending?: SectionRecord
  at_a_glance?: SectionRecord
  // Present in the shape; nothing generates them in this build.
  product_improvements?: SectionRecord
  model_behavior_improvements?: SectionRecord
}

export type InsightsExport = {
  metadata: {
    username: string
    generated_at: string
    /** The product version that generated the export (Mercury's own export
     *  shape — no external reader consumes this file). */
    mercury_version: string
    date_range: { start: string; end: string }
    session_count: number
    remote_hosts_collected?: string[]
  }
  aggregated_data: AggregatedData
  insights: Insights
  facets_summary: {
    total: number
    goal_categories: Record<string, number>
    outcomes: Record<string, number>
    satisfaction: Record<string, number>
    friction: Record<string, number>
  }
}

// ---------------------------------------------------------------------------
// Storage (layout is contract data; the home resolves LAZILY)
// ---------------------------------------------------------------------------

function dataDir(): string {
  return join(getMercuryHome(), 'usage-data')
}
function facetsDir(): string {
  return join(dataDir(), 'facets')
}
function metaDir(): string {
  return join(dataDir(), 'session-meta')
}
function reportPath(): string {
  return join(dataDir(), 'report.html')
}

function ensureDir(path: string): void {
  try {
    mkdirSync(path, { recursive: true })
  } catch {
    // Usually exists already; failure is swallowed.
  }
}

async function writeRecord(path: string, record: unknown): Promise<void> {
  ensureDir(join(path, '..'))
  await writeFile(path, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 })
}

// ---------------------------------------------------------------------------
// Per-session statistics extraction
// ---------------------------------------------------------------------------

/** File-extension → language (contract data). */
const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.py': 'Python',
  '.rb': 'Ruby',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.md': 'Markdown',
  '.json': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.sh': 'Shell',
  '.css': 'CSS',
  '.html': 'HTML',
}

/** Interruption marker (contract data — matched against stored transcripts). */
const INTERRUPT_MARKER = '[Request interrupted by user'

/** The legacy agent tool name still counted as task-agent use (contract data). */
const LEGACY_AGENT_TOOL_NAME = 'Task'

/**
 * Error-text → category, first match wins (both the substrings and the
 * bucket labels are contract data).
 */
const ERROR_BUCKETS: Array<{ label: string; needles: string[] }> = [
  { label: 'Command Failed', needles: ['exit code'] },
  { label: 'User Rejected', needles: ['rejected', "doesn't want"] },
  { label: 'Edit Failed', needles: ['string to replace not found', 'no changes'] },
  { label: 'File Changed', needles: ['modified since read'] },
  { label: 'File Too Large', needles: ['exceeds maximum', 'too large'] },
  { label: 'File Not Found', needles: ['file not found', 'does not exist'] },
]

function categorizeToolError(content: unknown): string {
  if (typeof content !== 'string') return 'Other'
  const lowered = content.toLowerCase()
  for (const bucket of ERROR_BUCKETS) {
    if (bucket.needles.some(needle => lowered.includes(needle))) return bucket.label
  }
  return 'Other'
}

function languageForPath(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf('.')
  if (dot === -1) return undefined
  return LANGUAGE_MAP[filePath.slice(dot).toLowerCase()]
}

function countLines(text: string): number {
  return text.split('\n').length
}

/** Changed-line tally of an Edit: added and removed line counts of the two sides. */
function editLineDelta(oldString: string, newString: string): { added: number; removed: number } {
  return { removed: countLines(oldString), added: countLines(newString) }
}

/** A human message: non-empty string content, or an array with a text block. */
function isHumanUserMessage(message: { type?: string; message?: { content?: unknown } }): boolean {
  if (message.type !== 'user') return false
  const content = message.message?.content
  if (typeof content === 'string') return content.trim() !== ''
  if (Array.isArray(content)) {
    return content.some(block => (block as { type?: string }).type === 'text')
  }
  return false
}

type SessionStats = Omit<
  SessionMeta,
  | 'session_id'
  | 'project_path'
  | 'start_time'
  | 'duration_minutes'
  | 'user_message_count'
  | 'assistant_message_count'
  | 'first_prompt'
  | 'summary'
>

function extractSessionStats(messages: Array<Record<string, unknown>>): SessionStats {
  const stats: SessionStats = {
    tool_counts: {},
    languages: {},
    git_commits: 0,
    git_pushes: 0,
    input_tokens: 0,
    output_tokens: 0,
    user_interruptions: 0,
    user_response_times: [],
    tool_errors: 0,
    tool_error_categories: {},
    uses_task_agent: false,
    uses_mcp: false,
    uses_web_search: false,
    uses_web_fetch: false,
    lines_added: 0,
    lines_removed: 0,
    files_modified: 0,
    message_hours: [],
    user_message_timestamps: [],
  }
  const modifiedFiles = new Set<string>()
  let lastAssistantTimestamp: number | null = null

  for (const message of messages) {
    const type = message.type
    const timestamp = message.timestamp as string | undefined
    const body = message.message as { content?: unknown; usage?: Record<string, number> } | undefined

    if (type === 'assistant') {
      if (timestamp) lastAssistantTimestamp = Date.parse(timestamp)
      const usage = body?.usage
      if (usage) {
        stats.input_tokens += usage.input_tokens ?? 0
        stats.output_tokens += usage.output_tokens ?? 0
      }
      const content = body?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: string; name?: string; input?: Record<string, unknown> }
          if (b.type !== 'tool_use' || typeof b.name !== 'string') continue
          stats.tool_counts[b.name] = (stats.tool_counts[b.name] ?? 0) + 1
          if (b.name === AGENT_TOOL_NAME || b.name === LEGACY_AGENT_TOOL_NAME) {
            stats.uses_task_agent = true
          }
          if (b.name.startsWith('mcp__')) stats.uses_mcp = true
          // WIDENED: both search doors count as web search —
          // the field name stays for schema compatibility, not renamed.
          if (b.name === 'WebSearch' || b.name === 'ProviderSearch') stats.uses_web_search = true
          if (b.name === 'WebFetch') stats.uses_web_fetch = true
          const input = b.input ?? {}
          const filePath = input.file_path
          if (typeof filePath === 'string') {
            const language = languageForPath(filePath)
            if (language) stats.languages[language] = (stats.languages[language] ?? 0) + 1
            if (b.name === 'Edit' || b.name === 'Write') modifiedFiles.add(filePath)
          }
          if (b.name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
            const delta = editLineDelta(input.old_string, input.new_string)
            stats.lines_added += delta.added
            stats.lines_removed += delta.removed
          }
          if (b.name === 'Write' && typeof input.content === 'string') {
            stats.lines_added += countLines(input.content)
          }
          const command = input.command
          if (typeof command === 'string') {
            if (command.includes('git commit')) stats.git_commits++
            if (command.includes('git push')) stats.git_pushes++
          }
        }
      }
      continue
    }

    if (type !== 'user') continue

    // Tool results inside user messages.
    const content = body?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as { type?: string; is_error?: boolean; content?: unknown }
        if (b.type === 'tool_result' && b.is_error) {
          stats.tool_errors++
          const bucket = categorizeToolError(
            typeof b.content === 'string'
              ? b.content
              : Array.isArray(b.content)
                ? ((b.content[0] as { text?: string } | undefined)?.text ?? 0)
                : 0,
          )
          stats.tool_error_categories[bucket] = (stats.tool_error_categories[bucket] ?? 0) + 1
        }
      }
    }

    // Interruptions: at most once per message.
    const texts: string[] = []
    if (typeof content === 'string') texts.push(content)
    else if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as { type?: string; text?: string }
        if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
      }
    }
    if (texts.some(text => text.includes(INTERRUPT_MARKER))) stats.user_interruptions++

    if (!isHumanUserMessage(message as never) || !timestamp) continue
    // The try/catch is deliberate: an unparseable
    // timestamp yields NaN (kept), not a throw.
    try {
      stats.message_hours.push(new Date(timestamp).getHours())
      stats.user_message_timestamps.push(timestamp)
      if (lastAssistantTimestamp !== null) {
        const gapSeconds = (Date.parse(timestamp) - lastAssistantTimestamp) / 1000
        // Strictly between: ≤2 s is tool-result turnaround, ≥3600 s is not
        // think time.
        if (gapSeconds > 2 && gapSeconds < 3600) stats.user_response_times.push(gapSeconds)
      }
    } catch {
      // Practically unreachable.
    }
  }

  stats.files_modified = modifiedFiles.size
  return stats
}

function isValidDate(value: unknown): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function assembleMeta(log: LogOption): SessionMeta | null {
  if (!isValidDate(log.created) || !isValidDate(log.modified)) return null
  const messages = log.messages as unknown as Array<Record<string, unknown>>
  const stats = extractSessionStats(messages)
  const sessionId =
    (messages.find(m => typeof m.sessionId === 'string')?.sessionId as string | undefined) ??
    'unknown'
  return {
    session_id: sessionId,
    project_path: (log as { projectPath?: string }).projectPath ?? '',
    start_time: log.created.toISOString(),
    duration_minutes: Math.round((log.modified.getTime() - log.created.getTime()) / 60_000),
    user_message_count: messages.filter(m => isHumanUserMessage(m as never)).length,
    assistant_message_count: messages.filter(m => m.type === 'assistant').length,
    first_prompt: log.firstPrompt ?? '',
    ...(log.summary ? { summary: log.summary } : {}),
    ...stats,
  }
}

// ---------------------------------------------------------------------------
// Branch de-duplication and parallel-session detection
// ---------------------------------------------------------------------------

/**
 * One entry per session id: most human messages wins, ties broken by the
 * longer duration. (Exported for parity; the run pipeline applies the same
 * rule inline.)
 */
export function deduplicateSessionBranches<T extends { log: LogOption; meta: SessionMeta }>(
  entries: T[],
): T[] {
  const bySession = new Map<string, T>()
  for (const entry of entries) {
    const existing = bySession.get(entry.meta.session_id)
    if (
      !existing ||
      entry.meta.user_message_count > existing.meta.user_message_count ||
      (entry.meta.user_message_count === existing.meta.user_message_count &&
        entry.meta.duration_minutes > existing.meta.duration_minutes)
    ) {
      bySession.set(entry.meta.session_id, entry)
    }
  }
  return [...bySession.values()]
}

const MULTI_CLAUDE_WINDOW_MS = 30 * 60 * 1000

/**
 * A→B→A interleaving inside a sliding 30-minute window. Unparseable
 * timestamps become NaN values that stay in the list (reproduced knowingly).
 */
export function detectMultiClauding(
  sessions: Array<{ session_id: string; user_message_timestamps: string[] }>,
): { overlap_events: number; sessions_involved: number; user_messages_during: number } {
  const points: Array<{ time: number; sessionId: string; key: string }> = []
  for (const session of sessions) {
    for (const timestamp of session.user_message_timestamps) {
      try {
        points.push({
          time: Date.parse(timestamp),
          sessionId: session.session_id,
          key: `${timestamp}:${session.session_id}`,
        })
      } catch {
        // Practically unreachable.
      }
    }
  }
  points.sort((a, b) => a.time - b.time)

  const pairs = new Set<string>()
  const involved = new Set<string>()
  const during = new Set<string>()
  const window: Array<{ time: number; sessionId: string; key: string }> = []
  const lastIndexBySession = new Map<string, number>()

  for (const point of points) {
    // Retire entries older than the window from the left.
    while (window.length > 0 && point.time - window[0]!.time > MULTI_CLAUDE_WINDOW_MS) {
      const retired = window.shift()!
      for (const [sessionId, index] of lastIndexBySession) {
        if (index === 0) lastIndexBySession.delete(sessionId)
        else lastIndexBySession.set(sessionId, index - 1)
      }
      void retired
    }
    const earlierIndex = lastIndexBySession.get(point.sessionId)
    if (earlierIndex !== undefined) {
      for (let i = earlierIndex + 1; i < window.length; i++) {
        const between = window[i]!
        if (between.sessionId !== point.sessionId) {
          const pair = [point.sessionId, between.sessionId].sort().join(':')
          pairs.add(pair)
          involved.add(point.sessionId)
          involved.add(between.sessionId)
          during.add(window[earlierIndex]!.key)
          during.add(between.key)
          during.add(point.key)
          break
        }
      }
    }
    window.push(point)
    lastIndexBySession.set(point.sessionId, window.length - 1)
  }
  return {
    overlap_events: pairs.size,
    sessions_involved: involved.size,
    user_messages_during: during.size,
  }
}

// ---------------------------------------------------------------------------
// Model calls (empty system prompt · no agents/MCP · non-interactive ·
// querySource 'insights' · per-call output cap)
// ---------------------------------------------------------------------------

async function runInsightsModelCall(
  prompt: string,
  model: string,
  maxOutputTokens: number,
  context: ToolUseContext,
): Promise<string> {
  const toolUseContext: ToolUseContext = {
    ...context,
    options: {
      ...context.options,
      mainLoopModel: model,
      tools: [],
      mcpClients: [],
      agentDefinitions: { activeAgents: [] },
      isNonInteractiveSession: true,
    },
    abortController: new AbortController(),
  }
  const collected: string[] = []
  const generator = query({
    messages: [createUserMessage({ content: prompt })],
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    canUseTool: async () => ({
      behavior: 'deny',
      message: 'tools are unavailable to the insights analysis',
      decisionReason: { type: 'asyncAgent', reason: 'insights runs without tools' },
    }),
    toolUseContext,
    querySource: 'insights',
    maxOutputTokensOverride: maxOutputTokens,
  })
  for await (const yielded of generator) {
    const message = yielded as { type?: string; message?: { content?: unknown } }
    if (message.type !== 'assistant') continue
    const content = message.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const b = block as { type?: string; text?: string }
      if (b.type === 'text' && b.text) collected.push(b.text)
    }
  }
  return collected.join('')
}

/** The region from the first `{` to the last `}` — a greedy brace match. */
function extractJsonRegion(text: string): string | null {
  const match = /\{[\s\S]*\}/.exec(text)
  return match ? match[0] : null
}

// ---------------------------------------------------------------------------
// Facet extraction
// ---------------------------------------------------------------------------

const TRANSCRIPT_CHAR_LIMIT = 30_000
const CHUNK_SIZE = 25_000
const CHUNK_SUMMARY_MAX_TOKENS = 500
const EXTRACTION_MAX_TOKENS = 4096

/** Contract data: the JSON-only marker also used by meta-session detection. */
const JSON_ONLY_INSTRUCTION = 'RESPOND WITH ONLY A VALID JSON OBJECT'
const FACET_MARKER = 'record_facets'

function formatTranscriptHeader(meta: SessionMeta): string {
  return `Session ${meta.session_id.slice(0, 8)} · started ${meta.start_time} · project ${meta.project_path} · ${meta.duration_minutes} minutes`
}

function formatTranscript(log: LogOption, meta: SessionMeta): string {
  const lines: string[] = [formatTranscriptHeader(meta), '']
  for (const message of log.messages as unknown as Array<Record<string, unknown>>) {
    const type = message.type
    if (type !== 'user' && type !== 'assistant') continue
    const body = message.message as { content?: unknown } | undefined
    const content = body?.content
    if (typeof content === 'string') {
      if (type === 'user') lines.push(`user: ${content.slice(0, 500)}`)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const b = block as { type?: string; text?: string; name?: string }
      if (b.type === 'text' && typeof b.text === 'string') {
        lines.push(
          type === 'user' ? `user: ${b.text.slice(0, 500)}` : `assistant: ${b.text.slice(0, 300)}`,
        )
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        lines.push(`[tool: ${b.name}]`)
      }
    }
  }
  return lines.join('\n')
}

async function condenseLongTranscript(
  transcript: string,
  meta: SessionMeta,
  model: string,
  context: ToolUseContext,
): Promise<string> {
  if (transcript.length <= TRANSCRIPT_CHAR_LIMIT) return transcript
  const chunks: string[] = []
  for (let i = 0; i < transcript.length; i += CHUNK_SIZE) {
    chunks.push(transcript.slice(i, i + CHUNK_SIZE))
  }
  const summaries = await Promise.all(
    chunks.map(async chunk => {
      try {
        const summary = await runInsightsModelCall(
          `Summarize this portion of a coding-session transcript in 3-5 sentences. Preserve the specific details — file names, error messages, user feedback. Cover: what the user asked for, what was done (tools, files), any friction, and how it ended.\n\n${chunk}`,
          model,
          CHUNK_SUMMARY_MAX_TOKENS,
          context,
        )
        return summary.trim() || chunk.slice(0, 2000)
      } catch {
        return chunk.slice(0, 2000)
      }
    }),
  )
  return `${formatTranscriptHeader(meta)}\n[condensed from ${chunks.length} parts]\n\n${summaries.join('\n\n---\n\n')}`
}

/** Allowed enum values (contract data — stored and re-read). */
const FACET_SCHEMA = `{
  "underlying_goal": "one sentence: what the user was really trying to get done",
  "goal_categories": {"debug_investigate|implement_feature|fix_bug|write_script_tool|refactor_code|configure_system|create_pr_commit|analyze_data|understand_codebase|write_tests|write_docs|deploy_infra|warmup_minimal": "count per category the user explicitly asked for"},
  "outcome": "fully_achieved|mostly_achieved|partially_achieved|not_achieved|unclear_from_transcript",
  "user_satisfaction_counts": {"frustrated|dissatisfied|likely_satisfied|satisfied|happy|unsure": "count per explicit signal"},
  "claude_helpfulness": "unhelpful|slightly_helpful|moderately_helpful|very_helpful|essential",
  "session_type": "single_task|multi_task|iterative_refinement|exploration|quick_question",
  "friction_counts": {"misunderstood_request|wrong_approach|buggy_code|user_rejected_action|claude_got_blocked|user_stopped_early|wrong_file_or_location|excessive_changes|slow_or_verbose|tool_failed|user_unclear|external_issue": "count per incident"},
  "friction_detail": "one or two concrete sentences, or empty",
  "primary_success": "none|fast_accurate_search|correct_code_edits|good_explanations|proactive_help|multi_file_changes|handled_complexity|good_debugging",
  "brief_summary": "one sentence"
}`

function buildFacetPrompt(transcript: string): string {
  return `Read one coding-session transcript and ${FACET_MARKER} for it.

Rules that matter:
- Count goal categories ONLY for what the user explicitly asked for — never the assistant's
  autonomous exploration or self-directed work. Requests come in many phrasings ("can you",
  "please", a bare imperative); count the intent, not the wording.
- Base satisfaction ONLY on explicit user signals: enthusiasm → happy; thanks or approval →
  satisfied; continuing without complaint → likely_satisfied; asking for corrections →
  dissatisfied; expressing breakage or giving up → frustrated.
- Be specific about friction: misunderstood_request means the wrong problem was solved;
  wrong_approach means the right problem, wrong route; buggy_code means shipped code that
  did not work; user_rejected_action means the user declined a proposed action;
  excessive_changes means far more was touched than asked.
- Very short or warm-up-only sessions take the warmup_minimal category.

TRANSCRIPT:
${transcript}

${JSON_ONLY_INSTRUCTION} matching this schema:
${FACET_SCHEMA}`
}

function isValidFacets(value: unknown): value is Omit<SessionFacets, 'session_id'> {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.underlying_goal === 'string' &&
    typeof record.outcome === 'string' &&
    typeof record.brief_summary === 'string' &&
    typeof record.goal_categories === 'object' &&
    record.goal_categories !== null &&
    typeof record.user_satisfaction_counts === 'object' &&
    record.user_satisfaction_counts !== null &&
    typeof record.friction_counts === 'object' &&
    record.friction_counts !== null
  )
}

async function extractFacets(
  log: LogOption,
  meta: SessionMeta,
  model: string,
  context: ToolUseContext,
): Promise<SessionFacets | null> {
  try {
    const transcript = await condenseLongTranscript(formatTranscript(log, meta), meta, model, context)
    const response = await runInsightsModelCall(
      buildFacetPrompt(transcript),
      model,
      EXTRACTION_MAX_TOKENS,
      context,
    )
    const region = extractJsonRegion(response)
    if (!region) return null
    const parsed: unknown = JSON.parse(region)
    if (!isValidFacets(parsed)) return null
    return { ...parsed, session_id: meta.session_id }
  } catch (error) {
    logError(new Error(`facet extraction failed: ${String(error)}`))
    return null
  }
}

// Facet/meta caches. A cached facet failing validation is DELETED so the
// next run re-extracts it; a read/parse failure simply misses.
function readCachedFacets(sessionId: string): SessionFacets | null {
  const path = join(facetsDir(), `${sessionId}.json`)
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isValidFacets(parsed)) {
      try {
        unlinkSync(path)
      } catch {
        // Deletion errors ignored.
      }
      return null
    }
    return { ...parsed, session_id: sessionId }
  } catch {
    return null
  }
}

function readCachedMeta(sessionId: string): SessionMeta | null {
  try {
    return JSON.parse(readFileSync(join(metaDir(), `${sessionId}.json`), 'utf8')) as SessionMeta
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function addCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, count] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + count
  }
}

function aggregate(metas: SessionMeta[], facets: Map<string, SessionFacets>): AggregatedData {
  const data: AggregatedData = {
    total_sessions: metas.length,
    total_sessions_scanned: 0,
    sessions_with_facets: facets.size,
    date_range: { start: '', end: '' },
    total_messages: 0,
    total_duration_hours: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    tool_counts: {},
    languages: {},
    git_commits: 0,
    git_pushes: 0,
    projects: {},
    goal_categories: {},
    outcomes: {},
    satisfaction: {},
    helpfulness: {},
    session_types: {},
    friction: {},
    success: {},
    session_summaries: [],
    total_interruptions: 0,
    total_tool_errors: 0,
    tool_error_categories: {},
    user_response_times: [],
    median_response_time: 0,
    avg_response_time: 0,
    sessions_using_task_agent: 0,
    sessions_using_mcp: 0,
    sessions_using_web_search: 0,
    sessions_using_web_fetch: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    total_files_modified: 0,
    days_active: 0,
    messages_per_day: 0,
    message_hours: [],
    multi_clauding: { overlap_events: 0, sessions_involved: 0, user_messages_during: 0 },
  }

  const dates = new Set<string>()
  for (const meta of metas) {
    data.total_messages += meta.user_message_count
    data.total_duration_hours += meta.duration_minutes / 60
    data.total_input_tokens += meta.input_tokens
    data.total_output_tokens += meta.output_tokens
    addCounts(data.tool_counts, meta.tool_counts)
    addCounts(data.languages, meta.languages)
    data.git_commits += meta.git_commits
    data.git_pushes += meta.git_pushes
    if (meta.project_path) {
      data.projects[meta.project_path] = (data.projects[meta.project_path] ?? 0) + 1
    }
    data.total_interruptions += meta.user_interruptions
    data.total_tool_errors += meta.tool_errors
    addCounts(data.tool_error_categories, meta.tool_error_categories)
    data.user_response_times.push(...meta.user_response_times)
    if (meta.uses_task_agent) data.sessions_using_task_agent++
    if (meta.uses_mcp) data.sessions_using_mcp++
    if (meta.uses_web_search) data.sessions_using_web_search++
    if (meta.uses_web_fetch) data.sessions_using_web_fetch++
    data.total_lines_added += meta.lines_added
    data.total_lines_removed += meta.lines_removed
    data.total_files_modified += meta.files_modified
    data.message_hours.push(...meta.message_hours)
    const date = meta.start_time.split('T')[0]
    if (date) dates.add(date)

    const sessionFacets = facets.get(meta.session_id)
    if (sessionFacets) {
      for (const [key, count] of Object.entries(sessionFacets.goal_categories)) {
        if (count > 0) data.goal_categories[key] = (data.goal_categories[key] ?? 0) + count
      }
      for (const [key, count] of Object.entries(sessionFacets.user_satisfaction_counts)) {
        if (count > 0) data.satisfaction[key] = (data.satisfaction[key] ?? 0) + count
      }
      for (const [key, count] of Object.entries(sessionFacets.friction_counts)) {
        if (count > 0) data.friction[key] = (data.friction[key] ?? 0) + count
      }
      data.outcomes[sessionFacets.outcome] = (data.outcomes[sessionFacets.outcome] ?? 0) + 1
      data.helpfulness[sessionFacets.claude_helpfulness] =
        (data.helpfulness[sessionFacets.claude_helpfulness] ?? 0) + 1
      data.session_types[sessionFacets.session_type] =
        (data.session_types[sessionFacets.session_type] ?? 0) + 1
      if (sessionFacets.primary_success !== 'none') {
        data.success[sessionFacets.primary_success] =
          (data.success[sessionFacets.primary_success] ?? 0) + 1
      }
    }
    if (data.session_summaries.length < 50) {
      data.session_summaries.push({
        id: meta.session_id.slice(0, 8),
        date: meta.start_time.split('T')[0] ?? '',
        summary: meta.summary ?? meta.first_prompt.slice(0, 100),
        ...(sessionFacets?.underlying_goal ? { goal: sessionFacets.underlying_goal } : {}),
      })
    }
  }

  const startTimes = metas.map(meta => meta.start_time).sort()
  data.date_range = {
    start: startTimes[0]?.split('T')[0] ?? '',
    end: startTimes[startTimes.length - 1]?.split('T')[0] ?? '',
  }
  const times = [...data.user_response_times].sort((a, b) => a - b)
  data.median_response_time = times.length > 0 ? times[Math.floor(times.length / 2)]! : 0
  data.avg_response_time =
    times.length > 0 ? times.reduce((sum, value) => sum + value, 0) / times.length : 0
  data.days_active = dates.size
  data.messages_per_day =
    dates.size > 0 ? Math.round((data.total_messages / dates.size) * 10) / 10 : 0
  data.multi_clauding = detectMultiClauding(
    metas.map(meta => ({
      session_id: meta.session_id,
      user_message_timestamps: meta.user_message_timestamps,
    })),
  )
  return data
}

// ---------------------------------------------------------------------------
// Narrative generation
// ---------------------------------------------------------------------------

const SECTION_MAX_TOKENS = 8192

function topEntries(map: Record<string, number>, limit: number): Array<[string, number]> {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
}

function buildDataContext(data: AggregatedData, facets: Map<string, SessionFacets>): string {
  const summaryLines = [...facets.values()]
    .slice(0, 50)
    .map(f => `- ${f.brief_summary} (${f.outcome}, ${f.claude_helpfulness})`)
  const frictionDetails = [...facets.values()]
    .map(f => f.friction_detail)
    .filter(detail => detail && detail.trim() !== '')
    .slice(0, 20)
  const instructions = [...facets.values()]
    .flatMap(f => f.user_instructions_to_claude ?? [])
    .slice(0, 15)
  return `${JSON.stringify(
    {
      sessions: data.total_sessions,
      analysed: data.sessions_with_facets,
      date_range: data.date_range,
      messages: data.total_messages,
      hours: Math.round(data.total_duration_hours),
      commits: data.git_commits,
      top_tools: topEntries(data.tool_counts, 8),
      top_goals: topEntries(data.goal_categories, 8),
      outcomes: data.outcomes,
      satisfaction: data.satisfaction,
      friction: data.friction,
      success: data.success,
      languages: data.languages,
    },
    null,
    2,
  )}

SESSION SUMMARIES:
${summaryLines.join('\n')}

FRICTION DETAILS:
${frictionDetails.join('\n')}

USER INSTRUCTIONS:
${instructions.length > 0 ? instructions.join('\n') : '(none captured)'}`
}

/** The embedded feature reference (real launcher name, never a generic one). */
function featureReference(): string {
  const cli = binaryName()
  return `- MCP servers: register external tool servers with \`${cli} mcp add <name> <url> --transport http\`. Good for connecting databases, browsers, and internal APIs.
- Custom skills: a SKILL.md under .mercury/skills/<name>/ becomes a slash command. Good for repeatable workflows you keep re-typing.
- Hooks: lifecycle shell commands under the settings file's "hooks" key. Good for auto-formatting after edits or gating dangerous commands.
- Headless mode: \`${cli} -p "<prompt>" --allowedTools <list>\` runs one task and exits. Good for CI and scripted usage.
- Task agents: background subagents that work in parallel while you keep the main session. Good for wide searches and independent workstreams.`
}

type SectionSpec = { name: keyof Insights; prompt: string }

function sectionSpecs(): SectionSpec[] {
  return [
    {
      name: 'project_areas',
      prompt: `Identify 4-5 project areas from the data. Respond as JSON {"areas": [{"name", "session_count", "description"}]} — the description is 2-3 sentences on what was worked on and how the harness was used. Skip internal housekeeping sessions.`,
    },
    {
      name: 'interaction_style',
      prompt: `Describe HOW this user interacts, in second person: quick iteration or detailed up-front specs? Interrupting or letting runs finish? Use specific examples and **bold** the key insights. Respond as JSON {"narrative": "2-3 paragraphs", "key_pattern": "one sentence"}.`,
    },
    {
      name: 'what_works',
      prompt: `Name the user's most impressive workflows. Respond as JSON {"intro": "one sentence", "impressive_workflows": [exactly 3 of {"title": "3-6 words", "description": "2-3 sentences in second person"}]}.`,
    },
    {
      name: 'friction_analysis',
      prompt: `Analyse where sessions went wrong. Respond as JSON {"intro": "one sentence", "categories": [3 of {"name": "concrete category", "explanation": "1-2 sentences, second person, what could be done differently", "examples": [2 specific examples with their consequences]}]}.`,
    },
    {
      name: 'suggestions',
      prompt: `Suggest improvements. Respond as JSON {"claude_md_additions": [{"addition": "one line", "why": "one sentence grounded in actual sessions", "prompt_scaffold": "where to add it"}], "features_to_try": [2-3 of {"feature", "one_liner", "why_for_you", "example_code"}], "usage_patterns": [{"title", "suggestion": "1-2 sentences", "detail": "3-4 sentences", "copyable_prompt"}]}.
Two rules: instruction additions PRIORITISE things the user said in two or more sessions (they should not have to repeat themselves), and features come ONLY from this reference:
${featureReference()}`,
    },
    {
      name: 'on_the_horizon',
      prompt: `Think big: what becomes possible next for this user — autonomous workflows, parallel agents, test-driven iteration. Respond as JSON {"intro": "one sentence", "opportunities": [3 of {"title": "4-8 words", "description": "2-3 sentences on what becomes possible", "tooling": "1-2 sentences", "copyable_prompt": "a detailed prompt to start"}]}.`,
    },
    {
      name: 'fun_ending',
      prompt: `Pick ONE memorable qualitative moment from the transcripts — explicitly not a statistic. Respond as JSON {"headline": "...", "detail": "brief"}.`,
    },
  ]
}

async function generateSection(
  spec: SectionSpec,
  dataContext: string,
  model: string,
  context: ToolUseContext,
): Promise<SectionRecord | undefined> {
  try {
    const response = await runInsightsModelCall(
      `${spec.prompt}\n\nDATA:\n${dataContext}`,
      model,
      SECTION_MAX_TOKENS,
      context,
    )
    const region = extractJsonRegion(response)
    if (!region) return undefined
    return JSON.parse(region) as SectionRecord
  } catch (error) {
    logForDebugging(`insights: section ${String(spec.name)} failed: ${String(error)}`)
    return undefined
  }
}

function condenseListSection(
  section: SectionRecord | undefined,
  listKey: string,
  titleKey: string,
  textKey: string,
): string {
  const list = section?.[listKey]
  if (!Array.isArray(list)) return ''
  return list
    .map(item => {
      const record = item as Record<string, unknown>
      return `- ${String(record[titleKey] ?? '')}: ${String(record[textKey] ?? '')}`
    })
    .join('\n')
}

async function generateAtAGlance(
  insights: Insights,
  dataContext: string,
  model: string,
  context: ToolUseContext,
): Promise<SectionRecord | undefined> {
  const condensed = [
    `## project areas\n${condenseListSection(insights.project_areas, 'areas', 'name', 'description')}`,
    `## big wins\n${condenseListSection(insights.what_works, 'impressive_workflows', 'title', 'description')}`,
    `## friction\n${condenseListSection(insights.friction_analysis, 'categories', 'name', 'explanation')}`,
    `## features\n${condenseListSection(insights.suggestions, 'features_to_try', 'feature', 'why_for_you')}`,
    `## usage patterns\n${condenseListSection(insights.suggestions, 'usage_patterns', 'title', 'suggestion')}`,
    `## horizon\n${condenseListSection(insights.on_the_horizon, 'opportunities', 'title', 'description')}`,
  ].join('\n\n')
  try {
    const response = await runInsightsModelCall(
      `Write the at-a-glance summary of a usage report. Respond as JSON with four fields:
{"whats_working": "the user's distinctive style and impactful work — high level, not fluffy, not about tool calls",
 "whats_hindering": "split harness-side faults from user-side friction; honest but constructive; generalise beyond one project",
 "quick_wins": "specific features from the material — avoid weak generic advice",
 "ambitious_workflows": "what to attempt as models get stronger"}
Each part: 2-3 short sentences, coaching tone, no raw category keys, no specific numeric statistics.

DATA:
${dataContext}

SECTIONS:
${condensed}`,
      model,
      SECTION_MAX_TOKENS,
      context,
    )
    const region = extractJsonRegion(response)
    if (!region) return undefined
    return JSON.parse(region) as SectionRecord
  } catch (error) {
    logForDebugging(`insights: at_a_glance failed: ${String(error)}`)
    return undefined
  }
}

// ---------------------------------------------------------------------------
// The HTML report
// ---------------------------------------------------------------------------

/** Stored value → display label (contract data). */
const LABEL_MAP: Record<string, string> = {
  debug_investigate: 'Debug/Investigate',
  implement_feature: 'Implement Feature',
  fix_bug: 'Fix Bug',
  write_script_tool: 'Write Script/Tool',
  refactor_code: 'Refactor Code',
  configure_system: 'Configure System',
  create_pr_commit: 'Create PR/Commit',
  analyze_data: 'Analyze Data',
  understand_codebase: 'Understand Codebase',
  write_tests: 'Write Tests',
  write_docs: 'Write Docs',
  deploy_infra: 'Deploy/Infra',
  warmup_minimal: 'Cache Warmup',
  fast_accurate_search: 'Fast/Accurate Search',
  correct_code_edits: 'Correct Code Edits',
  good_explanations: 'Good Explanations',
  proactive_help: 'Proactive Help',
  multi_file_changes: 'Multi-file Changes',
  handled_complexity: 'Multi-file Changes',
  good_debugging: 'Good Debugging',
  misunderstood_request: 'Misunderstood Request',
  wrong_approach: 'Wrong Approach',
  buggy_code: 'Buggy Code',
  user_rejected_action: 'User Rejected Action',
  claude_got_blocked: 'Mercury Got Blocked',
  user_stopped_early: 'User Stopped Early',
  wrong_file_or_location: 'Wrong File/Location',
  excessive_changes: 'Excessive Changes',
  slow_or_verbose: 'Slow/Verbose',
  tool_failed: 'Tool Failed',
  user_unclear: 'User Unclear',
  external_issue: 'External Issue',
  frustrated: 'Frustrated',
  dissatisfied: 'Dissatisfied',
  likely_satisfied: 'Likely Satisfied',
  satisfied: 'Satisfied',
  happy: 'Happy',
  unsure: 'Unsure',
  neutral: 'Neutral',
  delighted: 'Delighted',
  single_task: 'Single Task',
  multi_task: 'Multi Task',
  iterative_refinement: 'Iterative Refinement',
  exploration: 'Exploration',
  quick_question: 'Quick Question',
  fully_achieved: 'Fully Achieved',
  mostly_achieved: 'Mostly Achieved',
  partially_achieved: 'Partially Achieved',
  not_achieved: 'Not Achieved',
  unclear_from_transcript: 'Unclear',
  unhelpful: 'Unhelpful',
  slightly_helpful: 'Slightly Helpful',
  moderately_helpful: 'Moderately Helpful',
  very_helpful: 'Very Helpful',
  essential: 'Essential',
}

/** Fixed render orderings (contract data). */
const SATISFACTION_ORDER = ['frustrated', 'dissatisfied', 'likely_satisfied', 'satisfied', 'happy', 'unsure']
const OUTCOME_ORDER = ['not_achieved', 'partially_achieved', 'mostly_achieved', 'fully_achieved', 'unclear_from_transcript']

/** Section anchors (contract data — the nav and the at-a-glance card link them). */
const NAV_ENTRIES: Array<{ anchor: string; label: string }> = [
  { anchor: 'section-work', label: 'What you worked on' },
  { anchor: 'section-usage', label: 'How you use it' },
  { anchor: 'section-wins', label: 'What works' },
  { anchor: 'section-friction', label: 'Friction' },
  { anchor: 'section-features', label: 'Features to try' },
  { anchor: 'section-patterns', label: 'Usage patterns' },
  { anchor: 'section-horizon', label: 'On the horizon' },
  { anchor: 'section-feedback', label: 'Team feedback' },
]

function escapeHtml(text: string): string {
  return escapeXmlAttr(text)
}

/** Escape FIRST, then convert **spans** to <strong>. */
function escapeWithBold(text: string): string {
  return escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

function paragraphs(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map(block => {
      const converted = escapeWithBold(block)
        .split('\n')
        .map(line => (line.trimStart().startsWith('- ') ? `• ${line.trimStart().slice(2)}` : line))
        .join('<br>')
      return `<p>${converted}</p>`
    })
    .join('\n')
}

function labelFor(key: string): string {
  const mapped = LABEL_MAP[key]
  if (mapped) return mapped
  return key.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase())
}

function barChart(
  values: Record<string, number>,
  color: string,
  maxItems: number = 6,
  fixedOrder?: string[],
): string {
  let entries: Array<[string, number]>
  if (fixedOrder) {
    entries = fixedOrder
      .filter(key => (values[key] ?? 0) > 0)
      .map(key => [key, values[key]!])
  } else {
    entries = topEntries(values, maxItems)
  }
  if (entries.length === 0) return '<p class="empty">no data</p>'
  const largest = Math.max(...entries.map(([, count]) => count))
  return entries
    .map(
      ([key, count]) =>
        `<div class="bar-row"><span class="bar-label">${escapeHtml(labelFor(key))}</span><div class="bar" style="width:${Math.round((count / largest) * 100)}%;background:${color}"></div><span class="bar-count">${count}</span></div>`,
    )
    .join('\n')
}

/** Response-time buckets (contract data — boundaries in seconds). */
function responseTimeHistogram(times: number[]): string {
  if (times.length === 0) return '<p class="empty">no response time data</p>'
  const buckets: Array<[string, (t: number) => boolean]> = [
    ['2-10s', t => t < 10],
    ['10-30s', t => t < 30],
    ['30s-1m', t => t < 60],
    ['1-2m', t => t < 120],
    ['2-5m', t => t < 300],
    ['5-15m', t => t < 900],
    ['>15m', () => true],
  ]
  const counts = buckets.map(() => 0)
  for (const time of times) {
    for (let i = 0; i < buckets.length; i++) {
      if (buckets[i]![1](time)) {
        counts[i]!++
        break
      }
    }
  }
  if (counts.every(count => count === 0)) return '<p class="empty">no response time data</p>'
  const largest = Math.max(...counts)
  return buckets
    .map(
      ([label], i) =>
        `<div class="bar-row"><span class="bar-label">${label}</span><div class="bar" style="width:${largest > 0 ? Math.round((counts[i]! / largest) * 100) : 0}%;background:#7aa2f7"></div><span class="bar-count">${counts[i]}</span></div>`,
    )
    .join('\n')
}

/** Time-of-day periods (contract data — ranges AND labels; the client script re-creates them). */
function timeOfDayChart(hours: number[]): string {
  if (hours.length === 0) return '<p class="empty">no time data</p>'
  const counts = new Array<number>(24).fill(0)
  for (const hour of hours) {
    if (Number.isInteger(hour) && hour >= 0 && hour < 24) counts[hour]!++
  }
  return `<div id="time-of-day-bars"></div>
<script type="application/json" id="hour-counts">${JSON.stringify(counts)}</script>
<label>Timezone: <select id="tz-select">
<option value="0" selected>Pacific</option>
<option value="3">Eastern</option>
<option value="8">UTC</option>
<option value="9">Central Europe</option>
<option value="17">East Asia</option>
<option value="custom">Custom UTC offset…</option>
</select></label><input id="tz-custom" type="number" style="display:none;width:4em">`
}

function collapsible(title: string, body: string): string {
  return `<div class="collapsible"><div class="collapsible-header">${escapeHtml(title)}</div><div class="collapsible-content">${body}</div></div>`
}

function sectionString(section: SectionRecord | undefined, key: string): string {
  const value = section?.[key]
  return typeof value === 'string' ? value : ''
}

function renderReport(data: AggregatedData, insights: Insights): string {
  const glance = insights.at_a_glance
  const suggestions = insights.suggestions
  const additions = Array.isArray(suggestions?.claude_md_additions)
    ? (suggestions.claude_md_additions as Array<Record<string, unknown>>)
    : []
  const features = Array.isArray(suggestions?.features_to_try)
    ? (suggestions.features_to_try as Array<Record<string, unknown>>)
    : []
  const patterns = Array.isArray(suggestions?.usage_patterns)
    ? (suggestions.usage_patterns as Array<Record<string, unknown>>)
    : []
  const areas = Array.isArray(insights.project_areas?.areas)
    ? (insights.project_areas.areas as Array<Record<string, unknown>>)
    : []
  const workflows = Array.isArray(insights.what_works?.impressive_workflows)
    ? (insights.what_works.impressive_workflows as Array<Record<string, unknown>>)
    : []
  const frictionCategories = Array.isArray(insights.friction_analysis?.categories)
    ? (insights.friction_analysis.categories as Array<Record<string, unknown>>)
    : []
  const opportunities = Array.isArray(insights.on_the_horizon?.opportunities)
    ? (insights.on_the_horizon.opportunities as Array<Record<string, unknown>>)
    : []

  const analysedClause =
    data.total_sessions_scanned > data.total_sessions
      ? `${data.total_sessions} sessions analysed of ${data.total_sessions_scanned} scanned`
      : `${data.total_sessions} sessions`
  const overlapPct =
    data.total_messages > 0
      ? Math.round((data.multi_clauding.user_messages_during / data.total_messages) * 100)
      : 0

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mercury usage insights</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap">
<style>
body{font-family:Inter,system-ui,sans-serif;margin:0;background:#0f1420;color:#e6e9f0;line-height:1.55}
main{max-width:960px;margin:0 auto;padding:2rem 1.5rem}
h1{margin:0 0 .25rem}
.subtitle{color:#9aa4bd;margin-bottom:1.5rem}
nav{display:flex;flex-wrap:wrap;gap:.6rem;margin:1rem 0 2rem}
nav a{color:#7aa2f7;text-decoration:none;font-size:.9rem}
section{margin:2.25rem 0}
.card{background:#171e2e;border-radius:10px;padding:1.1rem 1.25rem;margin:.8rem 0}
.stat-strip{display:flex;flex-wrap:wrap;gap:1rem}
.stat{background:#171e2e;border-radius:10px;padding:.8rem 1.1rem;min-width:8rem}
.stat b{display:block;font-size:1.35rem}
.row{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
.bar-row{display:grid;grid-template-columns:11rem 1fr 3rem;align-items:center;gap:.5rem;margin:.2rem 0}
.bar{height:.8rem;border-radius:4px;min-width:2px}
.bar-count{color:#9aa4bd;text-align:right}
.empty{color:#9aa4bd}
button.copy{background:#25314d;color:#e6e9f0;border:none;border-radius:6px;padding:.25rem .6rem;cursor:pointer}
.collapsible-header{cursor:pointer;font-weight:600;padding:.4rem 0}
.collapsible-content{display:none}
.collapsible.open .collapsible-content{display:block}
.collapsible.open .collapsible-header{color:#7aa2f7}
pre{background:#101627;padding: .7rem;border-radius:8px;overflow-x:auto;white-space:pre-wrap}
@media (max-width：700px){.row{grid-template-columns:1fr}}
</style>
</head>
<body><main>
<h1>Mercury usage insights</h1>
<p class="subtitle">${escapeHtml(analysedClause)} · ${data.total_messages} messages · ${escapeHtml(data.date_range.start)} → ${escapeHtml(data.date_range.end)}</p>
${
  glance
    ? `<div class="card" id="at-a-glance">
<h2>At a glance</h2>
<p><strong>What's working:</strong> ${escapeWithBold(sectionString(glance, 'whats_working'))} <a href="#section-wins"><em>details</em></a></p>
<p><strong>What's hindering:</strong> ${escapeWithBold(sectionString(glance, 'whats_hindering'))} <a href="#section-friction"><em>details</em></a></p>
<p><strong>Quick wins:</strong> ${escapeWithBold(sectionString(glance, 'quick_wins'))} <a href="#section-features"><em>details</em></a></p>
<p><strong>Ambitious workflows:</strong> ${escapeWithBold(sectionString(glance, 'ambitious_workflows'))} <a href="#section-horizon"><em>details</em></a></p>
</div>`
    : ''
}
<nav>${NAV_ENTRIES.map(entry => `<a href="#${entry.anchor}">${escapeHtml(entry.label)}</a>`).join('')}</nav>
<div class="stat-strip">
<div class="stat"><b>${data.total_messages}</b>messages</div>
<div class="stat"><b>+${data.total_lines_added} / -${data.total_lines_removed}</b>lines</div>
<div class="stat"><b>${data.total_files_modified}</b>files touched</div>
<div class="stat"><b>${data.days_active}</b>active days</div>
<div class="stat"><b>${data.messages_per_day}</b>messages/day</div>
</div>

<section id="section-work"><h2>What you worked on</h2>
${areas.map(area => `<div class="card"><h3>${escapeHtml(String(area.name ?? ''))} <span class="empty">~${escapeHtml(String(area.session_count ?? ''))} sessions</span></h3>${paragraphs(String(area.description ?? ''))}</div>`).join('\n')}
<div class="row">
<div class="card"><h3>Goals</h3>${barChart(data.goal_categories, '#7aa2f7')}</div>
<div class="card"><h3>Tools</h3>${barChart(data.tool_counts, '#9ece6a')}</div>
</div>
<div class="row">
<div class="card"><h3>Languages</h3>${barChart(data.languages, '#e0af68')}</div>
<div class="card"><h3>Session types</h3>${barChart(data.session_types, '#bb9af7')}</div>
</div>
</section>

<section id="section-usage"><h2>How you interact</h2>
<div class="card">${paragraphs(sectionString(insights.interaction_style, 'narrative'))}<p><em>${escapeWithBold(sectionString(insights.interaction_style, 'key_pattern'))}</em></p></div>
<div class="card"><h3>Response times</h3><p class="empty">median ${data.median_response_time.toFixed(1)}s · average ${data.avg_response_time.toFixed(1)}s</p>${responseTimeHistogram(data.user_response_times)}</div>
<div class="card"><h3>Parallel sessions</h3>${
    data.multi_clauding.overlap_events === 0
      ? '<p>No parallel usage detected — you work one session at a time.</p>'
      : `<p>${data.multi_clauding.overlap_events} overlap events · ${data.multi_clauding.sessions_involved} sessions involved · ${overlapPct}% of messages sent during overlap.</p><p class="empty">Two sessions interleaving inside a 30-minute window count as parallel work.</p>`
  }</div>
<div class="row">
<div class="card"><h3>Time of day</h3>${timeOfDayChart(data.message_hours)}</div>
<div class="card"><h3>Tool errors</h3>${
    Object.keys(data.tool_error_categories).length === 0
      ? '<p class="empty">no tool errors</p>'
      : barChart(data.tool_error_categories, '#f7768e')
  }</div>
</div>
</section>

<section id="section-wins"><h2>What works</h2>
<p>${escapeWithBold(sectionString(insights.what_works, 'intro'))}</p>
${workflows.map(w => `<div class="card"><h3>${escapeHtml(String(w.title ?? ''))}</h3>${paragraphs(String(w.description ?? ''))}</div>`).join('\n')}
<div class="row">
<div class="card"><h3>Success factors</h3>${barChart(data.success, '#9ece6a')}</div>
<div class="card"><h3>Outcomes</h3>${barChart(data.outcomes, '#7aa2f7', 6, OUTCOME_ORDER)}</div>
</div>
</section>

<section id="section-friction"><h2>Friction</h2>
<p>${escapeWithBold(sectionString(insights.friction_analysis, 'intro'))}</p>
${frictionCategories
    .map(category => {
      const examples = Array.isArray(category.examples)
        ? (category.examples as unknown[]).map(example => `<li>${escapeWithBold(String(example))}</li>`).join('')
        : ''
      return `<div class="card"><h3>${escapeHtml(String(category.name ?? ''))}</h3>${paragraphs(String(category.explanation ?? ''))}<ul>${examples}</ul></div>`
    })
    .join('\n')}
<div class="row">
<div class="card"><h3>Friction types</h3>${barChart(data.friction, '#f7768e')}</div>
<div class="card"><h3>Satisfaction</h3>${barChart(data.satisfaction, '#e0af68', 6, SATISFACTION_ORDER)}</div>
</div>
</section>

<section id="section-features"><h2>Suggestions</h2>
${
  additions.length > 0
    ? `<div class="card"><h3>Instruction-file additions</h3>
${additions
        .map(
          (addition, i) =>
            `<div class="addition"><label><input type="checkbox" class="addition-check" checked data-copy="${escapeHtml(String(addition.addition ?? ''))}"> ${escapeWithBold(String(addition.addition ?? ''))}</label><p class="empty">${escapeWithBold(String(addition.why ?? ''))} — ${escapeWithBold(String(addition.prompt_scaffold ?? 'add to the instruction file'))}</p><button class="copy" data-copy-one="${i}">copy</button></div>`,
        )
        .join('\n')}
<button class="copy" id="copy-all">Copy all checked</button><span id="copy-all-result"></span></div>`
    : ''
}
${features
    .map(
      feature =>
        `<div class="card"><h3>${escapeHtml(String(feature.feature ?? ''))}</h3><p>${escapeWithBold(String(feature.one_liner ?? ''))}</p>${paragraphs(String(feature.why_for_you ?? ''))}${feature.example_code ? `<pre>${escapeHtml(String(feature.example_code))}</pre><button class="copy" data-copy-pre>copy</button>` : ''}</div>`,
    )
    .join('\n')}
</section>

<section id="section-patterns"><h2>Usage patterns</h2>
${patterns
    .map(
      pattern =>
        `<div class="card"><h3>${escapeHtml(String(pattern.title ?? ''))}</h3><p>${escapeWithBold(String(pattern.suggestion ?? ''))}</p>${collapsible('details', paragraphs(String(pattern.detail ?? '')))}${pattern.copyable_prompt ? `<pre>${escapeHtml(String(pattern.copyable_prompt))}</pre><button class="copy" data-copy-pre>copy</button>` : ''}</div>`,
    )
    .join('\n')}
</section>

<section id="section-horizon"><h2>On the horizon</h2>
<p>${escapeWithBold(sectionString(insights.on_the_horizon, 'intro'))}</p>
${opportunities
    .map(
      opportunity =>
        `<div class="card"><h3>${escapeHtml(String(opportunity.title ?? ''))}</h3>${paragraphs(String(opportunity.description ?? ''))}<p class="empty">${escapeWithBold(String(opportunity.tooling ?? ''))}</p>${opportunity.copyable_prompt ? `<pre>${escapeHtml(String(opportunity.copyable_prompt))}</pre><button class="copy" data-copy-pre>copy</button>` : ''}</div>`,
    )
    .join('\n')}
</section>

${
  insights.fun_ending
    ? `<section><div class="card"><h2>${escapeWithBold(sectionString(insights.fun_ending, 'headline'))}</h2>${paragraphs(sectionString(insights.fun_ending, 'detail'))}</div></section>`
    : ''
}

<section id="section-feedback"></section>
</main>
<script>
(function () {
  'use strict'
  // Collapsibles start collapsed; the header toggles both classes.
  document.querySelectorAll('.collapsible-header').forEach(function (header) {
    header.addEventListener('click', function () {
      header.parentElement.classList.toggle('open')
    })
  })
  function flash(button) {
    var original = button.textContent
    button.textContent = 'copied!'
    setTimeout(function () { button.textContent = original }, 2000)
  }
  document.querySelectorAll('button[data-copy-pre]').forEach(function (button) {
    button.addEventListener('click', function () {
      var pre = button.previousElementSibling
      if (pre) navigator.clipboard.writeText(pre.textContent).then(function () { flash(button) })
    })
  })
  document.querySelectorAll('button[data-copy-one]').forEach(function (button) {
    button.addEventListener('click', function () {
      var check = button.parentElement.querySelector('.addition-check')
      if (check) navigator.clipboard.writeText(check.getAttribute('data-copy')).then(function () { flash(button) })
    })
  })
  var copyAll = document.getElementById('copy-all')
  if (copyAll) {
    copyAll.addEventListener('click', function () {
      var lines = []
      document.querySelectorAll('.addition-check').forEach(function (check) {
        if (check.checked) lines.push(check.getAttribute('data-copy'))
      })
      // Reproduced quirk (item 13): the joined copy carries a LITERAL
      // backslash-n sequence, not a line break.
      navigator.clipboard.writeText(lines.join('\\\\n')).then(function () {
        document.getElementById('copy-all-result').textContent = 'copied ' + lines.length + ' item(s)'
        flash(copyAll)
      })
    })
  }
  // Time-of-day: four fixed periods; the selector shifts hours modulo 24.
  var countsNode = document.getElementById('hour-counts')
  var bars = document.getElementById('time-of-day-bars')
  if (countsNode && bars) {
    var counts = JSON.parse(countsNode.textContent)
    var periods = [
      { label: 'Morning (6-12)', from: 6, to: 12 },
      { label: 'Afternoon (12-18)', from: 12, to: 18 },
      { label: 'Evening (18-24)', from: 18, to: 24 },
      { label: 'Night (0-6)', from: 0, to: 6 },
    ]
    function render(offset) {
      // DOM nodes, never markup assignment.
      while (bars.firstChild) bars.removeChild(bars.firstChild)
      var totals = periods.map(function () { return 0 })
      for (var hour = 0; hour < 24; hour++) {
        var shifted = ((hour + offset) % 24 + 24) % 24
        for (var p = 0; p < periods.length; p++) {
          if (shifted >= periods[p].from && shifted < periods[p].to) {
            totals[p] += counts[hour]
            break
          }
        }
      }
      var largest = Math.max.apply(null, totals.concat([1]))
      periods.forEach(function (period, p) {
        var row = document.createElement('div')
        row.className = 'bar-row'
        var label = document.createElement('span')
        label.className = 'bar-label'
        label.textContent = period.label
        var bar = document.createElement('div')
        bar.className = 'bar'
        bar.style.width = Math.round((totals[p] / largest) * 100) + '%'
        bar.style.background = '#7aa2f7'
        var count = document.createElement('span')
        count.className = 'bar-count'
        count.textContent = String(totals[p])
        row.appendChild(label)
        row.appendChild(bar)
        row.appendChild(count)
        bars.appendChild(row)
      })
    }
    render(0)
    var select = document.getElementById('tz-select')
    var custom = document.getElementById('tz-custom')
    function currentOffset() {
      if (select.value === 'custom') {
        custom.style.display = ''
        return (parseInt(custom.value, 10) || 0) + 8
      }
      custom.style.display = 'none'
      return parseInt(select.value, 10)
    }
    select.addEventListener('change', function () { render(currentOffset()) })
    custom.addEventListener('input', function () { render(currentOffset()) })
  }
})()
</script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// The run pipeline
// ---------------------------------------------------------------------------

const UNCACHED_QUEUE_CAP = 200
const EXTRACTION_QUEUE_CAP = 50
const META_LOAD_BATCH = 50
const FULL_LOAD_BATCH = 10
const EXTRACTION_CONCURRENCY = 50
const MIN_HUMAN_MESSAGES = 2
const MIN_DURATION_MINUTES = 1

type SessionFileInfo = { sessionId: string; path: string; mtimeMs: number; size: number }

/** The facet/summarisation model. */
function analysisModelSetting(): string {
  return getBestModel()
}
/** The narrative model — a distinct accessor that today returns the same model. */
function narrativeModelSetting(): string {
  return getBestModel()
}

/** Lite scan: metadata only, never parsing; a tick every tenth project dir. */
async function liteScanSessions(): Promise<SessionFileInfo[]> {
  const found: SessionFileInfo[] = []
  let projectDirs: string[]
  try {
    projectDirs = readdirSync(getProjectsDir())
  } catch {
    return []
  }
  let processed = 0
  for (const projectDir of projectDirs) {
    processed++
    if (processed % 10 === 0) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    const dirPath = join(getProjectsDir(), projectDir)
    let files: string[]
    try {
      files = readdirSync(dirPath)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(dirPath, file)
      try {
        const stats = statSync(path)
        found.push({
          sessionId: basename(file, '.jsonl'),
          path,
          mtimeMs: stats.mtimeMs,
          size: stats.size,
        })
      } catch {
        // Unreadable entries skipped.
      }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found
}

/** Meta-session detection (contract markers; STRING contents only, first 5 messages). */
function isMetaSession(log: LogOption): boolean {
  const messages = (log.messages as unknown as Array<Record<string, unknown>>).slice(0, 5)
  for (const message of messages) {
    if (message.type !== 'user') continue
    const content = (message.message as { content?: unknown } | undefined)?.content
    if (typeof content !== 'string') continue
    if (content.includes(JSON_ONLY_INSTRUCTION) || content.includes(FACET_MARKER)) return true
  }
  return false
}

async function inBatches<T, R>(
  items: T[],
  batchSize: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    results.push(...(await Promise.all(batch.map(run))))
  }
  return results
}

export type UsageReportResult = {
  insights: Insights
  reportPath: string
  data: AggregatedData
  remoteStats: undefined
  facets: Map<string, SessionFacets>
}

export async function generateUsageReport(
  context: ToolUseContext,
  options?: { collectRemote?: boolean },
): Promise<UsageReportResult> {
  // Every collector for remote statistics is absent in this build; the
  // option is threaded so the export field's SHAPE survives (item 3).
  void options?.collectRemote

  // Two separate accessors that today resolve to the same default deep model.
  const analysisModel = analysisModelSetting()
  const narrativeModel = narrativeModelSetting()

  // 1. Lite scan.
  const scanned = await liteScanSessions()

  // 2. Meta load — cached in parallel batches; the uncached queue caps at
  //    the most recent 200 (the scan is mtime-sorted).
  const metas: SessionMeta[] = []
  const logsBySession = new Map<string, LogOption>()
  const uncached: SessionFileInfo[] = []
  await inBatches(scanned, META_LOAD_BATCH, async info => {
    const cached = readCachedMeta(info.sessionId)
    if (cached) {
      metas.push(cached)
      return
    }
    if (uncached.length < UNCACHED_QUEUE_CAP) uncached.push(info)
  })

  // 3. Full load, batches of 10; failures yield no logs.
  await inBatches(uncached, FULL_LOAD_BATCH, async info => {
    try {
      const log = await loadTranscriptFromFile(info.path)
      if (isMetaSession(log)) return
      const meta = assembleMeta(log)
      if (!meta) return
      metas.push(meta)
      logsBySession.set(meta.session_id, log)
      ensureDir(metaDir())
      await writeRecord(join(metaDir(), `${meta.session_id}.json`), meta)
    } catch {
      // No log from this file.
    }
  })

  // 4. De-duplicate branches inline (same rule as the exported helper) and
  //    drop the discarded sessions' logs from the extraction pool.
  const bySession = new Map<string, SessionMeta>()
  for (const meta of metas) {
    const existing = bySession.get(meta.session_id)
    if (
      !existing ||
      meta.user_message_count > existing.user_message_count ||
      (meta.user_message_count === existing.user_message_count &&
        meta.duration_minutes > existing.duration_minutes)
    ) {
      bySession.set(meta.session_id, meta)
    }
  }
  for (const sessionId of [...logsBySession.keys()]) {
    if (!bySession.has(sessionId)) logsBySession.delete(sessionId)
  }
  const deduped = [...bySession.values()].sort((a, b) => (a.start_time < b.start_time ? 1 : -1))

  // 5. Substantive pre-filter — saves model calls.
  const substantive = deduped.filter(
    meta =>
      meta.user_message_count >= MIN_HUMAN_MESSAGES &&
      meta.duration_minutes >= MIN_DURATION_MINUTES,
  )

  // 6. Facet load/extract.
  const facets = new Map<string, SessionFacets>()
  const toExtract: SessionMeta[] = []
  for (const meta of substantive) {
    const cached = readCachedFacets(meta.session_id)
    if (cached) {
      facets.set(meta.session_id, cached)
      continue
    }
    if (logsBySession.has(meta.session_id) && toExtract.length < EXTRACTION_QUEUE_CAP) {
      toExtract.push(meta)
    }
  }
  await inBatches(toExtract, EXTRACTION_CONCURRENCY, async meta => {
    const log = logsBySession.get(meta.session_id)
    if (!log) return
    const extracted = await extractFacets(log, meta, analysisModel, context)
    if (extracted) {
      facets.set(meta.session_id, extracted)
      ensureDir(facetsDir())
      await writeRecord(join(facetsDir(), `${meta.session_id}.json`), extracted)
    }
  })

  // 7. Minimal filter: warm-up-only sessions leave the aggregate; their
  //    facets stay available to the narrative stage (unfiltered map).
  const isMinimal = (meta: SessionMeta): boolean => {
    const sessionFacets = facets.get(meta.session_id)
    if (!sessionFacets) return false
    const positive = Object.entries(sessionFacets.goal_categories).filter(([, count]) => count > 0)
    return positive.length === 1 && positive[0]![0] === 'warmup_minimal'
  }
  const finalSessions = substantive.filter(meta => !isMinimal(meta))
  const filteredFacets = new Map<string, SessionFacets>()
  for (const meta of finalSessions) {
    const sessionFacets = facets.get(meta.session_id)
    if (sessionFacets) filteredFacets.set(meta.session_id, sessionFacets)
  }

  // 8. Aggregate the filtered set; stamp the scan total.
  const data = aggregate(finalSessions, filteredFacets)
  data.total_sessions_scanned = scanned.length

  // 9. Narratives ride the UNFILTERED facet map.
  const dataContext = buildDataContext(data, facets)
  const insights: Insights = {}
  const results = await Promise.all(
    sectionSpecs().map(async spec => ({
      name: spec.name,
      value: await generateSection(spec, dataContext, narrativeModel, context),
    })),
  )
  for (const result of results) {
    if (result.value !== undefined) insights[result.name] = result.value
  }
  // at_a_glance runs SEQUENTIALLY after the seven (its prompt embeds their
  // condensed renderings; its data-context argument is deliberately empty).
  const glance = await generateAtAGlance(insights, dataContext, narrativeModel, context)
  if (glance !== undefined) insights.at_a_glance = glance

  // 10. Render + write the report.
  const html = renderReport(data, insights)
  ensureDir(dataDir())
  writeFileSync(reportPath(), html, { encoding: 'utf8', mode: 0o600 })

  return { insights, reportPath: reportPath(), data, remoteStats: undefined, facets: filteredFacets }
}

// ---------------------------------------------------------------------------
// The command's return value
// ---------------------------------------------------------------------------

function buildUserSummary(data: AggregatedData, insights: Insights, reportUrl: string): string {
  const lines: string[] = []
  lines.push('# Mercury usage insights')
  const sessionsLabel =
    data.total_sessions_scanned > data.total_sessions
      ? `${data.total_sessions_scanned} sessions total · ${data.total_sessions} analysed`
      : `${data.total_sessions} sessions`
  lines.push(
    `${sessionsLabel} · ${data.total_messages} messages · ${Math.round(data.total_duration_hours)}h · ${data.git_commits} commits`,
  )
  lines.push(`${data.date_range.start} → ${data.date_range.end}`)
  lines.push('')
  const glance = insights.at_a_glance
  if (glance) {
    const parts: Array<[string, string, string]> = [
      ['What’s working', 'whats_working', 'What works'],
      ['What’s hindering', 'whats_hindering', 'Friction'],
      ['Quick wins', 'quick_wins', 'Suggestions'],
      ['Ambitious workflows', 'ambitious_workflows', 'On the horizon'],
    ]
    for (const [label, key, sectionName] of parts) {
      const text = sectionString(glance, key)
      if (text) lines.push(`**${label}:** ${text} _(see “${sectionName}” in the report)_`, '')
    }
  } else {
    lines.push('No insights were generated for this run.')
    lines.push('')
  }
  lines.push(`Your shareable report is ready: ${reportUrl}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Structured export (exported; no consumer in this build)
// ---------------------------------------------------------------------------

export function buildExportData(
  data: AggregatedData,
  insights: Insights,
  facets: Map<string, SessionFacets>,
  remoteStats?: Array<{ host?: string }>,
): InsightsExport {
  const facetsSummary: InsightsExport['facets_summary'] = {
    total: facets.size,
    goal_categories: {},
    outcomes: {},
    satisfaction: {},
    friction: {},
  }
  for (const sessionFacets of facets.values()) {
    for (const [key, count] of Object.entries(sessionFacets.goal_categories)) {
      if (count > 0) {
        facetsSummary.goal_categories[key] = (facetsSummary.goal_categories[key] ?? 0) + count
      }
    }
    facetsSummary.outcomes[sessionFacets.outcome] =
      (facetsSummary.outcomes[sessionFacets.outcome] ?? 0) + 1
    for (const [key, count] of Object.entries(sessionFacets.user_satisfaction_counts)) {
      if (count > 0) {
        facetsSummary.satisfaction[key] = (facetsSummary.satisfaction[key] ?? 0) + count
      }
    }
    for (const [key, count] of Object.entries(sessionFacets.friction_counts)) {
      if (count > 0) facetsSummary.friction[key] = (facetsSummary.friction[key] ?? 0) + count
    }
  }
  const hosts = (remoteStats ?? [])
    .map(entry => entry.host)
    .filter((host): host is string => typeof host === 'string' && host !== '')
  return {
    metadata: {
      username: process.env.SAFEUSER || process.env.USER || 'unknown',
      generated_at: new Date().toISOString(),
      // The build-version macro may be absent in dev runs.
      mercury_version:
        (process.env.npm_package_version as string | undefined) ??
        (globalThis as { MACRO?: { VERSION?: string } }).MACRO?.VERSION ??
        'unknown',
      date_range: data.date_range,
      session_count: data.total_sessions,
      ...(hosts.length > 0 ? { remote_hosts_collected: hosts } : {}),
    },
    aggregated_data: data,
    insights,
    facets_summary: facetsSummary,
  }
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

async function getPromptForCommand(
  _args: string,
  context: ToolUseContext,
): Promise<ContentBlockParam[]> {
  const result = await generateUsageReport(context)
  // A proper file URL — string concatenation leaves native separators and
  // spaces in place, and this is the line the command exists to deliver.
  const reportUrl = pathToFileURL(result.reportPath).href
  const userSummary = buildUserSummary(result.data, result.insights, reportUrl)
  const text = `The user ran /insights, which analysed their usage and produced a report.

Full insights JSON:
${JSON.stringify(result.insights, null, 2)}

Report URL: ${reportUrl}
Report file: ${result.reportPath}
Facets directory: ${facetsDir()}

What the user sees:
${userSummary}

Output the following message verbatim, and nothing else:
---
Your usage report is ready: ${reportUrl}

Want to dig into one of the sections, or try one of the suggestions?
---`
  return [{ type: 'text', text }]
}

/** The real module's declaration — identical to the registry's lazy shim. */
const insights = {
  type: 'prompt',
  name: 'insights',
  description: 'Analyze your usage and generate a personal insights report',
  get contentLength(): number {
    return 0
  },
  progressMessage: 'analyzing your sessions',
  source: 'builtin',
  getPromptForCommand,
} satisfies Command

export default insights
