import { basename as nodePathBasename } from 'node:path';
import { useRef, useState } from 'react';
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js';
import { splitWayOut, type useNotifications } from '../../context/notifications.js';
import { useFpsMetrics } from '../../context/fpsMetrics.js';
import { useCostSummary } from '../../costHook.js';
import { useClaim, useLoad, useMount, usePublish, useTimer } from '../../hooks/effects.js';
import { useDeprecationWarningNotification } from '../../hooks/notifs/useDeprecationWarningNotification.js';
import { useLspInitializationNotification } from '../../hooks/notifs/useLspInitializationNotification.js';
import { useRateLimitWarningNotification } from '../../hooks/notifs/useRateLimitWarningNotification.js';
import { useSettingsErrors } from '../../hooks/notifs/useSettingsErrors.js';
import { useAgentsChange } from '../../hooks/useAgentsChange.js';
import type { useApiKeyVerification } from '../../hooks/useApiKeyVerification.js';
import type { useEngineModel } from '../../hooks/useEngineModel.js';
import { useExtensions } from '../../hooks/useExtensions.js';
import { useFinishMarks } from '../../hooks/useFinishMarks.js';
import { useSessionTitleMint } from '../../hooks/useSessionTitleMint.js';
import { useSettingsChange } from '../../hooks/useSettingsChange.js';
import { useSkillsChange } from '../../hooks/useSkillsChange.js';
import { Box, Text } from '../../ink.js';
import { conversationIdHere, getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js';
import { hasSeatLive } from '../../services/engine-connector/seatLive.js';
import type { EngineConnectorV1 } from '../../services/engine-connector/types.js';
import { scheduleQuietUpdateNotice, UPDATE_NOTICE_KEY } from '../../services/privateChannel/quietUpdateNotice.js';
import { takeResumeFoldNotice } from '../../services/run/runCoordinator.js';
import { startBackgroundHousekeeping } from '../../services/backgroundHousekeeping.js';
import { crashReportDirDisplay, markCrashReportsNoticed, resolveCrashTranscript, unnoticedCrashReports } from '../../utils/crashReport.js';
import { getCwd } from '../../utils/cwd.js';
import { logForDebugging } from '../../utils/debug.js';
import { maybeGetTmuxMouseHint } from '../../utils/fullscreen.js';
import { mercuryBootPreflightEnabled, runAndRecordPreflight } from '../../services/health/healthPreflight.js';
import { recordBootInteractive } from '../../utils/observability/frictionStopwatch.js';
import { useKickOffCheckAndDisableSovereignIfNeeded } from '../../utils/permissions/bypassPermissionsKillswitch.js';
import { clearedSessionAt } from '../../utils/sessionStorage/clearedSessions.js';
import { subscribeTranscriptLoadDegradation, transcriptLoadDegradation } from '../../utils/sessionStorage/loading.js';
import { subscribeTranscriptStoreHealth, transcriptStoreHealth } from '../../utils/sessionStorage/writer.js';
import { getProjectDir } from '../../utils/sessionStoragePortable.js';
import { windowsShellRoadNotice } from '../../utils/shell/windowsShellRoad.js';
import { getCurrentWorktreeSession } from '../../services/worktree.js';
import type { CrashResumeStaged } from './crashResume.js';
import type { FocusedInputDialog } from './focusedDialog.js';
import { RECEIPT_TIMEOUT_MS } from './limits.js';
import { passedOver } from '../../utils/passedOver.js';
import { startTimeout, stopTimeout } from '../../utils/timers.js';

const loadHopIntoSession = () => import('../../services/switchboard/hopIntoSession.js');
const loadEnsureDaemon = () => import('../../services/switchboard/ensureDaemon.js');
const loadContextWindowWarmup = () => import('../../services/context/contextWindowWarmup.js');
const loadDaemonHandshake = () => import('../../daemon/handshake.js');
const loadProjectSnapshot = () => import('../../services/projectIntel/snapshot.js');

const WORKTREE_TIP_SECONDS = 15;
const BOOT_WARMUP_MS = 150;

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
  useClaim(() => {
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
  useClaim(() => {
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

  useTimer(() => {
    recordBootInteractive();
    startTimeout(() => {
      void loadEnsureDaemon()
        .then(async m => {
          if (await m.ensureOwnedDaemon()) await m.warmSessionRunner(getCwd());
        })
        .catch(passedOver);
    }, 0);
    startTimeout(() => {
      void loadContextWindowWarmup()
        .then(m => m.warmContextWindowSources())
        .catch(passedOver);
    }, 0);
  }, []);

  useClaim(() => {
    const disarm = scheduleQuietUpdateNotice(text =>
      addNotification({ key: UPDATE_NOTICE_KEY, text, priority: 'high', color: 'warning', timeoutMs: Infinity }),
    );
    return disarm;
  }, []);

  useLoad(signal => {
    const key = 'daemon-version';
    let unsubscribe = (): void => {};
    void loadDaemonHandshake()
      .then(hs => {
        if (signal.aborted) return;
        const paint = (): void => {
          const line = hs.lastDaemonHandshake()?.line ?? null;
          if (line !== null) addNotification({ key, ...splitWayOut(line), priority: 'high', color: 'warning', timeoutMs: 60_000 });
          else removeNotification(key);
        };
        paint();
        unsubscribe = hs.subscribeDaemonHandshake(paint);
      })
      .catch(passedOver);
    return () => {
      unsubscribe();
    };
  }, []);

  usePublish(() => {
    if (submitCount !== 1) return;
    try {
      startBackgroundHousekeeping();
    } catch (error) {
      logForDebugging(`background housekeeping failed to start: ${String(error)}`);
    }
  }, [submitCount]);
}

export function useChatBootNotices({
  focusedConnector,
  addNotification,
  removeNotification,
  focusedInputDialog,
  setCrashResumeStaged,
  crashNoticeLatchedRef,
  apiKeyVerification,
  engineModel,
}: {
  focusedConnector: EngineConnectorV1;
  addNotification: ReturnType<typeof useNotifications>['addNotification'];
  removeNotification: ReturnType<typeof useNotifications>['removeNotification'];
  focusedInputDialog: FocusedInputDialog | undefined;
  setCrashResumeStaged: (staged: CrashResumeStaged | null) => void;
  crashNoticeLatchedRef: { current: boolean };
  apiKeyVerification: ReturnType<typeof useApiKeyVerification>;
  engineModel: ReturnType<typeof useEngineModel>;
}) {
  useClaim(() => {
    const hosted = hasSeatLive(focusedConnector) && focusedConnector.transcriptStoreFailing !== undefined ? focusedConnector : null;
    const paint = (): void => {
      const health = transcriptStoreHealth();
      const sentence = health.failing ? health.sentence : (hosted?.transcriptStoreFailing?.() ?? undefined);
      if (sentence !== undefined) {
        addNotification({
          key: 'transcript-store',
          text: sentence || 'the session transcript store is failing to write',
          priority: 'high',
          timeoutMs: 3_600_000,
        });
      } else {
        removeNotification('transcript-store');
      }
    };
    paint();
    const offStore = subscribeTranscriptStoreHealth(paint);
    const offFacts = hosted?.subscribeModel(paint);
    return () => {
      offStore();
      offFacts?.();
    };
  }, [focusedConnector]);

  useClaim(() => {
    const paintDegradation = (): void => {
      try {
        const fact = transcriptLoadDegradation(getFocusedSessionConnector().transcriptFile?.());
        if (!fact) {
          removeNotification('transcript-degraded');
          return;
        }
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
      } catch (error) {
        passedOver(error)
      }
    };
    paintDegradation();
    return subscribeTranscriptLoadDegradation(paintDegradation);
  }, [focusedConnector]);

  useLoad(() => {
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
      .catch(passedOver);
  }, []);

  useMount(() => {
    const notice = windowsShellRoadNotice();
    if (notice === null) return;
    addNotification({
      key: 'shell-road',
      text: `${notice} · /health`,
      priority: 'high',
      timeoutMs: 60_000,
    });
  });

  useMount(() => {
    try {
      const unnoticed = unnoticedCrashReports();
      const newest = unnoticed[0];
      if (!newest) return;
      const more = unnoticed.length - 1;
      const identityBits = [
        newest.sessionId !== null ? `session ${newest.sessionId.slice(0, 8)}` : null,
        newest.cwd !== null ? `in ${nodePathBasename(newest.cwd) || newest.cwd}` : null,
      ].filter((bit): bit is string => bit !== null);
      let resolved: ReturnType<typeof resolveCrashTranscript> = null;
      try {
        resolved = resolveCrashTranscript(newest, {
          projectDirOf: getProjectDir,
          currentCwd: getCwd(),
          excludeSessionIds: [String(getSessionId())],
          clearedAt: clearedSessionAt,
          notAfterMs: Date.now() - process.uptime() * 1000,
        });
      } catch (error) {
        passedOver(error)
      }
      const backInside = resolved !== null && resolved.sessionId === conversationIdHere();
      if (resolved !== null && !backInside) {
        setCrashResumeStaged({
          origin: newest.origin,
          component: newest.component,
          message: newest.message,
          sessionId: resolved.sessionId,
          cwd: newest.cwd,
          transcriptPath: resolved.transcriptPath,
          moreCount: more,
        });
        return;
      }
      const wayBack = backInside ? ' — this is that session, back in' : ' — its transcript is gone, so no re-entry is offered';
      addNotification({
        key: 'crash-reports',
        text: `a previous session crashed (${newest.origin}${newest.component ? ` in ${newest.component}` : ''} — ${newest.message.slice(0, 80)})${identityBits.length > 0 ? ` · ${identityBits.join(' ')}` : ''}${wayBack}${more > 0 ? ` +${more} more` : ''} · reports in ${crashReportDirDisplay()}`,
        priority: 'high',
        timeoutMs: 60_000,
      });
      if (!crashNoticeLatchedRef.current) {
        crashNoticeLatchedRef.current = true;
        markCrashReportsNoticed();
      }
    } catch (error) {
      passedOver(error)
    }
  });

  usePublish(() => {
    if (focusedInputDialog === 'crash-resume' && !crashNoticeLatchedRef.current) {
      crashNoticeLatchedRef.current = true;
      try {
        markCrashReportsNoticed();
      } catch (error) {
        passedOver(error)
      }
    }
  }, [focusedInputDialog]);

  useMount(() => {
    try {
      const notice = takeResumeFoldNotice();
      if (!notice) return;
      if (notice.interruptedTools > 0) {
        addNotification({
          key: 'resume-run-fold',
          text: `${notice.interruptedTools} tool call(s) interrupted — /run for details`,
          priority: 'high',
          timeoutMs: 60_000,
        });
      }
      if (notice.blocker) {
        addNotification({
          key: 'resume-run-blocker',
          text: `${notice.blocker.description} — ${notice.blocker.resumeCondition}`,
          priority: 'high',
          timeoutMs: 60_000,
        });
      }
    } catch (error) {
      passedOver(error)
    }
  });

  useLoad(() => {
    void apiKeyVerification.reverify({ probe: false }).catch(passedOver);
  }, []);

  useTimer(() => {
    const timer = startTimeout(() => {
      void loadProjectSnapshot()
        .then(m => m.getProjectSnapshotAsync(getOriginalCwd(), { maxStaleMs: 120_000 }))
        .catch(passedOver);
    }, BOOT_WARMUP_MS);
    return () => stopTimeout(timer);
  }, []);

  useSettingsErrors();
  useRateLimitWarningNotification(engineModel);
  useDeprecationWarningNotification(engineModel);
  useLspInitializationNotification();
}

export function useChatBootTips({
  fullscreen,
  addNotification,
}: {
  fullscreen: boolean;
  addNotification: ReturnType<typeof useNotifications>['addNotification'];
}) {
  const worktreeTipShownRef = useRef(false);
  useMount(() => {
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
  });

  useLoad(() => {
    if (!fullscreen) return;
    void maybeGetTmuxMouseHint().then(hint => {
      if (hint) addNotification({ key: 'tmux-mouse-hint', text: hint, priority: 'low', timeoutMs: RECEIPT_TIMEOUT_MS });
    }).catch(passedOver);
  }, []);
}
