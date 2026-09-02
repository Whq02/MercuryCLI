import * as React from 'react'

import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { InlineChangeView, type InlineChangeViewData } from '../../components/InlineChangeView.js'
import { FAINT } from '../../components/mercuryPalette.js'
import { WithCardTone } from '../../components/mercury-ui/toolCardGrammar.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { Box, Text } from '../../ink.js'
import type { ToolResultBlockParam } from '../../types/wire.js'
import { truncate } from '../../utils/format.js'

/**
 * AstEdit renderers. A dry run paints the ONE inline change view in its
 * 'proposed' state (amber — never mistakable for an applied change); an
 * apply paints it 'applied'; everything else is bounded text.
 */

type RenderInput = { pattern?: string; rewrite?: string; path?: string; glob?: string; apply?: boolean }

type RenderOutput = {
  state: 'dry-run' | 'applied' | 'no-change' | 'no-matches'
  text: string
  matchCount: number
  fileCount: number
  changeView?: InlineChangeViewData
}

export function getToolUseSummary(input: RenderInput | undefined): string | null {
  if (!input?.pattern) return null
  const head = `${input.pattern} → ${input.rewrite ?? ''}`
  return truncate(`${input.apply ? 'apply ' : 'dry run '}${head}`, TOOL_SUMMARY_MAX_LENGTH)
}

export function renderToolUseMessage(input: RenderInput, _options: { verbose: boolean }): React.ReactNode {
  if (!input.pattern) return null
  const where = [input.path, input.glob].filter(Boolean).join(' ')
  return (
    <Text>
      {input.pattern}
      <Text dimColor> → </Text>
      {input.rewrite === '' ? <Text dimColor>(delete)</Text> : input.rewrite}
      {where ? <Text dimColor> in {where}</Text> : null}
      <Text dimColor> {input.apply ? '(apply)' : '(dry run)'}</Text>
    </Text>
  )
}

function stateWord(output: RenderOutput): string {
  switch (output.state) {
    case 'dry-run':
      return 'proposed'
    case 'applied':
      return 'applied'
    case 'no-matches':
      return 'no matches'
    default:
      return 'no change'
  }
}

function toneKey(output: RenderOutput): string {
  switch (output.state) {
    case 'dry-run':
      return 'queued' // amber family: proposed ≠ applied
    case 'applied':
      return 'succeeded'
    default:
      return 'no-change'
  }
}

export function renderToolResultMessage(
  output: RenderOutput,
  _progressMessages: unknown[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (output.changeView && output.changeView.files.some(f => f.hunks.length > 0)) {
    return <InlineChangeView data={output.changeView} verbose={verbose} />
  }
  const lines = (output.text ?? '').split('\n')
  const shown = verbose ? lines : lines.slice(0, 12)
  return (
    <WithCardTone state={toneKey(output)}>
      {({ glyph, tone }) => (
      <Box flexDirection="column">
        <Text>
          <Text color={tone}>{glyph} </Text>
          <Text color={FAINT}>structural edit</Text>
          <Text color={tone}> {stateWord(output)}</Text>
        </Text>
        {shown.map((line, i) => (
          <Text key={i} wrap="truncate-end">
            {line || ' '}
          </Text>
        ))}
        {!verbose && lines.length > shown.length ? (
          <Text dimColor>… +{lines.length - shown.length} lines (ctrl+o expands)</Text>
        ) : null}
      </Box>
  
      )}
    </WithCardTone>
  )
}

export function renderToolUseRejectedMessage(): React.ReactNode {
  return <Text dimColor>Structural edit not applied (declined)</Text>
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
