
;
import type { ToolResultBlockParam } from '../../../types/wire.js'
import * as React from 'react';
import { BULLET_OPERATOR, OUTPUT_CONNECTOR } from '../../../constants/figures.js';
import { Box, Text } from '../../../ink.js';
import { filterToolProgressMessages, type Tool, type Tools } from '../../../Tool.js';
import type { ProgressMessage } from '../../../types/message.js';
import { INTERRUPT_MESSAGE_FOR_TOOL_USE, isClassifierDenial, PLAN_REJECTION_PREFIX, REJECT_MESSAGE_WITH_REASON_PREFIX } from '../../../utils/messages.js';
import type { HermesKillInfo } from '../../../utils/permissions/capabilityGate.js';
import { GLYPH } from '../../mercury-ui/glyphs.js';
import { CRIMSON, FAINT, IVORY, SECOND } from '../../mercuryPalette.js';
import { FallbackToolUseErrorMessage } from '../../FallbackToolUseErrorMessage.js';
import { InterruptedByUser } from '../../InterruptedByUser.js';
import { MessageResponse } from '../../MessageResponse.js';
import { RejectedPlanMessage } from './RejectedPlanMessage.js';
import { RejectedToolUseMessage } from './RejectedToolUseMessage.js';
type Props = {
  progressMessagesForMessage: ProgressMessage[];
  tool?: Tool;
  tools: Tools;
  param: ToolResultBlockParam;
  verbose: boolean;
  isTranscriptMode?: boolean;
  hermesKill?: HermesKillInfo;
};
export function UserToolErrorMessage({
  progressMessagesForMessage,
  tool,
  tools,
  param,
  verbose,
  isTranscriptMode,
  hermesKill,
}: Props): React.ReactNode {
  if (hermesKill) {
    const reason =
      hermesKill.killPattern != null
        ? `blocked · ${hermesKill.kind} · killed by MERCURY_KILL=${hermesKill.killPattern}`
        : `blocked · ${hermesKill.kind}`;
    return (
      <MessageResponse>
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Text color={CRIMSON}>{GLYPH.fail} </Text>
            <Text color={IVORY}>{hermesKill.tool}</Text>
            {hermesKill.target ? (
              <Text color={SECOND}>
                {'  '}
                {hermesKill.target}
              </Text>
            ) : null}
          </Box>
          <Text color={FAINT}>
            {OUTPUT_CONNECTOR}
            {reason}
          </Text>
        </Box>
      </MessageResponse>
    );
  }

  if (
    typeof param.content === 'string' &&
    param.content.includes(INTERRUPT_MESSAGE_FOR_TOOL_USE)
  ) {
    return (
      <MessageResponse height={1}>
        <InterruptedByUser />
      </MessageResponse>
    );
  }

  if (
    typeof param.content === 'string' &&
    param.content.startsWith(PLAN_REJECTION_PREFIX)
  ) {
    const planContent = param.content.substring(PLAN_REJECTION_PREFIX.length);
    return <RejectedPlanMessage plan={planContent} />;
  }

  if (
    typeof param.content === 'string' &&
    param.content.startsWith(REJECT_MESSAGE_WITH_REASON_PREFIX)
  ) {
    return <RejectedToolUseMessage />;
  }

  

  return (
    tool?.renderToolUseErrorMessage?.(param.content, {
      progressMessagesForMessage: filterToolProgressMessages(
        progressMessagesForMessage,
      ),
      tools,
      verbose,
      isTranscriptMode,
    }) ?? <FallbackToolUseErrorMessage result={param.content} verbose={verbose} />
  );
}
