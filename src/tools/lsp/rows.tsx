import * as React from 'react'

import { FallbackToolUseErrorMessage, ShortErrorLine } from '../kit/FallbackToolUseErrorMessage.js'
import { isDenialResultText } from '../../engine/message-shapes/rejectionText.js'
import { InlineChangeView } from '../kit/InlineChangeView.js'
import { MessageResponse } from '../kit/MessageResponse.js'
import { CtrlOToExpand } from '../../screen/messages/CtrlOToExpand.js'
import { WithCardTone } from '../../screen/widgets/toolCardGrammar.js'
import { useMercuryTokens } from '../../screen/widgets/useMercuryTokens.js'
import { Box, Text } from '../../screen/themedRenderer.js'
import { LSP_ONE_LINE_MAX } from '../../integrations/lsp/failureWords.js'
import type { ToolResultBlockParam } from '../../engine/message-shapes/wire.js'
import { getDisplayPath } from '../../platform/files/file.js'
import { extractTag } from '../../engine/messages/messages.js'
import { collapseAndClip } from '../../platform/text/strings.js'
import { getSymbolAtPosition } from './symbolContext.js'
import type { Output } from './lspTools.js'


type RenderInput = Partial<{
  operation: string
  filePath: string
  line: number
  character: number
  newName: string
  apply: boolean
  actionIndex: number
  actionId: string
}>

type ResultLabel = { singular: string; plural: string; found?: string }

const RESULT_LABELS: Record<string, ResultLabel> = {
  goToDefinition: { singular: 'definition', plural: 'definitions' },
  findReferences: { singular: 'reference', plural: 'references' },
  hover: { singular: 'result', plural: 'results', found: 'hover information available' },
  documentSymbol: { singular: 'symbol', plural: 'symbols' },
  workspaceSymbol: { singular: 'symbol', plural: 'symbols' },
  goToImplementation: { singular: 'implementation', plural: 'implementations' },
  prepareCallHierarchy: { singular: 'item', plural: 'items' },
  incomingCalls: { singular: 'caller', plural: 'callers' },
  outgoingCalls: { singular: 'callee', plural: 'callees' },
  diagnostics: { singular: 'diagnostic', plural: 'diagnostics' },
  rename: { singular: 'edit', plural: 'edits' },
  codeActions: { singular: 'action', plural: 'actions' },
  switchSourceHeader: { singular: 'file', plural: 'files' },
  typeDefinition: { singular: 'definition', plural: 'definitions' },
  serverStatus: { singular: 'server', plural: 'servers' },
  workspaceDiagnostics: { singular: 'diagnostic', plural: 'diagnostics' },
  pathRename: { singular: 'edit', plural: 'edits' },
  fixDiagnostic: { singular: 'fix', plural: 'fixes' },
  formatDocument: { singular: 'edit', plural: 'edits' },
  formatRange: { singular: 'edit', plural: 'edits' },
  organizeImports: { singular: 'edit', plural: 'edits' },
  moveSymbol: { singular: 'edit', plural: 'edits' },
}

function labelFor(operation: string, count: number): string {
  const labels = RESULT_LABELS[operation] ?? { singular: 'result', plural: 'results' }
  return count === 1 ? labels.singular : labels.plural
}

const SYMBOL_ORIENTED_OPERATIONS = new Set([
  'goToDefinition',
  'findReferences',
  'hover',
  'goToImplementation',
])

