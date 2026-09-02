
export type CatalogueDoorFacet = {
  group: string
  family: string
  total: number
  open?: boolean
}

export type CatalogueDoorRow = {
  id: string
  name: string
  tag: string
  group: string
  action?: boolean
  expand?: CatalogueDoorFacet
}

export function catalogueDoorHeaderParts(facet: { family: string; total: number }): { lead: string; tail: string } {
  return { lead: `${facet.family} — ${facet.total} live · filter: `, tail: ' · esc collapse' }
}

export function catalogueDoorHeader(facet: { family: string; total: number }, filter: string): string {
  const parts = catalogueDoorHeaderParts(facet)
  return `${parts.lead}${filter}${parts.tail}`
}

export function filterCatalogueRows<T extends { id: string; name: string }>(rows: readonly T[], filter: string): T[] {
  const needle = filter.trim().toLowerCase()
  if (needle === '') return [...rows]
  return rows.filter(row => row.id.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle))
}

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

export function catalogueDoorFocus<T extends CatalogueDoorRow>(rows: readonly T[], group: string): number {
  const header = rows.findIndex(row => row.expand?.open === true && row.expand.group === group)
  if (header === -1) return -1
  const next = rows[header + 1]
  return next !== undefined && next.group === group && next.expand === undefined ? header + 1 : header
}
