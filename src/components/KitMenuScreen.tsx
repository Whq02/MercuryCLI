import React, { useEffect, useMemo, useState } from 'react';
import { basename } from 'node:path';
import { Box, useInput } from '../ink.js';
import { createSplashCore, WORD_W } from '../../assets/splash/splash-core.mjs';
import { leaveCurrentSurface } from '../context/surfaceRoute.js';
import { useMainLoopModel } from '../hooks/useMainLoopModel.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { enumerateKitCatalogueFresh } from '../services/kitMenu/kitCatalogue.js';
import { skillChangeDetector } from '../utils/skills/skillChangeDetector.js';
import { deltasFromStates, kitMenuStore, type KitMenuStore } from '../services/kitMenu/menuStore.js';
import { PRESET_NAME_MAX, kitPresetHook, presetNameProblem, type KitPresetSnapshot } from '../services/kitMenu/presetHook.js';
import { deleteKitPreset, kitPresetDeltas, listKitPresets, presetDeltaCount } from '../services/mcp/presetStore.js';
import { disarmWornPreset, wearPresetForNextSession } from '../services/kitMenu/presetWear.js';
import { peekWornPresetKit } from '../services/switchboard/bootBirthFacts.js';
import { carryNextSessionKit } from '../services/kitMenu/resolvedKit.js';
import {
  KIT_SECTION_TITLE,
  LOADING_KIT_CATALOGUE,
  cycleState,
  isKitMember,
  kitCounts,
  kitRowId,
  kitRowView,
  kitStateKey,
  sectionRows,
  type KitCatalogue,
  type KitCounts,
  type KitRow,
  type KitRowState,
  type KitRowView,
  type KitStates,
} from '../services/kitMenu/kitTypes.js';
import { renderModelChip } from '../utils/model/model.js';
import { InteractiveRow } from './mercury-ui/InteractiveRow.js';
import { renderSceneLine } from './mercury-ui/SceneCanvas.js';
import { getSessionAccent, getSessionCritterKey } from './mercury-ui/sessionAccent.js';
import { useGreetingShimmer } from './mercury-ui/useGreetingShimmer.js';
import { useInteractiveList } from './mercury-ui/useInteractiveList.js';
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js';
import { useSplashCoreAccent } from './mercury-ui/useSplashCoreAccent.js';

/**
 * KitMenuScreen — the MCPs & Skills manager:
 * the Boot face's "MCPs & Skills" row OPENS this screen (never
 * inlays it) — ONE screen, TWO TITLED SECTIONS, "MCPs" (on/off) then
 * "Skills" (on / invocable / off), composed by the ONE shared core through
 * the ratified boot-menu design (composeBootMenu, generic over its host —
 * the same three-panel layout ≥110 cols, the classic list below) so the
 * manager wears exactly the Boot Menu's polish. The settings layer's
 * sibling on the face: esc closes back to the canonical face.
 *
 * What it edits: the NEXT-SESSION DEFAULT KIT for this project (L24(3):
 * "apply to be off for the next session"; per repo). A LIVE session keeps
 * its own set — nothing here ever reaches a running session (pinned), and
 * /mcp + /skills inside a session are session-scoped dials isolated from
 * this menu in both directions. Write-through per toggle with a receipt
 * (the landed boot-menu grammar: the visible state IS the saved state; no
 * Save button). Default all-on: a fresh home never nags.
 *
 * THE STATES: every row's state is a WORD on the row — MCP servers and
 * extension master rows read on/off, skills read on/invocable/off
 * (invocable = listed, loads only when you /name it, never ambient) — and
 * the record keeps DEVIATIONS ONLY (an absent key is on, so default all-on
 * holds by construction and a newly added server/skill/extension is on
 * with no menu edit). An item under an OFF extension master reads
 * `off (extension)` — what the next session actually gets — and keeps its
 * own state for when the master returns; cycling it answers in words
 * instead of changing a value nobody can see.
 *
 * OPTION 2 (extensions): extension-contributed servers and
 * skills sit in the two lists under their extension's label, and each
 * extension carries a MASTER ROW above its items — off turns off everything
 * it contributes (skills, servers, commands, hooks), said in words on the
 * row. Mercury's own organs (the ide bridge, bundled skills) never appear.
 *
 * Runtime-only: the launcher never renders this screen (its card row hands
 * over with the `kit` receipt action; the face consumes the deep-link).
 *
 * Keyboard grammar (the boot menu's own): ↑↓/jk move · ↵/space/→ cycle
 * forward · ← cycle back · ⌫ default (on) · esc back one layer. Mouse:
 * click parity on every row. Every state names itself in words, never by
 * color alone.
 */

