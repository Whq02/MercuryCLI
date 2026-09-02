import * as React from 'react'
import { Box, Text } from '../ink.js'
import { getTotalLinesAdded, getTotalLinesRemoved } from '../cost-tracker.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import { ValueGlow } from './mercury-ui/LiveGlyphs.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import { GLOB_TOOL_NAME } from '../tools/GlobTool/prompt.js'
import { PROVIDER_SEARCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from '../tools/WebSearchTool/prompt.js'
import type { Message } from '../types/message.js'
import type { Tools } from '../Tool.js'
import type { ModelName } from '../utils/model/model.js'
import type { StreamingThinking } from '../utils/messages.js'


type Props = {
  messages: Message[]
  tools: Tools
  model: ModelName
  isLoading: boolean
  streamingThinking: StreamingThinking | null
  isThinking?: boolean
}

function MercuryTurnRollupInner({
  messages,
  model,
  isLoading,
  streamingThinking,
  isThinking: isThinkingProp,
}: Props): React.ReactNode {
  const tokens = useMercuryTokens()

  const ledeNode: React.ReactNode = null
  void isThinkingProp
  void streamingThinking
  void isLoading

  let added = 0
  let removed = 0
  let linesOk = false
  try {
    added = getTotalLinesAdded()
    removed = getTotalLinesRemoved()
    linesOk = true
  } catch {
    linesOk = false
  }

  const { fileCount, toolCount, typeBreakdown } = React.useMemo(() => {
    let toolCount = 0
    const fileSet = new Set<string>()
    let readCount = 0
    let editCount = 0
    let bashCount = 0
    let searchCount = 0
    const erroredIds = new Set<string>()
    const noChangeIds = new Set<string>()
    for (const m of messages) {
      if (m.type !== 'user') continue
      const content = m.message?.content
      if (!Array.isArray(content)) continue
      const tur = (m as { toolUseResult?: { noChange?: unknown; type?: unknown } })
        .toolUseResult
      const isNoChange =
        tur !== undefined && (tur.noChange !== undefined || tur.type === 'no-change')
      for (const block of content) {
        if (
          (block as { type?: string })?.type !== 'tool_result' ||
          typeof (block as { tool_use_id?: unknown }).tool_use_id !== 'string'
        )
          continue
        const id = (block as { tool_use_id: string }).tool_use_id
        if ((block as { is_error?: boolean }).is_error === true) erroredIds.add(id)
        else if (isNoChange) noChangeIds.add(id)
      }
    }
    for (const m of messages) {
      if (m.type !== 'assistant') continue
      const content = m.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block?.type !== 'tool_use') continue
        toolCount++
        switch (block.name) {
          case FILE_READ_TOOL_NAME:
            readCount++
            break
          case FILE_EDIT_TOOL_NAME:
          case FILE_WRITE_TOOL_NAME: {
            editCount++
            const fp = (block.input as { file_path?: unknown } | undefined)
              ?.file_path
            const blockId = (block as { id?: string }).id ?? ''
            if (
              typeof fp === 'string' &&
              !erroredIds.has(blockId) &&
              !noChangeIds.has(blockId)
            )
              fileSet.add(fp)
            break
          }
          case BASH_TOOL_NAME:
            bashCount++
            break
          case GREP_TOOL_NAME:
          case GLOB_TOOL_NAME:
          case WEB_SEARCH_TOOL_NAME:
          case PROVIDER_SEARCH_TOOL_NAME:
            searchCount++
            break
          default:
            break
        }
      }
    }

    const typeParts: string[] = []
    if (readCount > 0) typeParts.push(`${readCount} read`)
    if (editCount > 0) typeParts.push(`${editCount} edit`)
    if (bashCount > 0) typeParts.push(`${bashCount} run`)
    if (searchCount > 0) typeParts.push(`${searchCount} search`)
    const typeBreakdown = typeParts.length >= 2 ? typeParts.join(' · ') : null
    return { fileCount: fileSet.size, toolCount, typeBreakdown }
  }, [messages])

  const hasFiles = fileCount > 0
  const hasLines = linesOk && (added > 0 || removed > 0)
  const hasTools = toolCount > 0
  const showSpine = hasFiles || hasLines || hasTools

  let spineNode: React.ReactNode = null
  if (showSpine) {
    const segs: React.ReactNode[] = []
    segs.push(<Text key="scope" color={tokens.textMuted}>session</Text>)
    if (hasFiles) {
      if (segs.length > 0) segs.push(<Text key="s0" color={tokens.textMuted}> · </Text>)
      segs.push(
        <Text key="files">
          <Text color={tokens.success}>{GLYPH.ok} </Text>
          <ValueGlow value={fileCount} color={tokens.textPrimary}>
            {fileCount} file{fileCount === 1 ? '' : 's'} changed
          </ValueGlow>
        </Text>,
      )
    }
    if (hasLines) {
      if (segs.length > 0) segs.push(<Text key="s1" color={tokens.textMuted}> · </Text>)
      segs.push(
        <Text key="lines">
          <ValueGlow value={`${added}/${removed}`} color={tokens.textSecondary}>
            +{added} / -{removed}
          </ValueGlow>
        </Text>,
      )
    }
    if (hasTools) {
      if (segs.length > 0) segs.push(<Text key="s2" color={tokens.textMuted}> · </Text>)
      segs.push(
        <Text key="tools" color={tokens.textMuted}>
          {toolCount} tool{toolCount === 1 ? '' : 's'}
          {typeBreakdown ? ` (${typeBreakdown})` : ''}
        </Text>,
      )
    }
    spineNode = (
      <Text wrap="truncate-end">{segs}</Text>
    )
  }

  if (!showSpine && !ledeNode) return null

  return (
    <Box flexDirection="column" paddingX={1}>
      {spineNode}
      {ledeNode}
    </Box>
  )
}

export const MercuryTurnRollup = React.memo(MercuryTurnRollupInner)
