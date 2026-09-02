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


interface KitMenuScreenProps {
  onClose?: () => void;
  fullScene?: { columns: number; rows: number };
  catalogue?: KitCatalogue;
  store?: KitMenuStore;
  workspaceDir?: string;
}

export const KIT_LEGEND_SAVED = '↑↓ move · ↵ change (saved) · ⌫ default · esc back';
export const KIT_LEGEND_PRESET = '↑↓ move · ↵ change (saved) · ⌫ default · p save as preset… · w presets… · esc back';
export const KIT_LEGEND_PROMPT = 'type a name · ↵ save · esc cancel';
export const KIT_LEGEND_PRESETS = '↑↓ move · ↵ wear next session · ⌫ delete · esc back';
export const PRESET_LAYER_EMPTY = "no presets saved — 'p' on the menu saves the current record under a name";

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

export function kitStatusLine(changed: number): string {
  return changed > 0
    ? `${changed} choice${changed === 1 ? '' : 's'} saved — applies to the next session`
    : 'everything on — changes apply to the next session, never a running one';
}

export type PresetRowFact = { name: string; count: number | null };

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

export function presetLayerSummaryRows(saved: number, armed: string | null): Array<{ key: string; value: string; tone?: 'teal' }> {
  return [
    { key: 'Saved', value: `${saved} preset${saved === 1 ? '' : 's'}` },
    armed !== null
      ? { key: 'Armed', value: `● '${armed}' — one session`, tone: 'teal' }
      : { key: 'Armed', value: '— the menu’s default' },
    { key: 'Applies', value: '● the next session', tone: 'teal' },
  ];
}

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

export const KIT_LEGEND = '↑↓ move · ↵ change · ⌫ default · esc back';

export function kitValueLabel(row: KitRow, view: KitRowView = DEFAULT_VIEW): string {
  if (row.kind === 'note') return '';
  if (!isKitMember(row)) return '—';
  if (view.masterOff) return 'off (extension)';
  return view.own;
}

export function kitSummaryRows(counts: KitCounts): Array<{ key: string; value: string; tone?: 'teal' }> {
  return [
    { key: 'MCPs', value: `${counts.mcp.on} on · ${counts.mcp.off} off` },
    { key: 'Skills', value: `${counts.skill.on} on · ${counts.skill.invocable} invocable · ${counts.skill.off} off` },
    { key: 'Applies', value: '● the next session', tone: 'teal' },
  ];
}

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
  const [workspaceDir] = useState(() => givenWorkspace ?? process.cwd());

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
    void skillChangeDetector.rearmWatchRoots().catch(() => {});
    const unsubscribe = skillChangeDetector.subscribe(enumerate);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [given]);

  const listRows = useMemo(() => sectionRows(catalogue), [catalogue]);

  const [states, setStates] = useState<KitStates>(() => store.read(workspaceDir));
  const [lastReceipt, setLastReceipt] = useState<string | null>(null);
  const commitRow = (row: KitRow, next: KitRowState): string => {
    if (kitStateKey(row) === null) return '';
    const res = store.write(workspaceDir, row, next);
    if (!res.ok) return `save refused — ${res.reason}`;
    setStates(store.read(workspaceDir));
    const carry = carryNextSessionKit(listRows, store.read(workspaceDir));
    if (!carry.carried) {
      const note = `${res.receipt} · not carried (${carry.reason}) — the birth derives from the record`;
      setLastReceipt(note);
      return note;
    }
    setLastReceipt(res.receipt);
    return res.receipt;
  };
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

  const [preset, setPreset] = useState<{ open: boolean; name: string; note: string | null }>({ open: false, name: '', note: null });

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
    active: !preset.open && !presetsLayer.open,
    onClose: () => {
      if (onClose) onClose();
      else leaveCurrentSurface();
    },
    unavailable: r => !isKitMember(r),
    actions: [
      { key: 'return', hint: 'change', run: row => ({ pending: 'saving…', result: Promise.resolve().then(() => cycleRow(row, 1)) }) },
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
      dirBase: basename(process.cwd()) || process.cwd(),
      dirTail: '',
    };
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
    const statusRight =
      (list.note ?? lastReceipt ?? kitStatusLine(states.size)) +
      (liveCount !== null ? `  ·  ${liveCount} established session${liveCount === 1 ? '' : 's'} unchanged` : '');
    return {
      entries,
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
