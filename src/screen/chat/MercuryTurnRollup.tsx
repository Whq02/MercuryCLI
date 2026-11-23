import * as React from 'react'
import { Box, Text } from '../themedRenderer.js'
import { getTotalLinesAdded, getTotalLinesRemoved } from '../../models/usage/sessionCost.js'
import { GLYPH } from '../theme/glyphs.js'
import { ValueGlow } from '../widgets/LiveGlyphs.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { CockpitActiveContext } from '../cockpit/cockpitActiveContext.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/kit/names/fileEdit.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/kit/names/fileWrite.js'
import { FILE_READ_TOOL_NAME } from '../../tools/kit/names/fileRead.js'
import { BASH_TOOL_NAME } from '../../tools/kit/names/bash.js'
import { GREP_TOOL_NAME } from '../../tools/grep/prompt.js'
import { GLOB_TOOL_NAME } from '../../tools/glob/prompt.js'
import { PROVIDER_SEARCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from '../../tools/web-search/prompt.js'
import type { Message } from '../../engine/message-shapes/message.js'
import type { Tools } from '../../tools/kit/tool.js'
import type { ModelName } from '../../models/catalogue/engineModel.js'
import type { StreamingThinking } from '../../engine/messages/messages.js'
import { passedOver } from '../../platform/errors/passedOver.js'


type Props = {
  messages: Message[]
  tools?: Tools
  model?: ModelName
  isLoading?: boolean
  streamingThinking?: StreamingThinking | null
  isThinking?: boolean
}

type Spine = { fileCount: number; toolCount: number; typeBreakdown: string | null }

export function rollupSpineOf(messages: readonly Message[]): Spine {
  let toolCount = 0
  const fileSet = new Set<string>()
  let readCount = 0
  let editCount = 0
  let bashCount = 0
  let searchCount = 0
  const erroredIds = new Set<string>()
  const noChangeIds = new Set<string>()
  const settledIds = new Set<string>()
  for (const m of messages) {
    if (m.type !== 'user') continue
    const content = m.message?.content
    if (!Array.isArray(content)) continue
    const tur = (m as { toolUseResult?: { noChange?: unknown; type?: unknown } }).toolUseResult
    const isNoChange = tur !== undefined && (tur.noChange !== undefined || tur.type === 'no-change')
    for (const block of content) {
      if ((block as { type?: string })?.type !== 'tool_result' || typeof (block as { tool_use_id?: unknown }).tool_use_id !== 'string') continue
      const id = (block as { tool_use_id: string }).tool_use_id
      if ((block as { is_error?: boolean }).is_error === true) erroredIds.add(id)
      else if (isNoChange) noChangeIds.add(id)
      else settledIds.add(id)
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
          const fp = (block.input as { file_path?: unknown } | undefined)?.file_path
          const blockId = (block as { id?: string }).id ?? ''
          if (typeof fp === 'string' && settledIds.has(blockId) && !erroredIds.has(blockId) && !noChangeIds.has(blockId)) fileSet.add(fp)
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
}

function sessionLines(): { added: number; removed: number } | null {
  try {
    return { added: getTotalLinesAdded(), removed: getTotalLinesRemoved() }
  } catch (error) {
    passedOver(error)
    return null
  }
}

function MercuryTurnRollupInner({ messages }: Props): React.ReactNode {
  const tokens = useMercuryTokens()
  const inCockpit = React.useContext(CockpitActiveContext)
  const { fileCount, toolCount, typeBreakdown } = React.useMemo(() => rollupSpineOf(messages), [messages])
  const lines = sessionLines()

  const hasFiles = fileCount > 0
  const hasLines = lines !== null && (lines.added > 0 || lines.removed > 0)
  const hasTools = toolCount > 0
  if (inCockpit || !(hasFiles || hasLines || hasTools)) return null

  const segs: React.ReactNode[] = [
    <Text key="scope" color={tokens.textMuted}>session</Text>,
  ]
  if (hasFiles) {
    segs.push(<Text key="s0" color={tokens.textMuted}> · </Text>)
    segs.push(
      <Text key="files">
        <Text color={tokens.success}>{GLYPH.ok} </Text>
        <ValueGlow value={fileCount} color={tokens.textPrimary}>
          {fileCount} file{fileCount === 1 ? '' : 's'} changed
        </ValueGlow>
      </Text>,
    )
  }
  if (hasLines && lines !== null) {
    segs.push(<Text key="s1" color={tokens.textMuted}> · </Text>)
    segs.push(
      <Text key="lines">
        <ValueGlow value={`${lines.added}/${lines.removed}`} color={tokens.textSecondary}>
          +{lines.added} / -{lines.removed}
        </ValueGlow>
      </Text>,
    )
  }
  if (hasTools) {
    segs.push(<Text key="s2" color={tokens.textMuted}> · </Text>)
    segs.push(
      <Text key="tools" color={tokens.textMuted}>
        {toolCount} tool{toolCount === 1 ? '' : 's'}
        {typeBreakdown ? ` (${typeBreakdown})` : ''}
      </Text>,
    )
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text wrap="truncate-end">{segs}</Text>
    </Box>
  )
}

export const MercuryTurnRollup = React.memo(MercuryTurnRollupInner, (prev, next) => prev.messages === next.messages)
