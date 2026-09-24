;
import type { ToolResultBlockParam } from '../../types/wire.js'
import React, { useEffect } from 'react';
import { OUTPUT_CONNECTOR } from '../../constants/figures.js';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { MessageResponse } from '../../components/MessageResponse.js';
import { AMBER, FAINT, TERRA } from '../../components/mercuryPalette.js';
import { InteractiveRow } from '../../components/mercury-ui/InteractiveRow.js';
import { WithCardTone } from '../../components/mercury-ui/toolCardGrammar.js';
import { Box, Text } from '../../ink.js';
import { requestCommandDispatch } from '../../utils/cockpit/helmFocus.js';
import { cellCardFactsOf, lastShellCallOf, rememberCellCard, shellCallHeadline, type WorkshopCellCardFacts } from './cellCards.js';
import type { Input, Output } from './WorkshopTool.js';

const SHELL_CALL_ROW_LINES = 3;

export function renderToolUseMessage(
  input: Partial<Input>,
  _opts: { verbose: boolean },
): React.ReactNode {
  const cells = input.cells ?? [];
  const first = cells[0];
  if (!first) return null;
  return `${cells.length} ${first.language} cell${cells.length === 1 ? '' : 's'}${first.title ? ` · ${first.title}` : ''}`;
}

export function cellCardHint(cellId: string): string {
  return `${OUTPUT_CONNECTOR}view the card: /tasks ${cellId} · click to open`;
}

export function cellCardFactsOfResult(toolUseResult: unknown, input: Partial<Input> | undefined): WorkshopCellCardFacts[] {
  const cells = (toolUseResult as Partial<Output> | null | undefined)?.cells;
  if (!Array.isArray(cells)) return [];
  const facts: WorkshopCellCardFacts[] = [];
  cells.forEach((cell, index) => {
    const found = cellCardFactsOf(cell, input?.cells?.[index]?.code);
    if (found !== null) facts.push(found);
  });
  return facts;
}

function FailedCellsRow({ result, verbose, facts }: { result: ToolResultBlockParam['content']; verbose: boolean; facts: WorkshopCellCardFacts[] }): React.ReactNode {
  useEffect(() => {
    for (const cell of facts) rememberCellCard(cell);
  }, [facts]);
  const first = facts[0]!;
  return (
    <InteractiveRow
      id={`workshop-cell:${first.cellId}`}
      directActivate
      selectionBand={false}
      flexDirection="column"
      onActivate={() => requestCommandDispatch(`/tasks ${first.cellId}`)}
    >
      <MessageResponse>
        <Box flexDirection="column">
          <FallbackToolUseErrorMessage result={result} verbose={verbose} />
          {facts.map(cell => {
            const shellCall = lastShellCallOf(cell);
            const shellTail = (shellCall?.outputTail ?? []).slice(-SHELL_CALL_ROW_LINES);
            return (
              <Box key={cell.cellId} flexDirection="column">
                {shellCall !== undefined ? (
                  <Text color={FAINT} wrap="truncate-end">
                    {`  ${shellCall.refused === true ? 'refused' : 'command'}: ${shellCallHeadline(shellCall)}`}
                  </Text>
                ) : null}
                {shellTail.map((line, index) => (
                  <Text key={index} color={FAINT} wrap="truncate-end">
                    {'    '}
                    {line}
                  </Text>
                ))}
                <Text color={FAINT}>{cellCardHint(cell.cellId)}</Text>
              </Box>
            );
          })}
        </Box>
      </MessageResponse>
    </InteractiveRow>
  );
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose, toolUseResult, input }: { verbose: boolean; toolUseResult?: unknown; input?: Partial<Input> },
): React.ReactNode {
  const facts = cellCardFactsOfResult(toolUseResult, input);
  if (facts.length === 0) return <FallbackToolUseErrorMessage result={result} verbose={verbose} />;
  return <FailedCellsRow result={result} verbose={verbose} facts={facts} />;
}

export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  return (
    <Box flexDirection="column">
      {output.cells.map(cell => {
        const tail = verbose ? cell.outputTail : cell.outputTail.slice(-4);
        return (
          <WithCardTone key={cell.cellId} state={cell.state}>
            {({ glyph, tone }) => (
          <Box flexDirection="column">
            <Text>
              <Text color={tone}>{glyph} </Text>
              <Text color={FAINT}>
                {cell.cellId} · {cell.durationMs}ms · gen {cell.generation}
                {cell.title ? ` · ${cell.title}` : ''}
              </Text>
            </Text>
            {cell.runtimeKilled ? (
              <Text color={AMBER}>{'  runtime killed — retained state lost'}</Text>
            ) : null}
            {cell.error ? (
              <Text color={TERRA} wrap="truncate-end">{`  ${cell.error.split('\n')[0]}`}</Text>
            ) : null}
            {cell.valuePreview ? (
              <Text wrap="truncate-end">{`  = ${cell.valuePreview.split('\n')[0]}`}</Text>
            ) : null}
            {tail.map((line, i) => (
              <Text key={i} color={FAINT} wrap="truncate-end">
                {'  '}
                {line}
              </Text>
            ))}
            {!verbose && cell.outputTail.length > tail.length ? (
              <Text color={FAINT}>{`  … +${cell.outputTail.length - tail.length} output lines (ctrl+o expands)`}</Text>
            ) : null}
          </Box>
            )}
          </WithCardTone>
        );
      })}
    </Box>
  );
}
