// The /model picker's CATALOGUE DOOR — the pure composition behind the row
// that expands a live-catalogue group (OpenRouter, Hugging Face) from its
// bounded top-N view to the full live list behind a type-to-filter line.
//
// The picker holds two facts (which group is open, the filter text) and
// derives its visible rows here: the listed rows as the wrapper handed them,
// with the open group's model rows and door swapped for ONE header row plus
// the filtered full list. The full list is the catalogue snapshot's rows
// (fetched once, as ever); a keystroke only re-filters. Pure (no ink/react)
// so it unit-tests without a renderer; the picker's own measured window
// paints whichever slice of the composed rows is in view.

/** The door facet a picker row carries. `open` marks the header row the
 *  expanded group paints in the door's place. */
export type CatalogueDoorFacet = {
  /** The picker group the door belongs to (the row's own group string). */
  group: string
  /** The display word the header leads with ('OpenRouter', 'Hugging Face'). */
  family: string
  /** The live row count from the owning availability chain. */
  total: number
  open?: boolean
}

/** The row shape the composition reads — the picker's ModelChoice satisfies it. */
export type CatalogueDoorRow = {
  id: string
  name: string
  tag: string
  group: string
  /** A connect/attach/door ACTION row — never a model. */
  action?: boolean
  expand?: CatalogueDoorFacet
}

/** The open door's header sentence, in the two parts the picker paints
 *  around the live filter text (which carries the caret):
 *  `<family> — <total> live · filter: <text> · esc collapse`. */
export function catalogueDoorHeaderParts(facet: { family: string; total: number }): { lead: string; tail: string } {
  return { lead: `${facet.family} — ${facet.total} live · filter: `, tail: ' · esc collapse' }
}

/** The whole header sentence (the header row's name). */
export function catalogueDoorHeader(facet: { family: string; total: number }, filter: string): string {
  const parts = catalogueDoorHeaderParts(facet)
  return `${parts.lead}${filter}${parts.tail}`
}

/** Narrow rows by a filter: case-insensitive substring over the persisted
 *  id and the display name; the vendor's order is kept among matches. An
 *  empty (or blank) filter is every row. */
export function filterCatalogueRows<T extends { id: string; name: string }>(rows: readonly T[], filter: string): T[] {
  const needle = filter.trim().toLowerCase()
  if (needle === '') return [...rows]
  return rows.filter(row => row.id.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle))
}

/** The picker's visible rows. With no group open the listed rows pass
 *  through. With `expanded` open, that group's model rows and its door are
 *  replaced, at the group's first such row, by the header row (the door row
 *  re-labelled, `expand.open` set) followed by the filtered full list; the
 *  group's OTHER action rows (a stale-catalogue retry row) keep their place.
 *  A group with no door row in the listed rows cannot open — the listed rows
 *  pass through. */
export function composeCatalogueRows<T extends CatalogueDoorRow>(
  listed: readonly T[],
  expanded: string | null,
  filter: string,
  fullRows: readonly T[],
): T[] {
  if (expanded === null) return [...listed]
  const door = listed.find(row => row.expand !== undefined && row.expand.group === expanded)
  if (door === undefined || door.expand === undefined) return [...listed]
  const facet: CatalogueDoorFacet = { ...door.expand, open: true }
  const header: T = { ...door, name: catalogueDoorHeader(facet, filter), tag: '', expand: facet }
  const matches = filterCatalogueRows(fullRows, filter)
  const out: T[] = []
  let inserted = false
  for (const row of listed) {
    if (row.group !== expanded || (row.action === true && row.expand === undefined)) {
      out.push(row)
      continue
    }
    if (!inserted) {
      inserted = true
      out.push(header, ...matches)
    }
  }
  return out
}

/** Where the cursor lands after the composition changes for `group`: the
 *  first row of the open group's filtered list when one matches, else the
 *  header row itself (zero matches keep the filter line focused so esc and
 *  backspace read where they act). -1 when the group is not open. */
export function catalogueDoorFocus<T extends CatalogueDoorRow>(rows: readonly T[], group: string): number {
  const header = rows.findIndex(row => row.expand?.open === true && row.expand.group === group)
  if (header === -1) return -1
  const next = rows[header + 1]
  return next !== undefined && next.group === group && next.expand === undefined ? header + 1 : header
}
