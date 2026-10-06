import type { Attachment } from './types.js'

export type CapsuleSectionName = 'Files' | 'Mentions' | 'Instructions' | 'Memory' | 'Skills' | 'Tasks' | 'Diagnostics' | 'Reminders' | 'Crew' | 'Date'

export const capsuleKinds = {
  file: { section: 'Files', cadence: 'event' },
  already_read_file: { section: 'Files', cadence: 'event' },
  edited_text_file: { section: 'Files', cadence: 'event' },
  edited_image_file: { section: 'Files', cadence: 'event' },
  pdf_reference: { section: 'Files', cadence: 'event' },
  compact_file_reference: { section: 'Files', cadence: 'event' },
  directory: { section: 'Mentions', cadence: 'event' },
  agent_mention: { section: 'Mentions', cadence: 'event' },
  mcp_resource: { section: 'Mentions', cadence: 'event' },
  nested_memory: { section: 'Instructions', cadence: 'state' },
  relevant_memories: { section: 'Memory', cadence: 'state' },
  skill_listing: { section: 'Skills', cadence: 'state' },
  dynamic_skill: { section: 'Skills', cadence: 'state' },
  task_status: { section: 'Tasks', cadence: 'event' },
  diagnostics: { section: 'Diagnostics', cadence: 'event' },
  task_reminder: { section: 'Reminders', cadence: 'event' },
  contract_reminder: { section: 'Reminders', cadence: 'event' },
  date_change: { section: 'Date', cadence: 'state' },
} as const satisfies Partial<Record<Attachment['type'], { section: CapsuleSectionName; cadence: 'state' | 'event' }>>

export function capsuleKind(type: Attachment['type']): { section: CapsuleSectionName; cadence: 'state' | 'event' } | undefined {
  return (capsuleKinds as Partial<Record<Attachment['type'], { section: CapsuleSectionName; cadence: 'state' | 'event' }>>)[type]
}
