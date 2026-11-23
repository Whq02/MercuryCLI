import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useInput } from '../ink.js';
import { createSplashCore, WORD_W } from '../../assets/splash/splash-core.mjs';
import { readSessionWorkers } from '../daemon/concourseWorkers.js';
import { formatRelativeTimeAgo } from '../utils/format.js';
import {
  fireDeltaWords,
  saturnFactsOf,
  saturnNextFireMs,
  saturnStandingFireWords,
  saturnStandingOf,
  saturnStandingWords,
  type HeldFireV1,
  type SaturnFactsRowV1,
  type SaturnScheduleV1,
  type SaturnWhenV1,
  type ScheduleAccountV1,
  type ScheduleAccountVerdictV1,
} from '../daemon/saturn.js';
import { deriveScheduleAccountForModel, readLiveAccountFacts, scheduleAccountVerdict } from '../daemon/saturnAccount.js';
import { readBoxSchedules, removeBoxSchedule, setBoxSchedulePaused } from '../daemon/saturnBoxSchedules.js';
import { WHEN_SPELLING_EXAMPLES } from '../services/saturn/whenSpelling.js';
import { listKitPresets } from '../services/mcp/presetStore.js';
import { getModelOptions, KEY_CONNECT_PREFIX } from '../services/model/modelOptions.js';
import { readSessionReceipts, type SessionReceiptEntry } from '../services/switchboard/sessionReceipts.js';
import { accountIdentityShown } from '../services/wallet/identityWords.js';
import { getProjectDir } from '../utils/sessionStorage/paths.js';
import { workedInProjects } from '../utils/bootCardFacts.js';
import { useEngineModel } from '../hooks/useEngineModel.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { wrapPlain } from './BootHealthScreen.js';
import { keyHintLabel } from './mercury-ui/keyHintLabel.js';
import { useGreetingShimmer } from './mercury-ui/useGreetingShimmer.js';
import { useInteractiveList } from './mercury-ui/useInteractiveList.js';
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js';
import { useSplashCoreAccent } from './mercury-ui/useSplashCoreAccent.js';
import { LOCAL_PULL_RECOMMENDATION } from '../services/providers/local/localAccounts.js';
import { LOCAL_SETUP_OFFER } from '../commands/localsetup/words.js';
import { clearFormRowOf, commitPromptOf, editFormRowOf, runNowOf, scheduleEditRpcOf, submitFormOf, type SaturnFormRowId } from './bootSaturn/actions.js';
import { saturnMenuOf, saturnRowsView } from './bootSaturn/menu.js';
import { errorMessage, getErrnoCode } from '../utils/errors.js';
import { passedOver } from '../utils/passedOver.js';
import { logError } from '../utils/log.js';


const DETAIL_W = 38;

export interface SaturnScreenRowV1 {
  sessionTitle: string;
  sessionId: string;
  workspaceId: string;
  parked: boolean;
  box?: true;
  facts: SaturnFactsRowV1;
  schedule: SaturnScheduleV1;
  held: HeldFireV1[];
}

export interface SaturnScreenFactsV1 {
  rows: SaturnScreenRowV1[];
  heldTotal: number;
  sessions: number;
  daemonReadable: boolean;
}

export function sortForBoard(rows: SaturnScreenRowV1[]): SaturnScreenRowV1[] {
  const MAX = Number.MAX_SAFE_INTEGER;
  const groupKey = (r: SaturnScreenRowV1): string => (r.box === true ? 'box' : r.sessionId);
  const soonest = new Map<string, number>();
  for (const r of rows) {
    const k = groupKey(r);
    soonest.set(k, Math.min(soonest.get(k) ?? MAX, r.facts.nextFireMs ?? MAX));
  }
  return [...rows].sort((a, b) => {
    const ka = groupKey(a);
    const kb = groupKey(b);
    if (ka !== kb) {
      const ga = soonest.get(ka)!;
      const gb = soonest.get(kb)!;
      if (ga !== gb) return ga - gb;
      return ka < kb ? -1 : 1;
    }
    return (a.facts.nextFireMs ?? MAX) - (b.facts.nextFireMs ?? MAX);
  });
}

