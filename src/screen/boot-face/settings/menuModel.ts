import type { chatOnlyBoot, stripFacts } from '../../routes/surfaceRoute.js';
import { menuRowValueLabel, menuRowWarning, type readBootDefaultsProfile, type resolveEffectiveSettingsSnapshot, type ExplicitApplyReceipt, type MenuRow } from '../../../platform/substrate/startupMenu.js';
import { seatCeilingDetailLines, type SeatCeilingFacts, seatCeilingValueWords } from '../../../daemon/switchboard-capacity/capacityCheck.js';
import { motionDetailLines, motionValueWords, type readMotionSetting } from '../../cockpit/motionSetting.js';
import { jevValueWords, type readJevSettings } from '../../../models/jev/jevSetting.js';
import { backgroundLaunchValueWords, type backgroundSessionsLaunchCrewmates } from '../../../daemon/switchboard/backgroundLaunch.js';
import type { useEngineModel } from '../../model-picker/useEngineModel.js';
import { bootEnvironment } from '../bootEnvironment.js';
import { isHelmHomeEnabled } from '../../fullscreen-layout/fullscreen.js';
import type { useGreetingShimmer } from '../../widgets/useGreetingShimmer.js';
import type { useInteractiveList } from '../../widgets/useInteractiveList.js';
import { backgroundLaunchBootDetailLines } from './detailLines.js';

export const settingsEditors = [
  { editor: 'kit', label: 'MCPs & Skills', summary: 'what the next session loads' },
  { editor: 'agents', label: 'Agents', summary: 'create and edit agents' },
  { editor: 'profiles', label: 'Profiles (Beta)', summary: 'separate logins and history' },
] as const;

type EditorRow = (typeof settingsEditors)[number];
export type SettingsEditor = EditorRow['editor'];
export type SettingsRow = MenuRow | EditorRow;

export interface WorkerApplySummary {
  runnerId: string;
  sessionId: string;
  snapshotRevision: number | null;
  receipts: ExplicitApplyReceipt[] | null;
}

export type ApplyState =
  | { phase: 'closed' }
  | { phase: 'loading' }
  | { phase: 'ready'; workers: WorkerApplySummary[]; error?: string };

