import React, { useMemo, useState } from 'react';
import { useLoad } from '../effects/effects.js';
import { execFile } from 'node:child_process';
import { subprocessEnv } from '../../platform/processes/subprocessEnv.js';
import { gitArgs } from '../../platform/git/spawnArgs.js';
import { Box, useInput } from '../themedRenderer.js';
import { createSplashCore, WORD_W } from '../../../assets/splash/splash-core.mjs';
import { getSessionId } from '../../boot/process-state/processState.js';
import { chatOnlyBoot, leaveCurrentSurface, enterConcourse, routeSurfaceRegistered, stripFacts } from '../routes/surfaceRoute.js';
import { STARTUP_MENU, bootEnvPath, evaluateExplicitApply, isLiveEnvRow, menuRowChoices, readBootDefaultsProfile, readBootDefaultsProfileStrict, bootAdmissionSnapshot, resolveEffectiveSettingsSnapshot, type BootDefaultsProfileV1, type ExplicitApplyReceipt, type MenuRow } from '../../platform/substrate/startupMenu.js';
import { flagSpellings } from '../../platform/substrate/flagRegistry.js';
import { SEATS_MENU_ROW, seatCeilingFactsAsync, type SeatCeilingFacts } from '../../daemon/switchboard-capacity/capacityCheck.js';
import { MOTION_MENU_ROW, readMotionSetting, type MotionSetting } from '../cockpit/motionSetting.js';
import { JEV_MENU_ROW, readJevSettings } from '../../models/jev/jevSetting.js';
import { BACKGROUND_LAUNCH_MENU_ROW, backgroundSessionsLaunchCrewmates } from '../../daemon/switchboard/backgroundLaunch.js';
import { daemonControlRpc } from '../../daemon/control/controlSocket.js';
import type { DaemonRequest } from '../../daemon/control/protocol.js';
import { SPAWN_SWITCH_ENV, spawnSwitchFactsOfRecord, spawnSwitchKindOfEnv, spawnSwitchOnFromValue } from '../../daemon/switchboard/spawnSwitches.js';
import { useEngineModel } from '../model-picker/useEngineModel.js';
import { branchChip } from '../theme/glyphs.js';
import { isFullscreenEnvEnabled } from '../fullscreen-layout/fullscreen.js';
import { useGreetingShimmer } from '../widgets/useGreetingShimmer.js';
import { useInteractiveList } from '../widgets/useInteractiveList.js';
import { useMercuryTokens } from '../widgets/useMercuryTokens.js';
import { useSplashCoreAccent } from '../widgets/useSplashCoreAccent.js';
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js';
import { jevBootDetailLines } from './settings/detailLines.js';
import { type WorkerApplySummary, type ApplyState, type SettingsEditor, type SettingsRow, settingsEditors, settingsMenuModel } from './settings/menuModel.js';
import { commitBackgroundLaunchOf, commitMotionOf, commitJevOf, commitSeatsOf, commitRowOf, cycleRowOf } from './settings/commits.js';
import { settingsRowLine } from './settings/rows.js';
import type { SettingsContext } from './settings/context.js';
import { armBootSettingsLayerDeepLink } from './splash/settingsLayerDeepLink.js';
import { logError } from '../../platform/logs/errorLog.js';
import { errorMessage } from '../../platform/errors/errors.js';
import { passedOver } from '../../platform/errors/passedOver.js';
import { afterMicrotask } from '../../platform/async/timers.js';
export { JEV_BOOT_DETAIL_WIDTH, jevBootDetailLines, backgroundLaunchBootDetailLines } from './settings/detailLines.js';

export function readLiveSessionCount(load: () => Promise<number>): Promise<number | null> {
  return load().catch(error => {
    logError(error);
    return null;
  });
}

