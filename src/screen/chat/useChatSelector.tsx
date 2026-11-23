import type { UUID } from 'node:crypto';
import { useCallback, useRef, useState } from 'react';
import type { ResumeEntrypoint } from '../../commands/catalogue/commands.js';
import { useMessageActions, type MessageActionsNav } from '../messages/messageActions.js';
import { useMessageCursorActive } from '../messages/messageCursorStore.js';
import { MessageSelector } from '../rewind-picker/RewindPicker.js';
import type { useNotifications } from '../notifications/notifications.js';
import { setClipboardWithReceipt } from '../renderer/termio/osc.js';
import * as pendingInput from '../composer/input-core/pending-input.js';
import { getShortcutDisplay } from '../keys/shortcutFormat.js';
import { createBranchSession } from '../../sessions/branches/branchManifest.js';
import { getFocusedSessionConnector } from '../../engine/connector/focusedConnector.js';
import { waitForTurnEnd } from '../../engine/connector/turnEnd.js';
import type { RewindReceiptV1 } from '../../engine/connector/types.js';
import type { Message, NormalizedUserMessage, UserMessage } from '../../engine/message-shapes/message.js';
import type { InputMode } from '../composer/input-core/textInput.js';
import { getCwd } from '../../platform/files/cwd.js';
import { textForResubmit } from '../../engine/messages/messages.js';
import { modelDisplayString } from '../../models/catalogue/engineModel.js';
import { transcriptMessageIndex } from '../../sessions/transcripts/materialize.js';
import type { FocusedInputDialog } from './focusedDialog.js';
import { RECEIPT_TIMEOUT_MS } from './limits.js';
import type { Screen } from './screen.js';
import type { ResumableLog } from './sessionShapes.js';

const REWIND_SETTLE_WAIT_MS = 5000;
const MESSAGE_ACTION_UUID_PREFIX = 24;

function rewindReceiptLine(receipt: RewindReceiptV1): string {
  if (receipt.outcome === 'noop') return receipt.detail ?? 'nothing to restore — the files already match this point';
  const parts: string[] = [];
  if (receipt.code !== undefined) {
    const n = receipt.code.filesChanged.length;
    parts.push(n === 0 ? 'files already matched' : `${n} file${n === 1 ? '' : 's'} restored (+${receipt.code.insertions} -${receipt.code.deletions})`);
  }
  if (receipt.conversation !== undefined) {
    parts.push(`conversation wound back — ${receipt.conversation.removed} message${receipt.conversation.removed === 1 ? '' : 's'} left the model's view (the transcript keeps them)`);
  }
  return `rewound: ${parts.join(' · ')}`;
}

export function useChatSelector() {
  const [showMessageSelector, setShowMessageSelector] = useState(false);
  const openMessageSelector = useCallback(() => setShowMessageSelector(true), []);
  const [messageSelectorPreselect, setMessageSelectorPreselect] = useState<UserMessage | undefined>(undefined);
  return { showMessageSelector, setShowMessageSelector, openMessageSelector, messageSelectorPreselect, setMessageSelectorPreselect };
}

