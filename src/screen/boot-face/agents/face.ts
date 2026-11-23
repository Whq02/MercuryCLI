import type { AgentDefinition } from '../../../crew/agents/agentDefinition.js';
import { resolveEffectiveAgentRuntime, type AgentEstateEntry } from '../../../crew/agents/resolver.js';
import type { AgentTrashEntry } from '../../../crew/agents/store.js';
import type { StudioRow } from '../../agents/studio/studioData.js';
import { fieldValueLabel, FIELD_ROWS, type FieldId, type StudioEditorSnapshot, type StudioValidation } from '../../agents/studio/studioEditorModel.js';
import { getAgentSourceDisplayName } from '../../agents/utils.js';
import { SCOUT_TOOLS_DESCRIPTION } from '../../../tools/crewmate/scoutPolicy.js';

export type FaceEntry = {
  label: string;
  group: string;
  groupTitle: string;
  summary: string;
  valueLabel: string;
  valueIsDefault: boolean;
  pinnedVal: string | null;
  detail: null;
  inert?: boolean;
};


export function agentFaceEntryOf(row: StudioRow): FaceEntry {
  if (row.kind === 'invalid') {
    return {
      label: `invalid: ${row.invalid!.path.split(/[\\/]/).slice(-2).join('/')}`,
      group: 'needs attention',
      groupTitle: 'needs attention',
      summary: row.invalid!.error,
      valueLabel: 'unreadable',
      valueIsDefault: false,
      pinnedVal: null,
      detail: null,
    };
  }
  const agent = row.agent!;
  const disabled = agent.disabled === true;
  const group = getAgentSourceDisplayName(agent.source);
  return {
    label: agent.agentType,
    group,
    groupTitle: group,
    summary: agent.whenToUse.replace(/\n/g, ' '),
    valueLabel: disabled
      ? 'off'
      : `${agent.model ?? 'inherit'}${agent.operatorOverride ? ' (override)' : ''}${row.shadowed ? ' · shadowed' : ''}`,
    valueIsDefault: !disabled && agent.operatorOverride === undefined && row.shadowed !== true,
    pinnedVal: null,
    detail: null,
  };
}

export function agentFaceDetailLines(
  row: StudioRow,
  estate: Map<string, AgentEstateEntry>,
  eff: ReturnType<typeof resolveEffectiveAgentRuntime> | null,
  availabilityNote: string | null = null,
): string[] {
  if (row.kind === 'invalid') {
    return [
      'invalid definition',
      '',
      row.invalid!.path,
      row.invalid!.error,
      '',
      'the file stays visible until it parses —',
      'fix it in your editor; the roster repaints',
      'as it lands on disk.',
    ];
  }
  const agent = row.agent!;
  const lines: string[] = [
    `${agent.agentType}${agent.disabled ? ' (disabled)' : ''}`,
    '',
    (agent as { filePath?: string }).filePath ??
      (agent.source === 'built-in'
        ? 'built-in (no file)'
        : agent.source === 'extension'
          ? `extension: ${(agent as { extensionName?: string }).extensionName ?? '?'}`
          : 'in-memory (--agent-defs flag)'),
    `scope: ${getAgentSourceDisplayName(agent.source)}`,
  ];
  if (eff !== null) {
    const effortLine =
      eff.effortIntent !== undefined
        ? `effort: ${eff.effortIntent} → ${eff.effort.label}`
        : eff.effort.supportsEffort && eff.effort.appliedValue === undefined && eff.effort.label === 'default'
          ? 'effort: session'
          : `effort: session → ${eff.effort.label}`;
    lines.push(
      `model: ${eff.modelIntent} → ${eff.model}${eff.modelIntent === 'inherit' ? " (your session's model)" : ''}`,
      effortLine,
    );
    if (availabilityNote !== null) lines.push(`availability: ${availabilityNote} — Logins signs in`);
    if (eff.tools) {
      lines.push(
        eff.tools.readOnly
          ? `tools: ${SCOUT_TOOLS_DESCRIPTION}`
          : eff.tools.hasWildcard
          ? 'tools: all (MCP tools join at session time)'
          : `tools: ${eff.tools.validTools.length} of the base roster${eff.tools.invalidTools.length > 0 ? ` · unknown: ${eff.tools.invalidTools.join(', ')}` : ''}`,
      );
    }
  }
  if (agent.skills && agent.skills.length > 0) lines.push(`skills: ${agent.skills.join(', ')}`);
  if (agent.memory) lines.push(`memory: ${agent.memory}`);
  const entry = estate.get(agent.agentType);
  if (entry && entry.candidates.length > 1) {
    lines.push('', 'shadow chain:');
    for (const c of entry.candidates) {
      lines.push(`  ${c.winner ? '● wins' : `◌ ${c.shadowReason ?? 'shadowed'}`} — ${getAgentSourceDisplayName(c.agent.source)}`);
    }
  }
  return lines;
}

export function agentFaceSummaryRows(counts: {
  active: number;
  disabled: number;
  issues: number;
}): Array<{ key: string; value: string; tone?: 'teal' }> {
  return [
    { key: 'Agents', value: `${counts.active} active · ${counts.disabled} off` },
    { key: 'Issues', value: counts.issues > 0 ? `${counts.issues} need attention` : 'none' },
    { key: 'Applies', value: '● live sessions see new agents', tone: 'teal' },
  ];
}

