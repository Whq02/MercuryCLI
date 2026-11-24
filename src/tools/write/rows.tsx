import * as React from 'react'
import { useLoad } from '../../screen/effects/effects.js'

import { truncatePathMiddle } from '../../platform/text/truncate.js'
import { CtrlOToExpand } from '../../screen/messages/CtrlOToExpand.js'
import { FallbackToolUseErrorMessage } from '../kit/FallbackToolUseErrorMessage.js'
import { isDenialResultText } from '../../engine/message-shapes/rejectionText.js'
import { EditUpdatedMessage } from '../edit/EditUpdatedMessage.js'
import { FileEditToolUseRejectedMessage } from './FileEditToolUseRejectedMessage.js'
import { FilePathLink } from '../kit/FilePathLink.js'
import { HighlightedCode } from '../../screen/highlighted-code/HighlightedCode.js'
import { MessageResponse } from '../kit/MessageResponse.js'
import { ToolCardMarker } from '../../screen/widgets/toolCardMeta.js'
import { useMercuryTokens } from '../../screen/widgets/useMercuryTokens.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../kit/toolLimits.js'
import { isRemotePath } from '../../platform/remote-file-target/target.js'
import { useTerminalSize } from '../../screen/fullscreen-layout/useTerminalSize.js'
import { Box, Text } from '../../screen/themedRenderer.js'
import type { ToolResultBlockParam } from '../../engine/message-shapes/wire.js'
import { getPatchForDisplay } from '../../platform/text/diff.js'
import { getDisplayPath } from '../../platform/files/file.js'
import { toolErrorReason } from '../kit/toolErrorReason.js'
import { readFileInRange, FileTooLargeError } from '../../platform/files/readFileInRange.js'
import { countCharInString, firstLineOf, plural } from '../../platform/text/strings.js'
import { WRITE_TOOL_NAME } from '../kit/names/write.js'
import { isENOENT } from '../../platform/errors/errors.js'
import { isSqliteRowTarget } from './structuredTargets.js'
import type { FileWriteInput, Output } from './WriteTool.js'

const MAX_LINES_TO_RENDER = 10
const MAX_REJECTED_DIFF_BYTES = 1024 * 1024

function countActualLines(content: string): number {
  if (content === '') return 0
  const newlines = countCharInString(content, '\n')
  return content.endsWith('\n') ? newlines : newlines + 1
}

export function userFacingName(_input?: Partial<FileWriteInput>): string {
  return WRITE_TOOL_NAME
}

export function getToolUseSummary(input: Partial<FileWriteInput> | undefined): string | null {
  if (!input?.file_path) return null
  return truncatePathMiddle(getDisplayPath(input.file_path), TOOL_SUMMARY_MAX_LENGTH)
}

export function renderToolUseMessage(
  input: Partial<FileWriteInput>,
  _options: { verbose: boolean },
): React.ReactNode {
  if (!input.file_path) return null
  return (
    <FilePathLink filePath={input.file_path}>
      {getDisplayPath(input.file_path)}
    </FilePathLink>
  )
}

export function isResultTruncated(output: Output | undefined): boolean {
  if (!output || output.type !== 'create') return false
  return countActualLines(output.content) > MAX_LINES_TO_RENDER
}

function NoChangeResult({ filePath }: { filePath: string }): React.ReactNode {
  const tokens = useMercuryTokens()
  return (
    <MessageResponse>
      <Text color={tokens.textMuted}>
        No changes — {getDisplayPath(filePath)} already matches the provided content
      </Text>
    </MessageResponse>
  )
}

function CreateResult({
  filePath,
  content,
  verbose,
  condensed,
}: {
  filePath: string
  content: string
  verbose: boolean
  condensed: boolean
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const tokens = useMercuryTokens()
  const displayPath = getDisplayPath(filePath)
  const lineCount = countActualLines(content)
  const sqliteSuffix = isSqliteRowTarget(filePath) ? ' · not checkpointed' : ''

  if (condensed && !verbose) {
    return (
      <MessageResponse>
        <Text>
          <ToolCardMarker />
          Wrote <Text bold>{lineCount}</Text> {plural(lineCount, 'line')} to {displayPath}
          {sqliteSuffix}
        </Text>
      </MessageResponse>
    )
  }

  if (content === '') {
    return (
      <MessageResponse>
        <Box flexDirection="column">
          <Text>
            <ToolCardMarker />
            Wrote <Text bold>0</Text> lines to {displayPath}
          </Text>
          <Text color={tokens.textMuted}>(empty file)</Text>
        </Box>
      </MessageResponse>
    )
  }

  const codeWidth = Math.max(20, columns - 6)
  const previewCode = verbose
    ? content
    : content.split('\n').slice(0, MAX_LINES_TO_RENDER).join('\n')
  const hiddenLines = verbose ? 0 : Math.max(0, lineCount - MAX_LINES_TO_RENDER)

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text>
          <ToolCardMarker />
          Wrote <Text bold>{lineCount}</Text> {plural(lineCount, 'line')} to {displayPath}
          {sqliteSuffix}
        </Text>
        <HighlightedCode code={previewCode} filePath={filePath} width={codeWidth} />
        {hiddenLines > 0 ? (
          <Text color={tokens.textMuted}>
            +{hiddenLines} more {plural(hiddenLines, 'line')} <CtrlOToExpand />
          </Text>
        ) : null}
      </Box>
    </MessageResponse>
  )
}

