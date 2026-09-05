import React, { useEffect, useMemo, useState } from 'react';
import { basename } from 'node:path';
import { execFile } from 'node:child_process';
import { subprocessEnv } from '../utils/subprocessEnv.js'
import { Box, useInput } from '../ink.js';
import { createSplashCore, WORD_W } from '../../assets/splash/splash-core.mjs';
import { getSessionId } from '../bootstrap/state.js';
import { chatOnlyBoot, leaveCurrentSurface, enterConcourse, routeSurfaceRegistered, stripFacts } from '../context/surfaceRoute.js';
import { armBootSettingsLayerDeepLink } from './BootSplashScreen.js';
import {
  STARTUP_MENU,
  bootEnvPath,
  evaluateExplicitApply,
  menuRowChoices,
  readBootDefaultsProfile,
  bootAdmissionSnapshot,
  resolveEffectiveSettingsSnapshot,
  saveBootDefaultsProfile,
  type BootDefaultsProfileV1,
  type ExplicitApplyReceipt,
  type MenuRow,
} from '../substrate/startupMenu.js';
import { flagSpellings } from '../substrate/flagRegistry.js';
import {
  SEATS_MENU_ROW,
  seatCeilingDetailLines,
  seatCeilingFacts,
  seatCeilingValueWords,
  seatCostWarning,
  seatSourceWords,
  setOperatorSeats,
} from '../services/switchboard/capacityCheck.js';
import { daemonControlRpc } from '../daemon/controlSocket.js';
import type { DaemonRequest } from '../daemon/protocol.js';
import { getFocusedSessionConnector, hasFocusedSession } from '../services/engine-connector/focusedConnector.js';
import {
  SPAWN_SWITCH_ENV,
  spawnSwitchFactsOfRecord,
  spawnSwitchKindOfEnv,
  spawnSwitchOnFromValue,
} from '../services/switchboard/spawnSwitches.js';
import { useMainLoopModel } from '../hooks/useMainLoopModel.js';
import { renderModelChip } from '../utils/model/model.js';
import { getSessionAccent, getSessionCritterKey } from './mercury-ui/sessionAccent.js';
import { GLYPH } from './mercury-ui/glyphs.js';
import { InteractiveRow } from './mercury-ui/InteractiveRow.js';
import { renderSceneLine } from './mercury-ui/SceneCanvas.js';
import { isFullscreenEnvEnabled, isHelmHomeEnabled } from '../utils/fullscreen.js';
import { consoleEnabled } from '../utils/cockpit/helmConsole.js';
import { useGreetingShimmer } from './mercury-ui/useGreetingShimmer.js';
import { useInteractiveList } from './mercury-ui/useInteractiveList.js';
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js';
import { useSplashCoreAccent } from './mercury-ui/useSplashCoreAccent.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';


function savedChoicesByRow(profile: BootDefaultsProfileV1 | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!profile) return out;
  for (const row of STARTUP_MENU) {
    const sp = flagSpellings(row.env).find(s => profile.env[s] !== undefined);
    if (sp !== undefined) out[row.env] = profile.env[sp]!;
  }
  return out;
}

function choiceLabel(row: MenuRow, saved: string | undefined): string {
  const value = saved ?? null;
  return menuRowChoices(row).find(c => c.value === value)?.label ?? JSON.stringify(saved);
}

interface WorkerApplySummary {
  runnerId: string;
  sessionId: string;
  snapshotRevision: number | null;
  receipts: ExplicitApplyReceipt[] | null;
}

type ApplyState = { phase: 'closed' } | { phase: 'loading' } | { phase: 'ready'; workers: WorkerApplySummary[] };

function gitTailProbe(onTail: (tail: string) => void): () => void {
  let alive = true;
  execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { windowsHide: true, encoding: 'utf8', timeout: 800, env: { ...subprocessEnv() } }, (bErr, bOut) => {
    if (!alive || bErr) return;
    const branch = bOut.trim();
    if (!branch) return;
    execFile('git', ['status', '--porcelain', '-uno'], { windowsHide: true, encoding: 'utf8', timeout: 1500, env: { ...subprocessEnv() } }, (stErr, stOut) => {
      if (!alive) return;
      const clean = stErr ? null : stOut.trim() === '';
      onTail(`  ${GLYPH.branch}${branch}` + (clean === null ? '' : clean ? ' · clean' : ' · uncommitted'));
    });
  });
  return () => {
    alive = false;
  };
}

