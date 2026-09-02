// Indented stdout/stderr of a locally executed command, each stream behind
// the shared gutter connector. A stream whose first line leads with a
// diamond figure and a space is a cloud-launch notice and gets its own
// header treatment instead of the markdown block.

import React from 'react'
import { Box, Text } from '../../ink.js'
import {
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../../constants/xml.js'
import { extractTag } from '../../utils/messages.js'
import { Markdown } from '../Markdown.js'
import { MessageResponse } from '../MessageResponse.js'

const CLOUD_LAUNCH_LEAD = /^([◇◆]) /

function CloudLaunchNotice({ text }: { text: string }): React.ReactNode {
  const lines = text.split('\n')
  const first = lines[0] ?? ''
  const diamond = first.slice(0, 1)
  const header = first.slice(2)
  const middotAt = header.indexOf(' · ')
  const label = middotAt === -1 ? header : header.slice(0, middotAt)
  const remainder = middotAt === -1 ? '' : header.slice(middotAt)
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="background">{diamond} </Text>
        <Text bold>{label}</Text>
        {remainder ? <Text dimColor>{remainder}</Text> : null}
      </Text>
      {lines.length > 1 ? (
        <MessageResponse>
          <Text dimColor>{lines.slice(1).join('\n')}</Text>
        </MessageResponse>
      ) : null}
    </Box>
  )
}

function Stream({ text }: { text: string }): React.ReactNode {
  if (CLOUD_LAUNCH_LEAD.test(text)) return <CloudLaunchNotice text={text} />
  return (
    <MessageResponse>
      <Markdown>{text}</Markdown>
    </MessageResponse>
  )
}

export function UserLocalCommandOutputMessage({
  content,
}: {
  content: string
}): React.ReactNode {
  const stdout = (extractTag(content, LOCAL_COMMAND_STDOUT_TAG) ?? '').trim()
  const stderr = (extractTag(content, LOCAL_COMMAND_STDERR_TAG) ?? '').trim()
  if (!stdout && !stderr) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>(no content)</Text>
      </MessageResponse>
    )
  }
  return (
    <Box flexDirection="column">
      {stdout ? <Stream text={stdout} /> : null}
      {stderr ? <Stream text={stderr} /> : null}
    </Box>
  )
}

export default UserLocalCommandOutputMessage
