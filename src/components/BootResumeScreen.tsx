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

/**
 * BootResumeScreen — the Boot face's OWN resume entrance (the operator's
 * face-doors ruling): the face's "Resume Session" row opens THIS
 * screen in place — a face-internal layer beside the settings, MCPs & Skills
 * and health layers, composed by the ONE shared core through the ratified
 * boot-menu design (composeBootMenu), so the session picker sits "within the
 * containers and style of the main menu" as ruled. CANCEL/esc returns to the
 * face rows with zero chat-chrome flash — the route never leaves
 * 'boot-settings' for a browse.
 *
 * PICKING is still a REAL chat journey (ruling 2, Law 9): ↵ opens the chosen
 * session through the estate's one resume door (focusResumedSession — the
 * same door the in-chat switcher, the --resume boot and the Projects row
 * ride), then steps onto the chat route with the session PRESENT — the chat
 * stop appears on the strip exactly as today. A refused landing paints its
 * reason ON the row and the face stays; nothing armed, nothing flashed.
 *
 * ONE PICKER CORE, TWO SKINS (ruling 4): the rows are sessionPickerModel's —
 * the same load, projection, scope partition, cleared marks and crew split
 * the in-chat switcher presents; this file owns only the face skin. Scope
 * starts at the FULL history ('all' — parity with the argless /resume the
 * face's row used to arm) and `a` flips to this project and back, exactly
 * the in-chat grammar. `n` births a fresh session in place through the
 * face's own birth door.
 */

/** The rows a proof/still injects — the screen then runs NO store load. */
export interface BootResumePickerModel {
  flat: SessionPickerFlatRow[];
  crew: SessionPickerCrewRow[];
  elsewhereCount: number;
  pendingMore: number;
}

interface BootResumeScreenProps {
  onClose?: () => void;
  /** The persistent Boot scene contract: the screen owns the whole viewport
   *  on the shared flat ground, exactly like the settings layer. */
  fullScene?: { columns: number; rows: number };
  /** Injected rows — a proof/still hands them; absent ⇒ the live model. */
  model?: BootResumePickerModel;
  /** The opening scope (default 'all' — the argless-/resume parity). */
  initialScope?: SessionScope;
  /** THE SECOND ACT (the operator's merge): the face's project rows — ONE
   *  gather, handed down (the face owns scanBootCardFacts). Present ⇒ the
   *  PROJECTS container composes below the sessions; absent ⇒ the screen
   *  is the landed sessions picker, byte-for-byte. */
  projects?: ReadonlyArray<BootProjectFact & { running?: number }>;
  /** The face's ONE project landing (trust-gate → ground → the one resume
   *  door / the card-aware hop / a birth) — never re-implemented here. ↵
   *  on a project row rides it; the refusal paints ON the row. */
  openProject?: (p: BootProjectFact) => AsyncListNote;
}

/** One composer entry shape (structurally what composeBootMenu consumes). */
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

/** An operator session as a control-plane row (pure; the stills compose the
 *  same): grouped under its PROJECT (the group boundary IS the in-chat
 *  head mark), the seen age as the value — a deliberately /clear'ed session
 *  wears its mark beside the age ('all' scope truth), and stands out. */
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

/** A router-crew transcript row (pure): classed apart under its own title,
 *  navigable — reading a crew transcript is inspection, not switching. */
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

/** The honest other-repos count (project scope; pure): an inert line — `a`
 *  is the reach, exactly the in-chat sentence. */
export function resumeElsewhereEntry(count: number): ResumeEntry {
  return {
    label: `+${count} in other project${count === 1 ? '' : 's'} — a shows all history`,
    group: 'elsewhere',
    // lowercase like its 'router crews' and 'projects' siblings — the one
    // authored-title casing on this screen (lead-ruled
    // minimal-diff).
    groupTitle: 'elsewhere',
    summary: '',
    valueLabel: '',
    valueIsDefault: true,
    pinnedVal: null,
    detail: null,
    inert: true,
  };
}

/** The selected row's trail (pure; SETTING DETAIL body): what ↵ does, the
 *  session's project, age, the cleared truth. */
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

/** The crew row's trail (pure). */
export function resumeCrewDetailLines(c: SessionPickerCrewRow): string[] {
  return [
    `crew seat: ${c.tag}`,
    `last seen: ${c.seen}`,
    '',
    'a router-crew transcript — ↵ opens it',
    'for inspection as a real chat.',
  ];
}

