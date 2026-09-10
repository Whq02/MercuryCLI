import type { ToolResultBlockParam } from '../../types/wire.js'
import React from 'react'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { FAINT } from '../../components/mercuryPalette.js'
import { WithCardTone } from '../../components/mercury-ui/toolCardGrammar.js'
import { Box, Text } from '../../ink.js'
import type { Input, Output } from './ComputerTool.js'

export function userFacingName(): string {
  return 'Computer'
}

const clip = (text: string, cap: number): string => (text.length > cap ? `${text.slice(0, cap)}…` : text)

export function renderToolUseMessage(input: Partial<Input>, _opts: { verbose: boolean }): React.ReactNode {
  if (!input.action) return null
  const parts: string[] = [input.action]
  const modifiers = input.modifiers && input.modifiers.length > 0 ? ` +${input.modifiers.join('+')}` : ''
  switch (input.action) {
    case 'screenshot':
      if (typeof input.display === 'number') parts.push(`display ${input.display}`)
      break
    case 'click':
    case 'doubleClick':
    case 'rightClick':
    case 'move':
      parts.push(`(${input.x}, ${input.y})${modifiers}`)
      break
    case 'drag':
      parts.push(`(${input.x}, ${input.y}) → (${input.toX}, ${input.toY})${modifiers}`)
      break
    case 'scroll':
      parts.push(`(${input.x}, ${input.y}) by ${input.dx ?? 0}, ${input.dy ?? 0}${modifiers}`)
      break
    case 'type':
      if (typeof input.text === 'string') parts.push(`"${clip(JSON.stringify(input.text).slice(1, -1), 30)}" (${input.text.length} chars)`)
      break
    case 'key':
      parts.push(input.key ?? '')
      break
    case 'hold':
      parts.push(`${input.key ?? ''} ${input.durationMs ?? 0}ms`)
      break
    case 'wait':
      parts.push(`${input.durationMs ?? 1000}ms`)
      break
    default:
      break
  }
  return parts.filter(Boolean).join(' ')
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}

export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const lines = (output.result ?? '').split('\n')
  const shown = verbose ? lines : lines.slice(0, 10)
  return (
    <WithCardTone state={output.outcome}>
      {({ glyph, tone }) => (
        <Box flexDirection="column">
          <Text>
            <Text color={tone}>{glyph} </Text>
            <Text color={FAINT}>computer {output.action}</Text>
          </Text>
          {shown.map((line, i) => (
            <Text key={i} color={FAINT}>
              {'  '}
              {line}
            </Text>
          ))}
          {!verbose && lines.length > shown.length ? (
            <Text color={FAINT}>{`  … ${lines.length - shown.length} more line(s)`}</Text>
          ) : null}
        </Box>
      )}
    </WithCardTone>
  )
}