function collectSaturnScreenFacts(nowMs: number): SaturnScreenFactsV1 {
  try {
    const records = Object.values(readSessionWorkers()).filter(r => r.endedAt === undefined);
    const rows: SaturnScreenRowV1[] = [];
    let heldTotal = 0;
    for (const rec of records) {
      const facts = saturnFactsOf(rec, nowMs);
      heldTotal += facts.heldFireCount ?? 0;
      for (const f of facts.schedules ?? []) {
        const schedule = rec.schedules?.find(s => s.id === f.id);
        if (schedule === undefined) continue;
        rows.push({
          sessionTitle: rec.title ?? rec.runnerId,
          sessionId: rec.sessionId,
          workspaceId: rec.workspaceId,
          parked: rec.parkedAt !== undefined || rec.stoppedAt !== undefined,
          facts: f,
          schedule,
          held: (rec.heldFires ?? []).filter(h => h.scheduleId === f.id),
        });
      }
    }
    const box = readBoxSchedules();
    const boxFacts = saturnFactsOf(box, nowMs);
    heldTotal += boxFacts.heldFireCount ?? 0;
    for (const f of boxFacts.schedules ?? []) {
      const schedule = box.schedules.find(s => s.id === f.id);
      if (schedule === undefined) continue;
      rows.push({
        sessionTitle: 'box',
        sessionId: `box:${f.id}`,
        workspaceId: schedule.action.kind === 'birth' ? schedule.action.birth.workspaceDir : '',
        parked: false,
        box: true,
        facts: f,
        schedule,
        held: box.heldFires.filter(h => h.scheduleId === f.id),
      });
    }
    return { rows: sortForBoard(rows), heldTotal, sessions: records.length, daemonReadable: true };
  } catch {
    return { rows: [], heldTotal: 0, sessions: 0, daemonReadable: false };
  }
}

export { fireDeltaWords };

export function saturnNextFireWords(facts: SaturnFactsRowV1, nowMs: number): string {
  return facts.paused === true ? 'paused' : fireDeltaWords(facts.nextFireMs, nowMs);
}

function saturnRowFireWords(row: SaturnScreenRowV1, nowMs: number): string {
  return saturnStandingFireWords(saturnStandingOf(row.schedule, row.held), nowMs);
}

type SaturnEntry = {
  label: string;
  group: string;
  groupTitle: string;
  summary: string;
  valueLabel: string;
  valueIsDefault: boolean;
  pinnedVal: null;
  detail: null;
  inert?: boolean;
};

const clampText = (s: string, w: number): string => (s.length > w ? s.slice(0, w - 1) + '…' : s);

export function saturnEntryOf(row: SaturnScreenRowV1, nowMs: number): SaturnEntry {
  const standing = saturnStandingOf(row.schedule, row.held);
  const words = saturnStandingWords(standing, nowMs);
  return {
    label: `${row.facts.id}  ${clampText(row.facts.when, 34)}`,
    group: row.box === true ? 'box' : row.sessionId,
    groupTitle: row.box === true ? 'box (machine)' : `${row.sessionTitle}${row.parked ? ' · parked' : ''}`,
    summary: `${row.facts.kind} · ${words}`,
    valueLabel: words,
    valueIsDefault: standing.held === 0 && !standing.paused && standing.nextFireMs !== null,
    pinnedVal: null,
    detail: null,
  };
}

