import * as React from 'react'

import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { FilePathLink } from '../../components/FilePathLink.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { HighlightedCode } from '../../components/HighlightedCode.js'
import { NotebookEditToolUseRejectedMessage } from '../../components/NotebookEditToolUseRejectedMessage.js'
import { Box, Text } from '../../ink.js'
import type { ToolResultBlockParam } from '../../types/wire.js'
import { getDisplayPath } from '../../utils/file.js'
import { extractTag } from '../../utils/messages.js'
import type { Output } from './NotebookEditTool.js'

/** Notebook-edit header, rejection, error, and result renderers. */

type UiInput = {
  notebook_path?: string
  cell_id?: string
  new_source?: string
  cell_type?: 'code' | 'markdown'
  edit_mode?: 'replace' | 'insert' | 'delete'
}

const VERBOSE_SOURCE_PREVIEW_CHARS = 30

export function getToolUseSummary(input?: UiInput): string | null {
  return input?.notebook_path ? getDisplayPath(input.notebook_path) : null
}

/** Nothing unless path, source and cell type are all present — a replace
 *  that omitted cell_type renders no header at all. */
export function renderToolUseMessage(
  input?: UiInput,
  options?: { verbose?: boolean },
): React.ReactNode {
  if (!input?.notebook_path || input.new_source === undefined || !input.cell_type) return null
  if (!options?.verbose) {
    return (
      <Text>
        {/* The link target stays absolute; only the visible text is the
            display path (a relative file:// URL resolves nowhere). */}
        <FilePathLink filePath={input.notebook_path}>
          {getDisplayPath(input.notebook_path)}
        </FilePathLink>
        @{input.cell_id}
      </Text>
    )
  }
  return (
    <Text>
      <FilePathLink filePath={input.notebook_path} />@{input.cell_id},{' '}
      content: {input.new_source.slice(0, VERBOSE_SOURCE_PREVIEW_CHARS)}…, cell_type: {input.cell_type},
      edit_mode: {input.edit_mode ?? 'replace'}
    </Text>
  )
}

export function renderToolUseRejectedMessage(
  input?: UiInput,
  options?: { verbose?: boolean },
): React.ReactNode {
  return (
    <NotebookEditToolUseRejectedMessage
      notebook_path={input?.notebook_path ?? ''}
      cell_id={input?.cell_id}
      new_source={input?.new_source ?? ''}
      cell_type={input?.cell_type}
      edit_mode={input?.edit_mode}
      verbose={options?.verbose ?? false}
    />
  )
}

function ShortErrorLine({ text }: { text: string }): React.ReactNode {
  return (
    <MessageResponse height={1}>
      <Text color="error">{text}</Text>
    </MessageResponse>
  )
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!verbose && typeof result === 'string' && extractTag(result, 'tool_use_error') !== null) {
    return <ShortErrorLine text="Error editing notebook" />
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}

function ResultCard({ output }: { output: Output }): React.ReactNode {
  if (output.error) {
    return (
      <MessageResponse height={1}>
        <Text color="error">{output.error}</Text>
      </MessageResponse>
    )
  }
  // "Updated" for every mode, including insert and delete.
  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text>
          Updated cell <Text bold>{output.cell_id}</Text>:
        </Text>
        <Box marginLeft={2}>
          <HighlightedCode code={output.new_source} filePath="notebook.py" />
        </Box>
      </Box>
    </MessageResponse>
  )
}

export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown,
  _options: { verbose: boolean },
): React.ReactNode {
  return <ResultCard output={output} />
}
