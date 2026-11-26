import React, { useMemo, useRef, useState } from 'react';
import { getCwd } from '../../platform/files/cwd.js';
import { useInput } from '../themedRenderer.js';
import { bootMenuAsks, createSplashCore, fmtAge, WORD_W } from '../../../assets/splash/splash-core.mjs';
import { isProjectSession } from '../session-chooser/sessionFilter.js';
import type { BootProjectFact } from './bootCardFacts.js';
import { getSessionId } from '../../boot/process-state/processState.js';
import { useAppStateMaybeOutsideOfProvider } from '../app-state/AppState.js';
import { enterRootChat } from '../routes/surfaceRoute.js';
import { boardHomedSessionIds } from '../../daemon/concourse-workers/concourseWorkers.js';
import { useEngineModel } from '../model-picker/useEngineModel.js';
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js';
import {
  useSessionPickerModel,
  type SessionPickerFlatRow,
  type SessionScope,
} from '../widgets/faces/sessionPickerModel.js';
import { retentionWindowDays } from '../../sessions/transcripts/retentionSweep.js';
import { formatFileSize, formatRelativeTimeAgo } from '../../platform/text/format.js';
import {
  buildPruneOffer,
  operatorPruneTranscripts,
  type PruneOffer,
  type PruneReceipt,
} from '../../daemon/switchboard/transcriptPruneDoor.js';
import { sessionIdOfListing } from '../../sessions/transcripts/sessionStorage.js';
import { bootEnvironment } from './bootEnvironment.js';
import { useGreetingShimmer } from '../widgets/useGreetingShimmer.js';
import { useInteractiveList, type AsyncListNote } from '../widgets/useInteractiveList.js';
import { useMercuryTokens } from '../widgets/useMercuryTokens.js';
import { useSplashCoreAccent } from '../widgets/useSplashCoreAccent.js';
import { useBootComposition } from './useBootComposition.js';
import { resumeView, type SelectableRow } from './resume/resumeView.js';


interface BootResumePickerModel {
  flat: SessionPickerFlatRow[];
  elsewhereCount: number;
  pendingMore: number;
  readNotice?: string | null;
}

interface BootResumeScreenProps {
  onClose?: () => void;
  fullScene?: { columns: number; rows: number };
  model?: BootResumePickerModel;
  initialScope?: SessionScope;
  projects?: ReadonlyArray<BootProjectFact & { running?: number }>;
  openProject?: (p: BootProjectFact) => AsyncListNote;
}

export type ResumeEntry = {
  label: string;
  group: string;
  groupTitle: string;
  summary: string;
  valueLabel: string;
  valueIsDefault: boolean;
  pinnedVal: null;
  detail: null;
  detailExtra?: string[];
  inert?: boolean;
};

export function resumeEntryOf(f: SessionPickerFlatRow): ResumeEntry {
  return {
    label: f.row.label,
    group: f.project,
    groupTitle: f.project,
    summary: `last seen ${f.row.seen}${f.row.cleared ? ' · cleared' : ''} — ↵ opens it`,
    valueLabel: f.row.cleared ? `${f.row.seen} · cleared` : f.row.seen,
    valueIsDefault: f.row.cleared !== true,
    pinnedVal: null,
    detail: null,
  };
}

export function resumeElsewhereEntry(count: number): ResumeEntry {
  return {
    label: `+${count} in other project${count === 1 ? '' : 's'} — a shows all history`,
    group: 'elsewhere',
    groupTitle: 'elsewhere',
    summary: '',
    valueLabel: '',
    valueIsDefault: true,
    pinnedVal: null,
    detail: null,
    inert: true,
  };
}

export function resumeDetailLines(f: SessionPickerFlatRow): string[] {
  return [
    `project: ${f.project}`,
    `last seen: ${f.row.seen}`,
    ...(f.row.cleared ? ['cleared — deliberately closed; resuming reopens it'] : []),
    '',
    '↵ opens this session —',
    'the chat stop appears on the strip;',
    'this screen and the face stay beneath.',
    '',
    'esc — back to the face, nothing opened',
  ];
}


