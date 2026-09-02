
export type McpState = 'on' | 'off'
export type SkillState = 'on' | 'invocable' | 'off'
export const MCP_STATES: readonly McpState[] = ['on', 'off']
export const SKILL_STATES: readonly SkillState[] = ['on', 'invocable', 'off']

export type KitSection = 'mcp' | 'skill'
export const KIT_SECTIONS: readonly KitSection[] = ['mcp', 'skill']
export const KIT_SECTION_TITLE: Readonly<Record<KitSection, string>> = { mcp: 'MCPs', skill: 'Skills' }

export type KitRow =
  | { kind: 'mcp'; section: 'mcp'; name: string; scope: string; extension: string | null }
  | { kind: 'skill'; section: 'skill'; name: string; source: string; extension: string | null }
  | { kind: 'extension'; section: KitSection; name: string; contributes: string }
  | { kind: 'empty'; section: KitSection; text: string }
  | { kind: 'note'; section: KitSection; text: string }

export interface KitCatalogue {
  readonly rows: readonly KitRow[]
}

export const EMPTY_KIT_CATALOGUE: KitCatalogue = { rows: [] }

export const LOADING_KIT_CATALOGUE: KitCatalogue = {
  rows: [
    { kind: 'empty', section: 'mcp', text: 'reading the MCP configs…' },
    { kind: 'empty', section: 'skill', text: 'reading the skills…' },
  ],
}

export function isKitMember(row: KitRow): row is Extract<KitRow, { kind: 'mcp' | 'skill' | 'extension' }> {
  return row.kind === 'mcp' || row.kind === 'skill' || row.kind === 'extension'
}

export function emptySectionText(section: KitSection): string {
  return section === 'mcp'
    ? 'no MCP servers configured — add one with /mcp add'
    : 'no skills found — create one under .mercury/skills/'
}

export function kitRowId(row: KitRow): string {
  switch (row.kind) {
    case 'mcp':
      return `mcp:${row.name}`
    case 'skill':
      return `skill:${row.name}`
    case 'extension':
      return `extension:${row.section}:${row.name}`
    case 'empty':
      return `empty:${row.section}`
    case 'note':
      return `note:${row.section}:${row.text}`
  }
}

export function sectionRows(catalogue: KitCatalogue): KitRow[] {
  const out: KitRow[] = []
  for (const section of KIT_SECTIONS) {
    const rows = catalogue.rows.filter(r => r.section === section)
    const members = rows.filter(isKitMember)
    if (members.length === 0 && !rows.some(r => r.kind === 'empty')) out.push({ kind: 'empty', section, text: emptySectionText(section) })
    out.push(...rows.filter(r => r.kind !== 'note'), ...rows.filter(r => r.kind === 'note'))
  }
  return out
}


export type KitRowState = McpState | SkillState

export function kitStateKey(row: KitRow): string | null {
  switch (row.kind) {
    case 'mcp':
      return `mcp:${row.name}`
    case 'skill':
      return `skill:${row.name}`
    case 'extension':
      return `extension:${row.name}`
    case 'empty':
    case 'note':
      return null
  }
}

export function cycleState(row: KitRow, current: KitRowState, direction: 1 | -1): KitRowState {
  const ring: readonly KitRowState[] = row.kind === 'skill' ? SKILL_STATES : MCP_STATES
  const idx = Math.max(0, ring.indexOf(current))
  return ring[(idx + direction + ring.length) % ring.length]!
}

export type KitStates = ReadonlyMap<string, KitRowState>

export interface KitRowView {
  own: KitRowState
  effective: KitRowState
  masterOff: boolean
}

export function kitRowView(row: KitRow, states: KitStates): KitRowView {
  const key = kitStateKey(row)
  const own: KitRowState = key === null ? 'on' : (states.get(key) ?? 'on')
  const ext = row.kind === 'mcp' || row.kind === 'skill' ? row.extension : null
  const masterOff = ext !== null && (states.get(`extension:${ext}`) ?? 'on') === 'off'
  return { own, effective: masterOff ? 'off' : own, masterOff }
}

export interface KitCounts {
  mcp: { on: number; off: number }
  skill: { on: number; invocable: number; off: number }
}

export function kitCounts(rows: readonly KitRow[], states: KitStates): KitCounts {
  const counts: KitCounts = { mcp: { on: 0, off: 0 }, skill: { on: 0, invocable: 0, off: 0 } }
  for (const row of rows) {
    if (row.kind !== 'mcp' && row.kind !== 'skill') continue
    const { effective } = kitRowView(row, states)
    if (row.kind === 'mcp') counts.mcp[effective === 'off' ? 'off' : 'on']++
    else counts.skill[effective]++
  }
  return counts
}
