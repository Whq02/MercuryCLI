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
  if (r.target === 'effort') return `coordinator effort set: ${r.value}${r.detail ? ` — ${r.detail}` : ''} · ${r.boundary}`;
  return `switched: ${r.value}${r.detail ? ` — ${r.detail}` : ''} · ${r.boundary}`;
}

function coordinatorEffortOptions(modelId: string): Array<{ id: string; label: string }> {
  const truth = resolveEffortTruth(modelId, undefined, { thinkingEnabled: false });
  if (!truth.supportsEffort) {
    return [{ id: '', label: `${NO_EFFORT_CONTROL_LABEL} — ${modelId} takes no effort setting` }];
  }
  const stops = truth.selectable.map(level => ({ id: level, label: level }));
  return truth.suppressedBy === 'thinking-off'
    ? stops.map(stop => ({ ...stop, label: `${stop.label} · saved, not sent — the coordinator calls with thinking off` }))
    : truth.flooredBy === 'thinking-off'
      ? stops.map(stop => ({ ...stop, label: `${stop.label} · saved, not sent — the coordinator calls with thinking off and sends ${truth.wire}` }))
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
  nested?: boolean;
  allottedRows?: number;
  allottedWidth?: number;
}): React.ReactNode {
  const t = useMercuryTokens();
  const [facts, setFacts] = useState<PickerFacts | null>(null);
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
      const configuredModel =
        cfg?.assistModel !== undefined
          ? await models.canonicalCoordinatorModelId(cfg.assistModel)
          : undefined;
      if (epoch !== loadEpochRef.current) return;
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
      loadEpochRef.current += 1;
    };
  }, [load]);

  const [effortPick, setEffortPick] = useState<CoordinatorModelEntryV1 | null>(null);
  const [effortNote, setEffortNote] = useState<string | null>(null);
  const effortDoorArmedRef = React.useRef(false);

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
      !(input === 'e' && query.length === 0 && effortDoorArmedRef.current)
    ) {
      event.stopImmediatePropagation();
      setQuery(q => q + input);
    }
  });

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
    active: effortPick === null,
    ...(facts?.configuredModel !== undefined ? { initialId: `model:${facts.configuredModel}` } : {}),
    unavailable: r => r.kind === 'header',
    actions: [
      {
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
  effortDoorArmedRef.current = list.selectedRow?.kind === 'model';

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

  const selected = list.selectedRow;
  const detail =
    selected === null
      ? ''
      : selected.kind === 'mode'
        ? (facts?.fallbackReason ??
          'cycles Off / Rules only / Agent-assisted · applies at the next coordinator resolve')
        : selected.kind === 'model'
          ? selected.entry.availability === 'ready'
            ? [
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
            return (
              <InteractiveRow key={props.id} {...props} width="100%" height={1}>
                <Box flexShrink={0}>
                  <Text>
                    <Text color={markerColor}>{marker} </Text>
                    <Text color={t.textPrimary}>{padTo(r.entry.displayName, nameCols)}</Text>
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1} overflow="hidden">
                  {}
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
        <RowPickModal
          cols={Math.max(40, allottedWidth ?? 40)}
          rows={allottedRows ?? 18}
          titlePrefix="EFFORT"
          title={`coordinator · ${effortPick.displayName}`}
          legend="↵ sets the coordinator's effort · esc keeps it"
          options={coordinatorEffortOptions(effortPick.modelId)}
          onPick={id => {
            setEffortPick(null);
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
