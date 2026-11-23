import { Box } from '../themedRenderer.js';
import type { sectionRows, KitRow } from '../kit-menu-model/kitTypes.js';
import { InteractiveRow } from '../widgets/InteractiveRow.js';
import { renderSceneLine } from '../widgets/SceneCanvas.js';
import type { useInteractiveList } from '../widgets/useInteractiveList.js';
import type { useMercuryTokens } from '../widgets/useMercuryTokens.js';
import type { PresetRowFact, kitEntryOf as kitEntryOfDoor } from '../boot-face/KitMenuScreen.js';

export function kitMenuView({ t, columns, rows, listRows, presetsLayer, list, presetsList, composition, kitEntryOf }: { t: ReturnType<typeof useMercuryTokens>; columns: number; rows: number; listRows: ReturnType<typeof sectionRows>; presetsLayer: { open: boolean; facts: PresetRowFact[] }; list: ReturnType<typeof useInteractiveList<KitRow>>; presetsList: ReturnType<typeof useInteractiveList<PresetRowFact>>; composition: { placed: string[]; entryAt: Map<number, number> }; kitEntryOf: typeof kitEntryOfDoor }) {
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
