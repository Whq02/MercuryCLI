// The main interactive screen — THE FACE over the focused chat. Every
// session is a full chat running in its own process (the daemon hosts it);
// the one on screen is the focused chat, reached through its engine
// connector, and before any session exists the focused chat is the blank
// chat whose first message creates one. This screen owns the composer, the
// transcript in its two modes, the consent card, the dialogs, the status
// strip and every chrome element — and never an engine. One keystroke has
// exactly one owner, and the owner is discoverable.

import type { UUID } from 'node:crypto';
import { takeResumeFoldNotice } from '../services/run/runCoordinator.js';
import { subscribeTranscriptLoadDegradation, transcriptLoadDegradation } from '../utils/sessionStorage/loading.js';
import { subscribeTranscriptStoreHealth, transcriptStoreHealth } from '../utils/sessionStorage/writer.js';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename as nodePathBasename, join } from 'node:path';
import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { getOriginalCwd, getProjectRoot, getSessionId } from '../bootstrap/state.js';
import { commandOffInPlainWorld, commandRetired, commandSeat, getCommandName, isCommandEnabled, type Command, type ResumeEntrypoint } from '../commands.js';
import { AutoDefaultNotice, AutoDefaultNudgeDialog } from '../components/AutoDefaultDialogs.js';
import { CostThresholdDialog } from '../components/CostThresholdDialog.js';
import { ExitFlow } from '../components/ExitFlow.js';
import { computeUnseenDivider, countUnseenAssistantTurns, FullscreenLayout, useUnseenDivider } from '../components/FullscreenLayout.js';
import { IdleReturnDialog } from '../components/IdleReturnDialog.js';
import { MercuryTurnRollup } from '../components/MercuryTurnRollup.js';
import {
  MessageActionsKeybindings,
  useMessageActions,
  type MessageActionsNav,
} from '../components/messageActions.js';
import { MessageSelector } from '../components/MessageSelector.js';
import { Messages } from '../components/Messages.js';
import { PermissionQueueContext, permissionQueueStatus } from '../components/permissions/PermissionQueueContext.js';
import { PermissionRequest, type ToolUseConfirm } from '../components/permissions/PermissionRequest.js';
import PromptInput from '../components/PromptInput/PromptInput.js';
import { isVimModeEnabled } from '../components/PromptInput/utils.js';
import { SandboxViolationExpandedView } from '../components/SandboxViolationExpandedView.js';
import { ScrollKeybindingHandler } from '../components/ScrollKeybindingHandler.js';
import { BriefIdleStatus } from '../components/Spinner.js';
import { MessageActionsBar } from '../components/messageActions.js';
import { setMessageCursor, useMessageCursorActive } from '../components/messageCursorStore.js';
import { FocusedSessionStatusRow } from '../components/SwitchboardTagBar.js';
import {
  useKickOffCheckAndDisableBypassPermissionsIfNeeded,
  useKickOffCheckAndDisableAutoModeIfNeeded,
} from '../utils/permissions/bypassPermissionsKillswitch.js';
import { useExtensions } from '../hooks/useExtensions.js';
import { useCostSummary } from '../costHook.js';
import { useFpsMetrics } from '../context/fpsMetrics.js';
import { useOverlayOpen } from '../context/overlayContext.js';
import { startBackgroundHousekeeping } from '../utils/backgroundHousekeeping.js';
import { scheduleQuietUpdateNotice, UPDATE_NOTICE_KEY } from '../services/privateChannel/quietUpdateNotice.js';
import { activeToolVerb } from '../utils/cockpit/toolVerb.js';
import { publishCompanionTurn } from '../utils/cockpit/companionSignals.js';
import { publishMcpConnections } from '../utils/cockpit/mcpGauge.js';
import { dynamicMcpConfigSnapshot, ideAutoConnectSeed, setDynamicMcpConfig } from '../services/mcp/dynamicMcpSeed.js';
import type { ScopedMcpServerConfig } from '../services/mcp/types.js';
import { useIDEIntegration } from '../hooks/useIDEIntegration.js';
import { useIdeSelection, type IDESelection } from '../hooks/useIdeSelection.js';
import { useIdeLogging } from '../hooks/useIdeLogging.js';
import { useIDEStatusIndicator } from '../hooks/notifs/useIDEStatusIndicator.js';
import { useSeatReceipts } from '../hooks/useSeatReceipts.js';
import { useAgentStateClassifier } from '../hooks/useAgentStateClassifier.js';
import { IdeOnboardingDialog } from '../components/IdeOnboardingDialog.js';
import { type IDEExtensionInstallationStatus, type IdeType } from '../utils/ide.js';
import { ElicitationDialog } from '../components/mcp/ElicitationDialog.js';
import { useMcpConnectivityStatus } from '../hooks/notifs/useMcpConnectivityStatus.js';
import { recordBootInteractive } from '../utils/observability/frictionStopwatch.js';
import { readAllTranscriptEntries } from '../utils/sessionStorage/materialize.js';
import { isHumanTurn } from '../utils/messagePredicates.js';
import { submitTrace } from '../utils/submitTrace.js';
import { fluxMark, fluxWhy } from '../utils/flux/fluxProbe.js';
import { SpinnerWithVerb } from '../components/Spinner.js';
import { StreamingHoldRow } from '../components/Spinner/StreamingHoldRow.js';
import type { SpinnerMode } from '../components/Spinner/types.js';
import { SwitchboardAttributionProvider } from '../components/SwitchboardTagBar.js';
import { useMercuryTokens } from '../components/mercury-ui/useMercuryTokens.js';
import { LOCAL_COMMAND_STDOUT_TAG, BASH_INPUT_TAG } from '../constants/xml.js';
import { CockpitBottomStatus } from '../context/cockpitActiveContext.js';
import { MercuryFrame } from '../components/MercuryFrame.js';
import { useNotifications } from '../context/notifications.js';
import { performUiRouteAlias } from '../context/routeAliases.js';
import { currentSurfaceRoute, settleAbsentChat, subscribeSurfaceRoute } from '../context/surfaceRoute.js';
import { CancelRequestHandler } from '../hooks/useCancelRequest.js';
import { CommandKeybindingHandlers } from '../hooks/useCommandKeybindings.js';
import { GlobalKeybindingHandlers } from '../hooks/useGlobalKeybindings.js';
import { useAgentsChange } from '../hooks/useAgentsChange.js';
import { useApiKeyVerification } from '../hooks/useApiKeyVerification.js';
import { useConcourseLifecycleSignals } from '../hooks/useConcourseLifecycleSignals.js';
import { useMainLoopModel } from '../hooks/useMainLoopModel.js';
import { useMergedCommands } from '../hooks/useMergedCommands.js';
import { useMergedTools } from '../hooks/useMergedTools.js';
import { useObligationSignals } from '../hooks/useObligationSignals.js';
import { usePingEngine } from '../hooks/usePingEngine.js';
import { useCrossProjectFinishPings } from '../hooks/useCrossProjectFinishPings.js';
import { useSessionTitleMint } from '../hooks/useSessionTitleMint.js';
import { useSearchInput } from '../hooks/useSearchInput.js';
import { useSettingsChange } from '../hooks/useSettingsChange.js';
import { useSkillsChange } from '../hooks/useSkillsChange.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { packHints } from '../components/mercury-ui/geometry.js';
import { stringWidth } from '../ink/stringWidth.js';
import type { VimMode } from '../hooks/useVimInput.js';
import { useAutoModeUnavailableNotification } from '../hooks/notifs/useAutoModeUnavailableNotification.js';
import { useCanSwitchToExistingSubscription } from '../hooks/notifs/useCanSwitchToExistingSubscription.js';
import { useDeprecationWarningNotification } from '../hooks/notifs/useDeprecationWarningNotification.js';
import { useLspInitializationNotification } from '../hooks/notifs/useLspInitializationNotification.js';
import { useModelMigrationNotifications } from '../hooks/notifs/useModelMigrationNotifications.js';
import { useRateLimitWarningNotification } from '../hooks/notifs/useRateLimitWarningNotification.js';
import { useSettingsErrors } from '../hooks/notifs/useSettingsErrors.js';
import { Box, Text, useStdin, useTheme } from '../ink.js';
import { AlternateScreen } from '../ink/components/AlternateScreen.js';
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js';
import useInput from '../ink/hooks/use-input.js';
import { useInterval } from '../ink/hooks/use-interval.js';
import { useSearchHighlight } from '../ink/hooks/use-search-highlight.js';
import { useTabStatus, type TabStatusKind } from '../ink/hooks/use-tab-status.js';
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js';
import { useTerminalTitle } from '../ink/hooks/use-terminal-title.js';
import { streamingRevealSuppressed } from '../ink/session/capabilities.js';
import { setClipboardWithReceipt } from '../ink/termio/osc.js';
import { useTerminalNotification } from '../ink/useTerminalNotification.js';
import * as pendingInput from '../input-core/pending-input.js';
import { rekeyCommandQueueToSession } from '../input-core/command-queue.js';
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { getShortcutDisplay } from '../keybindings/shortcutFormat.js';
import { modelDisplayString, renderModelName } from '../utils/model/model.js';
import { crossProviderNote, settlePendingAtBoundary } from '../utils/model/modelTransition.js';
import { createBranchSession } from '../services/branches/branchManifest.js';
import { hasSeatLive, IDLE_LIVE, type SessionLiveV1 } from '../services/engine-connector/seatLive.js';
import { useFocusedTranscript } from '../hooks/useFocusedTranscript.js';
import { useAppState, useAppStateStore, useSetAppState } from '../state/AppState.js';
import type { AppState } from '../state/AppStateStore.js';
import {
  getFocusedSessionConnector,
  hasFocusedSession,
  landingInFlight,
  subscribeFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js';
import {
  enteringWarmth,
  entryLoadingLineOf,
  evictSessionWarmth,
  paintedTranscriptOf,
  sessionWarmthVersion,
  settleEntryWarmth,
  subscribeSessionWarmth,
} from '../services/concourse/sessionWarmth.js';
import type { RewindReceiptV1, SessionAskV1 } from '../services/engine-connector/types.js';
import { flagEnv } from '../substrate/flagRegistry.js';
import { resolveTerminalExperience } from '../ink/session/terminalExperience.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js';
import { themisBootVerify } from '../substrate/themis/boot.js';
import { themisActive } from '../substrate/themis/level.js';
import type { SetToolJSXFn, Tool, ToolPermissionContext } from '../Tool.js';
import { resolveToolJSX } from './toolJsxArbitration.js';
import type { LogOption } from '../types/logs.js';
import type { Message, NormalizedUserMessage, ProgressMessage, UserMessage } from '../types/message.js';
import type { PermissionMode } from '../types/permissions.js';
import { ASK_USER_QUESTION_TOOL_NAME } from '../tools/AskUserQuestionTool/prompt.js';
import type { PromptInputMode } from '../types/textInputTypes.js';
import { asSessionId } from '../types/ids.js';
import { createAbortController } from '../utils/abortController.js';
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js';
import type { PastedContent } from '../utils/config/schema.js';
import { crashReportDirDisplay, markCrashReportsNoticed, unnoticedCrashReports } from '../utils/crashReport.js';
import { getProjectDir } from '../utils/sessionStoragePortable.js';
import { CrashResumeDialog } from '../components/CrashResumeDialog.js';
import { getCwd } from '../utils/cwd.js';
import { logForDebugging } from '../utils/debug.js';
import { consumeEarlyInput } from '../utils/earlyInput.js';
import { isEnvTruthy } from '../utils/envUtils.js';
import { renderMessagesToPlainText } from '../utils/exportRenderer.js';
import { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE, type FileStateCache } from '../utils/fileStateCache.js';
import { isFullscreenEnvEnabled, isMouseTrackingEnabled, maybeGetTmuxMouseHint } from '../utils/fullscreen.js';
import type { PromptInputHelpers } from '../types/promptInputHelpers.js';
import { formatCommandLoadingMetadata, resolveUnknownSlashName, unavailableCommandLine, unknownCommandLine } from '../utils/processUserInput/processSlashCommand.js';
import { addToHistory } from '../history.js';
import { mercuryBootPreflightEnabled, runAndRecordPreflight } from '../utils/healthPreflight.js';
import { createCommandInputMessage, createUserMessage, extractTag, getUserMessageText, textForResubmit } from '../utils/messages.js';
import { shouldShowAutoDefaultNotice } from '../utils/permissions/shouldShowAutoDefaultNotice.js';
import { shouldShowAutoDefaultNudge } from '../utils/permissions/shouldShowAutoDefaultNudge.js';
import { getTipToShowOnSpinner, recordShownTip } from '../services/tips/tipScheduler.js';
import { sendNotification } from '../services/notifier.js';
import { startPreventSleep, stopPreventSleep } from '../services/preventSleep.js';
import { getCurrentSessionTitle } from '../utils/sessionStorage/logs.js';
import { getCurrentWorktreeSession } from '../utils/worktree.js';
import { registerComposerSeeder } from '../utils/cockpit/composerSeed.js';
import { registerPermissionFocusNotifier } from '../utils/permissions/permissionFocus.js';
import { publishCockpitActivity, type ActivityState } from '../utils/cockpit/cockpitActivity.js';
import { parseSearchQuery } from '../utils/transcriptSearch.js';
import type { StreamingToolUse } from '../utils/messages/streaming.js';

export type Screen = 'prompt' | 'transcript';

export type Props = {
  commands: Command[];
  debug?: boolean;
  initialTools: Tool[];
  /** Hides input entirely (a read-only host). */
  disabled?: boolean;
  disableSlashCommands?: boolean;
};

// ── contract data ────────────────────────────────────────────────────────
const IDLE_THRESHOLD_MINUTES_ENV = 'MERCURY_IDLE_THRESHOLD_MINUTES';
const IDLE_TOKEN_THRESHOLD_ENV = 'MERCURY_IDLE_TOKEN_THRESHOLD';
const DEFAULT_IDLE_THRESHOLD_MINUTES = 75;
const DEFAULT_IDLE_TOKEN_THRESHOLD = 100_000;
const TITLE_FRAMES = ['⠂', '⠐'] as const;
const TITLE_STATIC_MARK = '✻';
const TITLE_INTERVAL_MS = 960;
const COST_THRESHOLD_USD = 5;
const RECENT_SCROLL_REPIN_WINDOW_MS = 3000;
const SWITCH_STATUS_TIMEOUT_MS = 30_000;
const WORKTREE_TIP_SECONDS = 15;
const BOOT_WARMUP_MS = 150;
const SEARCH_WARMUP_QUIET_MS = 20;
const SEARCH_WARMUP_SHOW_MS = 2000;
const EDITOR_STATUS_MS = 4000;
const RECEIPT_TIMEOUT_MS = 8000;
/** How long a rewind waits for an interrupted turn to settle before asking
 *  the runner (which refuses under a live turn). */
const REWIND_SETTLE_WAIT_MS = 5000;

/** The one-line receipt a landed rewind paints: what moved, in the
 *  operator's words. */
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
/** The beat the no-chat check settles for before the boot face takes the
 *  frame — long enough for a dialog command to load and mount after its
 *  armed line was consumed, short enough to read as immediate. */
const NO_CHAT_SETTLE_MS = 150;
const PERSISTENT_NOTIFICATION_MS = 2_147_483_647;
const MESSAGE_ACTION_UUID_PREFIX = 24;
const EMPTY_CONFIRM_QUEUE: ToolUseConfirm[] = [];
const NO_STREAMING_TOOL_USES: StreamingToolUse[] = [];

// ── the focused chat's feeds, composed through the connector slot ─────────
// Every face reader rides the slot: the consent cards render whichever
// session holds the screen, the live turn folds from its records, the
// model readout and the streaming tail are its own.
const subscribeFocusedAsks = subscribeThroughFocused((connector, listener) => connector.subscribeAsks(listener));
const getFocusedAsks = (): readonly SessionAskV1[] => getFocusedSessionConnector().asks();
const subscribeFocusedSeatLive = subscribeThroughFocused((connector, listener) =>
  hasSeatLive(connector) ? connector.subscribeLive(listener) : () => {},
);
const getFocusedSeatLive = (): SessionLiveV1 => {
  const connector = getFocusedSessionConnector();
  return hasSeatLive(connector) ? connector.live() : IDLE_LIVE;
};
const subscribeFocusedModel = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener));
const getFocusedEffectiveModel = (): string => getFocusedSessionConnector().modelFacts().effective;
// The focused chat's LIVE TAIL (the reply's text block as it streams) — the
// same store shape the streaming reveal paints from, fed by the session's
// connector; a boolean snapshot (text or none) is all the screen re-renders
// on, the tail leaf subscribes to the text itself.
const subscribeFocusedTail = subscribeThroughFocused((connector, listener) =>
  hasSeatLive(connector) ? connector.tail().subscribe(listener) : () => {},
);
const getFocusedTailActive = (): boolean => {
  const connector = getFocusedSessionConnector();
  return hasSeatLive(connector) ? connector.tail().getSnapshot() !== null : false;
};
// The focused chat's live streamed-character count (the tail projection's
// turnChars) — the spinner's token counter and tok/s read it through the
// live ref below; 0 when idle or on a connector without the accessor.
const getFocusedLiveResponseChars = (): number => {
  const connector = getFocusedSessionConnector();
  return hasSeatLive(connector) ? (connector.turnChars?.() ?? 0) : 0;
};
const getFocusedStatusKey = (): string => {
  const connector = getFocusedSessionConnector();
  return hasSeatLive(connector) ? `${connector.status().interrupting ? 1 : 0}` : '0';
};

