export type CatalogueDoorFacet = { group: string; family: string; total: number; open?: boolean }

export type PickerRow = {
  id: string
  name: string
  tag: string
  group: string
  door?: string
  action?: boolean
  gated?: boolean
  choice?: string
  expand?: CatalogueDoorFacet
}

export type FoldState = 'folded' | 'top' | 'full'

export const PICKER_FOLD_BOUND = 12
export const PICKER_TOP_ROWS = 12
export const PICKER_FILTER_REACH = 50

export const MODEL_PICKER_TITLE = 'Mercury · model'
export const MODEL_PICKER_FILTER_PLACEHOLDER = 'filter by name or id'
export const MODEL_PICKER_HINT = '↑↓ select · ↵ switch · c context · → ← fold · / filter · esc or click outside closes'
export const MODEL_PICKER_NO_ALIAS = 'new · no alias'
export const MODEL_PICKER_CURRENT = 'current'
export const MODEL_PICKER_UNAVAILABLE = 'unavailable'
export const MODEL_PICKER_PANEL = { cap: 100, reserve: 2, min: 20 } as const

export type ProviderDoor = { door: string; account?: string; active?: boolean }
export type ProviderHeading = { name: string; doors: ProviderDoor[]; reason?: string; note?: string }

export type PickerGroup<T extends PickerRow> = {
  group: string
  rows: T[]
  door?: T
  doors: string[]
}

export type PickerLine<T extends PickerRow> =
  | { kind: 'heading'; group: string; fold: FoldState; live: number; matched?: number; total?: number }
  | { kind: 'door'; group: string; door: string; live: number; matched?: number; total?: number }
  | { kind: 'row'; row: T; key: string }
  | { kind: 'more'; group: string; hidden: number; reach: boolean }

export function rowKey(row: PickerRow): string {
  return row.door === undefined ? row.id : `${row.id}@${row.door}`
}

export function isModelRow(row: PickerRow): boolean {
  return row.action !== true && row.expand === undefined && row.choice === undefined
}

export function isLiveRow(row: PickerRow): boolean {
  return isModelRow(row) && row.gated !== true
}

export function liveCount(rows: readonly PickerRow[]): number {
  return new Set(rows.filter(isLiveRow).map(row => row.id)).size
}

export function hasAlias(row: PickerRow): boolean {
  return row.name.trim() !== '' && row.name.trim() !== row.id.trim()
}

export function matchesPickerFilter(row: PickerRow, filter: string): boolean {
  const needle = filter.trim().toLowerCase()
  if (needle === '') return true
  return row.id.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle)
}

export function groupPickerRows<T extends PickerRow>(rows: readonly T[]): PickerGroup<T>[] {
  const out: PickerGroup<T>[] = []
  const byGroup = new Map<string, PickerGroup<T>>()
  for (const row of rows) {
    let group = byGroup.get(row.group)
    if (group === undefined) {
      group = { group: row.group, rows: [], doors: [] }
      byGroup.set(row.group, group)
      out.push(group)
    }
    if (row.expand !== undefined) {
      group.door = row
      continue
    }
    group.rows.push(row)
    if (row.door !== undefined && !group.doors.includes(row.door)) group.doors.push(row.door)
  }
  return out
}

export function groupSize<T extends PickerRow>(group: PickerGroup<T>): number {
  const listed = group.rows.filter(isModelRow).length
  return group.door !== undefined ? Math.max(listed, group.door.expand?.total ?? 0) : listed
}

export function orderPickerGroups<T extends PickerRow>(
  groups: readonly PickerGroup<T>[],
  opts: { top?: string; recentAt?: (group: string) => number | undefined },
): PickerGroup<T>[] {
  const at = (group: string): number => opts.recentAt?.(group) ?? 0
  return groups
    .map((group, index) => ({ group, index }))
    .sort((a, b) => {
      if (a.group.group === opts.top) return -1
      if (b.group.group === opts.top) return 1
      const diff = at(b.group.group) - at(a.group.group)
      return diff !== 0 ? diff : a.index - b.index
    })
    .map(entry => entry.group)
}

