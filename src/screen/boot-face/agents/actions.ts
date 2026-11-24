import type { AgentDefinition } from '../../../crew/agents/agentDefinition.js';
import type { AgentSpecFields } from '../../../crew/agents/contracts.js';
import { setAgentDisabled, setAgentOverride } from '../../../crew/agents/overrides.js';
import { AgentStoreError, deleteAgentToTrash } from '../../../crew/agents/store.js';
import { isFileBacked, type StudioRow } from '../../agents/studio/studioData.js';
import type { FieldId } from '../../agents/studio/studioEditorModel.js';
import { AGENT_COLORS } from '../../../tools/crewmate/agentColors.js';
import { EFFORT_LEVELS, resolveEffortTruth, type EffortValue } from '../../../models/effort/effort.js';
import { agentModelPickOutcome, getAgentModelPickerRows } from '../../../models/catalogue/agentModelPicker.js';
import { bootBirthFacts } from '../../../daemon/switchboard/bootBirthFacts.js';
import { offeredDefinitionModes } from '../../../tools/crewmate/crewmatePermissionPosture.js';
import { agentFormFieldKind } from './face.js';
import type { AgentsFaceContext } from './context.js';

export function toggleRowOf(ctx: AgentsFaceContext, row: StudioRow | null): { pending: string; result: Promise<string | null> } | null {
  const { refreshEverywhere, workspaceDir } = ctx;
  if (!row?.agent || row.agent.source === 'built-in') return null;
  const target = row.agent;
  return {
    pending: 'saving…',
    result: setAgentDisabled('user', workspaceDir, target.agentType, target.disabled !== true)
      .then(() => {
        refreshEverywhere();
        return `${target.disabled ? 'enabled' : 'disabled'} ${target.agentType}`;
      })
      .catch(e => String(e)),
  };
}

export function runDeleteOf(ctx: AgentsFaceContext, agent: AgentDefinition): void {
  const { refreshEverywhere, setConfirm, setNote } = ctx;
  if (!isFileBacked(agent)) return;
  void deleteAgentToTrash(
    { filePath: agent.filePath, revision: agent.revision },
    {
      agentType: agent.agentType,
      source: agent.source as Exclude<typeof agent.source, 'built-in' | 'extension'>,
    },
  )
    .then(entry => {
      setNote(`deleted ${agent.agentType} — restorable in the recovery area as ${entry.id}`);
      refreshEverywhere();
    })
    .catch(e => setNote(e instanceof AgentStoreError ? e.message : String(e)))
    .finally(() => setConfirm(null));
}

export function agentEditRun(ctx: AgentsFaceContext, r: StudioRow | null) {
  const { openForm, setModelPick } = ctx;
  if (!r?.agent) return null;
  if (r.agent.source === 'built-in') {
    const agent = r.agent;
    setModelPick({
      agentType: agent.agentType,
      current: agent.model ?? 'inherit',
      ...(agent.operatorOverride?.from === 'user' && agent.operatorOverride.effort !== undefined
        ? { effortKept: agent.operatorOverride.effort }
        : {}),
      rows: getAgentModelPickerRows(),
    });
    return null;
  }
  if (!isFileBacked(r.agent)) return 'only file-backed agents edit here — clone it in /agents first';
  openForm('edit', { identity: { filePath: r.agent.filePath, revision: r.agent.revision }, agent: r.agent });
  return null;
}

export function modelPickRun(ctx: AgentsFaceContext, value: string | null) {
  const { modelPick, onOpenLogins, refreshEverywhere, setModelPick, workspaceDir } = ctx;
  const pick = modelPick;
  if (value === null || pick === null) return null;
  const row = pick.rows.find(r => r.value === value);
  if (row === undefined) return null;
  const outcome = agentModelPickOutcome(row);
  if (outcome.kind === 'needs-sign-in') {
    if (onOpenLogins) {
      onOpenLogins();
      return null;
    }
    return `${outcome.hint} — /logins opens the sign-in catalogue`;
  }
  const cleared = outcome.model === undefined;
  setModelPick(null);
  return {
    pending: 'saving…',
    result: setAgentOverride(
      'user',
      workspaceDir,
      pick.agentType,
      cleared
        ? pick.effortKept !== undefined
          ? { effort: pick.effortKept }
          : undefined
        : { model: outcome.model!, ...(pick.effortKept !== undefined ? { effort: pick.effortKept } : {}) },
    )
      .then(() => {
        refreshEverywhere();
        return cleared
          ? `${pick.agentType} follows your session's model again — override cleared`
          : `${pick.agentType} runs ${outcome.model} — a config row, the built-in definition untouched`;
      })
      .catch(e => String(e)),
  };
}

