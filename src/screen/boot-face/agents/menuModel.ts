import type { useEngineModel } from '../../model-picker/useEngineModel.js';
import { resolveEffectiveAgentRuntime } from '../../../crew/agents/resolver.js';
import { bootBirthFacts } from '../../../daemon/switchboard/bootBirthFacts.js';
import { getInitialEffortSetting, parseEffortValue, type EffortValue } from '../../../models/effort/effort.js';
import { computeStudioValidation, effectiveStudioRuntime, studioDestinationPath, type FieldId, type StudioEditorSnapshot, type StudioValidation } from '../../agents/studio/studioEditorModel.js';
import type { Tools } from '../../../tools/kit/tool.js';
import { agentModelAvailabilityNote } from '../../../models/catalogue/agentModelPicker.js';
import { bootEnvironment } from '../bootEnvironment.js';
import type { useGreetingShimmer } from '../../widgets/useGreetingShimmer.js';
import { AGENT_FACE_LEGEND_FORM, agentFormEntryOf, agentFormDetailLines, AGENT_FACE_LEGEND_TRASH, AGENT_FACE_LEGEND_PROMPT, AGENT_FACE_LEGEND_PICK, agentFaceEntryOf, AGENT_FACE_LEGEND_CONFIRM, agentDeleteConfirmLines, agentFaceSummaryRows, type FaceEntry, AGENT_FACE_LEGEND, agentTrashEntryOf, agentFaceStatusLine, agentFaceDetailLines } from './face.js';
import type { AgentDefinitions, AgentFormState, AgentLists, AgentsFaceBase } from './context.js';

export function bootSessionEffort(): EffortValue | undefined {
  return parseEffortValue(bootBirthFacts().effort ?? undefined) ?? getInitialEffortSetting();
}

export function agentsFaceBase({ counts, mainModel, wordGlow, workspaceDir }: { counts: AgentDefinitions['counts']; mainModel: ReturnType<typeof useEngineModel>; wordGlow: ReturnType<typeof useGreetingShimmer>; workspaceDir: string }) {
  const environment = bootEnvironment(mainModel, workspaceDir);
  const base = {
    title: 'agents',
    summaryTitle: 'AGENTS',
    summaryRows: agentFaceSummaryRows(counts),
    environment,
    glowWord: wordGlow,
    moreHint: '… (the trail continues — taller terminal)',
  };
  return base;
}

export function formFace({ base, defs, faceTools, form, formList, formPick, formPrompt, formRowIds, formSnap, mainModel, note, pickList, sessionEffort, workspaceDir }: { base: AgentsFaceBase; defs: AgentDefinitions['defs']; faceTools: Tools; form: NonNullable<AgentFormState['form']>; formList: AgentLists['formList']; formPick: AgentFormState['formPick']; formPrompt: AgentFormState['formPrompt']; formRowIds: Array<'destination' | FieldId>; formSnap: NonNullable<AgentFormState['formSnap']>; mainModel: ReturnType<typeof useEngineModel>; note: AgentDefinitions['note']; pickList: AgentLists['pickList']; sessionEffort?: EffortValue; workspaceDir: string }) {
  const snap = formSnap;
  const validation = computeStudioValidation({
    doc: snap.doc,
    existingAgents: defs?.allAgents ?? [],
    base: undefined,
    mode: form.mode,
  });
  const destination = studioDestinationPath({
    base: undefined,
    scope: snap.scope,
    cwd: workspaceDir,
    name: snap.doc.fields.name,
  });
  const modelAvailability = agentModelAvailabilityNote(snap.doc.fields.model);
  const effRun = effectiveStudioRuntime({
    doc: snap.doc,
    base: undefined,
    scope: snap.scope,
    parentModel: mainModel,
    sessionEffort: sessionEffort ?? bootSessionEffort(),
    tools: faceTools,
  });
  const effortWord =
    effRun.effortIntent === undefined && effRun.effort.supportsEffort && effRun.effort.appliedValue === undefined && effRun.effort.label === 'default'
      ? 'session'
      : effRun.effort.label;
  const effectiveLine = `${effRun.modelIntent} → ${effRun.model} · effort ${effortWord}${modelAvailability !== null ? ` · ${modelAvailability}` : ''}`;
  if (formPick !== null) {
    return formPickFace({ base, destination, effectiveLine, form, formPick, pickList, snap, validation });
  }
  return formRowsFace({ base, destination, effectiveLine, form, formList, formPrompt, formRowIds, note, snap, validation });
}