export function resumeProjectEntryOf(p: BootProjectFact & { running?: number }): ResumeEntry {
  return {
    label: p.base,
    group: 'projects',
    groupTitle: 'projects',
    summary: `↵ opens this repo's newest chat · highlighting filters the sessions above`,
    valueLabel: `${fmtAge(p.ageMs)}${p.running !== undefined && p.running > 0 ? ` · ${p.running} running` : ''}`,
    valueIsDefault: true,
    pinnedVal: null,
    detail: null,
  };
}

export function resumeProjectDetailLines(p: BootProjectFact & { running?: number }): string[] {
  return [
    `repo: ${p.base}`,
    ...(p.dir.length > 32 ? [`dir: …${p.dir.slice(-31)}`] : [`dir: ${p.dir}`]),
    `last session: ${fmtAge(p.ageMs)} ago`,
    ...(p.running !== undefined && p.running > 0 ? [`${p.running} running now`] : []),
    '',
    'highlighted: the sessions above show',
    'this repo alone (↑ walks back out)',
    '',
    '↵ opens the newest chat there',
    '(a history-less repo births one);',
    'the refusal paints on the row.',
  ];
}

export function resumeEmptyDetailLines(scope: SessionScope, elsewhereCount: number): string[] {
  return scope === 'project' && elsewhereCount > 0
    ? ['no sessions in this project yet', '', `${elsewhereCount} in other projects — a shows`, 'the full history.', '', 'n births a fresh session here']
    : ['nothing to resume yet', '', 'n births a fresh session here —', 'the chat, the session and the board', 'row come into being together.'];
}

export function resumeSummaryRows(facts: {
  scope: SessionScope;
  count: number;
  elsewhereCount: number;
  pendingMore: number;
  projectsCount?: number;
}): Array<{ key: string; value: string; tone?: 'faint' }> {
  return [
    { key: 'Scope', value: facts.scope === 'all' ? 'all history — every project' : 'this project' },
    {
      key: 'Sessions',
      value: `${facts.count}${facts.scope === 'project' && facts.elsewhereCount > 0 ? ` · ${facts.elsewhereCount} elsewhere` : ''}`,
    },
    ...(facts.projectsCount !== undefined && facts.projectsCount > 0
      ? [{ key: 'Repos', value: `${facts.projectsCount}` }]
      : []),
    ...(facts.pendingMore > 0 ? [{ key: 'Loading', value: `${facts.pendingMore} more…`, tone: 'faint' as const }] : []),
    { key: 'Opens', value: 'in place' },
  ];
}

export function resumeStatusLine(facts: { loading: boolean; count: number; scope: SessionScope; pendingMore: number; filterBase?: string }): string {
  if (facts.loading) return 'reading the session store…';
  const scopeWord =
    facts.filterBase !== undefined
      ? `'${facts.filterBase}' (filtered)`
      : facts.scope === 'all'
        ? 'the full history'
        : 'this project';
  const pending = facts.pendingMore > 0 ? ` · loading ${facts.pendingMore} more…` : '';
  return facts.count === 0
    ? `no sessions to resume in ${scopeWord}${pending} — n births one`
    : `${facts.count} session${facts.count === 1 ? '' : 's'} in ${scopeWord}${pending}`;
}

export function resumeLegendOf(scope: SessionScope, hasRows: boolean, projectsPresent = false): string {
  const flip = scope === 'all' ? 'a this project' : 'a all history';
  const jump = projectsPresent ? ' · ⇥ repos' : '';
  return hasRows
    ? `↑↓ move · ↵ open · n new session · d prune · ${flip}${jump} · esc back`
    : `n new session · d prune · ${flip}${jump} · esc back`;
}


export function pruneScopeLabelOf(scope: SessionScope): string {
  return scope === 'project'
    ? "this project's listed chats"
    : 'the full history (every project, cleared included)';
}

const agoShort = (d: Date, nowMs?: number): string =>
  formatRelativeTimeAgo(d, { style: 'short', ...(nowMs !== undefined ? { now: new Date(nowMs) } : {}) });

