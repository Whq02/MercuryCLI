import * as React from 'react'

import { truncatePathMiddle } from '../../utils/truncate.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { FilePathLink } from '../../components/FilePathLink.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { ToolCardMeta, toolCardCountColor } from '../../components/mercury-ui/toolCardMeta.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { Text } from '../../ink.js'
import type { ToolResultBlockParam } from '../../types/wire.js'
import { getTaskOutputDir } from '../../utils/task/diskOutput.js'
import { extractTag } from '../../utils/messages.js'
import { FILE_NOT_FOUND_CWD_NOTE, getDisplayPath } from '../../utils/file.js'
import { formatFileSize } from '../../utils/format.js'
import { getPlansDirectory } from '../../utils/plans.js'
import { isPathInside } from '../../utils/pathPrefix.js'
import { plural } from '../../utils/stringUtils.js'
import type { Input, Output } from './FileReadTool.js'
import { FILE_READ_TOOL_NAME } from './prompt.js'

/**
 * Read renderers: summary chrome only, never content — the transcript
 * search index must stay empty for read results.
 */

const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,20}$/

/** The task id when the path is an agent-output file, else null. */
function agentOutputTaskId(filePath: string | undefined): string | null {
  if (!filePath) return null
  try {
    const outputDir = getTaskOutputDir()
    // Separator-agnostic (TS-2): the dir is path.join() output — '\' on
    // win32 — while the guard spoke POSIX, so these rows never resolved
    // there and every plan/agent-output read painted its raw temp path.
    if (!isPathInside(filePath, outputDir)) return null
    const base = filePath.split(/[\\/]/).pop() ?? ''
    const withoutSuffix = base.endsWith('.output') ? base.slice(0, -'.output'.length) : base
    return TASK_ID_PATTERN.test(withoutSuffix) ? withoutSuffix : null
  } catch {
    return null
  }
}

function isPlanFile(filePath: string | undefined): boolean {
  if (!filePath) return false
  try {
    const plansDir = getPlansDirectory()
    return isPathInside(filePath, plansDir)
  } catch {
    return false
  }
}

export function userFacingName(input?: Partial<Input>): string {
  // The plan test wins when both somehow match.
  if (isPlanFile(input?.file_path)) return 'Read plan'
  if (agentOutputTaskId(input?.file_path) !== null) return 'Read agent output'
  return FILE_READ_TOOL_NAME
}

export function getToolUseSummary(input: Partial<Input> | undefined): string | null {
  if (!input?.file_path) return null
  const taskId = agentOutputTaskId(input.file_path)
  if (taskId !== null) return taskId
  return truncatePathMiddle(getDisplayPath(input.file_path), TOOL_SUMMARY_MAX_LENGTH)
}

export function renderToolUseMessage(
  input: Partial<Input>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!input.file_path) return null
  // Agent-output reads suppress the path parenthetical WITHOUT suppressing
  // the row — the task id is surfaced through the tag instead.
  if (agentOutputTaskId(input.file_path) !== null) return ''
  const trailers: string[] = []
  if (input.pages !== undefined) {
    trailers.push(`pages ${input.pages}`)
  } else if (verbose && (input.offset !== undefined || input.limit !== undefined)) {
    const start = input.offset ?? 1
    trailers.push(
      input.limit !== undefined ? `lines ${start}-${start + input.limit - 1}` : `from line ${start}`,
    )
  }
  // The display path rides as the link's CHILDREN: the full path when
  // verbose, the shortened display path otherwise; the trailer is plain
  // text in the same fragment.
  const displayPath = verbose ? input.file_path : getDisplayPath(input.file_path)
  return (
    <Text>
      <FilePathLink filePath={input.file_path}>{displayPath}</FilePathLink>
      {trailers.length > 0 ? ` · ${trailers.join(' · ')}` : null}
    </Text>
  )
}

export function renderToolUseTag(input?: Partial<Input>): string | null {
  const taskId = agentOutputTaskId(input?.file_path)
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
    case 'text':
      // Line count only — the output schema carries no byte totals, so a
      // byte trailer here would be invented.
      return (
        <Text>
          Read <Text bold>{output.file.numLines}</Text> {plural(output.file.numLines, 'line')}
        </Text>
      )
  }
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  // Every result branch is a single line inside the height-1 frame.
  return (
    <MessageResponse height={1}>
      <ReadResultSummary output={output} />
    </MessageResponse>
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
    // Read throws from call, so its errors are NOT wrapped in the
    // tool-use-error tag — the not-found probe runs on the raw string.
    if (result.includes(FILE_NOT_FOUND_CWD_NOTE)) {
      return <ShortErrorLine text="File not found" />
    }
    if (extractTag(result, 'tool_use_error') !== null) {
      return <ShortErrorLine text="Error reading file" />
    }
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
