import React from 'react'
import { LOCAL_COMMAND_STDERR_TAG, LOCAL_COMMAND_STDOUT_TAG } from '../../constants/xml.js'
import { Box, Text } from '../../ink.js'
import { extractTag } from '../../utils/messages.js'
import { earlierReleasesCount } from '../../utils/releaseNotes.js'
import { ctrlOToExpand } from '../CtrlOToExpand.js'
import { Markdown } from '../Markdown.js'
import { MessageResponse } from '../MessageResponse.js'

const CLOUD_LAUNCH_LEAD = /^([◇◆]) /

const LABEL_SEPARATOR = ' · '

type Notice = { diamond: string; label: string; remainder: string; rest: string[] }

function noticeOf(text: string): Notice | null {
  if (!CLOUD_LAUNCH_LEAD.test(text)) return null
  const [first = '', ...rest] = text.split('\n')
  const header = first.slice(2)
  const at = header.indexOf(LABEL_SEPARATOR)
  const label = at === -1 ? header : header.slice(0, at)
  const remainder = at === -1 ? '' : header.slice(at)
  return { diamond: first.slice(0, 1), label, remainder, rest }
}

function CloudLaunchNotice({ diamond, label, remainder, rest }: Notice): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="background">{diamond} </Text>
        <Text bold>{label}</Text>
        {remainder ? <Text dimColor>{remainder}</Text> : null}
      </Text>
      {rest.length > 0 ? (
        <MessageResponse>
          <Text dimColor>{rest.join('\n')}</Text>
        </MessageResponse>
      ) : null}
    </Box>
  )
}

type Folded = { shown: string; fold: string | null }

function withoutEarlierReleases(lines: string[], at: number): string {
  return lines.filter((_, index) => index !== at).join('\n').replace(/\n{3,}/g, '\n\n')
}

function foldedEarlierReleases(text: string, verbose: boolean): Folded {
  const lines = text.split('\n')
  const at = lines.findIndex(line => earlierReleasesCount(line) !== null)
  if (at < 0) return { shown: text, fold: null }
  if (verbose) return { shown: withoutEarlierReleases(lines, at), fold: null }
  return { shown: lines.slice(0, at).join('\n').trimEnd(), fold: `${lines[at]!.trim()} ${ctrlOToExpand()}` }
}

function FoldedMarkdown({ shown, fold }: Folded): React.ReactNode {
  const body = <Markdown>{shown}</Markdown>
  return (
    <MessageResponse>
      {fold === null ? (
        body
      ) : (
        <Box flexDirection="column">
          {body}
          <Text dimColor>{fold}</Text>
        </Box>
      )}
    </MessageResponse>
  )
}

function Stream({ text, verbose }: { text: string; verbose: boolean }): React.ReactNode {
  const notice = noticeOf(text)
  return notice ? <CloudLaunchNotice {...notice} /> : <FoldedMarkdown {...foldedEarlierReleases(text, verbose)} />
}

const taggedText = (content: string, tag: string): string => (extractTag(content, tag) ?? '').trim()

export function UserLocalCommandOutputMessage({ content, verbose = false }: { content: string; verbose?: boolean }): React.ReactNode {
  const streams = [LOCAL_COMMAND_STDOUT_TAG, LOCAL_COMMAND_STDERR_TAG].map(tag => taggedText(content, tag)).filter(text => text !== '')
  if (streams.length === 0) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>(no content)</Text>
      </MessageResponse>
    )
  }
  return (
    <Box flexDirection="column">
      {streams.map((text, index) => (
        <Stream key={index} text={text} verbose={verbose} />
      ))}
    </Box>
  )
}
