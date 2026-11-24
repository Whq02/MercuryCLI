import * as React from 'react'
import { BLACK_CIRCLE } from '../theme/rowGlyphs.js'
import { Box, Text } from '../themedRenderer.js'
import { ConfigurableShortcutHint } from '../keys/ConfigurableShortcutHint.js'
import { formatTokens } from '../../platform/text/format.js'
import { FAINT, IVORY, SECOND, TEAL } from '../theme/mercuryPalette.js'
import { MessageResponse } from '../../tools/kit/MessageResponse.js'
import { ProgressBar } from '../widgets/components.js'
import { GLYPH } from '../theme/glyphs.js'


type Props = {
  summary: string
  pct?: number
  messagesSummarized?: number
  userContext?: string
  tokensBefore?: number
  tokensAfter?: number
  keptMessages?: number
  transcript?: boolean
}

export function MercuryFoldSummary({
  summary,
  pct,
  messagesSummarized,
  userContext,
  tokensBefore,
  tokensAfter,
  keptMessages,
  transcript = false,
}: Props): React.ReactNode {
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
                {}
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
