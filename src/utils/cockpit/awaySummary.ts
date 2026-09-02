import type { Message } from '../../types/message.js'
import { isMercurySubstrateProfileOn } from '../config.js'
import { isEnvTruthy } from '../envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isOperatorTurn } from '../messages/operatorTurns.js'

/**
 * Away/resume summary — "what happened while you were gone". When a session is
 * resumed (--continue/--resume), the REPL mounts with the prior transcript but
 * nothing TELLS you, at a glance, what that prior run did — you have to scroll.
 * This derives a one-line recap from the resumed messages themselves (turns +
 * files touched + top tools + how long ago it was last active) and surfaces it as
 * a resume notification, so a long autonomous run you walked away from greets you
 * with its shape instead of a wall of scrollback. The trust/orientation half of
 * "use Mercury for real autonomous work" (friction-audit spec'd follow-up).
 *
 * PURE + deterministic (nowMs is injected, not read) so the proof drives it under
 * plain `bun run`; bun:bundle/feature()-FREE for loadability. Derives ONLY from
 * the messages already in hand — no new store, no trace read, no cost-tracker
 * (which resets to the fresh process on resume and would report zeros).
 *
 * DEFAULT-ON for Mercury (substrate), opt-out MERCURY_AWAY_SUMMARY=0. OFF (
 * MERCURY_SUBSTRATE=0 with env unset, or =0) ⇒ buildAwaySummary is never called and
 * no notification is shown ⇒ byte-identical.
 */

/** Gate: stamp-only; default-ON under the substrate, explicit opt-in honored, `=0` opt-out wins. */
export function isAwaySummaryEnabled(): boolean {
  
  const flag = flagEnv('MERCURY_AWAY_SUMMARY')
  if (flag === '0' || flag?.toLowerCase() === 'false') return false
  if (isEnvTruthy(flag)) return true
  return isMercurySubstrateProfileOn()
}

/** Tools worth surfacing a per-tool count for (the work-shaped ones). */
const COUNTED_TOOLS = new Set<string>([
  'Edit',
  'Write',
  'Read',
  'Bash',
  'Grep',
  'Glob',
  'Task',
  'Agent',
  'WebFetch',
  'WebSearch',
  'ProviderSearch',
])

/** 'just now' / 'Nm ago' / 'Nh ago' / 'Nd ago'; '' on a bad gap. Exported so the
 *  ResumeRecapCard renderer formats the SAME buckets from recapMetadata's raw ms. */
export function humanGap(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  return `${d}d ago`
}

type Block = { type?: string; id?: string; name?: string; input?: unknown; text?: string }

/**
 * Resume-time SYNTHETIC messages (conversationRecovery's
 * deserializeMessagesWithInterruptDetection appends an isMeta "Continue from
 * where you left off." user + a fresh "No response requested." assistant
 * sentinel to make an interrupted transcript API-valid). They are bookkeeping,
 * not the prior run: counting them poisoned lastAssistant (the picker said
 * `✕ ended on error`, the recap card said `✓ resumed clean` — two trust
 * surfaces disagreeing about the SAME tail) and lastTs ('just now' instead of
 * the real gap). The user half is already isMeta-gated; this spots the
 * assistant sentinel by its exact one-block text.
 */