export function pruneCardLines(offer: PruneOffer, answer: 'no' | 'yes', nowMs?: number): string[] {
  const lines: string[] = [
    'prune transcripts — the one deleting',
    'door · nothing is ever deleted',
    'automatically',
    '',
    `scope: ${offer.scopeLabel}`,
    `older than ${offer.windowDays} days`,
    '',
  ];
  if (offer.candidates.length > 0) {
    lines.push(
      `would delete: ${offer.candidates.length} transcript${offer.candidates.length === 1 ? '' : 's'} · total ${formatFileSize(offer.totalBytes)}`,
      `age range: ${offer.oldestModified ? agoShort(offer.oldestModified, nowMs) : '—'} → ${offer.newestModified ? agoShort(offer.newestModified, nowMs) : '—'}`,
    );
  } else {
    lines.push(`nothing to prune — no listed chat is older than ${offer.windowDays} days`);
  }
  lines.push('', `${answer === 'no' ? '▸ ' : '  '}No — keep everything (default)`);
  if (offer.candidates.length > 0) {
    lines.push(`${answer === 'yes' ? '▸ ' : '  '}Yes — delete exactly this set, for good`);
  }
  lines.push('', 'deletes exactly the set named above ·', 'asked every time, never remembered');
  return lines;
}

export function pruneReceiptLines(receipt: PruneReceipt, nowMs?: number): string[] {
  return [
    "pruned · the operator's own act",
    '',
    `deleted ${receipt.deleted} transcript${receipt.deleted === 1 ? '' : 's'}`,
    `freed ${formatFileSize(receipt.bytesFreed)} · ${agoShort(receipt.at, nowMs)} · by the operator`,
    ...(receipt.failed > 0 ? [`${receipt.failed} could not be deleted — still listed`] : []),
  ];
}

export function pruneLegendOf(stage: 'card', offered: boolean): string;
export function pruneLegendOf(stage: 'deleting' | 'receipt'): string;
export function pruneLegendOf(stage: 'card' | 'deleting' | 'receipt', offered = false): string {
  if (stage === 'card') {
    return offered ? '↑↓ choose · ↵ commit (No is the default) · esc / n keep everything' : '↵ / esc close';
  }
  return stage === 'receipt' ? '↵ / esc back to the list' : 'deleting the named set…';
}

type PruneFace =
  | { stage: 'card'; offer: PruneOffer; answer: 'no' | 'yes' }
  | { stage: 'deleting' }
  | { stage: 'receipt'; receipt: PruneReceipt };

function pruneAskingOf(prune: PruneFace): string {
  if (prune.stage === 'deleting') return pruneLegendOf('deleting');
  if (prune.stage === 'receipt') {
    return `deleted ${prune.receipt.deleted} transcript${prune.receipt.deleted === 1 ? '' : 's'}${prune.receipt.failed > 0 ? `, ${prune.receipt.failed} not deleted` : ''} · ↵ esc`;
  }
  const count = prune.offer.candidates.length;
  return count === 0 ? 'nothing to prune · ↵ esc' : `delete ${count} transcript${count === 1 ? '' : 's'}? ▸ ${prune.answer === 'yes' ? 'Yes' : 'No'} · ↑↓ ↵ esc`;
}

function selectableIdOf(row: SelectableRow): string {
  if (row.kind === 'session') return `resume:${sessionIdOfListing(row.flat.row.log) ?? row.flat.row.label}`;
  return `project:${row.project.dir}`;
}

