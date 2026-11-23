import * as React from 'react'
import { Text } from '../../screen/themedRenderer.js'
import type { ToolResultBlockParam } from '../../engine/message-shapes/wire.js'
import { jsonStringify } from '../../platform/logs/slowOperations.js'

type Confirmed = { message: string }

export function contextOnlyTraits() {
  return {
    shouldDefer: true,
    maxResultSizeChars: 10_000,
    isConcurrencySafe: (): boolean => false,
    isReadOnly: (): boolean => true,
    renderToolResultMessage: (output: Confirmed): React.ReactNode => <Text dimColor>{output.message}</Text>,
    mapToolResultToToolResultBlockParam: (output: Confirmed, toolUseID: string): ToolResultBlockParam => ({
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }),
  } as const
}

export function refusal(reason: string): Error {
  return new Error(`refused: ${reason}`)
}
