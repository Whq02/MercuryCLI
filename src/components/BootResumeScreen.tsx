import React, { useEffect, useMemo, useRef, useState } from 'react';
import { basename } from 'node:path';
import { getCwd } from '../utils/cwd.js';
import { Box, useInput } from '../ink.js';
import { createSplashCore, fmtAge, WORD_W } from '../../assets/splash/splash-core.mjs';
import { isProjectSession } from '../utils/sessionFilter.js';
import type { BootProjectFact } from '../utils/bootCardFacts.js';
import { getSessionId } from '../bootstrap/state.js';
import { useAppStateMaybeOutsideOfProvider } from '../state/AppState.js';
import { enterRootRepl } from '../context/surfaceRoute.js';
import { boardHomedSessionIds } from '../daemon/concourseSupervisor.js';
import { useMainLoopModel } from '../hooks/useMainLoopModel.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import {
  useSessionPickerModel,
  type SessionPickerCrewRow,
  type SessionPickerFlatRow,
  type SessionScope,
} from './mercury-ui/screens/sessionPickerModel.js';
import { retentionWindowDays } from '../utils/cleanup.js';
import { formatFileSize, formatRelativeTimeAgo } from '../utils/format.js';
import {
  buildPruneOffer,
  operatorPruneTranscripts,
  type PruneOffer,
  type PruneReceipt,
} from '../utils/sessionStorage/transcriptPruneDoor.js';
import { getSessionIdFromLog } from '../utils/sessionStorage.js';
import { renderModelChip } from '../utils/model/model.js';
import { InteractiveRow } from './mercury-ui/InteractiveRow.js';
import { renderSceneLine } from './mercury-ui/SceneCanvas.js';
import { getSessionAccent, getSessionCritterKey } from './mercury-ui/sessionAccent.js';
import { useGreetingShimmer } from './mercury-ui/useGreetingShimmer.js';
import { useInteractiveList, type AsyncListNote } from './mercury-ui/useInteractiveList.js';
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js';
import { useSplashCoreAccent } from './mercury-ui/useSplashCoreAccent.js';


export interface BootResumePickerModel {
  flat: SessionPickerFlatRow[];
  crew: SessionPickerCrewRow[];
  elsewhereCount: number;
  pendingMore: number;
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
    summary: `last seen ${f.row.seen}${f.row.cleared ? ' · cleared' : ''} — ↵ opens it as the real chat`,
    valueLabel: f.row.cleared ? `${f.row.seen} · cleared` : f.row.seen,
    valueIsDefault: f.row.cleared !== true,
    pinnedVal: null,
    detail: null,
  };
}

export function resumeCrewEntryOf(c: SessionPickerCrewRow): ResumeEntry {
  return {
    label: `${c.tag} — ${c.label}`,
    group: 'router crews',
    groupTitle: 'router crews',
    summary: `a router-crew transcript · last seen ${c.seen} — ↵ opens it for inspection`,
    valueLabel: c.seen,
    valueIsDefault: true,
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
    '↵ opens this session as the real chat —',
    'the chat stop appears on the strip;',
    'this screen and the face stay beneath.',
    '',
    'esc — back to the face, nothing opened',
  ];
}

export function resumeCrewDetailLines(c: SessionPickerCrewRow): string[] {
  return [
    `crew seat: ${c.tag}`,
    `last seen: ${c.seen}`,
    '',
    'a router-crew transcript — ↵ opens it',
    'for inspection as a real chat.',
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
    '↵ opens the newest chat there as the',
    'real chat (a history-less repo births',
    'one); the refusal paints on the row.',
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
  crewCount: number;
  elsewhereCount: number;
  pendingMore: number;
  projectsCount?: number;
}): Array<{ key: string; value: string; tone?: 'teal' | 'faint' }> {
  return [
    { key: 'Scope', value: facts.scope === 'all' ? 'all history — every project' : 'this project' },
    {
      key: 'Sessions',
      value: `${facts.count}${facts.crewCount > 0 ? ` · ${facts.crewCount} crew` : ''}${facts.scope === 'project' && facts.elsewhereCount > 0 ? ` · ${facts.elsewhereCount} elsewhere` : ''}`,
    },
    ...(facts.projectsCount !== undefined && facts.projectsCount > 0
      ? [{ key: 'Repos', value: `${facts.projectsCount}` }]
      : []),
    ...(facts.pendingMore > 0 ? [{ key: 'Loading', value: `${facts.pendingMore} more…`, tone: 'faint' as const }] : []),
    { key: 'Opens', value: '● a real chat, in place', tone: 'teal' },
  ];
}