export function BootResumeScreen({ onClose, fullScene, model: given, initialScope, projects, openProject }: BootResumeScreenProps = {}): React.ReactNode {
  const t = useMercuryTokens();
  const { columns: termCols, rows: termRows } = useTerminalSize();
  const columns = fullScene?.columns ?? termCols;
  const rows = fullScene?.rows ?? termRows;
  const [scope, setScope] = useState<SessionScope>(initialScope ?? 'all');

  const [projectFilter, setProjectFilter] = useState<(BootProjectFact & { running?: number }) | null>(null);

  const live = useSessionPickerModel(scope, {
    enabled: given === undefined,
    ...(projectFilter !== null ? { filterDir: projectFilter.dir } : {}),
  });
  const flat = useMemo(
    () =>
      given === undefined
        ? live.flat
        : projectFilter === null
          ? given.flat
          : given.flat.filter(f => isProjectSession(f.row.log, projectFilter.dir)),
    [given, live.flat, projectFilter],
  );
  const elsewhereCount = given?.elsewhereCount ?? live.elsewhereCount;
  const pendingMore = given?.pendingMore ?? live.pendingMore;
  const readNotice = given?.readNotice ?? live.readNotice;
  const loading = given === undefined && live.logs === null;

  const selectable: SelectableRow[] = useMemo(
    () => [
      ...flat.map(f => ({ kind: 'session' as const, flat: f })),
      ...(projects ?? []).map(project => ({ kind: 'project' as const, project })),
    ],
    [flat, projects],
  );

  const [prune, setPrune] = useState<PruneFace | null>(null);
  const showPrune = (next: PruneFace): void => {
    if (bootMenuAsks(columns, rows, pruneAskingOf(next))) setPrune(next);
  };
  const openPruneDoor = (): void => {
    const offer = buildPruneOffer(
      flat.map(f => f.row.log),
      {
        scopeLabel: pruneScopeLabelOf(scope),
        windowDays: retentionWindowDays(),
        activeSessionId: String(getSessionId() ?? ''),
        liveSessionIds: boardHomedSessionIds(),
      },
    );
    showPrune({ stage: 'card', offer, answer: 'no' });
  };
  async function runPrune(offer: PruneOffer) {
    setPrune({ stage: 'deleting' });
    const receipt = await operatorPruneTranscripts(offer);
    live.dropSessions(new Set(receipt.deletedSessionIds));
    setPrune({ stage: 'receipt', receipt });
  }
  useInput(
    (input, key, event) => {
      event.stopImmediatePropagation();
      if (prune === null) return;
      if (prune.stage === 'deleting') return;
      if (prune.stage === 'receipt') {
        if (key.return || key.escape) setPrune(null);
        return;
      }
      if (key.escape || input === 'n') {
        setPrune(null);
        return;
      }
      if (!bootMenuAsks(columns, rows, pruneAskingOf(prune))) return;
      if (key.upArrow || key.downArrow) {
        const offered = prune.offer.candidates.length > 0;
        showPrune({ ...prune, answer: offered && prune.answer === 'no' ? 'yes' : 'no' });
        return;
      }
      if (key.return) {
        if (prune.answer === 'yes' && prune.offer.candidates.length > 0) {
          void runPrune(prune.offer);
        } else {
          setPrune(null);
        }
        return;
      }
    },
    { isActive: prune !== null },
  );

  const permissionMode = useAppStateMaybeOutsideOfProvider(state => state.toolPermissionContext.mode);
  const permissionModeRef = useRef(permissionMode);
  permissionModeRef.current = permissionMode;

  const openRow = (row: SelectableRow): AsyncListNote | null => {
    if (row.kind === 'project') {
      return openProject?.(row.project) ?? null;
    }
    const log = row.flat.row.log;
    const title = row.flat.row.label;
    return {
      pending: 'opening…',
      result: (async (): Promise<string | null> => {
        try {
          const sessionId = sessionIdOfListing(log);
          if (!sessionId) return 'could not resume — the row carries no session id';
          const hop = await import('../../daemon/switchboard/hopIntoSession.js');
          const outcome = await hop.focusResumedSession(String(sessionId), log.fullPath, {
            title,
            permissionMode: permissionModeRef.current,
          });
          if (!outcome.ok) return outcome.reason;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
        enterRootChat();
        return null;
      })(),
    };
  };

  const birthRow = (): AsyncListNote => ({
    pending: 'starting a session…',
    result: (async (): Promise<string | null> => {
      const { bornSession } = await import('../../daemon/switchboard/bornSession.js');
      const born = await bornSession({ workspaceDir: getCwd() });
      if (!born.ok) return born.reason;
      enterRootChat();
      return null;
    })(),
  });

  const list = useInteractiveList<SelectableRow>({
    rows: selectable,
    rowId: selectableIdOf,
    idNamespace: 'boot-resume',
    active: prune === null,
    onClose: () => onClose?.(),
    actions: [
      { key: 'return', hint: 'open', run: r => (r === null ? null : openRow(r)) },
      { key: 'n', hint: 'new session', run: () => birthRow() },
      {
        key: 'd',
        hint: 'prune',
        run: () => {
          if (projectFilter !== null) {
            return 'prune acts on the whole list; exit the project filter first';
          }
          openPruneDoor();
          return null;
        },
      },
      {
        key: 'a',
        hint: 'scope',
        run: () => {
          setScope(s => (s === 'project' ? 'all' : 'project'));
          return null;
        },
      },
    ],
  });
  const selected = list.selectedRow;
  if (selected?.kind === 'project') {
    if (projectFilter?.dir !== selected.project.dir) setProjectFilter(selected.project);
  } else if (selected !== null && projectFilter !== null) {
    setProjectFilter(null);
  }

  useInput(
    (_input, key, event) => {
      if (!key.tab) return;
      event.stopImmediatePropagation();
      const projStart = flat.length;
      if (projStart >= selectable.length) return;
      list.moveTo(list.selectedIndex >= projStart ? 0 : projStart);
    },
    { isActive: prune === null && (projects?.length ?? 0) > 0 },
  );

  useInput(
    (_input, key, event) => {
      if (!key.leftArrow) return;
      event.stopImmediatePropagation();
      onClose?.();
    },
    { isActive: prune === null },
  );

  const { accent: coreAccent, rampStops } = useSplashCoreAccent();
  const core = useMemo(
    () => createSplashCore({ nocolor: false, truecolor: true, accent: coreAccent }),
    [coreAccent],
  );
  const wordGlow = useGreetingShimmer(rampStops, WORD_W);
  const mainModel = useEngineModel();

  const menuM = useMemo(() => {
    const environment = bootEnvironment(mainModel, getCwd());
    const entries: ResumeEntry[] = [
      ...flat.map(resumeEntryOf),
      ...(scope === 'project' && elsewhereCount > 0 ? [resumeElsewhereEntry(elsewhereCount)] : []),
      ...(projects ?? []).map(resumeProjectEntryOf),
    ];
    const entryIndexOf = (i: number): number =>
      i < flat.length ? i : i + (scope === 'project' && elsewhereCount > 0 ? 1 : 0);
    const statusRight =
      list.note ??
      readNotice ??
      resumeStatusLine({
        loading,
        count: flat.length,
        scope,
        pendingMore,
        ...(projectFilter !== null ? { filterBase: projectFilter.base } : {}),
      });
    const pruneOverride =
      prune === null
        ? null
        : prune.stage === 'card'
          ? { detailOverride: pruneCardLines(prune.offer, prune.answer), detailOverrideConfirms: true, legend: pruneLegendOf('card', prune.offer.candidates.length > 0) }
          : prune.stage === 'deleting'
            ? { detailOverride: ['deleting the named set…'], detailOverrideConfirms: true, legend: pruneLegendOf('deleting') }
            : { detailOverride: pruneReceiptLines(prune.receipt), detailOverrideConfirms: true, legend: pruneLegendOf('receipt') };
    const merged = (projects?.length ?? 0) > 0;
    return {
      entries,
      selIdx: selected !== null ? entryIndexOf(list.selectedIndex) : -1,
      title: merged ? 'sessions · projects' : 'resume session',
      summaryRows: resumeSummaryRows({
        scope,
        count: flat.length,
        elsewhereCount,
        pendingMore,
        ...(merged ? { projectsCount: projects?.length ?? 0 } : {}),
      }),
      environment,
      statusRight,
      ...(readNotice !== null ? { noticeLine: readNotice } : {}),
      glowWord: wordGlow,
      legend: resumeLegendOf(scope, selectable.length > 0, merged),
      ...(selected === null
        ? {
            detailOverride: loading
              ? ['reading the session store…']
              : readNotice !== null
                ? [readNotice, '', ...resumeEmptyDetailLines(scope, elsewhereCount)]
                : resumeEmptyDetailLines(scope, elsewhereCount),
          }
        : {
            detailOverride:
              selected.kind === 'session'
                ? resumeDetailLines(selected.flat)
                : resumeProjectDetailLines(selected.project),
          }),
      ...(pruneOverride ?? {}),
      asking: prune === null ? null : pruneAskingOf(prune),
    };
  }, [flat, elsewhereCount, pendingMore, readNotice, loading, scope, selected, selectable.length, list.selectedIndex, list.note, prune, mainModel, wordGlow?.peakCell, wordGlow?.gainLevel]);

  const composition = useBootComposition(core, columns, rows, menuM);

  const elsewhereAt = scope === 'project' && elsewhereCount > 0 ? flat.length : -1;
  const listIndexOf = (entryIdx: number): number => {
    if (entryIdx === elsewhereAt) return -1;
    return elsewhereAt >= 0 && entryIdx > elsewhereAt ? entryIdx - 1 : entryIdx;
  };
  return resumeView({ t, columns, rows, selectable, list, composition, listIndexOf });
}