// The composer's MCP roster prop on the connector-fed chat: one frozen empty
// array, never a literal minted per render (a fresh [] re-rendered the
// memoised composer on every root render — the region matrix's marks).
const NO_MCP_CLIENTS: never[] = [];

// Words arriving through the connector door carry no composer buffer.
const INERT_PROMPT_HELPERS: PromptInputHelpers = {
  setCursorOffset: () => {},
  clearBuffer: () => {},
  resetHistory: () => {},
};

/** A chat that paints its own rows (a daemon-hosted session) takes a
 *  display row; the blank chat owns no rows. */
type PaintsRows = { addDisplayRow?: (row: Message) => void; transcriptFile?: () => string };

type FocusedInputDialog = 'message-selector' | 'tool-permission' | 'elicitation' | 'ide-onboarding' | 'cost-threshold' | 'idle-return' | 'crash-resume' | 'auto-mode';

type ToolJSXState = Parameters<SetToolJSXFn>[0];

/** What a resume needs from a session record: the live messages plus the
 *  optional identity/metadata fields the flow reads. A full LogOption fits;
 *  so does a freshly loaded conversation result. */
type ResumableLog = Omit<Partial<LogOption>, 'messages'> & { messages: Message[] };

type FrozenTranscriptState = { messageCount: number; streamingToolUseCount: number };

type ScrollRestore = { gap: number; sticky: boolean };

type IdleReturnTreatment = 'off' | 'dialog' | 'hint-dim' | 'hint-plain';

/** Exactly one dialog may hold focus; this order is the contract. */
function getFocusedInputDialog(args: {
  isExiting: boolean;
  showMessageSelector: boolean;
  isPromptInputActive: boolean;
  toolJSX: ToolJSXState;
  toolUseConfirmQueueLength: number;
  elicitationQueueLength: number;
  showIdeOnboarding: boolean;
  showCostThreshold: boolean;
  showIdleReturn: boolean;
  showCrashResume: boolean;
  showAutoModeSurface: boolean;
}): FocusedInputDialog | undefined {
  const { isExiting, showMessageSelector, isPromptInputActive, toolJSX, toolUseConfirmQueueLength, elicitationQueueLength, showIdeOnboarding, showCostThreshold, showIdleReturn, showCrashResume, showAutoModeSurface } = args;
  if (isExiting) return undefined;
  if (showMessageSelector) return 'message-selector';
  // Interrupt dialogs stand down while a typing burst is in progress: a
  // dialog mounting under a moving hand eats the next keystroke as its verb.
  if (isPromptInputActive) return undefined;
  // A blocking overlay stands the rest down — unless it asked for the
  // animation to continue (a background hint waiting on user interaction).
  const blocked = toolJSX !== null && toolJSX.jsx !== null && toolJSX.shouldContinueAnimation !== true;
  if (blocked) return undefined;
  if (toolUseConfirmQueueLength > 0) return 'tool-permission';
  // MCP elicitation (Law 9 restore): the manager's handler queues the
  // request into AppState.elicitation and the SERVER WAITS on the answer —
  // an unmounted card left every elicitation hanging forever.
  if (elicitationQueueLength > 0) return 'elicitation';
  if (showIdeOnboarding) return 'ide-onboarding';
  if (showCostThreshold) return 'cost-threshold';
  if (showIdleReturn) return 'idle-return';
  // The crash re-entry offer (FN-013 CRASH-03) outranks the auto-mode
  // nudge: a session that died with work in it is the more urgent fact.
  if (showCrashResume) return 'crash-resume';
  if (showAutoModeSurface) return 'auto-mode';
  return undefined;
}

function positiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function idleThresholdMinutes(): number {
  return positiveNumberEnv(IDLE_THRESHOLD_MINUTES_ENV, DEFAULT_IDLE_THRESHOLD_MINUTES);
}

function idleTokenThreshold(): number {
  return positiveNumberEnv(IDLE_TOKEN_THRESHOLD_ENV, DEFAULT_IDLE_TOKEN_THRESHOLD);
}

function idleReturnTreatment(): IdleReturnTreatment {
  // A feature-value lookup, not a flag: which variant ships is decided
  // outside this screen; unset it is 'off'.
  const raw = getFeatureValue_CACHED_MAY_BE_STALE<string>('idle_return_treatment', 'off');
  if (raw === 'dialog') return 'dialog';
  if (raw === 'hint') return 'hint-dim';
  if (raw === 'hint_v2') return 'hint-plain';
  return 'off';
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** The stop-hook spinner suffix, derived from the transcript while loading. */
function stopHookSuffix(messages: readonly Message[], isLoading: boolean): string | undefined {
  if (!isLoading) return undefined;
  type HookProgress = {
    hookEvent?: string;
    hookExecutionId?: string;
    hookName?: string;
    statusMessage?: string;
    completed?: boolean;
  };
  const progress: HookProgress[] = [];
  const summarised = new Set<string>();
  const completedByExecution = new Map<string, number>();
  for (const message of messages) {
    if (message.type === 'progress') {
      const data = (message as ProgressMessage).data as { type?: string } & HookProgress;
      if (data.type === 'hook_progress' && (data.hookEvent === 'Stop' || data.hookEvent === 'SubagentStop')) {
        progress.push(data);
      }
      continue;
    }
    if (message.type === 'system') {
      const sys = message as { subtype?: string; hookExecutionId?: string };
      if (sys.subtype === 'stop_hook_summary' && sys.hookExecutionId) summarised.add(sys.hookExecutionId);
      continue;
    }
    if (message.type === 'attachment') {
      const att = (message as { attachment?: { type?: string; hookEvent?: string; hookExecutionId?: string } }).attachment;
      if (att && att.hookExecutionId && (att.hookEvent === 'Stop' || att.hookEvent === 'SubagentStop')) {
        completedByExecution.set(att.hookExecutionId, (completedByExecution.get(att.hookExecutionId) ?? 0) + 1);
      }
    }
  }
  if (progress.length === 0) return undefined;
  const latest = progress[progress.length - 1]!;
  const executionId = latest.hookExecutionId ?? '';
  if (executionId && summarised.has(executionId)) return undefined;
  const ofExecution = progress.filter(p => (p.hookExecutionId ?? '') === executionId);
  const total = ofExecution.length;
  const completed = Math.min(total, completedByExecution.get(executionId) ?? ofExecution.filter(p => p.completed).length);
  const custom = ofExecution.find(p => p.statusMessage)?.statusMessage;
  // Counts ride the status line's ' · ' grammar — a parenthesised count
  // beside the row's own (…) HUD group painted two adjacent paren runs
  // (the jammed-specimen sweep).
  if (custom) return total > 1 ? `${custom} · ${completed}/${total}` : custom;
  // Asymmetric by contract: one hook names its event, several go generic.
  if (total === 1) {
    return latest.hookEvent === 'SubagentStop' ? 'running subagent stop hook' : 'running stop hook';
  }
  return `running stop hooks · ${completed}/${total}`;
}

/** Title animation in an isolated leaf so its tick re-renders nothing else. */
function AnimatedTitle({
  enabled,
  title,
  wantsPrefix,
  animating,
}: {
  enabled: boolean;
  title: string;
  wantsPrefix: boolean;
  animating: boolean;
}): null {
  const focused = useTerminalFocus();
  const [frame, setFrame] = useState(0);
  useInterval(
    () => setFrame(f => (f + 1) % TITLE_FRAMES.length),
    enabled && wantsPrefix && animating && focused ? TITLE_INTERVAL_MS : null,
  );
  const prefix = animating ? TITLE_FRAMES[frame]! : TITLE_STATIC_MARK;
  useTerminalTitle(!enabled ? null : !wantsPrefix ? title : `${prefix} ${title}`);
  return null;
}

/** The slash word of an input, resolved against the enabled command set by
 *  name, alias or display name — exactly as the submit path resolves it. */
function resolveSlashCommand(input: string, commands: Command[]): Command | undefined {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return undefined;
  const spaceIndex = trimmed.indexOf(' ');
  const name = (spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex)).trim();
  if (!name) return undefined;
  return commands.find(
    command =>
      isCommandEnabled(command) &&
      (command.name === name || command.aliases?.includes(name) === true || getCommandName(command) === name),
  );
}

/** A REAL screen-registered command that only the PLAIN-WORLD gate or its
 *  RETIREMENT disables: the enabled resolver above answers undefined for
 *  it, so without this read the line would relay to the session runner as
 *  words — and the runner's table (not this boot's world) answers the
 *  headless-form refusal instead of the door's own sentence, persisted as
 *  a user row. */
function resolveGatedPlainWorldCommand(input: string, commands: Command[]): Command | undefined {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return undefined;
  const spaceIndex = trimmed.indexOf(' ');
  const name = (spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex)).trim();
  if (!name) return undefined;
  const real = commands.find(
    command => command.name === name || command.aliases?.includes(name) === true || getCommandName(command) === name,
  );
  return real !== undefined && (commandOffInPlainWorld(real) || commandRetired(real) !== undefined) ? real : undefined;
}

/** The transcript search bar: one row with the footer's top border so
 *  swapping it for the footer never shifts the scroll box. */
function TranscriptSearchBar({
  columns,
  onQueryChange,
  onCommit,
  onCancel,
  warmSearchIndex,
  matchCount,
  matchCurrent,
}: {
  columns: number;
  onQueryChange: (query: string) => void;
  onCommit: (query: string) => void;
  onCancel: () => void;
  warmSearchIndex: () => Promise<number>;
  matchCount: number | null;
  matchCurrent: number;
}): React.ReactNode {
  const tokens = useMercuryTokens();
  const [warm, setWarm] = useState<'warming' | 'quiet' | number>('warming');
  const committedRef = useRef(false);
  const search = useSearchInput({
    isActive: true,
    onExit: () => {
      committedRef.current = true;
      onCommit(search.query);
    },
    onCancel,
    columns,
    backspaceExitsOnEmpty: false,
  });
  // Warm-up runs BEFORE the query effect so it measures the real cost.
  useEffect(() => {
    let live = true;
    const started = Date.now();
    void warmSearchIndex()
      .then(ms => {
        if (!live) return;
        const measured = Number.isFinite(ms) ? ms : Date.now() - started;
        setWarm(measured < SEARCH_WARMUP_QUIET_MS ? 'quiet' : measured);
      })
      .catch(() => {
        if (live) setWarm('quiet');
      });
    return () => {
      live = false;
    };
  }, [warmSearchIndex]);
  useEffect(() => {
    if (typeof warm !== 'number') return;
    const timer = setTimeout(() => setWarm('quiet'), SEARCH_WARMUP_SHOW_MS);
    return () => clearTimeout(timer);
  }, [warm]);
  const { query } = search;
  useEffect(() => {
    if (warm === 'warming') return;
    onQueryChange(query);
  }, [query, warm, onQueryChange]);
  const before = query.slice(0, search.cursorOffset);
  const at = query.slice(search.cursorOffset, search.cursorOffset + 1) || ' ';
  const after = query.slice(search.cursorOffset + 1);
  let right: React.ReactNode;
  if (warm === 'warming') {
    right = <Text color={tokens.textSecondary}>indexing…</Text>;
  } else if (typeof warm === 'number') {
    right = <Text color={tokens.textSecondary}>{`indexed in ${warm}ms`}</Text>;
  } else if (query.length > 0 && matchCount === 0) {
    right = <Text color={tokens.failure}>no matches</Text>;
  } else if (matchCount !== null && matchCount > 0) {
    right = <Text color={tokens.textSecondary}>{`${matchCurrent}/${matchCount}`}</Text>;
  } else {
    right = null;
  }
  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      borderStyle="single"
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderColor={tokens.borderSubtle}
      paddingX={1}
      height={2}
      noSelect
    >
      <Box flexDirection="row" flexShrink={1} overflow="hidden">
        <Text color={tokens.textSecondary}>/</Text>
        <Text>{before}</Text>
        <Text inverse>{at}</Text>
        <Text>{after}</Text>
      </Box>
      <Box flexShrink={0} marginLeft={1}>
        {right}
      </Box>
    </Box>
  );
}

/** The transcript footer: what this view is, how to leave it, and the
 *  pager's real key set. ONE pre-packed string (packHints over the live
 *  width): whole segments greedily in priority order — the exit keys ride
 *  directly behind the view's name so they survive any width — never a
 *  mid-segment clip, a blank chord hole, or a dangling separator (the
 *  80-col footer would otherwise lose `q quits`/the toggle chord to sibling-Text
 *  flex wrapping). */
