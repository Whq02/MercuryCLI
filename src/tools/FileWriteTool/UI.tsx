import * as React from 'react'

import { truncatePathMiddle } from '../../utils/truncate.js'
import { CtrlOToExpand } from '../../components/CtrlOToExpand.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { FileEditToolUpdatedMessage } from '../../components/FileEditToolUpdatedMessage.js'
import { FileEditToolUseRejectedMessage } from '../../components/FileEditToolUseRejectedMessage.js'
import { FilePathLink } from '../../components/FilePathLink.js'
import { HighlightedCode } from '../../components/HighlightedCode.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { ToolCardMarker } from '../../components/mercury-ui/toolCardMeta.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import type { ToolResultBlockParam } from '../../types/wire.js'
import { getPatchForDisplay } from '../../utils/diff.js'
import { getDisplayPath } from '../../utils/file.js'
import { extractTag } from '../../utils/messages.js'
import { getPlansDirectory } from '../../utils/plans.js'
import { isPathInside } from '../../utils/pathPrefix.js'
import { readFileInRange, FileTooLargeError } from '../../utils/readFileInRange.js'
import { countCharInString, firstLineOf, plural } from '../../utils/stringUtils.js'
import { FILE_WRITE_TOOL_NAME } from './prompt.js'
import type { FileWriteToolInput, Output } from './FileWriteTool.js'

/**
 * Write renderers: created-file preview with truncation, updated-file diff,
 * no-change card, and the asynchronously-loaded rejection preview.
 */

const CREATE_PREVIEW_LINES = 10
const CODE_BLOCK_GUTTER = 6
const REJECTION_SCAN_CAP_BYTES = 1024 * 1024

/**
 * Line counting for the create card: always split on `\n` (the model always
 * emits `\n`; the platform EOL would report one line for everything on
 * Windows), and a trailing newline terminates the last line rather than
 * adding an empty one.
 */
export function countLines(content: string): number {
  if (content === '') return 0
  const newlines = countCharInString(content, '\n')
  return content.endsWith('\n') ? newlines : newlines + 1
}

/** True exactly when an eleventh line exists — never splits the content. */
function hasMoreThanPreviewLines(content: string): boolean {
  let index = -1
  for (let seen = 0; seen < CREATE_PREVIEW_LINES; seen++) {
    index = content.indexOf('\n', index + 1)
    if (index === -1) return false
  }
  return index < content.length - 1
}

function isPlanFile(filePath: string | undefined): boolean {
  if (!filePath) return false
  try {
    const plansDir = getPlansDirectory()
    // Separator-agnostic (TS-2): join() emits '\' on win32; the POSIX
    // needle never matched there.
    return isPathInside(filePath, plansDir)
  } catch {
    return false
  }
}

export function userFacingName(input?: Partial<FileWriteToolInput>): string {
  if (isPlanFile(input?.file_path)) return 'Write plan'
  return FILE_WRITE_TOOL_NAME
}

export function getToolUseSummary(input: Partial<FileWriteToolInput> | undefined): string | null {
  if (!input?.file_path) return null
  return truncatePathMiddle(getDisplayPath(input.file_path), TOOL_SUMMARY_MAX_LENGTH)
}

export function renderToolUseMessage(
  input: Partial<FileWriteToolInput>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!input.file_path) return null
  // The display path, as the Edit and Read rows paint it (the absolute form
  // end-truncates the filename away at 80 columns).
  return (
    <FilePathLink filePath={input.file_path}>
      {getDisplayPath(input.file_path)}
    </FilePathLink>
  )
}

/** Only creates over the preview cap fold; updates render their full diff. */
export function isResultTruncated(output: Output | undefined): boolean {
  if (!output || output.type !== 'create') return false
  return hasMoreThanPreviewLines(output.content)
}

function CreatedFileCard({
  output,
  verbose,
}: {
  output: Extract<Output, object>
  verbose: boolean
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns } = useTerminalSize()
  const lineCount = countLines(output.content)
  const displayPath = getDisplayPath(output.filePath)
  if (output.content === '') {
    return (
      <Box flexDirection="column">
        <Text>
          <ToolCardMarker />
          Wrote <Text bold>0</Text> lines to {displayPath}
        </Text>
        <Text color={tokens.textMuted}>(empty file)</Text>
      </Box>
    )
  }
  const lines = output.content.split('\n')
  const shown = verbose ? output.content : lines.slice(0, CREATE_PREVIEW_LINES).join('\n')
  const hidden = verbose ? 0 : Math.max(0, lineCount - CREATE_PREVIEW_LINES)
  return (
    <Box flexDirection="column">
      <Text>
        <ToolCardMarker />
        Wrote <Text bold>{lineCount}</Text> {plural(lineCount, 'line')} to {displayPath}
      </Text>
      <Box width={Math.max(20, columns - CODE_BLOCK_GUTTER)}>
        <HighlightedCode code={shown} filePath={output.filePath} />
      </Box>
      {hidden > 0 ? (
        <Text color={tokens.textMuted}>
          +{hidden} more {plural(hidden, 'line')} <CtrlOToExpand />
        </Text>
      ) : null}
    </Box>
  )
}