export function saturnDetailLines(row: SaturnScreenRowV1, nowMs: number, receipts: SessionReceiptEntry[]): string[] {
  const s = row.schedule;
  const lines: string[] = [`${row.facts.id} · ${row.facts.kind}${row.box === true ? ' · box tier' : ''}`, ''];
  lines.push(...wrapPlain(`when: ${row.facts.when}`, DETAIL_W));
  lines.push(`next: ${saturnRowFireWords(row, nowMs)}`);
  lines.push(`last: ${s.lastFiredAt !== undefined ? formatRelativeTimeAgo(new Date(s.lastFiredAt), { style: 'short', now: new Date(nowMs) }) : 'never'}`);
  lines.push(`model: ${s.modelKey}${s.effort !== undefined ? ` · ${s.effort}` : ''}`);
  lines.push(...wrapPlain(`account: ${s.account.family}/${s.account.source}${s.account.identity !== undefined && accountIdentityShown() ? ` · ${s.account.identity}` : ''}`, DETAIL_W));
  lines.push(`preflight at write: ${s.preflightAtWrite !== undefined ? s.preflightAtWrite.state : 'not computed'}`);
  if (s.action.kind === 'birth') {
    const b = s.action.birth;
    lines.push('');
    lines.push(...wrapPlain(`birth: ${b.presence} in ${b.workspaceDir}`, DETAIL_W));
    if (b.kitPreset !== undefined) lines.push(...wrapPlain(`wearing: preset '${b.kitPreset}'`, DETAIL_W));
    lines.push(b.opening !== undefined ? 'born-working (opening mission set)' : 'born-waiting');
  }
  if (row.held.length > 0) {
    lines.push('');
    lines.push(`held fires: ${row.held.length}`);
    for (const h of row.held.slice(0, 3)) {
      lines.push(...wrapPlain(`· ${h.reason} — due ${formatRelativeTimeAgo(new Date(h.dueAt), { style: 'short', now: new Date(nowMs) })}`, DETAIL_W));
      if (typeof h.detail === 'string' && h.detail !== '') lines.push(...wrapPlain(h.detail, DETAIL_W));
    }
  }
  if (s.note !== undefined) {
    lines.push('');
    lines.push(...wrapPlain(`note: ${s.note}`, DETAIL_W));
  }
  if (receipts.length > 0) {
    lines.push('');
    lines.push('recent fire decisions:');
    for (const r of receipts) lines.push(...wrapPlain(`· ${r.summary}`, DETAIL_W));
  }
  return lines;
}

export function saturnSummaryRows(f: SaturnScreenFactsV1, nowMs: number): Array<{ key: string; value: string; tone?: 'teal' | 'amber' | 'crimson' | 'faint' }> {
  const soonest = f.rows
    .map(r => saturnStandingOf(r.schedule, r.held).nextFireMs)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b)[0];
  return [
    { key: 'Schedules', value: `${f.rows.length}` },
    { key: 'Next fire', value: soonest !== undefined ? fireDeltaWords(soonest, nowMs) : '—' },
    {
      key: 'Held',
      value: f.heldTotal > 0 ? `${f.heldTotal} — /logins releases sign-in holds` : '0',
      ...(f.heldTotal > 0 ? { tone: 'amber' as const } : {}),
    },
    { key: 'Sessions', value: `${f.sessions} live`, tone: 'faint' },
  ];
}

export function saturnLegendOf(state: { busy: boolean }): string {
  if (state.busy) return 'working… (the screen settles before the next key)';
  return '↑↓ move · pgup/pgdn page · a schedule birth… · x delete · n run-now · p pause/resume · r refresh · esc back';
}

export function saturnStatusLine(f: SaturnScreenFactsV1): string {
  if (!f.daemonReadable) return "the daemon's records are not readable here — start Mercury's daemon and press r";
  if (f.rows.length === 0) {
    return f.sessions === 0
      ? 'no live sessions hold schedules'
      : `no schedules on ${f.sessions} live session${f.sessions === 1 ? '' : 's'}`;
  }
  return `${f.rows.length} schedule${f.rows.length === 1 ? '' : 's'} · ${f.heldTotal} held · read-only until a verb`;
}

export function saturnEmptyDetailLines(f: SaturnScreenFactsV1): string[] {
  if (!f.daemonReadable) {
    return ["the daemon's records are not readable here —", 'start the daemon and press r.'];
  }
  return [
    'no schedules stand.',
    '',
    ...wrapPlain(`press ${keyHintLabel('a')} to schedule a session birth — a fresh session born on the clock.`, DETAIL_W),
    '',
    ...wrapPlain('a session schedules itself too (its own tools, the set-schedule door); every schedule and its fire decisions land here.', DETAIL_W),
  ];
}


export interface SaturnFormStateV1 {
  when: string;
  modelKey: string;
  workspaceDir: string;
  presence: 'headless' | 'screen-present';
  kitPreset: string | null;
  opening: string | null;
  title: string | null;
  note: string | null;
}

export const SATURN_FORM_ROWS: readonly SaturnFormRowId[] = ['when', 'model', 'workspace', 'presence', 'kit', 'opening', 'title', 'note'];

