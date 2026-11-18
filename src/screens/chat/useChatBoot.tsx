import { useEffect, useRef, useState } from 'react';
import type { useNotifications } from '../../context/notifications.js';
import { Box, Text } from '../../ink.js';
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js';
import { hasSeatLive } from '../../services/engine-connector/seatLive.js';
import type { EngineConnectorV1 } from '../../services/engine-connector/types.js';
import type { CrashResumeStaged } from './crashResume.js';
import { RECEIPT_TIMEOUT_MS } from './limits.js';

const loadHopIntoSession = () => import('../../services/switchboard/hopIntoSession.js');
export const loadEnsureDaemon = () => import('../../services/switchboard/ensureDaemon.js');
export const loadContextWindowWarmup = () => import('../../utils/model/contextWindowWarmup.js');
export const loadDaemonHandshake = () => import('../../daemon/handshake.js');
export const loadProjectSnapshot = () => import('../../services/projectIntel/snapshot.js');

export function useChatCrashResume() {
  const [crashResumeStaged, setCrashResumeStaged] = useState<CrashResumeStaged | null>(null);
  const crashNoticeLatchedRef = useRef(false);
  return { crashResumeStaged, setCrashResumeStaged, crashNoticeLatchedRef };
}

export function useChatBootLines({
  focusedConnector,
  addNotification,
}: {
  focusedConnector: EngineConnectorV1;
  addNotification: ReturnType<typeof useNotifications>['addNotification'];
}) {
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
      void loadHopIntoSession().then(({ composeNoRunnerLine }) => {
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

  const lostLinePaintedAtRef = useRef(0);
  useEffect(() => {
    if (!hasSeatLive(focusedConnector) || focusedConnector.lostLine === undefined) return undefined;
    const readLostLine = focusedConnector.lostLine.bind(focusedConnector);
    const paintLostLine = (): void => {
      const lost = readLostLine();
      if (lost === null || lost.atMs <= lostLinePaintedAtRef.current) return;
      lostLinePaintedAtRef.current = lost.atMs;
      addNotification({ key: 'lost-line', text: lost.text, priority: 'high', color: 'error' as const, timeoutMs: RECEIPT_TIMEOUT_MS * 2 });
    };
    paintLostLine();
    return focusedConnector.subscribeLive(paintLostLine);
  }, [focusedConnector, addNotification]);
}