function isSyntheticResumeAssistant(m: Message): boolean {
  if (m.type !== 'assistant') return false
  const content = (m as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content === 'No response requested.'
  if (Array.isArray(content) && content.length === 1) {
    const b = content[0] as Block
    return b?.type === 'text' && b.text === 'No response requested.'
  }
  return false
}

/** Synthetic/meta messages carry FRESH timestamps — exclude them from the
 *  prior run's last-active clock. */
function isSyntheticOrMeta(m: Message): boolean {
  if (isSyntheticResumeAssistant(m)) return true
  const um = m as { isMeta?: boolean }
  return um.isMeta === true
}

function fileOf(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const o = input as Record<string, unknown>
  for (const k of ['file_path', 'notebook_path', 'path']) {
    const v = o[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

/** Structured recap — the line plus its raw ingredients, so the resume-recap
 *  transcript card can render shape counts without re-parsing the line. */
export type AwayRecap = {
  /** The one-line recap (identical to what buildAwaySummary always returned). */
  line: string
  /** True when the prior run's LAST assistant turn carried an unrecovered error. */
  endedOnError: boolean
  turns: number
  filesTouched: number
  /** Top-3 tracked tools, space-joined ('Edit×2 Bash×1'); '' when none tracked. */
  topTools: string
  /** Count of tool calls whose result carried is_error (errored, denied, or
   *  interrupted) — calls that did NOT complete. */
  toolFailures: number
  /** ms since the prior run was last active; absent when no timestamp parsed. */
  lastActiveGapMs?: number
  /** The working-tree delta the caller passed in, echoed for its metadata. */
  gitDelta?: { files: number; added: number; removed: number } | null
}

/**
 * Build the structured away/resume recap from the resumed messages, or null when
 * there is nothing worth reporting (empty / no turns and no tracked tool use).
 * nowMs is injected for deterministic testing.
 */
export function buildAwayRecap(
  messages: Message[],
  nowMs: number,
  gitDelta?: { files: number; added: number; removed: number } | null,
): AwayRecap | null {
  if (!Array.isArray(messages) || messages.length === 0) return null

  let turns = 0
  const toolCounts = new Map<string, number>()
  const files = new Set<string>()
  let lastTs = 0
  let lastAssistant: Message | null = null

  // Failed tool calls first (a pre-pass so the tool_use walk below can consult
  // it): a tool_result carrying is_error means the call did NOT complete — a
  // denied or errored Edit wrote nothing, so its file was never touched and
  // the resume cannot be reported as clean over it.
  const failedToolUseIds = new Set<string>()
  let toolFailures = 0
  for (const m of messages) {
    if (m.type !== 'user') continue
    const content = (m as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) continue
    for (const raw of content) {
      const b = raw as { type?: string; tool_use_id?: string; is_error?: boolean }
      if (b?.type !== 'tool_result' || b.is_error !== true) continue
      toolFailures++
      if (typeof b.tool_use_id === 'string' && b.tool_use_id.length > 0) {
        failedToolUseIds.add(b.tool_use_id)
      }
    }
  }

  for (const m of messages) {
    // The frame's ⤳N counter and this recap count the SAME turns — the one
    // operator-turn predicate (messages/operatorTurns).
    if (isOperatorTurn(m)) turns++

    // Resume-time synthetic sentinels are bookkeeping, not the prior run —
    // they must move neither the last-active clock nor lastAssistant (see
    // isSyntheticResumeAssistant; the trust-cockpit picker/card-disagreement
    // fix).
    if (isSyntheticOrMeta(m)) continue

    const ts = Date.parse((m as { timestamp?: string }).timestamp ?? '')
    if (Number.isFinite(ts) && ts > lastTs) lastTs = ts

    if (m.type === 'assistant') {
      lastAssistant = m
      const content = (m as { message?: { content?: unknown } }).message?.content
      if (Array.isArray(content)) {
        for (const raw of content) {
          const b = raw as Block
          if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue
          if (COUNTED_TOOLS.has(b.name)) {
            toolCounts.set(b.name, (toolCounts.get(b.name) ?? 0) + 1)
          }
          const f = fileOf(b.input)
          if (f && !(typeof b.id === 'string' && failedToolUseIds.has(b.id))) files.add(f)
        }
      }
    }
  }

  const totalToolUse = [...toolCounts.values()].reduce((a, b) => a + b, 0)
  if (turns === 0 && totalToolUse === 0) return null

  const parts: string[] = []
  parts.push(`${turns} turn${turns === 1 ? '' : 's'}`)
  if (files.size > 0) parts.push(`${files.size} file${files.size === 1 ? '' : 's'} touched`)
  if (toolFailures > 0) {
    parts.push(`${toolFailures} tool call${toolFailures === 1 ? '' : 's'} failed`)
  }
  const gap = lastTs > 0 ? humanGap(nowMs - lastTs) : ''
  if (gap) parts.push(`last active ${gap}`)

  // Working-tree state (the "did the run leave my repo dirty / committed?" signal,
  // the core question returning to a long autonomous run). Live git diff-vs-HEAD,
  // so it persists across the resume (unlike the process-reset cost-tracker).
  if (gitDelta && gitDelta.files > 0) {
    const d =
      gitDelta.added > 0 || gitDelta.removed > 0
        ? ` (+${gitDelta.added}/-${gitDelta.removed})`
        : ''
    parts.push(`${gitDelta.files} uncommitted${d}`)
  }

  // End-state: if the prior run's LAST assistant turn errored (API error / carried
  // a structured error) it didn't finish clean — surface that FIRST (the top
  // return-to-a-long-run question: did it finish or crash?). A recovered mid-run
  // error leaves a clean final turn, so this only fires on an unrecovered end.
  const le = lastAssistant as { error?: unknown; isApiErrorMessage?: boolean } | null
  const endedOnError = !!le && (le.error != null || le.isApiErrorMessage === true)
  if (endedOnError) {
    parts.unshift('prior run ended on an error')
  }

  // Top 3 tracked tools by count, descending (ties broken by name for determinism).
  const top = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([name, n]) => `${name}×${n}`)

  // Plain text (no ad-hoc glyph): notifications render as plain strings and the
  // GLYPH vocab isn't importable here without breaking this module's loadability.
  let line = `Resumed — ${parts.join(', ')}`
  if (top.length > 0) line += ` · ${top.join(' ')}`
  return {
    line,
    endedOnError,
    turns,
    filesTouched: files.size,
    topTools: top.join(' '),
    toolFailures,
    ...(lastTs > 0 ? { lastActiveGapMs: nowMs - lastTs } : {}),
    gitDelta,
  }
}

/**
 * The one-line recap only — a thin wrapper over buildAwayRecap, kept so the
 * pure proof's exact-line assertions (and any line-only caller) stay stable.
 */
export function buildAwaySummary(
  messages: Message[],
  nowMs: number,
  gitDelta?: { files: number; added: number; removed: number } | null,
): string | null {
  return buildAwayRecap(messages, nowMs, gitDelta)?.line ?? null
}
