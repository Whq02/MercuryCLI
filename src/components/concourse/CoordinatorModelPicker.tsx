import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from '../../ink.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { GLYPH, padTo } from '../mercury-ui/glyphs.js';
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js';
import { useInteractiveList, type AsyncListNote } from '../mercury-ui/useInteractiveList.js';
import { shedToFit } from '../mercury-ui/geometry.js';
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js';
import {
  coordinatorModelStatusLabel,
  coordinatorModelStatusWord,
  type CoordinatorModelEntryV1,
  type CoordinatorModelRegistryV1,
  type CoordinatorSwitchReceiptV1,
} from '../../services/concourse/coordinatorModels.js';
import { providerDisplayName, type CallModelRoute } from '../../services/providers/routeLaw.js';
import { NO_EFFORT_CONTROL_LABEL, resolveEffortTruth } from '../../utils/effort.js';
import { providerFrontierLine } from '../../utils/model/providerFrontier.js';
import type { ConcourseCallbacks } from './contracts.js';
import { RowPickModal } from './RowPickModal.js';

// ============================================================================
//  CoordinatorModelPicker — the rail chip's ⌄ opened. ONE modal list over
//  the COMPOSED registry — the mode row (closed vocabulary, cycle on ↵)
//  above the model rows, grouped under their provider headers. EVERY model
//  row is selectable (the operator's ruling): a row that is not ready
//  carries its truthful label in the tail — not signed in, provider
//  unavailable, not in the catalogue (credential/catalogue facts only; the
//  verdict-word removal ruled every qualification word off every row) — and
//  ↵ still applies it; the wire decides the turn and states its reason in
//  the turn's own reply.
//  Selection calls the route's switch callback: the OWNER validates + writes
//  and the receipt paints on the note line — the label and the safe-boundary
//  statement included (a switch never retargets a running coordinator turn;
//  identity/conversation/managed sessions untouched). Labels are computed at
//  OPEN + after every switch (read-time law); the picker never caches a
//  stale registry across actions.
// ============================================================================

type PickerRow =
  | { kind: 'mode' }
  | { kind: 'header'; source: CallModelRoute | 'unrecognised'; label: string }
  | { kind: 'model'; entry: CoordinatorModelEntryV1 };

interface PickerFacts {
  registry: CoordinatorModelRegistryV1;
  requestedMode: 'off' | 'rules-only' | 'agent-assisted';
  effectiveMode: 'off' | 'rules-only' | 'agent-assisted';
  fallbackReason?: string;
  configuredModel?: string;
}

const MODE_ORDER = ['off', 'rules-only', 'agent-assisted'] as const;
const MODE_LABEL: Record<(typeof MODE_ORDER)[number], string> = {
  off: 'Off',
  'rules-only': 'Rules only',
  'agent-assisted': 'Agent-assisted (experimental)',
};

/** What ↵ on this row does — the preview-before-apply sentence for the
 *  focused row's detail line. A ready row states the safe boundary; every
 *  other row states that the pick stands and what the next turn needs. */
function pickConsequence(entry: CoordinatorModelEntryV1): string {
  switch (entry.availability) {
    case 'ready':
      return 'switch applies at the next coordinator turn — identity, conversation and managed sessions untouched';
    case 'not-signed-in':
      return `selectable — a coordinator turn on it fails on the wire until ${entry.detail ?? '/logins'} signs in`;
    case 'provider-unavailable':
      return `selectable — attaches in /model (the ${providerDisplayName(entry.source)} group); the wire refuses until then`;
    case 'not-in-catalogue':
      return 'selectable — the wire decides whether the provider still serves it';
  }
}

function receiptLine(r: CoordinatorSwitchReceiptV1): string {
  if (r.outcome === 'refused') {
    return `refused: ${r.value} — ${r.reason ?? 'unknown'}${r.detail ? ` (${r.detail})` : ''}`;
  }
  if (r.outcome === 'no-change') return `no change — ${r.value} already set${r.detail ? ` (${r.detail})` : ''}`;
  if (r.target === 'mode') return `mode set: ${r.value} — ${r.boundary}`;
  // The effort receipt names the tier the coordinator model actually runs
  // when that differs from the pick (the owner's detail) — "effort set:
  // max" alone claimed a tier a low|high|max model never sends.
  if (r.target === 'effort') return `coordinator effort set: ${r.value}${r.detail ? ` — ${r.detail}` : ''} · ${r.boundary}`;
  return `switched: ${r.value}${r.detail ? ` — ${r.detail}` : ''} · ${r.boundary}`;
}

