import { basename } from 'node:path';
import React from 'react';
import { Box, Text } from '../ink.js';
import { Select } from './CustomSelect/index.js';
import { CommandCenter } from './mercury-ui/components.js';
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js';

/** The crash notice's actionable form (FN-013 CRASH-03): when the newest
 *  unnoticed crash report names a session whose transcript still resolves,
 *  the boot offers re-entry in one keypress instead of a passive line the
 *  operator must hand-translate into /resume. Dismissal is one esc; the
 *  boot never blocks on it (the dialog rides the focused-dialog contract,
 *  standing down behind permissions, elicitations and typing bursts). */

type CrashResumeAction = 'resume' | 'dismiss';

type Props = {
  origin: string;
  component: string | null;
  message: string;
  sessionId: string;
  cwd: string | null;
  /** Unnoticed reports beyond the offered one — named, never hidden. */
  moreCount: number;
  onDone: (action: CrashResumeAction) => void;
};

const CRASH_RESUME_OPTIONS = [
  { value: 'resume' as const, label: 'Resume that session' },
  { value: 'dismiss' as const, label: 'Not now' },
];

export function CrashResumeDialog({
  origin,
  component,
  message,
  sessionId,
  cwd,
  moreCount,
  onDone,
}: Props): React.ReactNode {
  const tokens = useMercuryTokens();
  const where = cwd !== null ? basename(cwd) || cwd : null;
  return (
    <CommandCenter
      view="previous session crashed"
      footer="enter to choose · esc dismisses"
      onClose={() => onDone('dismiss')}
    >
      <Box flexDirection="column" marginTop={1}>
        <Text color={tokens.textPrimary} wrap="truncate-end">
          {origin}
          {component ? ` in ${component}` : ''} — {message.slice(0, 80)}
        </Text>
        <Text color={tokens.textSecondary} wrap="truncate-end">
          session {sessionId.slice(0, 8)}
          {where !== null ? ` in ${where}` : ''}
          {moreCount > 0 ? ` · +${moreCount} more report(s) in /health` : ''}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Select options={CRASH_RESUME_OPTIONS} onChange={(value: CrashResumeAction) => onDone(value)} />
      </Box>
    </CommandCenter>
  );
}
