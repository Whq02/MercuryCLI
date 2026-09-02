// Terminal rendering of eval cells: one cell card per call — language chip
// and title on the use line, a live output tail plus nested bridge tool
// events while running, and a collapsed result preview with honest chips
// (cancelled · truncated · kernel notes) on completion.

import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Message as MessageComponent } from '../../components/Message.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { CtrlOToExpand, SubAgentProvider } from '../../components/CtrlOToExpand.js'
import { FallbackToolUseRejectedMessage } from '../../components/FallbackToolUseRejectedMessage.js'
import type { ProgressMessage } from '../../types/message.js'
import type { EvalToolProgress } from '../../types/tools.js'
import type { Tools } from '../../Tool.js'
import { buildSubagentLookups } from '../../utils/messages.js'
import type { EvalToolOutput } from './EvalTool.js'

const EMPTY_SET: Set<string> = new Set()

function evalProgressOf(progressMessages: readonly ProgressMessage[]): EvalToolProgress[] {
  const out: EvalToolProgress[] = []
  for (const message of progressMessages) {
    const data = message.data as { type?: string } | undefined
    if (data?.type === 'eval_progress') out.push(data as EvalToolProgress)
  }
  return out
}

export function renderEvalToolUseMessage(
  input?: Partial<{ language: string; title: string; code: string; reset: boolean }>,
): string {
  if (!input) return ''
  const parts: string[] = []
  if (input.language) parts.push(input.language)
  if (input.title) parts.push(input.title)
  else if (typeof input.code === 'string') {
    const firstLine = input.code.split('\n').find(line => line.trim()) ?? ''
    parts.push(firstLine.trim().slice(0, 60))
  }
  if (input.reset) parts.push('(reset)')
  return parts.join(' · ')
}

export function renderEvalProgressMessage(
  progressMessages: readonly ProgressMessage[],
  options: { tools?: Tools; verbose?: boolean },
): React.ReactNode {
  const events = evalProgressOf(progressMessages)
  if (events.length === 0) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>Starting kernel…</Text>
      </MessageResponse>
    )
  }
  const nested = events.filter(e => e.kind === 'nested')
  const lastOutput = [...events].reverse().find(e => e.kind === 'output')
  const lookups = buildSubagentLookups([])
  const shown = nested.slice(-4)
  return (
    <Box flexDirection="column">
      {nested.length > shown.length ? (
        <Text dimColor>
          +{nested.length - shown.length} earlier bridge call(s) <CtrlOToExpand />
        </Text>
      ) : null}
      <SubAgentProvider>
        {shown.map((row, index) => (
          <MessageResponse key={index}>
            <MessageComponent
              message={(row as Extract<EvalToolProgress, { kind: 'nested' }>).message as never}
              tools={options.tools ?? ([] as never)}
              commands={[] as never}
              verbose={false}
              addMargin={false}
              shouldAnimate={false}
              shouldShowDot={false}
              isTranscriptMode={false}
              isStatic={true}
              inProgressToolUseIDs={EMPTY_SET}
              progressMessagesForMessage={[] as never}
              lookups={lookups as never}
            />
          </MessageResponse>
        ))}
      </SubAgentProvider>
      {lastOutput && lastOutput.kind === 'output' && lastOutput.tail.trim() ? (
        <MessageResponse>
          <Box flexDirection="column">
            {lastOutput.tail
              .split('\n')
              .slice(-5)
              .map((line, index) => (
                <Text key={index} dimColor wrap="truncate-end">
                  {line}
                </Text>
              ))}
          </Box>
        </MessageResponse>
      ) : null}
    </Box>
  )
}

const PREVIEW_LINES = 10

export function renderEvalResultMessage(
  output?: EvalToolOutput,
  _progressMessages?: readonly ProgressMessage[],
  options?: { verbose?: boolean },
): React.ReactNode {
  if (!output) return null
  const verbose = options?.verbose === true
  const chips: string[] = []
  if (output.status === 'cancelled') chips.push('cancelled')
  if (output.status === 'error') chips.push('error')
  if (output.stdout.truncated || output.stderr.truncated) chips.push('truncated')
  if (output.spillPath) chips.push('spilled')
  const bodyParts: string[] = []
  if (output.stdout.text.trim()) bodyParts.push(output.stdout.text)
  if (output.stderr.text.trim()) bodyParts.push(output.stderr.text)
  if (output.resultRepr) bodyParts.push(`⇒ ${output.resultRepr}`)
  if (output.error) bodyParts.push(`${output.error.name}: ${output.error.value}`)
  const body = bodyParts.join('\n')
  const lines = body.split('\n').filter(line => line.length > 0)
  const shown = verbose ? lines : lines.slice(0, PREVIEW_LINES)
  const hidden = lines.length - shown.length
  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text>
          <Text color={output.status === 'ok' ? 'success' : output.status === 'cancelled' ? 'warning' : 'error'}>
            {output.status === 'ok' ? 'ran' : output.status}
          </Text>
          <Text dimColor>
            {' '}
            · {output.language} · cell {output.executionCount}
            {chips.length > 0 ? ` · ${chips.join(' · ')}` : ''}
            {output.displays.length > 0 ? ` · ${output.displays.length} display(s)` : ''}
          </Text>
        </Text>
        {shown.map((line, index) => (
          <Text key={index} dimColor wrap="truncate-end">
            {line}
          </Text>
        ))}
        {hidden > 0 ? (
          <Text dimColor>
            … +{hidden} more line(s) <CtrlOToExpand />
          </Text>
        ) : null}
        {verbose
          ? output.annotations.map((note, index) => (
              <Text key={`a${index}`} dimColor italic>
                {note}
              </Text>
            ))
          : null}
      </Box>
    </MessageResponse>
  )
}

export function renderEvalRejectedMessage(): React.ReactNode {
  return <FallbackToolUseRejectedMessage />
}
