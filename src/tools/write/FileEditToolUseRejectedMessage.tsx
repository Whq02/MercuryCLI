import React from 'react'
import { relative } from 'path'
import { useTerminalSize } from '../../screen/fullscreen-layout/useTerminalSize.js'
import { Box, Text } from '../../screen/themedRenderer.js'
import { isRemotePath } from '../../platform/remote-file-target/target.js'
import { getCwd } from '../../platform/files/cwd.js'
import type { StructuredPatchHunk } from '../../platform/text/diff.js'
import { HighlightedCode } from '../../screen/highlighted-code/HighlightedCode.js'
import { MessageResponse } from '../kit/MessageResponse.js'
import { StructuredDiffList } from '../../screen/structured-diff/StructuredDiffList.js'

const PREVIEW_LINES = 10

const BODY_INSET = 12

type Props = { file_path: string; operation: 'write' | 'update'; patch?: StructuredPatchHunk[]; firstLine: string | null; fileContent?: string; content?: string; style?: 'condensed'; verbose: boolean }

function Headline({ file_path, operation, verbose }: Props): React.ReactNode {
  const displayPath = verbose || isRemotePath(file_path) ? file_path : relative(getCwd(), file_path)
  return (
    <MessageResponse height={1}>
      <Text dimColor wrap="wrap">
        Operator rejected {operation} to <Text bold>{displayPath}</Text>
      </Text>
    </MessageResponse>
  )
}

function WritePreview({ content, file_path, verbose, width }: { content: string; file_path: string; verbose: boolean; width: number }): React.ReactNode {
  if (content === '') return <MessageResponse height={1}><Text dimColor>(no content)</Text></MessageResponse>
  const lines = content.split('\n')
  const shown = verbose ? lines : lines.slice(0, PREVIEW_LINES)
  const cut = lines.length - shown.length
  return (
    <MessageResponse>
      <Box flexDirection="column">
        <HighlightedCode code={shown.join('\n')} filePath={file_path} width={width} />
        {cut > 0 ? <Text dimColor>+{cut} lines</Text> : null}
      </Box>
    </MessageResponse>
  )
}

const PatchPreview = ({ patch, file_path, firstLine, fileContent, width }: { patch: StructuredPatchHunk[]; file_path: string; firstLine: string | null; fileContent?: string; width: number }): React.ReactNode => (
  <MessageResponse>
    <StructuredDiffList hunks={patch} dim width={width} filePath={file_path} firstLine={firstLine} fileContent={fileContent} />
  </MessageResponse>
)

function bodyOf(props: Props, width: number): React.ReactNode {
  const { operation, content, patch, file_path, firstLine, fileContent, verbose, style } = props
  if (style === 'condensed' && !verbose) return null
  if (operation === 'write' && content !== undefined) return <WritePreview content={content} file_path={file_path} verbose={verbose} width={width} />
  if (patch && patch.length > 0) return <PatchPreview patch={patch} file_path={file_path} firstLine={firstLine} fileContent={fileContent} width={width} />
  return null
}

export function FileEditToolUseRejectedMessage(props: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const body = bodyOf(props, columns - BODY_INSET)
  const headline = <Headline {...props} />
  return body === null ? headline : <Box flexDirection="column">{headline}{body}</Box>
}
