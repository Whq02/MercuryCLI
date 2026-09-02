import type { TextBlockParam } from '../../types/wire.js'
import * as React from 'react'
import { CHANNEL_ARROW } from '../../constants/figures.js'
import { CHANNEL_TAG } from '../../constants/xml.js'
import { Box, Text } from '../../ink.js'
import { truncateToWidth } from '../../utils/format.js'

type Props = {
  addMargin: boolean
  param: TextBlockParam
}

// Parses the envelope the channel wrappers emit:
//   <channel source="…" user="…" chat_id="…">content</channel>
// wrapChannelMessage guarantees source leads; the user attribute may be absent.
const CHANNEL_RE = new RegExp(
  `<${CHANNEL_TAG}\\s+source="([^"]+)"([^>]*)>\\n?([\\s\\S]*?)\\n?</${CHANNEL_TAG}>`,
)
const USER_ATTR_RE = /\buser="([^"]+)"/

// An extension's server arrives as ext:slack-channel:slack (the runtime
// name spelling); only the last segment is worth showing.
// Keep this in step with the suffix matching in isServerInChannels.
function displayServerName(name: string): string {
  const i = name.lastIndexOf(':')
  return i === -1 ? name : name.slice(i + 1)
}

const TRUNCATE_AT = 60

export function UserChannelMessage({
  addMargin,
  param: { text },
}: Props): React.ReactNode {
  const m = CHANNEL_RE.exec(text)
  if (!m) return null
  const [, source, attrs, content] = m
  const user = USER_ATTR_RE.exec(attrs ?? '')?.[1]
  const body = (content ?? '').trim().replace(/\s+/g, ' ')
  const truncated = truncateToWidth(body, TRUNCATE_AT)
  return (
    <Box marginTop={addMargin ? 1 : 0}>
      <Text>
        <Text color="suggestion">{CHANNEL_ARROW}</Text>{' '}
        <Text dimColor>
          {displayServerName(source ?? '')}
          {user ? ` · ${user}` : ''}:
        </Text>{' '}
        {truncated}
      </Text>
    </Box>
  )
}
