import type { useEngineModel } from '../../model-picker/useEngineModel.js';
import type { AgentDefinition } from '../../../crew/agents/agentDefinition.js';
import type { AgentTrashEntry } from '../../../crew/agents/store.js';
import type { StudioRow } from '../../agents/studio/studioData.js';
import type { FieldId } from '../../agents/studio/studioEditorModel.js';
import type { Tools } from '../../../tools/kit/tool.js';
import type { agentsFaceBase } from './menuModel.js';
import type { useAgentDefinitions } from './useAgentDefinitions.js';
import type { useAgentFormState } from './useAgentFormState.js';
import type { useInteractiveList } from '../../widgets/useInteractiveList.js';

export type AgentDefinitions = ReturnType<typeof useAgentDefinitions>;
export type AgentFormState = ReturnType<typeof useAgentFormState>;
export type AgentLists = {
  list: ReturnType<typeof useInteractiveList<StudioRow>>;
  trashList: ReturnType<typeof useInteractiveList<AgentTrashEntry>>;
  modelPickList: ReturnType<typeof useInteractiveList<string>>;
  formList: ReturnType<typeof useInteractiveList<'destination' | FieldId>>;
  pickList: ReturnType<typeof useInteractiveList<string>>;
};
export type AgentsFaceBase = ReturnType<typeof agentsFaceBase>;
export type AgentsFaceContext = Pick<AgentDefinitions, 'refreshEverywhere' | 'setNote'> & Pick<AgentFormState, 'setConfirm' | 'openForm' | 'setModelPick' | 'modelPick' | 'formRef' | 'setFormPick' | 'setFormPrompt' | 'formPick' | 'formPromptRef' | 'confirm' | 'formSnap'> & { workspaceDir: string; onOpenLogins: (() => void) | undefined; faceTools: Tools; mainModel: ReturnType<typeof useEngineModel>; runDelete: (agent: AgentDefinition) => void };
