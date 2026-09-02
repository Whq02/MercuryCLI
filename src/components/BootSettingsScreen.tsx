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

/**
 * BootSettingsScreen — the RATIFIED boot-menu design as the runtime settings
 * face (the flat-list projection is replaced by the
 * launcher's three-panel layout — CONTROL PLANE · SETTING DETAIL · LAUNCH
 * SUMMARY · ENVIRONMENT · the System-ready bar — composed by the ONE shared
 * core, composeBootMenu; below 110 cols the classic single-column tier in
 * the launcher's exact classic grammar is the only surviving flat list).
 *
 * Same semantic substrate as ever, never the launcher's process:
 * rows come from STARTUP_MENU, values move through saveBootDefaultsProfile
 * (write-through — the visible state IS the saved state; each change
 * commits the next monotonic profile revision with its receipt), and
 * THIS session's effective values ride resolveEffectiveSettingsSnapshot
 * with per-row provenance. Runtime deltas slot INTO the ratified panels
 * — the profile revision joins LAUNCH SUMMARY, write receipts land in
 * the status bar, per-row provenance renders under Current value, and 'a'
 * swaps the SETTING DETAIL body for the apply-receipts view (esc closes the
 * receipts layer first — the existing layering).
 *
 * Keyboard grammar (one contract, both hosts): ↑↓/jk move ·
 * ↵/space/→ cycle (saved) · ← cycle back · ⌫ reset to default · a apply
 * receipts · o concourse (when genuinely available) · esc back one layer.
 */

/** Canonical-keyed saved choices (a saved file carries the spelling pair
 *  per row — collapse through the registry's own spelling resolver). */
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

