import { matchBlock } from '../../../integrations/extensions/blocklist.js'
import { trustStateOf } from '../../../integrations/extensions/roster.js'
import { installedFromSource } from '../../../integrations/extensions/sources.js'
import type { RowAction } from '../../widgets/NavigablePanes.js'
import type { installCardActions, rowSourceActions } from './actions.js'
import { rowKeyOf, type BoardRow, type Slot } from './shapes.js'

type RowActionsArgs = Pick<ReturnType<typeof installCardActions>, 'openCardForEntry' | 'doUpdate' | 'openUninstallConfirm'> &
  Pick<ReturnType<typeof rowSourceActions>, 'toggleRow' | 'toggleBlockEntry' | 'openOptions' | 'doSwapPrevious' | 'doRefreshSource' | 'toggleBlockSource'> & {
    kchar: (action: string) => string | null
    setSlot: (slot: Slot | null) => void
  }

export function boardRowActions({ kchar, toggleRow, openCardForEntry, doUpdate, openUninstallConfirm, toggleBlockEntry, openOptions, doSwapPrevious, doRefreshSource, setSlot, toggleBlockSource }: RowActionsArgs): RowAction<BoardRow>[] {
  const isExt = (r: BoardRow): r is Extract<BoardRow, { kind: 'ext' }> => r.kind === 'ext'
  const isSrc = (r: BoardRow): r is Extract<BoardRow, { kind: 'src' }> => r.kind === 'src'
  const toggleable = (r: BoardRow): boolean =>
    isExt(r) && (r.entry.home === 'installed' || r.entry.home === 'bundled' || (r.entry.home === 'project' && r.entry.record !== null))

  const act = (action: string, label: string, when: (r: BoardRow) => boolean, run: (r: BoardRow) => void): RowAction<BoardRow>[] => {
    const char = kchar(action)
    if (char === null) return []
    return [{ key: char, label, ...(char === ' ' ? { hint: `space ${label}` } : {}), when, run }]
  }
  const rowActions: RowAction<BoardRow>[] = [
    ...act('toggle', 'off', r => toggleable(r) && isExt(r) && r.entry.switchedOn && r.entry.blockedBy === null, r => isExt(r) && toggleRow(r.entry)),
    ...act('toggle', 'on', r => toggleable(r) && isExt(r) && !r.entry.switchedOn && r.entry.blockedBy === null, r => isExt(r) && toggleRow(r.entry)),
    ...act(
      'install',
      'install',
      r => isExt(r) && trustStateOf(r.entry) === 'found' && r.entry.home === 'project',
      r => isExt(r) && openCardForEntry(r.entry, { section: 'installed', row: rowKeyOf(r) }),
    ),
    ...act(
      'install',
      'fetch',
      r => isExt(r) && r.entry.home === 'proposal' && r.entry.blockedBy === null,
      r => isExt(r) && openCardForEntry(r.entry, { section: 'installed', row: rowKeyOf(r) }),
    ),
    ...act(
      'install',
      'approve',
      r =>
        isExt(r) &&
        r.entry.home !== 'proposal' &&
        trustStateOf(r.entry) === 'off' &&
        (!r.entry.approved || r.entry.changedSinceApproval) &&
        r.entry.root !== null,
      r => isExt(r) && openCardForEntry(r.entry, { section: 'installed', row: rowKeyOf(r) }),
    ),
    ...act(
      'update',
      'update',
      r => isExt(r) && r.entry.availableVersion !== null && r.entry.home === 'installed',
      r => isExt(r) && void doUpdate(r.entry, { section: 'installed', row: rowKeyOf(r) }),
    ),
    ...act('remove', 'uninstall', r => isExt(r) && r.entry.home === 'installed', r => isExt(r) && openUninstallConfirm(r.entry)),
    ...act(
      'remove',
      'forget',
      r => isExt(r) && r.entry.home === 'project' && r.entry.record !== null,
      r => isExt(r) && openUninstallConfirm(r.entry),
    ),
    ...act(
      'block',
      'block',
      r => isExt(r) && r.entry.blockedBy === null && (r.entry.home === 'installed' || trustStateOf(r.entry) === 'found'),
      r => isExt(r) && toggleBlockEntry(r.entry),
    ),
    ...act('block', 'unblock', r => isExt(r) && r.entry.blockedBy === 'operator', r => isExt(r) && toggleBlockEntry(r.entry)),
    ...act(
      'options',
      'options',
      r => isExt(r) && r.entry.manifest !== null && Object.keys(r.entry.manifest.needs?.options ?? {}).length > 0,
      r => isExt(r) && openOptions(r.entry),
    ),
    ...act('previous', 'previous', r => isExt(r) && r.entry.previous !== null, r => isExt(r) && doSwapPrevious(r.entry)),
    ...act('refresh', 'refresh', isSrc, r => isSrc(r) && void doRefreshSource(r.row.label)),
    ...act('remove', 'remove', isSrc, r =>
      isSrc(r) ? setSlot({ mode: 'remove-source', label: r.row.label, installedIds: installedFromSource(r.row.label) }) : undefined,
    ),
    ...act('block', 'block', r => isSrc(r) && matchBlock([r.row.label, r.row.record.where]) === null, r => isSrc(r) && toggleBlockSource(r.row)),
    ...act(
      'block',
      'unblock',
      r => isSrc(r) && matchBlock([r.row.label, r.row.record.where])?.by === 'operator',
      r => isSrc(r) && toggleBlockSource(r.row),
    ),
  ]
  return rowActions
}
