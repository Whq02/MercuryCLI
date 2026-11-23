import React, { useMemo, useState } from 'react';
import { Box, useInput } from '../themedRenderer.js';
import { createSplashCore, WORD_W } from '../../../assets/splash/splash-core.mjs';
import { useEngineModel } from '../model-picker/useEngineModel.js';
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js';
import { useSetAppStateMaybe } from '../app-state/AppState.js';
import type { AgentDefinition, AgentDefinitionsResult } from '../../crew/agents/agentDefinition.js';
import { AgentStoreError, listAgentTrash, restoreAgentFromTrash, type AgentTrashEntry } from '../../crew/agents/store.js';
import { isFileBacked, type StudioRow } from '../agents/studio/studioData.js';
import type { FieldId } from '../agents/studio/studioEditorModel.js';
import { getAllBaseTools } from '../../tools/kit/toolList.js';
import type { Tools } from '../../tools/kit/tool.js';
import { getAgentModelPickerRows } from '../../models/catalogue/agentModelPicker.js';
import { renderSceneLine } from '../widgets/SceneCanvas.js';
import { useGreetingShimmer } from '../widgets/useGreetingShimmer.js';
import { useInteractiveList } from '../widgets/useInteractiveList.js';
import { useMercuryTokens } from '../widgets/useMercuryTokens.js';
import { useSplashCoreAccent } from '../widgets/useSplashCoreAccent.js';
import { agentFormRowIds } from './agents/face.js';
import { toggleRowOf, runDeleteOf, agentEditRun, modelPickRun, editFormRowOf, clearFormRowOf, formPickRun } from './agents/actions.js';
import { formPromptKeys, confirmKeys, formSnapKeys } from './agents/keys.js';
import { agentsFaceBase, bootSessionEffort, formFace, modelPickFace, trashFace, listFace } from './agents/menuModel.js';
import { agentFaceRow } from './agents/rows.js';
import { useAgentDefinitions } from './agents/useAgentDefinitions.js';
import { useAgentFormState } from './agents/useAgentFormState.js';
import type { AgentsFaceContext } from './agents/context.js';
export { agentFaceEntryOf, agentFaceDetailLines, agentFaceSummaryRows, agentFaceStatusLine, AGENT_FACE_LEGEND, AGENT_FACE_LEGEND_FORM, agentFormRowIds, agentFormEntryOf, agentFormDetailLines } from './agents/face.js';

interface BootAgentsScreenProps {
  onClose?: () => void;
  suspended?: boolean;
  onOpenLogins?: () => void;
  fullScene?: { columns: number; rows: number };
  definitions?: AgentDefinitionsResult;
  workspaceDir?: string;
  toolsOf?: () => Tools;
}

