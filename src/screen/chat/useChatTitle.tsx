import { useState } from 'react';
import { useClaim, usePublish } from '../effects/effects.js';
import { useOverlayOpen } from '../overlays/overlayHooks.js';
import { useInterval } from '../renderer/bindings/use-interval.js';
import { useTerminalFocus } from '../renderer/bindings/use-terminal-focus.js';
import { useTerminalTitle } from '../renderer/bindings/use-terminal-title.js';
import type { EngineConnectorV1 } from '../../engine/connector/types.js';
import { startPreventSleep, stopPreventSleep } from '../../platform/host-os/preventSleep.js';
import { useAppState } from '../app-state/AppState.js';
import type { AppStateStore } from '../app-state/AppStateStore.js';
import { asSessionId } from '../../sessions/transcripts/ids.js';
import { publishCockpitActivity, type ActivityState } from '../cockpit/cockpitActivity.js';
import { getCurrentSessionTitle } from '../../sessions/transcripts/sessionListings.js';
import type { FocusedInputDialog } from './focusedDialog.js';

const TITLE_FRAMES = ['⠂', '⠐'] as const;
const TITLE_STATIC_MARK = '✻';
const TITLE_INTERVAL_MS = 960;

export function AnimatedTitle({
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

export function useChatTitle({
  focusedInputDialog,
  focusedConnector,
  isLoading,
  store,
}: {
  focusedInputDialog: FocusedInputDialog | undefined;
  focusedConnector: EngineConnectorV1;
  isLoading: boolean;
  store: AppStateStore;
}): { title: string; titleAnimating: boolean; sessionTitleSetting: boolean | undefined } {
  const isWaitingForApproval = focusedInputDialog === 'tool-permission';
  const showingLocalDialog = focusedInputDialog !== undefined && focusedInputDialog !== 'tool-permission';
  const sessionTitleSetting = useAppState(state => (state.settings as { terminalTitle?: { sessionTitle?: boolean } }).terminalTitle?.sessionTitle);
  const sessionTitle = sessionTitleSetting === false ? undefined : getCurrentSessionTitle(asSessionId(focusedConnector.sessionId()));
  const agentTitle = store.getState().standaloneAgentContext?.name;
  const title = sessionTitle ?? agentTitle ?? 'Mercury';
  const titleAnimating = isLoading && !isWaitingForApproval && !showingLocalDialog;
  useClaim(() => {
    if (!titleAnimating) return;
    startPreventSleep();
    return () => stopPreventSleep();
  }, [titleAnimating]);
  const diffReviewOpen = useOverlayOpen('diff-dialog');
  const cockpitActivity: ActivityState = isWaitingForApproval ? 'waiting' : diffReviewOpen ? 'review' : isLoading ? 'active' : 'calm';
  usePublish(() => {
    publishCockpitActivity(cockpitActivity);
  }, [cockpitActivity]);
  return { title, titleAnimating, sessionTitleSetting };
}