// ── THE PROJECTS CONTAINER (the second act): the face's project rows as
//    the trailing section — one selection highlight walks both containers;
//    highlighting a project FILTERS the sessions above to that repo; ↵ is
//    the face's own landing (openProject — one verb, two granularities). ──

/** A project row's entry (pure; the stills compose the same). */
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

/** The project row's trail (pure): the dir, the age, the landing truth. */
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

/** The empty detail body per scope (pure). */
export function resumeEmptyDetailLines(scope: SessionScope, elsewhereCount: number): string[] {
  return scope === 'project' && elsewhereCount > 0
    ? ['no sessions in this project yet', '', `${elsewhereCount} in other projects — a shows`, 'the full history.', '', 'n births a fresh session here']
    : ['nothing to resume yet', '', 'n births a fresh session here —', 'the chat, the session and the board', 'row come into being together.'];
}

/** The SESSIONS panel rows (pure; the stills compose the same). The
 *  second act adds the repos count exactly when the projects container
 *  exists — absent, the panel is the landed bytes. */
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

/** The status bar's standing line (pure; the pin reads it). A live
 *  project filter names itself — the list above is that repo alone. */
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

/** The list keys (pure): only the moves that exist. `d prune` rides both
 *  arms — the door opens on an empty offer too, and says so honestly. The
 *  second act adds the container jump exactly when projects exist. */
export function resumeLegendOf(scope: SessionScope, hasRows: boolean, projectsPresent = false): string {
  const flip = scope === 'all' ? 'a this project' : 'a all history';
  const jump = projectsPresent ? ' · ⇥ repos' : '';
  return hasRows
    ? `↑↓ move · ↵ open · n new session · d prune · ${flip}${jump} · esc back`
    : `n new session · d prune · ${flip}${jump} · esc back`;
}

// ── THE PRUNE DOOR on the face (lead-ruled
//    Option A over the one-caller law): the face's resume screen
//    is the SECOND named operator-pressed card of the ONE deleting door —
//    the same typed grammar as the /sessions card (frozen offer at open,
//    default No, esc/n leave, one commit road, the typed receipt), pinned
//    with the same needles by prove-status-prune. The picker CORE never
//    reaches the door: dropSessions is a list-state mirror only. ─────────

/** The offer's scope in the operator's words — the /sessions card's exact
 *  spellings (one vocabulary across both skins; pinned). */
export function pruneScopeLabelOf(scope: SessionScope): string {
  return scope === 'project'
    ? "this project's listed chats"
    : 'the full history (every project, cleared included)';
}

const agoShort = (d: Date, nowMs?: number): string =>
  formatRelativeTimeAgo(d, { style: 'short', ...(nowMs !== undefined ? { now: new Date(nowMs) } : {}) });

/** The typed confirmation card as SETTING DETAIL rows (pure; the stills
 *  compose it): the frozen set named in full, No leading and default, the
 *  never-remembered sentence — the /sessions card's own vocabulary. */
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

/** The typed receipt rows (pure): count · bytes freed · when · whose act —
 *  failures stay listed, honestly. */
export function pruneReceiptLines(receipt: PruneReceipt, nowMs?: number): string[] {
  return [
    "pruned · the operator's own act",
    '',
    `deleted ${receipt.deleted} transcript${receipt.deleted === 1 ? '' : 's'}`,
    `freed ${formatFileSize(receipt.bytesFreed)} · ${agoShort(receipt.at, nowMs)} · by the operator`,
    ...(receipt.failed > 0 ? [`${receipt.failed} could not be deleted — still listed`] : []),
  ];
}

/** The door's keys per stage (pure) — the /sessions footers' spellings. */
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