export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown,
  {
    verbose,
    style,
    isTranscriptMode,
  }: { verbose: boolean; style?: 'condensed' | 'default'; isTranscriptMode?: boolean },
): React.ReactNode {
  const effectiveVerbose = verbose || isTranscriptMode === true
  if (output.type === 'delete' || output.type === 'not-found') {
    const head =
      output.type === 'delete'
        ? 'Deleted one SQLite row'
        : 'Row not found; nothing was deleted'
    return (
      <MessageResponse>
        <Text>
          {head} — {getDisplayPath(output.filePath)}
          {output.content !== '' ? ` · ${output.content}` : ''}
          {output.type === 'delete' ? ' · not checkpointed' : ''}
        </Text>
      </MessageResponse>
    )
  }
  if (output.type === 'no-change') {
    return <NoChangeResult filePath={output.filePath} />
  }
  if (output.type === 'update') {
    return (
      <EditUpdatedMessage
        filePath={output.filePath}
        structuredPatch={output.structuredPatch}
        firstLine={firstLineOf(output.content)}
        fileContent={output.originalFile ?? ''}
        verbose={effectiveVerbose}
        {...(style === 'condensed' ? { style: 'condensed' as const } : {})}
      />
    )
  }
  return (
    <CreateResult
      filePath={output.filePath}
      content={output.content}
      verbose={effectiveVerbose}
      condensed={style === 'condensed'}
    />
  )
}

type RejectedPreviewState =
  | { kind: 'loading' }
  | { kind: 'create' }
  | { kind: 'update'; originalContent: string; patch: ReturnType<typeof getPatchForDisplay> }
  | { kind: 'error' }

function RejectedWritePreview({
  filePath,
  content,
  verbose,
}: {
  filePath: string
  content: string
  verbose: boolean
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const remote = isRemotePath(filePath)
  const [state, setState] = React.useState<RejectedPreviewState>(() =>
    remote ? { kind: 'create' } : { kind: 'loading' },
  )

  useLoad(signal => {
    if (remote) {
      setState({ kind: 'create' })
      return
    }
    setState({ kind: 'loading' })
    void readFileInRange(filePath, 0, undefined, MAX_REJECTED_DIFF_BYTES, signal).then(
      result => {
        if (signal.aborted) return
        const originalContent = result.content
        const patch = getPatchForDisplay({
          filePath,
          fileContents: originalContent,
          edits: [{ old_string: originalContent, new_string: content }],
        })
        setState({ kind: 'update', originalContent, patch })
      },
      error => {
        if (signal.aborted) return
        if (isENOENT(error) || error instanceof FileTooLargeError) {
          setState({ kind: 'create' })
        } else {
          setState({ kind: 'error' })
        }
      },
    )
  }, [filePath, content, remote])

  if (state.kind === 'error') {
    return (
      <MessageResponse>
        <Text color={tokens.textMuted}>no changes</Text>
      </MessageResponse>
    )
  }
  if (state.kind === 'update') {
    return (
      <FileEditToolUseRejectedMessage
        file_path={filePath}
        operation="update"
        patch={state.patch}
        firstLine={firstLineOf(content)}
        fileContent={state.originalContent}
        style="condensed"
        verbose={verbose}
      />
    )
  }
  return (
    <FileEditToolUseRejectedMessage
      file_path={filePath}
      operation="write"
      content={content}
      firstLine={firstLineOf(content)}
      verbose={verbose}
    />
  )
}

export function renderToolUseRejectedMessage(
  input?: Partial<FileWriteInput>,
  options?: { verbose?: boolean },
): React.ReactNode {
  if (!input?.file_path || input.content === undefined) return null
  return (
    <RejectedWritePreview
      filePath={input.file_path}
      content={input.content}
      verbose={options?.verbose ?? false}
    />
  )
}

function ShortErrorLine({ text }: { text: string }): React.ReactNode {
  const tokens = useMercuryTokens()
  return (
    <MessageResponse>
      <Text color={tokens.warning}>{text}</Text>
    </MessageResponse>
  )
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!verbose && typeof result === 'string' && !isDenialResultText(result)) {
    return <ShortErrorLine text={toolErrorReason(result, 'Error writing file')} />
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
