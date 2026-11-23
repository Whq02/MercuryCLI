import * as React from 'react'
import { CHANNEL_ARROW } from '../../constants/figures.js'
import { CHANNEL_TAG } from '../../constants/xml.js'
import { Box, Text } from '../../ink.js'
import type { TextBlockParam } from '../../types/wire.js'
import { truncateToWidth } from '../../utils/truncate.js'

const CHANNEL_RE = new RegExp(
  `<${CHANNEL_TAG} source="([^"]+)"([^>]*)>\\n?([\\s\\S]*?)\\n?</${CHANNEL_TAG}>`,
)

type Props = {
  addMargin: boolean
  param: TextBlockParam
}

export function UserChannelMessage({
  addMargin,
  param: { text },
}: Props): React.ReactNode {
  const match = text.match(CHANNEL_RE)
  if (!match) return null
  const [, source = '', attrs = '', body = ''] = match
  const user = attrs.match(/\buser="([^"]+)"/)?.[1]
  const colon = source.lastIndexOf(':')
  const serverName = colon >= 0 ? source.slice(colon + 1) : source
  const preview = truncateToWidth(body.trim().replace(/\s+/g, ' '), 60)
  return (
    <Box marginTop={addMargin ? 1 : 0}>
      <Text>
        <Text color="suggestion">{CHANNEL_ARROW}</Text>{' '}
        <Text dimColor>
          {serverName}
          {user ? ` · ${user}` : ''}:
        </Text>{' '}
        {preview}
      </Text>
    </Box>
  )
}