interface KitMenuScreenProps {
  onClose?: () => void;
  /** The persistent Boot scene contract: the manager owns the whole
   *  viewport on the shared flat ground, exactly like the settings layer. */
  fullScene?: { columns: number; rows: number };
  /** The rows to manage — injected by a host or a proof; absent ⇒ the screen
   *  reads them itself through the runner's own doors (enumerateKitCatalogue,
   *  once at mount; the sections say "reading…" until the answer is in). */
  catalogue?: KitCatalogue;
  /** The menu store the toggles write through (the record, per repo);
   *  absent ⇒ the estate's own. A proof hands a fixture. */
  store?: KitMenuStore;
  /** The repo whose next-session default this screen edits; absent ⇒ the
   *  face's ground (process.cwd()). */
  workspaceDir?: string;
}

/** Key truth once the store is bound: ↵ changes AND saves. */
export const KIT_LEGEND_SAVED = '↑↓ move · ↵ change (saved) · ⌫ default · esc back';
/** …and with the preset doors: `p` opens the save-as prompt, `w` the saved
 *  presets layer (ACTION keys in the boot menu's own grammar — 'a apply
 *  receipts' — never a third titled section). */
export const KIT_LEGEND_PRESET = '↑↓ move · ↵ change (saved) · ⌫ default · p save as preset… · w presets… · esc back';
/** The prompt's own keys while it owns input. */
export const KIT_LEGEND_PROMPT = 'type a name · ↵ save · esc cancel';
/** The presets layer's keys while it owns the screen (↵ on the armed row
 *  disarms — the one-keystroke undo). */
export const KIT_LEGEND_PRESETS = '↑↓ move · ↵ wear next session · ⌫ delete · esc back';
/** The layer's honest empty line (never a nag). */
export const PRESET_LAYER_EMPTY = "no presets saved — 'p' on the menu saves the current record under a name";

/** The prompt as SETTING DETAIL body rows (pure; the stills compose it):
 *  the name with the live caret, the plain words, the note or the keys. */
export function presetPromptLines(name: string, note: string | null): string[] {
  return [
    'save as preset',
    '',
    `name: ${name}▌`,
    '',
    'a preset is this record under a name —',
    'the next session, and the coordinator,',
    'can start from it.',
    '',
    note ?? '↵ save · esc cancel',
  ];
}

/** The status bar's standing line (pure; the pin reads it): a fresh record
 *  says the all-on truth — never a nag. */
export function kitStatusLine(changed: number): string {
  return changed > 0
    ? `${changed} choice${changed === 1 ? '' : 's'} saved — applies to the next session`
    : 'everything on — changes apply to the next session, never a running one';
}

/** One saved preset as the layer lists it (count null = a damaged entry —
 *  visible, its wear says the reason). */
export type PresetRowFact = { name: string; count: number | null };

/** The layer's composer entry for one saved preset (pure; the stills
 *  compose the same): the armed one wears the word `armed`. */
export function presetLayerEntryOf(fact: PresetRowFact, armed: string | null): KitEntry {
  return {
    label: fact.name,
    group: 'saved presets',
    groupTitle: 'saved presets',
    summary:
      fact.count === null
        ? 'damaged in the config — ↵ says the reason; save it again from the menu'
        : `${fact.count} delta${fact.count === 1 ? '' : 's'} from all-on · ↵ wears it for the NEXT session (one-shot: the menu's default resumes after) · ⌫ deletes it`,
    valueLabel: armed === fact.name ? 'armed' : '—',
    valueIsDefault: armed !== fact.name,
    pinnedVal: null,
    detail: null,
    detailExtra:
      fact.count === null
        ? undefined
        : [
            '↵ — the next session wears it, one-shot',
            armed === fact.name ? '↵ again — disarm (the menu’s default stands)' : '⌫ — delete the preset',
          ],
  };
}

