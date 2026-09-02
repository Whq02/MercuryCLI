import type { ToolResultBlockParam } from '../../types/wire.js'
import React from 'react'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { Text } from '../../ink.js'
import type { Input, Output } from './SetTierTool.js'

export function userFacingName(): string {
  return 'SetTier'
}

export function renderToolUseMessage(
  input: Partial<Input>,
  _opts: { verbose: boolean },
): React.ReactNode {
  const parts: string[] = []
  if (input.model) parts.push(input.model)
  if (input.effort) parts.push(`@${input.effort}`)
  if (input.scope) parts.push(`(${input.scope})`)
  if (input.reason) parts.push(`— ${input.reason}`)
  return parts.join(' ')
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
  _opts: { verbose: boolean },
): React.ReactNode {
  if (!output.ok) {
    return <Text dimColor>tier unchanged — {output.refused}</Text>
  }
  // The surfacing contract: the ⇅ from→to line, bold so a self-switch is
  // never visually silent (the modeBand carries the standing live readout).
  return (
    <Text bold>
      {output.line}
      <Text dimColor>
        {' '}
        · {output.switchesUsed}/{output.switchCap} switches
      </Text>
    </Text>
  )
}
