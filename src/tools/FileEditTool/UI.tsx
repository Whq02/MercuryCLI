import * as React from 'react'

import { truncatePathMiddle } from '../../utils/truncate.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { FallbackToolUseRejectedMessage } from '../../components/FallbackToolUseRejectedMessage.js'
import { FileEditToolDiff } from '../../components/FileEditToolDiff.js'
import { FileEditToolUpdatedMessage } from '../../components/FileEditToolUpdatedMessage.js'
import { FileEditToolUseRejectedMessage } from '../../components/FileEditToolUseRejectedMessage.js'
import { FilePathLink } from '../../components/FilePathLink.js'
import { HighlightedCode } from '../../components/HighlightedCode.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { Text } from '../../ink.js'
import type { ToolResultBlockParam } from '../../types/wire.js'
import { FILE_NOT_FOUND_CWD_NOTE, getDisplayPath } from '../../utils/file.js'
import { extractTag } from '../../utils/messages.js'
import { getPlansDirectory } from '../../utils/plans.js'
import { isPathInside } from '../../utils/pathPrefix.js'
import { firstLineOf } from '../../utils/stringUtils.js'
import type { FileEditInput, FileEditOutput } from './types.js'

/**
 * Edit renderers: use line, result diff card, rejection preview, and error
 * classification. The unread-file matcher here must stay consistent with
 * the refusal text in FileEditTool.ts (same slice, same wording).
 */

const UNREAD_FILE_REFUSAL = 'File has not been read yet'

/** A legacy multi-edit input carries an `edits` array. */
type MaybeLegacyInput = Partial<FileEditInput> & { edits?: unknown[] }

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

export function userFacingName(input?: MaybeLegacyInput): string {
  if (isPlanFile(input?.file_path)) return 'Update plan'
  // Legacy multi-edit inputs always target an existing file.
  if (input?.edits !== undefined) return 'Update'
  if (input?.old_string === '') return 'Create'
  if (!input) return 'Update'
  return 'Update'
}

export function getToolUseSummary(input: MaybeLegacyInput | undefined): string | null {
  if (!input?.file_path) return null
  return truncatePathMiddle(getDisplayPath(input.file_path), TOOL_SUMMARY_MAX_LENGTH)
}

export function renderToolUseMessage(
  input: MaybeLegacyInput,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!input.file_path) return null
  // Plan files carry the plan path in the display name already.
  if (isPlanFile(input.file_path)) return null
  // The display path: the absolute form end-truncates the filename away at
  // 80 columns, and the Read row already shows the relative path.
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
  // The no-change card is never the diff view.
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
      {...(isPlanFile(output.filePath) ? { previewHint: 'preview the plan' } : {})}
    />
  )
}

export function renderToolUseRejectedMessage(
  input?: MaybeLegacyInput,
  options?: { verbose?: boolean; width?: number | string },
): React.ReactNode {
  if (!input?.file_path) {
    return <FallbackToolUseRejectedMessage />
  }
  // Defensive first branch: a legacy `edits` input renders the plain
  // update rejection with no diff at all.
  if (input.edits !== undefined) {
    return (
      <FileEditToolUseRejectedMessage
        file_path={input.file_path}
        operation="update"
        firstLine={null}
        verbose={options?.verbose ?? false}
      />
    )
  }
  // A new-file creation previews the content; an ordinary edit loads its
  // diff asynchronously through the bounded-window diff component.
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
    if (result.includes(UNREAD_FILE_REFUSAL)) {
      return <ShortErrorLine text="File must be read before it can be edited" />
    }
    if (result.includes(FILE_NOT_FOUND_CWD_NOTE)) {
      return <ShortErrorLine text="File not found" />
    }
    if (extractTag(result, 'tool_use_error') !== null) {
      return <ShortErrorLine text="Error editing file" />
    }
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
