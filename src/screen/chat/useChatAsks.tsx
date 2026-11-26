import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { useClaim, useLayoutPublish } from '../effects/effects.js';
import { CardQueuedWords } from '../../permissions/cards/CardQueuedWords.js';
import { PermissionQueueContext, permissionQueueStatus } from '../../permissions/cards/PermissionQueueContext.js';
import { ExternalSeatPermissionRequest, PermissionRequest, type ToolUseConfirm } from '../../permissions/cards/PermissionRequest.js';
import type { ExternalSeatPermissionAsk } from '../../permissions/cards/externalSeatAsk.js';
import type { useNotifications } from '../notifications/notifications.js';
import { Box } from '../themedRenderer.js';
import { getFocusedSessionConnector, subscribeThroughFocused } from '../../engine/connector/focusedConnector.js';
import type { SessionAskV1 } from '../../engine/connector/types.js';
import {
  listExternalSeatAsks,
  settleExternalSeatAsk,
  subscribeExternalSeatAsks,
} from '../../crew/crewmates/seatBridge.js';
import { useAppState } from '../app-state/AppState.js';
import type { AppState } from '../app-state/AppStateStore.js';
import type { ToolPermissionContext } from '../../tools/kit/tool.js';
import { logForDebugging } from '../../platform/logs/debugLog.js';
import { recordModeTransition } from '../../permissions/rules/modeTransitions.js';
import { registerPermissionFocusNotifier } from '../../permissions/rules/permissionFocus.js';
import { permissionModeTitle } from '../../permissions/rules/permissionMode.js';
import { transitionPermissionMode } from '../../permissions/rules/permissionSetup.js';
import {
  type ChatScreenStore,
  createChatScreenStore,
  recordChatConsentResolved,
  selectResolvedConsentCount,
} from './chatStore.js';
import type { FocusedInputDialog } from './focusedDialog.js';
import { RECEIPT_TIMEOUT_MS } from './limits.js';
import { startTimeout } from '../../platform/async/timers.js';

const subscribeFocusedAsks = subscribeThroughFocused((connector, listener) => connector.subscribeAsks(listener));
const getFocusedAsks = (): readonly SessionAskV1[] => getFocusedSessionConnector().asks();
const subscribeFocusedPermissionMode = subscribeThroughFocused((connector, listener) => connector.subscribePermissionMode(listener));

export function useChatAsks({
  setAppState,
  addNotification,
  chatStore,
}: {
  setAppState: (updater: (prev: AppState) => AppState) => void;
  addNotification: ReturnType<typeof useNotifications>['addNotification'];
  chatStore?: ChatScreenStore;
}) {
  useClaim(
    () =>
      registerPermissionFocusNotifier(text =>
        addNotification({ key: 'permission-focus-refusal', text, priority: 'high', timeoutMs: 4000 }),
      ),
    [addNotification],
  );
  const localStoreRef = useRef<ChatScreenStore | null>(null);
  const consentStore = chatStore ?? (localStoreRef.current ??= createChatScreenStore());
  const sessionAsks = useSyncExternalStore(subscribeFocusedAsks, getFocusedAsks, getFocusedAsks);
  const externalSeatAsks = useSyncExternalStore(subscribeExternalSeatAsks, listExternalSeatAsks, listExternalSeatAsks);
  const toolUseConfirmQueue = useMemo(() => sessionAsks.map(ask => ask.confirm), [sessionAsks]);
  const toolUseIds = useMemo(
    () => [...toolUseConfirmQueue.map(confirm => confirm.toolUseID), ...externalSeatAsks.map(ask => ask.askId)],
    [toolUseConfirmQueue, externalSeatAsks],
  );
  const readResolvedConsentCount = (): number => selectResolvedConsentCount(consentStore.getState(), toolUseIds);
  const resolvedConsentCount = useSyncExternalStore(consentStore.subscribe, readResolvedConsentCount, readResolvedConsentCount);
  const resolveHeadPermission = useCallback((settledExternalAskId?: string) => {
    const focused = getFocusedSessionConnector();
    const asks = focused.asks();
    const external = listExternalSeatAsks();
    recordChatConsentResolved(consentStore, [
      ...asks.map(ask => ask.confirm.toolUseID),
      ...external.map(ask => ask.askId),
    ]);
    if (settledExternalAskId !== undefined) {
      settleExternalSeatAsk(settledExternalAskId);
      return;
    }
    const head = asks[0];
    if (head !== undefined) focused.settleAsk(head.id);
  }, [consentStore]);
  const adoptRunnerMode = useCallback(() => {
    const held = getFocusedSessionConnector().permissionMode();
    if (held === null) return;
    setAppState(prev => {
      if (prev.toolPermissionContext.mode === held) return prev;
      let next = prev.toolPermissionContext;
      try {
        next = transitionPermissionMode(prev.toolPermissionContext.mode, held, prev.toolPermissionContext);
      } catch (error) {
        logForDebugging(`permission mode adoption ${prev.toolPermissionContext.mode} → ${held} kept the standing context: ${error instanceof Error ? error.message : String(error)}`);
      }
      recordModeTransition({ from: prev.toolPermissionContext.mode, to: held, road: 'screen-mirror', detail: "the runner's own mode adopted" });
      return { ...prev, toolPermissionContext: { ...next, mode: held } };
    });
  }, [setAppState]);
  useClaim(() => {
    if (getFocusedSessionConnector().modelFacts().effectiveSource === 'live') adoptRunnerMode();
    return subscribeFocusedPermissionMode(adoptRunnerMode);
  }, [adoptRunnerMode]);

  const setToolPermissionContext = useCallback(
    (context: ToolPermissionContext, options?: { preserveMode?: boolean }) => {
      setAppState(prev => {
        const preserved = options?.preserveMode ? prev.toolPermissionContext.mode : context.mode;
        if (preserved !== prev.toolPermissionContext.mode) {
          recordModeTransition({ from: prev.toolPermissionContext.mode, to: preserved, road: 'screen-mirror' });
        }
        return { ...prev, toolPermissionContext: { ...context, mode: preserved } };
      });
      if (!options?.preserveMode) {
        void getFocusedSessionConnector()
          .setPermissionMode(context.mode)
          .then(receipt => {
            if (receipt.outcome !== 'refused') return;
            adoptRunnerMode();
            addNotification({
              key: 'permission-mode-refused',
              text: `${permissionModeTitle(context.mode)} refused by the session — ${receipt.detail ?? 'the runner did not take it'}`,
              priority: 'high',
              color: 'error' as const,
              timeoutMs: RECEIPT_TIMEOUT_MS,
            });
          });
      }
      startTimeout(() => {
        for (const entry of getFocusedSessionConnector().asks()) entry.confirm.recheckPermission?.();
      }, 0);
    },
    [setAppState, adoptRunnerMode, addNotification],
  );
  const elicitationQueue = useAppState(state => state.elicitation.queue);
  const respondToElicitation = useCallback(
    (action: 'accept' | 'decline' | 'cancel', content?: Record<string, string | number | boolean | string[]>) => {
      const head = elicitationQueue[0];
      if (!head) return;
      head.respond({ action, content });
      const params = head.params as { mode?: string };
      if (action === 'accept' && params.mode === 'url') return;
      setAppState(prev => ({ ...prev, elicitation: { queue: prev.elicitation.queue.slice(1) } }));
    },
    [elicitationQueue, setAppState],
  );
  const dismissElicitationWaiting = useCallback(
    (action: 'cancel' | 'retry' | 'dismiss') => {
      const head = elicitationQueue[0];
      if (!head) return;
      setAppState(prev => ({ ...prev, elicitation: { queue: prev.elicitation.queue.slice(1) } }));
      head.onWaitingDismiss?.(action);
    },
    [elicitationQueue, setAppState],
  );
  return { sessionAsks, externalSeatAsks, toolUseConfirmQueue, resolvedConsentCount, resolveHeadPermission, setToolPermissionContext, elicitationQueue, respondToElicitation, dismissElicitationWaiting };
}

