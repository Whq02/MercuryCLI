import { Box, Text } from '../themedRenderer.js';
import { useShortcutDisplay } from '../keys/useShortcutDisplay.js';
import { overflowWhoClause } from '../../engine/requests/overflowSignal.js';
import { foldReceipt, foldReceiptWords } from '../../engine/compaction/foldReceipt.js';
import type { CompactMetadata } from '../../engine/message-shapes/message.js';

export function CompactBoundaryMessage({
  message,
  landing,
}: {
  message?: { compactMetadata?: Partial<CompactMetadata> };
  landing?: { input: number } | null;
}) {
  const historyShortcut = useShortcutDisplay("app:toggleTranscript", "Global", "ctrl+o");
  const meta = message?.compactMetadata;
  const overflowWho = meta?.trigger === 'overflow' && meta.overflow !== undefined ? ` (${overflowWhoClause(meta.overflow)})` : '';
  const head =
    meta?.trigger === 'overflow'
      ? `Context overflowed${overflowWho} — folded and retried`
      : meta?.trigger === 'auto'
        ? 'Context compacted automatically'
        : 'Conversation compacted';
  const words = meta?.trigger === undefined ? [] : foldReceiptWords(foldReceipt({ ...meta, trigger: meta.trigger, preTokens: meta.preTokens ?? 0 }, landing));
  const facts = words.length > 0 ? ` — ${words.join(' · ')}` : '';
  return <Box marginY={1}><Text dimColor={true}>✻ {head}{facts} ({historyShortcut} for history)</Text></Box>;
}
