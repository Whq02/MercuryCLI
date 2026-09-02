// ============================================================================
//  mercury-ui/toolCardMeta — the shared accent kit for the └─ tool-result line.
//
//  The live transcript's per-tool result summary (Read "N lines", Grep
//  "Found N files", WebSearch "Did N searches in Xs", …) is rendered by each
//  tool's renderToolResultMessage. This module is the ONE place that decides how
//  a result-line datum is *styled* in Mercury — so every card reads the same:
//  a TEAL geometric marker (●) before the summary, the load-bearing COUNT in
//  IVORY-bold, and any trailing meta (bytes / duration) in FAINT.
//
//  HONESTY: this module renders ONLY what the caller hands it. It invents no
//  number, no duration, no byte count. A tool with no honest metadatum passes
//  none and the FAINT trailer simply doesn't render. There is no per-tool
//  duration here for Read/Edit/Grep — only WebSearch/Glob carry a real measured
//  duration in their persisted Output, and only those pass `meta`.
//
//  (A retired branch used the default color and no
//  marker — byte-identical default cards.) mercuryPalette tokens only; no new hex; no emoji; ● is the
//  design's done-dot (figures.BLACK_CIRCLE folds to '●' for Mercury).
// ============================================================================

import * as React from 'react'
import { Text } from '../../ink.js'
import { BLACK_CIRCLE } from '../../constants/figures.js'

// ADAPTIVE INK: these are THEME-ROLE strings,
// resolved reactively by ThemedText against the live family — in the fork
// DARK theme the roles are byte-equal to the brand ink (text=IVORY,
// inactive=FAINT, success=TEAL via the warm-ink overlay), and light /
// daltonized / ansi paint their own deliberate values. Function signatures
// unchanged so the 16 tool-card call sites stay put.

/** The accent color for the COUNT inside a result summary (bold count). */
export function toolCardCountColor(): string | undefined {
  return 'text'
}

/** The muted tint for trailing meta (bytes, duration, "session"). */
export function toolCardMetaColor(): string | undefined {
  return 'inactive'
}

/**
 * The leading geometric marker for a *successful* result line — a success ●
 * in the status-spine sense (ok). (The base renderer had no marker.)
 * Kept width-2 ('● ') to match the design's done-dot cadence; callers place it
 * at the head of the summary Text, inside the existing └─ gutter.
 */
export function ToolCardMarker(): React.ReactNode {
  return <Text color="success">{BLACK_CIRCLE} </Text>
}

/**
 * Render a trailing muted meta segment, e.g. ` · 1.5KB` or ` · 12ms`. Returns
 * null when `text` is empty — so a tool with no honest
 * trailer renders nothing (no dangling separator).
 */
export function ToolCardMeta({ text }: { text?: string | null }): React.ReactNode {
  if (!text) return null
  return (
    <Text color="inactive">
      {' · '}
      {text}
    </Text>
  )
}
