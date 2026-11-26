import type { RefObject } from 'react';
import { Box } from '../../themedRenderer.js';
import { saturnNextFireMs } from '../../../daemon/saturn/saturn.js';
import { compileWhenSpelling } from '../../../daemon/saturn/whenSpelling.js';
import type { SessionReceiptEntry } from '../../../daemon/switchboard/sessionReceipts.js';
import { projectDisplayName } from '../bootCardFacts.js';
import type { useEngineModel } from '../../model-picker/useEngineModel.js';
import { InteractiveRow } from '../../widgets/InteractiveRow.js';
import { renderSceneLine } from '../../widgets/SceneCanvas.js';
import { bootEnvironment } from '../bootEnvironment.js';
import type { useGreetingShimmer } from '../../widgets/useGreetingShimmer.js';
import type { useInteractiveList } from '../../widgets/useInteractiveList.js';
import type { useMercuryTokens } from '../../widgets/useMercuryTokens.js';
import type { SaturnFormPreflightV1, SaturnFormStateV1, SaturnScreenFactsV1, SaturnScreenRowV1, saturnDetailLines as saturnDetailLinesDoor, saturnEmptyDetailLines as saturnEmptyDetailLinesDoor, saturnEntryOf as saturnEntryOfDoor, saturnFormDetailLines as saturnFormDetailLinesDoor, saturnFormEntries as saturnFormEntriesDoor, saturnFormLegendOf as saturnFormLegendOfDoor, saturnLegendOf as saturnLegendOfDoor, saturnOpeningRowIsCurrent as saturnOpeningRowIsCurrentDoor, saturnStatusLine as saturnStatusLineDoor, saturnSummaryRows as saturnSummaryRowsDoor } from '../BootSaturnScreen.js';
import type { SaturnFormRowId } from './actions.js';

export function saturnMenuOf({ mainModel, saturnSummaryRows, facts, nowMs, wordGlow, form, givenNow, preflightOf, livePreflightOf, formPick, SATURN_WORKSPACE_CUSTOM_ROW, clampText, SATURN_OPENING_AUDIT_ROW, SATURN_AUDIT_MISSION, SATURN_OPENING_REVIEW_ROW, SATURN_REVIEW_MISSION, saturnOpeningRowIsCurrent, pickList, saturnFormLegendOf, saturnFormDetailLines, formPrompt, saturnFormEntries, formList, formNote, saturnEntryOf, list, note, saturnStatusLine, selected, saturnLegendOf, busy, saturnDetailLines, receiptsOf, liveReceiptsOf, saturnEmptyDetailLines }: { mainModel: ReturnType<typeof useEngineModel>; saturnSummaryRows: typeof saturnSummaryRowsDoor; facts: SaturnScreenFactsV1; nowMs: number; wordGlow: ReturnType<typeof useGreetingShimmer>; form: SaturnFormStateV1 | null; givenNow: number | undefined; preflightOf: ((modelKey: string, nextFireMs: number | null) => SaturnFormPreflightV1) | undefined; livePreflightOf: (modelKey: string, nextFireMs: number | null) => SaturnFormPreflightV1; formPick: { field: 'model' | 'kit' | 'workspace' | 'opening'; options: string[] } | null; SATURN_WORKSPACE_CUSTOM_ROW: string; clampText: (s: string, w: number) => string; SATURN_OPENING_AUDIT_ROW: string; SATURN_AUDIT_MISSION: string; SATURN_OPENING_REVIEW_ROW: string; SATURN_REVIEW_MISSION: string; saturnOpeningRowIsCurrent: typeof saturnOpeningRowIsCurrentDoor; pickList: ReturnType<typeof useInteractiveList<string>>; saturnFormLegendOf: typeof saturnFormLegendOfDoor; saturnFormDetailLines: typeof saturnFormDetailLinesDoor; formPrompt: { field: SaturnFormRowId; draft: string } | null; saturnFormEntries: typeof saturnFormEntriesDoor; formList: ReturnType<typeof useInteractiveList<SaturnFormRowId>>; formNote: string | null; saturnEntryOf: typeof saturnEntryOfDoor; list: ReturnType<typeof useInteractiveList<SaturnScreenRowV1>>; note: string | null; saturnStatusLine: typeof saturnStatusLineDoor; selected: ReturnType<typeof useInteractiveList<SaturnScreenRowV1>>['selectedRow']; saturnLegendOf: typeof saturnLegendOfDoor; busy: RefObject<boolean>; saturnDetailLines: typeof saturnDetailLinesDoor; receiptsOf: ((row: SaturnScreenRowV1) => SessionReceiptEntry[]) | undefined; liveReceiptsOf: (row: SaturnScreenRowV1) => SessionReceiptEntry[]; saturnEmptyDetailLines: typeof saturnEmptyDetailLinesDoor }) {
  const environment = bootEnvironment(mainModel, process.cwd());
  const base = {
    title: 'saturn scheduler',
    summaryRows: saturnSummaryRows(facts, nowMs),
    environment,
    glowWord: wordGlow,
    moreHint: '… (the trail continues — taller terminal)',
  };
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
    noticeLine: selected === null ? saturnEmptyDetailLines(facts).filter(Boolean).join(' ') : null,
    detailOverride:
      selected !== null
        ? saturnDetailLines(selected, nowMs, (receiptsOf ?? liveReceiptsOf)(selected))
        : saturnEmptyDetailLines(facts),
  };
}

export function saturnRowsView({ columns, rows, composition, rowPropsAt, t }: { columns: number; rows: number; composition: { placed: string[]; entryAt: Map<number, number> }; rowPropsAt: (entryIdx: number) => { props: ReturnType<ReturnType<typeof useInteractiveList<SaturnScreenRowV1>>['rowProps']>; hoverLabel: string } | null; t: ReturnType<typeof useMercuryTokens> }) {
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