/** The stops the coordinator model's OWN vocabulary offers, from the one
 *  effort owner, resolved for the coordinator's call (thinking disabled —
 *  a lane whose effort dial is its reasoning dial sends no dial there, and
 *  the row says the pick is saved, not sent). A model with no effort
 *  control offers one inert row that says so instead of the full ladder. */
function coordinatorEffortOptions(modelId: string): Array<{ id: string; label: string }> {
  const truth = resolveEffortTruth(modelId, undefined, { thinkingEnabled: false });
  if (!truth.supportsEffort) {
    return [{ id: '', label: `${NO_EFFORT_CONTROL_LABEL} — ${modelId} takes no effort setting` }];
  }
  const stops = truth.selectable.map(level => ({ id: level, label: level }));
  return truth.suppressedBy === 'thinking-off'
    ? stops.map(stop => ({ ...stop, label: `${stop.label} · saved, not sent — the coordinator calls with thinking off` }))
    : stops;
}

export function CoordinatorModelPicker({
  callbacks,
  onClose,
  nested = false,
  allottedRows,
  allottedWidth,
}: {
  callbacks: Pick<ConcourseCallbacks, 'switchCoordinatorModel' | 'switchCoordinatorMode' | 'switchCoordinatorEffort'>;
  onClose: () => void;
  /** One frame, one title: a NESTED mount (the CoordinatorSurface settings
   *  branch) already owns the frame and the 'COORDINATOR — settings' title
   *  — the picker sheds its own border, marginTop and title there. */
  nested?: boolean;
  /** Band honesty: the rows the HOST allots to the picker. The window
   *  budgets against THIS truth minus the picker's own chrome — never
   *  against termRows-13 (the full-height mount law overpainted the 80x24
   *  band). Absent ⇒ the legacy heuristic stands. */
  allottedRows?: number;
  /** The host's content width — the legend sheds whole hint segments to fit
   *  it (the unwrapped joined line broke after a separator in the 42-col
   *  pane and dangled ' · ' at the line end). Absent ⇒ a conservative 40
   *  columns. */
  allottedWidth?: number;
}): React.ReactNode {
  const t = useMercuryTokens();
  const [facts, setFacts] = useState<PickerFacts | null>(null);
  // A rejected registry load settles a typed failed state (never a
  // permanent 'composing the registry…') and 'r' retries; a cancelled
  // (unmounted) load never writes.
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const loadEpochRef = React.useRef(0);
  const load = useCallback(async (): Promise<void> => {
    const epoch = ++loadEpochRef.current;
    setLoadFailed(null);
    try {
      const models = await import('../../services/concourse/coordinatorModels.js');
      const lane = await import('../../services/concourse/coordinatorLane.js');
      const { getGlobalConfig } = await import('../../utils/config.js');
      const [registry, effective] = await Promise.all([
        models.composeCoordinatorModelRegistry(),
        lane.resolveEffectiveCoordinator(),
      ]);
      const cfg = getGlobalConfig().concourseCoordinator;
      // The registry tolerates alias spellings ('opus', 'fable[1m]') — the
      // configured marker and the opening cursor compare against
      // entry.modelId, so canonicalize ONCE here or a validated configured
      // model reads as unconfigured.
      const configuredModel =
        cfg?.assistModel !== undefined
          ? await models.canonicalCoordinatorModelId(cfg.assistModel)
          : undefined;
      if (epoch !== loadEpochRef.current) return; // superseded/cancelled — never write
      setFacts({
        registry,
        requestedMode: effective.resolution.requested,
        effectiveMode: effective.resolution.effective,
        ...(effective.resolution.fallbackReason !== undefined
          ? { fallbackReason: effective.resolution.fallbackReason }
          : {}),
        ...(configuredModel !== undefined ? { configuredModel } : {}),
      });
    } catch (e) {
      if (epoch !== loadEpochRef.current) return;
      setLoadFailed(String(e).slice(0, 140));
    }
  }, []);
  useEffect(() => {
    void load();
    return () => {
      loadEpochRef.current += 1; // cancel: a late settle writes nothing
    };
  }, [load]);

  // THE EFFORT DOORWAY (operator-ruled): e on the SELECTED MODEL row opens
  // the SAME RowPickModal the session rows' e opens — one UI, a second
  // doorway; the pick persists as the coordinator model's own effort
  // (switchCoordinatorEffort) and its turns actually carry it. The key
  // fires only while the filter query is EMPTY — with live query text
  // every printable keeps feeding the filter (typing f-a-b-l-e must never
  // pop a modal mid-word), and the legend advertises e exactly when it
  // applies.
  const [effortPick, setEffortPick] = useState<CoordinatorModelEntryV1 | null>(null);
  const [effortNote, setEffortNote] = useState<string | null>(null);
  // Whether the cursor sits on a model row RIGHT NOW — read by the search
  // handler (registered before the list hook) at event time, written each
  // render after the list computes. The e key leaves the filter for the
  // effort doorway ONLY where the doorway actually fires (empty query AND a
  // model row under the cursor); everywhere else e types like any printable
  // — never an inert key, never a half-eaten one.
  const effortDoorArmedRef = React.useRef(false);

  // SEARCH: type-to-filter over displayName/modelId/provider. The handler
  // registers BEFORE the list hook, so printables/backspace feed the query
  // and the FIRST esc clears it (the second closes — the list's own cancel
  // path). Layered exactly like the concourse '/' filter lens. While the
  // effort modal is up it owns every key — this handler yields whole.
  const [query, setQuery] = useState('');
  useInput((input, key, event) => {
    if (effortPick !== null) return;
    if (facts === null && loadFailed !== null && input === 'r') {
      event.stopImmediatePropagation();
      void load();
      return;
    }
    if (key.escape && query.length > 0) {
      event.stopImmediatePropagation();
      setQuery('');
      return;
    }
    if ((key.backspace || key.delete) && query.length > 0) {
      event.stopImmediatePropagation();
      setQuery(q => q.slice(0, -1));
      return;
    }
    if (
      input.length > 0 &&
      !key.ctrl &&
      !key.meta &&
      !key.tab &&
      !key.return &&
      !key.escape &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow &&
      !key.pageUp &&
      !key.pageDown &&
      // An e that the effort doorway will actually take (empty query, model
      // row under the cursor) is declined here so the list action below
      // receives it; every other e feeds the filter like any printable.
      !(input === 'e' && query.length === 0 && effortDoorArmedRef.current)
    ) {
      event.stopImmediatePropagation();
      setQuery(q => q + input);
    }
  });

  // The name column adapts to the host width: the wide modal keeps the
  // 28-column grid; a narrow nested pane shrinks it to the longest name so
  // the tail keeps room for at least the state word. A label that cannot
  // fit the tail paints as its state word (the focused detail line below
  // spells the whole label).
  const hostWidth = Math.max(16, allottedWidth ?? 40);
  const longestName = Math.max(8, ...(facts?.registry.entries ?? []).map(e => e.displayName.length));
  const nameCols = hostWidth >= 64 ? 28 : Math.min(28, longestName + 1, Math.max(12, hostWidth - 2 - 14));
  const tailCols = Math.max(6, hostWidth - 2 - nameCols);
  const tailLabel = (entry: CoordinatorModelEntryV1): string => {
    const full = coordinatorModelStatusLabel(entry);
    return full.length <= tailCols ? full : coordinatorModelStatusWord(entry);
  };

  const q = query.trim().toLowerCase();
  const matches = (e: CoordinatorModelEntryV1): boolean =>
    q.length === 0 ||
    e.displayName.toLowerCase().includes(q) ||
    e.modelId.toLowerCase().includes(q) ||
    providerDisplayName(e.source).toLowerCase().includes(q);
  // Group order = the registry's own entry order (first appearance) — the
  // one naming owner labels each group; no second order or label table.
  const sourceOrder: Array<CallModelRoute | 'unrecognised'> = [];
  for (const e of facts?.registry.entries ?? []) {
    if (!sourceOrder.includes(e.source)) sourceOrder.push(e.source);
  }
  const rows: PickerRow[] = facts
    ? [
        { kind: 'mode' },
        ...sourceOrder.flatMap((source): PickerRow[] => {
          const group = facts.registry.entries.filter(e => e.source === source && matches(e));
          return group.length === 0
            ? []
            : [
                { kind: 'header', source, label: providerDisplayName(source) },
                ...group.map(entry => ({ kind: 'model' as const, entry })),
              ];
        }),
      ]
    : [];

  const list = useInteractiveList<PickerRow>({
    rows,
    rowId: r => (r.kind === 'model' ? `model:${r.entry.modelId}` : r.kind === 'header' ? `header:${r.label}` : r.kind),
    onClose,
    idNamespace: 'coordinator-picker',
    // The effort modal owns the keys while it is up — the list keeps its
    // cursor but decodes nothing (the RowPickModal grammar).
    active: effortPick === null,
    ...(facts?.configuredModel !== undefined ? { initialId: `model:${facts.configuredModel}` } : {}),
    // Only the group headers are walked past: every model row is a live
    // choice whatever its label says.
    unavailable: r => r.kind === 'header',
    actions: [
      {
        // The second doorway to the ONE effort picker UI: only a model row
        // answers it, and only with an empty filter (the search handler
        // consumes e otherwise).
        key: 'e',
        hint: 'effort',
        when: r => r.kind === 'model',
        run: (row): null => {
          if (row?.kind === 'model') {
            setEffortNote(null);
            setEffortPick(row.entry);
          }
          return null;
        },
      },
      {
        key: 'return',
        hint: 'select',
        run: (row): AsyncListNote | null => {
          if (!row || !facts) return null;
          if (row.kind === 'mode') {
            const next = MODE_ORDER[(MODE_ORDER.indexOf(facts.requestedMode) + 1) % MODE_ORDER.length]!;
            return {
              pending: `setting mode ${MODE_LABEL[next]}…`,
              result: callbacks.switchCoordinatorMode(next).then(r => {
                void load();
                return receiptLine(r);
              }),
            };
          }
          if (row.kind === 'model') {
            return {
              pending: `switching to ${row.entry.displayName}…`,
              result: callbacks.switchCoordinatorModel(row.entry.modelId).then(r => {
                void load();
                return receiptLine(r);
              }),
            };
          }
          return null;
        },
      },
    ],
  });
  // Written per render, read at event time by the search handler above.
  effortDoorArmedRef.current = list.selectedRow?.kind === 'model';

  // The list is WINDOWED within the viewport — the window follows the
  // selection, whole rows shed at the edges as '±N more' (never a clipped
  // label), and the detail/note/help rows below stay retained at every
  // size. Original indices ride into rowProps so pointer hit-regions stay
  // true under the window.
  //
  // The span budgets against the HOST-allotted band minus the picker's OWN
  // chrome, so picker rows can never overpaint the shell's status rail/help
  // at 80x24. Chrome: shed indicators 2 (reserved) + detail 2 (marginTop +
  // row) + note 1 + help 1, + the active query row, + (framed mounts only)
  // border 2 + marginTop 1 + title 1.
  const { rows: termRows } = useTerminalSize();
  const ownChrome = 6 + (query.length > 0 ? 1 : 0) + (nested ? 0 : 4);
  const viewSpan =
    allottedRows !== undefined
      ? Math.max(3, allottedRows - ownChrome)
      : Math.max(4, termRows - 13);
  const selIdxRaw = rows.findIndex(
    r => list.selectedRow !== null && (r.kind === 'model' ? `model:${r.entry.modelId}` : r.kind === 'header' ? `header:${r.label}` : r.kind) === (list.selectedRow.kind === 'model' ? `model:${list.selectedRow.entry.modelId}` : list.selectedRow.kind === 'header' ? `header:${list.selectedRow.label}` : list.selectedRow.kind),
  );
  const selIdx = Math.max(0, selIdxRaw);
  const windowFrom =
    rows.length <= viewSpan ? 0 : Math.min(Math.max(0, selIdx - Math.floor(viewSpan / 2)), rows.length - viewSpan);
  const visibleRows: Array<[PickerRow, number]> = rows.slice(windowFrom, windowFrom + viewSpan).map((r, j) => [r, windowFrom + j]);
  const shedAbove = windowFrom;
  const shedBelow = Math.max(0, rows.length - (windowFrom + viewSpan));

  // Preview for the FOCUSED row: the label, the identity line, the provider
  // and what a pick does — before selection, not after.
  const selected = list.selectedRow;
  const detail =
    selected === null
      ? ''
      : selected.kind === 'mode'
        ? (facts?.fallbackReason ??
          // No ←/→ glyphs in hint position: the advertised-key census reads
          // them as an arrows-lr binding this row does not have (↵ cycles).
          'cycles Off / Rules only / Agent-assisted · applies at the next coordinator resolve')
        : selected.kind === 'model'
          ? selected.entry.availability === 'ready'
            ? [
                // The canonical surface's own identity/limits line leads,
                // then provider, then boundary.
                ...(selected.entry.description !== undefined ? [selected.entry.description] : []),
                `${providerDisplayName(selected.entry.source)} route`,
                pickConsequence(selected.entry),
              ].join(' · ')
            : [
                coordinatorModelStatusLabel(selected.entry),
                ...(selected.entry.description !== undefined ? [selected.entry.description] : []),
                pickConsequence(selected.entry),
              ].join(' · ')
          : '';

  return (
    // Nested mounts render FRAMELESS — the settings branch owns the one
    // frame and the one title; a standalone mount keeps its own.
    <Box
      flexDirection="column"
      {...(nested ? {} : { borderStyle: 'round' as const, borderColor: t.info, paddingX: 1, marginTop: 1 })}
    >
      {nested ? null : (
        <Text bold color={t.info}>
          COORDINATOR
        </Text>
      )}
      {query.length > 0 ? (
        <Box height={1} overflow="hidden">
          <Text wrap="truncate-end">
            <Text color={t.info}>/ </Text>
            <Text color={t.textPrimary}>{query}</Text>
            <Text color={t.info}>{GLYPH.caretBlock}</Text>
            {rows.every(r => r.kind !== 'model') ? <Text color={t.textMuted}>  — no model matches</Text> : null}
          </Text>
        </Box>
      ) : null}
      {facts === null && loadFailed !== null ? (
        // The typed failed state (never a permanent spinner): the reason +
        // the one retry action, keyboard ('r') and click through the same load.
        <Box flexDirection="column">
          <Text color={t.failure} wrap="truncate-end">
            the model registry failed to compose — {loadFailed}
          </Text>
          <InteractiveRow id="coordinator:picker:retry" directActivate onActivate={() => void load()}>
            {hover => <Text color={hover ? 'infoShimmer' : t.info}>▸ retry · r</Text>}
          </InteractiveRow>
        </Box>
      ) : facts === null ? (
        <Text color={t.textMuted}>composing the registry…</Text>
      ) : (
        <Box flexDirection="column">
          {shedAbove > 0 ? (
            <Box height={1} overflow="hidden">
              <Text color={t.textMuted}>{`↑ +${shedAbove} more`}</Text>
            </Box>
          ) : null}
          {visibleRows.map(([r, i]) => {
            const props = list.rowProps(r, i);
            if (r.kind === 'mode') {
              const downgraded = facts.effectiveMode !== facts.requestedMode;
              return (
                <InteractiveRow key={props.id} {...props} width="100%" height={1}>
                  <Text wrap="truncate-end">
                    <Text color={t.textSecondary}>{padTo('Mode', nameCols + 2)}</Text>
                    <Text color={t.textPrimary}>{MODE_LABEL[facts.requestedMode]}</Text>
                    {downgraded ? (
                      <Text color={t.textMuted}>{` ${GLYPH.turns} runs ${MODE_LABEL[facts.effectiveMode]}`}</Text>
                    ) : null}
                  </Text>
                </InteractiveRow>
              );
            }
            if (r.kind === 'header') {
              const frontier = r.source === 'unrecognised' ? undefined : providerFrontierLine(r.source);
              return (
                <InteractiveRow key={props.id} {...props} width="100%" height={1}>
                  {() => (
                    <Text wrap="truncate-end">
                      <Text bold color={t.textMuted}>
                        {r.label}
                      </Text>
                      {frontier ? <Text color={t.textMuted}>{`  ${frontier}`}</Text> : null}
                    </Text>
                  )}
                </InteractiveRow>
              );
            }
            const ready = r.entry.availability === 'ready';
            const configured = r.entry.modelId === facts.configuredModel;
            const marker = configured ? (ready ? GLYPH.ok : GLYPH.warn) : ' ';
            const markerColor = configured ? (ready ? t.success : t.warning) : t.textMuted;
            // The marker+name column is PINNED (flexShrink 0) so the tail
            // can never shrink INSIDE the padded name column and break the
            // label grid. A ready row's tail is the canonical identity line;
            // every other row's tail is its truthful label, in warning ink
            // (the focused detail line below carries the identity line and
            // what a pick does).
            return (
              <InteractiveRow key={props.id} {...props} width="100%" height={1}>
                <Box flexShrink={0}>
                  <Text>
                    <Text color={markerColor}>{marker} </Text>
                    <Text color={t.textPrimary}>{padTo(r.entry.displayName, nameCols)}</Text>
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1} overflow="hidden">
                  {/* The provider lives on the group header. */}
                  <Text color={ready ? t.textMuted : t.warning} wrap="truncate-end">
                    {ready ? (r.entry.description ?? '') : tailLabel(r.entry)}
                  </Text>
                </Box>
              </InteractiveRow>
            );
          })}
          {shedBelow > 0 ? (
            <Box height={1} overflow="hidden">
              <Text color={t.textMuted}>{`↓ +${shedBelow} more`}</Text>
            </Box>
          ) : null}
          <Box height={1} overflow="hidden" marginTop={1}>
            <Text color={t.textMuted} wrap="truncate-end">
              {detail}
            </Text>
          </Box>
          <Box height={1} overflow="hidden">
            <Text color={(effortNote ?? list.note)?.startsWith('refused') ? t.warning : t.textSecondary} wrap="truncate-end">
              {effortNote ??
                list.note ??
                (facts.registry.selectable
                  ? '↵ selects — every row is selectable; its label says what the next turn needs'
                  : 'no models listed — /model attaches a provider')}
            </Text>
          </Box>
        </Box>
      )}
      <Box height={1} overflow="hidden">
        <Text color={t.textMuted} wrap="truncate-end">
          {shedToFit(
            [
              { text: `${list.motionHint} browse`, priority: 3 },
              { text: '↵ select', priority: 2 },
              // The effort doorway advertises itself exactly when it fires:
              // a model row under the cursor and no filter text (with a
              // query, e types into the filter like every printable).
              ...(list.selectedRow?.kind === 'model' && query.length === 0
                ? [{ text: 'e effort', priority: 2 }]
                : []),
              { text: 'type to filter', priority: 1 },
              { text: `esc ${query.length > 0 ? 'clears' : 'back'}`, priority: 4 },
            ],
            Math.max(16, allottedWidth ?? 40),
            ' · ',
          )
            .map(p => p.text)
            .join(' · ')}
        </Text>
      </Box>
      {effortPick !== null ? (
        // THE ONE EFFORT PICKER UI, second doorway (RowPickModal — the same
        // component e on a session row opens): the pick persists as the
        // coordinator model's own effort and the receipt paints on the note
        // line. Mounted inside the picker's own box, over its rows.
        <RowPickModal
          cols={Math.max(40, allottedWidth ?? 40)}
          rows={allottedRows ?? 18}
          titlePrefix="EFFORT"
          title={`coordinator · ${effortPick.displayName}`}
          legend="↵ sets the coordinator's effort · esc keeps it"
          options={coordinatorEffortOptions(effortPick.modelId)}
          onPick={id => {
            setEffortPick(null);
            // The inert no-effort-control row picks nothing.
            if (id === '') return;
            void callbacks.switchCoordinatorEffort?.(id).then(r => {
              setEffortNote(receiptLine(r));
              void load();
            });
          }}
          onClose={() => setEffortPick(null)}
        />
      ) : null}
    </Box>
  );
}
