// ============================================================================
//  MercurySupercodeKeywordHint — the inline supercode keyword-trigger affordance.
//
//  The prompt-composer hint that pairs with the detector in
//  utils/keywordTrigger/supercode.ts. When the live draft contains a TRIGGERABLE
//  `supercode` keyword — i.e. the skip rules pass: NOT inside quotes /
//  paired delimiters, NOT a path/identifier (`src/supercode/foo.ts`), NOT a
//  flag (`--supercode-mode`), NOT a question (`what is supercode?`), NOT slash
//  input (`/rename supercode`) — this renders a single advisory line above the
//  composer footer — the keyword-armed hint.
//
//  DETECTION-HONEST (the load-bearing contract): the copy says the keyword
//  "opts the engine into its dynamic-workflow runtime — engine-side; detected,
//  not enforced here." Mercury does NOT execute the keyword, mutate the turn, or
//  change session effort from this surface — it only SURFACES that the engine's
//  own keyword handler will see it. No fabricated "supercode mode ON" state.
//
//  Honest-empty: no triggerable keyword ⇒ this returns null (a present-keyword-
//  absent state is rendering nothing, never a crash). Pure + presentational —
//  all logic lives in the detector; this file only renders. Geometric glyph
//  only (◆), zero new hex (mercuryPalette tokens), no emoji.
// ============================================================================

import * as React from 'react'
import { Box, Text } from '../ink.js'
import { FAINT, IVORY, SECOND } from './mercuryPalette.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import { hasSupercodeKeyword } from '../utils/keywordTrigger/supercode.js'
import { useAppStateMaybeOutsideOfProvider } from '../state/AppState.js'
import { dynamicWorkflowsEnabled } from '../tools/WorkflowTool/workflowEnablement.js'

// The keyword-armed marker. Geometric vocabulary (GLYPH.mission / ownSubstrate)
// — the filled diamond reads as "an active directive is present" without the
// tonal mismatch of an emoji.
const ARMED_GLYPH = GLYPH.mission

export type MercurySupercodeKeywordHintProps = {
  /** The live composer draft (PromptInput's `displayedValue`). */
  value: string
  /**
   * Gate: render only when the composer can actually submit. Mirrors TF's
   * `!composerDisabled && hasSupercodeKeyword(text)` — a disabled/loading
   * composer must NOT imply the keyword will reach the engine. Defaults true.
   */
  active?: boolean
}

/**
 * The inline keyword-trigger advisory. Renders one honest line iff `active` AND
 * the draft contains a triggerable `supercode`; otherwise nothing.
 *
 * Detection is delegated to `hasSupercodeKeyword` (the detector's skip rules),
 * so this surface is byte-for-byte as conservative as the detector: a quoted/
 * path/flag/question/slash occurrence shows nothing.
 */
export function MercurySupercodeKeywordHint({
  value,
  active = true,
}: MercurySupercodeKeywordHintProps): React.ReactNode {
  // The keyword-armed glyph rides the warm-ink SESSION ACCENT (terra family;
  // MERCURY_CRITTER re-tints it) — identity colour, not the fixed status spine.
  const accent = useSessionAccent().accent
  // Standing-mode read: when supercode is already ON the per-turn promise is
  // moot (the attachment layer suppresses the keyword too) — stay silent.
  const standingSupercode = useAppStateMaybeOutsideOfProvider(s => s.supercode) === true
  // Cheap: hasSupercodeKeyword bails immediately when the word is absent. The
  // memo only matters while a draft actually mentions the keyword. HONESTY
  // the chip mirrors the attachment layer's OWN gates —
  // with workflows disabled the keyword produces NO turn effect, and the old
  // chip promised one anyway.
  const armed = React.useMemo(
    () =>
      active &&
      typeof value === 'string' &&
      hasSupercodeKeyword(value) &&
      !standingSupercode &&
      dynamicWorkflowsEnabled(),
    [active, value, standingSupercode],
  )
  if (!armed) return null

  return (
    <Box flexDirection="row" marginLeft={2} marginTop={0}>
      <Box minWidth={2}>
        <Text color={accent}>{ARMED_GLYPH}</Text>
      </Box>
      <Text wrap="truncate-end">
        <Text color={IVORY} bold>
          supercode
        </Text>
        <Text color={SECOND}>
          {' '}
          keyword detected — this turn opts into dynamic orchestration
        </Text>
        <Text color={FAINT}> (/effort supercode makes it standing: max + workflows)</Text>
      </Text>
    </Box>
  )
}

export default MercurySupercodeKeywordHint
