import React, { useCallback, useRef, useState } from 'react';
import { useDerivedState, useLayoutPublish } from '../effects/effects.js';
import { CostThresholdDialog } from '../../models/usage/CostThresholdDialog.js';
import { CrashResumeDialog } from './CrashResumeDialog.js';
import { ElicitationDialog } from '../mcp/ElicitationDialog.js';
import { BackgroundTasksDialog } from '../tasks/BackgroundTasksDialog.js';
import type { CompactWorkControls, CompactWorkFocus } from '../tasks/CompactWorkSummary.js';
import type { useNotifications } from '../notifications/notifications.js';
import { Box, type DOMElement, measureElement } from '../themedRenderer.js';
import { getFocusedSessionConnector } from '../../engine/connector/focusedConnector.js';
import type { AppState, AppStateStore } from '../app-state/AppStateStore.js';
import type { SetToolJSXFn } from '../../tools/kit/tool.js';
import type { Message } from '../../engine/message-shapes/message.js';
import { getGlobalConfig, saveGlobalConfig } from '../../platform/settings/config.js';
import { logForDebugging } from '../../platform/logs/debugLog.js';
import { getCurrentWorktreeSession } from '../../platform/git/worktree/worktree.js';
import { resolveToolJSX } from './toolJsxArbitration.js';
import type { CrashResumeStaged } from './crashResume.js';
import type { FocusedInputDialog } from './focusedDialog.js';
import { RECEIPT_TIMEOUT_MS, SWITCH_STATUS_TIMEOUT_MS } from './limits.js';

const COST_THRESHOLD_USD = 5;

export type ToolJSXState = Parameters<SetToolJSXFn>[0];

type ElicitationQueue = AppState['elicitation']['queue'];

export function useChatDialogs({
  store,
  addNotification,
}: {
  store: AppStateStore;
  addNotification?: ReturnType<typeof useNotifications>['addNotification'];
}) {
  const [toolJSX, setToolJSXState] = useState<ToolJSXState>(null);
  const setToolJSX: SetToolJSXFn = useCallback(next => {
    setToolJSXState(prev => resolveToolJSX(prev, next));
  }, []);
  const [isExiting, setIsExiting] = useState(false);
  const [showExitFlow, setShowExitFlow] = useState(false);
  const [exitCommandJsx, setExitCommandJsx] = useState<React.ReactNode | null>(null);
  const [showCostThreshold, setShowCostThreshold] = useState(false);
  const [showBashesDialog, setShowBashesDialog] = useState<string | boolean>(false);
  const handleExit = useCallback(() => {
    if (getCurrentWorktreeSession() !== null) {
      setShowExitFlow(true);
      return;
    }
    setIsExiting(true);
    void (async () => {
      try {
        const module = await import('../../commands/exit/exit.js');
        const element = await module.call(
          () => {
            setExitCommandJsx(null);
            setIsExiting(false);
          },
          { getAppState: () => store.getState() },
        );
        if (element === null || element === undefined) {
          setIsExiting(false);
          return;
        }
        setExitCommandJsx(element);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logForDebugging(`exit command failed: ${detail}`);
        setIsExiting(false);
        addNotification?.({
          key: 'exit-failed',
          text: `Could not exit (${detail}) — press ctrl+c to quit.`,
          priority: 'high',
          color: 'error' as const,
          timeoutMs: RECEIPT_TIMEOUT_MS,
        });
      }
    })();
  }, [store, addNotification]);
  return { toolJSX, setToolJSX, isExiting, showExitFlow, setShowExitFlow, exitCommandJsx, showCostThreshold, setShowCostThreshold, showBashesDialog, setShowBashesDialog, handleExit };
}

export function useChatDialogPaints({
  toolJSX,
  compactFocus,
  compactWork,
  fullscreen,
  chatSurfaceCovered,
  focusedInputDialog,
}: {
  toolJSX: ToolJSXState;
  compactFocus: CompactWorkFocus;
  compactWork: CompactWorkControls;
  fullscreen: boolean;
  chatSurfaceCovered: boolean;
  focusedInputDialog: FocusedInputDialog | undefined;
}) {
  const dialogSlotRef = useRef<DOMElement | null>(null);
  const [dialogPaints, setDialogPaints] = useState(false);
  useDerivedState(() => {
    const node = dialogSlotRef.current;
    const paints = toolJSX?.isLocalJSXCommand === true && node !== null && measureElement(node).height > 0;
    setDialogPaints(prev => (prev === paints ? prev : paints));
  });
  const localJsx = Boolean(toolJSX?.jsx && toolJSX.isLocalJSXCommand);
  const compactDetailUp = compactFocus === 'detail' && fullscreen && !chatSurfaceCovered && focusedInputDialog === undefined && !localJsx;
  const dialogOwnsKeys = (toolJSX?.isLocalJSXCommand === true && dialogPaints) || compactDetailUp;
  useLayoutPublish(() => {
    if (compactWork.read() === 'detail' && !compactDetailUp) compactWork.set('composer');
  }, [compactDetailUp, compactWork]);
  return { dialogSlotRef, dialogPaints, localJsx, compactDetailUp, dialogOwnsKeys };
}

