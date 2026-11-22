import * as React from 'react';
import { BLACK_CIRCLE } from '../constants/figures.js';
import { Box, Text } from '../ink.js';
import type { Screen } from '../screens/Chat.js';
import type { NormalizedUserMessage } from '../types/message.js';
import { getUserMessageText } from '../services/messages.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { MercuryCompactSummary } from './MercuryCompactSummary.js';
import { MessageResponse } from './MessageResponse.js';
import { notBuilt } from '../pi/holes.js'
type Props = {
  message: NormalizedUserMessage;
  screen: Screen;
};

function reclaimPct(message: NormalizedUserMessage): number | undefined {
  const meta = message.summarizeMetadata as
    | { contextReclaimedPct?: number }
    | undefined;
  const v = meta?.contextReclaimedPct;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function CompactSummary(arg0: Props): React.ReactNode {
  return notBuilt('src/components/CompactSummary.tsx:23')
}
