import * as React from 'react'

import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { InlineChangeView } from '../../components/InlineChangeView.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { CtrlOToExpand } from '../../components/CtrlOToExpand.js'
import { WithCardTone } from '../../components/mercury-ui/toolCardGrammar.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { Box, Text } from '../../ink.js'
import type { ToolResultBlockParam } from '../../types/wire.js'
import { getDisplayPath } from '../../utils/file.js'
import { extractTag } from '../../utils/messages.js'
import { LSP_TOOL_NAME } from './prompt.js'
import { getSymbolAtPosition } from './symbolContext.js'
import type { Output } from './LSPTool.js'

/**
 * LSP renderers: operation labels, the outcome badge (tone from the shared
 * card grammar — a bespoke tone switch here was the estate's one grammar
 * violation), the inline change view, and the count summary.
 */

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

/** Per-operation result labels; hover carries its availability phrasing. */
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

export function userFacingName(): string {
  return LSP_TOOL_NAME
}

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
      // Not-applied-but-succeeded is tonally "queued/in motion".
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
  if (output.resultCount === undefined) {
    // Initialisation and request failures: badge plus the raw result text.
    return (
      <MessageResponse>
        <Text>
          <OutcomeBadge output={output} />
          <Text color={tokens.textMuted}>{output.result}</Text>
        </Text>
      </MessageResponse>
    )
  }
  const count = output.resultCount
  const isHoverHit = output.operation === 'hover' && count > 0
  const summary = (
    <Text>
      <OutcomeBadge output={output} />
      {isHoverHit ? (
        <Text>hover information available</Text>
      ) : (
        <Text>
          Found <Text color={tokens.accent}>{count}</Text> {labelFor(output.operation, count)}
          {output.fileCount !== undefined && output.fileCount > 1 ? (
            <Text>
              {' '}
              across <Text color={tokens.accent}>{output.fileCount}</Text> files
            </Text>
          ) : null}
        </Text>
      )}
      {count > 0 && !verbose ? (
        <Text color={tokens.textMuted}>
          {' '}
          <CtrlOToExpand />
        </Text>
      ) : null}
    </Text>
  )
  if (!verbose) {
    return <MessageResponse>{summary}</MessageResponse>
  }
  return (
    <MessageResponse>
      <Box flexDirection="column">
        {summary}
        <Box paddingLeft={2} flexDirection="column">
          <Text>{output.result}</Text>
        </Box>
      </Box>
    </MessageResponse>
  )
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!verbose && typeof result === 'string' && extractTag(result, 'tool_use_error') !== null) {
    return <ShortErrorLine text="LSP operation failed" />
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}

function ShortErrorLine({ text }: { text: string }): React.ReactNode {
  const tokens = useMercuryTokens()
  return (
    <MessageResponse>
      <Text color={tokens.warning}>
        {GLYPH.warn} {text}
      </Text>
    </MessageResponse>
  )
}
