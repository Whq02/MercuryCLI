import * as React from 'react'
import { Box, Text } from '../ink.js'
import { getTotalLinesAdded, getTotalLinesRemoved } from '../cost-tracker.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import { ValueGlow } from './mercury-ui/LiveGlyphs.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import { GLOB_TOOL_NAME } from '../tools/GlobTool/prompt.js'
import { PROVIDER_SEARCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from '../tools/WebSearchTool/prompt.js'
import type { Message } from '../types/message.js'
import type { Tools } from '../Tool.js'
import type { ModelName } from '../utils/model/model.js'
import type { StreamingThinking } from '../utils/messages.js'

// ============================================================================
//  MercuryTurnRollup — the Mercury transcript's session roll-up spine + the
//  present-continuous thinking lede, one component injected once into the REPL
//  bottom slot directly beneath MercuryFrame.
//
//  HONEST DATA ONLY. Every segment self-omits when its datum isn't truthfully
//  available; the component returns null rather than ever rendering an empty
//  row or a faked figure. There is NO token count (StreamingThinking carries
//  none — the /chat specimen's "608.5k tokens" is a fixture, not state), NO
//  "tests green", NO per-tool duration (renderToolResultMessage gets none).
//
//  - Spine: files changed (Edit/Write tool_use with a file_path), +/- lines
//    (session-cumulative via cost-tracker), and a session tool count.
//  - Lede: only while real thinking is streaming (isLoading && streamingThinking
//    .isStreaming); a live stopwatch from when streaming began, present tense.
//    Past form ("thought for Ns") only renders if we actually stamped a start.
//
//  (Unconditional.)
// ============================================================================

type Props = {
  messages: Message[]
  tools: Tools
  model: ModelName
  isLoading: boolean
  streamingThinking: StreamingThinking | null
  /** Live present-continuous thinking signal. The HONEST source is the REPL's
   *  streamMode === 'thinking' (set on the thinking content_block_start, the
   *  same signal Spinner.tsx consumes). The legacy streamingThinking.isStreaming
   *  gate is dead (never set true in src/), so the lede is driven off this. */
  isThinking?: boolean
}

function MercuryTurnRollupInner({
  messages,
  model,
  isLoading,
  streamingThinking,
  isThinking: isThinkingProp,
}: Props): React.ReactNode {
  const tokens = useMercuryTokens()

  // ---- Thinking lede: REMOVED. It rendered a second "∴ thinking (Ns)" line that
  // (1) DUPLICATED the Spinner's live thinking indicator ("<verb>… (Ns · thinking)"),
  // and (2) ran a stopwatch (startRef) that was stamped on the first thinking block
  // but never reset between bursts — so it showed cumulative seconds since the FIRST
  // think of the session (e.g. "1707s"), raw, never formatted to minutes. The Spinner
  // (SpinnerAnimationRow, formatDuration, resets per burst) is the single canonical
  // thinking display. This component now renders only the honest turn-rollup spine.
  const ledeNode: React.ReactNode = null
  void isThinkingProp
  void streamingThinking
  void isLoading

  // ---- Spine: honest session roll-up ----
  // Line totals are session-cumulative (cost-tracker). Degrade to omission if
  // the getters throw — mirror the snapshot bridge's 'unavailable' policy.
  let added = 0
  let removed = 0
  let linesOk = false
  try {
    added = getTotalLinesAdded()
    removed = getTotalLinesRemoved()
    linesOk = true
  } catch {
    linesOk = false
  }

  // Files + tool count from the live message stream (canonical query.ts pattern:
  // iterate assistant content, narrow tool_use). Only Edit/Write carry a
  // file_path in Mercury (no MultiEdit). MEMOIZED on `messages` — this walk is
  // O(msgs×blocks) and the component lives in the hot REPL bottom slot, so it must
  // not re-run on every unrelated render (spinner tick, cost update). The early
  // gate above is process-constant (folds at build), so hook order is stable.
  const { fileCount, toolCount, typeBreakdown } = React.useMemo(() => {
    let toolCount = 0
    const fileSet = new Set<string>()
    // Per-tool-TYPE tally — honest counts of tool_use blocks by name. Used for a
    // compact "N read · M edit · K search" breakdown. Each bucket is a real count
    // of tool_use blocks in the live stream; absent buckets render nothing.
    let readCount = 0
    let editCount = 0
    let bashCount = 0
    let searchCount = 0
    // HONESTY (round-3 study): an ENOENT-failed Edit was counted as a
    // "file changed". Collect the errored tool_use ids from the paired
    // tool_result rows so a failed edit never enters the file set (the
    // sibling turnReceipt derives from RESULT rows for the same reason).
    // extends the same law to truthful no-change results — an
    // edit/write whose result carried the noChange marker changed nothing.
    const erroredIds = new Set<string>()
    const noChangeIds = new Set<string>()
    for (const m of messages) {
      if (m.type !== 'user') continue
      const content = m.message?.content
      if (!Array.isArray(content)) continue
      const tur = (m as { toolUseResult?: { noChange?: unknown; type?: unknown } })
        .toolUseResult
      const isNoChange =
        tur !== undefined && (tur.noChange !== undefined || tur.type === 'no-change')
      for (const block of content) {
        if (
          (block as { type?: string })?.type !== 'tool_result' ||
          typeof (block as { tool_use_id?: unknown }).tool_use_id !== 'string'
        )
          continue
        const id = (block as { tool_use_id: string }).tool_use_id
        if ((block as { is_error?: boolean }).is_error === true) erroredIds.add(id)
        else if (isNoChange) noChangeIds.add(id)
      }
    }
    for (const m of messages) {
      if (m.type !== 'assistant') continue
      const content = m.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block?.type !== 'tool_use') continue
        toolCount++
        switch (block.name) {
          case FILE_READ_TOOL_NAME:
            readCount++
            break
          case FILE_EDIT_TOOL_NAME:
          case FILE_WRITE_TOOL_NAME: {
            editCount++
            const fp = (block.input as { file_path?: unknown } | undefined)
              ?.file_path
            // A failed or no-change edit changed nothing — keep it out of
            // the file tally.
            const blockId = (block as { id?: string }).id ?? ''
            if (
              typeof fp === 'string' &&
              !erroredIds.has(blockId) &&
              !noChangeIds.has(blockId)
            )
              fileSet.add(fp)
            break
          }
          case BASH_TOOL_NAME:
            bashCount++
            break
          case GREP_TOOL_NAME:
          case GLOB_TOOL_NAME:
          case WEB_SEARCH_TOOL_NAME:
          case PROVIDER_SEARCH_TOOL_NAME:
            searchCount++
            break
          default:
            break
        }
      }
    }

    // Build the compact type breakdown from the honest buckets (omit zeros).
    const typeParts: string[] = []
    if (readCount > 0) typeParts.push(`${readCount} read`)
    if (editCount > 0) typeParts.push(`${editCount} edit`)
    if (bashCount > 0) typeParts.push(`${bashCount} run`)
    if (searchCount > 0) typeParts.push(`${searchCount} search`)
    // Only show the breakdown when it adds information (≥2 distinct types).
    const typeBreakdown = typeParts.length >= 2 ? typeParts.join(' · ') : null
    return { fileCount: fileSet.size, toolCount, typeBreakdown }
  }, [messages])

  const hasFiles = fileCount > 0
  const hasLines = linesOk && (added > 0 || removed > 0)
  const hasTools = toolCount > 0
  const showSpine = hasFiles || hasLines || hasTools

  let spineNode: React.ReactNode = null
  if (showSpine) {
    const segs: React.ReactNode[] = []
    // Scope cue LEADS the spine (product-study r2: the old trailing '· session'
    // read as a truncated sentence). Every segment below is session-cumulative
    // (the full messages walk + cost-tracker totals), so one front label scopes
    // them all in the strip's 'label value' grammar.
    segs.push(<Text key="scope" color={tokens.textMuted}>session</Text>)
    if (hasFiles) {
      // ValueGlow (LiveGlyphs): the work-landed tallies flash awake as they
      // change — the change-acknowledgment tier of the one liveness grammar.
      // The tool-count segment below stays quiet (it ticks on EVERY call; a
      // meta line glowing constantly would be noise, not signal).
      if (segs.length > 0) segs.push(<Text key="s0" color={tokens.textMuted}> · </Text>)
      segs.push(
        <Text key="files">
          <Text color={tokens.success}>{GLYPH.ok} </Text>
          <ValueGlow value={fileCount} color={tokens.textPrimary}>
            {fileCount} file{fileCount === 1 ? '' : 's'} changed
          </ValueGlow>
        </Text>,
      )
    }
    if (hasLines) {
      if (segs.length > 0) segs.push(<Text key="s1" color={tokens.textMuted}> · </Text>)
      segs.push(
        <Text key="lines">
          <ValueGlow value={`${added}/${removed}`} color={tokens.textSecondary}>
            +{added} / -{removed}
          </ValueGlow>
        </Text>,
      )
    }
    if (hasTools) {
      if (segs.length > 0) segs.push(<Text key="s2" color={tokens.textMuted}> · </Text>)
      segs.push(
        <Text key="tools" color={tokens.textMuted}>
          {toolCount} tool{toolCount === 1 ? '' : 's'}
          {typeBreakdown ? ` (${typeBreakdown})` : ''}
        </Text>,
      )
    }
    spineNode = (
      <Text wrap="truncate-end">{segs}</Text>
    )
  }

  if (!showSpine && !ledeNode) return null

  // Left-anchored in every home:
  // this spine's tallies tick mid-turn, and it shares the status band with the
  // working row — one fixed anchor for the whole family.
  return (
    <Box flexDirection="column" paddingX={1}>
      {spineNode}
      {ledeNode}
    </Box>
  )
}

// React.memo — this lives in the persistent REPL bottom slot and re-renders on
// every parent commit (spinner frames, cost ticks). Default shallow-prop compare
// skips the re-render (and the memoized message walk) when no prop reference
// changed; `messages` is rebuilt per real turn, so the spine still updates live.
export const MercuryTurnRollup = React.memo(MercuryTurnRollupInner)
