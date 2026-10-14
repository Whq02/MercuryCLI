import * as React from 'react'

import { truncatePathMiddle } from '../../utils/truncate.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { FallbackToolUseRejectedMessage } from '../../components/FallbackToolUseRejectedMessage.js'
import { FileEditToolDiff } from '../../components/FileEditToolDiff.js'
import { consentContentWidth } from '../../components/permissions/consentBodyBudget.js'
import { FileEditToolUpdatedMessage } from '../../components/FileEditToolUpdatedMessage.js'
import { FilePathLink } from '../../components/FilePathLink.js'
import { HighlightedCode } from '../../components/HighlightedCode.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { Text } from '../../ink.js'
import type { ToolResultBlockParam } from '../../types/wire.js'
import { getDisplayPath } from '../../utils/file.js'
import { firstLineOf } from '../../utils/stringUtils.js'
import { toolErrorReason } from '../../utils/toolErrorReason.js'
import type { FileEditInput, FileEditOutput } from './types.js'


export function userFacingName(input?: Partial<FileEditInput>): string {
  if (input?.old_string === '') return 'Create'
  return 'Update'
}

export function getToolUseSummary(input: Partial<FileEditInput> | undefined): string | null {
  if (!input?.file_path) return null
  return truncatePathMiddle(getDisplayPath(input.file_path), TOOL_SUMMARY_MAX_LENGTH)
}

export function renderToolUseMessage(
  input: Partial<FileEditInput>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!input.file_path) return null
  return (
    <FilePathLink filePath={input.file_path}>
      {getDisplayPath(input.file_path)}
    </FilePathLink>
  )
}

function NoChangeCard({ filePath }: { filePath: string }): React.ReactNode {
  const tokens = useMercuryTokens()
  return (
    <MessageResponse>
      <Text color={tokens.textMuted}>
        No changes — {getDisplayPath(filePath)} already matches the requested content
      </Text>
    </MessageResponse>
  )
}

export function renderToolResultMessage(
  output: FileEditOutput,
  _progressMessages: unknown,
  { verbose, style }: { verbose: boolean; style?: 'condensed' | 'default' },
): React.ReactNode {
  if (output.noChange) {
    return <NoChangeCard filePath={output.filePath} />
  }
  return (
    <FileEditToolUpdatedMessage
      filePath={output.filePath}
      structuredPatch={output.structuredPatch}
      firstLine={firstLineOf(output.originalFile)}
      fileContent={output.originalFile}
      verbose={verbose}
      {...(style === 'condensed' ? { style: 'condensed' as const } : {})}
    />
  )
}

export function renderToolUseRejectedMessage(
  input?: Partial<FileEditInput>,
  options?: { verbose?: boolean; width?: number | string },
): React.ReactNode {
  if (!input?.file_path) {
    return <FallbackToolUseRejectedMessage />
  }
  if (input.old_string === '') {
    return (
      <MessageResponse>
        <HighlightedCode code={input.new_string ?? ''} filePath={input.file_path} />
      </MessageResponse>
    )
  }
  return (
    <FileEditToolDiff
      file_path={input.file_path}
      edits={[
        {
          old_string: input.old_string ?? '',
          new_string: input.new_string ?? '',
          replace_all: input.replace_all ?? false,
        },
      ]}
      {...(typeof options?.width === 'number' ? { availableWidth: consentContentWidth(options.width) } : {})}
    />
  )
}

function ShortErrorLine({ text }: { text: string }): React.ReactNode {
  const tokens = useMercuryTokens()
  return (
    <MessageResponse>
      <Text color={tokens.warning}>
        {GLYPH.warn} {text}
      </Text>
    </MessageResponse>
  )
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!verbose && typeof result === 'string') {
    return <ShortErrorLine text={toolErrorReason(result, 'Error editing file')} />
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