export function editFormRowOf(ctx: AgentsFaceContext, id: 'destination' | FieldId): void {
  const { faceTools, formRef, mainModel, setFormPick, setFormPrompt } = ctx;
  const f = formRef.current;
  const snap = f?.machine.snapshot();
  if (!f || !snap) return;
  switch (agentFormFieldKind(id)) {
    case 'cycle': {
      if (id === 'destination') f.machine.setScope(snap.scope === 'project' ? 'user' : 'project');
      else if (id === 'background') f.machine.commit({ set: { background: snap.doc.fields.background ? undefined : true } });
      else f.machine.commit({ set: { isolation: snap.doc.fields.isolation ? undefined : 'worktree' } });
      return;
    }
    case 'text':
      f.machine.openFieldEditor(id as FieldId);
      setFormPrompt(id);
      return;
    case 'body':
      f.machine.setTextBuffer(snap.doc.body.trim());
      setFormPrompt('body');
      return;
    case 'tools': {
      const names = faceTools.map(tool => tool.name);
      setFormPick({ field: id as FieldId, options: names, toggles: true });
      return;
    }
    case 'pick': {
      const field = id as FieldId;
      if (field === 'model') {
        const modelRows = getAgentModelPickerRows();
        setFormPick({ field, options: modelRows.map(r => r.value), modelRows });
        return;
      }
      const options =
        field === 'effort'
            ? (() => {
                const previewModel =
                  snap.doc.fields.model && snap.doc.fields.model !== 'inherit'
                    ? snap.doc.fields.model
                    : mainModel;
                const stops = resolveEffortTruth(previewModel, undefined).selectable;
                return (stops.length > 0 ? stops : EFFORT_LEVELS).map(String);
              })()
            : field === 'permissionMode'
              ? offeredDefinitionModes(bootBirthFacts().bypassConsent)
              : field === 'memory'
                ? ['user', 'project', 'local']
                : field === 'instructionProfile'
                  ? ['auto', 'native']
                  : [...AGENT_COLORS];
      setFormPick({ field, options: [...options, '(clear — use the default)'] });
      return;
    }
  }
}

export function clearFormRowOf(ctx: AgentsFaceContext, id: 'destination' | FieldId): void {
  const { formRef } = ctx;
  const f = formRef.current;
  if (!f) return;
  switch (id) {
    case 'destination':
      f.machine.setScope('project');
      return;
    case 'name':
    case 'description':
    case 'body':
      return;
    case 'background':
      f.machine.commit({ set: { background: undefined } });
      return;
    case 'isolation':
      f.machine.commit({ set: { isolation: undefined } });
      return;
    default: {
      const set: Partial<AgentSpecFields> = {};
      set[id] = undefined;
      f.machine.commit({ set });
      return;
    }
  }
}

export function formPickRun(ctx: AgentsFaceContext, value: string | null) {
  const { formPick, formRef, onOpenLogins, setFormPick } = ctx;
  const f = formRef.current;
  const pick = formPick;
  if (value === null || !f || !pick) return null;
  const snap = f.machine.snapshot();
  if (pick.toggles) {
    const field = pick.field as 'tools' | 'disallowedTools';
    const current = snap.doc.fields[field];
    const next =
      current === undefined
        ? [value]
        : current.includes(value)
          ? current.filter(n => n !== value)
          : [...current, value];
    const set: Partial<AgentSpecFields> = {};
    set[field] = next.length === 0 ? undefined : next;
    f.machine.commit({ set });
    return null;
  }
  const cleared = value === '(clear — use the default)';
  if (pick.field === 'model') {
    const row = pick.modelRows?.find(r => r.value === value);
    if (row !== undefined) {
      const outcome = agentModelPickOutcome(row);
      if (outcome.kind === 'needs-sign-in') {
        if (onOpenLogins) {
          onOpenLogins();
          return null;
        }
        return `${outcome.hint} — /logins opens the sign-in catalogue`;
      }
      f.machine.commit({ set: { model: outcome.model } });
      setFormPick(null);
      return null;
    }
    f.machine.commit({ set: { model: cleared || value === 'inherit' ? undefined : value } });
  } else if (pick.field === 'effort') {
    f.machine.commit({ set: { effort: cleared ? undefined : (value as EffortValue) } });
  } else if (pick.field === 'maxTurns') {
  } else {
    f.machine.commit({ set: { [pick.field]: cleared ? undefined : value } as Partial<AgentSpecFields> });
  }
  setFormPick(null);
  return null;
}
