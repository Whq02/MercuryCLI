import * as React from 'react'
import { useRef, useState } from 'react'
import { useLoad, useMount } from '../effects/effects.js'
import { basename } from 'node:path'
import { Text, useInput } from '../themedRenderer.js'
import { useAppState, useSetAppState } from '../app-state/AppState.js'
import { rosterSummary, trustStateOf } from '../../integrations/extensions/roster.js'
import {
  listSources,
  type SourceRow,
} from '../../integrations/extensions/sources.js'
import type { Health, RosterEntry } from '../../integrations/extensions/types.js'
import { getCwd } from '../../platform/files/cwd.js'
import {
  NavigablePanes,
  type SectionDef,
} from '../widgets/NavigablePanes.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { useOpenEventGate } from '../widgets/useOpenEventGate.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { ApprovalCardView } from './ApprovalCardView.js'
import { charWord, resolveExtensionsBindings } from './bindings.js'
import { ExtensionView } from './ExtensionView.js'
import { SourceView } from './SourceView.js'
import {
  installedRollup,
  noteWords,
  sourcesRollup,
} from './rowWords.js'
import { boardActions, installCardActions, rowSourceActions } from './board/actions.js'
import { boardColumns } from './board/columns.js'
import { boardRowActions } from './board/rowActions.js'
import { ExtensionSidePane, SourceSidePane } from './board/SidePanes.js'
import { slotParts } from './board/slot.js'
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

  if (view.kind === 'ext' && !entries.some(e => e.id === view.id)) toBoard({ section: 'installed' })
  else if (view.kind === 'source' && !sources.some(s => s.label === view.label)) toBoard({ section: 'sources' })

  const routedRef = useRef(false)
  useLoad(() => {
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

  useMount(() => {
    if (kb.declined.length === 0) return
    setNote(kb.declined.length === 1 ? kb.declined[0]! : `${kb.declined[0]!} (+${kb.declined.length - 1} more — /keys lists the table)`)
  })

  const { onSlotInput, onSlotEscape, slotNode } = slotParts({ slot, setSlot, setFilterText, setNote, note, cols, tokens, runAdd, doUninstallNow, doRemoveSource, runFetchProposal, refresh })

  const { installedColumns, sourceColumns } = boardColumns({ cols, tokens })

  const rowActions = boardRowActions({ kchar, toggleRow, openCardForEntry, doUpdate, openUninstallConfirm, toggleBlockEntry, openOptions, doSwapPrevious, doRefreshSource, setSlot, toggleBlockSource })

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
