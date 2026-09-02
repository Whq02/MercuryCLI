import React, { useCallback, useMemo, useRef, useState } from 'react';
import { basename } from 'node:path';
import { Box, useInput } from '../ink.js';
import { createSplashCore, WORD_W } from '../../assets/splash/splash-core.mjs';
import { readSessionWorkers } from '../daemon/concourseSupervisor.js';
import { formatRelativeTimeAgo } from '../utils/format.js';
import { daemonControlRpc } from '../daemon/controlSocket.js';
import { MERCURY_DAEMON_PROTO } from '../daemon/protocol.js';
import {
  saturnFactsOf,
  saturnNextFireMs,
  type HeldFireV1,
  type SaturnFactsRowV1,
  type SaturnScheduleV1,
  type SaturnWhenV1,
  type ScheduleAccountV1,
  type ScheduleAccountVerdictV1,
} from '../daemon/saturn.js';
import { deriveScheduleAccountForModel, readLiveAccountFacts, scheduleAccountVerdict } from '../daemon/saturnAccount.js';
import { addBoxSchedule, readBoxSchedules, removeBoxSchedule, setBoxSchedulePaused } from '../daemon/saturnBoxSchedules.js';
import { compileWhenSpelling, WHEN_SPELLING_EXAMPLES } from '../services/saturn/whenSpelling.js';
import { listKitPresets } from '../services/mcp/presetStore.js';
import { getModelOptions, KEY_CONNECT_PREFIX } from '../utils/model/modelOptions.js';
import { readSessionReceipts, type SessionReceiptEntry } from '../services/switchboard/sessionReceipts.js';
import { getProjectDir } from '../utils/sessionStorage/paths.js';
import { projectDisplayName, workedInProjects } from '../utils/bootCardFacts.js';
import { useMainLoopModel } from '../hooks/useMainLoopModel.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { renderModelChip } from '../utils/model/model.js';
import { wrapPlain } from './BootHealthScreen.js';
import { InteractiveRow } from './mercury-ui/InteractiveRow.js';
import { keyHintLabel } from './mercury-ui/keyHintLabel.js';
import { renderSceneLine } from './mercury-ui/SceneCanvas.js';
import { getSessionAccent, getSessionCritterKey } from './mercury-ui/sessionAccent.js';
import { useGreetingShimmer } from './mercury-ui/useGreetingShimmer.js';
import { useInteractiveList } from './mercury-ui/useInteractiveList.js';
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js';
import { useSplashCoreAccent } from './mercury-ui/useSplashCoreAccent.js';

/**
 * BootSaturnScreen — SATURN's scheduler screen (the
 * operator's banked birth-tier spec). ONE component, two mounts: the Boot
 * face's row opens it as a face-internal layer (fullScene — the settings/
 * kit/health/resume layers' sibling, composed by the ONE shared design,
 * composeBootMenu), and /saturn mounts the SAME component in-chat at a
 * bounded height (the interim board's own door, kept — never a route hop;
 * Law 9: the chat keeps its frame).
 *
 * THE BOARD replaces the deliberately minimal interim board ABOVE
 * THE PARITY FLOOR (never-reduce-operator-scope): ↑/↓ select · x delete
 * (the sessionControl set-schedule remove) · n run-now (the one dispatch
 * door; parked targets ride the resume arm) · r refresh · esc close ALL
 * SURVIVE; above the floor the rows group under their owning sessions with
 * next-fire/held/paused state read through THE LANDED PROJECTION
 * (saturnFactsOf — the box tier's rows compose through the same function),
 * the selected row's full trail paints as SETTING DETAIL (when-spelling
 * verbatim · model · the first-class account · preflight-at-write · birth
 * facts · held fires with reasons · the fired-late/missed receipt tail),
 * and p pause/resume rides the wire's own landed ops.
 *
 * BOX-TIER rows (fork iii) paint beside the session rows with their tier
 * named; their x/n answer honestly that the file is the door until the
 * operator-facing writer lands (this lane's S4).
 *
 * Facts, clock and the receipts read are INJECTABLE (proof stills and
 * staticRender legs freeze them); the live defaults read the daemon's own
 * records — never a daemon boot, never a PTY.
 */

const DETAIL_W = 38;

export interface SaturnScreenRowV1 {
  sessionTitle: string;
  sessionId: string;
  workspaceId: string;
  parked: boolean;
  /** A box-wide (machine-tier) row — the daemon-home file is its door. */
  box?: true;
  /** THE PROJECTION's row (saturnFactsOf): next-fire/paused/kind/when. */
  facts: SaturnFactsRowV1;
  /** The record's own schedule (spelling verbatim, account, stamps). */
  schedule: SaturnScheduleV1;
  /** This schedule's held fires, typed reasons and all. */
  held: HeldFireV1[];
}