export function useChatSelectorView({
  addNotification,
  setInputValue,
  setInputMode,
  setShowMessageSelector,
  messageSelectorPreselect,
  setMessageSelectorPreselect,
  focusedInputDialog,
  chatSurfaceCovered,
  messages,
  onCancel,
  focusedEffectiveModel,
  handleEnterTranscript,
  setScreen,
  setShowAllInTranscript,
  isLoadingRef,
  resume,
}: {
  addNotification: ReturnType<typeof useNotifications>['addNotification'];
  setInputValue: (value: string) => void;
  setInputMode: (mode: InputMode) => void;
  setShowMessageSelector: (show: boolean) => void;
  messageSelectorPreselect: UserMessage | undefined;
  setMessageSelectorPreselect: (message: UserMessage | undefined) => void;
  focusedInputDialog: FocusedInputDialog | undefined;
  chatSurfaceCovered: boolean;
  messages: Message[];
  onCancel: () => void;
  focusedEffectiveModel: string;
  handleEnterTranscript: () => void;
  setScreen: (screen: Screen) => void;
  setShowAllInTranscript: (showAll: boolean) => void;
  isLoadingRef: { current: boolean };
  resume: (sessionId: UUID, log: ResumableLog, entrypoint: ResumeEntrypoint) => Promise<void>;
}) {
  const refuseSessionRewrite = useCallback((what: string): void => {
    addNotification({
      key: 'session-rewrite',
      text: `${what} acts on the session's own conversation — not available for a managed session yet (a named follow-up); /sessions opens another session, /clear starts fresh`,
      priority: 'high',
      timeoutMs: RECEIPT_TIMEOUT_MS,
    });
  }, [addNotification]);
  const messageActionsDisabled = false;
  const messageCursorActive = useMessageCursorActive();
  const messageNavRef = useRef<MessageActionsNav | null>(null);
  const messageActions = useMessageActions(messageNavRef, {
    copy: (text: string) => {
      void setClipboardWithReceipt(text).then(receipt => {
        process.stdout.write(receipt.sequence);
        addNotification({ key: 'message-copy', text: receipt.confirmation, color: 'success', priority: 'immediate', timeoutMs: 2000 });
      });
    },
    edit: async (msg: NormalizedUserMessage) => {
      const prefix = msg.uuid.slice(0, MESSAGE_ACTION_UUID_PREFIX);
      const raw = getFocusedSessionConnector().records().find(m => m.type === 'user' && m.uuid.startsWith(prefix)) as UserMessage | undefined;
      if (!raw) return;
      const resubmit = textForResubmit(raw);
      if (resubmit) {
        setInputValue(resubmit.text);
        setInputMode(resubmit.mode);
      }
      refuseSessionRewrite('editing a sent message');
    },
  });

  const onRestore = useCallback(
    async (message: UserMessage | undefined, mode: 'both' | 'conversation' | 'code', files?: { filePath?: string; undo?: boolean; userMessageId?: string }): Promise<RewindReceiptV1> => {
      const connector = getFocusedSessionConnector();
      if (connector.turnActive()) {
        connector.interrupt();
        await waitForTurnEnd(connector, { limitMs: REWIND_SETTLE_WAIT_MS });
      }
      if (message === undefined && files?.userMessageId === undefined) return { outcome: 'refused', mode, refusal: 'not-found', detail: 'no restore point was selected' };
      const receipt = files === undefined && message !== undefined
        ? await connector.rewind({ userMessageId: message.uuid, mode })
        : await connector.rewind({ userMessageId: files?.userMessageId ?? message!.uuid, mode: 'code', ...files });
      if (receipt.outcome === 'applied' && receipt.conversation !== undefined) {
        if (message === undefined) return receipt;
        const resubmit = textForResubmit(message);
        if (resubmit) {
          pendingInput.edit(resubmit.text, { restored: true });
          setInputMode(resubmit.mode);
        }
      }
      if (receipt.outcome !== 'refused') {
        addNotification({
          key: 'rewind-receipt',
          text: rewindReceiptLine(receipt),
          priority: 'high',
          timeoutMs: RECEIPT_TIMEOUT_MS,
        });
      }
      return receipt;
    },
    [addNotification, setInputMode, setInputValue],
  );
  const onSummarize = useCallback(async () => {
    setShowMessageSelector(false);
    setMessageSelectorPreselect(undefined);
    refuseSessionRewrite('summarising a stretch of the conversation');
  }, [refuseSessionRewrite]);

  const messageSelector =
    focusedInputDialog === 'message-selector' && !chatSurfaceCovered ? (
      <MessageSelector
        messages={messages}
        onPreRestore={onCancel}
        onRestore={onRestore}
        onSummarize={onSummarize}
        preselectedMessage={messageSelectorPreselect}
        providerOrigin={modelDisplayString(focusedEffectiveModel)}
        onViewOnly={() => {
          handleEnterTranscript();
          setScreen('transcript');
          setShowAllInTranscript(true);
          setShowMessageSelector(false);
          setMessageSelectorPreselect(undefined);
          addNotification({
            key: 'view-only-history',
            text: `read-only view — ${getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')} returns; nothing changed`,
            priority: 'immediate',
            timeoutMs: 6000,
          });
        }}
        onBranchCreated={manifest => {
          addNotification({
            key: 'branch-created',
            text: `Branch created: ${manifest.branchSessionId.slice(0, 8)} (fork ${manifest.forkOrdinal}) — mercury --resume ${manifest.branchSessionId}; this session is untouched`,
            priority: 'immediate',
            timeoutMs: RECEIPT_TIMEOUT_MS,
          });
        }}
        onRerun={async message => {
          if (isLoadingRef.current) return { ok: false as const, reason: 'a run is in flight — esc to interrupt it first' };
          const sourceTranscriptPath = getFocusedSessionConnector().transcriptFile?.() ?? null;
          if (!sourceTranscriptPath) return { ok: false as const, reason: 'no transcript file to branch from — the chat owns no session yet' };
          const idx = transcriptMessageIndex(sourceTranscriptPath, message.uuid);
          if (idx === -1) return { ok: false as const, reason: 'that message is not in the committed transcript' };
          const branch = createBranchSession({
            sourceTranscriptPath,
            forkOrdinal: idx,
            boundaryKind: 'rewind',
            cwd: getCwd(),
            providerOrigin: modelDisplayString(focusedEffectiveModel),
          });
          if (!branch.ok) return { ok: false as const, reason: branch.reason };
          const branchId = branch.manifest.branchSessionId as UUID;
          const { loadConversationForResume } = await import('../../sessions/resume/conversationRecovery.js');
          const loaded = await loadConversationForResume(branchId, branch.branchTranscriptPath);
          if (!loaded) return { ok: false as const, reason: `branch created but not loadable — mercury --resume ${branchId}` };
          const branchLog: ResumableLog = { ...loaded, fullPath: branch.branchTranscriptPath };
          setShowMessageSelector(false);
          setMessageSelectorPreselect(undefined);
          await resume(branchId, branchLog, 'fork');
          const resubmit = textForResubmit(message);
          if (resubmit) {
            setInputValue(resubmit.text);
            setInputMode(resubmit.mode);
          }
          addNotification({
            key: 'rerun-branch-created',
            text: `Branch created: ${branchId.slice(0, 8)} (fork ${idx}) — prompt staged, Enter reruns; the source session is untouched`,
            priority: 'immediate',
            timeoutMs: RECEIPT_TIMEOUT_MS,
          });
          return { ok: true as const };
        }}
        onClose={() => {
          setShowMessageSelector(false);
          setMessageSelectorPreselect(undefined);
        }}
      />
    ) : null;
  return { messageActionsDisabled, messageCursorActive, messageNavRef, messageActions, messageSelector };
}
