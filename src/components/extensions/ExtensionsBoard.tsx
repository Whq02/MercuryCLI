import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { basename } from 'node:path'
import { Box, Text, useInput } from '../../ink.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import { matchBlock } from '../../extensions/blocklist.js'
import { contributionCounts } from '../../extensions/manifest.js'
import { saveOptionValues, type OptionValue } from '../../extensions/options.js'
import { rosterSummary, trustStateOf } from '../../extensions/roster.js'
import {
  installedFromSource,
  listSources,
  type SourceRow,
} from '../../extensions/sources.js'
import type { Health, RosterEntry } from '../../extensions/types.js'
import { getCwd } from '../../utils/cwd.js'
import {
  NavigablePanes,
  type ColumnDef,
  type RowAction,
  type SectionDef,
} from '../mercury-ui/NavigablePanes.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { useOpenEventGate } from '../mercury-ui/useOpenEventGate.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { ApprovalCardView } from './ApprovalCardView.js'
import { charWord, resolveExtensionsBindings } from './bindings.js'
import { ExtensionView, bytesWord } from './ExtensionView.js'
import { SourceView } from './SourceView.js'
import {
  installedRollup,
  noteWords,
  sourceStateWord,
  sourceWhereWords,
  sourcesRollup,
  trustWord,
} from './rowWords.js'
import { boardActions, installCardActions, rowSourceActions } from './board/actions.js'
import { ExtensionSidePane, SourceSidePane } from './board/SidePanes.js'
import { rowKeyOf, type BoardRow, type BoardSeed, type Slot, type View } from './board/shapes.js'

export type { CardSpec } from './board/shapes.js'


export type ExtensionsRoute =
  | { kind: 'board'; section: 'installed' | 'sources' }
  | { kind: 'open'; name: string }
  | { kind: 'add'; raw: string }
  | { kind: 'install'; target: string }

