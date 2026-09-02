import React from 'react';
import { Box, Text } from '../ink.js';
import { formatTokens } from '../utils/format.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';
import { CommandCenter } from './mercury-ui/components.js';
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js';
type IdleReturnAction = 'continue' | 'clear' | 'dismiss' | 'never';
type Props = {
  idleMinutes: number;
  totalInputTokens: number;
  onDone: (action: IdleReturnAction) => void;
};

const IDLE_RETURN_OPTIONS = [
  {
    value: 'continue' as const,
    label: 'Continue this conversation',
  },
  {
    value: 'clear' as const,
    label: 'Send message as a new conversation',
  },
  {
    value: 'never' as const,
    label: "Don't ask me again",
  },
];

function MercuryIdleReturnDialog({
  idleMinutes,
  totalInputTokens,
  onDone,
}: Props): React.ReactNode {
  const formattedIdle = formatIdleDuration(idleMinutes);
  const formattedTokens = formatTokens(totalInputTokens);
  // adaptive ink — this modal is unavoidable and must stay
  // legible on the light/daltonized families, so it resolves the tokens.
  const tokens = useMercuryTokens();
  return (
    <CommandCenter
      view="session idle"
      footer="enter to choose"
      onClose={() => onDone('dismiss')}
    >
      <Box flexDirection="column" marginTop={1}>
        <Text color={tokens.textPrimary}>
          You've been away {formattedIdle} and this conversation is{' '}
          {formattedTokens} tokens.
        </Text>
        <Text color={tokens.textSecondary}>
          For a new task, a fresh context is faster and spends less.
        </Text>
      </Box>
      <Box marginTop={1}>
        <Select
          options={IDLE_RETURN_OPTIONS}
          onChange={(value: IdleReturnAction) => onDone(value)}
        />
      </Box>
    </CommandCenter>
  );
}

export function IdleReturnDialog({
  idleMinutes,
  totalInputTokens,
  onDone,
}: Props): React.ReactNode {
  return (
    <MercuryIdleReturnDialog
      idleMinutes={idleMinutes}
      totalInputTokens={totalInputTokens}
      onDone={onDone}
    />
  );
}
// The idle span, worded the way a person would say it: under a minute is
// "< 1m", whole minutes up to the hour, then hours with the leftover minutes
// mentioned only when there are any.
function formatIdleDuration(minutes: number): string {
  if (minutes < 1) return '< 1m';
  const whole = Math.floor(minutes);
  if (whole < 60) return `${whole}m`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
