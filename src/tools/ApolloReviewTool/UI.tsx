// The Apollo closing-review card: the layman
// review of the completed pre-flight spec — summary, blocker state, spec
// files, run note — on the design system (useMercuryTokens; the ∵ seal).
//
// One card, two moments: the consent surface (ApolloReviewPermissionRequest)
// and the transcript receipt (renderToolResultMessage) render the SAME
// component, so what the user approved and what the record shows can never
// diverge. Deliberately provider-free (tokens + glyphs only) so the render
// prover can mount it standalone.

import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { FilePathLink } from '../../components/FilePathLink.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { getDisplayPath } from '../../utils/file.js'
import type { Output } from './ApolloReviewTool.js'

export function ApolloReviewCard({
  summary,
  blockers,
  specFiles,
  runNote,
}: {
  summary: string
  blockers: readonly string[]
  specFiles: readonly string[]
  runNote?: string
}): React.ReactElement {
  const tokens = useMercuryTokens()
  const clean = blockers.length === 0
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={tokens.accent}>{GLYPH.modeApollo}</Text>{' '}
        <Text bold color={tokens.textPrimary}>
          Apollo pre-flight review
        </Text>
      </Text>
      <Box marginLeft={2} flexDirection="column">
        <Text color={tokens.textSecondary} wrap="wrap">
          {summary}
        </Text>
        <Box marginTop={1} flexDirection="column">
          {clean ? (
            <Text color={tokens.success}>No blockers — the spec is ready to build.</Text>
          ) : (
            <>
              <Text color={tokens.warning}>
                {blockers.length === 1 ? '1 blocker remains:' : `${blockers.length} blockers remain:`}
              </Text>
              {blockers.map(blocker => (
                <Text key={blocker} color={tokens.textSecondary} wrap="wrap">
                  <Text color={tokens.warning}>· </Text>
                  {blocker}
                </Text>
              ))}
            </>
          )}
        </Box>
        {specFiles.length > 0 ? (
          <Box marginTop={1} flexDirection="column">
            <Text color={tokens.textInstruction}>The spec, in plain language:</Text>
            {specFiles.map(file => (
              <Text key={file} color={tokens.textMuted}>
                {'  '}
                <FilePathLink filePath={file}>{getDisplayPath(file)}</FilePathLink>
              </Text>
            ))}
          </Box>
        ) : null}
        {runNote ? (
          <Box marginTop={1}>
            <Text color={tokens.textInstruction}>
              Run it: <Text color={tokens.textSecondary}>{runNote}</Text>
            </Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}

/** The transcript receipt: the card plus the settled line. */
export function renderToolResultMessage(output: Output): React.ReactNode {
  if (!output) return null
  return (
    <MessageResponse>
      <Box flexDirection="column">
        <ApolloReviewCard
          summary={output.summary}
          blockers={output.blockers}
          specFiles={output.specFiles}
          runNote={output.runNote}
        />
        <Box marginLeft={2} marginTop={1}>
          <SettledLine output={output} />
        </Box>
      </Box>
    </MessageResponse>
  )
}

function SettledLine({ output }: { output: Output }): React.ReactElement {
  const tokens = useMercuryTokens()
  if (output.blockers.length > 0) {
    return (
      <Text color={tokens.textMuted}>
        The build waits until the blockers are settled.
      </Text>
    )
  }
  if (output.interviewContinues) {
    return (
      <Text color={tokens.textInstruction}>
        Not yet — the interview continues with more questions.
      </Text>
    )
  }
  return (
    <Text color={tokens.success}>
      Build approved — continuing under {output.buildModeTitle ?? 'the build posture'}.
    </Text>
  )
}

export function renderToolUseRejectedMessage(): React.ReactNode {
  return <Text dimColor>Build not started — the user held the review.</Text>
}

export function renderToolUseMessage(): React.ReactNode {
  return null
}