export function freshSaturnForm(defaults: { modelKey: string; workspaceDir: string }): SaturnFormStateV1 {
  return {
    when: '',
    modelKey: defaults.modelKey,
    workspaceDir: defaults.workspaceDir,
    presence: 'headless',
    kitPreset: null,
    opening: null,
    title: null,
    note: null,
  };
}


export const SATURN_WORKSPACE_CUSTOM_ROW = 'custom path…';

export function saturnWorkspacePickOptions(projectDirs: string[]): string[] {
  return [...new Set(projectDirs)].concat(SATURN_WORKSPACE_CUSTOM_ROW);
}


export const SATURN_OPENING_NONE_ROW = 'born-waiting — no mission';
export const SATURN_OPENING_AUDIT_ROW = 'audit';
export const SATURN_OPENING_REVIEW_ROW = 'review';
export const SATURN_OPENING_CUSTOM_ROW = 'custom…';

export const SATURN_AUDIT_MISSION =
  'Audit this workspace: sweep the recent changes and the checks that guard them, verify what they claim against the tree, and write your findings — with file references — into the transcript.';
export const SATURN_REVIEW_MISSION =
  'Review the recent work in this workspace: read the latest commits, flag defects and risks with file references, and write the review into the transcript.';

export function saturnOpeningPickOptions(): string[] {
  return [SATURN_OPENING_NONE_ROW, SATURN_OPENING_AUDIT_ROW, SATURN_OPENING_REVIEW_ROW, SATURN_OPENING_CUSTOM_ROW];
}

export function saturnOpeningFromPick(row: string): string | null | 'custom' {
  if (row === SATURN_OPENING_AUDIT_ROW) return SATURN_AUDIT_MISSION;
  if (row === SATURN_OPENING_REVIEW_ROW) return SATURN_REVIEW_MISSION;
  if (row === SATURN_OPENING_CUSTOM_ROW) return 'custom';
  return null;
}

export function saturnOpeningRowIsCurrent(row: string, opening: string | null): boolean {
  if (row === SATURN_OPENING_NONE_ROW) return opening === null;
  if (row === SATURN_OPENING_AUDIT_ROW) return opening === SATURN_AUDIT_MISSION;
  if (row === SATURN_OPENING_REVIEW_ROW) return opening === SATURN_REVIEW_MISSION;
  return opening !== null && opening !== SATURN_AUDIT_MISSION && opening !== SATURN_REVIEW_MISSION;
}

export function saturnFormEntries(form: SaturnFormStateV1): SaturnEntry[] {
  const row = (
    id: SaturnFormRowId,
    label: string,
    groupTitle: string,
    valueLabel: string,
    valueIsDefault: boolean,
    summary: string,
  ): SaturnEntry => ({ label, group: groupTitle, groupTitle, summary, valueLabel, valueIsDefault, pinnedVal: null, detail: null });
  return [
    row('when', 'When', 'the birth', form.when === '' ? '— say when (↵)' : clampText(form.when, 28), form.when !== '', `e.g. ${WHEN_SPELLING_EXAMPLES.slice(0, 4).join(' · ')}`),
    row('model', 'Model', 'the birth', clampText(form.modelKey, 28), true, 'the model the session is born on (↵ picks)'),
    row('workspace', 'Workspace', 'the birth', clampText(form.workspaceDir, 28), true, 'the project it is born in (↵ picks; custom path too)'),
    row(
      'presence',
      'Presence',
      'the birth',
      form.presence === 'headless' ? 'headless — unattended' : 'screen-present — Mercury open',
      true,
      '↵ flips the arm',
    ),
    row('kit', 'Kit preset', 'born wearing', form.kitPreset ?? 'none', true, 'the extensions it is born wearing (↵ picks)'),
    row('opening', 'Opening mission', 'born wearing', form.opening !== null ? clampText(form.opening, 28) : 'born-waiting', true, '↵ picks: audit · review · custom — born-waiting when none'),
    row('title', 'Title', 'words', form.title ?? '(the door names it)', true, 'the born session’s name (↵ edits)'),
    row('note', 'Note', 'words', form.note ?? '—', true, 'a word for the board (↵ edits)'),
  ];
}

export interface SaturnFormPreflightV1 {
  derivation: { ok: true; account: ScheduleAccountV1 } | { ok: false; reason: string };
  verdict: ScheduleAccountVerdictV1 | null;
}

