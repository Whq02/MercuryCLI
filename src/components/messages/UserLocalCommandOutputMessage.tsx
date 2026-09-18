
import React from 'react'
import { Box, Text } from '../../ink.js'
import {
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../../constants/xml.js'
import { extractTag } from '../../utils/messages.js'
import { earlierReleasesCount } from '../../utils/releaseNotes.js'
import { ctrlOToExpand } from '../CtrlOToExpand.js'
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

function foldEarlierReleases(text: string, verbose: boolean): { shown: string; fold: string | null } {
  const lines = text.split('\n')
  const at = lines.findIndex(line => earlierReleasesCount(line) !== null)
  if (at < 0) return { shown: text, fold: null }
  if (verbose) {
    return { shown: [...lines.slice(0, at), ...lines.slice(at + 1)].join('\n').replace(/\n{3,}/g, '\n\n'), fold: null }
  }
  return { shown: lines.slice(0, at).join('\n').trimEnd(), fold: `${lines[at]!.trim()} ${ctrlOToExpand()}` }
}

function Stream({ text, verbose }: { text: string; verbose: boolean }): React.ReactNode {
  if (CLOUD_LAUNCH_LEAD.test(text)) return <CloudLaunchNotice text={text} />
  const { shown, fold } = foldEarlierReleases(text, verbose)
  if (fold === null) {
    return (
      <MessageResponse>
        <Markdown>{shown}</Markdown>
      </MessageResponse>
    )
  }
  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Markdown>{shown}</Markdown>
        <Text dimColor>{fold}</Text>
      </Box>
    </MessageResponse>
  )
}

export function UserLocalCommandOutputMessage({
  content,
  verbose = false,
}: {
  content: string
  verbose?: boolean
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
      {stdout ? <Stream text={stdout} verbose={verbose} /> : null}
      {stderr ? <Stream text={stderr} verbose={verbose} /> : null}
    </Box>
  )
}

export default UserLocalCommandOutputMessage