function formPickFace({ base, destination, effectiveLine, form, formPick, pickList, snap, validation }: { base: AgentsFaceBase; destination: string; effectiveLine: string; form: NonNullable<AgentFormState['form']>; formPick: NonNullable<AgentFormState['formPick']>; pickList: AgentLists['pickList']; snap: StudioEditorSnapshot; validation: StudioValidation }) {
  const current = (snap.doc.fields as Record<string, unknown>)[formPick.field];
  if (formPick.modelRows !== undefined) {
    const currentModel = String(snap.doc.fields.model ?? 'inherit');
    return {
      ...base,
      entries: formPick.modelRows.map(r => ({
        label: r.kind === 'connect' ? `${r.label} …` : r.label,
        group: r.group,
        groupTitle: r.group,
        summary: r.unavailable ?? r.description,
        valueLabel: r.kind === 'connect' ? 'sign in' : r.unavailable !== undefined ? 'needs sign-in' : currentModel === r.value ? 'current' : '',
        valueIsDefault: r.unavailable === undefined && r.kind !== 'connect',
        pinnedVal: null,
        detail: null,
      })),
      selIdx: pickList.selectedIndex,
      statusRight: `${formPick.modelRows.length} rows — the full catalogue; ↵ on a sign-in row opens Logins`,
      legend: AGENT_FACE_LEGEND_PICK,
      detailOverride: agentFormDetailLines({ snap, validation, destination, effectiveLine, mode: form.mode }),
    };
  }
  return {
    ...base,
    entries: formPick.options.map(o => ({
      label: o,
      group: formPick.field,
      groupTitle: `pick ${formPick.field}`,
      summary: '',
      valueLabel: formPick.toggles
        ? Array.isArray(current) && current.includes(o)
          ? 'in'
          : ''
        : String(current ?? (formPick.field === 'model' ? 'inherit' : '')) === o
          ? 'current'
          : '',
      valueIsDefault: true,
      pinnedVal: null,
      detail: null,
    })),
    selIdx: pickList.selectedIndex,
    statusRight: `${formPick.options.length} option${formPick.options.length === 1 ? '' : 's'}${formPick.toggles ? ' · ↵ toggles membership' : ''}`,
    legend: AGENT_FACE_LEGEND_PICK,
    detailOverride: agentFormDetailLines({ snap, validation, destination, effectiveLine, mode: form.mode }),
  };
}

function formRowsFace({ base, destination, effectiveLine, form, formList, formPrompt, formRowIds, note, snap, validation }: { base: AgentsFaceBase; destination: string; effectiveLine: string; form: NonNullable<AgentFormState['form']>; formList: AgentLists['formList']; formPrompt: AgentFormState['formPrompt']; formRowIds: Array<'destination' | FieldId>; note: AgentDefinitions['note']; snap: StudioEditorSnapshot; validation: StudioValidation }) {
  const promptOpen = formPrompt !== null;
  const promptLine = promptOpen
    ? `${String(formPrompt)}: ${snap.textBuffer === '' ? '(type)' : snap.textBuffer}▌`
    : null;
  return {
    ...base,
    entries: formRowIds.map(id => agentFormEntryOf(id, snap)),
    selIdx: promptOpen ? -1 : formList.selectedIndex,
    statusRight: promptLine ?? snap.note?.text ?? note ?? 'the agent form — ↵ edits a row · s saves',
    legend: promptOpen ? AGENT_FACE_LEGEND_PROMPT : AGENT_FACE_LEGEND_FORM,
    detailOverride: agentFormDetailLines({ snap, validation, destination, effectiveLine, mode: form.mode }),
  };
}