export function BootSettingsScreen({
  onClose,
  fullScene,
}: {
  onClose?: () => void;
  fullScene?: { columns: number; rows: number };
} = {}): React.ReactNode {
  const t = useMercuryTokens();
  const { columns: termCols, rows: termRows } = useTerminalSize();
  const columns = fullScene?.columns ?? termCols;
  const rows = fullScene?.rows ?? termRows;
  const path = bootEnvPath();

  const [saveTick, setSaveTick] = useState(0);
  const [lastReceipt, setLastReceipt] = useState<string | null>(null);
  const profile = useMemo(() => readBootDefaultsProfile(path), [path, saveTick]);
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
  const seatFacts = useMemo(() => seatCeilingFacts(), [seatsTick, saveTick]);
  const menuRows = useMemo<readonly MenuRow[]>(() => [...STARTUP_MENU, SEATS_MENU_ROW as MenuRow], []);
  const isSeatsRow = (row: MenuRow): boolean => row.env === SEATS_MENU_ROW.env;
  const commitSeats = (next: number | null): string => {
    const facts = setOperatorSeats(next);
    setSeatsTick(n => n + 1);
    const warning = seatCostWarning(facts);
    const words =
      next === null
        ? `seats follow ${seatSourceWords(facts.source)}: ${facts.seats} — applies to the next admission`
        : `seats ${facts.seats} · set by you — applies to the next admission${warning !== null ? ` · ${warning}` : ''}`;
    setLastReceipt(words);
    return words;
  };

  const [liveCount, setLiveCount] = useState<number | null>(null);
  const [apply, setApply] = useState<ApplyState>({ phase: 'closed' });
  useEffect(() => {
    let cancelled = false;
    void import('../daemon/concourseSupervisor.js')
      .then(sup => {
        if (!cancelled) setLiveCount(sup.countLiveConcourseWorkers());
      })
      .catch(() => {
        if (!cancelled) setLiveCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [saveTick]);
  useEffect(() => {
    if (apply.phase !== 'loading') return;
    let cancelled = false;
    void import('../daemon/concourseSupervisor.js')
      .then(sup => {
        if (cancelled) return;
        const currentProfile = readBootDefaultsProfile(path);
        const workers = sup
          .listConcourseWorkers(null)
          .map((rec): WorkerApplySummary => {
            const live = spawnSwitchFactsOfRecord(rec);
            const liveValues = {
              [SPAWN_SWITCH_ENV.subagents]: live.subagents.on ? null : '0',
              [SPAWN_SWITCH_ENV.workflows]: live.workflows.on ? null : '0',
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
            void daemonControlRpc(
              {
                op: 'sessionControl',
                action: 'set-spawn-switch',
                sessionId: worker.sessionId,
                by: 'operator',
                spawnSwitch: { kind, on: spawnSwitchOnFromValue(receipt.target) },
              } as DaemonRequest,
              { timeoutMs: 3000 },
            )
              .then(reply => {
                if (cancelled) return;
                const settledControl = reply.ok === true && (reply.op === 'sessionControl' || reply.op === 'concourseControl') ? reply : null;
                const outcome = settledControl !== null ? settledControl.outcome : 'refused';
                const detail = settledControl !== null ? settledControl.detail : reply.ok === true ? undefined : reply.error;
                const settled: ExplicitApplyReceipt = {
                  ...receipt,
                  outcome: outcome === 'applied' || outcome === 'queued' ? outcome : outcome === 'noop' ? 'no-change' : 'refused',
                  reason: typeof detail === 'string' && detail !== '' ? detail : receipt.reason,
                };
                setApply(prev =>
                  prev.phase !== 'ready'
                    ? prev
                    : {
                        phase: 'ready',
                        workers: prev.workers.map(w =>
                          w.sessionId !== worker.sessionId || !w.receipts
                            ? w
                            : { ...w, receipts: w.receipts.map(r => (r.env === receipt.env ? settled : r)) },
                        ),
                      },
                );
              })
              .catch(() => {
              });
          }
        }
      })
      .catch(() => {
        if (!cancelled) setApply({ phase: 'ready', workers: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [apply.phase, path]);

  const commitRow = (row: MenuRow, value: string | null): string => {
    if (isSeatsRow(row)) return commitSeats(value === null ? null : Number(value));
    const env: Record<string, string> = { ...saved };
    if (value === null) delete env[row.env];
    else env[row.env] = value;
    const res = saveBootDefaultsProfile(env, path, {
      ...(liveCount !== null ? { existingSessionsUnchanged: liveCount } : {}),
    });
    if (!res.ok) return `save refused — ${res.reason}`;
    setSaveTick(n => n + 1);
    setLastReceipt(`r${res.revision} · ${res.receipt}`);
    const kind = spawnSwitchKindOfEnv(row.env);
    if (row.applicationClass === 'live' && kind !== null && hasFocusedSession()) {
      void getFocusedSessionConnector()
        .setSpawnSwitch(kind, spawnSwitchOnFromValue(value))
        .then(receipt => setLastReceipt(`r${res.revision} · saved for new sessions · this session: ${receipt.detail ?? receipt.outcome}`));
    }
    return `r${res.revision} · ${res.receipt}`;
  };

  const cycleRow = (row: MenuRow, direction: 1 | -1): string => {
    if (isSeatsRow(row)) return commitSeats(direction > 0 ? seatFacts.seats + 1 : Math.max(1, seatFacts.seats - 1));
    const choices = menuRowChoices(row);
    const currentValue = saved[row.env] ?? null;
    const idx = Math.max(0, choices.findIndex(c => c.value === currentValue));
    const next = choices[(idx + direction + choices.length) % choices.length]!;
    return commitRow(row, next.value);
  };

  const concourseLive = routeSurfaceRegistered('concourse') && isFullscreenEnvEnabled();
  const plainWorld = chatOnlyBoot();
  const chatBoot = stripFacts().chatBoot;

  const list = useInteractiveList<MenuRow>({
    rows: menuRows,
    rowId: r => r.env,
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
        run: row => (row ? { pending: 'saving…', result: Promise.resolve().then(() => cycleRow(row, 1)) } : null),
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
        run: row => (row ? { pending: 'saving…', result: Promise.resolve().then(() => commitRow(row, null)) } : null),
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
        run: row => (row ? { pending: 'saving…', result: Promise.resolve().then(() => cycleRow(row, 1)) } : null),
      },
    ],
  });

  const selectedRow = list.selectedRow;
  useInput(
    (_input, key, event) => {
      if (apply.phase !== 'closed') return;
      if (!key.leftArrow && !key.rightArrow) return;
      if (selectedRow == null) return;
      event.stopImmediatePropagation();
      void Promise.resolve().then(() => cycleRow(selectedRow, key.leftArrow ? -1 : 1));
    },
    { isActive: true },
  );

  const { accent: coreAccent, rampStops } = useSplashCoreAccent();
  const core = useMemo(
    () => createSplashCore({ nocolor: false, truecolor: true, accent: coreAccent }),
    [coreAccent],
  );
  const wordGlow = useGreetingShimmer(rampStops, WORD_W);
  const mainModel = useMainLoopModel();
  const [dirTail, setDirTail] = useState('');
  useEffect(() => gitTailProbe(setDirTail), []);

  const changed = useMemo(() => STARTUP_MENU.filter(r => saved[r.env] !== undefined).length, [saved]);
  const menuM = useMemo(() => {
    const entries = menuRows.map(row => {
      if (isSeatsRow(row)) {
        return {
          label: row.label,
          group: row.group,
          summary: row.summary,
          valueLabel: seatCeilingValueWords(seatFacts),
          valueIsDefault: seatFacts.source !== 'operator',
          pinnedVal: null,
          detail: row.detail ?? null,
          detailExtra: seatCeilingDetailLines(seatFacts),
        };
      }
      const effective = effectiveByEnv.get(row.env);
      const envPinned = effective?.source === 'process-env';
      return {
        label: row.label,
        group: row.group,
        summary: row.summary,
        valueLabel: choiceLabel(row, saved[row.env]),
        valueIsDefault: saved[row.env] === undefined,
        pinnedVal: envPinned ? (effective?.value ?? '') : null,
        detail: row.detail ?? null,
        detailExtra: [
          `this session  ${effective ? (effective.value ?? 'default') : 'default'} (${effective?.source ?? 'default'})`,
        ],
      };
    });
    const savedVal = (env: string): string | null => saved[env] ?? null;
    const harness = [
      isHelmHomeEnabled() ? 'helm' : null,
      consoleEnabled() ? 'console' : null,
    ].filter(Boolean) as string[];
    const critterKey = getSessionCritterKey();
    const statusRight =
      (list.note ?? lastReceipt ?? (changed > 0 ? `${changed} choice${changed === 1 ? '' : 's'} saved — applies to new sessions` : 'changes reach new sessions')) +
      (liveCount !== null ? `  ·  ${liveCount} established session${liveCount === 1 ? '' : 's'} unchanged` : '');
    return {
      entries,
      selIdx: list.selectedIndex,
      summary: {
        profile: `r${profile?.revision ?? 0} · ${changed > 0 ? `custom · ${changed} set` : 'default'}`,
        harness: harness.join(' · ') || 'none',
        integrity: savedVal('MERCURY_THEMIS') ?? 'enforce',
        integritySet: savedVal('MERCURY_THEMIS') !== null,
      },
      environment: {
        model: renderModelChip(mainModel),
        critter: critterKey.charAt(0).toUpperCase() + critterKey.slice(1),
        critterHue: getSessionAccent().accent,
        dirBase: basename(process.cwd()) || process.cwd(),
        dirTail,
      },
      statusRight,
      glowWord: wordGlow,
      legend: `↑↓ move · ↵ change (saved) · ⌫ default · a apply receipts${concourseLive && !chatBoot ? ` · o ${plainWorld ? 'live view' : 'concourse'}` : ''} · esc ${apply.phase === 'closed' ? 'back' : 'close receipts'}`,
      ...(apply.phase !== 'closed'
        ? {
            detailOverride:
              apply.phase === 'loading'
                ? ['reading established sessions…']
                : applyOverrideRows(apply.workers),
          }
        : {}),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved, effectiveByEnv, seatFacts, list.selectedIndex, list.note, lastReceipt, changed, liveCount, apply, mainModel, dirTail, profile, concourseLive, plainWorld, chatBoot, wordGlow?.peakCell, wordGlow?.gainLevel]);

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
        const line = composition.placed[i] ?? '';
        const entryIdx = composition.entryAt.get(i);
        if (entryIdx !== undefined && menuRows[entryIdx] !== undefined) {
          const row = menuRows[entryIdx]!;
          const props = list.rowProps(row, entryIdx);
          return (
            <InteractiveRow
              key={props.id}
              id={props.id}
              selected={props.selected}
              onSelect={props.onSelect}
              onActivate={props.onActivate}
              selectionBand={false}
              hoverStyle="chrome-ink"
              height={1}
            >
              {hover => renderSceneLine(line, hover && !props.selected ? { label: row.label, color: t.info } : undefined)}
            </InteractiveRow>
          );
        }
        return (
          <Box key={`menuline-${i}`} height={1} flexShrink={0}>
            {line.length > 0 ? renderSceneLine(line) : null}
          </Box>
        );
      })}
    </Box>
  );
}

function applyOverrideRows(workers: WorkerApplySummary[]): string[] {
  if (workers.length === 0) {
    return [
      'apply to established sessions',
      'no established sessions — saved defaults reach',
      'the next session at creation',
    ];
  }
  const rows: string[] = [`apply to established sessions · ${workers.length}`];
  for (const w of workers.slice(0, 6)) {
    if (!w.receipts) {
      rows.push(`${w.runnerId} · ${w.sessionId.slice(0, 8)} — no captured snapshot`);
      continue;
    }
    const refused = w.receipts.filter(r => r.outcome === 'refused');
    const noChange = w.receipts.filter(r => r.outcome === 'no-change');
    const live = w.receipts.filter(r => r.outcome === 'applied' || r.outcome === 'queued');
    rows.push(
      `${w.runnerId} · ${w.sessionId.slice(0, 8)} — snapshot r${w.snapshotRevision ?? 0} · ${noChange.length} at profile · ${refused.length} refused${live.length > 0 ? ` · ${live.length} live (${live.map(r => r.outcome).join(', ')})` : ''}`,
    );
    if (live.length > 0 && live[0]?.reason) rows.push(`  · ${live[0].reason}`);
    if (refused.length > 0 && refused[0]?.reason) rows.push(`  · ${refused[0].reason}`);
  }
  return rows;
}
