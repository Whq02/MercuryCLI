import { Box } from '../../themedRenderer.js';
import type { SettingsRow } from './menuModel.js';
import { InteractiveRow } from '../../widgets/InteractiveRow.js';
import { renderSceneLine } from '../../widgets/SceneCanvas.js';
import type { useInteractiveList } from '../../widgets/useInteractiveList.js';
import type { useMercuryTokens } from '../../widgets/useMercuryTokens.js';

export function settingsRowLine({ composition, list, menuRows, t }: { composition: { placed: string[]; entryAt: Map<number, number> }; list: ReturnType<typeof useInteractiveList<SettingsRow>>; menuRows: readonly SettingsRow[]; t: ReturnType<typeof useMercuryTokens> }, i: number) {
  const line = composition.placed[i] ?? '';
  const entryIdx = composition.entryAt.get(i);
  if (entryIdx !== undefined && menuRows[entryIdx] !== undefined) {
    const row = menuRows[entryIdx]!;
    const props = list.rowProps(row, entryIdx);
    return (
      <InteractiveRow
        key={props.id}
        id={props.id}
        selected={props.selected}
        onSelect={props.onSelect}
        onActivate={props.onActivate}
        selectionBand={false}
        hoverStyle="chrome-ink"
        height={1}
      >
        {hover => renderSceneLine(line, hover && !props.selected ? { label: row.label, color: t.info } : undefined)}
      </InteractiveRow>
    );
  }
  return (
    <Box key={`menuline-${i}`} height={1} flexShrink={0}>
      {line.length > 0 ? renderSceneLine(line) : null}
    </Box>
  );
}
