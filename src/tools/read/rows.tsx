import * as React from 'react'

import { truncatePathMiddle } from '../../platform/text/truncate.js'
import { FallbackToolUseErrorMessage, ShortErrorLine } from '../kit/FallbackToolUseErrorMessage.js'
import { isDenialResultText } from '../../engine/message-shapes/rejectionText.js'
import { FilePathLink } from '../kit/FilePathLink.js'
import { MessageResponse } from '../kit/MessageResponse.js'
import { ToolCardMeta, toolCardCountColor } from '../../screen/widgets/toolCardMeta.js'
import { useMercuryTokens } from '../../screen/widgets/useMercuryTokens.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../kit/toolLimits.js'
import { Text } from '../../screen/themedRenderer.js'
import type { ToolResultBlockParam } from '../../engine/message-shapes/wire.js'
import { getTaskOutputDir } from '../../engine/task-framework/diskOutput.js'
import { extractTag } from '../../engine/messages/messages.js'
import { FILE_NOT_FOUND_CWD_NOTE, getDisplayPath } from '../../platform/files/file.js'
import { REMOTE_FILE_NOT_FOUND } from '../../platform/remote-file-target/target.js'
import { formatFileSize } from '../../platform/text/format.js'
import { isPathInside } from './pathPrefix.js'
import { plural } from '../../platform/text/strings.js'
import type { Input, Output } from './ReadTool.js'
import { resultResolvedNames } from './call/results.js'
import { READ_TOOL_NAME } from '../kit/names/read.js'
import { passedOver } from '../../platform/errors/passedOver.js'


const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,20}$/

function crewmateOutputTaskId(filePath: string | undefined): string | null {
  if (!filePath) return null
  try {
    const outputDir = getTaskOutputDir()
    if (!isPathInside(filePath, outputDir)) return null
    const base = filePath.split(/[\\/]/).pop() ?? ''
    const withoutSuffix = base.endsWith('.output') ? base.slice(0, -'.output'.length) : base
    return TASK_ID_PATTERN.test(withoutSuffix) ? withoutSuffix : null
  } catch (error) {
    passedOver(error)
    return null
  }
}

export function userFacingName(input?: Partial<Input>): string {
  return crewmateOutputTaskId(input?.file_path) !== null ? 'Read crewmate output' : READ_TOOL_NAME
}

export function getToolUseSummary(input: Partial<Input> | undefined): string | null {
  if (!input?.file_path) return null
  const taskId = crewmateOutputTaskId(input.file_path)
  if (taskId !== null) return taskId
  return truncatePathMiddle(getDisplayPath(input.file_path), TOOL_SUMMARY_MAX_LENGTH)
}

export function renderToolUseMessage(
  input: Partial<Input>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!input.file_path) return null
  if (crewmateOutputTaskId(input.file_path) !== null) return ''
  const trailers: string[] = []
  if (input.pages) {
    trailers.push(`pages ${input.pages}`)
  } else if (verbose && (input.offset !== undefined || input.limit !== undefined)) {
    const start = input.offset ?? 1
    trailers.push(input.limit !== undefined ? `lines ${start}-${start + input.limit - 1}` : `from line ${start}`)
  }
  return (
    <Text>
      <FilePathLink filePath={input.file_path}>
        {verbose ? input.file_path : getDisplayPath(input.file_path)}
      </FilePathLink>
      {trailers.length > 0 ? ` · ${trailers.join(' · ')}` : null}
    </Text>
  )
}

export function renderToolUseTag(input?: Partial<Input>): string | null {
  const taskId = crewmateOutputTaskId(input?.file_path)
  return taskId !== null ? taskId : null
}

function ReadResultSummary({ output }: { output: Output }): React.ReactNode {
  const tokens = useMercuryTokens()
  switch (output.type) {
    case 'image':
      return (
        <Text color={toolCardCountColor()}>
          image
          <ToolCardMeta text={formatFileSize(output.file.originalSize)} />
        </Text>
      )
    case 'notebook': {
      const count = output.file.cells.length
      if (count === 0) return <Text color={tokens.warning}>Notebook has no cells</Text>
      return (
        <Text>
          Read <Text bold>{count}</Text> {plural(count, 'cell')}
        </Text>
      )
    }
    case 'pdf':
      return (
        <Text>
          PDF <Text color={tokens.textMuted}>({formatFileSize(output.file.originalSize)})</Text>
        </Text>
      )
    case 'parts':
      return (
        <Text>
          Read <Text bold>{output.file.count}</Text> {plural(output.file.count, 'page')}{' '}
          <Text color={tokens.textMuted}>({formatFileSize(output.file.originalSize)})</Text>
        </Text>
      )
    case 'file_unchanged':
      return <Text color={tokens.textMuted}>unchanged since last read</Text>
    case 'text': {
      const resolvedName = resultResolvedNames.get(output)
      return (
        <Text>
          Read <Text bold>{output.file.numLines}</Text> {plural(output.file.numLines, 'line')}
          {resolvedName !== undefined ? <Text color={tokens.textMuted}> ({resolvedName})</Text> : null}
        </Text>
      )
    }
  }
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  return (
    <MessageResponse height={1}>
      <ReadResultSummary output={output} />
    </MessageResponse>
  )
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!verbose && typeof result === 'string' && !isDenialResultText(result)) {
    if (result.includes(FILE_NOT_FOUND_CWD_NOTE) || result.includes(REMOTE_FILE_NOT_FOUND)) {
      return <ShortErrorLine text="File not found" />
    }
    if (extractTag(result, 'tool_use_error') !== null) {
      return <ShortErrorLine text="Error reading file" />
    }
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