export function orderPickerRows<T extends PickerRow>(
  rows: readonly T[],
  opts: { top?: string; recentAt?: (group: string) => number | undefined },
): T[] {
  return orderPickerGroups(groupPickerRows(rows), opts).flatMap(group => (group.door === undefined ? group.rows : [...group.rows, group.door]))
}

export function initialPickerFolds<T extends PickerRow>(groups: readonly PickerGroup<T>[], top: string | undefined, currentKey?: string): Record<string, FoldState> {
  const folds: Record<string, FoldState> = {}
  for (const group of groups) {
    const isTop = group.group === top
    folds[group.group] = isTop || groupSize(group) <= PICKER_FOLD_BOUND ? 'top' : 'folded'
    if (currentKey !== undefined) {
      const index = group.rows.findIndex(row => rowKey(row) === currentKey)
      if (index >= 0) folds[group.group] = index < PICKER_TOP_ROWS ? 'top' : 'full'
    }
  }
  return folds
}

export function cyclePickerFold(fold: FoldState, direction: 'open' | 'close', hidden: boolean): FoldState {
  if (direction === 'close') return 'folded'
  if (fold === 'folded') return 'top'
  return hidden ? 'full' : fold
}

function doorLines<T extends PickerRow>(group: PickerGroup<T>, rows: readonly T[], filter: string, totals: (door: string) => number): PickerLine<T>[] {
  const out: PickerLine<T>[] = []
  const filtering = filter.trim() !== ''
  for (const door of group.doors) {
    const own = rows.filter(row => (row.door ?? group.doors[0]) === door)
    if (own.length === 0) continue
    const live = liveCount(own)
    out.push({ kind: 'door', group: group.group, door, live, ...(filtering ? { matched: own.filter(isModelRow).length, total: totals(door) } : {}) })
    for (const row of own) out.push({ kind: 'row', row, key: rowKey(row) })
  }
  return out
}

function reachOfGroup<T extends PickerRow>(group: PickerGroup<T>, fullRows: (group: string) => T[] | undefined): readonly T[] {
  return group.door !== undefined ? (fullRows(group.group) ?? group.rows) : group.rows
}

export function pickerReachTotal<T extends PickerRow>(groups: readonly PickerGroup<T>[], fullRows: (group: string) => T[] | undefined): number {
  return groups.reduce((sum, group) => sum + reachOfGroup(group, fullRows).filter(isModelRow).length, 0)
}

export function composePickerLines<T extends PickerRow>(
  groups: readonly PickerGroup<T>[],
  folds: Record<string, FoldState>,
  filter: string,
  fullRows: (group: string) => T[] | undefined,
): PickerLine<T>[] {
  const out: PickerLine<T>[] = []
  const filtering = filter.trim() !== ''
  for (const group of groups) {
    const reachOf = (): readonly T[] => reachOfGroup(group, fullRows)
    if (filtering) {
      const pool = [...group.rows.filter(row => !isModelRow(row) && row.expand === undefined), ...reachOf().filter(isModelRow)]
      const matches = pool.filter(row => matchesPickerFilter(row, filter))
      const models = matches.filter(isModelRow)
      if (models.length === 0) continue
      out.push({ kind: 'heading', group: group.group, fold: 'full', live: liveCount(models), matched: models.length, total: pool.filter(isModelRow).length })
      if (group.doors.length >= 2) {
        out.push(...doorLines(group, models, filter, door => pool.filter(row => isModelRow(row) && (row.door ?? group.doors[0]) === door).length))
      } else {
        for (const row of matches) out.push({ kind: 'row', row, key: rowKey(row) })
      }
      continue
    }
    const fold = folds[group.group] ?? 'top'
    const listedModels = group.rows.filter(isModelRow)
    const size = groupSize(group)
    const live = group.door !== undefined ? Math.max(group.door.expand?.total ?? 0, liveCount(group.rows)) : liveCount(group.rows)
    out.push({ kind: 'heading', group: group.group, fold, live })
    if (fold === 'folded') continue
    const actions = group.rows.filter(row => !isModelRow(row))
    const shownModels = fold === 'full' ? (group.door !== undefined ? reachOf().filter(isModelRow) : listedModels) : listedModels.slice(0, PICKER_TOP_ROWS)
    const shown = [...actions, ...shownModels]
    if (group.doors.length >= 2) out.push(...doorLines(group, shown, filter, () => 0))
    else for (const row of shown) out.push({ kind: 'row', row, key: rowKey(row) })
    const hidden = fold === 'full' ? 0 : size - shownModels.length
    if (hidden > 0) out.push({ kind: 'more', group: group.group, hidden, reach: hidden > PICKER_FILTER_REACH })
  }
  return out
}