/** The layer's NEXT SESSION panel (pure; the stills compose the same). */
export function presetLayerSummaryRows(saved: number, armed: string | null): Array<{ key: string; value: string; tone?: 'teal' }> {
  return [
    { key: 'Saved', value: `${saved} preset${saved === 1 ? '' : 's'}` },
    armed !== null
      ? { key: 'Armed', value: `● '${armed}' — one session`, tone: 'teal' }
      : { key: 'Armed', value: '— the menu’s default' },
    { key: 'Applies', value: '● the next session', tone: 'teal' },
  ];
}

/** A read that failed answers in words, never a silent empty screen. */
const UNREADABLE_KIT_CATALOGUE: KitCatalogue = {
  rows: [
    { kind: 'empty', section: 'mcp', text: 'the MCP configs could not be read — /health names the fault' },
    { kind: 'empty', section: 'skill', text: 'the skills could not be read — /health names the fault' },
  ],
};

type KitEntry = {
  label: string;
  group: string;
  groupTitle: string;
  summary: string;
  valueLabel: string;
  valueIsDefault: boolean;
  pinnedVal: string | null;
  detail: null;
  detailExtra?: string[];
  inert?: boolean;
};

const DEFAULT_VIEW: KitRowView = { own: 'on', effective: 'on', masterOff: false };

/** Key truth: only the moves that exist from this layer (the pin holds the
 *  legend to the bound keys). The store-bound screen wears KIT_LEGEND_SAVED. */
// '← back' left the legends: ← cycles the value BACKWARD on
// this screen (both arrows are bound to cycleRow) — it never leaves; the old
// label read as a second exit beside 'esc back'. The settings sibling's
// legend shape (arrows unadvertised, ↵ the named cycle) is the family form.
export const KIT_LEGEND = '↑↓ move · ↵ change · ⌫ default · esc back';

/** The value WORD a row wears (pure; the pin composes it). */
export function kitValueLabel(row: KitRow, view: KitRowView = DEFAULT_VIEW): string {
  // A note carries no value at all (its sentence is the row — the ruled
  // MCP-sourced sentence fills the wide tier's row to the cell); an empty
  // line wears the em dash.
  if (row.kind === 'note') return '';
  if (!isKitMember(row)) return '—';
  if (view.masterOff) return 'off (extension)';
  return view.own;
}

/** The NEXT SESSION panel's rows (pure; the stills compose the same). */
export function kitSummaryRows(counts: KitCounts): Array<{ key: string; value: string; tone?: 'teal' }> {
  return [
    { key: 'MCPs', value: `${counts.mcp.on} on · ${counts.mcp.off} off` },
    { key: 'Skills', value: `${counts.skill.on} on · ${counts.skill.invocable} invocable · ${counts.skill.off} off` },
    { key: 'Applies', value: '● the next session', tone: 'teal' },
  ];
}

/** The composer entry for a row (pure; the pin composes it). */
export function kitEntryOf(row: KitRow, view: KitRowView = DEFAULT_VIEW): KitEntry {
  const group = KIT_SECTION_TITLE[row.section];
  const valueLabel = kitValueLabel(row, view);
  const valueIsDefault = isKitMember(row) && !view.masterOff && view.own === 'on';
  switch (row.kind) {
    case 'empty':
    case 'note':
      return { label: row.text, group, groupTitle: group, summary: '', valueLabel, valueIsDefault: true, pinnedVal: null, detail: null, inert: true };
    case 'mcp':
      return {
        label: row.name,
        group,
        groupTitle: group,
        summary: `MCP server · ${row.scope} scope${row.extension ? ` · from the ${row.extension} extension` : ''} — on connects it for the next session; off leaves it out of that session's process entirely.`,
        valueLabel,
        valueIsDefault,
        pinnedVal: null,
        detail: null,
        detailExtra: [
          'on — connected for the next session',
          "off — absent from that session's process",
          ...(view.masterOff ? [`${row.extension} (extension) is off — this server follows it`] : []),
        ],
      };
    case 'skill':
      return {
        label: row.name,
        group,
        groupTitle: group,
        summary: `skill · ${row.source} — on is ambient (the agent can reach for it); invocable is listed but loads only when you /${row.name}; off is absent from the next session.`,
        valueLabel,
        valueIsDefault,
        pinnedVal: null,
        detail: null,
        detailExtra: [
          'on — ambient: the agent can reach for it',
          `invocable — listed; loads only when you /${row.name}`,
          'off — absent from the next session',
          ...(view.masterOff ? [`${row.extension} (extension) is off — this skill follows it`] : []),
        ],
      };
    case 'extension':
      return {
        label: `${row.name} (extension)`,
        group,
        groupTitle: group,
        summary: `the ${row.name} extension — off turns off EVERYTHING it contributes for the next session: ${row.contributes}.`,
        valueLabel,
        valueIsDefault,
        pinnedVal: null,
        detail: null,
        detailExtra: ['off turns off everything it contributes:', row.contributes],
      };
  }
}

