import type { FieldId } from '../../agents/studio/studioEditorModel.js';
import { InteractiveRow } from '../../widgets/InteractiveRow.js';
import { renderSceneLine } from '../../widgets/SceneCanvas.js';
import type { useMercuryTokens } from '../../widgets/useMercuryTokens.js';
import { agentFormEntryOf, agentFaceEntryOf } from './face.js';
import type { AgentDefinitions, AgentFormState, AgentLists } from './context.js';

export function agentFaceRow({ entryIdx, form, formList, formPick, formRowIds, formSnap, line, list, listRows, modelPick, modelPickList, pickList, t, trash, trashList }: { entryIdx: number; form: AgentFormState['form']; formList: AgentLists['formList']; formPick: AgentFormState['formPick']; formRowIds: Array<'destination' | FieldId>; formSnap: AgentFormState['formSnap']; line: string; list: AgentLists['list']; listRows: AgentDefinitions['listRows']; modelPick: AgentFormState['modelPick']; modelPickList: AgentLists['modelPickList']; pickList: AgentLists['pickList']; t: ReturnType<typeof useMercuryTokens>; trash: AgentFormState['trash']; trashList: AgentLists['trashList'] }) {
  if (formPick !== null) {
    const option = formPick.options[entryIdx];
    if (option !== undefined) {
      const props = pickList.rowProps(option, entryIdx);
      return (
        <InteractiveRow key={props.id} id={props.id} selected={props.selected} unavailable={props.unavailable} onSelect={props.onSelect} onActivate={props.onActivate} selectionBand={false} hoverStyle="chrome-ink" height={1}>
          {hover => renderSceneLine(line, hover && !props.selected ? { label: option, color: t.info } : undefined)}
        </InteractiveRow>
      );
    }
  } else if (form !== null) {
    const rowId = formRowIds[entryIdx];
    if (rowId !== undefined) {
      const props = formList.rowProps(rowId, entryIdx);
      return (
        <InteractiveRow key={props.id} id={props.id} selected={props.selected} unavailable={props.unavailable} onSelect={props.onSelect} onActivate={props.onActivate} selectionBand={false} hoverStyle="chrome-ink" height={1}>
          {hover => renderSceneLine(line, hover && !props.selected ? { label: agentFormEntryOf(rowId, formSnap!).label, color: t.info } : undefined)}
        </InteractiveRow>
      );
    }
  } else if (modelPick !== null) {
    const row = modelPick.rows[entryIdx];
    if (row !== undefined) {
      const props = modelPickList.rowProps(row.value, entryIdx);
      return (
        <InteractiveRow key={props.id} id={props.id} selected={props.selected} unavailable={props.unavailable} onSelect={props.onSelect} onActivate={props.onActivate} selectionBand={false} hoverStyle="chrome-ink" height={1}>
          {hover => renderSceneLine(line, hover && !props.selected ? { label: row.label, color: t.info } : undefined)}
        </InteractiveRow>
      );
    }
  } else if (trash.open) {
    const entry = trash.entries[entryIdx];
    if (entry !== undefined) {
      const props = trashList.rowProps(entry, entryIdx);
      return (
        <InteractiveRow key={props.id} id={props.id} selected={props.selected} unavailable={props.unavailable} onSelect={props.onSelect} onActivate={props.onActivate} selectionBand={false} hoverStyle="chrome-ink" height={1}>
          {hover => renderSceneLine(line, hover && !props.selected ? { label: entry.agentType, color: t.info } : undefined)}
        </InteractiveRow>
      );
    }
  } else {
    const row = listRows[entryIdx];
    if (row !== undefined) {
      const props = list.rowProps(row, entryIdx);
      return (
        <InteractiveRow key={props.id} id={props.id} selected={props.selected} unavailable={props.unavailable} onSelect={props.onSelect} onActivate={props.onActivate} selectionBand={false} hoverStyle="chrome-ink" height={1}>
          {hover => renderSceneLine(line, hover && !props.selected ? { label: agentFaceEntryOf(row).label, color: t.info } : undefined)}
        </InteractiveRow>
      );
    }
  }
}