export function BootAgentsScreen({
  onClose,
  suspended = false,
  onOpenLogins,
  fullScene,
  definitions: given,
  workspaceDir: givenWorkspace,
  toolsOf,
}: BootAgentsScreenProps = {}): React.ReactNode {
  const t = useMercuryTokens();
  const { columns: termCols, rows: termRows } = useTerminalSize();
  const columns = fullScene?.columns ?? termCols;
  const rows = fullScene?.rows ?? termRows;
  const [workspaceDir] = useState(() => givenWorkspace ?? process.cwd());
  const faceTools = useMemo(() => (toolsOf ?? getAllBaseTools)(), [toolsOf]);
  const mainModel = useEngineModel();
  const setAppStateMaybe = useSetAppStateMaybe();

  const { defs, note, setNote, refreshEverywhere, built, listRows, counts } = useAgentDefinitions({ given, workspaceDir, setAppStateMaybe });

  const { confirm, setConfirm, trash, setTrash, modelPick, setModelPick, form, formSnap, formPrompt, setFormPrompt, formPick, setFormPick, formRef, formPromptRef, closeForm, openForm } = useAgentFormState({ defs, workspaceDir, mainModel, setNote, refreshEverywhere });

  const toggleRow = (row: StudioRow | null): { pending: string; result: Promise<string | null> } | null => toggleRowOf(ctx, row);

  const runDelete = (agent: AgentDefinition): void => runDeleteOf(ctx, agent);
  const ctx: AgentsFaceContext = { refreshEverywhere, workspaceDir, setConfirm, setNote, openForm, setModelPick, modelPick, onOpenLogins, faceTools, formRef, mainModel, setFormPick, setFormPrompt, formPick, formPromptRef, confirm, runDelete, formSnap };

  const list = useInteractiveList<StudioRow>({
    rows: listRows,
    rowId: r => `agent-face:${r.id}`,
    idNamespace: 'boot-agents',
    active: !suspended && form === null && confirm === null && !trash.open && modelPick === null,
    onClose: () => onClose?.(),
    actions: [
      {
        key: 'return',
        hint: 'edit',
        run: r => agentEditRun(ctx, r),
      },
      {
        key: 'n',
        hint: 'new',
        run: () => {
          openForm('create');
          return null;
        },
      },
      { key: 'x', hint: 'on/off', run: r => toggleRow(r) },
      {
        key: 'backspace',
        hint: 'delete',
        run: r => {
          if (!r?.agent || !isFileBacked(r.agent)) return null;
          setConfirm(r.agent);
          return null;
        },
      },
      {
        key: 'u',
        hint: 'trash',
        run: () => {
          setTrash({ open: true, entries: listAgentTrash() });
          return null;
        },
      },
      {
        key: 'r',
        hint: 'reload',
        run: () => {
          refreshEverywhere();
          return 'definitions re-read from disk';
        },
      },
    ],
  });

  const trashList = useInteractiveList<AgentTrashEntry>({
    rows: trash.entries,
    rowId: e => `agent-trash:${e.id}`,
    idNamespace: 'boot-agents-trash',
    active: !suspended && trash.open,
    onClose: () => setTrash({ open: false, entries: [] }),
    actions: [
      {
        key: 'return',
        hint: 'restore',
        run: e =>
          e === null
            ? null
            : {
                pending: 'restoring…',
                result: restoreAgentFromTrash(e.id)
                  .then(r => {
                    refreshEverywhere();
                    setTrash({ open: true, entries: listAgentTrash() });
                    return `restored ${e.agentType} → ${r.path}`;
                  })
                  .catch(err => (err instanceof AgentStoreError ? err.message : String(err))),
              },
      },
    ],
  });

  const modelPickList = useInteractiveList<string>({
    rows: modelPick?.rows.map(r => r.value) ?? [],
    rowId: v => `agent-builtin-pick:${v}`,
    idNamespace: 'boot-agents-builtin-pick',
    active: !suspended && modelPick !== null,
    onClose: () => setModelPick(null),
    actions: [
      {
        key: 'return',
        hint: 'pick',
        run: value => modelPickRun(ctx, value),
      },
    ],
  });

  const formRowIds = useMemo(() => (form === null ? [] : agentFormRowIds(form.mode)), [form]);
  const editFormRow = (id: 'destination' | FieldId): void => editFormRowOf(ctx, id);

  const clearFormRow = (id: 'destination' | FieldId): void => clearFormRowOf(ctx, id);

  const formList = useInteractiveList<'destination' | FieldId>({
    rows: formRowIds,
    rowId: r => `agent-form:${r}`,
    idNamespace: 'boot-agents-form',
    active:
      !suspended &&
      form !== null &&
      formPrompt === null &&
      formPick === null &&
      formSnap?.conflict == null &&
      formSnap?.recoverOffer == null &&
      formSnap?.busy !== true,
    onClose: () => closeForm(),
    actions: [
      {
        key: 'return',
        hint: 'edit field',
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
        key: 'g',
        hint: 'generate',
        run: () => {
          formRef.current?.machine.setTextBuffer('');
          setFormPrompt('describe');
          return null;
        },
      },
      {
        key: 's',
        hint: 'save',
        run: () => {
          void formRef.current?.machine.save();
          return null;
        },
      },
    ],
  });

  const pickList = useInteractiveList<string>({
    rows: formPick?.options ?? [],
    rowId: r => `agent-pick:${r}`,
    idNamespace: 'boot-agents-pick',
    active: !suspended && formPick !== null,
    onClose: () => setFormPick(null),
    actions: [
      {
        key: 'return',
        hint: 'pick',
        run: value => formPickRun(ctx, value),
      },
    ],
  });

  useInput(
    (input, key, event) => formPromptKeys(ctx, input, key, event),
    { isActive: !suspended && form !== null && formPrompt !== null },
  );

  useInput(
    (input, key, event) => confirmKeys(ctx, input, key, event),
    { isActive: !suspended && confirm !== null },
  );

  useInput(
    (input, key, event) => formSnapKeys(ctx, input, key, event),
    {
      isActive:
        !suspended &&
        form !== null &&
        (formSnap?.busy === true || formSnap?.recoverOffer != null || formSnap?.conflict != null),
    },
  );

  const [prevSuspended, setPrevSuspended] = useState(suspended);
  if (prevSuspended !== suspended) {
    setPrevSuspended(suspended);
    if (prevSuspended && !suspended) {
      if (formPick !== null && formPick.field === 'model') {
        const modelRows = getAgentModelPickerRows();
        setFormPick({ field: formPick.field, options: modelRows.map(r => r.value), modelRows });
      }
      if (modelPick !== null) {
        setModelPick({ ...modelPick, rows: getAgentModelPickerRows() });
      }
    }
  }

  const { accent: coreAccent, rampStops } = useSplashCoreAccent();
  const core = useMemo(
    () => createSplashCore({ nocolor: false, truecolor: true, accent: coreAccent }),
    [coreAccent],
  );
  const wordGlow = useGreetingShimmer(rampStops, WORD_W);

  const sessionEffort = bootSessionEffort();
  const menuM = useMemo(() => {
    const base = agentsFaceBase({ counts, mainModel, wordGlow, workspaceDir });
    if (form !== null && formSnap !== null) {
      return formFace({ base, defs, faceTools, form, formList, formPick, formPrompt, formRowIds, formSnap, mainModel, note, pickList, sessionEffort, workspaceDir });
    }
    if (modelPick !== null) {
      return modelPickFace({ base, modelPick, modelPickList });
    }
    if (trash.open) {
      return trashFace({ base, trash, trashList });
    }
    return listFace({ base, built, confirm, counts, defs, faceTools, list, listRows, mainModel, note, sessionEffort });
  }, [counts, listRows, built, defs, list.selectedRow, list.selectedIndex, list.note, note, confirm, trash, trashList.selectedIndex, trashList.note, form, formSnap, formPrompt, formPick, formRowIds, formList.selectedIndex, pickList.selectedIndex, modelPick, modelPickList.selectedIndex, modelPickList.note, mainModel, sessionEffort, faceTools, workspaceDir, wordGlow?.peakCell, wordGlow?.gainLevel]);

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

  if (suspended) return null;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {Array.from({ length: rows }, (_, i) => {
        const line = composition.placed[i] ?? '';
        const entryIdx = composition.entryAt.get(i);
        if (entryIdx !== undefined) {
          const faceRow = agentFaceRow({ entryIdx, form, formList, formPick, formRowIds, formSnap, line, list, listRows, modelPick, modelPickList, pickList, t, trash, trashList });
          if (faceRow !== undefined) return faceRow;
        }
        return (
          <Box key={`agentline-${i}`} height={1} flexShrink={0}>
            {line.length > 0 ? renderSceneLine(line) : null}
          </Box>
        );
      })}
    </Box>
  );
}