/** The runtime's ENVIRONMENT git tail — probed lazily ONCE per mount (the
 *  launcher's own gitEnvTail law), always fail-soft, ASYNC. The spawnSync
 *  pair this replaces ran inside the face's FIRST RENDER (a useState
 *  initializer, synchronous in the keystroke's reconciler flush): up to
 *  0.8s + 1.5s of a dead terminal on the 'm'/'s' press — no paint, no
 *  input, esc unable to close — for a decoration string (TASK-017 S2,
 *  boot-settings-sync-git-in-render; RealmsView's header records the same
 *  class fixed the same way). The tail fills in when the probe answers. */
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
  /** The persistent Boot scene contract: the settings face owns
   *  the whole viewport on the shared flat ground (round 7). */
  fullScene?: { columns: number; rows: number };
} = {}): React.ReactNode {
  const t = useMercuryTokens();
  const { columns: termCols, rows: termRows } = useTerminalSize();
  const columns = fullScene?.columns ?? termCols;
  const rows = fullScene?.rows ?? termRows;
  const path = bootEnvPath();

  // The saved profile + THIS session's effective snapshot re-resolve after
  // every save (state version drives the memo).
  const [saveTick, setSaveTick] = useState(0);
  const [lastReceipt, setLastReceipt] = useState<string | null>(null);
  const profile = useMemo(() => readBootDefaultsProfile(path), [path, saveTick]);
  const saved = useMemo(() => savedChoicesByRow(profile), [profile]);
  const snapshot = useMemo(
    // THIS process's admission values (recorded at boot) — a fresh
    // resolution only when no boot recorded one.
    () => bootAdmissionSnapshot() ?? resolveEffectiveSettingsSnapshot({ sessionId: getSessionId(), path }),
    [path, saveTick],
  );
  const effectiveByEnv = useMemo(
    () => new Map(snapshot.rows.map(r => [r.env, r])),
    [snapshot],
  );

  // Established-session facts (the bounded records read — dynamic import so
  // the Concourse subsystem loads only when this screen asks for it).
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
          .map((rec): WorkerApplySummary => ({
            runnerId: rec.runnerId,
            sessionId: rec.sessionId,
            snapshotRevision: rec.settingsSnapshot?.profileRevision ?? null,
            receipts: rec.settingsSnapshot
              ? evaluateExplicitApply(rec.settingsSnapshot, currentProfile)
              : null,
          }));
        setApply({ phase: 'ready', workers });
      })
      .catch(() => {
        if (!cancelled) setApply({ phase: 'ready', workers: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [apply.phase, path]);

  const commitRow = (row: MenuRow, value: string | null): string => {
    const env: Record<string, string> = { ...saved };
    if (value === null) delete env[row.env];
    else env[row.env] = value;
    const res = saveBootDefaultsProfile(env, path, {
      ...(liveCount !== null ? { existingSessionsUnchanged: liveCount } : {}),
    });
    if (!res.ok) return `save refused — ${res.reason}`;
    setSaveTick(n => n + 1);
    setLastReceipt(`r${res.revision} · ${res.receipt}`);
    return `r${res.revision} · ${res.receipt}`;
  };

  const cycleRow = (row: MenuRow, direction: 1 | -1): string => {
    const choices = menuRowChoices(row);
    const currentValue = saved[row.env] ?? null;
    const idx = Math.max(0, choices.findIndex(c => c.value === currentValue));
    const next = choices[(idx + direction + choices.length) % choices.length]!;
    return commitRow(row, next.value);
  };

  const concourseLive = routeSurfaceRegistered('concourse') && isFullscreenEnvEnabled();
  // In THE PLAIN WORLD (a `--chat` boot, the concourse switched off) the 'o'
  // door opens the plain live view of the sessions, and the legend says so.
  const plainWorld = chatOnlyBoot();
  // A `--chat` boot has no concourse door on the menu at all (L15: New
  // Session is the door) — the --concourse-off twin keeps 'o' as its
  // live-view door.
  const chatBoot = stripFacts().chatBoot;

  const list = useInteractiveList<MenuRow>({
    rows: STARTUP_MENU as readonly MenuRow[],
    rowId: r => r.env,
    idNamespace: 'boot-settings',
    onClose: () => {
      if (apply.phase !== 'closed') {
        setApply({ phase: 'closed' });
        return;
      }
      // Hosted as the Boot face's settings layer — esc closes back to the
      // canonical face; standalone mounting keeps the route pop.
      if (onClose) onClose();
      else leaveCurrentSurface();
    },
    actions: [
      // the pending note paints on the keypress; the disk write
      // runs through the event loop, never inside the keypress handler.
      {
        key: 'return',
        hint: 'cycle',
        run: row => (row ? { pending: 'saving…', result: Promise.resolve().then(() => cycleRow(row, 1)) } : null),
      },
      // the visible Concourse action — present ONLY while genuinely
      // available; the route stacks, so the Concourse's Back returns here.
      ...(concourseLive && !chatBoot
        ? [{
            key: 'o',
            hint: plainWorld ? 'open the live view' : 'open concourse',
            run: (): null => {
              // RB-07: a Concourse trip from WITHIN settings returns to the
              // settings layer, not the bare face.
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
      // The ratified grammar's space alias for cycle.
      {
        key: ' ',
        hint: 'cycle',
        run: row => (row ? { pending: 'saving…', result: Promise.resolve().then(() => cycleRow(row, 1)) } : null),
      },
    ],
  });

  // ←/→ cycle back/forward — the vertical list decodes no horizontal
  // motion, so these land here (active only while the menu owns input).
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

  // ── the ratified composition (the ONE shared design) ─────────────────────
  // Bound to the LIVE session accent — the menu face
  // wears the selected critter's family like every boot surface. The pixel
  // word greets each OPEN of this face (mount-armed; the settle law).
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
    const entries = (STARTUP_MENU as readonly MenuRow[]).map(row => {
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
        // THIS session's effective value + provenance, under Current
        // value — the flat list's fact, in the ratified panel's slot.
        detailExtra: [
          `this session  ${effective ? (effective.value ?? 'default') : 'default'} (${effective?.source ?? 'default'})`,
        ],
      };
    });
    const savedVal = (env: string): string | null => saved[env] ?? null;
    // Helm home + console left the menu (default-on; env kills) — the chip
    // reads their owning gates, not a saved row.
    const harness = [
      isHelmHomeEnabled() ? 'helm' : null,
      consoleEnabled() ? 'console' : null,
    ].filter(Boolean) as string[];
    const critterKey = getSessionCritterKey();
    // Runtime title truth: changes reach NEW sessions; receipts and
    // the established-session fact ride the status bar.
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
  }, [saved, effectiveByEnv, list.selectedIndex, list.note, lastReceipt, changed, liveCount, apply, mainModel, dirTail, profile, concourseLive, plainWorld, chatBoot, wordGlow?.peakCell, wordGlow?.gainLevel]);

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
        if (entryIdx !== undefined && (STARTUP_MENU as readonly MenuRow[])[entryIdx] !== undefined) {
          const row = (STARTUP_MENU as readonly MenuRow[])[entryIdx]!;
          const props = list.rowProps(row, entryIdx);
          return (
            // The composed CONTROL PLANE row IS the pointer target — click
            // parity rides InteractiveRow; the selected paint stays the
            // composed grammar (❯ + bold-underline ivory).
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

/** The apply-receipts view as SETTING DETAIL body rows (the 'a' view
 *  swaps the panel body; the layout tier never moves). */
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
    rows.push(
      `${w.runnerId} · ${w.sessionId.slice(0, 8)} — snapshot r${w.snapshotRevision ?? 0} · ${noChange.length} at profile · ${refused.length} refused`,
    );
    if (refused.length > 0 && refused[0]?.reason) rows.push(`  · ${refused[0].reason}`);
  }
  return rows;
}
