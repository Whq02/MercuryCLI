// ============================================================================
//  services/kitMenu/kitTypes — the MCPs & Skills manager's vocabulary.
//
//  The manager is ONE screen with TWO TITLED SECTIONS: "MCPs" (every
//  operator-configured server, on/off) then "Skills" (every skill,
//  tri-state on / invocable / off — invocable = listed, loads only on
//  /name, never ambient). Extension-contributed servers and skills appear
//  in those two lists under their extension's label, and each extension
//  gets a MASTER ROW grouped above its items whose off turns off
//  EVERYTHING the extension contributes (skills, servers, commands, hooks).
//  Mercury's own organs (the ide bridge, the bundled skills) are never
//  listed — only operator-added sources appear.
//
//  NAMING LAW (scout-B §0.3): a row's `name` IS the spelling the runner
//  resolves at connect/load — a config server by its config key, an
//  extension server as `ext:<extension>:<server>`, an extension skill as
//  `<extension>:<skill>` — so a toggle can never miss its target. Every
//  surface uses these spellings verbatim; the label is the name.
//
//  "pack" is RESERVED for extensions; a saved kit snapshot is a PRESET.
// ============================================================================

export type McpState = 'on' | 'off'
export type SkillState = 'on' | 'invocable' | 'off'
export const MCP_STATES: readonly McpState[] = ['on', 'off']
export const SKILL_STATES: readonly SkillState[] = ['on', 'invocable', 'off']

export type KitSection = 'mcp' | 'skill'
/** The two titled sections, in the ruled order (the operator's words). */
export const KIT_SECTIONS: readonly KitSection[] = ['mcp', 'skill']
export const KIT_SECTION_TITLE: Readonly<Record<KitSection, string>> = { mcp: 'MCPs', skill: 'Skills' }

export type KitRow =
  /** An MCP server in the runner's resolved spelling; `scope` is the config
   *  scope it came from ('dynamic' for an extension's server). */
  | { kind: 'mcp'; section: 'mcp'; name: string; scope: string; extension: string | null }
  /** A skill in the runner's resolved spelling; `source` names where it
   *  loads from (the settings source or the extension). */
  | { kind: 'skill'; section: 'skill'; name: string; source: string; extension: string | null }
  /** An extension's MASTER ROW (Option 2), grouped above that extension's
   *  items in the section; `contributes` is the plain-words census of what
   *  its off turns off ("2 skills · 1 server · commands · hooks"). */
  | { kind: 'extension'; section: KitSection; name: string; contributes: string }
  /** A section's honest empty line — inert, never focused. */
  | { kind: 'empty'; section: KitSection; text: string }
  /** A section's honest NOTE (composed after its members — the MCP-sourced
   *  skills sentence: no server is connected at the face) — inert. */
  | { kind: 'note'; section: KitSection; text: string }

export interface KitCatalogue {
  readonly rows: readonly KitRow[]
}

export const EMPTY_KIT_CATALOGUE: KitCatalogue = { rows: [] }

/** The screen's first paint while the doors answer: each section says so
 *  (never the "none configured" words before the read is in). */
export const LOADING_KIT_CATALOGUE: KitCatalogue = {
  rows: [
    { kind: 'empty', section: 'mcp', text: 'reading the MCP configs…' },
    { kind: 'empty', section: 'skill', text: 'reading the skills…' },
  ],
}

/** A row that carries a toggle (master rows included). */
export function isKitMember(row: KitRow): row is Extract<KitRow, { kind: 'mcp' | 'skill' | 'extension' }> {
  return row.kind === 'mcp' || row.kind === 'skill' || row.kind === 'extension'
}

/** The section's empty words (the screen paints no nag — a fresh home
 *  simply says what is not there). */
export function emptySectionText(section: KitSection): string {
  // An empty section leads with its DOOR (the OS-1 empty-state precedent):
  // what is not there, then the way to make one.
  return section === 'mcp'
    ? 'no MCP servers configured — add one with /mcp add'
    : 'no skills found — create one under .mercury/skills/'
}

/** Stable, data-derived row ids (the list hook's identity law). */
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

/** The screen's row list: every section present in the ruled order; a
 *  section with no member (and no empty line of its own) gets the honest
 *  empty line; members keep catalogue order; notes compose LAST. */
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

// ── the states (C2) ────────────────────────────────────────────────────────

export type KitRowState = McpState | SkillState

/** The STATE key a row's toggle writes — an extension's master rows (one per
 *  section it contributes to) share ONE state, so the key drops the
 *  section; items key by their resolved spelling. Empty lines have none. */
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

/** The row's cycle: MCP servers and master rows on ⇄ off; skills
 *  on → invocable → off → on (↵/space/→ forward, ← back). */
export function cycleState(row: KitRow, current: KitRowState, direction: 1 | -1): KitRowState {
  const ring: readonly KitRowState[] = row.kind === 'skill' ? SKILL_STATES : MCP_STATES
  const idx = Math.max(0, ring.indexOf(current))
  return ring[(idx + direction + ring.length) % ring.length]!
}

/** DEVIATIONS ONLY: an absent key means 'on' — default all-on by
 *  construction (a newly added server, skill or extension is on with no
 *  menu edit; a fresh home never nags). */
export type KitStates = ReadonlyMap<string, KitRowState>

export interface KitRowView {
  /** The row's OWN recorded state. */
  own: KitRowState
  /** What the next session actually gets: an item under an OFF extension
   *  master is off whatever its own state says (Option 2). */
  effective: KitRowState
  /** The item's extension master is off. */
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

/** The NEXT SESSION panel's numbers, over EFFECTIVE states (master rows
 *  and empty lines are not members). */
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
