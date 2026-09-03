import * as React from 'react'
import { Text } from '../../ink.js'

// ============================================================================
//  EffortStrip — the ONE effort strip: `effort  low [medium] high`, the
//  bracket on the level in force. The main /model picker paints it under its
//  rows; the /submodels panel opens it over a row with `e`. Presentational
//  only — each host decodes its own keys (←→ move the bracket there) — so
//  the two surfaces cannot drift apart in look. `levels` is the host's
//  truthful set from the effort owner, never the full ladder by habit.
// ============================================================================

export function EffortStrip({
  levels,
  current,
  accent,
  faint,
}: {
  levels: readonly string[]
  /** The level in force — bracketed and tinted with the accent. */
  current: string | undefined
  /** The host's identity accent (the bracketed level) and its faint tone. */
  accent: string
  faint: string
}): React.ReactNode {
  return (
    <Text>
      <Text color={faint}>effort  </Text>
      {levels.map(e => (
        <Text key={e} bold={e === current} color={e === current ? accent : faint}>
          {e === current ? `[${e}] ` : `${e} `}
        </Text>
      ))}
    </Text>
  )
}
