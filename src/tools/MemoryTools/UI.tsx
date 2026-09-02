// Terminal rendering for the memory verbs: one-line use rows, honest
// result rows (per-item retain outcomes, cited/degraded reflect, typed
// correct refusals).

import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import type { CorrectToolOutput, RecallOutput, ReflectOutput, RetainOutput } from './MemoryTools.js'

export function renderMemoryToolUse(
  verb: 'retain' | 'recall' | 'reflect' | 'correct',
  input?: Record<string, unknown>,
): string {
  if (!input) return ''
  switch (verb) {
    case 'retain': {
      const items = input.items
      return Array.isArray(items) ? `${items.length} fact(s)` : ''
    }
    case 'recall':
      return String(input.query ?? input.read ?? '')
    case 'reflect':
      return String(input.query ?? '')
    case 'correct':
      return `${String(input.op ?? '')} ${String(input.id ?? '')}`
  }
}

export function renderRetainResult(output?: RetainOutput): React.ReactNode {
  if (!output) return null
  return (
    <MessageResponse>
      <Text>
        {output.refused > 0 ? (
          <Text color="warning">
            {output.stored} stored · {output.refused} REFUSED
          </Text>
        ) : (
          <Text color="success">{output.stored} stored</Text>
        )}
        <Text dimColor> (pending until consolidation)</Text>
      </Text>
    </MessageResponse>
  )
}

export function renderRecallResult(output?: RecallOutput): React.ReactNode {
  if (!output) return null
  if (output.kind === 'record') {
    return (
      <MessageResponse>
        <Text dimColor>{output.found ? `read ${output.id}` : `not found: ${output.id}`}</Text>
      </MessageResponse>
    )
  }
  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text dimColor>
          {output.hits.length === 0 ? 'no memory matched (elidable)' : `${output.hits.length} hit(s)`}
        </Text>
        {output.hits.slice(0, 5).map((hit, index) => (
          <Text key={index} dimColor wrap="truncate-end">
            [{hit.id}] {hit.preview}
          </Text>
        ))}
      </Box>
    </MessageResponse>
  )
}

export function renderReflectResult(output?: ReflectOutput): React.ReactNode {
  if (!output) return null
  return (
    <MessageResponse>
      <Box flexDirection="column">
        {output.mode === 'synthesis' ? (
          <>
            <Text wrap="wrap">{output.answer}</Text>
            <Text dimColor>cited: {output.citedIds?.join(', ')}</Text>
          </>
        ) : (
          <Text dimColor>no synthesis — {output.degradedReason}</Text>
        )}
      </Box>
    </MessageResponse>
  )
}

export function renderCorrectResult(output?: CorrectToolOutput): React.ReactNode {
  if (!output) return null
  return (
    <MessageResponse>
      {output.ok ? (
        <Text>
          <Text color="success">{output.op}</Text>
          <Text dimColor>
            {' '}
            seq {output.targetSeq} → {output.newSeq} (history retained)
          </Text>
        </Text>
      ) : (
        <Text color="warning">
          {output.op} refused ({output.code})
        </Text>
      )}
    </MessageResponse>
  )
}
