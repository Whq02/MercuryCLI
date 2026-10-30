import { Box, Text } from '../../ink.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import { overflowWhoClause } from '../../services/api/overflowSignal.js';
import { foldReceipt, foldReceiptWords } from '../../services/compact/foldReceipt.js';
import type { CompactMetadata } from '../../types/message.js';

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