export function ExtensionsBoard({
  onClose,
  route,
  appendTranscript,
}: {
  onClose: () => void
  route: ExtensionsRoute
  appendTranscript: (line: string) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns: cols } = useTerminalSize()
  const setAppState = useSetAppState()
  const extensions = useAppState(s => s.extensions)
  const [sources, setSources] = useState<SourceRow[]>(() => listSources())
  const [view, setView] = useState<View>({ kind: 'board', seed: { section: route.kind === 'board' ? route.section : 'installed' } })
  const [activeSection, setActiveSection] = useState<'installed' | 'sources'>(route.kind === 'board' ? route.section : 'installed')
  const [slot, setSlot] = useState<Slot | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [filterText, setFilterText] = useState('')
  const busyRef = useRef(false)
  const pastGate = useOpenEventGate()

  const entries = extensions.roster as RosterEntry[]
  const healthOf = (id: string): Health | null => extensions.health[id] ?? null

  const kb = React.useMemo(() => resolveExtensionsBindings(), [])
  const kchar = (action: string): string | null => kb.chars.get(`extensions:${action}`) ?? null
  const declinedByDefaultChar = React.useMemo(() => {
    const defaults: ReadonlyArray<readonly [string, string]> = [
      ['extensions:toggle', ' '],
      ['extensions:install', 'i'],
      ['extensions:update', 'U'],
      ['extensions:remove', 'x'],
      ['extensions:block', 'b'],
      ['extensions:options', 'o'],
      ['extensions:add-source', 'a'],
      ['extensions:refresh', 'u'],
      ['extensions:reload', 'r'],
      ['extensions:filter', 'f'],
      ['extensions:previous', 'P'],
    ]
    const map = new Map<string, string>()
    for (const [action, char] of defaults) {
      if (kb.chars.has(action)) continue
      const line = kb.declined.find(l => l.startsWith(action))
      if (line) map.set(char, line)
    }
    return map
  }, [kb])

  const { refresh, doReload, toBoard } = boardActions({ setAppState, setSources, appendTranscript, setNote, setActiveSection, setView })
  const { openCardForEntry, doInstall, doUpdate, cardApprove, cardKeep, doUninstallNow, openUninstallConfirm, cardUninstall, cardEsc } = installCardActions({ setSlot, setNote, setView, busyRef, entries, refresh, doReload, toBoard })
  const { toggleRow, toggleBlockEntry, toggleBlockSource, doRefreshSource, doRemoveSource, runAdd, runFetchProposal, doSwapPrevious, openOptions } = rowSourceActions({ setNote, setSlot, setView, busyRef, entries, refresh, doReload, openCardForEntry, doInstall })

  useEffect(() => {
    if (view.kind === 'ext' && !entries.some(e => e.id === view.id)) toBoard({ section: 'installed' })
    if (view.kind === 'source' && !sources.some(s => s.label === view.label)) toBoard({ section: 'sources' })
  }, [view, entries, sources])

  const routedRef = useRef(false)
  useEffect(() => {
    if (routedRef.current) return
    routedRef.current = true
    if (route.kind === 'add') {
      void runAdd(route.raw)
      return
    }
    if (route.kind === 'open') {
      const source = listSources().find(r => r.label === route.name)
      if (source) {
        setView({ kind: 'source', label: source.label })
        return
      }
      const entry = entries.find(e => e.name === route.name || e.id === route.name)
      if (entry) setView({ kind: 'ext', id: entry.id })
      else setNote(`no extension or source named ${route.name}`)
      return
    }
    if (route.kind === 'install') {
      const at = route.target.lastIndexOf('@')
      const name = at > 0 ? route.target.slice(0, at) : route.target
      const label = at > 0 ? route.target.slice(at + 1) : null
      const entry = entries.find(e => e.id === route.target) ?? entries.find(e => e.name === name && (label === null || e.label === label))
      if (entry) {
        if (trustStateOf(entry) === 'on') setView({ kind: 'board', seed: { section: 'installed', row: `ext:${entry.id}` } })
        else openCardForEntry(entry, { section: 'installed', row: `ext:${entry.id}` })
        return
      }
      const offering = listSources().filter(row => (label === null || row.label === label) && row.catalogue?.extensions.some(e => e.name === name))
      if (offering.length === 0) setNote(`no source offers ${name} — the sources section lists what you have`)
      else if (offering.length > 1) setNote(`${name} is offered by ${offering.map(o => o.label).join(', ')} — open the source and press i`)
      else void doInstall(offering[0]!.label, name, { section: 'installed' })
    }
  }, [])

  const filter = filterText.trim().toLowerCase()
  const extRows: BoardRow[] = entries
    .filter(e => filter === '' || `${e.name} ${e.label} ${noteWords(e, healthOf(e.id))}`.toLowerCase().includes(filter))
    .map(entry => ({ kind: 'ext', entry, health: healthOf(entry.id) }))
  const srcRows: BoardRow[] = sources
    .filter(r => filter === '' || `${r.label} ${r.record.kind} ${r.record.where}`.toLowerCase().includes(filter))
    .map(row => ({ kind: 'src', row }))

  const reloadArmed = extensions.pending || entries.some(e => e.pending !== null)

  useInput(
    (input, key) => {
      if ((key as { ctrl?: boolean }).ctrl || (key as { meta?: boolean }).meta) return
      if (!pastGate() || busyRef.current) return
      if (input !== '' && input === kchar('add-source')) {
        setNote(null)
        setSlot({ mode: 'add', text: '', busy: null, error: null })
      } else if (input !== '' && input === kchar('filter')) {
        setNote(null)
        setSlot({ mode: 'filter', text: filterText })
      } else if (input !== '' && input === kchar('reload')) {
        if (reloadArmed) void doReload()
        else setNote('nothing to reload — the records match the running session')
      } else if (input !== '' && declinedByDefaultChar.has(input)) {
        setNote(declinedByDefaultChar.get(input)!)
      }
    },
    { isActive: view.kind === 'board' && slot === null },
  )

  useEffect(() => {
    if (kb.declined.length === 0) return
    setNote(kb.declined.length === 1 ? kb.declined[0]! : `${kb.declined[0]!} (+${kb.declined.length - 1} more — /keys lists the table)`)
  }, [])

  const onSlotInput = (input: string, key: Record<string, boolean>): void => {
    if (slot === null || key['ctrl'] || key['meta'] || key['super']) return
    const typed = input && !key['tab'] && !key['return'] ? input : ''
    switch (slot.mode) {
      case 'add': {
        if (slot.busy) return
        if (key['return']) {
          void runAdd(slot.text)
          return
        }
        if (key['backspace'] || key['delete']) setSlot({ ...slot, text: slot.text.slice(0, -1), error: null })
        else if (typed) setSlot({ ...slot, text: slot.text + typed, error: null })
        return
      }
      case 'filter': {
        if (key['return']) {
          setSlot(null)
          return
        }
        const next = key['backspace'] || key['delete'] ? slot.text.slice(0, -1) : typed ? slot.text + typed : slot.text
        setSlot({ ...slot, text: next })
        setFilterText(next)
        return
      }
      case 'uninstall': {
        if (input === 'y') void doUninstallNow(slot.id, false)
        else if (input === 'k' && slot.dataBytes > 0 && !slot.inPlace) void doUninstallNow(slot.id, true)
        else if (key['return'] && (slot.inPlace || slot.dataBytes === 0)) void doUninstallNow(slot.id, false)
        return
      }
      case 'remove-source': {
        if (key['return']) void doRemoveSource(slot.label, false)
        else if (input === 'y' && slot.installedIds.length > 0) void doRemoveSource(slot.label, true)
        return
      }
      case 'fetch': {
        if (key['return']) void runFetchProposal(slot)
        return
      }
      case 'option': {
        if (key['return']) {
          const keyName = slot.keys[slot.index]!
          const declared = slot.schema[keyName]
          const value: OptionValue =
            declared?.type === 'number' ? Number(slot.text) : declared?.type === 'boolean' ? slot.text.trim() === 'true' : slot.text
          const out = saveOptionValues(slot.id, slot.schema, { [keyName]: value })
          if (!out.ok) {
            setNote(out.error)
            setSlot(null)
            return
          }
          const nextIndex = slot.index + 1
          if (nextIndex < slot.keys.length) setSlot({ ...slot, index: nextIndex, text: '' })
          else {
            setSlot(null)
            setNote('options saved')
            refresh()
          }
          return
        }
        if (key['backspace'] || key['delete']) setSlot({ ...slot, text: slot.text.slice(0, -1) })
        else if (typed) setSlot({ ...slot, text: slot.text + typed })
        return
      }
      default:
        return
    }
  }

  const onSlotEscape = (): void => {
    if (slot === null) return
    if (slot.mode === 'add' && slot.busy) return
    if (slot.mode === 'filter' && slot.text !== '') {
      setSlot({ ...slot, text: '' })
      setFilterText('')
      return
    }
    setSlot(null)
  }

  const confirmFace = (parts: [string, string]): { node: React.ReactNode; rows: number } => {
    const one = `${parts[0]} · ${parts[1]}`
    if (one.length <= Math.max(20, cols - 6)) {
      return {
        rows: 1,
        node: (
          <Text color={tokens.textSecondary} wrap="truncate-end">
            {one}
          </Text>
        ),
      }
    }
    return {
      rows: 2,
      node: (
        <Box flexDirection="column">
          <Text color={tokens.textSecondary} wrap="truncate-end">
            {parts[0]}
          </Text>
          <Text color={tokens.textSecondary} wrap="truncate-end">
            {parts[1]}
          </Text>
        </Box>
      ),
    }
  }
  const slotNode = ((): { node: React.ReactNode; rows: number } | null => {
    if (slot !== null) {
      switch (slot.mode) {
        case 'add': {
          const line = slot.busy ?? slot.error ?? 'a git URL, a folder or an archive · ↵ adds · esc cancels'
          return {
            rows: 2,
            node: (
              <Box flexDirection="column">
                <Text color={slot.error ? tokens.failure : tokens.textMuted} wrap="truncate-end">
                  {line}
                </Text>
                <Text wrap="truncate-end">
                  <Text color={tokens.accent}>add › </Text>
                  <Text color={tokens.textPrimary}>{slot.text}</Text>
                  <Text color={tokens.accent}>▌</Text>
                </Text>
              </Box>
            ),
          }
        }
        case 'filter':
          return {
            rows: 2,
            node: (
              <Box flexDirection="column">
                <Text color={tokens.textMuted} wrap="truncate-end">
                  typing narrows both sections · esc clears, then closes
                </Text>
                <Text wrap="truncate-end">
                  <Text color={tokens.accent}>filter › </Text>
                  <Text color={tokens.textPrimary}>{slot.text}</Text>
                  <Text color={tokens.accent}>▌</Text>
                </Text>
              </Box>
            ),
          }
        case 'uninstall':
          return confirmFace(
            slot.inPlace
              ? [`forget ${slot.name}? the folder stays in the repo`, '↵ forget · esc cancel']
              : slot.dataBytes > 0
                ? [`uninstall ${slot.name} ${slot.version} (${slot.label}) · data ${bytesWord(slot.dataBytes)}`, 'y delete data · k keep data · esc cancel']
                : [`uninstall ${slot.name} ${slot.version} (${slot.label})`, '↵ uninstall · esc cancel'],
          )
        case 'remove-source': {
          const names = slot.installedIds.map(id => id.split('@')[0])
          const shown = names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2} more` : '')
          return confirmFace(
            slot.installedIds.length > 0
              ? [`remove ${slot.label}? · ${slot.installedIds.length} installed from it: ${shown}`, '↵ remove the source only · y also uninstall them · esc cancel']
              : [`remove ${slot.label}?`, '↵ remove · esc cancel'],
          )
        }
        case 'fetch':
          return confirmFace([`fetch ${slot.name} from ${slot.url} to inspect?`, '↵ fetch · esc not now'])
        case 'option': {
          const keyName = slot.keys[slot.index]!
          const declared = slot.schema[keyName]
          const masked = declared?.sensitive ? '•'.repeat(slot.text.length) : slot.text
          return {
            rows: 2,
            node: (
              <Box flexDirection="column">
                <Text color={tokens.textMuted} wrap="truncate-end">
                  {`option ${slot.index + 1}/${slot.keys.length} · ${keyName}${declared?.sensitive ? ' (sensitive)' : ''}${declared?.required ? ' · required' : ''}${declared?.description ? ` · ${declared.description}` : ''} · ↵ saves · esc skips`}
                </Text>
                <Text wrap="truncate-end">
                  <Text color={tokens.accent}>{keyName} › </Text>
                  <Text color={tokens.textPrimary}>{masked}</Text>
                  <Text color={tokens.accent}>▌</Text>
                </Text>
              </Box>
            ),
          }
        }
        default:
          return null
      }
    }
    if (note !== null) {
      const budget = Math.max(20, cols - 6)
      const noteRows: string[] = []
      let current = ''
      for (const piece of note.split(' — ')) {
        const candidate = current === '' ? piece : `${current} — ${piece}`
        if (candidate.length <= budget || current === '') current = candidate
        else {
          noteRows.push(current)
          current = piece
        }
      }
      noteRows.push(current)
      const shown = noteRows.slice(0, 3)
      return {
        rows: shown.length,
        node: (
          <Box flexDirection="column">
            {shown.map((line, i) => (
              <Text key={i} color={tokens.textMuted} wrap="truncate-end">
                {line}
              </Text>
            ))}
          </Box>
        ),
      }
    }
    return null
  })()

  const wide = cols >= 140
  const installedColumns: ColumnDef<BoardRow>[] = [
    {
      key: 'state',
      header: 'state',
      width: 10,
      cell: r => {
        if (r.kind !== 'ext') return <Text color={tokens.textMuted}>—</Text>
        const w = trustWord(trustStateOf(r.entry), r.health)
        return (
          <Text color={tokens[w.role]} wrap="truncate-end">
            {w.glyph} {w.word}
          </Text>
        )
      },
    },
    {
      key: 'name',
      header: 'name',
      width: 16,
      cell: r => (
        <Text color={tokens.textPrimary} wrap="truncate-end">
          {r.kind === 'ext' ? r.entry.name : r.row.label}
        </Text>
      ),
    },
    {
      key: 'ver',
      header: 'ver',
      width: 7,
      cell: r => (
        <Text color={tokens.textMuted} wrap="truncate-end">
          {r.kind === 'ext' ? r.entry.version || '—' : '—'}
        </Text>
      ),
    },
    {
      key: 'from',
      header: 'from',
      width: 11,
      cell: r => (
        <Text color={tokens.textMuted} wrap="truncate-end">
          {r.kind === 'ext' ? r.entry.label : r.row.record.kind}
        </Text>
      ),
    },
    ...(wide
      ? [
          {
            key: 'adds',
            header: 'adds',
            width: 22,
            cell: (r: BoardRow) => {
              if (r.kind !== 'ext' || r.entry.manifest === null) return <Text color={tokens.textMuted}>—</Text>
              const counts = contributionCounts(r.entry.manifest)
              const parts = Object.entries(counts).map(([kind, n]) => `${n} ${n === 1 ? kind.replace(/s$/, '') : kind}`)
              return (
                <Text color={tokens.textMuted} wrap="truncate-end">
                  {parts.length > 0 ? parts.join(' · ') : '—'}
                </Text>
              )
            },
          } satisfies ColumnDef<BoardRow>,
        ]
      : []),
    {
      key: 'note',
      header: 'note',
      cell: r => (
        <Text color={tokens.textMuted} wrap="truncate-end">
          {r.kind === 'ext' ? noteWords(r.entry, r.health) : ''}
        </Text>
      ),
    },
  ]

  const sourceColumns: ColumnDef<BoardRow>[] = [
    {
      key: 'state',
      header: 'state',
      width: 11,
      cell: r => {
        if (r.kind !== 'src') return <Text color={tokens.textMuted}>—</Text>
        const w = sourceStateWord(r.row.state)
        return (
          <Text color={tokens[w.role]} wrap="truncate-end">
            {w.glyph} {w.word}
          </Text>
        )
      },
    },
    {
      key: 'source',
      header: 'source',
      width: 12,
      cell: r => (
        <Text color={tokens.textPrimary} wrap="truncate-end">
          {r.kind === 'src' ? r.row.label : ''}
        </Text>
      ),
    },
    {
      key: 'kind',
      header: 'kind',
      width: 7,
      cell: r => (
        <Text color={tokens.textMuted} wrap="truncate-end">
          {r.kind === 'src' ? r.row.record.kind : ''}
        </Text>
      ),
    },
    {
      key: 'where',
      header: 'where',
      cell: r => {
        if (r.kind !== 'src') return <Text color={tokens.textMuted}>—</Text>
        const blocked = matchBlock([r.row.label, r.row.record.where]) !== null
        return (
          <Text color={tokens.textMuted} wrap="truncate-end">
            {sourceWhereWords(r.row)}
            {blocked ? <Text color={tokens.failure}> · blocked</Text> : null}
          </Text>
        )
      },
    },
  ]

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

  const sideInfo = (r: BoardRow): React.ReactNode => {
    if (r.kind === 'ext') return <ExtensionSidePane entry={r.entry} health={healthOf(r.entry.id)} />
    return <SourceSidePane row={r.row} />
  }

  if (view.kind === 'source') {
    return (
      <SourceView
        label={view.label}
        onBack={seedRow => toBoard({ section: 'sources', row: seedRow ?? `src:${view.label}` })}
        onInstall={(label, name) => void doInstall(label, name, { section: 'sources', row: `src:${label}` })}
        onUpdate={entry => void doUpdate(entry, { section: 'sources', row: `src:${view.label}` })}
        onUninstall={entry => openUninstallConfirm(entry)}
        onClose={onClose}
        slot={
          slotNode !== null
            ? { node: slotNode.node, rows: slotNode.rows, active: slot !== null, onInput: onSlotInput, onEscape: onSlotEscape }
            : null
        }
        entries={entries}
        sources={sources}
      />
    )
  }
  if (view.kind === 'ext') {
    const entry = entries.find(e => e.id === view.id)
    if (entry) {
      return (
        <ExtensionView
          entry={entry}
          health={healthOf(entry.id)}
          onBack={() => toBoard({ section: 'installed', row: `ext:${view.id}` })}
          onToggle={() => toggleRow(entry)}
          onUpdate={() => void doUpdate(entry, { section: 'installed', row: `ext:${view.id}` })}
          onUninstall={() => {
            toBoard({ section: 'installed', row: `ext:${view.id}` })
            openUninstallConfirm(entry)
          }}
          onOptions={() => {
            toBoard({ section: 'installed', row: `ext:${view.id}` })
            openOptions(entry)
          }}
          onBlock={() => toggleBlockEntry(entry)}
          onPrevious={() => doSwapPrevious(entry)}
          onRefreshRoster={refresh}
        />
      )
    }
  }
  if (view.kind === 'card') {
    return (
      <ApprovalCardView
        card={view.card}
        onApprove={scope => cardApprove(view.card, scope)}
        onKeep={() => cardKeep(view.card)}
        onUninstall={() => cardUninstall(view.card)}
        onBack={() => cardEsc(view.card)}
      />
    )
  }

  const boardSeed: BoardSeed = view.kind === 'board' ? view.seed : { section: 'installed' }
  const sections: SectionDef<BoardRow>[] = [
    {
      id: 'installed',
      label: 'installed',
      count: extRows.length,
      rows: extRows,
      emptyHint:
        filter !== ''
          ? 'nothing matches the filter'
          : '○ no extensions yet\nsources › a adds a git URL, a folder or an archive\ndocs/EXTENSIONS.md explains how to make one',
    },
    {
      id: 'sources',
      label: 'sources',
      count: srcRows.length,
      rows: srcRows,
      emptyHint: filter !== '' ? 'nothing matches the filter' : '○ no sources\na adds a git URL, a folder or an archive',
    },
  ]

  const summary = rosterSummary(
    entries,
    new Map(Object.entries(extensions.health).flatMap(([id, h]) => (h ? [[id, h.outcome]] : []))),
    sources.length,
  )
  const rollup = activeSection === 'installed' ? installedRollup(summary, cols >= 110) : sourcesRollup(sources, cols >= 110)

  const anyRows = extRows.length > 0 || srcRows.length > 0
  const addChar = kchar('add-source')
  const reloadChar = kchar('reload')
  const filterChar = kchar('filter')
  const footerHints = [
    addChar !== null ? `${charWord(addChar)} ${activeSection === 'installed' ? 'source' : 'add'}` : null,
    reloadArmed && reloadChar !== null ? `${charWord(reloadChar)} reload` : null,
    anyRows && filterChar !== null ? (filterText !== '' ? `${charWord(filterChar)} filter (${filterText})` : `${charWord(filterChar)} filter`) : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <NavigablePanes<BoardRow>
      view="extensions"
      subtitle={basename(getCwd())}
      sections={sections}
      columns={activeSection === 'installed' ? installedColumns : sourceColumns}
      rowKey={rowKeyOf}
      renderDetail={sideInfo}
      onClose={onClose}
      onActivate={row => {
        setNote(null)
        if (row.kind === 'src') setView({ kind: 'source', label: row.row.label })
        else if (trustStateOf(row.entry) === 'found') openCardForEntry(row.entry, { section: 'installed', row: rowKeyOf(row) })
        else setView({ kind: 'ext', id: row.entry.id })
      }}
      rowActions={rowActions}
      sideInfo={sideInfo}
      footerHints={footerHints}
      headerRight={
        <Text color={tokens.textMuted} wrap="truncate-end">
          {extensions.problems.length > 0 ? <Text color={tokens.warning}>{extensions.problems[0]} · </Text> : null}
          {rollup}
        </Text>
      }
      {...(boardSeed.section !== undefined ? { initialSectionId: boardSeed.section } : {})}
      {...(boardSeed.row !== undefined ? { initialRowKey: boardSeed.row } : {})}
      onSectionChange={id => {
        setNote(null)
        setActiveSection(id === 'sources' ? 'sources' : 'installed')
      }}
      composerSlot={
        slotNode !== null
          ? {
              active: slot !== null,
              node: slotNode.node,
              rows: slotNode.rows,
              onInput: onSlotInput,
              onEscape: onSlotEscape,
            }
          : undefined
      }
    />
  )
}