export function KitMenuScreen({ onClose, fullScene, catalogue: given, store = kitMenuStore, workspaceDir: givenWorkspace }: KitMenuScreenProps = {}): React.ReactNode {
  const t = useMercuryTokens();
  const { columns: termCols, rows: termRows } = useTerminalSize();
  const columns = fullScene?.columns ?? termCols;
  const rows = fullScene?.rows ?? termRows;
  // The repo whose default this screen edits — the face's ground at mount
  // (per project, O-2; after a projects-picker ground move the face
  // re-mounts on the new ground).
  const [workspaceDir] = useState(() => givenWorkspace ?? process.cwd());

  // THE ENUMERATION: the runner's own doors, on EVERY OPEN and FRESH (the
  // operator's freshness ruling — "a screen never shows a stale list": the
  // fresh door drops the loader/extension/connector/active-set memos before
  // reading, so a skill created since the last open appears without a
  // restart; config home + cwd reads; never a spawn — no server is
  // connected at the face, which is exactly why the Skills section carries
  // the MCP-sourced sentence). While open, the screen listens to the skill
  // change-watcher — re-armed on the CURRENT ground, so a projects-picker
  // move never leaves it watching the old repo — and re-enumerates on its
  // signal: a skill-forge creation lands on screen as it lands on disk.
  const [catalogue, setCatalogue] = useState<KitCatalogue>(() => given ?? LOADING_KIT_CATALOGUE);
  useEffect(() => {
    if (given !== undefined) {
      setCatalogue(given);
      return;
    }
    let cancelled = false;
    const enumerate = (): void => {
      void enumerateKitCatalogueFresh(process.cwd())
        .then(read => {
          if (!cancelled) setCatalogue(read);
        })
        .catch(() => {
          if (!cancelled) setCatalogue(UNREADABLE_KIT_CATALOGUE);
        });
    };
    enumerate();
    // The watcher serves the chat session's own reloads too — the re-arm
    // (idempotent; initializes on the first open) only re-derives its
    // roots from the CURRENT ground; subscribers and pending reloads keep.
    void skillChangeDetector.rearmWatchRoots().catch(() => {});
    const unsubscribe = skillChangeDetector.subscribe(enumerate);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [given]);

  const listRows = useMemo(() => sectionRows(catalogue), [catalogue]);

  // The states — the record's DEVIATIONS (absent = on), read at mount and
  // re-read after every write-through (the visible state IS the saved
  // state; each toggle commits with its receipt).
  const [states, setStates] = useState<KitStates>(() => store.read(workspaceDir));
  const [lastReceipt, setLastReceipt] = useState<string | null>(null);
  const commitRow = (row: KitRow, next: KitRowState): string => {
    if (kitStateKey(row) === null) return '';
    const res = store.write(workspaceDir, row, next);
    if (!res.ok) return `save refused — ${res.reason}`;
    setStates(store.read(workspaceDir));
    // THE L18 CARRY (the PRIMARY road): the
    // immediately-next birth from this screen carries the RESOLVED snapshot
    // past the daemon's cached config view; the daemon's workspace-keyed
    // derivation is the FALLBACK for births the screen never sees. Once
    // per write, never at mount. A snapshot the wire would refuse is not
    // carried, and the receipt says so.
    const carry = carryNextSessionKit(listRows, store.read(workspaceDir));
    if (!carry.carried) {
      const note = `${res.receipt} · not carried (${carry.reason}) — the birth derives from the record`;
      setLastReceipt(note);
      return note;
    }
    setLastReceipt(res.receipt);
    return res.receipt;
  };
  /** The one toggle body — keyboard and pointer both land here. */
  const cycleRow = (row: KitRow | null, direction: 1 | -1): string | null => {
    if (row === null || !isKitMember(row)) return null;
    const view = kitRowView(row, states);
    if (view.masterOff && (row.kind === 'mcp' || row.kind === 'skill')) {
      return `${row.extension} (extension) is off — its servers and skills follow it; turn the extension on first`;
    }
    return commitRow(row, cycleState(row, view.own, direction));
  };
  const resetRow = (row: KitRow | null): string | null => {
    if (row === null || !isKitMember(row)) return null;
    return commitRow(row, 'on');
  };

  // ── "Save as preset…" — the action hook (the store door, P2) ─────────────
  // `p` opens a name prompt in the SETTING DETAIL body (the boot menu's own
  // action layering: esc closes the prompt first, then the screen); ↵ hands
  // the record's deltas + the roster to the bound hook — the default IS the
  // preset store, whose counted receipt (or typed refusal) paints in words.
  const [preset, setPreset] = useState<{ open: boolean; name: string; note: string | null }>({ open: false, name: '', note: null });

  // ── the PRESETS layer (`w`) — wear · disarm · delete ─────────────────────
  // The saved presets as a sub-list in the SAME panel (the boot menu's own
  // action layering — never a third titled section of the manager): ↵ arms
  // the ONE-SHOT wear for the next session (↵ on the armed row disarms),
  // ⌫ deletes, esc closes the layer. Wearing resolves the preset over THIS
  // screen's live roster and names every delta that does not bite here.
  const [presetsLayer, setPresetsLayer] = useState<{ open: boolean; facts: PresetRowFact[] }>({ open: false, facts: [] });
  const readPresetFacts = (): PresetRowFact[] =>
    listKitPresets().map(name => {
      const resolved = kitPresetDeltas(name);
      return { name, count: resolved.ok ? presetDeltaCount(resolved.deltas) : null };
    });
  const wearOrDisarm = (name: string): string => {
    if (peekWornPresetKit()?.name === name) {
      const res = disarmWornPreset();
      return res.ok ? res.receipt : res.reason;
    }
    const res = wearPresetForNextSession(name, listRows);
    return res.ok ? res.receipt : res.reason;
  };
  const deletePresetRow = (name: string): string => {
    const res = deleteKitPreset(name);
    setPresetsLayer(p => ({ ...p, facts: readPresetFacts() }));
    return res.ok ? res.receipt : res.reason;
  };
  const snapshotOf = (): KitPresetSnapshot => ({
    workspaceDir,
    deltas: deltasFromStates(states),
    members: {
      mcp: listRows.filter(r => r.kind === 'mcp').map(r => r.name),
      skills: listRows.filter(r => r.kind === 'skill').map(r => r.name),
      extensions: [...new Set(listRows.filter(r => r.kind === 'extension').map(r => r.name))],
    },
  });

  // Established-session fact for the status bar (the bounded records read —
  // dynamic import so the Concourse subsystem loads only when this screen
  // asks for it; the settings layer's exact seam). A live session is never
  // touched by this screen, and the bar says so in the same words.
  const [liveCount, setLiveCount] = useState<number | null>(null);
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
  }, []);

  const list = useInteractiveList<KitRow>({
    rows: listRows,
    rowId: kitRowId,
    idNamespace: 'kit-menu',
    // The prompt or the presets layer owns input while open (their esc
    // closes them first, never the screen).
    active: !preset.open && !presetsLayer.open,
    onClose: () => {
      // Hosted as the Boot face's manager layer — esc closes back to the
      // canonical face; standalone mounting keeps the route pop.
      if (onClose) onClose();
      else leaveCurrentSurface();
    },
    // A section's empty line or note is inert: the cursor never rests on it.
    unavailable: r => !isKitMember(r),
    // The pending note paints on the keypress; the record write runs
    // through the event loop, never inside the keypress handler (the boot
    // menu's own law).
    actions: [
      { key: 'return', hint: 'change', run: row => ({ pending: 'saving…', result: Promise.resolve().then(() => cycleRow(row, 1)) }) },
      // The ratified grammar's space alias for cycle.
      { key: ' ', hint: 'change', run: row => ({ pending: 'saving…', result: Promise.resolve().then(() => cycleRow(row, 1)) }) },
      { key: 'backspace', hint: 'default', run: row => ({ pending: 'saving…', result: Promise.resolve().then(() => resetRow(row)) }) },
      {
        key: 'p',
        hint: 'save as preset…',
        run: () => {
          setPreset({ open: true, name: '', note: null });
          return null;
        },
      },
      {
        key: 'w',
        hint: 'presets…',
        run: () => {
          setPresetsLayer({ open: true, facts: readPresetFacts() });
          return null;
        },
      },
    ],
  });

  // The saved-presets sub-list (active only while the layer owns the
  // screen): ↵/space wear (or disarm, on the armed row), ⌫ delete, esc back.
  const presetsList = useInteractiveList<PresetRowFact>({
    rows: presetsLayer.facts,
    rowId: f => `preset:${f.name}`,
    idNamespace: 'kit-presets-layer',
    active: presetsLayer.open,
    onClose: () => setPresetsLayer({ open: false, facts: [] }),
    actions: [
      { key: 'return', hint: 'wear', run: f => (f === null ? null : { pending: 'wearing…', result: Promise.resolve().then(() => wearOrDisarm(f.name)) }) },
      { key: ' ', hint: 'wear', run: f => (f === null ? null : { pending: 'wearing…', result: Promise.resolve().then(() => wearOrDisarm(f.name)) }) },
      { key: 'backspace', hint: 'delete', run: f => (f === null ? null : { pending: 'deleting…', result: Promise.resolve().then(() => deletePresetRow(f.name)) }) },
    ],
  });

  // ←/→ cycle back/forward — the vertical list decodes no horizontal
  // motion, so these land here (the boot menu's own pattern); the receipt
  // reaches the status bar through lastReceipt.
  const selectedRow = list.selectedRow;
  useInput(
    (_input, key, event) => {
      if (!key.leftArrow && !key.rightArrow) return;
      if (selectedRow == null) return;
      event.stopImmediatePropagation();
      void Promise.resolve().then(() => cycleRow(selectedRow, key.leftArrow ? -1 : 1));
    },
    { isActive: !preset.open && !presetsLayer.open },
  );

  // The prompt's keys (active only while it is open): printable bytes type
  // the name (bounded), ⌫ edits, ↵ saves through the hook, esc cancels —
  // consumed here so no owner beneath sees them.
  useInput(
    (input, key, event) => {
      event.stopImmediatePropagation();
      if (key.escape) {
        setPreset({ open: false, name: '', note: null });
        return;
      }
      if (key.return) {
        const problem = presetNameProblem(preset.name);
        if (problem !== null) {
          setPreset(p => ({ ...p, note: problem }));
          return;
        }
        const res = kitPresetHook().save(preset.name.trim(), snapshotOf());
        setPreset(p => ({ ...p, note: res.ok ? res.receipt : res.reason }));
        return;
      }
      if (key.backspace || key.delete) {
        setPreset(p => ({ ...p, name: p.name.slice(0, -1), note: null }));
        return;
      }
      if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
      // eslint-disable-next-line no-control-regex
      if (input.length > 0 && !/[\x00-\x1f\x7f]/.test(input)) {
        setPreset(p => ({ ...p, name: (p.name + input).slice(0, PRESET_NAME_MAX), note: null }));
      }
    },
    { isActive: preset.open },
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
      // The repo this default kit belongs to (per project).
      dirBase: basename(process.cwd()) || process.cwd(),
      dirTail: '',
    };
    // THE PRESETS LAYER owns the panel while open: the saved presets as the
    // list (the armed one wearing the word), its own legend and NEXT
    // SESSION truth — the manager's rows return on esc.
    if (presetsLayer.open) {
      const armed = peekWornPresetKit()?.name ?? null;
      const empty = presetsLayer.facts.length === 0;
      return {
        entries: empty
          ? [{ label: PRESET_LAYER_EMPTY, group: 'saved presets', groupTitle: 'saved presets', summary: '', valueLabel: '—', valueIsDefault: true, pinnedVal: null, detail: null, inert: true } satisfies KitEntry]
          : presetsLayer.facts.map(f => presetLayerEntryOf(f, armed)),
        selIdx: empty ? -1 : presetsList.selectedIndex,
        title: 'presets',
        summaryTitle: 'NEXT SESSION',
        summaryRows: presetLayerSummaryRows(presetsLayer.facts.length, armed),
        environment,
        statusRight:
          (presetsList.note ?? (armed !== null ? `preset '${armed}' armed — the next session wears it, then the menu's default resumes` : kitStatusLine(states.size))) +
          (liveCount !== null ? `  ·  ${liveCount} established session${liveCount === 1 ? '' : 's'} unchanged` : ''),
        glowWord: wordGlow,
        legend: KIT_LEGEND_PRESETS,
      };
    }
    const entries = listRows.map(row => kitEntryOf(row, kitRowView(row, states)));
    const selectable = selectedRow !== null && isKitMember(selectedRow);
    // The record's own truth (the boot menu's grammar): the receipt of the
    // last write, else how many choices stand — a fresh record says the
    // all-on truth, never a nag; the established-session fact rides beside.
    const statusRight =
      (list.note ?? lastReceipt ?? kitStatusLine(states.size)) +
      (liveCount !== null ? `  ·  ${liveCount} established session${liveCount === 1 ? '' : 's'} unchanged` : '');
    return {
      entries,
      // The cursor parked on an inert line composes no focused row.
      selIdx: selectable ? list.selectedIndex : -1,
      title: 'mcps & skills',
      summaryTitle: 'NEXT SESSION',
      summaryRows: kitSummaryRows(kitCounts(listRows, states)),
      moreHint: '… (the trail continues — a taller terminal shows it whole)',
      environment,
      statusRight,
      glowWord: wordGlow,
      legend: preset.open ? KIT_LEGEND_PROMPT : KIT_LEGEND_PRESET,
      ...(preset.open
        ? { detailOverride: presetPromptLines(preset.name, preset.note) }
        : selectable
          ? {}
          : {
              detailOverride: [
                'nothing to toggle yet for this project',
                '',
                'MCP servers and skills you add appear here,',
                'on by default — the next session starts with',
                'everything that is on.',
              ],
            }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listRows, states, selectedRow, list.selectedIndex, list.note, lastReceipt, liveCount, preset, presetsLayer, presetsList.selectedIndex, presetsList.note, mainModel, wordGlow?.peakCell, wordGlow?.gainLevel]);

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
        // The pointer target rides whichever list owns the screen: the
        // presets layer's saved rows while it is open, else the manager's.
        if (entryIdx !== undefined && presetsLayer.open) {
          const fact = presetsLayer.facts[entryIdx];
          if (fact !== undefined) {
            const props = presetsList.rowProps(fact, entryIdx);
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
                {hover => renderSceneLine(line, hover && !props.selected && !props.unavailable ? { label: fact.name, color: t.info } : undefined)}
              </InteractiveRow>
            );
          }
        }
        const row = entryIdx !== undefined && !presetsLayer.open ? listRows[entryIdx] : undefined;
        if (row !== undefined && entryIdx !== undefined) {
          const props = list.rowProps(row, entryIdx);
          return (
            // The composed CONTROL PLANE row IS the pointer target — click
            // parity rides InteractiveRow (a click selects, a second click
            // cycles); the selected paint stays the composed grammar
            // (❯ + bold-underline ivory).
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
              {hover => renderSceneLine(line, hover && !props.selected && !props.unavailable ? { label: kitEntryOf(row).label, color: t.info } : undefined)}
            </InteractiveRow>
          );
        }
        return (
          <Box key={`kitline-${i}`} height={1} flexShrink={0}>
            {line.length > 0 ? renderSceneLine(line) : null}
          </Box>
        );
      })}
    </Box>
  );
}
