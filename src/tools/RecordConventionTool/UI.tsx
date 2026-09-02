import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import { truncate } from '../../utils/format.js'
import type { RecordConventionOutput } from './RecordConventionTool.js'

export function renderRecordConventionToolUseMessage(
  input: Partial<{ rule: string; replaces: string }>,
): React.ReactNode {
  return input.rule ? truncate(input.rule, 72, true) : ''
}

export function renderRecordConventionResultMessage(
  output: RecordConventionOutput,
): React.ReactNode {
  return (
    <MessageResponse>
      {output.action === 'recorded' || output.action === 'updated' ? (
        <Text>
          {output.action === 'recorded' ? 'Recorded' : 'Merged'} into{' '}
          <Text bold>{output.path?.split(/[\\/]/).pop() ?? 'the estate'}</Text>
        </Text>
      ) : (
        <Text dimColor>{output.detail}</Text>
      )}
    </MessageResponse>
  )
}