function TranscriptFooter({
  toggleChord,
  expandChord,
  hasSearchBadge,
  virtualScroll,
  showAllSuppressed,
  showAll,
  status,
  badge,
}: {
  toggleChord: string;
  expandChord: string;
  hasSearchBadge: boolean;
  virtualScroll: boolean;
  showAllSuppressed: boolean;
  /** The show-all state drives the expand arm's verb. */
  showAll: boolean;
  status: string | null;
  badge: string | null;
}): React.ReactNode {
  const tokens = useMercuryTokens();
  const { columns } = useTerminalSize();
  let hints: string[];
  if (hasSearchBadge) {
    // n/N belong to the search-badge state only.
    hints = ['n/N navigate matches'];
  } else if (virtualScroll) {
    hints = ['q quits', '/ search', 'g/G jump', 'arrows scroll', 'drag selects and copies'];
  } else if (!showAllSuppressed) {
    hints = [`${expandChord} ${showAll ? 'to collapse' : 'to show all'}`];
  } else {
    hints = [];
  }
  const right = status ?? badge ?? '';
  // The right cell's BUDGET (w32-06): this was the one
  // footer string with no width cap on a flexShrink={0} box — a long
  // status (the Windows temp path of a transcript export) starved the left
  // hints to zero and painted past the frame. The cell now caps at half
  // the row (floored at 16 columns so a tiny terminal still shows a
  // legible tail) and truncates from the START — on a path the filename
  // tail is the half that matters.
  const rightBudget = right === '' ? 0 : Math.min(stringWidth(right), Math.max(16, Math.floor((columns - 3) / 2)));
  const rightWidth = right === '' ? 0 : rightBudget + 1;
  const left = packHints(
    ['detailed transcript', `${toggleChord} to toggle`, ...hints],
    Math.max(0, columns - 2 - rightWidth),
  );
  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      borderStyle="single"
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderColor={tokens.borderSubtle}
      paddingX={1}
      height={2}
    >
      <Box flexDirection="row" flexShrink={1} overflow="hidden">
        <Text color={tokens.textSecondary} wrap="truncate">
          {left}
        </Text>
      </Box>
      <Box flexShrink={0} marginLeft={1} width={rightBudget}>
        {right !== '' ? (
          <Text color={tokens.textSecondary} wrap="truncate-start">
            {right}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

export function REPL({
  commands: initialCommands,
  debug = false,
  initialTools,
  disabled = false,
  disableSlashCommands = false,
}: Props): React.ReactNode {
  fluxMark('render:repl-root');
  // The render-reason probe's holder (MERCURY_FLUX_PROBE only; the read at
  // the bottom of this render names which root input moved).
  const rootWhyRef = useRef<Record<string, unknown> | null>(null);
  // Deterministic render fault: the crash-surface prover drives the real
  // application-root boundary through this seam. Unset it is one env read.
  if (flagEnv('MERCURY_RENDER_FAULT') === 'repl') {
    throw new Error('deterministic REPL render fault (MERCURY_RENDER_FAULT=repl)');
  }

  const store = useAppStateStore();
  const setAppState = useSetAppState();
  const { addNotification, removeNotification } = useNotifications();
  const { columns, rows } = useTerminalSize();
  const terminal = useTerminalNotification();
  const tokens = useMercuryTokens();
  const [themeName] = useTheme();
  const mainLoopModel = useMainLoopModel();

  // Environment-derived layout gates, computed once at mount (they were on
  // the hot render path).
  const [fullscreen] = useState(() => isFullscreenEnvEnabled());
  const [virtualScrollEnabled] = useState(() => resolveTerminalExperience().virtualScroll.effective);
  // The one experience resolver owns the title control (MERCURY_TERMINAL_TITLE);
  // render-stable by mount-time memoization per its contract.
  const [terminalTitleEnabled] = useState(() => resolveTerminalExperience().terminalTitle.effective);
  const [dumpMode, setDumpMode] = useState(false);
  const inVirtualTranscriptMode = fullscreen && virtualScrollEnabled && !dumpMode;

  // ── the focused chat ─────────────────────────────────────────────────
  // Every session is a full chat; the one on screen is the focused chat.
  // This screen is the FACE over the focused chat's connector — a session
  // the daemon hosts, or the blank chat that owns no session yet — and
  // paints WHICHEVER session holds the focused slot; a hop re-points the
  // slot. The VIEW's turn is the focused chat's.
  const focusedConnector = useSyncExternalStore(subscribeFocusedSessionConnector, getFocusedSessionConnector, getFocusedSessionConnector);
  const seatLive = useSyncExternalStore(subscribeFocusedSeatLive, getFocusedSeatLive, getFocusedSeatLive);
  const focusedEffectiveModel = useSyncExternalStore(subscribeFocusedModel, getFocusedEffectiveModel, getFocusedEffectiveModel);
  const textActive = useSyncExternalStore(subscribeFocusedTail, getFocusedTailActive, getFocusedTailActive);
  const interruptingKey = useSyncExternalStore(subscribeFocusedSeatLive, getFocusedStatusKey, getFocusedStatusKey);
  const isStopping = interruptingKey === '1';
  const focusedTail = hasSeatLive(focusedConnector) ? focusedConnector.tail() : null;
  const isLoading = seatLive.inFlight;
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;

  // Non-REPL surfaces read the focused turn, never a proxy.
  useEffect(() => {
    setAppState(prev => (prev.foregroundTurnActive === isLoading ? prev : { ...prev, foregroundTurnActive: isLoading }));
  }, [isLoading, setAppState]);

  // ── model transitions (Law 9 restore) ────────────────────────────────
  // A /model pick made mid-turn PARKS in pendingModelSwitch; this boundary
  // effect applies it exactly-once when the foreground turn ends. The fold
  // dropped the effect with the old mount estate — the parked switch never
  // settled. The transition transcript row is the CONNECTOR's projection
  // now; the face only settles state and speaks the notification.
  const pendingModelSwitch = useAppState(state => state.pendingModelSwitch);
  useEffect(() => {
    if (isLoading || pendingModelSwitch === null) return;
    let receipt = null as ReturnType<typeof settlePendingAtBoundary>;
    setAppState(prev => {
      const settled = settlePendingAtBoundary(
        { mainLoopModel: prev.mainLoopModel, mainLoopModelForSession: prev.mainLoopModelForSession, pendingModelSwitch: prev.pendingModelSwitch },
      );
      if (!settled) return prev;
      receipt = settled;
      return { ...prev, ...settled.patch, lastModelTransition: settled.receipt };
    });
    // Assigned inside the updater closure: re-read through a local so the
    // narrowing follows the value, not the declaration.
    const settledReceipt: ReturnType<typeof settlePendingAtBoundary> = receipt;
    if (settledReceipt) {
      // The destination is NAMED the way every sibling surface names it —
      // through the label helper, with the explicit 'Default' word for the
      // null setting — never the raw wire id, never the bare word 'model'
      // (FN-016 R16); a cross-provider settle carries the one note owner's
      // transport sentence (FN-016 R17).
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

  // ── transcript ───────────────────────────────────────────────────────
  // `messages` is the transcript AS RENDERED — the focused chat's records
  // through its connector (echo rows and display rows included).
  const messages = useFocusedTranscript();
  const [conversationId, setConversationId] = useState<string>(() => focusedConnector.sessionId());
  const [toolJSX, setToolJSXState] = useState<ToolJSXState>(null);
  const setToolJSX: SetToolJSXFn = useCallback(next => {
    setToolJSXState(prev => resolveToolJSX(prev, next));
  }, []);
  // The permission request may publish a sticky footer in fullscreen; the
  // bottom column renders it right after the working-status strip.
  const [permissionStickyFooter, setPermissionStickyFooter] = useState<React.ReactNode>(null);
  const stickyFooterOwnerUp = permissionStickyFooter !== null;
  const [screen, setScreen] = useState<Screen>('prompt');
  const [showAllInTranscript, setShowAllInTranscript] = useState(false);
  const [showMessageSelector, setShowMessageSelector] = useState(false);
  // One identity for the composer's message-selector door: an inline arrow
  // here re-minted the prop on every root render and re-rendered the
  // memoised composer with it (the region matrix's render-reason marks).
  const openMessageSelector = useCallback(() => setShowMessageSelector(true), []);
  const [messageSelectorPreselect, setMessageSelectorPreselect] = useState<UserMessage | undefined>(undefined);
  const [isExiting, setIsExiting] = useState(false);
  const [showExitFlow, setShowExitFlow] = useState(false);
  // The exit command module's rendered result (the confirm card), when the
  // exit path is not the worktree flow.
  const [exitCommandJsx, setExitCommandJsx] = useState<React.ReactNode | null>(null);
  const [isPromptInputActive, setIsPromptInputActive] = useState(false);
  const [inputMode, setInputModeState] = useState<PromptInputMode>(() => pendingInput.mode());
  void inputMode;
  const [submitCount, setSubmitCount] = useState(0);
  const [lastCompletedAt, setLastCompletedAt] = useState<number | null>(null);
  const [remountKey, setRemountKey] = useState(0);
  const [showCostThreshold, setShowCostThreshold] = useState(false);
  const [idleReturnStaged, setIdleReturnStaged] = useState<{ input: string; idleMinutes: number } | null>(null);
  // The crash re-entry offer (FN-013 CRASH-03): staged by the boot effect
  // when the newest unnoticed crash report names a session whose transcript
  // still resolves; the focused-dialog contract renders it one keypress
  // from re-entry. The latch ref keeps the notice marker honest — advanced
  // only once the offer (or the plain notice) has actually been shown.
  const [crashResumeStaged, setCrashResumeStaged] = useState<{
    origin: string;
    component: string | null;
    message: string;
    sessionId: string;
    cwd: string | null;
    transcriptPath: string | undefined;
    moreCount: number;
  } | null>(null);
  const crashNoticeLatchedRef = useRef(false);
  const idleCheckLatchedOffRef = useRef(false);
  const [autoModeSurface, setAutoModeSurface] = useState<'nudge' | 'notice' | null>(null);
  // The nudge shows the mode captured when it was staged.
  const [nudgeStagedMode, setNudgeStagedMode] = useState<PermissionMode | null>(null);
  const [frozenTranscriptState, setFrozenTranscriptState] = useState<FrozenTranscriptState | null>(null);
  const [searchBarOpen, setSearchBarOpen] = useState(false);
  const [committedSearchQuery, setCommittedSearchQuery] = useState('');
  const [searchMatchCount, setSearchMatchCount] = useState<number | null>(null);
  const [searchMatchCurrent, setSearchMatchCurrent] = useState(0);
  const [editorStatus, setEditorStatus] = useState<string | null>(null);
  const editorGenerationRef = useRef(0);
  const editorInFlightRef = useRef(false);
  const dumpFiredRef = useRef(false);
  const [vimMode, setVimMode] = useState<VimMode>('INSERT');
  const [showBashesDialog, setShowBashesDialog] = useState<string | boolean>(false);
  const [isSearchingHistory, setIsSearchingHistory] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const [tools, setToolsState] = useState<Tool[]>(initialTools);
  useEffect(() => {
    setToolsState(initialTools);
  }, [initialTools]);
  const mcpState = useAppState(state => state.mcp);
  // The MCP gauge's runtime half (Law 9 restore — the publisher's only
  // feeder died with the old mount estate): Deck, readiness, /doctor and
  // the /mcp panel read the PUBLISHED connections; the connection manager
  // owns the one list (AppState.mcp.clients — main.tsx seeds the manager,
  // the screen keeps no registry), and the face publishes it as it changes.
  useEffect(() => {
    publishMcpConnections(mcpState.clients);
  }, [mcpState.clients]);
  // Failed / needs-auth MCP server notices (Law 9 restore) — one notice per
  // non-empty bucket, off the manager's own list.
  useMcpConnectivityStatus({ mcpClients: mcpState.clients });
  const toolPermissionContext = useAppState(state => state.toolPermissionContext);
  const agentDefinitions = useAppState(state => state.agentDefinitions);
  const isBriefOnly = useAppState(state => state.isBriefOnly);
  const verbose = useAppState(state => state.verbose);
  const spinnerTip = useAppState(state => state.spinnerTip);
  const commands = useMergedCommands(initialCommands, mcpState.commands);
  const mergedTools = useMergedTools(tools, mcpState.tools, toolPermissionContext);
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const apiKeyVerification = useApiKeyVerification();

  // A row the SCREEN adds to the chat (a notice of its own): a display row
  // on a chat that paints rows, a notification on the blank chat.
  const paintScreenRow = useCallback((row: Message, fallbackText: string): void => {
    const focused = getFocusedSessionConnector() as PaintsRows;
    if (typeof focused.addDisplayRow === 'function') {
      focused.addDisplayRow(row);
      return;
    }
    addNotification({ key: `screen-row-${Date.now()}`, text: fallbackText, priority: 'immediate', timeoutMs: RECEIPT_TIMEOUT_MS });
  }, [addNotification]);

  // ── the composer owner: this screen only projects it ─────────────────
  useState(() => {
    // The boot seed CONSUMES the early-input capture (utils/earlyInput):
    // keystrokes typed while Mercury was starting land in the composer —
    // initSession's "early input wins" resolution was designed for exactly
    // this argument, and a hardcoded '' silently discarded the buffer.
    pendingInput.initSession(getSessionId(), consumeEarlyInput());
    return null;
  });
  const setInputValue = useCallback((value: string) => {
    pendingInput.edit(value);
  }, []);
  const setInputMode = useCallback((mode: PromptInputMode) => {
    pendingInput.setMode(mode);
    setInputModeState(mode);
  }, []);
  const setPastedContents = useCallback((next: Record<number, PastedContent>) => {
    pendingInput.setPastedContents(next);
  }, []);
  const insertTextRef = useRef<{ insert: (text: string) => void; setInputWithCursor: (value: string, cursor: number) => void; cursorOffset: number } | null>(null);

  const scrollRef = useRef<ScrollBoxHandle | null>(null);
  const modalScrollRef = useRef<ScrollBoxHandle | null>(null);
  const jumpRef = useRef<{ jumpToIndex: (i: number) => void; setSearchQuery: (q: string) => void; nextMatch: () => void; prevMatch: () => void; setAnchor: () => void; warmSearchIndex: () => Promise<number>; disarmSearch: () => void } | null>(null);
  const lastUserScrollAtRef = useRef(0);
  const repinToBottom = useCallback(() => {
    scrollRef.current?.scrollToBottom();
  }, []);
  const noteUserScroll = useCallback(() => {
    lastUserScrollAtRef.current = Date.now();
  }, []);

  useEffect(() => {
    return pendingInput.registerInterceptors({
      // The suggestion intercept: an accepted suggestion rides the same
      // edit path; nothing here rewrites the operator's text.
      interceptSuggestion: () => false,
      onEmptyToNonempty: () => {
        if (!fullscreen) return;
        // A deliberate scroll this recent chose the reading position.
        if (Date.now() - lastUserScrollAtRef.current < RECENT_SCROLL_REPIN_WINDOW_MS) return;
        repinToBottom();
      },
      onActiveChange: setIsPromptInputActive,
    });
  }, [fullscreen, repinToBottom]);

  useEffect(() => registerComposerSeeder(seed => pendingInput.append(seed)), []);

  // Modal permission focus (block E): the refusal notice for gestures that
  // would open/queue another surface while a permission card is up. The
  // notifier seam mirrors registerComposerSeeder — the notification queue
  // lives in AppState, so the module store reaches it through this bridge.
  useEffect(
    () =>
      registerPermissionFocusNotifier(text =>
        addNotification({ key: 'permission-focus-refusal', text, priority: 'high', timeoutMs: 4000 }),
      ),
    [addNotification],
  );

  // The streaming reveal's gate: reduced motion, or a terminal whose cursor
  // yank bug makes the tail unsafe to paint — SURFACE-SPLIT (FN-016 R2):
  // the yank hazard is cursor-up into scrollback, a main-screen-only fact,
  // so the fullscreen cockpit paints the live tail on win32 too and only
  // the inline surface keeps the conhost suppression.
  const prefersReducedMotion = useAppState(state => state.settings.prefersReducedMotion === true);
  const reducedMotion = prefersReducedMotion || isEnvTruthy(process.env.MERCURY_REDUCED_MOTION);
  const streamingSuppressed = streamingRevealSuppressed(reducedMotion, fullscreen);

  // ── queues ───────────────────────────────────────────────────────────
  // The pending asks live on the focused chat's connector; the card queue
  // below is that stream's full payloads.
  const sessionAsks = useSyncExternalStore(subscribeFocusedAsks, getFocusedAsks, getFocusedAsks);
  // THE COVERED-DIALOG GATE (the seat's key-leak seam): while another route
  // surface owns the frame (the Concourse board, the Boot Settings), THIS
  // REPL is COVERED — mounted but off-screen. Its input dialogs (the consent
  // card, the message selector, the bottom-column dialogs) must go INACTIVE,
  // or a keystroke on the board reaches an off-screen card's select and
  // ANSWERS a parked ask (a board digit landed 'allow'/'allow-always' on the
  // hidden card). This mirrors the useKeybinding covered
  // gate (replCovered) that already makes the card's nav/accept inert; the
  // card's RAW input path (CustomSelect digits/letters) had no such gate. The
  // signal is reactive (the route store), so the dialogs return live the
  // instant the frame is the REPL's again (⇧→ back into the focused chat).
  const replSurfaceCovered = useSyncExternalStore(
    subscribeSurfaceRoute,
    () => currentSurfaceRoute().kind !== 'repl',
    () => currentSurfaceRoute().kind !== 'repl',
  );
  const toolUseConfirmQueue = useMemo(() => sessionAsks.map(ask => ask.confirm), [sessionAsks]);
  const [resolvedConsentCount, setResolvedConsentCount] = useState(0);
  useEffect(() => {
    if (toolUseConfirmQueue.length === 0) setResolvedConsentCount(0);
  }, [toolUseConfirmQueue.length]);

  const resolveHeadPermission = useCallback(() => {
    // Same batch (React batches the store emit with the setState): the next
    // card mounts with the advanced marker, no blank frame.
    setResolvedConsentCount(c => c + 1);
    const focused = getFocusedSessionConnector();
    const head = focused.asks()[0];
    if (head !== undefined) focused.settleAsk(head.id);
  }, []);

  // The permission posture is the FOCUSED chat's: a mode change (shift+tab,
  // a plan approval's "allow all edits") reaches the session through its
  // connector, and the screen's own context mirrors it for the readouts.
  const setToolPermissionContext = useCallback(
    (context: ToolPermissionContext, options?: { preserveMode?: boolean }) => {
      setAppState(prev => {
        const preserved = options?.preserveMode ? prev.toolPermissionContext.mode : context.mode;
        return { ...prev, toolPermissionContext: { ...context, mode: preserved } };
      });
      if (!options?.preserveMode) getFocusedSessionConnector().setPermissionMode(context.mode);
      // Approving one item with "don't ask again" may now cover the others.
      setTimeout(() => {
        for (const entry of getFocusedSessionConnector().asks()) entry.confirm.recheckPermission?.();
      }, 0);
    },
    [setAppState],
  );

  // ── dialog focus arbitration ─────────────────────────────────────────
  // The consent card and the dialog commands are the FOCUSED chat's (the
  // ask stream and the local-JSX surface ride the focused connector).
  // ── the IDE integration (Law 9 restore — the mount, the onboarding
  // dialog, the status notices and the selection tracker all lost their
  // one caller with the old mount estate; /ide alone survived) ─────────
  const [showIdeOnboarding, setShowIdeOnboarding] = useState(false);
  const [ideInstallationStatus, setIDEInstallationState] = useState<IDEExtensionInstallationStatus | null>(null);
  const [ideToInstallExtension, setIdeToInstallExtension] = useState<IdeType | null>(null);
  const [ideSelection, setIdeSelection] = useState<IDESelection | undefined>(undefined);
  useIdeSelection(mcpState.clients, setIdeSelection);
  useIDEIntegration({
    autoConnectIdeFlag: ideAutoConnectSeed(),
    ideToInstallExtension,
    // The one mutable config owner replaces the old component state — the
    // hook's React-state-shaped setter adapts onto it.
    setDynamicMcpConfig: updater => {
      const previous = dynamicMcpConfigSnapshot();
      setDynamicMcpConfig(typeof updater === 'function' ? updater(previous) : updater);
    },
    setShowIdeOnboarding,
    setIDEInstallationState,
  });
  useIdeLogging(mcpState.clients);
  useIDEStatusIndicator({ ideInstallationStatus, ideSelection, mcpClients: mcpState.clients });
  // Screen receipts (Law 9 restore): receipts mint into a bounded buffer with
  // no other drain — each paints as ONE display row on the focused chat
  // (the screen's rows, never a session record).
  useSeatReceipts({
    setMessages: next => {
      const rows = typeof next === 'function' ? next([]) : next;
      for (const row of rows) paintScreenRow(row, '');
    },
  });
  // The agent-state classifier (Law 9 restore): the companion engine reads
  // its content-derived verdict; self-gated, cleared on the loading edge.
  useAgentStateClassifier(messages, isLoading);
  const elicitationQueue = useAppState(state => state.elicitation.queue);
  const respondToElicitation = useCallback(
    (action: 'accept' | 'decline' | 'cancel', content?: Record<string, string | number | boolean | string[]>) => {
      const head = elicitationQueue[0];
      if (!head) return;
      head.respond({ action, content });
      // A URL-mode acceptance stays queued for its second phase.
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
      // Pop first so a throwing dismiss callback cannot leave the head in place.
      setAppState(prev => ({ ...prev, elicitation: { queue: prev.elicitation.queue.slice(1) } }));
      head.onWaitingDismiss?.(action);
    },
    [elicitationQueue, setAppState],
  );
  const focusedInputDialog = getFocusedInputDialog({
    isExiting: isExiting || showExitFlow,
    showMessageSelector,
    isPromptInputActive,
    toolJSX,
    toolUseConfirmQueueLength: toolUseConfirmQueue.length,
    elicitationQueueLength: elicitationQueue.length,
    showIdeOnboarding,
    showCostThreshold,
    showIdleReturn: idleReturnStaged !== null,
    showCrashResume: crashResumeStaged !== null,
    showAutoModeSurface: autoModeSurface !== null,
  });
  const focusedInputDialogRef = useRef(focusedInputDialog);
  focusedInputDialogRef.current = focusedInputDialog;
  const dialogsHiddenWhileTyping =
    isPromptInputActive && !isExiting && !showMessageSelector && (toolUseConfirmQueue.length > 0 || showCostThreshold || idleReturnStaged !== null);

  // The turn clock the spinner reads: the session's own turn start, and the
  // time its consent card held the turn.
  const seatStartTimeRef = useRef(0);
  const seatPausedMsRef = useRef(0);
  const seatPauseStartRef = useRef<number | null>(null);
  {
    const started = seatLive.turnStartedAtMs;
    if (started !== null) seatStartTimeRef.current = started;
    else if (seatStartTimeRef.current === 0) seatStartTimeRef.current = Date.now();
  }
  // Pause accounting: permission transitions are stamped immediately.
  const previousFocusedDialogRef = useRef<FocusedInputDialog | undefined>(undefined);
  useEffect(() => {
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

  // Scroll re-pin on permission transitions, before the frame is produced.
  const previousPermissionFocusRef = useRef(false);
  useLayoutEffect(() => {
    const now = focusedInputDialog === 'tool-permission';
    if (now !== previousPermissionFocusRef.current) repinToBottom();
    previousPermissionFocusRef.current = now;
  }, [focusedInputDialog, repinToBottom]);

  // ── read-file state (the dialogs' own read cache) ────────────────────
  const readFileStateRef = useRef<FileStateCache | null>(null);
  const getReadFileState = useCallback((): FileStateCache => {
    if (readFileStateRef.current === null) {
      readFileStateRef.current = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE);
    }
    return readFileStateRef.current;
  }, []);

  // ── the tool-use context (the dialogs' and screen commands' context) ─
  // A dialog command (/model, /help, …) and a screen command (/vim, /mouse,
  // …) run HERE against the focused connector: the records they read are
  // the focused chat's, a row they append paints on the focused chat, and
  // the session-side members (a tool's progress, a stream mode) are inert.
  const resumeRef = useRef<(sessionId: UUID, log: LogOption, entrypoint: ResumeEntrypoint) => Promise<void>>(async () => {});
  const getToolUseContext = useCallback(
    (currentMessages: Message[], newMessages: Message[], controller: AbortController, model: string) => {
      const state = store.getState();
      const context = {
        options: {
          commands: commandsRef.current,
          debug,
          mainLoopModel: model,
          tools: mergedTools,
          verbose: state.verbose,
          mcpClients: [],
          mcpResources: state.mcp.resources,
          isNonInteractiveSession: false,
          agentDefinitions: state.agentDefinitions,
          querySource: 'repl_main_thread' as const,
          refreshTools: () => mergedTools,
          theme: themeName,
        },
        abortController: controller,
        readFileState: getReadFileState(),
        discoveredSkillNames: new Set<string>(),
        loadedNestedMemoryPaths: new Set<string>(),
        getAppState: () => store.getState(),
        setAppState,
        setToolJSX,
        addNotification,
        appendSystemMessage: (msg: Message) => paintScreenRow(msg, getUserMessageText(msg as UserMessage) ?? ''),
        sendOSNotification: (opts: { message: string; notificationType: string }) =>
          sendNotification({ message: opts.message, notificationType: opts.notificationType }, terminal),
        setInProgressToolUseIDs: () => {},
        setHasInterruptibleToolInProgress: () => {},
        setResponseLength: () => {},
        setStreamMode: () => {},
        openMessageSelector: () => setShowMessageSelector(true),
        updateFileHistoryState: (updater: (prev: AppState['fileHistory']) => AppState['fileHistory']) =>
          setAppState(prev => ({ ...prev, fileHistory: updater(prev.fileHistory) })),
        updateAttributionState: (updater: (prev: AppState['attribution']) => AppState['attribution']) =>
          setAppState(prev => ({ ...prev, attribution: updater(prev.attribution) })),
        setConversationId: (id: UUID) => setConversationId(id),
        requestPrompt: () => () => Promise.reject(new Error('a prompt from a dialog command has no door to a managed session yet')),
        messages: currentMessages.concat(newMessages),
        // Rows a dialog appends are the screen's — they paint on the
        // focused chat and never enter a session's transcript.
        setMessages: (updater: (prev: Message[]) => Message[]) => {
          for (const row of updater([])) paintScreenRow(row, getUserMessageText(row as UserMessage) ?? '');
        },
        onChangeAPIKey: () => {
          void apiKeyVerification.reverify();
        },
        // The /ide command's config door (Law 9 restore): writes the ONE
        // mutable dynamic-config owner; the mounted manager re-resolves.
        onChangeDynamicMcpConfig: (config: Record<string, ScopedMcpServerConfig>) => {
          setDynamicMcpConfig(config);
        },
        onInstallIDEExtension: (ide: IdeType) => setIdeToInstallExtension(ide),
        resume: (sessionId: UUID, log: LogOption, entrypoint: ResumeEntrypoint) => resumeRef.current(sessionId, log, entrypoint),
      };
      return context;
    },
    [store, debug, mergedTools, themeName, getReadFileState, setAppState, setToolJSX, addNotification, paintScreenRow, terminal, apiKeyVerification],
  );

  // The spinner tip picks once per turn boundary.
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
      .catch(() => {});
  }, [setAppState, themeName, getReadFileState]);
  // The turn boundary: the focused chat's turn fell idle.
  const wasLoadingRef = useRef(false);
  useEffect(() => {
    if (wasLoadingRef.current && !isLoading) {
      setLastCompletedAt(Date.now());
      idleCheckLatchedOffRef.current = false;
      seatPausedMsRef.current = 0;
      seatPauseStartRef.current = null;
      pickTurnTip();
    }
    if (isLoading) tipPickedThisTurnRef.current = false;
    wasLoadingRef.current = isLoading;
  }, [isLoading, pickTurnTip]);
  const [generatedTitle] = useState<string | null>(null);

  // ── the one session-switch chokepoint ────────────────────────────────
  // ONE resume path (every session is a managed session): a session live on
  // the board is hopped into — the focused slot re-points at its connector,
  // nothing resumes, nothing respawns; a durable one comes back as a managed
  // session — its transcript paints first, the daemon admits the SAME
  // session behind the paint, and the recap rides as a display-only row.
  // The chat that was focused keeps running (views are not sessions; a
  // switch stops nothing) and the composer's draft stays where it was.
  const resume = useCallback(async (sessionId: UUID, log: ResumableLog, entrypoint: ResumeEntrypoint): Promise<void> => {
    void entrypoint;
    const label = log.customTitle ?? log.agentName ?? String(sessionId).slice(0, 8);
    addNotification({
      key: 'session-switch',
      text: `opening ${label}…`,
      priority: 'medium',
      timeoutMs: SWITCH_STATUS_TIMEOUT_MS,
    });
    const { focusResumedSession } = await import('../services/switchboard/hopIntoSession.js');
    const outcome = await focusResumedSession(String(sessionId), (log as { fullPath?: string }).fullPath, {
      title: label,
      permissionMode: store.getState().toolPermissionContext.mode,
    });
    removeNotification('session-switch');
    if (!outcome.ok) {
      addNotification({
        key: 'resume-hop',
        text: `the session could not be opened — ${outcome.reason}`,
        priority: 'high',
        color: 'error',
        timeoutMs: RECEIPT_TIMEOUT_MS,
      });
      return;
    }
    setToolJSX(null);
    // The refused admission paints through the ONE painter below — the
    // focused connector keeps the refusal, and every resume road (this
    // switch, the boot's --resume, the picker) reads the same truth.
  }, [addNotification, removeNotification, setToolJSX]);
  resumeRef.current = resume;

  // The no-live-runner line paints on EVERY resume road: the boot's
  // --resume and the picker land here without the switch callback above, so
  // the screen reads the refusal off the FOCUSED connector itself (kept and
  // announced on the live channel). One painter, split at the ' · ' seams —
  // no terminal width can shed the reason or the action.
  useEffect(() => {
    const paintNoRunnerLine = (): void => {
      const focused = getFocusedSessionConnector() as {
        admissionRefusal?: () => string | null;
        record?: { title?: string };
        sessionId?: () => string;
      };
      const refusal = typeof focused.admissionRefusal === 'function' ? focused.admissionRefusal() : null;
      if (refusal === null || refusal === undefined) return;
      const title =
        focused.record?.title ??
        (typeof focused.sessionId === 'function' ? String(focused.sessionId()).slice(0, 8) : 'this session');
      void import('../services/switchboard/hopIntoSession.js').then(({ composeNoRunnerLine }) => {
        const segments = composeNoRunnerLine(title, refusal).split(' · ');
        addNotification({
          key: 'resume-hop',
          jsx: (
            <Box flexDirection="column">
              {segments.map(segment => (
                <Text key={segment} color="error" wrap="truncate-end">
                  {segment}
                </Text>
              ))}
            </Box>
          ),
          priority: 'high',
          timeoutMs: RECEIPT_TIMEOUT_MS * 2,
        });
      });
    };
    paintNoRunnerLine();
    return hasSeatLive(focusedConnector) ? focusedConnector.subscribeLive(paintNoRunnerLine) : undefined;
  }, [focusedConnector, addNotification]);

  // ── submission ───────────────────────────────────────────────────────
  // A screen command's receipt: the two rows the session's runner paints
  // for its own local commands (the echoed command, its stdout) — display
  // rows on a chat that paints rows, a notification on the blank chat.
  const paintScreenCommandReceipt = useCallback((commandName: string, args: string, text: string): void => {
    const focused = getFocusedSessionConnector() as PaintsRows;
    if (typeof focused.addDisplayRow === 'function') {
      focused.addDisplayRow(createUserMessage({ content: formatCommandLoadingMetadata(commandName, args) }));
      focused.addDisplayRow(createCommandInputMessage(`<${LOCAL_COMMAND_STDOUT_TAG}>${text}</${LOCAL_COMMAND_STDOUT_TAG}>`));
      return;
    }
    addNotification({ key: `command-${commandName}`, text, priority: 'immediate', timeoutMs: RECEIPT_TIMEOUT_MS });
  }, [addNotification]);
  const onSubmit = useCallback(async (input: string, helpers: PromptInputHelpers, _speculationAccept?: unknown, options?: { fromKeybinding?: boolean }): Promise<void> => {
    const text = input.trim();
    if (text === '') return;
    submitTrace('repl-onSubmit', input, { fromKeybinding: options?.fromKeybinding === true, speculation: false, guardActive: isLoadingRef.current });
    const focusedNow = getFocusedSessionConnector();
    const seatMode = pendingInput.mode();
    const seatPastes = pendingInput.pastedContents();
    const seatCommand = text.startsWith('/') && seatMode !== 'bash' ? resolveSlashCommand(text, commandsRef.current) : undefined;
    // THE ONE DISPATCH RULE (commandSeat): a session-seat line — plain
    // words, a bash line, a prompt expansion, a session-side local command
    // — lands in the session (its own table runs it); a screen-seat local
    // command runs HERE against the focused connector; a dialog command
    // (local-jsx) or a route alias takes the screen paths below.
    const seat = seatCommand === undefined ? 'session' : commandSeat(seatCommand);
    const takeComposer = (): void => {
      if (pendingInput.text().replace(/\s+$/, '') === input) pendingInput.clearForSubmit(input);
      setInputValue('');
      setPastedContents({});
      setIdeSelection(undefined);
      helpers.clearBuffer();
      helpers.setCursorOffset(0);
      setInputMode('prompt');
      if (!options?.fromKeybinding) addToHistory({ display: seatMode === 'bash' ? `!${input}` : input, pastedContents: seatPastes });
    };
    // THE PLAIN-WORLD HONESTY at the one dispatch seam (the chat-mode law):
    // a concourse-only command typed in a plain boot — or a retired door
    // typed anywhere — must answer its own sentence on THIS seat; falling
    // through as session words hands it to the runner, whose table is
    // never a plain world.
    if (seatCommand === undefined && text.startsWith('/') && seatMode !== 'bash') {
      const gated = resolveGatedPlainWorldCommand(text, commandsRef.current);
      if (gated !== undefined) {
        takeComposer();
        paintScreenCommandReceipt(getCommandName(gated), '', unavailableCommandLine(gated));
        return;
      }
      // THE UNKNOWN-NAME HONESTY (the gated branch's sibling): a /name no
      // table registers answers the SCREEN's sentence display-only — as
      // session words it reached the runner and the runner's "Unknown
      // skill" refusal persisted as a user row. Paths, // and non-name
      // shapes stay prompts (the resolver's own gates).
      const unknownName = resolveUnknownSlashName(text, commandsRef.current);
      if (unknownName !== undefined) {
        takeComposer();
        paintScreenCommandReceipt(unknownName, '', unknownCommandLine(unknownName, commandsRef.current));
        return;
      }
    }
    if (seat === 'session') {
      // Idle-return dialog: stage plain words when the idle gap qualifies.
      const treatment = idleReturnTreatment();
      if (
        treatment === 'dialog' &&
        getGlobalConfig().idleReturnDismissed !== true &&
        !idleCheckLatchedOffRef.current &&
        seatCommand === undefined &&
        seatMode !== 'bash' &&
        lastCompletedAt !== null &&
        focusedNow.usage().totalInputTokens >= idleTokenThreshold()
      ) {
        const idleMinutes = (Date.now() - lastCompletedAt) / 60_000;
        if (idleMinutes >= idleThresholdMinutes()) {
          // The dialog shows the ACTUAL gap, not the threshold.
          setIdleReturnStaged({ input, idleMinutes });
          setInputValue('');
          setPastedContents({});
          return;
        }
      }
      takeComposer();
      repinToBottom();
      setSubmitCount(count => count + 1);
      // THE COMPACT-VS-RUNNING-TURN LAW (an honest immediate answer, never a
      // silent wait behind a wedged turn): the delivery law stands — the
      // words deliver whatever the turn is doing and the session runs them
      // at its next readable moment — but a session-side COMMAND typed while
      // the turn is in flight says so at once: it queues behind the turn,
      // and esc is the way past a wedged one. Plain words stay quiet (the
      // ordinary mid-turn steer must not nag).
      if (seatCommand !== undefined && isLoadingRef.current) {
        addNotification({
          key: 'session-command-queued',
          text: `/${getCommandName(seatCommand)} queued — runs when the current turn ends (esc interrupts the turn)`,
          priority: 'immediate',
          timeoutMs: RECEIPT_TIMEOUT_MS,
        });
      }
      void focusedNow
        .sendWords(text, {
          mode: seatMode,
          pastedContents: seatPastes,
          ...(options?.fromKeybinding ? { fromKeybinding: true } : {}),
        })
        .then(receipt => {
          if (receipt.state !== 'refused') return;
          // The words come back to the composer with the door's own sentence.
          if (pendingInput.text() === '') setInputValue(input);
          addNotification({
            key: 'focused-session-send',
            text: receipt.detail,
            priority: 'high',
            color: 'error' as const,
            timeoutMs: RECEIPT_TIMEOUT_MS,
          });
        });
      return;
    }
    const spaceAt = text.indexOf(' ');
    const args = spaceAt === -1 ? '' : text.slice(spaceAt + 1).trim();
    if (seatCommand !== undefined && seatCommand.type === 'local' && seatCommand.uiRouteAlias === undefined) {
      // A SCREEN command (the composer, the keys, the view, the blank
      // chat — and every user-private command, whose line never leaves
      // this process): its body runs in the screen process against the
      // focused connector; its receipt paints on the focused chat the way
      // the session paints its own commands' receipts. It runs NOW, busy
      // or not — a screen command never queues behind a session turn.
      takeComposer();
      void (async () => {
        try {
          // STOP-CLASS (interrupt-first): the brake acts while the turn
          // runs — the focused chat's interrupt door fires BEFORE the body,
          // never after the very work the command exists to stop.
          if (seatCommand.interruptFirst === true && focusedNow.turnActive()) {
            focusedNow.interrupt();
          }
          const context = getToolUseContext([...focusedNow.records()], [], createAbortController(), focusedNow.modelFacts().effective);
          const module = await seatCommand.load();
          const result = await module.call(args, context);
          if (result.type === 'text' && result.value.trim() !== '') paintScreenCommandReceipt(getCommandName(seatCommand), args, result.value);
        } catch (error) {
          logForDebugging(`screen command /${seatCommand.name} failed: ${String(error)}`);
          addNotification({ key: `command-${seatCommand.name}`, text: `/${getCommandName(seatCommand)} failed — ${error instanceof Error ? error.message : String(error)}`, priority: 'high', color: 'error' as const, timeoutMs: RECEIPT_TIMEOUT_MS });
        }
      })();
      return;
    }
    const routeAlias = (seatCommand as { uiRouteAlias?: 'concourse' } | undefined)?.uiRouteAlias;
    if (seatCommand !== undefined && routeAlias) {
      // A UI route alias is consumed before history, persistence and
      // dispatch. The route swap is the receipt.
      if (pendingInput.text().replace(/\s+$/, '') === input) setInputValue('');
      const outcome = performUiRouteAlias(routeAlias);
      if (outcome.note) {
        addNotification({ key: 'route-alias', text: outcome.note, priority: 'immediate', timeoutMs: RECEIPT_TIMEOUT_MS });
      }
      return;
    }
    if (seatCommand !== undefined && seatCommand.type === 'local-jsx') {
      // A dialog command renders in place: the dialog is the face's, its
      // effects reach the session through the focused connector's doors,
      // and nothing of it lands in a session's transcript.
      if (pendingInput.text().replace(/\s+$/, '') === input) setInputValue('');
      const context = getToolUseContext([...focusedNow.records()], [], createAbortController(), focusedNow.modelFacts().effective);
      let completed = false;
      const onDone = (
        result?: string,
        doneOptions?: { display?: 'skip' | 'system' | 'user'; nextInput?: string; submitNextInput?: boolean },
      ): void => {
        completed = true;
        setToolJSX(null);
        if (result && doneOptions?.display !== 'skip') {
          addNotification({ key: `command-${seatCommand.name}`, text: result, priority: 'immediate' });
        }
        if (doneOptions?.nextInput) {
          if (doneOptions.submitNextInput) void onSubmitRef.current(doneOptions.nextInput, INERT_PROMPT_HELPERS);
          else setInputValue(doneOptions.nextInput);
        }
        const stash = pendingInput.stashedPrompt();
        if (stash) {
          pendingInput.setStash(undefined);
          setInputValue(stash.text);
        }
      };
      try {
        const module = await seatCommand.load();
        // Named `element`, never `jsx`: a local `jsx` binding captures the
        // bundle's compiled JSX factory identifier in this scope (the
        // build-identity jsx-shadow class — it killed every bang command
        // once, silently).
        const element = await module.call(onDone, context, args);
        if (element && !completed) {
          setToolJSX({ jsx: element, shouldHidePromptInput: false, isLocalJSXCommand: true, isImmediate: true });
        } else if (!element && !completed) {
          // NEVER SILENTLY NOTHING: a dialog that returns no surface and
          // never called its completion has no other way to be seen — the
          // /mcp-over-an-empty-list class painted no panel, no row, no error.
          addNotification({
            key: `command-${seatCommand.name}`,
            text: `/${getCommandName(seatCommand)} had nothing to show`,
            priority: 'immediate',
            timeoutMs: RECEIPT_TIMEOUT_MS,
          });
        }
      } catch (error) {
        logForDebugging(`dialog command /${seatCommand.name} failed: ${String(error)}`);
        addNotification({
          key: `command-${seatCommand.name}`,
          text: `/${getCommandName(seatCommand)} failed — ${error instanceof Error ? error.message : String(error)}`,
          priority: 'high',
          color: 'error' as const,
          timeoutMs: RECEIPT_TIMEOUT_MS,
        });
      }
    }
  }, [addNotification, getToolUseContext, lastCompletedAt, paintScreenCommandReceipt, repinToBottom, setInputMode, setInputValue, setPastedContents, setToolJSX]);
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  // ── cancellation ─────────────────────────────────────────────────────
  // esc reaches the FOCUSED chat through its connector: the session's turn
  // stops in its own process, its parked asks retire with it.
  const onCancel = useCallback(() => {
    idleCheckLatchedOffRef.current = false;
    getFocusedSessionConnector().interrupt();
  }, []);

  // ── the armed root command ───────────────────────────────────────────
  // appState.initialMessage is the ONE armed-submission seam: a prompt on
  // argv, a plan approval's implementation prompt (the Boot face's rows
  // retired off this seam at FACE-DOORS C6 — they land through the
  // estate's own doors or face-native layers now). Its
  // string content submits through onSubmit exactly once, then the seam
  // clears; a carried permission posture lands on the focused chat first,
  // and a carried clear-context births a fresh session for the words (the
  // one-door law: a fresh chat IS a fresh session, on the board at birth).
  // The landing gate, read once for the whole screen: a birth in flight
  // holds both the armed words below and the yield to the boot face further
  // down.
  const landing = useSyncExternalStore(subscribeFocusedSessionConnector, landingInFlight, landingInFlight);
  const armedMessage = useAppState(state => state.initialMessage);
  useEffect(() => {
    if (armedMessage === null) return;
    // The chat-forward boot STARTS its birth and paints (the first frame
    // must not wait on a daemon round-trip), so the words can arrive before
    // the session they were armed for exists. They wait for that landing —
    // submitting into a resting slot answered with a generic sentence
    // naming neither the cause nor the remedy.
    if (landing) return;
    setAppState(prev => (prev.initialMessage === null ? prev : { ...prev, initialMessage: null }));
    const text = (getUserMessageText(armedMessage.message) ?? '').trim();
    if (text === '') return;
    void (async () => {
      if (armedMessage.clearContext) {
        const { bornSession } = await import('../services/switchboard/bornSession.js');
        const born = await bornSession({ workspaceDir: getCwd(), model: getFocusedSessionConnector().modelFacts().effective });
        if (!born.ok) {
          addNotification({ key: 'focused-session-send', text: born.reason, priority: 'high', color: 'error' as const, timeoutMs: RECEIPT_TIMEOUT_MS });
          return;
        }
      }
      if (armedMessage.permissionMode) {
        getFocusedSessionConnector().setPermissionMode(armedMessage.permissionMode as PermissionMode);
      }
      await onSubmitRef.current(text, INERT_PROMPT_HELPERS);
    })();
  }, [armedMessage, landing, setAppState]);

  useConcourseLifecycleSignals(terminal);
  useObligationSignals(terminal);
  usePingEngine();
  useCrossProjectFinishPings();
  useSessionTitleMint();
  useSettingsChange(() => {});
  useAgentsChange(getCwd());
  useSkillsChange(getCwd(), () => {});
  // Mount-time hook set: the two remote kill-switch checks, extension
  // management, the cost-summary exit hook over the fps metrics.
  useKickOffCheckAndDisableBypassPermissionsIfNeeded();
  useKickOffCheckAndDisableAutoModeIfNeeded();
  useExtensions({ enabled: true });
  useCostSummary(useFpsMetrics());
  const localJsxDialogShowing = toolJSX?.isLocalJSXCommand === true;

  // ── rewind and its kin ───────────────────────────────────────────────
  // A session's conversation belongs to its runner: rewinding it, restoring
  // its files or summarising a stretch needs a door the runner does not have
  // yet. The gesture stays alive and says so in one line — never a silent
  // no-op, never a rewrite of another process's transcript.
  const refuseSessionRewrite = useCallback((what: string): void => {
    addNotification({
      key: 'session-rewrite',
      text: `${what} acts on the session's own conversation — not available for a managed session yet (a named follow-up); /resume opens another session, /clear starts fresh`,
      priority: 'high',
      timeoutMs: RECEIPT_TIMEOUT_MS,
    });
  }, [addNotification]);

  // C12 hygiene: a dismissed permission ask must not strand its sticky
  // footer (the request clears it itself; this covers an abort path).
  useEffect(() => {
    if (stickyFooterOwnerUp && focusedInputDialog !== 'tool-permission') setPermissionStickyFooter(null);
  }, [stickyFooterOwnerUp, focusedInputDialog]);

  // ── boot-time work (mount once; nothing here may touch the paint path) ──
  useEffect(() => {
    // Friction stopwatch: the REPL's first mount IS boot→interactive — one
    // real sample off the process's own uptime (records once; /clear is not
    // a boot). The /trace FRICTION section renders it against its budget.
    recordBootInteractive();
    // The daemon that hosts every session PRE-WARMS right after the first
    // paint (never before the first frame — the flicker law), so the first
    // message never waits for a daemon start; the message itself creates
    // the session. The same hook then arms the WARM RUNNER for this
    // workspace (daemon/warmRunner.ts): a freshly spawned owned daemon
    // already self-warmed at boot ('kept'), while an already-running daemon
    // pre-spawns one now — either way the first message claims a booted
    // runner instead of paying the spawn.
    setTimeout(() => {
      void import('../services/switchboard/ensureDaemon.js')
        .then(async m => {
          if (await m.ensureOwnedDaemon()) await m.warmSessionRunner(getCwd());
        })
        .catch(() => {});
    }, 0);
    // The context-window sources — local model discovery (bounded loopback
    // probes, in parallel) and one bounded catalogue GET per family whose
    // credential exists — deferred one macrotask past this mount so the
    // first paint never waits on them. They decide the window the rail and
    // /context budget against, and the first /model open lists the live
    // lineup instead of the dated pins (TTL'd; the picker refreshes after).
    setTimeout(() => {
      void import('../utils/model/contextWindowWarmup.js')
        .then(m => m.warmContextWindowSources())
        .catch(() => {});
    }, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The quiet update notice (sweep #2, item 81): armed once after
  // the boot frames, at most one listing a day, silent on failure, one calm
  // line that expires on its own; MERCURY_UPDATE_NOTICE=0 disables it.
  useEffect(() => {
    const disarm = scheduleQuietUpdateNotice(text =>
      addNotification({ key: UPDATE_NOTICE_KEY, text, priority: 'low', timeoutMs: 20_000 }),
    );
    return disarm;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // THE ONE HONEST LINE of the daemon-version handshake (daemon/handshake.ts):
  // a daemon of another version that cannot restart yet — live sessions, a
  // terminal daemon, a pre-handshake build — is named once with the way
  // out; the line clears itself once the handshake matches again. The
  // handshake runs on the daemon door (ensureOwnedDaemon); this only paints.
  useEffect(() => {
    const key = 'daemon-version';
    let alive = true;
    let unsubscribe = (): void => {};
    void import('../daemon/handshake.js')
      .then(hs => {
        if (!alive) return;
        const paint = (): void => {
          const line = hs.lastDaemonHandshake()?.line ?? null;
          if (line !== null) addNotification({ key, text: line, priority: 'high', color: 'warning', timeoutMs: 60_000 });
          else removeNotification(key);
        };
        paint();
        unsubscribe = hs.subscribeDaemonHandshake(paint);
      })
      .catch(() => {});
    return () => {
      alive = false;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Background housekeeping starts exactly on the first submit.
  useEffect(() => {
    if (submitCount !== 1) return;
    try {
      startBackgroundHousekeeping();
    } catch (error) {
      logForDebugging(`background housekeeping failed to start: ${String(error)}`);
    }
  }, [submitCount]);

  // Companion publishes: the live turn facts every cockpit surface reads.
  useEffect(() => {
    publishCompanionTurn({
      turnLive: isLoading,
      streaming: textActive,
      awaitingPermission: toolUseConfirmQueue.length > 0,
    });
  }, [isLoading, textActive, toolUseConfirmQueue.length]);

  // The transcript store's failure surface (B15): the writer publishes a
  // health fact after two consecutive drain failures; ONE sticky
  // notification carries the store owner's exact sentence, cleared on the
  // first successful drain — before this, an unwritable or full config
  // home silently stopped saving the session (debug-log only).
  useEffect(() => {
    const paint = (): void => {
      const health = transcriptStoreHealth();
      if (health.failing) {
        addNotification({
          key: 'transcript-store',
          text: health.sentence ?? 'the session transcript store is failing to write',
          priority: 'high',
          timeoutMs: 3_600_000,
        });
      } else {
        removeNotification('transcript-store');
      }
    };
    paint();
    return subscribeTranscriptStoreHealth(paint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Transcript LOAD degradation (FN-013 CRASH-05a, the store-health
  // pattern's read-side sibling): the loader classifies malformed and
  // shape-invalid records — and a whole-file refusal — but the fact only
  // ever reached the debug log, so a damaged transcript resumed quietly
  // (or resumed EMPTY with nobody told). The latched fact paints ONE
  // sticky notification; the repair itself is the split's deferred half.
  useEffect(() => {
    const paintDegradation = (): void => {
      try {
        const fact = transcriptLoadDegradation();
        if (!fact) return;
        const where = fact.path;
        addNotification({
          key: 'transcript-degraded',
          text:
            fact.refusal !== null
              ? `transcript refused on load: ${fact.refusal} — ${where} · this session resumed WITHOUT its prior records (nothing was repaired)`
              : `transcript degraded on load: ${fact.malformed} malformed, ${fact.invalid} invalid of ${fact.totalLines} line(s) — ${where} · the valid records loaded; nothing was repaired`,
          priority: 'high',
          timeoutMs: 3_600_000,
        });
      } catch {
        // a disclosure affordance — never a boot hazard
      }
    };
    paintDegradation();
    return subscribeTranscriptLoadDegradation(paintDegradation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Boot health preflight: notify only on fault.
  useEffect(() => {
    if (!mercuryBootPreflightEnabled()) return;
    void runAndRecordPreflight()
      .then(summary => {
        const failing = summary.failing[0];
        if (!failing) return;
        addNotification({
          key: 'boot-preflight',
          text: `boot preflight: ${failing.id} failed${failing.evidence ? ` — ${failing.evidence}` : ''} · /health for details`,
          priority: 'high',
          timeoutMs: 60_000,
        });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Crash-report boot notice (B20's read half; FN-013 CRASH-03 made it
  // name its session and project and offer re-entry): a crash persisted
  // since the last notice gets ONE word at the next interactive boot. When
  // the newest report names a session whose transcript still resolves, the
  // word is an actionable dialog — one keypress resumes that session in
  // its project; otherwise the plain notice paints, naming what identity
  // survived and saying so when the transcript is gone. The marker latches
  // BEHIND display (the effect below): an unattended boot that never shows
  // the notice leaves it unconsumed.
  useEffect(() => {
    try {
      const unnoticed = unnoticedCrashReports();
      const newest = unnoticed[0];
      if (!newest) return;
      const more = unnoticed.length - 1;
      const identityBits = [
        newest.sessionId !== null ? `session ${newest.sessionId.slice(0, 8)}` : null,
        newest.cwd !== null ? `in ${nodePathBasename(newest.cwd) || newest.cwd}` : null,
      ].filter((bit): bit is string => bit !== null);
      if (newest.sessionId !== null) {
        // Actionable only when the session can actually come back: its
        // transcript resolves in the recorded project (or the current one).
        let transcriptPath: string | undefined;
        try {
          const candidate = join(getProjectDir(newest.cwd ?? getCwd()), `${newest.sessionId}.jsonl`);
          if (existsSync(candidate)) transcriptPath = candidate;
        } catch {
          /* unresolvable store — the plain notice speaks instead */
        }
        if (transcriptPath !== undefined) {
          setCrashResumeStaged({
            origin: newest.origin,
            component: newest.component,
            message: newest.message,
            sessionId: newest.sessionId,
            cwd: newest.cwd,
            transcriptPath,
            moreCount: more,
          });
          return;
        }
      }
      addNotification({
        key: 'crash-reports',
        text: `a previous session crashed (${newest.origin}${newest.component ? ` in ${newest.component}` : ''} — ${newest.message.slice(0, 80)})${identityBits.length > 0 ? ` · ${identityBits.join(' ')}` : ''}${newest.sessionId !== null ? ' — its transcript is gone, so no re-entry is offered' : ''}${more > 0 ? ` +${more} more` : ''} · reports in ${crashReportDirDisplay()}`,
        priority: 'high',
        timeoutMs: 60_000,
      });
      if (!crashNoticeLatchedRef.current) {
        crashNoticeLatchedRef.current = true;
        markCrashReportsNoticed();
      }
    } catch {
      // forensics affordance — never a boot hazard
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The offer's display latch: the marker advances when the dialog has
  // actually held focus (shown), never at stage time — a boot that exits
  // before the dialog's turn re-offers next boot.
  useEffect(() => {
    if (focusedInputDialog === 'crash-resume' && !crashNoticeLatchedRef.current) {
      crashNoticeLatchedRef.current = true;
      try {
        markCrashReportsNoticed();
      } catch {
        /* the notice may repeat — better twice than never */
      }
    }
  }, [focusedInputDialog]);

  // Interactive resume-fold notice (FN-013 CRASH-02, the crash-notice
  // pattern): the launcher ran the run-level interruption fold before this
  // projection mounted; its one-shot latch carries what the fold found —
  // tool calls that died mid-flight (now uncertainty markers gating
  // completion behind an inspect step) and a re-emitted operator blocker.
  // Both facts must reach the operator, not only the /run screen.
  useEffect(() => {
    try {
      const notice = takeResumeFoldNotice();
      if (!notice) return;
      if (notice.interruptedTools > 0) {
        addNotification({
          key: 'resume-run-fold',
          text: `resumed run: ${notice.interruptedTools} tool call(s) interrupted mid-flight — inspect their real state before claiming completion · /run for the reconciled record`,
          priority: 'high',
          timeoutMs: 60_000,
        });
      }
      if (notice.blocker) {
        addNotification({
          key: 'resume-run-blocker',
          text: `resumed run is blocked: ${notice.blocker.description} (resume condition: ${notice.blocker.resumeCondition})`,
          priority: 'high',
          timeoutMs: 60_000,
        });
      }
    } catch {
      // a notice affordance — never a boot hazard
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Integrity boot verify while the plane is active (the default since the
  // default-on ruling; explicit MERCURY_THEMIS=off skips). The
  // FULL designed sweep — lockfile + drift + chain verify + the pairing
  // invariant — through the one boot seam (themisBootVerify), which also
  // writes the boot audit rows. Level is read through themisActive(): the
  // one reader owns the unset⇒default resolution, never an inline re-read.
  useEffect(() => {
    if (!themisActive()) return;
    void themisBootVerify(getCwd())
      .then(report => {
        if (!report.ran || report.problems.length === 0) return;
        const others = report.problems.length - 1;
        addNotification({
          key: 'integrity-boot-verify',
          text: `integrity: ${report.problems[0]}${others > 0 ? ` (+${others} more)` : ''} · /health for details`,
          priority: 'high',
          timeoutMs: 60_000,
        });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-mode default surfaces: the nudge wins when both apply.
  useEffect(() => {
    void (async () => {
      try {
        const nudge = shouldShowAutoDefaultNudge();
        if (nudge !== null) {
          setNudgeStagedMode(nudge);
          setAutoModeSurface('nudge');
          return;
        }
        if (shouldShowAutoDefaultNotice(store.getState().toolPermissionContext.mode)) setAutoModeSurface('notice');
      } catch {
        // a surface that cannot be evaluated is not shown
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The API key re-verifies in the same mount-once initialiser.
  useEffect(() => {
    void apiKeyVerification.reverify().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Boot-idle warm-up: cold costs off the critical path.
  useEffect(() => {
    const timer = setTimeout(() => {
      // The context-capsule producer's first collection pays the cold
      // project snapshot (~95ms measured: git status + tree digest) INSIDE
      // the submit->send path; priming the same TTL cache here moves that
      // cost to boot idle. Freshness law unchanged — collection still
      // re-reads through the 120s TTL exactly as before.
      void import('../services/projectIntel/snapshot.js')
        .then(m => m.getProjectSnapshotAsync(getOriginalCwd(), { maxStaleMs: 120_000 }))
        .catch(() => {});
      // GPT seamlessness (field directive): with a connected account, prime
      // the live-catalogue fetch at boot idle so the FIRST /model of the
      // session already carries the GPT rows (getGptSeatAvailability
      // self-guards and kicks the TTL'd single-flight refresh).
      void import('../services/providers/openai/openaiCatalogue.js')
        .then(m => m.getGptSeatAvailability())
        .catch(() => {});
    }, BOOT_WARMUP_MS);
    return () => clearTimeout(timer);
  }, []);

  // ── the independent notification hooks (all unconditional) ──────────
  useModelMigrationNotifications();
  useCanSwitchToExistingSubscription();
  useAutoModeUnavailableNotification();
  useSettingsErrors();
  useRateLimitWarningNotification(mainLoopModel);
  useDeprecationWarningNotification(mainLoopModel);
  useLspInitializationNotification();

  // ── title, tab status, activity, sleep ───────────────────────────────
  const isWaitingForApproval = focusedInputDialog === 'tool-permission';
  const showingLocalDialog = focusedInputDialog !== undefined && focusedInputDialog !== 'tool-permission';
  const sessionTitleSetting = useAppState(state => (state.settings as { terminalTitle?: { sessionTitle?: boolean } }).terminalTitle?.sessionTitle);
  const sessionTitle = sessionTitleSetting === false ? undefined : getCurrentSessionTitle(asSessionId(focusedConnector.sessionId()));
  const agentTitle = store.getState().standaloneAgentContext?.name;
  const title = sessionTitle ?? agentTitle ?? generatedTitle ?? 'Mercury';
  const tabStatus: TabStatusKind = isWaitingForApproval || showingLocalDialog ? 'waiting' : isLoading ? 'busy' : 'idle';
  const tabStatusEnabled =
    getFeatureValue_CACHED_MAY_BE_STALE<boolean>('terminal_tab_status', false) &&
    getGlobalConfig().showStatusInTerminalTab === true &&
    terminalTitleEnabled;
  useTabStatus(tabStatusEnabled ? tabStatus : null);
  const titleAnimating = isLoading && !isWaitingForApproval && !showingLocalDialog;
  useEffect(() => {
    if (!titleAnimating) return;
    startPreventSleep();
    return () => stopPreventSleep();
  }, [titleAnimating]);
  // Adaptive density: `waiting` is the approval predicate ALONE; `review`
  // is the diff-review overlay's open state.
  const diffReviewOpen = useOverlayOpen('diff-dialog');
  const cockpitActivity: ActivityState = isWaitingForApproval ? 'waiting' : diffReviewOpen ? 'review' : isLoading ? 'active' : 'calm';
  useEffect(() => {
    publishCockpitActivity(cockpitActivity);
  }, [cockpitActivity]);

  // ── idle prompt notification ─────────────────────────────────────────
  const editGenerationAtCompleteRef = useRef(0);
  useEffect(() => {
    if (submitCount === 0 || lastCompletedAt === null) return;
    const threshold = getGlobalConfig().messageIdleNotifThresholdMs;
    if (!threshold || threshold <= 0) return;
    const timer = setTimeout(() => {
      const interacted = pendingInput.editGeneration() !== editGenerationAtCompleteRef.current;
      if (interacted || isLoadingRef.current || toolJSX !== null || focusedInputDialogRef.current !== undefined) return;
      if (Date.now() - lastCompletedAt < threshold) return;
      void sendNotification({ message: 'Mercury is waiting for your input', notificationType: 'idle_prompt' }, terminal).catch(() => {});
    }, threshold);
    return () => clearTimeout(timer);
  }, [isLoading, toolJSX, submitCount, lastCompletedAt, terminal]);
  useEffect(() => {
    if (lastCompletedAt !== null) editGenerationAtCompleteRef.current = pendingInput.editGeneration();
  }, [lastCompletedAt]);

  // ── idle-return hint ─────────────────────────────────────────────────
  useEffect(() => {
    const treatment = idleReturnTreatment();
    if (treatment !== 'hint-dim' && treatment !== 'hint-plain') return;
    if (getGlobalConfig().idleReturnDismissed === true) return;
    if (lastCompletedAt === null || isLoading || messages.length === 0) return;
    const tokensUsed = getFocusedSessionConnector().usage().totalInputTokens;
    if (tokensUsed < idleTokenThreshold()) return;
    const remaining = Math.max(0, idleThresholdMinutes() * 60_000 - (Date.now() - lastCompletedAt));
    const timer = setTimeout(() => {
      const formatted = formatTokenCount(tokensUsed);
      addNotification({
        key: 'idle-return-hint',
        jsx:
          treatment === 'hint-dim' ? (
            <Text color={tokens.textMuted}>
              this may be a new task — <Text color={tokens.textPrimary}>/clear</Text> would save{' '}
              <Text color={tokens.textPrimary}>{formatted}</Text> tokens
            </Text>
          ) : (
            <Text color={tokens.warning}>{`this may be a new task — /clear would save ${formatted} tokens`}</Text>
          ),
        priority: 'medium',
        timeoutMs: PERSISTENT_NOTIFICATION_MS,
      });
    }, remaining);
    return () => {
      clearTimeout(timer);
      removeNotification('idle-return-hint');
    };
  }, [lastCompletedAt, isLoading, messages.length, addNotification, removeNotification, tokens]);

  // ── cost threshold ───────────────────────────────────────────────────
  const costThresholdShownRef = useRef<boolean>(getGlobalConfig().hasAcknowledgedCostThreshold === true);
  useEffect(() => {
    if (costThresholdShownRef.current) return;
    const focused = getFocusedSessionConnector();
    if (focused.usage().totalCostUSD < COST_THRESHOLD_USD) return;
    // Marked shown unconditionally so this never re-fires per message.
    costThresholdShownRef.current = true;
    if (focused.identity().consoleBilling) setShowCostThreshold(true);
  }, [messages.length]);

  // ── worktree tip (once per boot) ─────────────────────────────────────
  const worktreeTipShownRef = useRef(false);
  useEffect(() => {
    if (worktreeTipShownRef.current) return;
    const worktree = getCurrentWorktreeSession();
    if (!worktree || typeof worktree.creationDurationMs !== 'number') return;
    if (worktree.usedSparsePaths === true) return;
    const seconds = Math.round(worktree.creationDurationMs / 1000);
    if (seconds < WORKTREE_TIP_SECONDS) return;
    worktreeTipShownRef.current = true;
    addNotification({
      key: 'worktree-tip',
      text: `worktree creation took ${seconds}s — large repositories benefit from the sparse-paths setting, e.g. { "worktree": { "sparsePaths": ["src/"] } }`,
      priority: 'low',
      timeoutMs: 20_000,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── multiplexer mouse hint (never mutate the multiplexer's option) ───
  useEffect(() => {
    if (!fullscreen) return;
    void maybeGetTmuxMouseHint().then(hint => {
      if (hint) addNotification({ key: 'tmux-mouse-hint', text: hint, priority: 'low', timeoutMs: RECEIPT_TIMEOUT_MS });
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── transcript mode ──────────────────────────────────────────────────
  const scrollRestoreRef = useRef<ScrollRestore | null>(null);
  const captureScrollForFlip = useCallback(() => {
    const handle = scrollRef.current;
    if (!handle) {
      scrollRestoreRef.current = null;
      return;
    }
    const gap = Math.max(0, handle.getFreshScrollHeight() - handle.getViewportHeight() - handle.getScrollTop());
    scrollRestoreRef.current = { gap, sticky: gap === 0 };
  }, []);
  const [flipGeneration, setFlipGeneration] = useState(0);
  useLayoutEffect(() => {
    const restore = scrollRestoreRef.current;
    if (!restore) return;
    scrollRestoreRef.current = null;
    const handle = scrollRef.current;
    if (!handle) return;
    if (restore.sticky) {
      handle.scrollToBottom();
      return;
    }
    handle.scrollTo(Math.max(0, handle.getFreshScrollHeight() - handle.getViewportHeight() - restore.gap));
  }, [flipGeneration]);

  const handleEnterTranscript = useCallback(() => {
    captureScrollForFlip();
    setFrozenTranscriptState({
      messageCount: getFocusedSessionConnector().records().length,
      streamingToolUseCount: 0,
    });
    setFlipGeneration(g => g + 1);
  }, [captureScrollForFlip]);
  const handleExitTranscript = useCallback(() => {
    captureScrollForFlip();
    setFrozenTranscriptState(null);
    setSearchBarOpen(false);
    setCommittedSearchQuery('');
    setSearchMatchCount(null);
    setSearchMatchCurrent(0);
    jumpRef.current?.disarmSearch();
    editorGenerationRef.current += 1;
    setEditorStatus(null);
    setDumpMode(false);
    dumpFiredRef.current = false;
    setFlipGeneration(g => g + 1);
  }, [captureScrollForFlip]);
  const globalKeybindingProps = {
    screen,
    setScreen,
    showAllInTranscript,
    setShowAllInTranscript,
    messageCount: messages.length,
    onEnterTranscript: handleEnterTranscript,
    onExitTranscript: handleExitTranscript,
    virtualScrollActive: inVirtualTranscriptMode,
    searchBarOpen,
  };
  const inTranscript = screen === 'transcript';
  const inVirtualTranscript = inTranscript && inVirtualTranscriptMode;
  const legacyTranscript = inTranscript && !inVirtualTranscriptMode;

  // Freshness per entry: the highlighter follows the parsed query's free text.
  const { setQuery: setHighlight, scanElement, setPositions } = useSearchHighlight();
  useEffect(() => {
    if (!inTranscript) {
      setHighlight('');
      setPositions(null);
      return;
    }
    setHighlight(parseSearchQuery(committedSearchQuery).text ?? '');
  }, [inTranscript, committedSearchQuery, setHighlight, setPositions]);
  useEffect(() => {
    if (!editorStatus) return;
    const timer = setTimeout(() => setEditorStatus(null), EDITOR_STATUS_MS);
    return () => clearTimeout(timer);
  }, [editorStatus]);
  // A width change makes cached match positions stale: abort the search.
  const lastColumnsRef = useRef(columns);
  useEffect(() => {
    if (lastColumnsRef.current === columns) return;
    lastColumnsRef.current = columns;
    if (searchBarOpen || committedSearchQuery !== '') {
      setSearchBarOpen(false);
      setCommittedSearchQuery('');
      setSearchMatchCount(null);
      setSearchMatchCurrent(0);
      jumpRef.current?.disarmSearch();
      setHighlight('');
    }
  }, [columns, searchBarOpen, committedSearchQuery, setHighlight]);

  const openTranscriptInEditor = useCallback(() => {
    if (editorInFlightRef.current) return;
    editorInFlightRef.current = true;
    const generation = editorGenerationRef.current;
    setEditorStatus('rendering transcript…');
    void (async () => {
      try {
        const text = await renderMessagesToPlainText([...getFocusedSessionConnector().records()], mergedTools, Math.max(80, columns - 6));
        const cleaned = text
          .split('\n')
          .map(line => line.replace(/\s+$/, ''))
          .join('\n');
        const path = join(tmpdir(), `mercury-transcript-${Date.now()}.md`);
        writeFileSync(path, cleaned, 'utf8');
        if (generation !== editorGenerationRef.current) return;
        // ONE opener (w32-02 + ctr-6): utils/editor's door quotes every
        // token for the win32 shell (a raw shell:true spawn joined an
        // UNQUOTED cmd line, so a program-files editor path ran its first
        // space-separated segment with the error swallowed), attaches an
        // error listener, and answers whether an editor is configured —
        // this handler used to claim "opened …" whatever happened and
        // taught the POSIX $EDITOR spelling on every platform.
        const { openFileInExternalEditor } = await import('../utils/editor.js');
        if (openFileInExternalEditor(path)) {
          setEditorStatus(`opening ${path}`);
        } else {
          setEditorStatus(
            process.platform === 'win32'
              ? `written to ${path} — set EDITOR (or VISUAL) to open it`
              : `written to ${path} — set $EDITOR to open it`,
          );
        }
      } catch (error) {
        if (generation === editorGenerationRef.current) setEditorStatus(`render failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        editorInFlightRef.current = false;
      }
    })();
  }, [columns, mergedTools]);

  // Pager keys: bare letters in a modal reading view. Every handler checks
  // the surface route first and ignores ctrl/meta chords.
  useInput(
    (input, key) => {
      if (currentSurfaceRoute().kind !== 'repl') return;
      if (key.ctrl || key.meta) return;
      if (input === '/' && !searchBarOpen) {
        jumpRef.current?.setAnchor();
        setSearchBarOpen(true);
        return;
      }
      if ((input === 'n' || input === 'N') && !searchBarOpen && !dumpMode && searchMatchCount !== null && searchMatchCount > 0) {
        // Held-key batching coalesces repeats: step once per character.
        for (const ch of input) {
          if (ch === 'n') jumpRef.current?.nextMatch();
          else jumpRef.current?.prevMatch();
        }
        return;
      }
      if (input === 'q' && !searchBarOpen) {
        handleExitTranscript();
        setScreen('prompt');
        return;
      }
      // g/G: the advertised pager jumps — top of the transcript / live tail.
      if (input === 'g' && !searchBarOpen) {
        scrollRef.current?.scrollTo(0);
        return;
      }
      if (input === 'G' && !searchBarOpen) {
        scrollRef.current?.scrollToBottom();
        return;
      }
      if (input === '[' && !searchBarOpen && !dumpFiredRef.current) {
        dumpFiredRef.current = true;
        setShowAllInTranscript(true);
        setDumpMode(true);
        return;
      }
      if (input === 'v' && !searchBarOpen) {
        openTranscriptInEditor();
      }
    },
    { isActive: inTranscript && focusedInputDialog === undefined },
  );

  const commitSearch = useCallback((query: string) => {
    setSearchBarOpen(false);
    if (query === '' || searchMatchCount === 0) {
      // A zero-match query is discarded; an empty commit clears explicitly
      // because the bar unmounts before its own effect could.
      setCommittedSearchQuery('');
      setSearchMatchCount(null);
      setSearchMatchCurrent(0);
      jumpRef.current?.setSearchQuery('');
      setHighlight('');
      return;
    }
    setCommittedSearchQuery(query);
  }, [searchMatchCount, setHighlight]);
  const cancelSearch = useCallback(() => {
    setSearchBarOpen(false);
    jumpRef.current?.setSearchQuery('');
    jumpRef.current?.setSearchQuery(committedSearchQuery);
    setHighlight(parseSearchQuery(committedSearchQuery).text ?? '');
  }, [committedSearchQuery, setHighlight]);
  const previewSearch = useCallback((query: string) => {
    jumpRef.current?.setSearchQuery(query);
    setHighlight(parseSearchQuery(query).text ?? '');
  }, [setHighlight]);
  const warmSearchIndex = useCallback(() => jumpRef.current?.warmSearchIndex() ?? Promise.resolve(0), []);
  const onSearchMatchesChange = useCallback((count: number, current: number) => {
    setSearchMatchCount(count);
    setSearchMatchCurrent(current);
  }, []);
  useEffect(() => {
    if (!inTranscript) return;
    if (committedSearchQuery === '') return;
    jumpRef.current?.setSearchQuery(committedSearchQuery);
  }, [inTranscript, committedSearchQuery]);
  useKeybinding('app:interrupt', () => {
    if (searchBarOpen) cancelSearch();
  }, { isActive: searchBarOpen });

  // ── message actions ──────────────────────────────────────────────────
  // Message actions are always offered — there is no kill flag.
  const messageActionsDisabled = false;
  // The cursor lives in its own store (messageCursorStore): this root
  // subscribes to whether one STANDS — it swaps the composer for the bar
  // and mounts the key handlers on enter/exit — never to a move.
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
      // The words come back to the composer to send again; the session's
      // conversation itself is the runner's to rewind.
      const resubmit = textForResubmit(raw);
      if (resubmit) {
        setInputValue(resubmit.text);
        setInputMode(resubmit.mode);
      }
      refuseSessionRewrite('editing a sent message');
    },
  });

  // ── the message-selector paths ───────────────────────────────────────
  // /rewind (FN-015 rank 8): the session's runner owns its files and its
  // conversation — the cockpit asks it over the wire and paints the typed
  // receipt. A running turn is interrupted first and given a bounded
  // moment to settle (the runner refuses a rewind under a live turn). The
  // composer takes the rewound prompt's words back only once a
  // conversation rewind has LANDED — never before a refusal.
  const onRestore = useCallback(
    async (message: UserMessage, mode: 'both' | 'conversation' | 'code'): Promise<RewindReceiptV1> => {
      const connector = getFocusedSessionConnector();
      if (connector.turnActive()) {
        connector.interrupt();
        const deadline = Date.now() + REWIND_SETTLE_WAIT_MS;
        while (connector.turnActive() && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      const receipt = await connector.rewind({ userMessageId: message.uuid, mode });
      if (receipt.outcome === 'applied' && receipt.conversation !== undefined) {
        const resubmit = textForResubmit(message);
        if (resubmit) {
          setInputValue(resubmit.text);
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

  // ── suspend / resume ─────────────────────────────────────────────────
  const { internal_eventEmitter } = useStdin();
  useEffect(() => {
    const onSuspend = (): void => {
      // In fullscreen the raw write would land on the alternate buffer.
      if (!fullscreen) {
        process.stdout.write('\nMercury suspended — `fg` brings it back (ctrl+z suspends, ctrl+_ undoes input)\n');
      }
    };
    const onResume = (): void => setRemountKey(k => k + 1);
    internal_eventEmitter.on('suspend', onSuspend);
    internal_eventEmitter.on('resume', onResume);
    return () => {
      internal_eventEmitter.removeListener('suspend', onSuspend);
      internal_eventEmitter.removeListener('resume', onResume);
    };
  }, [fullscreen, internal_eventEmitter]);

  // ── message source selection ─────────────────────────────────────────
  // paint-from-warmth (the never-blank law): while an entry's fold is still
  // landing — the focused records EMPTY with an entry armed — the live view
  // paints the warmth the viewer already held (the mirror's tail slice) or
  // the honest loading row. RENDER-ONLY: `messages` (the exports, search,
  // the selectors, the unseen divider) keeps reading
  // the connector's own records, and the truth replaces the hint the moment
  // it lands (identical row uuids — both sides fold the same transcript —
  // so the swap reconciles seamlessly).
  const warmthVersion = useSyncExternalStore(subscribeSessionWarmth, sessionWarmthVersion, sessionWarmthVersion);
  // THE IDENTITY LAW: every warmth read is keyed by the session this mount
  // shows ('' while the slot rests) — warmth answers only for the identity
  // that earned it, and the COVERED identity (the pre-entry chat the slot
  // still holds until the re-point) is painted over, never cross-painted.
  const focusedSessionId = focusedConnector.sessionId();
  const paintedMessages = useMemo(
    () => paintedTranscriptOf(messages, enteringWarmth(), focusedSessionId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the store version keys the warmth read
    [messages, warmthVersion, focusedSessionId],
  );
  // The COLD half of never-blank: an entry armed with no warmth and no
  // records yet paints this chrome line at the transcript slot (the message
  // grammar has no honest loading row — 'info' system rows are verbose-only).
  const entryLoadingLine = entryLoadingLineOf(enteringWarmth(), messages.length === 0, focusedSessionId);
  // The hint settles at fold-complete replace: the entered session's records
  // landed (the truth wins, the slice dies), or the slot points at a session
  // the arm names NEITHER as entered NOR as covered — a merely-not-yet-
  // re-pointed slot is the covered case, not a mismatch. Idempotent beside
  // the entry road's own landing-settled disarm.
  useEffect(() => {
    const warmth = enteringWarmth();
    if (warmth === null) return;
    const focusedId = focusedConnector.sessionId();
    if (messages.length > 0 && focusedId === warmth.sessionId) {
      evictSessionWarmth(warmth.sessionId);
      settleEntryWarmth(warmth.sessionId);
    } else if (hasFocusedSession() && focusedId !== warmth.sessionId && focusedId !== warmth.coveredSessionId) {
      settleEntryWarmth(warmth.sessionId);
    }
  }, [messages, focusedConnector, warmthVersion]);
  const deferredMessages = useDeferredValue(paintedMessages);
  const liveOrDeferred = isLoading && !textActive ? deferredMessages : paintedMessages;
  const transcriptMessages = useMemo(
    () => (frozenTranscriptState ? messages.slice(0, frozenTranscriptState.messageCount) : messages),
    [messages, frozenTranscriptState],
  );
  const localJsx = Boolean(toolJSX?.jsx && toolJSX.isLocalJSXCommand);
  const centredModalUp = localJsx && fullscreen;
  const displayedMessages = inVirtualTranscript ? transcriptMessages : liveOrDeferred;

  const unseen = useUnseenDivider(messages.length);
  // A hop swaps the whole rendered transcript (the focused slot re-points):
  // the divider and the scroll re-anchor at the new tail, never a stale mark.
  const rekeyedSessionRef = useRef(focusedSessionId);
  useEffect(() => {
    unseen.onRepin();
    repinToBottom();
    setConversationId(focusedSessionId);
    // A LANDING is not a hop: the flip-first birth paints this chat on an
    // empty slot before the daemon answers, and the born session's re-point
    // fills that slot from ''. What the operator did in the landing window
    // is this chat's own — the dialog opened stays up, the words typed stay
    // in the composer (the re-key below carries them) — where a hop between
    // sessions drops the dialog and swaps the page. A cold keyless admission
    // lands late enough for both to matter.
    const landing = rekeyedSessionRef.current === '' && focusedSessionId !== '';
    if (!landing) setToolJSX(null);
    // W4 (the one-owner draft store): the composer draft is the SESSION's
    // own — a real re-point re-keys the live families to the entered
    // session's saved draft (the mount's initSession seed owns the first
    // world; typing during the swap wins via the store's editSeq fence).
    // The command queue re-keys at the SAME swap moment (AGENTDIALS C6,
    // W4's sibling): A's queued words park with A and B's return — B's
    // turn start can never fire A's words into B.
    if (rekeyedSessionRef.current !== focusedSessionId) {
      rekeyedSessionRef.current = focusedSessionId;
      void pendingInput.rekeyToSession(focusedSessionId === '' ? null : focusedSessionId, { landing });
      rekeyCommandQueueToSession(focusedSessionId === '' ? null : focusedSessionId, { landing });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedSessionId]);
  // NO CHAT ⇒ THE BOOT MENU (Law 9, rule 5): the root REPL never fronts a
  // resting slot. The router's strip and home verbs never route INTO an
  // absent chat; this is the road OUT — the REPL alone knows when its own
  // screen work is done. Whenever no session holds the slot while the REPL
  // owns the frame and nothing of the screen's own is open — no dialog
  // command (Doctor's health card, the resume picker), no armed command
  // still to run — the frame is handed to the router's one landing for an
  // empty bridge (settleAbsentChat: the boot face, with nothing beneath to
  // return to): a closed Doctor card, a cancelled picker, /clear whose
  // fresh birth was refused, all land there. The check settles one beat
  // after the change and re-reads every fact at fire time, so a dialog
  // mounting between an armed command's consumption and its paint is never
  // buried under the face; a LANDING in flight (a birth, a hop, a resume
  // between its door and the slot's re-point — the face rows' direct
  // focusResumedSession landings ride withLanding) holds the yield too. An
  // inline boot has no frame for
  // the face (CB-10) and keeps its REPL: every send answers the resting
  // slot's own sentence.
  const slotHasSession = useSyncExternalStore(subscribeFocusedSessionConnector, hasFocusedSession, hasFocusedSession);
  const toolJSXRef = useRef(toolJSX);
  toolJSXRef.current = toolJSX;
  const armedMessageRef = useRef(armedMessage);
  armedMessageRef.current = armedMessage;
  useEffect(() => {
    if (slotHasSession || landing || replSurfaceCovered || localJsx || armedMessage !== null) return;
    if (!isFullscreenEnvEnabled()) return;
    const settle = setTimeout(() => {
      if (hasFocusedSession() || landingInFlight() || currentSurfaceRoute().kind !== 'repl') return;
      if (toolJSXRef.current?.isLocalJSXCommand === true || armedMessageRef.current !== null) return;
      settleAbsentChat();
    }, NO_CHAT_SETTLE_MS);
    return () => clearTimeout(settle);
  }, [slotHasSession, landing, replSurfaceCovered, localJsx, armedMessage]);
  const unseenDivider = useMemo(
    () => (fullscreen ? computeUnseenDivider(messages, unseen.dividerIndex) : undefined),
    [fullscreen, messages, unseen.dividerIndex],
  );
  const newMessageCount = unseen.dividerIndex === null ? 0 : countUnseenAssistantTurns(messages, unseen.dividerIndex);
  const onScroll = useCallback(
    (sticky: boolean, handle: ScrollBoxHandle) => {
      noteUserScroll();
      if (sticky) unseen.onRepin();
      else unseen.onScrollAway(handle);
    },
    [noteUserScroll, unseen],
  );
  const onPillClick = useCallback(() => {
    setMessageCursor(null);
    unseen.jumpToNew(scrollRef.current);
  }, [unseen]);
  const disarmSearchOnScroll = useCallback(() => {
    jumpRef.current?.disarmSearch();
  }, []);

  // Re-pin on the user's own message, keyed on the identity of the last row
  // (the shared human-turn predicate).
  const lastMessage = messages[messages.length - 1];
  useEffect(() => {
    if (lastMessage && isHumanTurn(lastMessage)) repinToBottom();
  }, [lastMessage, repinToBottom]);

  // ── spinner and status strip ─────────────────────────────────────────
  // The VIEW's live-turn inputs are the focused chat's: its tool progress,
  // phase and clock fold from its records.
  const viewInProgressToolUseIDs = seatLive.inProgressToolUseIDs;
  // All the live phases reach the spinner: 'tool' takes the dedicated
  // tool-use mode (its own shimmer/treatment) instead of vanishing into
  // 'responding' — the collapse here was why a daemon-hosted chat never
  // showed the tool-running state. 'compacting' takes the requesting mode
  // (the info channel — a mechanical wait, no token stream) and speaks its
  // own word below; dressing the fold as 'thinking' put the session's
  // effort suffix on a bounded utility call.
  const viewStreamMode: SpinnerMode =
    seatLive.phase === 'thinking' ? 'thinking' : seatLive.phase === 'tool' ? 'tool-use' : seatLive.phase === 'compacting' ? 'requesting' : 'responding';
  const viewCompacting = seatLive.phase === 'compacting';
  // The spinner's token counter + tok/s poll this ref on their own animation
  // ticks; a LIVE getter feeds them the focused connector's streamed-char
  // count (the tail projection's turnChars). The old useRef(0) was fed by
  // ToolUseContext.setResponseLength — a road the daemon-hosted world stubs
  // to a no-op everywhere, so the counter sat frozen at 0 through every
  // streaming turn (the operator's "token counter is flat-out broken").
  const responseLengthRef = useMemo(
    () => ({
      get current(): number {
        return getFocusedLiveResponseChars();
      },
    }),
    [],
  );
  const apiMetricsRef = useRef<Array<{ ttftMs: number; firstTokenTime: number; lastTokenTime: number; responseLengthBaseline: number; endResponseLength: number }>>([]);
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
    // Hide spinner when streaming text is visible — the text is the feedback,
    // unless brief-only mode suppresses it, or the reveal itself is
    // suppressed (FN-016 R2): a tail that is not painting must not stand
    // the verb row down — the working strip is then the only live feedback.
    !textActive || isBriefOnly || streamingSuppressed
  );
  const spinnerSuffix = stopHookSuffix(messages, isLoading);
  const workingStatusStrip = <Box flexDirection="column">
    {showSpinner ? (
      <SpinnerWithVerb mode={viewStreamMode}
        loadingStartTimeRef={seatStartTimeRef}
        totalPausedMsRef={seatPausedMsRef}
        pauseStartTimeRef={seatPauseStartRef}
        spinnerTip={spinnerTip}
        responseLengthRef={responseLengthRef}
        overrideColor={null}
        overrideShimmerColor={null}
        overrideMessage={viewCompacting ? 'compacting context…' : null}
        spinnerSuffix={spinnerSuffix ?? null}
        verbose={verbose}
        hasActiveTools={viewInProgressToolUseIDs.size > 0}
        activeToolCount={viewInProgressToolUseIDs.size}
        activeToolLabel={activeToolVerb(messages, viewInProgressToolUseIDs)}
        leaderIsIdle={!isLoading}
        apiMetricsRef={apiMetricsRef}
      />
    ) : spinnerSlotReserved ? <StreamingHoldRow loadingStartTimeRef={seatStartTimeRef} totalPausedMsRef={seatPausedMsRef} pauseStartTimeRef={seatPauseStartRef} responseLengthRef={responseLengthRef} /> : null}
    <MercuryTurnRollup
      messages={messages}
      tools={mergedTools}
      model={focusedEffectiveModel}
      isLoading={isLoading}
      streamingThinking={null}
      isThinking={viewStreamMode === 'thinking'}
    />
  </Box>;

  // ── overlays and dialogs ─────────────────────────────────────────────
  // The tool-permission request is THE overlay; every other dialog lives in
  // the bottom column.
  const permissionOverlay =
    focusedInputDialog === 'tool-permission' && toolUseConfirmQueue[0] && !replSurfaceCovered ? (
      <PermissionQueueContext.Provider value={permissionQueueStatus(resolvedConsentCount, toolUseConfirmQueue.length)}>
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
          setStickyFooter={setPermissionStickyFooter}
        />
      </PermissionQueueContext.Provider>
    ) : null;

  const messageSelector =
    focusedInputDialog === 'message-selector' && !replSurfaceCovered ? (
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
          // The branch forks from the FOCUSED session's own transcript file
          // (the committed records — the in-memory transcript's index can
          // differ from the file's).
          const focused = getFocusedSessionConnector() as PaintsRows;
          const sourceTranscriptPath = typeof focused.transcriptFile === 'function' ? focused.transcriptFile() : null;
          if (!sourceTranscriptPath) return { ok: false as const, reason: 'no transcript file to branch from — the chat owns no session yet' };
          const entries = await readAllTranscriptEntries(sourceTranscriptPath);
          const idx = entries.findIndex(entry => (entry as { uuid?: string }).uuid === message.uuid);
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
          const { loadConversationForResume } = await import('../utils/conversationRecovery.js');
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

  // The three tool-JSX routings: in fullscreen EVERY local-JSX slash command
  // floats in the centred modal, immediate ones included; outside fullscreen
  // an IMMEDIATE local-JSX command sits in the bottom column's full-width
  // box; everything else with JSX renders inline in the scrollable body.
  const centredModal: React.ReactNode = centredModalUp ? toolJSX!.jsx : null;
  const bottomImmediateJsx: React.ReactNode =
    localJsx && !fullscreen && toolJSX!.isImmediate ? (
      <Box width="100%" flexDirection="column">
        {toolJSX!.jsx}
      </Box>
    ) : null;
  const inlineToolJsx =
    toolJSX?.jsx && !centredModal && !bottomImmediateJsx ? (
      <Box width="100%" flexDirection="column">
        {toolJSX.jsx}
      </Box>
    ) : null;

  // The bottom-column dialogs stand down while another route surface owns
  // the frame (THE COVERED-DIALOG GATE above) — a covered dialog would eat
  // the board's keys.
  const focusedBottomDialog: React.ReactNode = replSurfaceCovered ? null :
    focusedInputDialog === 'elicitation' && elicitationQueue[0] ? (
      <ElicitationDialog event={elicitationQueue[0]} onResponse={respondToElicitation} onWaitingDismiss={dismissElicitationWaiting} />
    ) : focusedInputDialog === 'ide-onboarding' ? (
      <IdeOnboardingDialog installationStatus={ideInstallationStatus} onDone={() => setShowIdeOnboarding(false)} />
    ) : focusedInputDialog === 'cost-threshold' ? (
      <CostThresholdDialog
        onDone={() => {
          setShowCostThreshold(false);
          saveGlobalConfig(config => ({ ...config, hasAcknowledgedCostThreshold: true }));
        }}
      />
    ) : focusedInputDialog === 'idle-return' && idleReturnStaged !== null ? (
      <IdleReturnDialog
        idleMinutes={idleReturnStaged.idleMinutes}
        totalInputTokens={getFocusedSessionConnector().usage().totalInputTokens}
        onDone={action => {
          const stagedText = idleReturnStaged.input;
          setIdleReturnStaged(null);
          if (action === 'dismiss') {
            setInputValue(stagedText);
            return;
          }
          if (action === 'never') saveGlobalConfig(config => ({ ...config, idleReturnDismissed: true }));
          idleCheckLatchedOffRef.current = true;
          void (async () => {
            if (action === 'clear') {
              // Start fresh: the session is dropped and a blank chat takes
              // the slot; the staged words create the next session.
              const hops = await import('../services/switchboard/hopIntoSession.js');
              await hops.clearFocusedSession();
            }
            await onSubmitRef.current(stagedText, INERT_PROMPT_HELPERS);
          })();
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
          // The one resume path (hopIntoSession): the crashed session comes
          // back in place, cross-project included — the door reads the
          // workspace from its record or the transcript's own head.
          void (async () => {
            addNotification({
              key: 'session-switch',
              text: `opening ${staged.sessionId.slice(0, 8)}…`,
              priority: 'medium',
              timeoutMs: SWITCH_STATUS_TIMEOUT_MS,
            });
            const { focusResumedSession } = await import('../services/switchboard/hopIntoSession.js');
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
    ) : focusedInputDialog === 'auto-mode' && autoModeSurface === 'nudge' ? (
      <AutoDefaultNudgeDialog currentMode={nudgeStagedMode ?? toolPermissionContext.mode} onDone={() => setAutoModeSurface(null)} />
    ) : focusedInputDialog === 'auto-mode' ? (
      <AutoDefaultNotice onDone={() => setAutoModeSurface(null)} />
    ) : null;

  // The exit path: a live WORKTREE session mounts the exit flow (the
  // worktree dialog); otherwise the real shutdown is the exit command
  // module's own — its result renders in the bottom column, and a null
  // result (a background-session detach) clears the exiting state.
  const handleExit = useCallback(() => {
    if (getCurrentWorktreeSession() !== null) {
      setShowExitFlow(true);
      return;
    }
    setIsExiting(true);
    void (async () => {
      try {
        const module = await import('../commands/exit/exit.js');
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
        logForDebugging(`exit command failed: ${String(error)}`);
        setIsExiting(false);
      }
    })();
  }, [store]);

  const promptInput = !disabled && !isExiting && !showExitFlow && !toolJSX?.shouldHidePromptInput && focusedInputDialog === undefined ? (
    <PromptInput
      debug={debug}
      ideSelection={undefined}
      toolPermissionContext={toolPermissionContext}
      setToolPermissionContext={setToolPermissionContext}
      apiKeyStatus={apiKeyVerification.status}
      commands={disableSlashCommands ? [] : commands}
      agents={agentDefinitions.activeAgents}
      isLoading={isLoading}
      verbose={verbose}
      submitCount={submitCount}
      onShowMessageSelector={openMessageSelector}
      onMessageActionsEnter={messageActionsDisabled ? undefined : messageActions.enter}
      mcpClients={NO_MCP_CLIENTS}
      vimMode={vimMode}
      setVimMode={setVimMode}
      showBashesDialog={showBashesDialog}
      setShowBashesDialog={setShowBashesDialog}
      onExit={handleExit}
      getToolUseContext={getToolUseContext}
      onSubmit={onSubmit}
      isSearchingHistory={isSearchingHistory}
      setIsSearchingHistory={setIsSearchingHistory}
      helpOpen={helpOpen}
      setHelpOpen={setHelpOpen}
      hasSuppressedDialogs={dialogsHiddenWhileTyping}
      isLocalJSXCommandActive={toolJSX?.isLocalJSXCommand === true}
      insertTextRef={insertTextRef}
    />
  ) : null;

  // The composer group; the message-actions bar replaces it while the
  // cursor is active.
  const composerGroup = promptInput ? <Box flexDirection="column">{promptInput}</Box> : null;
  const composerSlot =
    messageCursorActive && !messageActionsDisabled ? <MessageActionsBar /> : composerGroup;

  const bottomSlot = (
    <Box flexDirection="column">
      {inTranscript ? (
        searchBarOpen ? (
          <TranscriptSearchBar
            columns={columns}
            onQueryChange={previewSearch}
            onCommit={commitSearch}
            onCancel={cancelSearch}
            warmSearchIndex={warmSearchIndex}
            matchCount={searchMatchCount}
            matchCurrent={searchMatchCurrent}
          />
        ) : (
          <TranscriptFooter
            toggleChord={getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')}
            expandChord={getShortcutDisplay('transcript:toggleShowAll', 'Transcript', 'ctrl+e')}
            hasSearchBadge={committedSearchQuery !== '' && searchMatchCount !== null && searchMatchCount > 0}
            virtualScroll={inVirtualTranscript}
            showAllSuppressed={dumpMode}
            showAll={showAllInTranscript}
            status={editorStatus}
            badge={committedSearchQuery !== '' && searchMatchCount !== null && searchMatchCount > 0 ? `${searchMatchCurrent}/${searchMatchCount}` : null}
          />
        )
      ) : (
        composerSlot
      )}
    </Box>
  );

  // The message list's props are PER MODE: the virtual transcript is a pure
  // pager (no tool JSX, no confirm queue, no selector, no unseen divider,
  // no cursor); the legacy transcript builds its dedicated set; the live
  // view passes the live values.
  const messagesList = inVirtualTranscript ? (
    <Messages
      messages={displayedMessages}
      tools={mergedTools}
      commands={commands}
      verbose
      toolJSX={null}
      toolUseConfirmQueue={EMPTY_CONFIRM_QUEUE}
      inProgressToolUseIDs={viewInProgressToolUseIDs}
      isMessageSelectorVisible={false}
      conversationId={conversationId}
      screen={screen}
      streamingToolUses={NO_STREAMING_TOOL_USES}
      showAllInTranscript={showAllInTranscript}
      agentDefinitions={agentDefinitions}
      isLoading={isLoading}
      streamingThinking={null}
      hidePastReasoning
      streamingTail={focusedTail}
      streamingTextSuppressed={streamingSuppressed}
      isBriefOnly={isBriefOnly}
      scrollRef={scrollRef}
      trackStickyPrompt={fullscreen}
      jumpRef={jumpRef}
      onSearchMatchesChange={onSearchMatchesChange}
      scanElement={scanElement}
      setPositions={setPositions}
      disableRenderCap={dumpMode}
    />
  ) : inTranscript ? (
    <Messages
      messages={displayedMessages}
      tools={mergedTools}
      commands={commands}
      verbose
      toolJSX={null}
      toolUseConfirmQueue={EMPTY_CONFIRM_QUEUE}
      inProgressToolUseIDs={viewInProgressToolUseIDs}
      isMessageSelectorVisible={showMessageSelector}
      conversationId={conversationId}
      screen={screen}
      streamingToolUses={NO_STREAMING_TOOL_USES}
      showAllInTranscript={showAllInTranscript}
      agentDefinitions={agentDefinitions}
      isLoading={isLoading}
      hidePastReasoning
      streamingTail={focusedTail}
      streamingTextSuppressed={streamingSuppressed}
      isBriefOnly={isBriefOnly}
      trackStickyPrompt={fullscreen}
      disableRenderCap={dumpMode}
    />
  ) : (
    <Messages
      messages={displayedMessages}
      tools={mergedTools}
      commands={commands}
      verbose={verbose}
      toolJSX={toolJSX}
      toolUseConfirmQueue={toolUseConfirmQueue}
      inProgressToolUseIDs={viewInProgressToolUseIDs}
      isMessageSelectorVisible={showMessageSelector}
      conversationId={conversationId}
      screen={screen}
      streamingToolUses={NO_STREAMING_TOOL_USES}
      showAllInTranscript={showAllInTranscript}
      agentDefinitions={agentDefinitions}
      isLoading={isLoading}
      streamingTail={focusedTail}
      streamingTextSuppressed={streamingSuppressed}
      isBriefOnly={isBriefOnly}
      unseenDivider={unseenDivider}
      scrollRef={scrollRef}
      trackStickyPrompt={fullscreen}
      jumpRef={jumpRef}
      onSearchMatchesChange={onSearchMatchesChange}
      scanElement={scanElement}
      setPositions={setPositions}
      disableRenderCap={dumpMode}
      ownsCursor
      cursorNavRef={messageNavRef}
    />
  );

  // The scrollable body's enumerated composition: outside the virtual
  // transcript — messages → inline non-modal tool JSX → spacer → brief idle
  // line → queued-command strip (fullscreen). In the virtual transcript:
  // messages → tool overlay → sandbox-violation view.
  const briefIdleLine = !showSpinner && !isLoading && isBriefOnly ? <BriefIdleStatus /> : null;
  const transcriptBody = inVirtualTranscript ? (
    <Box flexDirection="column">
      {messagesList}
      {inlineToolJsx}
      <SandboxViolationExpandedView />
    </Box>
  ) : (
    <Box flexDirection="column">
      {entryLoadingLine !== null ? (
        <Box paddingLeft={1} marginTop={1}>
          <Text dimColor>{entryLoadingLine}</Text>
        </Box>
      ) : null}
      {messagesList}
      {inlineToolJsx}
      <Box flexGrow={1} />
      {briefIdleLine}
    </Box>
  );

  const cancelRequestProps = {
    // The interview card (the ask-user-question tool's permission card) owns
    // Escape while it is the focused dialog.
    isInterviewFocused:
      focusedInputDialog === 'tool-permission' && toolUseConfirmQueue[0]?.tool.name === ASK_USER_QUESTION_TOOL_NAME,
    // Both selectors own input: the message selector and the bashes dialog.
    isMessageSelectorVisible: showMessageSelector || showBashesDialog !== false,
    screen,
    // Vim owns Escape only when vim is actually ENABLED and in INSERT. The
    // cancel handler reads PRESENCE as vim-active (its documented contract),
    // and the vimMode state above initializes 'INSERT' unconditionally — so
    // passing it raw stood the Esc-interrupt binding down for EVERY non-vim
    // session.
    vimMode: isVimModeEnabled() ? vimMode : undefined,
    isLocalJSXCommand: toolJSX?.isLocalJSXCommand === true,
    isSearchingHistory,
    isHelpOpen: helpOpen,
    // A focused input dialog settles its own interrupt; without one the busy
    // ctrl+c press falls through to the composer's exit chord (the ruled
    // interrupt-and-arm grammar).
    isInputDialogFocused: focusedInputDialog !== undefined,
    streamMode: viewStreamMode,
    // esc and the interrupt chord reach the FOCUSED chat through its
    // connector: the session's turn is the live view's.
    focusedTurnActive: seatLive.inFlight,
  };
  const cancelHandler = <CancelRequestHandler {...cancelRequestProps} />;

  if (legacyTranscript) {
    // Deliberately unwrapped: native scrollback keeps working here.
    return (
      <KeybindingSetup>
        <AnimatedTitle enabled={terminalTitleEnabled} title={title} wantsPrefix={!tabStatusEnabled} animating={titleAnimating} />
        <GlobalKeybindingHandlers {...globalKeybindingProps} />
        <CommandKeybindingHandlers onSubmit={onSubmit} isActive={!toolJSX?.isLocalJSXCommand} />
        {cancelHandler}
        <Box flexDirection="column">
          {messagesList}
          {toolJSX?.jsx ?? null}
          <SandboxViolationExpandedView />
          <TranscriptFooter
            toggleChord={getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')}
            expandChord={getShortcutDisplay('transcript:toggleShowAll', 'Transcript', 'ctrl+e')}
            hasSearchBadge={false}
            virtualScroll={false}
            showAllSuppressed={dumpMode}
            showAll={showAllInTranscript}
            status={editorStatus}
            badge={null}
          />
        </Box>
      </KeybindingSetup>
    );
  }

  const tree = (
    <KeybindingSetup>
      <AnimatedTitle enabled={terminalTitleEnabled} title={title} wantsPrefix={!tabStatusEnabled} animating={titleAnimating} />
      <GlobalKeybindingHandlers {...globalKeybindingProps} />
      <CommandKeybindingHandlers onSubmit={onSubmit} isActive={!toolJSX?.isLocalJSXCommand} />
      <ScrollKeybindingHandler
        scrollRef={scrollRef}
        isActive={inVirtualTranscript || (fullscreen && (centredModalUp || focusedInputDialog === undefined || focusedInputDialog === 'tool-permission'))}
        // Scrolling must not stamp divider/pill state under a centred modal
        // or the permission overlay; in the virtual transcript a scroll
        // disarms the search instead.
        onScroll={inVirtualTranscript ? disarmSearchOnScroll : centredModalUp || permissionOverlay !== null ? undefined : onScroll}
        // Pager treatment while browsing the virtual transcript; keys yield
        // while the search bar is open. Never the centred-modal flag.
        isModal={inVirtualTranscript ? !searchBarOpen : false}
        modalScrollRef={modalScrollRef}
        modalUp={centredModalUp}
      />
      {fullscreen && messageCursorActive ? (
        <MessageActionsKeybindings handlers={messageActions.handlers} isActive={!messageActionsDisabled && focusedInputDialog === undefined} />
      ) : null}
      {cancelHandler}
      <SwitchboardAttributionProvider key={remountKey}>
        <FullscreenLayout
          scrollRef={scrollRef}
          statusBand={inVirtualTranscript ? undefined : workingStatusStrip}
          // The berth's WorkCapsule dresses the working strip; it tracks
          // whether the strip HAS CONTENT — `spinnerSlotReserved` IS the "a
          // working row is reserved" truth (the spinner or the hold row).
          statusBandActive={inVirtualTranscript ? undefined : spinnerSlotReserved}
          // The virtual transcript is a pure pager: no overlay, no modal, no
          // pill handlers reach the layout there.
          overlay={inVirtualTranscript ? undefined : permissionOverlay}
          modal={inVirtualTranscript ? undefined : centredModalUp ? centredModal : undefined}
          modalScrollRef={modalScrollRef}
          dividerYRef={unseen.dividerYRef}
          hidePill={inVirtualTranscript ? undefined : false}
          hideSticky={inVirtualTranscript ? undefined : false}
          newMessageCount={inVirtualTranscript ? 0 : newMessageCount}
          onPillClick={inVirtualTranscript ? undefined : onPillClick}
          scrollable={transcriptBody}
          bottom={
            <Box flexDirection="column">
              {/* The persistent frame band (session tabs + statusline): the
                  root REPL owns its mount at the top of the bottom column;
                  route surfaces compose their own copy through the
                  SurfaceRouter's 'inherit' arm. The working strip stays
                  under the banner. */}
              <MercuryFrame model={focusedEffectiveModel} />
              <CockpitBottomStatus>{workingStatusStrip}</CockpitBottomStatus>
              {/* The focused chat's one status row (the session's state +
                  "⇧← back") lives OUTSIDE the composer group: the way back
                  to the board stays on screen even while a consent card
                  holds the composer's slot. */}
              <FocusedSessionStatusRow />
              {permissionStickyFooter}
              {bottomImmediateJsx}
              {focusedBottomDialog}
              {showExitFlow ? (
                <ExitFlow
                  onDone={() => setShowExitFlow(false)}
                  onCancel={() => setShowExitFlow(false)}
                  showWorktree={getCurrentWorktreeSession() !== null}
                />
              ) : null}
              {exitCommandJsx}
              {bottomSlot}
              {messageSelector}
            </Box>
          }
        />
      </SwitchboardAttributionProvider>
    </KeybindingSetup>
  );

  // The render-reason probe (MERCURY_FLUX_PROBE only; off ⇒ one boolean
  // check, the thunk never runs): which of the root's store snapshots and
  // context reads moved this render — the region-invalidation matrix's
  // reader correlates the `why:repl-root:*` marks with `render:repl-root`
  // to name the feed that broke the root's idle rhythm. `none` means a
  // local state set or a parent re-render.
  fluxWhy('repl-root', rootWhyRef, () => ({
    focusedConnector,
    seatLive,
    focusedEffectiveModel,
    textActive,
    interruptingKey,
    isLoading,
    columns,
    rows,
    tokens,
    themeName,
    mainLoopModel,
    pendingModelSwitch,
    mcpState,
    toolPermissionContext,
    agentDefinitions,
    isBriefOnly,
    verbose,
    spinnerTip,
    prefersReducedMotion,
    sessionAsks,
    replSurfaceCovered,
    elicitationQueue,
    landing,
    armedMessage,
    sessionTitleSetting,
    warmthVersion,
    slotHasSession,
    messages,
    unseenDivider,
    newMessageCount,
    viewStreamMode,
    dumpMode,
    addNotification,
    removeNotification,
    terminal,
  }));
  if (!fullscreen) return tree;
  return <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>{tree}</AlternateScreen>;
}
