import React, { useCallback, useMemo, useRef, useState } from 'react';
import { usePublish } from '../effects/effects.js';
import { MercuryTurnRollup } from './MercuryTurnRollup.js';
import type { ToolUseConfirm } from '../../permissions/cards/PermissionRequest.js';
import { SpinnerWithVerb } from '../spinner/Spinner.js';
import { adoptSeatTurnStart } from '../spinner/seatClock.js';
import { StreamingHoldRow } from '../spinner/StreamingHoldRow.js';
import type { SpinnerMode } from '../spinner/spinnerMode.js';
import { statusLine, statusRowWarns } from './SwitchboardTagBar.js';
import { BASH_INPUT_TAG } from '../../engine/message-shapes/messageTags.js';
import type { useNotifications } from '../notifications/notifications.js';
import { Box } from '../themedRenderer.js';
import { FOLD_ROW_HEAD } from '../../engine/compaction/foldStatus.js';
import { getFocusedSessionConnector } from '../../engine/connector/focusedConnector.js';
import { hasSeatLive, IDLE_TURN_FACTS, type LiveTurnFactsV1, type SessionLiveV1 } from '../../engine/connector/seatLive.js';
import type { EngineConnectorV1 } from '../../engine/connector/types.js';
import { getTipToShowOnSpinner, recordShownTip } from '../tips/tipScheduler.js';
import { useAppState } from '../app-state/AppState.js';
import type { AppState } from '../app-state/AppStateStore.js';
import type { Message, ProgressMessage, UserMessage } from '../../engine/message-shapes/message.js';
import { activeToolVerb } from '../cockpit/toolVerb.js';
import { publishTurnSignals, turnEndedInError } from '../cockpit/turnSignals.js';
import type { FileStateCache } from '../../platform/files/fileStateCache.js';
import { extractTag, getUserMessageText } from '../../engine/messages/messages.js';
import { renderModelName } from '../../models/catalogue/engineModel.js';
import { crossProviderNote, settlePendingAtBoundary } from '../../models/catalogue/modelTransition.js';
import type { FocusedInputDialog } from './focusedDialog.js';
import type { ToolJSXState } from './useChatDialogs.js';
import { passedOver } from '../../platform/errors/passedOver.js';

const getFocusedLiveResponseChars = (): number => {
  const connector = getFocusedSessionConnector();
  return hasSeatLive(connector) ? (connector.turnChars?.() ?? 0) : 0;
};
const getFocusedLiveOutputTokens = (): number | null => {
  const connector = getFocusedSessionConnector();
  return hasSeatLive(connector) ? (connector.turnOutputTokens?.() ?? null) : null;
};
const getFocusedLiveTurnFacts = (): LiveTurnFactsV1 => {
  const connector = getFocusedSessionConnector();
  return hasSeatLive(connector) ? (connector.turnFacts?.() ?? IDLE_TURN_FACTS) : IDLE_TURN_FACTS;
};

function stopHookSuffix(messages: readonly Message[], isLoading: boolean): string | undefined {
  if (!isLoading) return undefined;
  let running = 0;
  let ran = 0;
  let total = 0;
  for (const message of messages) {
    if (message.type !== 'progress') continue;
    const data = (message as ProgressMessage).data as { type?: string; event?: string; state?: string; count?: number };
    if (data.type !== 'hook_progress' || data.event !== 'turn.answer') continue;
    if (data.state === 'running') {
      if (ran >= running) {
        running = 0;
        ran = 0;
      }
      running++;
      total = data.count ?? running;
    } else if (data.state === 'ran') {
      ran++;
    }
  }
  if (running === 0 || ran >= running) return undefined;
  if (total === 1) return 'running answer hook';
  return `running answer hooks · ${ran}/${total}`;
}