function livePreflightOf(modelKey: string, nextFireMs: number | null): SaturnFormPreflightV1 {
  try {
    const derivation = deriveScheduleAccountForModel(modelKey);
    if (!derivation.ok) return { derivation, verdict: null };
    const live = readLiveAccountFacts(derivation.account);
    return {
      derivation,
      verdict: scheduleAccountVerdict({ account: derivation.account, nextFireMs, nowMs: Date.now(), live }),
    };
  } catch (e) {
    return { derivation: { ok: false, reason: e instanceof Error ? e.message : String(e) }, verdict: null };
  }
}

export function saturnVerdictSentence(v: ScheduleAccountVerdictV1): string {
  switch (v.state) {
    case 'ready':
      return 'preflight: ready';
    case 'expiring':
      return `preflight: warned at schedule time — the sign-in's known expiry (${new Date(v.expiresAt).toISOString()}) lands before this fire; re-login by then or it fires held`;
    case 'expired':
      return "preflight: sign-in expired — re-login now (/logins) or it's born held";
    case 'signed-out':
      return "preflight: signed out — /logins connects an account, or it's born held";
    case 'unreachable':
      return `preflight: no local server answering — start it (or set MERCURY_LOCAL_BASE_URL), then ${LOCAL_PULL_RECOMMENDATION}, ${LOCAL_SETUP_OFFER}, or the fire is born held`;
    case 'rate-limited':
      return `preflight: rate-limited — a due fire holds until the window ends${v.retryAt !== undefined ? ` (~${new Date(v.retryAt).toISOString()})` : ''}`;
  }
}

export function saturnFormDetailLines(
  form: SaturnFormStateV1,
  compiled: { ok: true; when: SaturnWhenV1 } | { ok: false; reason: string } | null,
  preflight: SaturnFormPreflightV1 | null,
  nowMs: number,
): string[] {
  const lines: string[] = ['schedule a birth', ''];
  if (compiled === null) {
    lines.push(...wrapPlain(`when: say when — e.g. ${WHEN_SPELLING_EXAMPLES.slice(0, 3).join(' · ')}`, DETAIL_W));
  } else if (!compiled.ok) {
    lines.push(...wrapPlain(`when: ${compiled.reason}`, DETAIL_W));
  } else {
    const next = saturnNextFireMs(compiled.when, nowMs);
    lines.push(...wrapPlain(`fires ${fireDeltaWords(next, nowMs)} (${form.when})`, DETAIL_W));
  }
  lines.push('');
  if (preflight === null) {
    lines.push('account: —');
  } else if (!preflight.derivation.ok) {
    lines.push(...wrapPlain(preflight.derivation.reason, DETAIL_W));
  } else {
    const a = preflight.derivation.account;
    lines.push(...wrapPlain(`account: ${a.family}/${a.source}${a.identity !== undefined && accountIdentityShown() ? ` · ${a.identity}` : ''}`, DETAIL_W));
    if (preflight.verdict !== null) lines.push(...wrapPlain(saturnVerdictSentence(preflight.verdict), DETAIL_W));
  }
  lines.push('');
  lines.push(
    ...wrapPlain(
      form.presence === 'headless'
        ? 'headless: fires whenever the daemon lives; receipts and the transcript are the record'
        : 'screen-present: fires only while Mercury is open on this box',
      DETAIL_W,
    ),
  );
  lines.push(form.opening !== null ? 'born-working: the opening mission is its first turn' : 'born-waiting: it appears and waits');
  lines.push('');
  lines.push(...wrapPlain('at fire time the session appears on the concourse, receipted "born by schedule"', DETAIL_W));
  return lines;
}

export function saturnFormLegendOf(state: { prompt: boolean; pick: boolean }): string {
  if (state.prompt) return 'type · ↵ set · esc cancel';
  if (state.pick) return '↑↓ move · pgup/pgdn page · ↵ pick · esc back';
  return '↑↓ move · pgup/pgdn page · ↵ edit · ⌫ clear · s schedule it · esc back';
}

