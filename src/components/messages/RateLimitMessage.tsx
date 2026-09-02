// Rate-limit error row: the refusal head in the error colour, then the
// remedy lines the row was CREATED with, painted dim.
//
// The row is a RECORD (FN-016 R9): every remedy line — the within-family
// slot fix, the account remedy, the other-provider lane — is composed once
// where the row is created (composeAnthropicWallRemedies at the API-error
// mint) and rides the message text itself. Nothing here reads live slot,
// account or lane state, so a slot flip can never rewrite settled history:
// the historical wall row used to advertise the just-exhausted slot as
// having headroom and lose its upsell line as the seat changed. Rows from
// older transcripts carry no baked remedies and render as their own text.
//
// The pure account-remedy decision table lives with the message-text owner
// now; the re-export keeps this module the row's one import surface.

import React from 'react'
import { Box, Text } from '../../ink.js'

export {
  getUpsellMessage,
  type UpsellMessageParams,
} from '../../services/rateLimitMessages.js'

export function RateLimitMessage({
  addMargin = false,
  text,
}: {
  addMargin?: boolean
  text: string
}): React.ReactNode {
  const [head = '', ...remedies] = text.split('\n')
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Text color="error">{head}</Text>
      {remedies
        .filter(line => line.trim() !== '')
        .map(line => (
          <Text key={line} dimColor>
            {line}
          </Text>
        ))}
    </Box>
  )
}

export default RateLimitMessage
