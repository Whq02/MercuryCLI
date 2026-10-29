import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { conflictNotice } from '../../mneme/mnemeContradiction.js'
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

export function conflictLines(outcomes: readonly RetainOutput['outcomes'][number][]): string[] {
  const lines: string[] = []
  for (const outcome of outcomes) {
    if (outcome.status === 'refused' && outcome.conflict !== undefined) lines.push(conflictNotice(outcome.conflict))
  }
  return lines
}

export function renderRetainResult(output?: RetainOutput): React.ReactNode {
  if (!output) return null
  const conflicts = conflictLines(output.outcomes)
  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text>
          {output.refused > 0 ? (
            <Text color="warning">
              {output.stored} stored · {output.refused} REFUSED
            </Text>
          ) : (
            <Text color="success">{output.stored} stored</Text>
          )}
          <Text dimColor>{output.shelf ? (output.shelf.landed ? ' (pinned rule on the shelf)' : ' (pinned rule waits for the next maintenance pass)') : ' (pending until consolidation)'}</Text>
        </Text>
        {conflicts.map((line, index) => (
          <Text key={index} color="warning" wrap="truncate-end">
            {line}
          </Text>
        ))}
      </Box>
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
          {output.pointers.length === 0 ? 'no memory matched (elidable)' : `${output.pointers.length} pointer(s)`}
        </Text>
        {output.pointers.slice(0, 5).map((pointer, index) => (
          <Text key={index} dimColor wrap="truncate-end">
            [{pointer.id}] {pointer.kind} · {pointer.title}
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
      {output.ok && 'draft' in output ? (
        <Text>
          <Text color="success">{output.op}</Text>
          <Text dimColor>
            {' '}
            {output.newId !== null ? `draft ${output.targetId} → ${output.newId}` : `draft ${output.targetId} struck`} (no history: a draft)
          </Text>
        </Text>
      ) : output.ok ? (
        <Text>
          <Text color="success">{output.op}</Text>
          <Text dimColor>
            {' '}
            seq {output.targetSeq} → {output.newSeq} (history retained)
          </Text>
        </Text>
      ) : output.code === 'user-kept-rule' ? (
        <Text>
          <Text>rule kept</Text>
          <Text dimColor> you kept the rule; nothing changed</Text>
        </Text>
      ) : (
        <Box flexDirection="column">
          <Text color="warning">
            {output.op} refused ({output.code})
          </Text>
          {output.conflict !== undefined ? (
            <Text color="warning" wrap="truncate-end">
              {conflictNotice(output.conflict)}
            </Text>
          ) : null}
        </Box>
      )}
    </MessageResponse>
  )
}