export interface SaturnScreenFactsV1 {
  rows: SaturnScreenRowV1[];
  heldTotal: number;
  sessions: number;
  daemonReadable: boolean;
}

/** Board order: sessions (groups) by their own soonest fire, rows within a
 *  session soonest-first — one section header per owner (a global
 *  soonest-first sort would interleave owners and repeat their headers). */
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

/** The live read: every live session record's schedules + the box tier,
 *  BOTH composed through the landed projection (saturnFactsOf), in board
 *  order. Fail-soft: an unreadable store answers daemonReadable false,
 *  never a throw. */
export function collectSaturnScreenFacts(nowMs: number): SaturnScreenFactsV1 {
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

/** Plain delta words for a next fire (pure; the pin composes them). */
export function fireDeltaWords(nextFireMs: number | null, nowMs: number): string {
  if (nextFireMs === null) return 'no future fire';
  const deltaMs = nextFireMs - nowMs;
  if (deltaMs <= 0) return 'due now';
  const minutes = Math.round(deltaMs / 60000);
  if (minutes < 60) return `in ${Math.max(1, minutes)}m`;
  if (minutes < 60 * 24) return `in ${Math.round(minutes / 60)}h`;
  return `in ${Math.round(minutes / (60 * 24))}d`;
}

/** A row's fire words — paused wins (a paused row never fires). */
export function saturnNextFireWords(facts: SaturnFactsRowV1, nowMs: number): string {
  return facts.paused === true ? 'paused' : fireDeltaWords(facts.nextFireMs, nowMs);
}

/** One composer entry (structurally what composeBootMenu consumes — the
 *  manager's exact grammar). The owning session is the row's SECTION
 *  (groupTitle), so every tier names it; a row whose state asserts nothing
 *  wrong reads faint like a default value, one that does stands out. */
export type SaturnEntry = {
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
  const words = saturnNextFireWords(row.facts, nowMs);
  const heldBit = row.held.length > 0 ? ` · ${row.held.length} held` : '';
  return {
    label: `${row.facts.id}  ${clampText(row.facts.when, 34)}`,
    group: row.box === true ? 'box' : row.sessionId,
    groupTitle: row.box === true ? 'box (machine)' : `${row.sessionTitle}${row.parked ? ' · parked' : ''}`,
    summary: `${row.facts.kind} · ${words}${heldBit}`,
    valueLabel: `${words}${heldBit}`,
    valueIsDefault: row.held.length === 0 && row.facts.paused !== true && row.facts.nextFireMs !== null,
    pinnedVal: null,
    detail: null,
  };
}

/** The selected row's full trail (pure; SETTING DETAIL body): the spelling
 *  verbatim (facts.when IS describeWhen's word), the model, the first-class
 *  account (WHO, never a token), the stored schedule-time preflight (absent
 *  = 'not computed' — never read as ready), the birth facts, the held fires
 *  with their typed reasons, and the fired-late/missed receipt tail. */
export function saturnDetailLines(row: SaturnScreenRowV1, nowMs: number, receipts: SessionReceiptEntry[]): string[] {
  const s = row.schedule;
  const lines: string[] = [`${row.facts.id} · ${row.facts.kind}${row.box === true ? ' · box tier' : ''}`, ''];
  lines.push(...wrapPlain(`when: ${row.facts.when}`, DETAIL_W));
  lines.push(`next: ${saturnNextFireWords(row.facts, nowMs)}`);
  // Relative words like every sibling trail — the injected
  // nowMs keeps the stills byte-stable; the exact instants live in receipts.
  lines.push(`last: ${s.lastFiredAt !== undefined ? formatRelativeTimeAgo(new Date(s.lastFiredAt), { style: 'short', now: new Date(nowMs) }) : 'never'}`);
  lines.push(`model: ${s.modelKey}${s.effort !== undefined ? ` · ${s.effort}` : ''}`);
  lines.push(...wrapPlain(`account: ${s.account.family}/${s.account.source}${s.account.identity !== undefined ? ` · ${s.account.identity}` : ''}`, DETAIL_W));
  lines.push(`preflight at write: ${s.preflightAtWrite !== undefined ? s.preflightAtWrite.state : 'not computed'}`);
  if (s.action.kind === 'birth') {
    const b = s.action.birth;
    lines.push('');
    lines.push(...wrapPlain(`birth: ${b.presence} in ${b.workspaceDir}`, DETAIL_W));
    if (b.kitPreset !== undefined) lines.push(...wrapPlain(`wearing: preset '${b.kitPreset}'`, DETAIL_W));
    lines.push(
      b.contract === undefined
        ? 'contract: not pre-answered'
        : b.contract === null
          ? 'contract: no-contract (pre-answered)'
          : 'contract: pre-answered',
    );
    lines.push(b.opening !== undefined ? 'born-working (opening mission set)' : 'born-waiting');
  }
  if (row.held.length > 0) {
    lines.push('');
    lines.push(`held fires: ${row.held.length}`);
    for (const h of row.held.slice(0, 3)) {
      lines.push(...wrapPlain(`· ${h.reason} — due ${formatRelativeTimeAgo(new Date(h.dueAt), { style: 'short', now: new Date(nowMs) })}`, DETAIL_W));
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

/** The LAUNCH-SUMMARY panel rows (pure; the stills compose the same). */
export function saturnSummaryRows(f: SaturnScreenFactsV1, nowMs: number): Array<{ key: string; value: string; tone?: 'teal' | 'amber' | 'crimson' | 'faint' }> {
  const soonest = f.rows
    .filter(r => r.facts.paused !== true)
    .map(r => r.facts.nextFireMs)
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

/** The key legend — only the moves that exist (the parity floor's verbs
 *  survive the replacement by construction: x delete · n run-now · r
 *  refresh live HERE; `a` opens the birth composer). */
export function saturnLegendOf(state: { busy: boolean }): string {
  if (state.busy) return 'working… (the screen settles before the next key)';
  return '↑↓ move · a schedule birth… · x delete · n run-now · p pause/resume · r refresh · esc back';
}

/** The status bar's standing line — words, never a bare dead end. */
export function saturnStatusLine(f: SaturnScreenFactsV1): string {
  if (!f.daemonReadable) return "the daemon's records are not readable here — start Mercury's daemon and press r";
  if (f.rows.length === 0) {
    return f.sessions === 0
      ? 'no live sessions hold schedules'
      : `no schedules on ${f.sessions} live session${f.sessions === 1 ? '' : 's'}`;
  }
  return `${f.rows.length} schedule${f.rows.length === 1 ? '' : 's'} · ${f.heldTotal} held · read-only until a verb`;
}

/** The empty board's SETTING DETAIL body — the DOOR leads (the operator's
 *  sighting: the old copy described the screen as read-only and never
 *  taught the birth composer); the in-session road speaks second. The key
 *  hint rides keyHintLabel (the one platform-aware owner), never a
 *  hand-authored glyph. */
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

// ── THE FORM (the operator's banked birth tier: schedule a fresh session
//    to be born at a time — the seven facts, every one a landed engine
//    fact on SaturnBirthSpecV1/the submission grammar) ─────────────────────

export interface SaturnFormStateV1 {
  /** The operator's WHEN phrase, compiled through the spelling seam. */
  when: string;
  modelKey: string;
  workspaceDir: string;
  presence: 'headless' | 'screen-present';
  kitPreset: string | null;
  /** BORN-WORKING's opening mission; null = BORN-WAITING. */
  opening: string | null;
  contract: { kind: 'unset' } | { kind: 'none' } | { kind: 'text'; text: string };
  title: string | null;
  note: string | null;
}

export type SaturnFormRowId = 'when' | 'model' | 'workspace' | 'presence' | 'kit' | 'opening' | 'contract' | 'title' | 'note';
export const SATURN_FORM_ROWS: readonly SaturnFormRowId[] = ['when', 'model', 'workspace', 'presence', 'kit', 'opening', 'contract', 'title', 'note'];

/** A fresh form: the face's own ground and model, headless (the unattended
 *  arm — the machine tier's natural default), nothing pre-answered. */
export function freshSaturnForm(defaults: { modelKey: string; workspaceDir: string }): SaturnFormStateV1 {
  return {
    when: '',
    modelKey: defaults.modelKey,
    workspaceDir: defaults.workspaceDir,
    presence: 'headless',
    kitPreset: null,
    opening: null,
    contract: { kind: 'unset' },
    title: null,
    note: null,
  };
}

/** The contract fact's words (one home — the row and the preview agree). */
export function saturnContractWords(c: SaturnFormStateV1['contract']): string {
  return c.kind === 'unset' ? 'not pre-answered' : c.kind === 'none' ? 'no-contract (pre-answered)' : `“${clampText(c.text, 24)}”`;
}

// ── OS-2 (operator-ordered): the workspace row picks a KNOWN PROJECT ──────
//  "a selector for the project that you wanna schedule for" — the rows are
//  THE ONE PROJECT SOURCE's dirs (workedInProjects; never a second
//  enumeration) plus the custom-path road (the old free-text prompt). The
//  engine fact stays workspaceDir — a picker skin, no schema motion.

export const SATURN_WORKSPACE_CUSTOM_ROW = 'custom path…';

/** Pure: the picker's rows over the handed project dirs (deduped, order
 *  kept — the source is newest-first), the custom road always last. */
export function saturnWorkspacePickOptions(projectDirs: string[]): string[] {
  return [...new Set(projectDirs)].concat(SATURN_WORKSPACE_CUSTOM_ROW);
}

// ── OS-3 (operator-ordered): the opening mission's QUICK ROWS ─────────────
//  "you can put audit and review and then custom … custom opens up a text
//  field" — the born-working mission gains canned quick rows beside the
//  free-text road; born-waiting stays the default absent a mission. The
//  engine fact stays SaturnBirthSpecV1.opening — a picker skin only.

export const SATURN_OPENING_NONE_ROW = 'born-waiting — no mission';
export const SATURN_OPENING_AUDIT_ROW = 'audit';
export const SATURN_OPENING_REVIEW_ROW = 'review';
export const SATURN_OPENING_CUSTOM_ROW = 'custom…';

/** The canned missions — honest, short, SELF-CONTAINED (a schedule-born
 *  session works headless with zero conversational context, so the mission
 *  carries its own task, bar, and reporting channel). */
export const SATURN_AUDIT_MISSION =
  'Audit this workspace: sweep the recent changes and the checks that guard them, verify what they claim against the tree, and write your findings — with file references — into the transcript.';
export const SATURN_REVIEW_MISSION =
  'Review the recent work in this workspace: read the latest commits, flag defects and risks with file references, and write the review into the transcript.';

export function saturnOpeningPickOptions(): string[] {
  return [SATURN_OPENING_NONE_ROW, SATURN_OPENING_AUDIT_ROW, SATURN_OPENING_REVIEW_ROW, SATURN_OPENING_CUSTOM_ROW];
}

/** The pick's meaning: null = born-waiting; a string = the canned mission
 *  lands whole; 'custom' = the free-text road (the old prompt). */
export function saturnOpeningFromPick(row: string): string | null | 'custom' {
  if (row === SATURN_OPENING_AUDIT_ROW) return SATURN_AUDIT_MISSION;
  if (row === SATURN_OPENING_REVIEW_ROW) return SATURN_REVIEW_MISSION;
  if (row === SATURN_OPENING_CUSTOM_ROW) return 'custom';
  return null;
}

/** The opening pick row wearing 'current' for the form's own state. */
export function saturnOpeningRowIsCurrent(row: string, opening: string | null): boolean {
  if (row === SATURN_OPENING_NONE_ROW) return opening === null;
  if (row === SATURN_OPENING_AUDIT_ROW) return opening === SATURN_AUDIT_MISSION;
  if (row === SATURN_OPENING_REVIEW_ROW) return opening === SATURN_REVIEW_MISSION;
  return opening !== null && opening !== SATURN_AUDIT_MISSION && opening !== SATURN_REVIEW_MISSION;
}

/** The form's fact rows (pure; the stills compose the same). A REQUIRED
 *  field still empty stands out (valueIsDefault false); everything lawful
 *  reads quiet. */
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
    row('contract', 'Contract', 'born wearing', saturnContractWords(form.contract), true, '↵ cycles unset → no-contract → text…'),
    row('title', 'Title', 'words', form.title ?? '(the door names it)', true, 'the born session’s name (↵ edits)'),
    row('note', 'Note', 'words', form.note ?? '—', true, 'a word for the board (↵ edits)'),
  ];
}

/** What the form's preview computes per model/when change — the derivation
 *  and THE ONE VERDICT, injectable for proofs; the live default reads the
 *  same owners the daemon reads. */
export interface SaturnFormPreflightV1 {
  derivation: { ok: true; account: ScheduleAccountV1 } | { ok: false; reason: string };
  verdict: ScheduleAccountVerdictV1 | null;
}

export function livePreflightOf(modelKey: string, nextFireMs: number | null): SaturnFormPreflightV1 {
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

/** THE VERDICT's sentence — the one function's typed states rendered with
 *  its own facts (never a re-derived judgment); 'expired'/'signed-out'
 *  carry the held-birth honesty line (the banked spec's sentence: re-login
 *  now or it's born held). */
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
      return "preflight: no local server answering — start it (or set MERCURY_LOCAL_BASE_URL), or the fire is born held";
    case 'rate-limited':
      return `preflight: rate-limited — a due fire holds until the window ends${v.retryAt !== undefined ? ` (~${new Date(v.retryAt).toISOString()})` : ''}`;
  }
}

/** The form's SETTING DETAIL body (pure): the compiled when (or the
 *  compiler's own error), the derived account + the verdict sentence, the
 *  presence contract in plain words, born-waiting/working, the contract
 *  fact, and the banked landing sentence. */
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
    lines.push(...wrapPlain(`account: ${a.family}/${a.source}${a.identity !== undefined ? ` · ${a.identity}` : ''}`, DETAIL_W));
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
  lines.push(...wrapPlain(`contract: ${saturnContractWords(form.contract)}`, DETAIL_W));
  lines.push('');
  lines.push(...wrapPlain('at fire time the session appears on the concourse, receipted "born by schedule"', DETAIL_W));
  return lines;
}

/** The form legend — only the moves that exist per layer. */
export function saturnFormLegendOf(state: { prompt: boolean; pick: boolean }): string {
  if (state.prompt) return 'type · ↵ set · esc cancel';
  if (state.pick) return '↑↓ move · ↵ pick · esc back';
  return '↑↓ move · ↵ edit · ⌫ clear · s schedule it · esc back';
}

interface BootSaturnScreenProps {
  onClose?: (value?: string) => void;
  /** The persistent Boot scene contract: the screen owns the whole viewport
   *  on the shared flat ground, exactly like the settings layer. Absent =
   *  the in-chat mount (/saturn), composed at a bounded height. */
  fullScene?: { columns: number; rows: number };
  /** Injected board facts — a proof/still hands them; absent ⇒ the live
   *  collect above. */
  facts?: SaturnScreenFactsV1;
  /** Frozen clock for proofs; absent ⇒ Date.now() at each collect. */
  nowMs?: number;
  /** Injected receipts read for the detail tail; absent ⇒ the session's
   *  own receipt file, filtered to this schedule's fire/held rows. */
  receiptsOf?: (row: SaturnScreenRowV1) => SessionReceiptEntry[];
  /** The form's roster reads + preflight, injectable for proofs; the live
   *  defaults read the canonical owners (getModelOptions · listKitPresets ·
   *  the derivation + THE ONE VERDICT). */
  modelOptionsOf?: () => string[];
  presetsOf?: () => string[];
  /** The workspace picker's project dirs (OS-2) — injectable; the live
   *  default reads THE ONE PROJECT SOURCE (workedInProjects). */
  projectsOf?: () => string[];
  preflightOf?: (modelKey: string, nextFireMs: number | null) => SaturnFormPreflightV1;
}

function liveReceiptsOf(row: SaturnScreenRowV1): SessionReceiptEntry[] {
  if (row.box === true) return [];
  try {
    return readSessionReceipts(getProjectDir(row.workspaceId), row.sessionId)
      .filter(
        e =>
          (e.kind === 'schedule-fire' || e.kind === 'schedule-held') &&
          (e.details as { scheduleId?: unknown } | undefined)?.scheduleId === row.facts.id,
      )
      .slice(-4);
  } catch {
    return [];
  }
}

function liveModelOptions(): string[] {
  try {
    return [
      ...new Set(
        getModelOptions()
          .map(o => o.value)
          .filter((v): v is string => typeof v === 'string' && v.length > 0 && !v.startsWith(KEY_CONNECT_PREFIX)),
      ),
    ];
  } catch {
    return [];
  }
}

function livePresets(): string[] {
  try {
    return listKitPresets();
  } catch {
    return [];
  }
}

/** THE ONE PROJECT SOURCE's dirs (workedInProjects — the same scan the Boot
 *  face's Projects rows render; never a second enumeration). Fail-soft. */
function liveProjectDirs(): string[] {
  try {
    return workedInProjects().map(p => p.dir);
  } catch {
    return [];
  }
}

/** The text-entry caps per form field (the engine's own bounds). */
function formPromptCap(field: SaturnFormRowId): number {
  switch (field) {
    case 'workspace':
      return 4096;
    case 'opening':
      return 20_000;
    case 'contract':
      return 20_000;
    case 'note':
      return 500;
    default:
      return 200;
  }
}

export function BootSaturnScreen({ onClose, fullScene, facts: given, nowMs: givenNow, receiptsOf, modelOptionsOf, presetsOf, projectsOf, preflightOf }: BootSaturnScreenProps = {}): React.ReactNode {
  const t = useMercuryTokens();
  const { columns: termCols, rows: termRows } = useTerminalSize();
  const columns = fullScene?.columns ?? termCols;
  // The in-chat mount composes at a bounded height inside the transcript
  // flow (the chat keeps its frame); the face layer owns the viewport.
  const rows = fullScene?.rows ?? Math.max(12, Math.min(24, termRows - 2));

  const [collected, setCollected] = useState<{ facts: SaturnScreenFactsV1; atMs: number }>(() => {
    const atMs = givenNow ?? Date.now();
    return { facts: given ?? collectSaturnScreenFacts(atMs), atMs };
  });
  const [note, setNote] = useState<string | null>(null);
  const busy = useRef(false);
  const facts = given ?? collected.facts;
  const nowMs = givenNow ?? collected.atMs;

  // ── the birth composer (a sub-layer: the form owns input while open;
  //    its prompt and pickers own it in turn — the manager's layering) ─────
  const [form, setForm] = useState<SaturnFormStateV1 | null>(null);
  const [formNote, setFormNote] = useState<string | null>(null);
  const [formPrompt, setFormPrompt] = useState<{ field: SaturnFormRowId; draft: string } | null>(null);
  const [formPick, setFormPick] = useState<{ field: 'model' | 'kit' | 'workspace' | 'opening'; options: string[] } | null>(null);
  const formPromptRef = useRef(formPrompt);
  formPromptRef.current = formPrompt;
  const mainModel = useMainLoopModel();

  const refresh = useCallback((): void => {
    const atMs = givenNow ?? Date.now();
    setCollected({ facts: given ?? collectSaturnScreenFacts(atMs), atMs });
  }, [given, givenNow]);

  const scheduleEditRpc = useCallback(
    (row: SaturnScreenRowV1, op: 'remove' | 'pause' | 'resume', pendingWord: string, doneWord: string): void => {
      if (busy.current) return;
      busy.current = true;
      setNote(`${pendingWord} '${row.facts.id}'…`);
      void daemonControlRpc(
        {
          op: 'sessionControl',
          proto: MERCURY_DAEMON_PROTO,
          action: 'set-schedule',
          sessionId: row.sessionId,
          by: 'operator:saturn-screen',
          scheduleEdit: { op, scheduleId: row.facts.id },
        },
        { timeoutMs: 3000 },
      )
        .then(reply => {
          const r = reply as { ok?: boolean; outcome?: string; detail?: string; error?: string };
          setNote(
            r.ok === true && (r.outcome === 'applied' || r.outcome === 'noop')
              ? `${doneWord} '${row.facts.id}' — ${r.detail ?? 'receipted'}`
              : `${op} refused — ${r.detail ?? r.error ?? 'no detail'}`,
          );
        })
        .catch(e => setNote(`${op} failed — ${String(e)}`))
        .finally(() => {
          busy.current = false;
          refresh();
        });
    },
    [refresh],
  );

  const runNow = useCallback(
    (row: SaturnScreenRowV1): void => {
      if (busy.current) return;
      if (row.schedule.action.kind !== 'fire') {
        // The old door's run-now executed a prompt; a BIRTH's fire is the
        // admission itself — the honest answer, not a silent no-op.
        setNote('run-now takes fire schedules; a birth fires on its own clock');
        return;
      }
      busy.current = true;
      setNote(`running '${row.facts.id}' now…`);
      void daemonControlRpc(
        {
          op: 'sessionDispatch',
          proto: MERCURY_DAEMON_PROTO,
          clientMessageId: `saturn-screen-run-${row.facts.id}-${Date.now()}`,
          prompt: row.schedule.action.prompt,
          workspaceDir: row.workspaceId,
          by: 'operator:saturn-screen',
          ...(row.parked ? { resumeSessionId: row.sessionId } : { targetSessionId: row.sessionId }),
        },
        { timeoutMs: 5000 },
      )
        .then(reply => {
          const r = reply as { ok?: boolean; error?: string };
          setNote(r.ok === true ? `fired '${row.facts.id}' into ${row.sessionTitle}` : `run-now refused — ${r.error ?? 'no detail'}`);
        })
        .catch(e => setNote(`run-now failed — ${String(e)}`))
        .finally(() => {
          busy.current = false;
          refresh();
        });
    },
    [refresh],
  );

  // The box tier's verbs write the file directly — the file IS the door
  // (no wire verb; the next daemon tick sees every edit).
  const boxRemove = (row: SaturnScreenRowV1): void => {
    const outcome = removeBoxSchedule(row.facts.id);
    setNote(outcome === 'removed' ? `removed '${row.facts.id}' — a box row; the next tick sees it` : `remove refused — no box schedule '${row.facts.id}'`);
    refresh();
  };
  const boxPauseResume = (row: SaturnScreenRowV1): void => {
    const paused = row.facts.paused !== true;
    const outcome = setBoxSchedulePaused(row.facts.id, paused);
    setNote(
      outcome === 'applied'
        ? `${paused ? 'paused' : 'resumed'} '${row.facts.id}' — a box row; the next tick sees it`
        : outcome === 'noop'
          ? `already ${paused ? 'paused' : 'running'}`
          : `no box schedule '${row.facts.id}'`,
    );
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
          // A box row is always a birth — runNow's own kind arm answers it.
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

  // ── the form's own lists and prompt (each owns input while open) ─────────
  const commitPrompt = (field: SaturnFormRowId, draft: string): void => {
    const text = draft.trim();
    setForm(f => {
      if (f === null) return f;
      switch (field) {
        case 'when':
          return { ...f, when: text };
        case 'workspace':
          return text === '' ? f : { ...f, workspaceDir: text };
        case 'opening':
          return { ...f, opening: text === '' ? null : text };
        case 'contract':
          return { ...f, contract: text === '' ? { kind: 'none' } : { kind: 'text', text } };
        case 'title':
          return { ...f, title: text === '' ? null : text };
        case 'note':
          return { ...f, note: text === '' ? null : text };
        default:
          return f;
      }
    });
  };

  const editFormRow = (id: SaturnFormRowId): void => {
    const f = form;
    if (f === null) return;
    setFormNote(null);
    switch (id) {
      case 'when':
        setFormPrompt({ field: 'when', draft: f.when });
        return;
      case 'model':
        setFormPick({ field: 'model', options: (modelOptionsOf ?? liveModelOptions)() });
        return;
      case 'workspace':
        // OS-2: pick a known project (the one source) or the custom road.
        setFormPick({ field: 'workspace', options: saturnWorkspacePickOptions((projectsOf ?? liveProjectDirs)()) });
        return;
      case 'presence':
        setForm({ ...f, presence: f.presence === 'headless' ? 'screen-present' : 'headless' });
        return;
      case 'kit':
        setFormPick({ field: 'kit', options: ['none', ...(presetsOf ?? livePresets)()] });
        return;
      case 'opening':
        // OS-3: the quick rows (audit · review · custom…; none = waiting).
        setFormPick({ field: 'opening', options: saturnOpeningPickOptions() });
        return;
      case 'contract':
        // ↵ cycles unset → no-contract → text… (the prompt); from text back
        // to unset (⌫ clears from anywhere).
        if (f.contract.kind === 'unset') setForm({ ...f, contract: { kind: 'none' } });
        else if (f.contract.kind === 'none') setFormPrompt({ field: 'contract', draft: '' });
        else setForm({ ...f, contract: { kind: 'unset' } });
        return;
      case 'title':
        setFormPrompt({ field: 'title', draft: f.title ?? '' });
        return;
      case 'note':
        setFormPrompt({ field: 'note', draft: f.note ?? '' });
        return;
    }
  };

  const clearFormRow = (id: SaturnFormRowId): void => {
    setForm(f => {
      if (f === null) return f;
      switch (id) {
        case 'when':
          return { ...f, when: '' };
        case 'kit':
          return { ...f, kitPreset: null };
        case 'opening':
          return { ...f, opening: null };
        case 'contract':
          return { ...f, contract: { kind: 'unset' } };
        case 'title':
          return { ...f, title: null };
        case 'note':
          return { ...f, note: null };
        default:
          return f;
      }
    });
  };

  // THE SUBMIT: the form writes the BOX TIER (the sessionless home — the
  // file is the door; the next daemon tick sees the row). The compile and
  // the account derivation refuse typed ON the form; the stored row carries
  // the schedule-time preflight (THE ONE VERDICT at write).
  const submitForm = (): void => {
    const f = form;
    if (f === null) return;
    if (f.when === '') {
      setFormNote('say when first — ↵ on the When row');
      return;
    }
    const compiled = compileWhenSpelling(f.when, Date.now());
    if (!compiled.ok) {
      setFormNote(compiled.reason);
      return;
    }
    const birth = {
      workspaceDir: f.workspaceDir,
      modelKey: f.modelKey,
      presence: f.presence,
      ...(f.kitPreset !== null ? { kitPreset: f.kitPreset } : {}),
      ...(f.opening !== null ? { opening: f.opening } : {}),
      ...(f.contract.kind === 'none' ? { contract: null } : f.contract.kind === 'text' ? { contract: { text: f.contract.text } } : {}),
      ...(f.title !== null ? { title: f.title } : {}),
    };
    const res = addBoxSchedule(
      { when: compiled.when, action: { kind: 'birth', birth }, ...(f.note !== null ? { note: f.note } : {}) },
      'operator:saturn-screen',
      {
        deriveAccount: m => deriveScheduleAccountForModel(m),
        preflight: (account, nextFireMs) =>
          scheduleAccountVerdict({ account, nextFireMs, nowMs: Date.now(), live: readLiveAccountFacts(account) }),
      },
    );
    if (!res.ok) {
      setFormNote(res.reason);
      return;
    }
    setForm(null);
    setFormPrompt(null);
    setFormPick(null);
    setNote(`schedule '${res.id}' set — a ${f.presence} box birth, ${compiled.when.spelling ?? f.when}; the next daemon tick sees it`);
    refresh();
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
            // The custom road IS the old free-text prompt.
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

  // The prompt's keys (active only while it is open): printable bytes type
  // the draft (bounded by the engine's own caps), ⌫ edits, ↵ commits, esc
  // cancels — consumed here so no owner beneath sees them.
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
      // eslint-disable-next-line no-control-regex
      if (input.length > 0 && !/[\x00-\x1f\x7f]/.test(input)) {
        setFormPrompt({ ...p, draft: (p.draft + input).slice(0, formPromptCap(p.field)) });
      }
    },
    { isActive: formPrompt !== null },
  );

  // ── the ratified composition (the ONE shared design) ─────────────────────
  const { accent: coreAccent, rampStops } = useSplashCoreAccent();
  const core = useMemo(
    () => createSplashCore({ nocolor: false, truecolor: true, accent: coreAccent }),
    [coreAccent],
  );
  const wordGlow = useGreetingShimmer(rampStops, WORD_W);

  const menuM = useMemo(() => {
    const critterKey = getSessionCritterKey();
    const environment = {
      model: renderModelChip(mainModel),
      critter: critterKey.charAt(0).toUpperCase() + critterKey.slice(1),
      critterHue: getSessionAccent().accent,
      dirBase: basename(process.cwd()) || process.cwd(),
      dirTail: '',
    };
    const base = {
      title: 'saturn scheduler',
      summaryTitle: 'SATURN',
      summaryRows: saturnSummaryRows(facts, nowMs),
      environment,
      glowWord: wordGlow,
      moreHint: '… (the trail continues — a taller terminal shows it whole)',
    };
    // THE FORM LAYER owns the panel while open (the manager's own action
    // layering): the picker swaps the list for its options, the prompt
    // paints its draft in the status bar, and the detail body previews the
    // compiled when + the derived account + THE ONE VERDICT's sentence.
    if (form !== null) {
      const previewNow = givenNow ?? Date.now();
      const compiled = form.when === '' ? null : compileWhenSpelling(form.when, previewNow);
      const nextFire = compiled !== null && compiled.ok ? saturnNextFireMs(compiled.when, previewNow) : null;
      const preflight = (preflightOf ?? livePreflightOf)(form.modelKey, nextFire);
      if (formPick !== null) {
        return {
          ...base,
          entries: formPick.options.map(o => ({
            label:
              formPick.field === 'workspace' && o !== SATURN_WORKSPACE_CUSTOM_ROW
                ? `${projectDisplayName(o)}  ${clampText(o, 40)}`
                : o,
            group: formPick.field,
            groupTitle:
              formPick.field === 'model'
                ? 'pick the model'
                : formPick.field === 'workspace'
                  ? 'pick the project'
                  : formPick.field === 'opening'
                    ? 'pick the opening mission'
                    : 'pick the preset',
            summary:
              formPick.field === 'opening' && o === SATURN_OPENING_AUDIT_ROW
                ? clampText(SATURN_AUDIT_MISSION, 60)
                : formPick.field === 'opening' && o === SATURN_OPENING_REVIEW_ROW
                  ? clampText(SATURN_REVIEW_MISSION, 60)
                  : '',
            valueLabel:
              (formPick.field === 'model'
                ? form.modelKey === o
                : formPick.field === 'workspace'
                  ? form.workspaceDir === o
                  : formPick.field === 'opening'
                    ? saturnOpeningRowIsCurrent(o, form.opening)
                    : (form.kitPreset ?? 'none') === o)
                ? 'current'
                : '',
            valueIsDefault: true,
            pinnedVal: null,
            detail: null,
          })),
          selIdx: pickList.selectedIndex,
          statusRight: `${formPick.options.length} option${formPick.options.length === 1 ? '' : 's'}`,
          legend: saturnFormLegendOf({ prompt: false, pick: true }),
          detailOverride: saturnFormDetailLines(form, compiled, preflight, previewNow),
        };
      }
      const promptLine =
        formPrompt !== null ? `${formPrompt.field}: ${formPrompt.draft === '' ? '(type)' : formPrompt.draft}▌` : null;
      return {
        ...base,
        entries: saturnFormEntries(form),
        selIdx: formPrompt === null ? formList.selectedIndex : -1,
        statusRight: promptLine ?? formNote ?? 'the seven facts — ↵ edits a row',
        legend: saturnFormLegendOf({ prompt: formPrompt !== null, pick: false }),
        detailOverride: saturnFormDetailLines(form, compiled, preflight, previewNow),
      };
    }
    const entries = facts.rows.map(r => saturnEntryOf(r, nowMs));
    const statusRight = list.note ?? note ?? saturnStatusLine(facts);
    return {
      ...base,
      entries,
      selIdx: selected !== null ? list.selectedIndex : -1,
      statusRight,
      legend: saturnLegendOf({ busy: busy.current }),
      detailOverride:
        selected !== null
          ? saturnDetailLines(selected, nowMs, (receiptsOf ?? liveReceiptsOf)(selected))
          : saturnEmptyDetailLines(facts),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Pointer parity rides whichever list owns the composed entries: the
  // board's rows, the form's fact rows, or an open picker's options (the
  // prompt owns input alone — its frames mount no targets).
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

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {Array.from({ length: rows }, (_, i) => {
        const line = composition.placed[i] ?? '';
        const entryIdx = composition.entryAt.get(i);
        const target = entryIdx !== undefined ? rowPropsAt(entryIdx) : null;
        if (target !== null) {
          const { props, hoverLabel } = target;
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
          <Box key={`saturnline-${i}`} height={1} flexShrink={0}>
            {line.length > 0 ? renderSceneLine(line) : null}
          </Box>
        );
      })}
    </Box>
  );
}