export function modelPickFace({ base, modelPick, modelPickList }: { base: AgentsFaceBase; modelPick: NonNullable<AgentFormState['modelPick']>; modelPickList: AgentLists['modelPickList'] }) {
  return {
    ...base,
    entries: modelPick.rows.map(r => ({
      label: r.kind === 'connect' ? `${r.label} …` : r.label,
      group: r.group,
      groupTitle: r.group,
      summary: r.unavailable ?? r.description,
      valueLabel:
        r.kind === 'connect'
          ? 'sign in'
          : r.unavailable !== undefined
            ? 'needs sign-in'
            : modelPick.current === r.value
              ? 'current'
              : '',
      valueIsDefault: r.unavailable === undefined && r.kind !== 'connect',
      pinnedVal: null,
      detail: null,
    })),
    selIdx: modelPickList.selectedIndex,
    statusRight:
      modelPickList.note ??
      `${modelPick.agentType} — the model dial; ↵ on a sign-in row opens Logins`,
    legend: AGENT_FACE_LEGEND_PICK,
    detailOverride: [
      `${modelPick.agentType} — model override`,
      '',
      'built-in (no file): the definition is',
      'code — your pick lands in config as a',
      'per-agent settings row, never a file',
      'edit; dispatch wears it on the next',
      'spawn, running sessions included.',
      '',
      "'Inherit' clears the row — the agent",
      "follows your session's model again.",
    ],
  };
}

export function trashFace({ base, trash, trashList }: { base: AgentsFaceBase; trash: AgentFormState['trash']; trashList: AgentLists['trashList'] }) {
  const empty = trash.entries.length === 0;
  return {
    ...base,
    entries: empty
      ? [
          {
            label: 'the recovery area is empty — deleted agents land here, restorable',
            group: 'recovery area',
            groupTitle: 'recovery area',
            summary: '',
            valueLabel: '—',
            valueIsDefault: true,
            pinnedVal: null,
            detail: null,
            inert: true,
          } satisfies FaceEntry,
        ]
      : trash.entries.map(agentTrashEntryOf),
    selIdx: empty ? -1 : trashList.selectedIndex,
    statusRight: trashList.note ?? `${trash.entries.length} restorable`,
    legend: AGENT_FACE_LEGEND_TRASH,
  };
}

export function listFace({ base, built, confirm, counts, defs, faceTools, list, listRows, mainModel, note, sessionEffort }: { base: AgentsFaceBase; built: AgentDefinitions['built']; confirm: AgentFormState['confirm']; counts: AgentDefinitions['counts']; defs: AgentDefinitions['defs']; faceTools: Tools; list: AgentLists['list']; listRows: AgentDefinitions['listRows']; mainModel: ReturnType<typeof useEngineModel>; note: AgentDefinitions['note']; sessionEffort?: EffortValue }) {
  const entries = listRows.map(agentFaceEntryOf);
  const selected = list.selectedRow;
  const detailOverride = confirm
    ? agentDeleteConfirmLines(confirm)
    : selected !== null && built !== null
      ? agentFaceDetailLines(
          selected,
          built.estate,
          selected.agent
            ? resolveEffectiveAgentRuntime(selected.agent, {
                parentModel: mainModel,
                sessionEffort: sessionEffort ?? bootSessionEffort(),
                tools: faceTools,
              })
            : null,
          selected.agent ? agentModelAvailabilityNote(selected.agent.operatorOverride?.model ?? selected.agent.model) : null,
        )
      : [
          'no agents yet',
          '',
          "n creates one — it lands on disk and",
          'every session sees it, running ones',
          'included (the freshness law).',
        ];
  return {
    ...base,
    entries:
      entries.length > 0
        ? entries
        : [
            {
              label: 'no agents in this workspace yet — n creates one',
              group: 'agents',
              groupTitle: 'agents',
              summary: '',
              valueLabel: '—',
              valueIsDefault: true,
              pinnedVal: null,
              detail: null,
              inert: true,
            } satisfies FaceEntry,
          ],
    selIdx: entries.length > 0 ? list.selectedIndex : -1,
    statusRight:
      defs === null
        ? '◓ reading definitions …'
        : (list.note ?? note ?? agentFaceStatusLine(counts)),
    legend: confirm ? AGENT_FACE_LEGEND_CONFIRM : AGENT_FACE_LEGEND,
    detailOverride,
  };
}