export function agentFaceStatusLine(counts: { active: number; disabled: number }): string {
  return `${counts.active} agent${counts.active === 1 ? '' : 's'} active — a create lands in every session, running ones included`;
}

export const AGENT_FACE_LEGEND = '↑↓ move · ↵ edit · n new · x on/off · ⌫ delete · u trash · esc back';
export const AGENT_FACE_LEGEND_FORM = '↑↓ move · ↵ edit field · g generate · s save · ⌫ clear · esc back';
export const AGENT_FACE_LEGEND_PROMPT = 'type · ↵ apply · esc cancel';
export const AGENT_FACE_LEGEND_PICK = '↑↓ move · ↵ pick · esc back';
export const AGENT_FACE_LEGEND_TRASH = '↑↓ move · ↵ restore · esc back';
export const AGENT_FACE_LEGEND_CONFIRM = 'y / ↵ delete (recoverable) · n / esc cancel';

export function agentDeleteConfirmLines(agent: AgentDefinition): string[] {
  return [
    'delete agent',
    '',
    `delete ${agent.agentType}?`,
    '',
    'the file moves to the recovery area —',
    "never a permanent unlink; 'u' on the",
    'library restores it.',
    '',
    (agent as { filePath?: string }).filePath ?? '',
  ];
}

export function agentTrashEntryOf(entry: AgentTrashEntry): FaceEntry {
  return {
    label: entry.agentType,
    group: 'recovery area',
    groupTitle: 'recovery area',
    summary: `deleted ${entry.deletedAt.slice(0, 16)} · was ${entry.originalPath}`,
    valueLabel: 'restorable',
    valueIsDefault: true,
    pinnedVal: null,
    detail: null,
  };
}


export function agentFormRowIds(mode: 'create' | 'edit'): Array<'destination' | FieldId> {
  return mode === 'create' ? ['destination', ...FIELD_ROWS.map(r => r.id)] : FIELD_ROWS.map(r => r.id);
}

export function agentFormEntryOf(
  id: 'destination' | FieldId,
  snap: StudioEditorSnapshot,
): FaceEntry {
  if (id === 'destination') {
    return {
      label: 'destination',
      group: 'agent form',
      groupTitle: 'agent form',
      summary: 'where the definition file lands — the project repo or your personal home.',
      valueLabel: snap.scope,
      valueIsDefault: snap.scope === 'project',
      pinnedVal: null,
      detail: null,
    };
  }
  const rowMeta = FIELD_ROWS.find(r => r.id === id)!;
  return {
    label: rowMeta.label,
    group: 'agent form',
    groupTitle: 'agent form',
    summary: '',
    valueLabel: fieldValueLabel(snap.doc, id),
    valueIsDefault: false,
    pinnedVal: null,
    detail: null,
  };
}

export function agentFormDetailLines(args: {
  snap: StudioEditorSnapshot;
  validation: StudioValidation;
  destination: string;
  effectiveLine: string | null;
  mode: 'create' | 'edit';
}): string[] {
  const { snap, validation, destination, effectiveLine, mode } = args;
  if (snap.recoverOffer) {
    return [
      'unsaved draft found',
      '',
      'an unsaved draft from a previous session',
      'exists for this target.',
      '',
      'y / ↵ recover it · n discard it',
    ];
  }
  if (snap.conflict) {
    return [
      'revision conflict',
      '',
      'the file changed on disk while you edited.',
      '',
      'L load theirs + re-apply your edits',
      'esc keep editing (save will keep refusing)',
    ];
  }
  if (snap.busy) {
    return [mode === 'create' ? 'create agent' : 'edit agent', '', '◓ working … (esc cancels generation)'];
  }
  const lines: string[] = [
    mode === 'create' ? 'create agent' : `edit ${snap.doc.fields.name}`,
    '',
    `→ ${destination}`,
  ];
  if (effectiveLine !== null) lines.push(`runs: ${effectiveLine}`);
  lines.push('');
  if (validation.errors.length > 0) {
    for (const e of validation.errors) lines.push(`✗ ${e}`);
  }
  if (validation.warnings.length > 0) {
    for (const w of validation.warnings) lines.push(`▲ ${w}`);
  }
  if (validation.errors.length === 0 && validation.warnings.length === 0) {
    lines.push('✓ ready to save');
  }
  lines.push('', validation.canSave ? 's saves it' : 'save disabled while errors exist');
  return lines;
}

export function agentFormFieldKind(
  id: 'destination' | FieldId,
): 'cycle' | 'text' | 'body' | 'pick' | 'tools' {
  switch (id) {
    case 'destination':
    case 'background':
    case 'isolation':
      return 'cycle';
    case 'name':
    case 'description':
    case 'skills':
    case 'maxTurns':
    case 'initialPrompt':
      return 'text';
    case 'body':
      return 'body';
    case 'tools':
    case 'disallowedTools':
      return 'tools';
    default:
      return 'pick';
  }
}

export const BODY_CAP = 20_000;
export const TEXT_CAP = 4096;