export function isCursorStop<T extends PickerRow>(line: PickerLine<T> | undefined): boolean {
  return line !== undefined && (line.kind === 'row' || line.kind === 'heading')
}

export function firstRowIndex<T extends PickerRow>(lines: readonly PickerLine<T>[], from = 0): number {
  for (let index = Math.max(0, from); index < lines.length; index++) if (lines[index]!.kind === 'row') return index
  return -1
}

export function headingIndexOf<T extends PickerRow>(lines: readonly PickerLine<T>[], group: string): number {
  return lines.findIndex(line => line.kind === 'heading' && line.group === group)
}

export function nextStop<T extends PickerRow>(lines: readonly PickerLine<T>[], from: number, step: 1 | -1): number {
  let index = from + step
  while (index >= 0 && index < lines.length) {
    if (isCursorStop(lines[index])) return index
    index += step
  }
  return from
}

export function lastStop<T extends PickerRow>(lines: readonly PickerLine<T>[]): number {
  for (let index = lines.length - 1; index >= 0; index--) if (isCursorStop(lines[index])) return index
  return 0
}

export function moreLineWords(hidden: number, reach: boolean): string {
  return `↓ ${hidden} more · → unfolds the rest${reach ? ' · / filter reaches every one' : ''}`
}

export function matchWords(matched: number, total: number): string {
  return `${matched} of ${total} match`
}

function countWords(live: number, matched: number | undefined, total: number | undefined): string {
  return matched !== undefined && total !== undefined ? `${matched} of ${total}` : `${live} live`
}

export function providerNameOfGroup(group: string): string {
  const inner = /^Mercury — (.+?)(?: models)?$/.exec(group)?.[1] ?? group
  return inner.toUpperCase()
}

export function headingWords(
  heading: ProviderHeading | undefined,
  group: string,
  counts: { live: number; matched?: number; total?: number },
): string {
  const name = heading?.name ?? providerNameOfGroup(group)
  const count = countWords(counts.live, counts.matched, counts.total)
  if (heading === undefined) return counts.live === 0 && counts.matched === undefined ? name : `${name} · ${count}`
  const parts = [name]
  if (heading.doors.length === 1) {
    const [door] = heading.doors
    parts.push(door!.door)
    if (door!.account !== undefined) parts.push(door!.account)
  } else if (heading.doors.length >= 2) {
    parts.push(heading.doors.map(door => door.door).join(' + '))
  }
  if (heading.reason !== undefined) parts.push(heading.reason)
  if (heading.reason === undefined || counts.live > 0 || counts.matched !== undefined) parts.push(count)
  if (heading.note !== undefined) parts.push(heading.note)
  return parts.join(' · ')
}

export function doorWords(door: ProviderDoor, counts: { live: number; matched?: number; total?: number }): string {
  const parts = [door.door]
  if (door.account !== undefined) parts.push(door.account)
  parts.push(countWords(counts.live, counts.matched, counts.total))
  if (door.active === true) parts.push('active')
  return parts.join(' · ')
}

export type PickerColumns = { alias: number; id: number; state: number; ctx: number; tail: number }

export function pickerColumns(rowWidth: number): PickerColumns {
  const state = 13
  const ctx = 11
  const tailTarget = 14
  const alias = Math.max(12, Math.min(22, Math.round(rowWidth * 0.24)))
  const id = Math.max(20, Math.min(32, rowWidth - alias - state - ctx - tailTarget))
  const tail = Math.max(0, rowWidth - alias - id - state - ctx)
  return { alias, id, state, ctx, tail }
}