export function renderToolUseMessage(
  input: RenderInput,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!input.operation) return null
  const file = input.filePath
    ? verbose
      ? input.filePath
      : getDisplayPath(input.filePath)
    : undefined
  const symbol =
    input.filePath && input.line !== undefined && input.character !== undefined
      ? getSymbolAtPosition(input.filePath, input.line - 1, input.character - 1)
      : null

  if (SYMBOL_ORIENTED_OPERATIONS.has(input.operation) && file) {
    if (symbol) {
      return (
        <Text>
          {input.operation} <Text bold>{symbol}</Text> <Text dimColor>{file}</Text>
        </Text>
      )
    }
    return (
      <Text>
        {input.operation} <Text dimColor>{file}</Text>
        {input.line !== undefined && input.character !== undefined ? (
          <Text dimColor>
            {' '}
            {input.line}:{input.character}
          </Text>
        ) : null}
      </Text>
    )
  }
  if (input.operation === 'rename' && file) {
    return (
      <Text>
        rename {symbol ? <Text bold>{symbol} </Text> : null}
        {input.newName ? <Text>→ {input.newName} </Text> : null}
        <Text dimColor>{file}</Text>{' '}
        <Text bold={input.apply === true}>{input.apply === true ? 'APPLY' : 'preview'}</Text>
      </Text>
    )
  }
  if (input.operation === 'codeActions' && file) {
    return (
      <Text>
        codeActions <Text dimColor>{file}</Text>
        {input.line !== undefined && input.character !== undefined ? (
          <Text dimColor>
            {' '}
            {input.line}:{input.character}
          </Text>
        ) : null}{' '}
        {input.apply === true ? (
          <Text bold>APPLY [{input.actionIndex ?? '?'}]</Text>
        ) : (
          <Text>list</Text>
        )}
      </Text>
    )
  }
  if (file) {
    return (
      <Text>
        {input.operation} <Text dimColor>{file}</Text>
      </Text>
    )
  }
  return input.operation
}

function OutcomeBadge({ output }: { output: Output }): React.ReactNode {
  if (!output.outcome) return null
  let label: string
  let toneState: string
  if (output.outcome === 'succeeded') {
    if (output.applied === true) {
      label = 'APPLIED'
      toneState = 'applied'
    } else if (output.applied === false) {
      label = 'preview'
      toneState = 'prepared'
    } else {
      label = ''
      toneState = 'applied'
    }
  } else {
    label = output.applied === true ? output.outcome.toUpperCase() : output.outcome
    toneState = output.outcome
  }
  if (label === '') return null
  return (
    <WithCardTone state={toneState}>
      {({ glyph, tone }) => (
      <Text color={tone}>
        {glyph} {label}{' '}
      </Text>
  
      )}
    </WithCardTone>
  )
}

export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown,
  { verbose, isTranscriptMode }: { verbose: boolean; isTranscriptMode?: boolean },
): React.ReactNode {
  const revealed = verbose || isTranscriptMode === true
  if (output.changeView && output.changeView.files.length > 0) {
    return <InlineChangeView data={output.changeView} verbose={revealed} />
  }
  return <LspResultSummary output={output} verbose={revealed} />
}

function LspResultSummary({
  output,
  verbose,
}: {
  output: Output
  verbose: boolean
}): React.ReactNode {
  const tokens = useMercuryTokens()
  if (output.resultCount === undefined || output.outcome === 'failed') {
    const firstLine = output.result.split('\n')[0] ?? ''
    const text = verbose ? output.result : collapseAndClip(firstLine, LSP_ONE_LINE_MAX)
    return (
      <MessageResponse>
        <Text>
          <OutcomeBadge output={output} />
          <Text color={tokens.textMuted}>{text}</Text>
        </Text>
      </MessageResponse>
    )
  }

  const count = output.resultCount
  const fileCount = output.fileCount ?? 0
  const foundText = RESULT_LABELS[output.operation]?.found

  const summary = (
    <Text>
      <OutcomeBadge output={output} />
      {foundText && count > 0 ? (
        foundText
      ) : (
        <>
          Found <Text color={tokens.accent}>{count}</Text> {labelFor(output.operation, count)}
          {fileCount > 1 ? (
            <>
              {' '}across <Text color={tokens.accent}>{fileCount}</Text> files
            </>
          ) : null}
        </>
      )}
      {count > 0 && !verbose ? (
        <Text color={tokens.textMuted}>
          {' '}
          <CtrlOToExpand />
        </Text>
      ) : null}
    </Text>
  )

  return (
    <MessageResponse>
      <Box flexDirection="column">
        {summary}
        {verbose && output.result ? (
          <Box paddingLeft={2}>
            <Text>{output.result}</Text>
          </Box>
        ) : null}
      </Box>
    </MessageResponse>
  )
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
  name = 'LspRead',
): React.ReactNode {
  if (!verbose && typeof result === 'string' && !isDenialResultText(result)) {
    const tagged = extractTag(result, 'tool_use_error')
    if (tagged !== null) return <ShortErrorLine text={`${name}: ${collapseAndClip(tagged, 140)}`} />
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
