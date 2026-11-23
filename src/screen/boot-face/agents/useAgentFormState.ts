import { useCallback, useRef, useState } from 'react';
import { useClaim } from '../../effects/effects.js';
import type { useEngineModel } from '../../model-picker/useEngineModel.js';
import type { AgentDefinition } from '../../../crew/agents/agentDefinition.js';
import type { AgentTrashEntry } from '../../../crew/agents/store.js';
import { createStudioEditorMachine, type FieldId, type StudioDraftBase, type StudioEditorMachine, type StudioEditorSnapshot } from '../../agents/studio/studioEditorModel.js';
import type { EffortValue } from '../../../models/effort/effort.js';
import type { AgentModelPickerRow } from '../../../models/catalogue/agentModelPicker.js';
import type { AgentDefinitions } from './context.js';

export function useAgentFormState({ defs, workspaceDir, mainModel, setNote, refreshEverywhere }: { defs: AgentDefinitions['defs']; workspaceDir: string; mainModel: ReturnType<typeof useEngineModel>; setNote: AgentDefinitions['setNote']; refreshEverywhere: AgentDefinitions['refreshEverywhere'] }) {
  const [confirm, setConfirm] = useState<AgentDefinition | null>(null);
  const [trash, setTrash] = useState<{ open: boolean; entries: AgentTrashEntry[] }>({ open: false, entries: [] });
  const [modelPick, setModelPick] = useState<{
    agentType: string;
    current: string;
    effortKept?: EffortValue;
    rows: AgentModelPickerRow[];
  } | null>(null);

  const [form, setForm] = useState<{ machine: StudioEditorMachine; mode: 'create' | 'edit' } | null>(null);
  const [formSnap, setFormSnap] = useState<StudioEditorSnapshot | null>(null);
  const [formPrompt, setFormPrompt] = useState<'destination' | 'describe' | FieldId | null>(null);
  const [formPick, setFormPick] = useState<{ field: FieldId; options: string[]; toggles?: boolean; modelRows?: AgentModelPickerRow[] } | null>(null);
  const formRef = useRef(form);
  formRef.current = form;
  const formPromptRef = useRef(formPrompt);
  formPromptRef.current = formPrompt;
  const defsRef = useRef(defs);
  defsRef.current = defs;

  const closeForm = useCallback((): void => {
    formRef.current?.machine.dispose();
    setForm(null);
    setFormSnap(null);
    setFormPrompt(null);
    setFormPick(null);
  }, []);

  const openForm = useCallback(
    (mode: 'create' | 'edit', base?: StudioDraftBase): void => {
      formRef.current?.machine.dispose();
      const machine = createStudioEditorMachine(
        {
          mode,
          ...(base !== undefined ? { base } : {}),
          cwd: workspaceDir,
          getExistingAgents: () => defsRef.current?.allAgents ?? [],
          getParentModel: () => mainModel,
          onSaved: message => {
            closeForm();
            setNote(message);
            refreshEverywhere();
          },
          onCancel: () => closeForm(),
        },
        s => setFormSnap(s),
      );
      machine.setView({ kind: 'advanced', cursor: 0, editing: null });
      setForm({ machine, mode });
      setFormSnap(machine.snapshot());
    },
    [workspaceDir, mainModel, closeForm, refreshEverywhere],
  );
  useClaim(() => () => formRef.current?.machine.dispose(), []);
  return { confirm, setConfirm, trash, setTrash, modelPick, setModelPick, form, formSnap, formPrompt, setFormPrompt, formPick, setFormPick, formRef, formPromptRef, closeForm, openForm };
}
