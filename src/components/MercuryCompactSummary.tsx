import * as React from 'react'
import { BLACK_CIRCLE } from '../constants/figures.js'
import { Box, Text } from '../ink.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js'
import { formatTokens } from '../utils/format.js'
import { FAINT, IVORY, SECOND, TEAL } from './mercuryPalette.js'
import { MessageResponse } from './MessageResponse.js'
import { ProgressBar } from './mercury-ui/components.js'
import { GLYPH } from './mercury-ui/glyphs.js'

// ============================================================================
//  MercuryCompactSummary — the warm-ink /compact result card (Mercury's
//  replacement for the plain CompactSummary in the live REPL stream). Honest
//  data only: `summary` is the real compaction summary text, `pct` is the real
//  share of context reclaimed (computed from preCompactTokenCount vs the
//  resulting context size in commands/compact/compact.ts), `messagesSummarized`
//  is the real fold count. NO faked numbers. Rendered stamp-gated from
//  CompactSummary.tsx; transcript mode shows the full summary text, the live
//  stream shows the compact card. Status spine (TEAL gauge ramp) is never
//  themed; identity stays in the palette tokens.
// ============================================================================

type Props = {
  /** The real compaction summary text (full message body). */
  summary: string
  /** Real share of context reclaimed, 0–100. Omitted when unknown. */
  pct?: number
  /** Real count of messages folded into the summary. */
  messagesSummarized?: number
  /** Optional user-supplied compaction focus. */
  userContext?: string
  /** The context weight before → after the fold (real token counts). */
  tokensBefore?: number
  tokensAfter?: number
  /** Messages the verbatim keep-tail carried across the fold. */
  keptMessages?: number
  /** Transcript view shows the full summary; the live stream shows the card. */
  transcript?: boolean
}

export function MercuryCompactSummary({
  summary,
  pct,
  messagesSummarized,
  userContext,
  tokensBefore,
  tokensAfter,
  keptMessages,
  transcript = false,
}: Props): React.ReactNode {
  // Transcript mode: the whole reconstructed summary, plain, for scrollback.
  if (transcript) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Box minWidth={2}>
            <Text color={TEAL}>{BLACK_CIRCLE}</Text>
          </Box>
          <Box flexDirection="column">
            <Text bold color={IVORY}>
              Compacted
            </Text>
          </Box>
        </Box>
        <MessageResponse>
          <Text color={SECOND}>{summary}</Text>
        </MessageResponse>
      </Box>
    )
  }

  // Live stream: the compact card. Header line carries the real reclaim gauge +
  // the real fold count; a faint expand hint points at the full summary.
  const hasPct = typeof pct === 'number' && Number.isFinite(pct)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Box minWidth={2}>
          <Text color={TEAL}>{BLACK_CIRCLE}</Text>
        </Box>
        <Box flexDirection="column">
          <Text>
            <Text bold color={IVORY}>
              Compacted
            </Text>
            {hasPct ? (
              <Text>
                <Text color={FAINT}> {GLYPH.dot} </Text>
                {/* reclaim gauge — TEAL/AMBER/CRIMSON ramp via ProgressBar's
                    gaugeColor; the number is the real context-reclaimed share */}
                <ProgressBar value={pct!} max={100} width={5} showPct />
                <Text color={FAINT}> reclaimed</Text>
              </Text>
            ) : null}
          </Text>
          <MessageResponse>
            <Box flexDirection="column">
              {typeof messagesSummarized === 'number' ? (
                <Text color={FAINT}>
                  {messagesSummarized} message
                  {messagesSummarized === 1 ? '' : 's'} summarized
                </Text>
              ) : null}
              {typeof tokensBefore === 'number' && typeof tokensAfter === 'number' ? (
                <Text color={FAINT}>
                  context {formatTokens(tokensBefore)} → {formatTokens(tokensAfter)} tokens
                </Text>
              ) : null}
              {typeof keptMessages === 'number' && keptMessages > 0 ? (
                <Text color={FAINT}>
                  last {keptMessages} message{keptMessages === 1 ? '' : 's'} kept verbatim
                </Text>
              ) : null}
              {userContext ? (
                <Text color={FAINT}>
                  focus {'“'}
                  {userContext}
                  {'”'}
                </Text>
              ) : null}
              <Text color={FAINT}>
                <ConfigurableShortcutHint
                  action="app:toggleTranscript"
                  context="Global"
                  fallback="ctrl+o"
                  description="full summary — what the agent retains"
                  parens={true}
                />
              </Text>
            </Box>
          </MessageResponse>
        </Box>
      </Box>
    </Box>
  )
}