export function useChatDialogsView({
  toolJSX,
  dialogSlotRef,
  localJsx,
  compactDetailUp,
  setShowCostThreshold,
  messages,
  fullscreen,
  compactWork,
  getToolUseContext,
  focusedEffectiveModel,
  chatSurfaceCovered,
  focusedInputDialog,
  elicitationQueue,
  respondToElicitation,
  dismissElicitationWaiting,
  crashResumeStaged,
  setCrashResumeStaged,
  addNotification,
  removeNotification,
  store,
}: {
  toolJSX: ToolJSXState;
  dialogSlotRef: React.RefObject<DOMElement | null>;
  localJsx: boolean;
  compactDetailUp: boolean;
  setShowCostThreshold: (show: boolean) => void;
  messages: Message[];
  fullscreen: boolean;
  compactWork: CompactWorkControls;
  getToolUseContext: (currentMessages: Message[], newMessages: Message[], controller: AbortController, model: string) => React.ComponentProps<typeof BackgroundTasksDialog>['toolUseContext'];
  focusedEffectiveModel: string;
  chatSurfaceCovered: boolean;
  focusedInputDialog: FocusedInputDialog | undefined;
  elicitationQueue: ElicitationQueue;
  respondToElicitation: React.ComponentProps<typeof ElicitationDialog>['onResponse'];
  dismissElicitationWaiting: NonNullable<React.ComponentProps<typeof ElicitationDialog>['onWaitingDismiss']>;
  crashResumeStaged: CrashResumeStaged | null;
  setCrashResumeStaged: (staged: CrashResumeStaged | null) => void;
  addNotification: ReturnType<typeof useNotifications>['addNotification'];
  removeNotification: ReturnType<typeof useNotifications>['removeNotification'];
  store: AppStateStore;
}) {
  const costThresholdShownRef = useRef<boolean>(getGlobalConfig().hasAcknowledgedCostThreshold === true);
  useDerivedState(() => {
    if (costThresholdShownRef.current) return;
    const focused = getFocusedSessionConnector();
    if (focused.usage().totalCostUSD < COST_THRESHOLD_USD) return;
    costThresholdShownRef.current = true;
    if (focused.identity().consoleBilling) setShowCostThreshold(true);
  }, [messages.length]);
  const centredModalUp = (localJsx && fullscreen) || compactDetailUp;
  const toolJSXRef = useRef(toolJSX);
  toolJSXRef.current = toolJSX;

  const dialogSlot: React.ReactNode = toolJSX?.jsx ? (
    <Box ref={dialogSlotRef} width="100%" flexDirection="column">
      {toolJSX.jsx}
    </Box>
  ) : null;
  const centredModal: React.ReactNode = compactDetailUp ? <BackgroundTasksDialog entry="compact-summary" compactControls={compactWork} onDone={() => compactWork.set('composer')} toolUseContext={getToolUseContext(messages, [], new AbortController(), focusedEffectiveModel)} /> : centredModalUp ? dialogSlot : null;
  const bottomImmediateJsx: React.ReactNode = localJsx && !fullscreen && toolJSX!.isImmediate ? dialogSlot : null;
  const inlineToolJsx = toolJSX?.jsx && !centredModal && !bottomImmediateJsx ? dialogSlot : null;

  const focusedBottomDialog: React.ReactNode = chatSurfaceCovered ? null :
    focusedInputDialog === 'elicitation' && elicitationQueue[0] ? (
      <ElicitationDialog event={elicitationQueue[0]} onResponse={respondToElicitation} onWaitingDismiss={dismissElicitationWaiting} />
    ) : focusedInputDialog === 'cost-threshold' ? (
      <CostThresholdDialog
        onDone={() => {
          setShowCostThreshold(false);
          saveGlobalConfig(config => ({ ...config, hasAcknowledgedCostThreshold: true }));
        }}
      />
    ) : focusedInputDialog === 'crash-resume' && crashResumeStaged !== null ? (
      <CrashResumeDialog
        origin={crashResumeStaged.origin}
        component={crashResumeStaged.component}
        message={crashResumeStaged.message}
        sessionId={crashResumeStaged.sessionId}
        cwd={crashResumeStaged.cwd}
        moreCount={crashResumeStaged.moreCount}
        onDone={action => {
          const staged = crashResumeStaged;
          setCrashResumeStaged(null);
          if (action !== 'resume' || staged === null) return;
          void (async () => {
            addNotification({
              key: 'session-switch',
              text: `opening ${staged.sessionId.slice(0, 8)}…`,
              priority: 'medium',
              timeoutMs: SWITCH_STATUS_TIMEOUT_MS,
            });
            const { focusResumedSession } = await import('../../daemon/switchboard/hopIntoSession.js');
            const outcome = await focusResumedSession(staged.sessionId, staged.transcriptPath, {
              permissionMode: store.getState().toolPermissionContext.mode,
            });
            removeNotification('session-switch');
            if (!outcome.ok) {
              addNotification({
                key: 'resume-hop',
                text: `the crashed session could not be reopened — ${outcome.reason}`,
                priority: 'high',
                color: 'error',
                timeoutMs: RECEIPT_TIMEOUT_MS,
              });
            }
          })();
        }}
      />
    ) : null;
  return { centredModalUp, toolJSXRef, centredModal, bottomImmediateJsx, inlineToolJsx, focusedBottomDialog };
}