export function useChatTurnBoundary({
  isLoading,
  setAppState,
  addNotification,
}: {
  isLoading: boolean;
  setAppState: (updater: (prev: AppState) => AppState) => void;
  addNotification: ReturnType<typeof useNotifications>['addNotification'];
}) {
  usePublish(() => {
    setAppState(prev => (prev.foregroundTurnActive === isLoading ? prev : { ...prev, foregroundTurnActive: isLoading }));
  }, [isLoading, setAppState]);

  const pendingModelSwitch = useAppState(state => state.pendingModelSwitch);
  usePublish(() => {
    if (isLoading || pendingModelSwitch === null) return;
    let receipt = null as ReturnType<typeof settlePendingAtBoundary>;
    setAppState(prev => {
      const settled = settlePendingAtBoundary(
        { engineModel: prev.engineModel, engineModelForSession: prev.engineModelForSession, pendingModelSwitch: prev.pendingModelSwitch },
      );
      if (!settled) return prev;
      receipt = settled;
      return { ...prev, ...settled.patch, lastModelTransition: settled.receipt };
    });
    const settledReceipt: ReturnType<typeof settlePendingAtBoundary> = receipt;
    if (settledReceipt) {
      const applied = settledReceipt.receipt.applied;
      const label = applied === null ? 'Default' : renderModelName(applied);
      addNotification({
        key: 'model-transition-applied',
        invalidates: ['model-switched'],
        text: `${label} applied — queued during the turn${settledReceipt.receipt.crossProvider ? crossProviderNote(applied) : ''}`,
        priority: 'immediate',
        timeoutMs: 4000,
      });
    }
  }, [isLoading, pendingModelSwitch, setAppState, addNotification]);
  return { pendingModelSwitch };
}

export function useChatSeatClock({
  seatLive,
  focusedInputDialog,
  isLoading,
}: {
  seatLive: SessionLiveV1;
  focusedInputDialog: FocusedInputDialog | undefined;
  isLoading: boolean;
}) {
  const seatStartTimeRef = useRef(0);
  const seatPausedMsRef = useRef(0);
  const seatPauseStartRef = useRef<number | null>(null);
  {
    const ledger = adoptSeatTurnStart(
      { startMs: seatStartTimeRef.current, pausedMs: seatPausedMsRef.current, pauseStartMs: seatPauseStartRef.current },
      seatLive.turnStartedAtMs,
      Date.now(),
    );
    seatStartTimeRef.current = ledger.startMs;
    seatPausedMsRef.current = ledger.pausedMs;
    seatPauseStartRef.current = ledger.pauseStartMs;
  }
  const previousFocusedDialogRef = useRef<FocusedInputDialog | undefined>(undefined);
  usePublish(() => {
    const previous = previousFocusedDialogRef.current;
    previousFocusedDialogRef.current = focusedInputDialog;
    if (!isLoading) return;
    if (previous !== 'tool-permission' && focusedInputDialog === 'tool-permission') {
      seatPauseStartRef.current = Date.now();
    } else if (previous === 'tool-permission' && focusedInputDialog !== 'tool-permission') {
      if (seatPauseStartRef.current !== null) {
        seatPausedMsRef.current += Date.now() - seatPauseStartRef.current;
        seatPauseStartRef.current = null;
      }
    }
  }, [focusedInputDialog, isLoading]);
  return { seatStartTimeRef, seatPausedMsRef, seatPauseStartRef };
}