export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown,
  {
    verbose: verboseOption,
    style,
    isTranscriptMode,
  }: { verbose: boolean; style?: 'condensed' | 'default'; isTranscriptMode?: boolean },
): React.ReactNode {
  // A transcript-mode click-expansion reveals what verbose reveals.
  const verbose = verboseOption || isTranscriptMode === true
  if (output.type === 'no-change') {
    return <NoChangeCard filePath={output.filePath} />
  }
  if (output.type === 'update') {
    return (
      <FileEditToolUpdatedMessage
        filePath={output.filePath}
        structuredPatch={output.structuredPatch}
        firstLine={firstLineOf(output.content)}
        fileContent={output.originalFile ?? ''}
        verbose={verbose}
        {...(style === 'condensed' ? { style: 'condensed' as const } : {})}
        {...(isPlanFile(output.filePath) ? { previewHint: 'preview the plan' } : {})}
      />
    )
  }
  // create — condensed mode inverts the plan handling, outside verbose only.
  const plan = isPlanFile(output.filePath)
  if (!verbose && style === 'condensed') {
    if (plan) {
      return (
        <MessageResponse>
          <CreatedFileCard output={output} verbose={true} />
        </MessageResponse>
      )
    }
    const lineCount = countLines(output.content)
    return (
      <MessageResponse>
        <Text>
          <ToolCardMarker />
          Wrote <Text bold>{lineCount}</Text> {plural(lineCount, 'line')} to{' '}
          {getDisplayPath(output.filePath)}
        </Text>
      </MessageResponse>
    )
  }
  if (!verbose && plan) {
    return <PlanHintCard />
  }
  return (
    <MessageResponse>
      <CreatedFileCard output={output} verbose={verbose} />
    </MessageResponse>
  )
}

function PlanHintCard(): React.ReactNode {
  const tokens = useMercuryTokens()
  return (
    <MessageResponse>
      <Text color={tokens.textMuted}>plan written — preview the plan to review it</Text>
    </MessageResponse>
  )
}

function NoChangeCard({ filePath }: { filePath: string }): React.ReactNode {
  const tokens = useMercuryTokens()
  return (
    <MessageResponse>
      <Text color={tokens.textMuted}>
        No changes — {getDisplayPath(filePath)} already matches the provided content
      </Text>
    </MessageResponse>
  )
}

type RejectionPreviewState =
  | { state: 'loading' }
  | { state: 'create' }
  | { state: 'update'; patch: Output['structuredPatch']; original: string }
  | { state: 'error' }

function WriteRejectionPreview({
  input,
  verbose,
}: {
  input: { file_path: string; content: string }
  verbose: boolean
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [preview, setPreview] = React.useState<RejectionPreviewState>({ state: 'loading' })

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const existing = await readFileInRange(
          input.file_path,
          0,
          undefined,
          REJECTION_SCAN_CAP_BYTES,
        )
        if (cancelled) return
        const patch = getPatchForDisplay({
          filePath: input.file_path,
          fileContents: existing.content,
          edits: [{ old_string: existing.content, new_string: input.content }],
        })
        setPreview({ state: 'update', patch, original: existing.content })
      } catch (err) {
        if (cancelled) return
        // Missing files and over-cap files preview as a creation; anything
        // else settles on the short no-changes line.
        if (err instanceof FileTooLargeError || (err as { code?: string })?.code === 'ENOENT') {
          setPreview({ state: 'create' })
        } else {
          setPreview({ state: 'error' })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [input.file_path, input.content])

  if (preview.state === 'error') {
    return (
      <MessageResponse>
        <Text color={tokens.textMuted}>no changes</Text>
      </MessageResponse>
    )
  }
  if (preview.state === 'update') {
    return (
      <FileEditToolUseRejectedMessage
        file_path={input.file_path}
        operation="update"
        patch={preview.patch}
        firstLine={firstLineOf(input.content)}
        fileContent={preview.original}
        style="condensed"
        verbose={verbose}
      />
    )
  }
  // loading and create both show the rejected-write preview.
  return (
    <FileEditToolUseRejectedMessage
      file_path={input.file_path}
      operation="write"
      content={input.content}
      firstLine={firstLineOf(input.content)}
      verbose={verbose}
    />
  )
}

export function renderToolUseRejectedMessage(
  input?: Partial<FileWriteToolInput>,
  options?: { verbose?: boolean },
): React.ReactNode {
  if (!input?.file_path || input.content === undefined) return null
  return (
    <WriteRejectionPreview
      input={{ file_path: input.file_path, content: input.content }}
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
  if (
    !verbose &&
    typeof result === 'string' &&
    extractTag(result, 'tool_use_error') !== null
  ) {
    return <ShortErrorLine text="Error writing file" />
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