export function settingsMenuModel({ apply, backgroundLaunchOn, changed, chatBoot, concourseLive, dirTail, effectiveByEnv, isBackgroundLaunchRow, isJevRow, isMotionRow, isSeatsRow, jevDetailLines, jevSettings, lastReceipt, list, liveCount, mainModel, menuRows, motionSetting, plainWorld, profile, profileReadError, saved, seatFacts, wordGlow }: { apply: ApplyState; backgroundLaunchOn: ReturnType<typeof backgroundSessionsLaunchCrewmates>; changed: number; chatBoot: ReturnType<typeof stripFacts>['chatBoot']; concourseLive: boolean; dirTail: string; effectiveByEnv: Map<string, ReturnType<typeof resolveEffectiveSettingsSnapshot>['rows'][number]>; isBackgroundLaunchRow: (row: MenuRow) => boolean; isJevRow: (row: MenuRow) => boolean; isMotionRow: (row: MenuRow) => boolean; isSeatsRow: (row: MenuRow) => boolean; jevDetailLines: string[]; jevSettings: ReturnType<typeof readJevSettings>; lastReceipt: string | null; list: ReturnType<typeof useInteractiveList<SettingsRow>>; liveCount: number | null; mainModel: ReturnType<typeof useEngineModel>; menuRows: readonly SettingsRow[]; motionSetting: ReturnType<typeof readMotionSetting>; plainWorld: ReturnType<typeof chatOnlyBoot>; profile: ReturnType<typeof readBootDefaultsProfile>; profileReadError?: string | null; saved: Record<string, string>; seatFacts: SeatCeilingFacts | null; wordGlow: ReturnType<typeof useGreetingShimmer> }) {
  const entries = menuRows.map(row => {
    if ('editor' in row) return { label: row.label, group: 'NEXT SESSION', summary: row.summary, valueLabel: '↵ open', valueIsDefault: true, pinnedVal: null, detail: null };
    if (isSeatsRow(row)) {
      return {
        label: row.label,
        group: row.group,
        summary: row.summary,
        valueLabel: seatFacts === null ? 'reading capacity…' : seatCeilingValueWords(seatFacts),
        valueIsDefault: seatFacts?.source !== 'operator',
        pinnedVal: null,
        detail: row.detail ?? null,
        detailExtra: seatFacts === null ? ['reading capacity…'] : seatCeilingDetailLines(seatFacts),
      };
    }
    if (isMotionRow(row)) {
      return {
        label: row.label,
        group: row.group,
        summary: row.summary,
        valueLabel: motionValueWords(motionSetting),
        valueIsDefault: motionSetting === 'auto',
        pinnedVal: null,
        detail: row.detail ?? null,
        detailExtra: motionDetailLines(),
      };
    }
    if (isJevRow(row)) {
      return {
        label: row.label,
        group: row.group,
        summary: row.summary,
        valueLabel: jevValueWords(jevSettings),
        valueIsDefault: !jevSettings.enabled,
        pinnedVal: null,
        detail: row.detail ?? null,
        detailExtra: jevDetailLines,
      };
    }
    if (isBackgroundLaunchRow(row)) {
      return {
        label: row.label,
        group: row.group,
        summary: row.summary,
        valueLabel: backgroundLaunchValueWords(backgroundLaunchOn),
        valueIsDefault: !backgroundLaunchOn,
        pinnedVal: null,
        detail: row.detail ?? null,
        detailExtra: backgroundLaunchBootDetailLines(backgroundLaunchOn),
      };
    }
    const effective = effectiveByEnv.get(row.env);
    const envPinned = effective?.source === 'process-env';
    return {
      label: row.label,
      group: row.group,
      summary: row.summary,
      valueLabel: menuRowValueLabel(row, saved[row.env] ?? null, env => {
        const other = effectiveByEnv.get(env);
        return other?.source === 'process-env' ? (other.value ?? null) : (saved[env] ?? null);
      }),
      valueIsDefault: saved[row.env] === undefined,
      pinnedVal: envPinned ? (effective?.value ?? '') : null,
      warn: menuRowWarning(row, envPinned ? (effective?.value ?? null) : (saved[row.env] ?? null)),
      detail: row.detail ?? null,
      detailExtra: [
        `this session  ${effective ? (effective.value ?? 'default') : 'default'} (${effective?.source === 'profile' ? 'saved' : (effective?.source ?? 'default')})`,
      ],
    };
  });
  const harness = [
    isHelmHomeEnabled() ? 'helm' : null,
  ].filter(Boolean) as string[];
  const idleStatus =
    profileReadError
      ? `could not be read (${profileReadError})`
      : (changed > 0 ? `${changed} choice${changed === 1 ? '' : 's'} saved — applies to new sessions` : 'changes reach new sessions') +
        (liveCount !== null ? `  ·  ${liveCount} established session${liveCount === 1 ? '' : 's'} unchanged` : '');
  const statusRight = list.note ?? lastReceipt ?? idleStatus;
  return {
    entries,
    selIdx: list.selectedIndex,
    summary: {
      profile: profileReadError
        ? `could not be read (${profileReadError})`
        : `r${profile?.revision ?? 0} · ${changed > 0 ? `custom · ${changed} set` : 'default'}`,
      harness: harness.join(' · ') || 'none',
    },
    environment: bootEnvironment(mainModel, process.cwd(), dirTail),
    statusRight,
    glowWord: wordGlow,
    legend: `↑↓ move · ${list.selectedRow && 'editor' in list.selectedRow ? '↵ open' : '↵ change (saved) · ⌫ default'} · a apply receipts${concourseLive && !chatBoot ? ` · o ${plainWorld ? 'live view' : 'concourse'}` : ''} · esc ${apply.phase === 'closed' ? 'back' : 'close receipts'}`,
    ...(apply.phase !== 'closed'
      ? {
          detailOverride:
            apply.phase === 'loading'
              ? ['reading established sessions…']
              : applyOverrideRows(apply.workers, apply.error),
        }
      : {}),
  };
}

function applyOverrideRows(workers: WorkerApplySummary[], error?: string): string[] {
  if (error !== undefined) {
    return [
      'apply to established sessions',
      `established sessions could not be read (${error})`,
    ];
  }
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
      `${w.runnerId} · ${w.sessionId.slice(0, 8)} — snapshot r${w.snapshotRevision ?? 0} · ${noChange.length} as saved · ${refused.length} refused${live.length > 0 ? ` · ${live.length} live (${live.map(r => r.outcome).join(', ')})` : ''}`,
    );
    if (live.length > 0 && live[0]?.reason) rows.push(`  · ${live[0].reason}`);
    if (refused.length > 0 && refused[0]?.reason) rows.push(`  · ${refused[0].reason}`);
  }
  return rows;
}
