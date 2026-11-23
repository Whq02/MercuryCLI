import { Box } from '../../themedRenderer.js';
import { InteractiveRow } from '../../widgets/InteractiveRow.js';
import { renderSceneLine } from '../../widgets/SceneCanvas.js';
import type { useInteractiveList } from '../../widgets/useInteractiveList.js';
import type { useMercuryTokens } from '../../widgets/useMercuryTokens.js';
import type { BootProjectFact } from '../bootCardFacts.js';
import type { SessionPickerFlatRow } from '../../widgets/faces/sessionPickerModel.js';

export type SelectableRow =
  | { kind: 'session'; flat: SessionPickerFlatRow }
  | { kind: 'project'; project: BootProjectFact & { running?: number } };

export function resumeView({ t, columns, rows, selectable, list, composition, listIndexOf }: { t: ReturnType<typeof useMercuryTokens>; columns: number; rows: number; selectable: SelectableRow[]; list: ReturnType<typeof useInteractiveList<SelectableRow>>; composition: { placed: string[]; entryAt: Map<number, number> }; listIndexOf: (entryIdx: number) => number }) {
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
            row.kind === 'session' ? row.flat.row.label : row.project.base;
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