const noopSubscribe = (): (() => void) => () => {};

export function useChatAsksCard({
  focusedInputDialog,
  repinToBottom,
  toolUseConfirmQueue,
  externalSeatAsks,
  resolvedConsentCount,
  chatStore,
  resolveHeadPermission,
  chatSurfaceCovered,
  verbose,
}: {
  focusedInputDialog: FocusedInputDialog | undefined;
  repinToBottom: () => void;
  toolUseConfirmQueue: ToolUseConfirm[];
  externalSeatAsks?: readonly ExternalSeatPermissionAsk[];
  resolvedConsentCount?: number;
  chatStore?: ChatScreenStore;
  resolveHeadPermission: (settledExternalAskId?: string) => void;
  chatSurfaceCovered: boolean;
  verbose: boolean;
}) {
  const externalList = externalSeatAsks ?? [];
  const toolUseIds = useMemo(
    () => [...toolUseConfirmQueue.map(confirm => confirm.toolUseID), ...externalList.map(ask => ask.askId)],
    [toolUseConfirmQueue, externalList],
  );
  const subscribeConsent = chatStore ? chatStore.subscribe : noopSubscribe;
  const readConsentCount = (): number =>
    chatStore ? selectResolvedConsentCount(chatStore.getState(), toolUseIds) : (resolvedConsentCount ?? 0);
  const effectiveResolvedConsentCount = useSyncExternalStore(subscribeConsent, readConsentCount, readConsentCount);
  const previousPermissionFocusRef = useRef(false);
  useLayoutPublish(() => {
    const now = focusedInputDialog === 'tool-permission';
    if (now !== previousPermissionFocusRef.current) repinToBottom();
    previousPermissionFocusRef.current = now;
  }, [focusedInputDialog, repinToBottom]);
  const totalQueueLength = toolUseConfirmQueue.length + externalList.length;
  const nativeHead = toolUseConfirmQueue[0];
  const externalHead = nativeHead === undefined ? externalList[0] : undefined;
  const permissionOverlay =
    focusedInputDialog === 'tool-permission' && (nativeHead !== undefined || externalHead !== undefined) && !chatSurfaceCovered ? (
      <PermissionQueueContext.Provider value={permissionQueueStatus(effectiveResolvedConsentCount, totalQueueLength)}>
        <Box flexDirection="column">
          {nativeHead !== undefined ? (
            <PermissionRequest
              key={nativeHead.toolUseID}
              toolUseConfirm={nativeHead}
              toolUseContext={nativeHead.toolUseContext}
              onDone={() => resolveHeadPermission()}
              onReject={() => {
                resolveHeadPermission();
              }}
              verbose={verbose}
            />
          ) : externalHead !== undefined ? (
            <ExternalSeatPermissionRequest
              key={externalHead.askId}
              ask={externalHead}
              onDone={() => resolveHeadPermission(externalHead.askId)}
            />
          ) : null}
          <CardQueuedWords />
        </Box>
      </PermissionQueueContext.Provider>
    ) : null;
  return { permissionOverlay };
}