interface BootSaturnScreenProps {
  onClose?: (value?: string) => void;
  fullScene?: { columns: number; rows: number };
  facts?: SaturnScreenFactsV1;
  nowMs?: number;
  receiptsOf?: (row: SaturnScreenRowV1) => SessionReceiptEntry[];
  modelOptionsOf?: () => string[];
  presetsOf?: () => string[];
  projectsOf?: () => string[];
  preflightOf?: (modelKey: string, nextFireMs: number | null) => SaturnFormPreflightV1;
}

export function liveReceiptsOf(row: SaturnScreenRowV1): SessionReceiptEntry[] {
  if (row.box === true) return [];
  try {
    return readSessionReceipts(getProjectDir(row.workspaceId), row.sessionId)
      .filter(
        e =>
          (e.kind === 'schedule-fire' || e.kind === 'schedule-held') &&
          (e.details as { scheduleId?: unknown } | undefined)?.scheduleId === row.facts.id,
      )
      .slice(-4);
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return [];
    logError(error);
    return [
      {
        at: '',
        by: 'saturn-screen',
        kind: 'schedule-held',
        summary: `fire history could not be read (${error instanceof Error ? error.message : String(error)}) — press r to retry`,
      },
    ];
  }
}

export function liveModelOptions(): string[] {
  return [
    ...new Set(
      getModelOptions()
        .map(o => o.value)
        .filter(v => v.length > 0 && !v.startsWith(KEY_CONNECT_PREFIX)),
    ),
  ];
}

export function livePresets(): string[] {
  return listKitPresets();
}

export function liveProjectDirs(): string[] {
  return workedInProjects().map(p => p.dir);
}

export function runSaturnFormRowEdit(run: () => void, setFormNote: (note: string | null) => void): void {
  try {
    run();
  } catch (error) {
    setFormNote(error instanceof Error ? error.message : String(error));
  }
}

function formPromptCap(field: SaturnFormRowId): number {
  switch (field) {
    case 'workspace':
      return 4096;
    case 'opening':
      return 20_000;
    case 'note':
      return 500;
    default:
      return 200;
  }
}

export function runBoxRemoveNote(scheduleId: string, dir?: string): string {
  try {
    const outcome = removeBoxSchedule(scheduleId, dir);
    return outcome === 'removed'
      ? `removed '${scheduleId}' — a box row; the next tick sees it`
      : `remove refused — no box schedule '${scheduleId}'`;
  } catch (error) {
    passedOver(error);
    return `schedule refused — ${errorMessage(error)}`;
  }
}

export function runBoxPauseResumeNote(scheduleId: string, paused: boolean, dir?: string): string {
  try {
    const outcome = setBoxSchedulePaused(scheduleId, paused, dir);
    return outcome === 'applied'
      ? `${paused ? 'paused' : 'resumed'} '${scheduleId}' — a box row; the next tick sees it`
      : outcome === 'noop'
        ? `already ${paused ? 'paused' : 'running'}`
        : `no box schedule '${scheduleId}'`;
  } catch (error) {
    passedOver(error);
    return `schedule refused — ${errorMessage(error)}`;
  }
}

