import { useEffect, useRef, useState } from 'react';
import { splitWayOut, type useNotifications } from '../../context/notifications.js';
import { useFpsMetrics } from '../../context/fpsMetrics.js';
import { useCostSummary } from '../../costHook.js';
import { useAgentsChange } from '../../hooks/useAgentsChange.js';
import { useExtensions } from '../../hooks/useExtensions.js';
import { useFinishMarks } from '../../hooks/useFinishMarks.js';
import { useSessionTitleMint } from '../../hooks/useSessionTitleMint.js';
import { useSettingsChange } from '../../hooks/useSettingsChange.js';
import { useSkillsChange } from '../../hooks/useSkillsChange.js';
import { Box, Text } from '../../ink.js';
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js';
import { hasSeatLive } from '../../services/engine-connector/seatLive.js';
import type { EngineConnectorV1 } from '../../services/engine-connector/types.js';
import { scheduleQuietUpdateNotice, UPDATE_NOTICE_KEY } from '../../services/privateChannel/quietUpdateNotice.js';
import { startBackgroundHousekeeping } from '../../utils/backgroundHousekeeping.js';
import { getCwd } from '../../utils/cwd.js';
import { logForDebugging } from '../../utils/debug.js';
import { recordBootInteractive } from '../../utils/observability/frictionStopwatch.js';
import { useKickOffCheckAndDisableSovereignIfNeeded } from '../../utils/permissions/bypassPermissionsKillswitch.js';
import type { CrashResumeStaged } from './crashResume.js';
import { RECEIPT_TIMEOUT_MS } from './limits.js';

const loadHopIntoSession = () => import('../../services/switchboard/hopIntoSession.js');
const loadEnsureDaemon = () => import('../../services/switchboard/ensureDaemon.js');
const loadContextWindowWarmup = () => import('../../utils/model/contextWindowWarmup.js');
const loadDaemonHandshake = () => import('../../daemon/handshake.js');
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

export function useChatBootStart({
  submitCount,
  addNotification,
  removeNotification,
}: {
  submitCount: number;
  addNotification: ReturnType<typeof useNotifications>['addNotification'];
  removeNotification: ReturnType<typeof useNotifications>['removeNotification'];
}) {
  useFinishMarks();
  useSessionTitleMint();
  useSettingsChange(() => {});
  useAgentsChange(getCwd());
  useSkillsChange(getCwd(), () => {});
  useKickOffCheckAndDisableSovereignIfNeeded();
  useExtensions({ enabled: true });
  useCostSummary(useFpsMetrics());

  useEffect(() => {
    recordBootInteractive();
    setTimeout(() => {
      void loadEnsureDaemon()
        .then(async m => {
          if (await m.ensureOwnedDaemon()) await m.warmSessionRunner(getCwd());
        })
        .catch(() => {});
    }, 0);
    setTimeout(() => {
      void loadContextWindowWarmup()
        .then(m => m.warmContextWindowSources())
        .catch(() => {});
    }, 0);
  }, []);

  useEffect(() => {
    const disarm = scheduleQuietUpdateNotice(text =>
      addNotification({ key: UPDATE_NOTICE_KEY, text, priority: 'high', color: 'warning', timeoutMs: Infinity }),
    );
    return disarm;
  }, []);

  useEffect(() => {
    const key = 'daemon-version';
    let alive = true;
    let unsubscribe = (): void => {};
    void loadDaemonHandshake()
      .then(hs => {
        if (!alive) return;
        const paint = (): void => {
          const line = hs.lastDaemonHandshake()?.line ?? null;
          if (line !== null) addNotification({ key, ...splitWayOut(line), priority: 'high', color: 'warning', timeoutMs: 60_000 });
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
  }, []);

  useEffect(() => {
    if (submitCount !== 1) return;
    try {
      startBackgroundHousekeeping();
    } catch (error) {
      logForDebugging(`background housekeeping failed to start: ${String(error)}`);
    }
  }, [submitCount]);
}