export function resumeStatusLine(facts: { loading: boolean; count: number; crewCount: number; scope: SessionScope; pendingMore: number; filterBase?: string }): string {
  if (facts.loading) return 'reading the session store…';
  const scopeWord =
    facts.filterBase !== undefined
      ? `'${facts.filterBase}' (filtered)`
      : facts.scope === 'all'
        ? 'the full history'
        : 'this project';
  const crew = facts.crewCount > 0 ? ` · ${facts.crewCount} crew` : '';
  const pending = facts.pendingMore > 0 ? ` · loading ${facts.pendingMore} more…` : '';
  return facts.count === 0
    ? `no sessions to resume in ${scopeWord}${crew}${pending} — n births one`
    : `${facts.count} session${facts.count === 1 ? '' : 's'} in ${scopeWord}${crew}${pending} · ↵ opens the real chat`;
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

type SelectableRow =
  | { kind: 'session'; flat: SessionPickerFlatRow }
  | { kind: 'crew'; crew: SessionPickerCrewRow }
  | { kind: 'project'; project: BootProjectFact & { running?: number } };

function selectableIdOf(row: SelectableRow): string {
  if (row.kind === 'session') return `resume:${getSessionIdFromLog(row.flat.row.log) ?? row.flat.row.label}`;
  if (row.kind === 'crew') return `crew:${row.crew.tag}:${row.crew.label}`;
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
  const crew = given?.crew ?? live.crew;
  const elsewhereCount = given?.elsewhereCount ?? live.elsewhereCount;
  const pendingMore = given?.pendingMore ?? live.pendingMore;
  const loading = given === undefined && live.logs === null;

  const selectable: SelectableRow[] = useMemo(
    () => [
      ...flat.map(f => ({ kind: 'session' as const, flat: f })),
      ...crew.map(c => ({ kind: 'crew' as const, crew: c })),
      ...(projects ?? []).map(project => ({ kind: 'project' as const, project })),
    ],
    [flat, crew, projects],
  );

  const [prune, setPrune] = useState<
    | { stage: 'card'; offer: PruneOffer; answer: 'no' | 'yes' }
    | { stage: 'deleting' }
    | { stage: 'receipt'; receipt: PruneReceipt }
    | null
  >(null);
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
    setPrune({ stage: 'card', offer, answer: 'no' });
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
      if (key.upArrow || key.downArrow) {
        const offered = prune.offer.candidates.length > 0;
        setPrune({ ...prune, answer: offered && prune.answer === 'no' ? 'yes' : 'no' });
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
    const log = row.kind === 'session' ? row.flat.row.log : row.crew.log;
    const title = row.kind === 'session' ? row.flat.row.label : row.crew.label;
    return {
      pending: 'opening…',
      result: (async (): Promise<string | null> => {
        try {
          const sessionId = getSessionIdFromLog(log);
          if (!sessionId) return 'could not resume — the row carries no session id';
          const hop = await import('../services/switchboard/hopIntoSession.js');
          const outcome = await hop.focusResumedSession(String(sessionId), log.fullPath, {
            title,
            permissionMode: permissionModeRef.current,
          });
          if (!outcome.ok) return outcome.reason;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
        enterRootRepl();
        return null;
      })(),
    };
  };

  const birthRow = (): AsyncListNote => ({
    pending: 'starting a session…',
    result: (async (): Promise<string | null> => {
      const { bornSession } = await import('../services/switchboard/bornSession.js');
      const born = await bornSession({ workspaceDir: getCwd() });
      if (!born.ok) return born.reason;
      enterRootRepl();
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
            return 'the prune door offers the whole scope — walk back out of the project filter first';
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

  const selectedId = selected !== null ? selectableIdOf(selected) : null;
  useEffect(() => {
    if (selected?.kind === 'project') {
      if (projectFilter?.dir !== selected.project.dir) setProjectFilter(selected.project);
    } else if (selected !== null && projectFilter !== null) {
      setProjectFilter(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);
  const anchorIdRef = useRef<string | null>(null);
  anchorIdRef.current = selectedId;
  useEffect(() => {
    const want = anchorIdRef.current;
    if (want === null) return;
    const at = selectable.findIndex(r => selectableIdOf(r) === want);
    if (at !== -1 && at !== list.selectedIndex) list.moveTo(at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectable]);

  useInput(
    (_input, key, event) => {
      if (!key.tab) return;
      event.stopImmediatePropagation();
      const projStart = flat.length + crew.length;
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
  const mainModel = useMainLoopModel();

  const menuM = useMemo(() => {
    const critterKey = getSessionCritterKey();
    const environment = {
      model: renderModelChip(mainModel),
      critter: critterKey.charAt(0).toUpperCase() + critterKey.slice(1),
      critterHue: getSessionAccent().accent,
      dirBase: basename(getCwd()) || getCwd(),
      dirTail: '',
    };
    const entries: ResumeEntry[] = [
      ...flat.map(resumeEntryOf),
      ...(scope === 'project' && elsewhereCount > 0 ? [resumeElsewhereEntry(elsewhereCount)] : []),
      ...crew.map(resumeCrewEntryOf),
      ...(projects ?? []).map(resumeProjectEntryOf),
    ];
    const entryIndexOf = (i: number): number =>
      i < flat.length ? i : i + (scope === 'project' && elsewhereCount > 0 ? 1 : 0);
    const statusRight =
      list.note ??
      resumeStatusLine({
        loading,
        count: flat.length,
        crewCount: crew.length,
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
      summaryTitle: merged ? 'SESSIONS · PROJECTS' : 'SESSIONS',
      summaryRows: resumeSummaryRows({
        scope,
        count: flat.length,
        crewCount: crew.length,
        elsewhereCount,
        pendingMore,
        ...(merged ? { projectsCount: projects?.length ?? 0 } : {}),
      }),
      environment,
      statusRight,
      glowWord: wordGlow,
      legend: resumeLegendOf(scope, selectable.length > 0, merged),
      ...(selected === null
        ? { detailOverride: loading ? ['reading the session store…'] : resumeEmptyDetailLines(scope, elsewhereCount) }
        : {
            detailOverride:
              selected.kind === 'session'
                ? resumeDetailLines(selected.flat)
                : selected.kind === 'crew'
                  ? resumeCrewDetailLines(selected.crew)
                  : resumeProjectDetailLines(selected.project),
          }),
      ...(pruneOverride ?? {}),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat, crew, elsewhereCount, pendingMore, loading, scope, selected, selectable.length, list.selectedIndex, list.note, prune, mainModel, wordGlow?.peakCell, wordGlow?.gainLevel]);

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

  const elsewhereAt = scope === 'project' && elsewhereCount > 0 ? flat.length : -1;
  const listIndexOf = (entryIdx: number): number => {
    if (entryIdx === elsewhereAt) return -1;
    return elsewhereAt >= 0 && entryIdx > elsewhereAt ? entryIdx - 1 : entryIdx;
  };
  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {Array.from({ length: rows }, (_, i) => {
        const line = composition.placed[i] ?? '';
        const entryIdx = composition.entryAt.get(i);
        const rowIdx = entryIdx !== undefined ? listIndexOf(entryIdx) : -1;
        const row = rowIdx >= 0 ? selectable[rowIdx] : undefined;
        if (row !== undefined) {
          const props = list.rowProps(row, rowIdx);
          const hoverLabel =
            row.kind === 'session' ? row.flat.row.label : row.kind === 'crew' ? row.crew.label : row.project.base;
          return (
            <InteractiveRow
              key={props.id}
              id={props.id}
              selected={props.selected}
              unavailable={props.unavailable}
              onSelect={props.onSelect}
              onActivate={props.onActivate}
              selectionBand={false}
              hoverStyle="chrome-ink"
              height={1}
            >
              {hover => renderSceneLine(line, hover && !props.selected ? { label: hoverLabel, color: t.info } : undefined)}
            </InteractiveRow>
          );
        }
        return (
          <Box key={`resumeline-${i}`} height={1} flexShrink={0}>
            {line.length > 0 ? renderSceneLine(line) : null}
          </Box>
        );
      })}
    </Box>
  );
}