function hasLastTurnCompletedAtMs(
  connector: EngineConnectorV1 & { lastTurnCompletedAtMs?: () => number | null },
): connector is EngineConnectorV1 & { lastTurnCompletedAtMs: () => number | null } {
  return typeof connector.lastTurnCompletedAtMs === 'function';
}
export function useChatTurnEnd({
  focusedConnector,
  isLoading,
  setAppState,
  themeName,
  getReadFileState,
  seatPausedMsRef,
  seatPauseStartRef,
}: {
  focusedConnector: EngineConnectorV1;
  isLoading: boolean;
  setAppState: (updater: (prev: AppState) => AppState) => void;
  themeName: NonNullable<Parameters<typeof getTipToShowOnSpinner>[0]>['theme'];
  getReadFileState: () => FileStateCache;
  seatPausedMsRef: { current: number };
  seatPauseStartRef: { current: number | null };
}) {
  const tipPickedThisTurnRef = useRef(false);
  const shellCommandsSeenRef = useRef(new Set<string>());
  const shellScanCursorRef = useRef(0);
  const pickTurnTip = useCallback(() => {
    if (tipPickedThisTurnRef.current) return;
    tipPickedThisTurnRef.current = true;
    const transcript = getFocusedSessionConnector().records();
    for (let i = shellScanCursorRef.current; i < transcript.length; i++) {
      const message = transcript[i]!;
      if (message.type !== 'user') continue;
      const text = getUserMessageText(message as UserMessage);
      const command = text ? extractTag(text, BASH_INPUT_TAG) : null;
      if (command) shellCommandsSeenRef.current.add(command.trim());
    }
    shellScanCursorRef.current = transcript.length;
    const theme = themeName;
    void getTipToShowOnSpinner({ theme, readFileState: getReadFileState(), bashTools: new Set(shellCommandsSeenRef.current) })
      .then(async tip => {
        if (tip) {
          const content = await tip.content({ theme });
          setAppState(prev => ({ ...prev, spinnerTip: content }));
          recordShownTip(tip);
        } else {
          setAppState(prev => (prev.spinnerTip === undefined ? prev : { ...prev, spinnerTip: undefined }));
        }
      })
      .catch(passedOver);
  }, [setAppState, themeName, getReadFileState]);
  const hasConnectorCompleted = hasLastTurnCompletedAtMs(focusedConnector);
  const connectorCompletedAt = hasConnectorCompleted ? focusedConnector.lastTurnCompletedAtMs() : null;
  const [turnEndState, setTurnEndState] = useState<{
    connector: unknown;
    at: number | null;
    wasLoading: boolean;
    lastCompletedAt: number | null;
    completionSeq: number;
  }>(() => ({
    connector: focusedConnector,
    at: connectorCompletedAt,
    wasLoading: isLoading,
    lastCompletedAt: null,
    completionSeq: 0,
  }));
  if (turnEndState.connector !== focusedConnector) {
    setTurnEndState(prev => ({
      ...prev,
      connector: focusedConnector,
      at: connectorCompletedAt,
      wasLoading: isLoading,
    }));
  } else {
    const completed = hasConnectorCompleted
      ? !isLoading && connectorCompletedAt !== null && connectorCompletedAt !== turnEndState.at
      : turnEndState.wasLoading && !isLoading;
    const nextAt = !isLoading ? connectorCompletedAt : turnEndState.at;
    if (completed || nextAt !== turnEndState.at || isLoading !== turnEndState.wasLoading) {
      setTurnEndState(prev => ({
        connector: focusedConnector,
        at: nextAt,
        wasLoading: isLoading,
        lastCompletedAt: completed ? Date.now() : prev.lastCompletedAt,
        completionSeq: completed ? prev.completionSeq + 1 : prev.completionSeq,
      }));
    }
  }
  const handledCompletionSeqRef = useRef(0);
  usePublish(() => {
    if (turnEndState.completionSeq !== handledCompletionSeqRef.current) {
      handledCompletionSeqRef.current = turnEndState.completionSeq;
      seatPausedMsRef.current = 0;
      seatPauseStartRef.current = null;
      pickTurnTip();
    }
    if (isLoading) tipPickedThisTurnRef.current = false;
  }, [turnEndState.completionSeq, isLoading, pickTurnTip]);
  return { lastCompletedAt: turnEndState.lastCompletedAt };
}

export function useChatTurnSignals({
  isLoading,
  textActive,
  toolUseConfirmQueue,
  messages,
}: {
  isLoading: boolean;
  textActive: boolean;
  toolUseConfirmQueue: ToolUseConfirm[];
  messages: Message[];
}): void {
  usePublish(() => {
    publishTurnSignals({
      turnLive: isLoading,
      streaming: textActive,
      awaitingPermission: toolUseConfirmQueue.length > 0,
      endedInError: !isLoading && turnEndedInError(messages),
    });
  }, [isLoading, textActive, toolUseConfirmQueue.length, messages]);
}

