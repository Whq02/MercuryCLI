import {
  ANTHROPIC_MODEL_GROUP,
  getModelOptions,
  isProviderActionRow,
  MODES_MODEL_GROUP,
  type ModelOption,
} from './modelOptions.js'
import { isHaikuTier } from './modelFloor.js'

const INHERIT = 'inherit'

export type AgentModelPickerRow = {
  value: string
  label: string
  description: string
  group: string
  kind: 'inherit' | 'model' | 'connect'
  unavailable?: string
}

export function getAgentModelPickerRows(
  catalogue: ModelOption[] = getModelOptions(),
): AgentModelPickerRow[] {
  const rows: AgentModelPickerRow[] = [
    {
      value: INHERIT,
      label: 'Inherit',
      description: 'Use the same model as the parent session',
      group: 'Agent',
      kind: 'inherit',
    },
  ]
  for (const opt of catalogue) {
    if (opt.value === null) continue
    if (opt.group === MODES_MODEL_GROUP) continue
    if (isHaikuTier(opt.value)) continue
    const group = opt.group ?? ANTHROPIC_MODEL_GROUP
    if (isProviderActionRow(opt.value)) {
      rows.push({ value: opt.value, label: opt.label, description: opt.description, group, kind: 'connect' })
      continue
    }
    rows.push({
      value: opt.value,
      label: opt.label,
      description: opt.description,
      group,
      kind: 'model',
      ...(opt.unavailable !== undefined ? { unavailable: opt.unavailable } : {}),
    })
  }
  return rows
}

export function agentModelAvailabilityNote(
  model: string | undefined,
  rows: AgentModelPickerRow[] = getAgentModelPickerRows(),
): string | null {
  if (model === undefined || model === INHERIT) return null
  const row = rows.find(r => r.value === model)
  return row?.unavailable ?? null
}

export type AgentModelPickOutcome =
  | { kind: 'picked'; model: string | undefined }
  | { kind: 'needs-sign-in'; hint: string }

export function agentModelPickOutcome(row: AgentModelPickerRow): AgentModelPickOutcome {
  if (row.kind === 'connect') return { kind: 'needs-sign-in', hint: `${row.label} — ${row.description}` }
  if (row.unavailable !== undefined) return { kind: 'needs-sign-in', hint: `${row.label} — ${row.unavailable}` }
  return { kind: 'picked', model: row.kind === 'inherit' ? undefined : row.value }
}
