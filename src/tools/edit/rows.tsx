import * as React from 'react'

import { truncatePathMiddle } from '../../platform/text/truncate.js'
import { FallbackToolUseErrorMessage, ShortErrorLine } from '../kit/FallbackToolUseErrorMessage.js'
import { isDenialResultText } from '../../engine/message-shapes/rejectionText.js'
import { FallbackToolUseRejectedMessage } from '../kit/FallbackToolUseRejectedMessage.js'
import { EditDiff } from './EditDiff.js'
import { consentContentWidth } from '../../permissions/cards/consentBodyBudget.js'
import { EditUpdatedMessage } from './EditUpdatedMessage.js'
import { FilePathLink } from '../kit/FilePathLink.js'
import { HighlightedCode } from '../../screen/highlighted-code/HighlightedCode.js'
import { MessageResponse } from '../kit/MessageResponse.js'
import { useMercuryTokens } from '../../screen/widgets/useMercuryTokens.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../kit/toolLimits.js'
import { Text } from '../../screen/themedRenderer.js'
import type { ToolResultBlockParam } from '../../engine/message-shapes/wire.js'
import { getDisplayPath } from '../../platform/files/file.js'
import { firstLineOf } from '../../platform/text/strings.js'
import { toolErrorReason } from '../kit/toolErrorReason.js'
import type { FileEditInput, FileEditOutput } from './schema.js'


export function userFacingName(input?: Partial<FileEditInput>): string {
  return input?.old_string === '' ? 'Create' : 'Update'
}

export function getToolUseSummary(input: { file_path?: string } | undefined): string | null {
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
      {verbose ? input.file_path : getDisplayPath(input.file_path)}
    </FilePathLink>
  )
}

function NoChangeMessage({ filePath }: { filePath: string }): React.ReactNode {
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
    return <NoChangeMessage filePath={output.filePath} />
  }
  return (
    <EditUpdatedMessage
      filePath={output.filePath}
      structuredPatch={output.structuredPatch}
      firstLine={firstLineOf(output.originalFile)}
      fileContent={output.originalFile}
      verbose={verbose}
      style={style === 'condensed' ? 'condensed' : undefined}
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
  const availableWidth =
    typeof options?.width === 'number' ? consentContentWidth(options.width) : undefined
  if (input.old_string === '') {
    return (
      <MessageResponse>
        <HighlightedCode
          code={input.new_string ?? ''}
          filePath={input.file_path}
          width={availableWidth}
        />
      </MessageResponse>
    )
  }
  return (
    <EditDiff
      file_path={input.file_path}
      edits={[
        {
          old_string: input.old_string,
          new_string: input.new_string,
          replace_all: input.replace_all,
        },
      ]}
      availableWidth={availableWidth}
    />
  )
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!verbose && typeof result === 'string' && !isDenialResultText(result)) {
    return <ShortErrorLine text={toolErrorReason(result, 'Error editing file')} />
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