export function useChatStatusStrip({
  seatLive,
  messages,
  toolJSX,
  toolUseConfirmQueue,
  isLoading,
  isStopping,
  textActive,
  streamingSuppressed,
  isCompact,
  focusedConnector,
  spinnerTip,
  verbose,
  seatStartTimeRef,
  seatPausedMsRef,
  seatPauseStartRef,
}: {
  seatLive: SessionLiveV1;
  messages: Message[];
  toolJSX: ToolJSXState;
  toolUseConfirmQueue: ToolUseConfirm[];
  isLoading: boolean;
  isStopping: boolean;
  textActive: boolean;
  streamingSuppressed: boolean;
  isCompact: boolean;
  focusedConnector: EngineConnectorV1;
  spinnerTip: AppState['spinnerTip'];
  verbose: boolean;
  seatStartTimeRef: React.RefObject<number>;
  seatPausedMsRef: React.RefObject<number>;
  seatPauseStartRef: React.RefObject<number | null>;
}) {
  const viewInProgressToolUseIDs = seatLive.inProgressToolUseIDs;
  const viewStreamMode: SpinnerMode =
    seatLive.phase === 'thinking' ? 'thinking' : seatLive.phase === 'tool' ? 'tool-use' : seatLive.phase === 'compacting' || seatLive.phase === 'waiting' ? 'requesting' : 'responding';
  const viewCompacting = seatLive.phase === 'compacting';
  const responseLengthRef = useMemo(
    () => ({
      get current(): number {
        return getFocusedLiveResponseChars();
      },
    }),
    [],
  );
  const outputTokensRef = useMemo(
    () => ({
      get current(): number | null {
        return getFocusedLiveOutputTokens();
      },
    }),
    [],
  );
  const liveTurnFactsRef = useMemo(
    () => ({
      get current(): LiveTurnFactsV1 {
        return getFocusedLiveTurnFacts();
      },
    }),
    [],
  );
  const onlySleepToolActive = useMemo(() => {
    if (viewInProgressToolUseIDs.size === 0) return false;
    const sleeping = new Set<string>();
    for (const message of messages) {
      if (message.type !== 'assistant') continue;
      const content = (message as { message: { content?: unknown } }).message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if ((block as { type?: string }).type === 'tool_use' && (block as { name?: string }).name === 'Sleep') sleeping.add((block as { id: string }).id);
      }
    }
    for (const id of viewInProgressToolUseIDs) if (!sleeping.has(id)) return false;
    return true;
  }, [viewInProgressToolUseIDs, messages]);
  const spinnerSlotReserved = (!toolJSX || toolJSX.showSpinner === true) &&
    toolUseConfirmQueue.length === 0 &&
    (isLoading || isStopping) &&
    !onlySleepToolActive;
  const showSpinner = spinnerSlotReserved && (
    !textActive || streamingSuppressed
  );
  const spinnerSuffix = stopHookSuffix(messages, isLoading);
  const hookWaitKeys = useMemo(() => [...viewInProgressToolUseIDs], [viewInProgressToolUseIDs]);
  const compactSeatStatus = isCompact && hasSeatLive(focusedConnector) ? { ...focusedConnector.status(), wait: null } : null;
  const compactStatus = compactSeatStatus !== null && statusRowWarns(seatLive, compactSeatStatus) ? statusLine(seatLive, compactSeatStatus, null, true) : '';
  const workingStatusStrip = <Box flexDirection="column">
    {showSpinner || (isCompact && spinnerSlotReserved) ? (
      <SpinnerWithVerb compact={isCompact} compactWarning={compactStatus !== '' && compactStatus !== 'ready'} mode={viewStreamMode}
        loadingStartTimeRef={seatStartTimeRef}
        totalPausedMsRef={seatPausedMsRef}
        pauseStartTimeRef={seatPauseStartRef}
        spinnerTip={spinnerTip}
        responseLengthRef={responseLengthRef}
        outputTokensRef={outputTokensRef}
        liveTurnFactsRef={liveTurnFactsRef}
        overrideColor={null}
        overrideShimmerColor={null}
        overrideMessage={compactStatus !== '' && compactStatus !== 'ready' ? compactStatus : viewCompacting ? FOLD_ROW_HEAD : null}
        still={viewCompacting}
        spinnerSuffix={spinnerSuffix ?? null}
        hookWaitKeys={hookWaitKeys}
        verbose={verbose}
        hasActiveTools={viewInProgressToolUseIDs.size > 0}
        activeToolCount={viewInProgressToolUseIDs.size}
        activeToolLabel={activeToolVerb(messages, viewInProgressToolUseIDs)}
        waitingOnCrewmates={seatLive.phase === 'waiting'}
        leaderIsIdle={!isLoading}
      />
    ) : spinnerSlotReserved ? <StreamingHoldRow loadingStartTimeRef={seatStartTimeRef} totalPausedMsRef={seatPausedMsRef} pauseStartTimeRef={seatPauseStartRef} responseLengthRef={responseLengthRef} outputTokensRef={outputTokensRef} liveTurnFactsRef={liveTurnFactsRef} /> : null}
    {!isCompact ? <MercuryTurnRollup messages={messages} /> : null}
  </Box>;
  return { viewInProgressToolUseIDs, viewStreamMode, spinnerSlotReserved, workingStatusStrip };
}