export function deliverSpawnSwitchReceipt(
  sessionId: string,
  receipt: ExplicitApplyReceipt,
  kind: NonNullable<ReturnType<typeof spawnSwitchKindOfEnv>>,
  io: {
    rpc?: typeof daemonControlRpc;
    isCancelled: () => boolean;
    setApply: (updater: (prev: ApplyState) => ApplyState) => void;
  },
): Promise<void> {
  const applySettled = (settled: ExplicitApplyReceipt): void => {
    io.setApply(prev =>
      prev.phase !== 'ready'
        ? prev
        : {
            phase: 'ready',
            workers: prev.workers.map(w =>
              w.sessionId !== sessionId || !w.receipts
                ? w
                : { ...w, receipts: w.receipts.map(r => (r.env === receipt.env ? settled : r)) },
            ),
          },
    );
  };
  return (io.rpc ?? daemonControlRpc)(
    {
      op: 'sessionControl',
      action: 'set-spawn-switch',
      sessionId,
      by: 'operator',
      spawnSwitch: { kind, on: spawnSwitchOnFromValue(receipt.target) },
    } as DaemonRequest,
    { timeoutMs: 3000 },
  )
    .then(reply => {
      if (io.isCancelled()) return;
      const settledControl = reply.ok === true && (reply.op === 'sessionControl' || reply.op === 'concourseControl') ? reply : null;
      const outcome = settledControl !== null ? settledControl.outcome : 'refused';
      const detail = settledControl !== null ? settledControl.detail : reply.ok === true ? undefined : reply.error;
      applySettled({
        ...receipt,
        outcome: outcome === 'applied' || outcome === 'queued' ? outcome : outcome === 'noop' ? 'no-change' : 'refused',
        reason: typeof detail === 'string' && detail !== '' ? detail : receipt.reason,
      });
    })
    .catch(error => {
      if (io.isCancelled()) return;
      const message = error instanceof Error ? error.message : String(error);
      applySettled({
        ...receipt,
        outcome: 'refused',
        reason: message !== '' ? message : receipt.reason,
      });
    });
}


function savedChoicesByRow(profile: BootDefaultsProfileV1 | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!profile) return out;
  for (const row of STARTUP_MENU) {
    const sp = flagSpellings(row.env).find(s => profile.env[s] !== undefined);
    if (sp !== undefined && menuRowChoices(row).some(c => c.value === profile.env[sp])) out[row.env] = profile.env[sp]!;
  }
  return out;
}

function withGroupRow(rows: readonly MenuRow[], row: MenuRow): MenuRow[] {
  let after = -1;
  rows.forEach((r, i) => {
    if (r.group === row.group) after = i;
  });
  if (after < 0) return [...rows, row];
  return [...rows.slice(0, after + 1), row, ...rows.slice(after + 1)];
}

export function withJevRow(rows: readonly MenuRow[]): MenuRow[] {
  return withGroupRow(withGroupRow(rows, BACKGROUND_LAUNCH_MENU_ROW as MenuRow), JEV_MENU_ROW as MenuRow);
}

function gitTailProbe(onTail: (tail: string) => void): () => void {
  let alive = true;
  execFile('git', gitArgs(['rev-parse', '--abbrev-ref', 'HEAD']), { windowsHide: true, encoding: 'utf8', timeout: 800, env: { ...subprocessEnv() } }, (bErr, bOut) => {
    if (!alive || bErr) return;
    const branch = bOut.trim();
    if (!branch) return;
    execFile('git', gitArgs(['status', '--porcelain', '-uno']), { windowsHide: true, encoding: 'utf8', timeout: 1500, env: { ...subprocessEnv() } }, (stErr, stOut) => {
      if (!alive) return;
      const clean = stErr ? null : stOut.trim() === '';
      onTail(`  ${branchChip(branch)}` + (clean === null ? '' : clean ? ' · clean' : ' · uncommitted'));
    });
  });
  return () => {
    alive = false;
  };
}

