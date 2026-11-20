import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useDerivedState, useLayoutPublish, useSubscription } from '../../hooks/effects.js';
import { CardQueuedWords } from '../../components/permissions/CardQueuedWords.js';
import { PermissionQueueContext, permissionQueueStatus } from '../../components/permissions/PermissionQueueContext.js';
import { PermissionRequest, type ToolUseConfirm } from '../../components/permissions/PermissionRequest.js';
import type { useNotifications } from '../../context/notifications.js';
import { Box } from '../../ink.js';
import { getFocusedSessionConnector, subscribeThroughFocused } from '../../services/engine-connector/focusedConnector.js';
import type { SessionAskV1 } from '../../services/engine-connector/types.js';
import { useAppState } from '../../state/AppState.js';
import type { AppState } from '../../state/AppStateStore.js';
import type { ToolPermissionContext } from '../../Tool.js';
import { logForDebugging } from '../../utils/debug.js';
import { recordModeTransition } from '../../utils/permissions/modeTransitions.js';
import { registerPermissionFocusNotifier } from '../../utils/permissions/permissionFocus.js';
import { permissionModeTitle } from '../../utils/permissions/PermissionMode.js';
import { transitionPermissionMode } from '../../utils/permissions/permissionSetup.js';
import type { FocusedInputDialog } from './focusedDialog.js';
import { RECEIPT_TIMEOUT_MS } from './limits.js';
import { startTimeout } from '../../utils/timers.js';

const subscribeFocusedAsks = subscribeThroughFocused((connector, listener) => connector.subscribeAsks(listener));
const getFocusedAsks = (): readonly SessionAskV1[] => getFocusedSessionConnector().asks();
const subscribeFocusedPermissionMode = subscribeThroughFocused((connector, listener) => connector.subscribePermissionMode(listener));

export function useChatAsks({
  setAppState,
  addNotification,
}: {
  setAppState: (updater: (prev: AppState) => AppState) => void;
  addNotification: ReturnType<typeof useNotifications>['addNotification'];
}) {
  useSubscription(
    () =>
      registerPermissionFocusNotifier(text =>
        addNotification({ key: 'permission-focus-refusal', text, priority: 'high', timeoutMs: 4000 }),
      ),
    [addNotification],
  );
  const sessionAsks = useSyncExternalStore(subscribeFocusedAsks, getFocusedAsks, getFocusedAsks);
  const toolUseConfirmQueue = useMemo(() => sessionAsks.map(ask => ask.confirm), [sessionAsks]);
  const [resolvedConsentCount, setResolvedConsentCount] = useState(0);
  useDerivedState(() => {
    if (toolUseConfirmQueue.length === 0) setResolvedConsentCount(0);
  }, [toolUseConfirmQueue.length]);
  const resolveHeadPermission = useCallback(() => {
    setResolvedConsentCount(c => c + 1);
    const focused = getFocusedSessionConnector();
    const head = focused.asks()[0];
    if (head !== undefined) focused.settleAsk(head.id);
  }, []);

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
  useSubscription(() => subscribeFocusedPermissionMode(adoptRunnerMode), [adoptRunnerMode]);

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
  return { sessionAsks, toolUseConfirmQueue, resolvedConsentCount, resolveHeadPermission, setToolPermissionContext, elicitationQueue, respondToElicitation, dismissElicitationWaiting };
}

export function useChatAsksCard({
  focusedInputDialog,
  repinToBottom,
  toolUseConfirmQueue,
  resolvedConsentCount,
  resolveHeadPermission,
  chatSurfaceCovered,
  verbose,
}: {
  focusedInputDialog: FocusedInputDialog | undefined;
  repinToBottom: () => void;
  toolUseConfirmQueue: ToolUseConfirm[];
  resolvedConsentCount: number;
  resolveHeadPermission: () => void;
  chatSurfaceCovered: boolean;
  verbose: boolean;
}) {
  const previousPermissionFocusRef = useRef(false);
  useLayoutPublish(() => {
    const now = focusedInputDialog === 'tool-permission';
    if (now !== previousPermissionFocusRef.current) repinToBottom();
    previousPermissionFocusRef.current = now;
  }, [focusedInputDialog, repinToBottom]);
  const permissionOverlay =
    focusedInputDialog === 'tool-permission' && toolUseConfirmQueue[0] && !chatSurfaceCovered ? (
      <PermissionQueueContext.Provider value={permissionQueueStatus(resolvedConsentCount, toolUseConfirmQueue.length)}>
        <Box flexDirection="column">
          <PermissionRequest
            key={toolUseConfirmQueue[0].toolUseID}
            toolUseConfirm={toolUseConfirmQueue[0]}
            toolUseContext={toolUseConfirmQueue[0].toolUseContext}
            onDone={resolveHeadPermission}
            onReject={() => {
              resolveHeadPermission();
            }}
            verbose={verbose}
            workerBadge={toolUseConfirmQueue[0].workerBadge}
          />
          <CardQueuedWords />
        </Box>
      </PermissionQueueContext.Provider>
    ) : null;
  return { permissionOverlay };
}