export function BootSaturnScreen({ onClose, fullScene, facts: given, nowMs: givenNow, receiptsOf, modelOptionsOf, presetsOf, projectsOf, preflightOf }: BootSaturnScreenProps = {}): React.ReactNode {
  const t = useMercuryTokens();
  const { columns: termCols, rows: termRows } = useTerminalSize();
  const columns = fullScene?.columns ?? termCols;
  const rows = fullScene?.rows ?? Math.max(12, Math.min(24, termRows - 2));

  const [collected, setCollected] = useState<{ facts: SaturnScreenFactsV1; atMs: number }>(() => {
    const atMs = givenNow ?? Date.now();
    return { facts: given ?? collectSaturnScreenFacts(atMs), atMs };
  });
  const [note, setNote] = useState<string | null>(null);
  const busy = useRef(false);
  const facts = given ?? collected.facts;
  const nowMs = givenNow ?? collected.atMs;

  const [form, setForm] = useState<SaturnFormStateV1 | null>(null);
  const [formNote, setFormNote] = useState<string | null>(null);
  const [formPrompt, setFormPrompt] = useState<{ field: SaturnFormRowId; draft: string } | null>(null);
  const [formPick, setFormPick] = useState<{ field: 'model' | 'kit' | 'workspace' | 'opening'; options: string[] } | null>(null);
  const formPromptRef = useRef(formPrompt);
  formPromptRef.current = formPrompt;
  const mainModel = useEngineModel();

  const refresh = useCallback((): void => {
    const atMs = givenNow ?? Date.now();
    setCollected({ facts: given ?? collectSaturnScreenFacts(atMs), atMs });
  }, [given, givenNow]);

  const scheduleEditRpc = useCallback(
    (row: SaturnScreenRowV1, op: 'remove' | 'pause' | 'resume', pendingWord: string, doneWord: string): void => {
      scheduleEditRpcOf({ busy, setNote, refresh }, row, op, pendingWord, doneWord);
    },
    [refresh],
  );

  const runNow = useCallback(
    (row: SaturnScreenRowV1): void => {
      runNowOf({ busy, setNote, refresh }, row);
    },
    [refresh],
  );

  const boxRemove = (row: SaturnScreenRowV1): void => {
    setNote(runBoxRemoveNote(row.facts.id));
    refresh();
  };
  const boxPauseResume = (row: SaturnScreenRowV1): void => {
    setNote(runBoxPauseResumeNote(row.facts.id, row.facts.paused !== true));
    refresh();
  };

  const list = useInteractiveList<SaturnScreenRowV1>({
    rows: facts.rows,
    rowId: r => `saturn:${r.sessionId}:${r.facts.id}`,
    idNamespace: 'boot-saturn',
    active: form === null,
    onClose: () => onClose?.(),
    actions: [
      {
        key: 'a',
        hint: 'schedule birth…',
        run: () => {
          setFormNote(null);
          setForm(freshSaturnForm({ modelKey: mainModel, workspaceDir: process.cwd() }));
          return null;
        },
      },
      {
        key: 'x',
        hint: 'delete',
        run: r => {
          if (r === null) return null;
          if (r.box === true) boxRemove(r);
          else scheduleEditRpc(r, 'remove', 'removing', 'removed');
          return null;
        },
      },
      {
        key: 'n',
        hint: 'run-now',
        run: r => {
          if (r === null) return null;
          runNow(r);
          return null;
        },
      },
      {
        key: 'p',
        hint: 'pause/resume',
        run: r => {
          if (r === null) return null;
          if (r.box === true) boxPauseResume(r);
          else if (r.facts.paused === true) scheduleEditRpc(r, 'resume', 'resuming', 'resumed');
          else scheduleEditRpc(r, 'pause', 'pausing', 'paused');
          return null;
        },
      },
      {
        key: 'r',
        hint: 'refresh',
        run: () => {
          setNote(null);
          refresh();
          return null;
        },
      },
    ],
  });
  const selected = list.selectedRow;

  const commitPrompt = (field: SaturnFormRowId, draft: string): void => {
    commitPromptOf({ setForm }, field, draft);
  };

  const editFormRow = (id: SaturnFormRowId): void => {
    runSaturnFormRowEdit(
      () => editFormRowOf({ form, setFormNote, setFormPrompt, setFormPick, modelOptionsOf, liveModelOptions, saturnWorkspacePickOptions, projectsOf, liveProjectDirs, setForm, presetsOf, livePresets, saturnOpeningPickOptions }, id),
      setFormNote,
    );
  };

  const clearFormRow = (id: SaturnFormRowId): void => {
    clearFormRowOf({ setForm }, id);
  };

  const submitForm = (): void => {
    submitFormOf({ form, setFormNote, setForm, setFormPrompt, setFormPick, setNote, refresh });
  };

  const formList = useInteractiveList<SaturnFormRowId>({
    rows: SATURN_FORM_ROWS,
    rowId: r => `saturn-form:${r}`,
    idNamespace: 'boot-saturn-form',
    active: form !== null && formPrompt === null && formPick === null,
    onClose: () => {
      setForm(null);
      setFormNote(null);
    },
    actions: [
      {
        key: 'return',
        hint: 'edit',
        run: r => {
          if (r !== null) editFormRow(r);
          return null;
        },
      },
      {
        key: 'backspace',
        hint: 'clear',
        run: r => {
          if (r !== null) clearFormRow(r);
          return null;
        },
      },
      {
        key: 's',
        hint: 'schedule it',
        run: () => {
          submitForm();
          return null;
        },
      },
    ],
  });

  const pickList = useInteractiveList<string>({
    rows: formPick?.options ?? [],
    rowId: r => `saturn-pick:${r}`,
    idNamespace: 'boot-saturn-pick',
    active: formPick !== null,
    onClose: () => setFormPick(null),
    actions: [
      {
        key: 'return',
        hint: 'pick',
        run: r => {
          if (r === null) return null;
          const field = formPick?.field;
          if (field === undefined) return null;
          if (field === 'workspace' && r === SATURN_WORKSPACE_CUSTOM_ROW) {
            setFormPick(null);
            setFormPrompt({ field: 'workspace', draft: form?.workspaceDir ?? '' });
            return null;
          }
          if (field === 'opening') {
            const mapped = saturnOpeningFromPick(r);
            if (mapped === 'custom') {
              setFormPick(null);
              setFormPrompt({ field: 'opening', draft: form?.opening ?? '' });
              return null;
            }
            setForm(f => (f === null ? f : { ...f, opening: mapped }));
            setFormPick(null);
            return null;
          }
          setForm(f =>
            f === null
              ? f
              : field === 'model'
                ? { ...f, modelKey: r }
                : field === 'workspace'
                  ? { ...f, workspaceDir: r }
                  : { ...f, kitPreset: r === 'none' ? null : r },
          );
          setFormPick(null);
          return null;
        },
      },
    ],
  });

  useInput(
    (input, key, event) => {
      event.stopImmediatePropagation();
      const p = formPromptRef.current;
      if (p === null) return;
      if (key.escape) {
        setFormPrompt(null);
        return;
      }
      if (key.return) {
        commitPrompt(p.field, p.draft);
        setFormPrompt(null);
        return;
      }
      if (key.backspace || key.delete) {
        setFormPrompt({ ...p, draft: p.draft.slice(0, -1) });
        return;
      }
      if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
      if (input.length > 0 && !/[\x00-\x1f\x7f]/.test(input)) {
        setFormPrompt({ ...p, draft: (p.draft + input).slice(0, formPromptCap(p.field)) });
      }
    },
    { isActive: formPrompt !== null },
  );

  const { accent: coreAccent, rampStops } = useSplashCoreAccent();
  const core = useMemo(
    () => createSplashCore({ nocolor: false, truecolor: true, accent: coreAccent }),
    [coreAccent],
  );
  const wordGlow = useGreetingShimmer(rampStops, WORD_W);

  const menuM = useMemo(() => {
    return saturnMenuOf({ mainModel, saturnSummaryRows, facts, nowMs, wordGlow, form, givenNow, preflightOf, livePreflightOf, formPick, SATURN_WORKSPACE_CUSTOM_ROW, clampText, SATURN_OPENING_AUDIT_ROW, SATURN_AUDIT_MISSION, SATURN_OPENING_REVIEW_ROW, SATURN_REVIEW_MISSION, saturnOpeningRowIsCurrent, pickList, saturnFormLegendOf, saturnFormDetailLines, formPrompt, saturnFormEntries, formList, formNote, saturnEntryOf, list, note, saturnStatusLine, selected, saturnLegendOf, busy, saturnDetailLines, receiptsOf, liveReceiptsOf, saturnEmptyDetailLines });
  }, [facts, nowMs, selected, list.selectedIndex, list.note, note, mainModel, receiptsOf, form, formNote, formPrompt, formPick, formList.selectedIndex, pickList.selectedIndex, givenNow, preflightOf, wordGlow?.peakCell, wordGlow?.gainLevel]);

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

  const rowPropsAt = (entryIdx: number): { props: ReturnType<typeof list.rowProps>; hoverLabel: string } | null => {
    if (form !== null) {
      if (formPrompt !== null) return null;
      if (formPick !== null) {
        const opt = formPick.options[entryIdx];
        return opt === undefined ? null : { props: pickList.rowProps(opt, entryIdx), hoverLabel: opt };
      }
      const id = SATURN_FORM_ROWS[entryIdx];
      return id === undefined ? null : { props: formList.rowProps(id, entryIdx), hoverLabel: id };
    }
    const row = facts.rows[entryIdx];
    return row === undefined ? null : { props: list.rowProps(row, entryIdx), hoverLabel: row.facts.id };
  };

  return saturnRowsView({ columns, rows, composition, rowPropsAt, t });
}