export function BootSettingsScreen({
  onClose,
  onOpenEditor,
  fullScene,
}: {
  onClose?: () => void;
  onOpenEditor?: (editor: SettingsEditor) => void;
  fullScene?: { columns: number; rows: number };
} = {}): React.ReactNode {
  const t = useMercuryTokens();
  const { columns: termCols, rows: termRows } = useTerminalSize();
  const columns = fullScene?.columns ?? termCols;
  const rows = fullScene?.rows ?? termRows;
  const path = bootEnvPath();

  const [saveTick, setSaveTick] = useState(0);
  const [lastReceipt, setLastReceipt] = useState<string | null>(null);
  const profileRead = useMemo(() => readBootDefaultsProfileStrict(path), [path, saveTick]);
  const profile = profileRead.ok ? profileRead.profile : null;
  const profileReadError = profileRead.ok ? null : profileRead.reason;
  const saved = useMemo(() => savedChoicesByRow(profile), [profile]);
  const snapshot = useMemo(
    () => bootAdmissionSnapshot() ?? resolveEffectiveSettingsSnapshot({ sessionId: getSessionId(), path }),
    [path, saveTick],
  );
  const effectiveByEnv = useMemo(
    () => new Map(snapshot.rows.map(r => [r.env, r])),
    [snapshot],
  );
  const [seatsTick, setSeatsTick] = useState(0);
  const [seatFacts, setSeatFacts] = useState<SeatCeilingFacts | null>(null);
  useLoad(signal => {
    void seatCeilingFactsAsync().then(facts => { if (!signal.aborted) setSeatFacts(facts); });
  }, [seatsTick, saveTick]);
  const [motionTick, setMotionTick] = useState(0);
  const motionSetting = useMemo(() => readMotionSetting(), [motionTick, saveTick]);
  const [jevTick, setJevTick] = useState(0);
  const jevSettings = useMemo(() => readJevSettings(), [jevTick, saveTick]);
  const jevDetailLines = useMemo(() => jevBootDetailLines(), [jevTick, saveTick]);
  const [backgroundLaunchTick, setBackgroundLaunchTick] = useState(0);
  const backgroundLaunchOn = useMemo(() => backgroundSessionsLaunchCrewmates(), [backgroundLaunchTick, saveTick]);
  const hasEditors = onOpenEditor !== undefined;
  const menuRows = useMemo<readonly SettingsRow[]>(() => [...(hasEditors ? settingsEditors : []), ...withJevRow(STARTUP_MENU), SEATS_MENU_ROW as MenuRow, MOTION_MENU_ROW as MenuRow], [hasEditors]);
  const isSeatsRow = (row: MenuRow): boolean => row.env === SEATS_MENU_ROW.env;
  const isMotionRow = (row: MenuRow): boolean => row.env === MOTION_MENU_ROW.env;
  const isJevRow = (row: MenuRow): boolean => row.env === JEV_MENU_ROW.env;
  const isBackgroundLaunchRow = (row: MenuRow): boolean => row.env === BACKGROUND_LAUNCH_MENU_ROW.env;
  const commitBackgroundLaunch = (next: boolean): string => commitBackgroundLaunchOf(ctx, next);
  const commitMotion = (next: MotionSetting): string => commitMotionOf(ctx, next);
  const commitJev = (next: boolean): string => commitJevOf(ctx, next);
  const commitSeats = (next: number | null): string => commitSeatsOf(ctx, next);

  const [liveCount, setLiveCount] = useState<number | null>(null);
  const [apply, setApply] = useState<ApplyState>({ phase: 'closed' });
  useLoad(signal => {
    void readLiveSessionCount(() => import('../../daemon/concourse-workers/concourseWorkers.js').then(sup => sup.countLiveConcourseWorkers())).then(count => {
      if (!signal.aborted) setLiveCount(count);
    });
  }, [saveTick]);
  useLoad(signal => {
    if (apply.phase !== 'loading') return;
    void import('../../daemon/concourse-workers/concourseWorkers.js')
      .then(sup => {
        if (signal.aborted) return;
        const currentProfile = readBootDefaultsProfile(path);
        const savedAtMs = currentProfile?.savedAt ? Date.parse(currentProfile.savedAt) : NaN;
        const workers = sup
          .listConcourseWorkers(null)
          .map((rec): WorkerApplySummary => {
            const turnRanSinceSave =
              Number.isFinite(savedAtMs) && rec.lastDeliveryAt !== undefined && rec.lastDeliveryAt >= savedAtMs;
            const liveEnvValues = turnRanSinceSave
              ? Object.fromEntries(
                  STARTUP_MENU.filter(isLiveEnvRow).map(r => {
                    const sp = currentProfile ? flagSpellings(r.env).find(s => currentProfile.env[s] !== undefined) : undefined;
                    return [r.env, sp !== undefined ? (currentProfile!.env[sp] ?? null) : null];
                  }),
                )
              : {};
            const live = spawnSwitchFactsOfRecord(rec);
            const liveValues = {
              ...liveEnvValues,
              [SPAWN_SWITCH_ENV.subagents]: live.subagents.on ? null : '0',
            };
            return {
              runnerId: rec.runnerId,
              sessionId: rec.sessionId,
              snapshotRevision: rec.settingsSnapshot?.profileRevision ?? null,
              receipts: rec.settingsSnapshot
                ? evaluateExplicitApply(rec.settingsSnapshot, currentProfile, liveValues)
                : null,
            };
          });
        setApply({ phase: 'ready', workers });
        for (const worker of workers) {
          for (const receipt of worker.receipts ?? []) {
            const kind = spawnSwitchKindOfEnv(receipt.env);
            if (receipt.outcome !== 'queued' || kind === null) continue;
            void deliverSpawnSwitchReceipt(worker.sessionId, receipt, kind, {
              isCancelled: () => signal.aborted,
              setApply,
            });
          }
        }
      })
      .catch(error => {
        passedOver(error);
        if (!signal.aborted) setApply({ phase: 'ready', workers: [], error: errorMessage(error) });
      });
  }, [apply.phase === 'closed', path]);

  const commitRow = (row: MenuRow, value: string | null): string => commitRowOf(ctx, row, value);

  const cycleRow = (row: MenuRow, direction: 1 | -1): string => cycleRowOf(ctx, row, direction);
  const ctx: SettingsContext = { setBackgroundLaunchTick, setLastReceipt, setMotionTick, setJevTick, setSeatFacts, setSeatsTick, commitBackgroundLaunch, commitJev, commitMotion, commitSeats, isBackgroundLaunchRow, isJevRow, isMotionRow, isSeatsRow, liveCount, path, saved, setSaveTick, backgroundLaunchOn, commitRow, jevSettings, motionSetting, seatFacts };

  const concourseLive = routeSurfaceRegistered('concourse') && isFullscreenEnvEnabled();
  const plainWorld = chatOnlyBoot();
  const chatBoot = stripFacts().chatBoot;

  const activate = (row: SettingsRow | null) => {
    if (row === null) return null;
    if ('editor' in row) {
      onOpenEditor?.(row.editor);
      return null;
    }
    return { pending: 'saving…', result: afterMicrotask(() => cycleRow(row, 1)) };
  };
  const list = useInteractiveList<SettingsRow>({
    rows: menuRows,
    rowId: r => 'editor' in r ? r.editor : r.env,
    idNamespace: 'boot-settings',
    onClose: () => {
      if (apply.phase !== 'closed') {
        setApply({ phase: 'closed' });
        return;
      }
      if (onClose) onClose();
      else leaveCurrentSurface();
    },
    actions: [
      {
        key: 'return',
        hint: 'cycle',
        run: activate,
      },
      ...(concourseLive && !chatBoot
        ? [{
            key: 'o',
            hint: plainWorld ? 'open the live view' : 'open concourse',
            run: (): null => {
              armBootSettingsLayerDeepLink();
              enterConcourse();
              return null;
            },
          }]
        : []),
      {
        key: 'backspace',
        hint: 'default',
        run: row => (row && !('editor' in row) ? { pending: 'saving…', result: afterMicrotask(() => commitRow(row, null)) } : null),
      },
      {
        key: 'a',
        hint: 'apply receipts',
        run: () => {
          setApply(prev => (prev.phase === 'closed' ? { phase: 'loading' } : { phase: 'closed' }));
          return null;
        },
      },
      {
        key: ' ',
        hint: 'cycle',
        run: activate,
      },
    ],
  });

  const selectedRow = list.selectedRow;
  useInput(
    (_input, key, event) => {
      if (apply.phase !== 'closed') return;
      if (!key.leftArrow && !key.rightArrow) return;
      if (selectedRow == null || 'editor' in selectedRow) return;
      event.stopImmediatePropagation();
      void afterMicrotask(() => cycleRow(selectedRow, key.leftArrow ? -1 : 1));
    },
    { isActive: true },
  );

  const { accent: coreAccent, rampStops } = useSplashCoreAccent();
  const core = useMemo(
    () => createSplashCore({ nocolor: false, truecolor: true, accent: coreAccent }),
    [coreAccent],
  );
  const wordGlow = useGreetingShimmer(rampStops, WORD_W);
  const mainModel = useEngineModel();
  const [dirTail, setDirTail] = useState('');
  useLoad(() => gitTailProbe(setDirTail), []);

  const changed = useMemo(() => STARTUP_MENU.filter(r => saved[r.env] !== undefined).length, [saved]);
  const menuM = useMemo(() => {
    return settingsMenuModel({ apply, backgroundLaunchOn, changed, chatBoot, concourseLive, dirTail, effectiveByEnv, isBackgroundLaunchRow, isJevRow, isMotionRow, isSeatsRow, jevDetailLines, jevSettings, lastReceipt, list, liveCount, mainModel, menuRows, motionSetting, plainWorld, profile, profileReadError, saved, seatFacts, wordGlow });
  }, [saved, effectiveByEnv, seatFacts, motionSetting, jevSettings, jevDetailLines, backgroundLaunchOn, list.selectedIndex, list.note, lastReceipt, changed, liveCount, apply, mainModel, dirTail, profile, profileReadError, concourseLive, plainWorld, chatBoot, wordGlow?.peakCell, wordGlow?.gainLevel]);

  const composition = useMemo(() => {
    const menu = core.composeBootMenu(columns, rows, menuM) as {
      lines: string[];
      entryLines: Array<{ entry: number; line: number }>;
    };
    const { placed, top } = core.placeBlock(menu.lines, rows) as { placed: string[]; top: number };
    return {
      placed,
      entryAt: new Map<number, number>(menu.entryLines.map(e => [e.line + top, e.entry])),
    };
  }, [core, columns, rows, menuM]);

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {Array.from({ length: rows }, (_, i) => {
        return settingsRowLine({ composition, list, menuRows, t }, i);
      })}
    </Box>
  );
}