/** The selectable row's stable id (the cursor re-anchors by it when the
 *  filter resizes the sessions block — an index would slide). */
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

  // THE FILTER (the second act's sweetener): the highlighted project scopes
  // the sessions container. Derived from the SELECTION (stored so the
  // resize can re-anchor the cursor); cleared the moment the cursor walks
  // back into the sessions/crew.
  const [projectFilter, setProjectFilter] = useState<(BootProjectFact & { running?: number }) | null>(null);

  // THE ROW MODEL — the one picker core (an injected model runs no load;
  // the live filter rides the core's own filterDir fact; an injected model
  // filters through the SAME landed matcher).
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

  // THE PRUNE DOOR (the /sessions card's twin — the second named caller of
  // the one deleting door): the card FREEZES its offer at open from the
  // rows THIS list shows as sessions (crew transcripts are never offered),
  // starts answered No, answers No on esc/n, and remembers nothing. Only
  // the highlighted Yes calls the door; the receipt stage paints the typed
  // receipt after; the model's dropSessions mirrors exactly the deleted set.
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
    // Drop exactly the deleted transcripts from the list — the model's
    // mirror of what the door removed; failures stay listed, honestly.
    live.dropSessions(new Set(receipt.deletedSessionIds));
    setPrune({ stage: 'receipt', receipt });
  }
  // The door's stages own every key while open. CARD: ↑↓ move between No
  // and Yes, ↵ commits the highlighted answer, esc / n answer No — nothing
  // is deleted on any road but the highlighted Yes. DELETING: keys wait.
  // RECEIPT: ↵ / esc close it. Nothing here is ever remembered.
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

  // The boot's resolved permission posture rides every face resume road
  // (C6 — parity with the blank chat's first message and the boot's own
  // --resume); a ref so the async landing reads the press-time truth.
  const permissionMode = useAppStateMaybeOutsideOfProvider(state => state.toolPermissionContext.mode);
  const permissionModeRef = useRef(permissionMode);
  permissionModeRef.current = permissionMode;

  // ↵ — THE REAL CHAT JOURNEY (ruling 2): the estate's one resume door,
  // then the plain (unarmed) step onto the chat route with the session
  // PRESENT. A refusal paints on the row; the face stays. The landed
  // precedent is the face's own Projects row (openProject).
  const openRow = (row: SelectableRow): AsyncListNote | null => {
    if (row.kind === 'project') {
      // The face's ONE landing (openProject) — trust-gate, ground, the one
      // resume door / the card-aware hop / a birth; the refusal paints ON
      // the row. Never re-implemented here.
      return openProject?.(row.project) ?? null;
    }
    const log = row.kind === 'session' ? row.flat.row.log : row.crew.log;
    const title = row.kind === 'session' ? row.flat.row.label : row.crew.label; // project rows returned above
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
          // fail-soft: the face stays; the row is re-pressable
          return e instanceof Error ? e.message : String(e);
        }
        enterRootRepl();
        return null;
      })(),
    };
  };

  // n — a fresh session in place (the face's own birth door; runRow 'new').
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
    // The prune door owns input while open (its esc closes the door first,
    // never the screen — the manager's layering law).
    active: prune === null,
    onClose: () => onClose?.(),
    actions: [
      { key: 'return', hint: 'open', run: r => (r === null ? null : openRow(r)) },
      { key: 'n', hint: 'new session', run: () => birthRow() },
      {
        key: 'd',
        hint: 'prune',
        run: () => {
          // The door — operator-pressed, never automatic. Opens the typed
          // confirmation card; nothing happens before the card. Under a
          // PROJECT FILTER the door refuses honestly: its card's scope
          // vocabulary is the one deleting door's PINNED grammar, and a
          // filtered list must never freeze an offer the words would
          // misname (move back to the sessions to prune the scope whole).
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

  // THE FILTER FOLLOWS THE HIGHLIGHT (the second act): the cursor standing
  // on a project row filters the sessions above to that repo; walking back
  // out clears it. The filter RESIZES the sessions block, so the cursor
  // re-anchors BY ID after every recomposition (an index would slide onto
  // a different row as the list shrinks or grows back).
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

  // ⇥ jumps between the two containers (its own key beside the list — the
  // ← precedent; ↑↓ walk across the boundary freely, one highlight).
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

  // ← is the advertised close synonym on vertical face lists (the in-chat
  // picker's own grammar; the vertical list decodes no horizontal motion).
  useInput(
    (_input, key, event) => {
      if (!key.leftArrow) return;
      event.stopImmediatePropagation();
      onClose?.();
    },
    { isActive: prune === null },
  );

  // ── the ratified composition (the ONE shared design) ─────────────────────
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
    // The list's index counts selectable rows; the inert elsewhere line
    // sits between the sessions and the crew in the composition.
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
    // The prune door's stages own the SETTING DETAIL body and the legend
    // while open (the kit prompt's layering) — the list beneath keeps its
    // composition and returns whole on esc.
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
      // The merged identity arrives WITH the projects container (the card
      // recut's wiring); a projects-less mount is the landed picker whole.
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

  // Pointer parity (the manager's grammar): composed entry index → the
  // selectable list index (the inert elsewhere line mounts no target).
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
