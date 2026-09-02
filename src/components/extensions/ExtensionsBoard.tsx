// ============================================================================
//  ExtensionsBoard — the /extensions board (spec 05): two sections,
//  INSTALLED and SOURCES, on the panes chassis. The board paints the core's
//  one-owner facts — computeRoster()/computeHealth() published into the
//  AppState `extensions` slice, listSources(), trustStateOf — and derives
//  nothing. Views replace the board whole (the WorkflowsBoard ViewState
//  pattern; one NavigablePanes live at a time): the source view, the
//  extension view, the approval card (card.ts approvalCardLines verbatim —
//  the CLI and the board show the SAME card). The ONE composer slot carries
//  add · filter · the confirms (uninstall / source-remove / proposal-fetch)
//  · the options walk. Adding a source never installs (the operator's
//  ruling); approval never switches anything on before its reload; `r` is
//  the swap and prints the one transcript line.
// ============================================================================
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { basename } from 'node:path'
import { Box, Text, useInput } from '../../ink.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import { computeActiveSet } from '../../extensions/active.js'
import { isExtensionsPending, noteReloaded, reloadExtensions, setExtensionsPending } from '../../extensions/boot.js'
import { block, matchBlock, unblock } from '../../extensions/blocklist.js'
import type { CardKind } from '../../extensions/card.js'
import {
  approve,
  approveUpdate,
  discardUpdate,
  installFromSource,
  setSwitch,
  swapToPrevious,
  uninstall,
  uninstallPreview,
  update,
} from '../../extensions/install.js'
import { contributionCounts, readManifest, type ManifestNeeds } from '../../extensions/manifest.js'
import { isOptionSet, saveOptionValues, type OptionValue } from '../../extensions/options.js'
import { rosterSummary, trustStateOf } from '../../extensions/roster.js'
import {
  addSource,
  installedFromSource,
  listSources,
  removeSource,
  refreshSource,
  type SourceRow,
} from '../../extensions/sources.js'
import type { Health, RosterEntry } from '../../extensions/types.js'
import { extensionsStateFrom } from '../../hooks/useExtensions.js'
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
import { ExtensionView } from './ExtensionView.js'
import { SourceView } from './SourceView.js'
import {
  age,
  installedRollup,
  noteWords,
  sourceStateWord,
  sourceWhereWords,
  sourcesRollup,
  trustWord,
} from './rowWords.js'

// ── the deep links (05 §7) ──────────────────────────────────────────────────

export type ExtensionsRoute =
  | { kind: 'board'; section: 'installed' | 'sources' }
  | { kind: 'open'; name: string }
  | { kind: 'add'; raw: string }
  | { kind: 'install'; target: string }

// ── rows ────────────────────────────────────────────────────────────────────

type BoardRow =
  | { kind: 'ext'; entry: RosterEntry; health: Health | null }
  | { kind: 'src'; row: SourceRow }

function rowKeyOf(row: BoardRow): string {
  return row.kind === 'ext' ? `ext:${row.entry.id}` : `src:${row.row.label}`
}

// ── the view machine (each view replaces the previous whole) ────────────────

export type CardSpec = {
  id: string
  cardKind: CardKind
  /** The manifest root the card renders (the fetched update's folder on a diff card). */
  root: string
  label: string
  where: string | null
  commit: string | null
  previous: { root: string; version: string } | null
  /** Where esc lands. */
  back: BoardSeed
}

type BoardSeed = { section?: 'installed' | 'sources'; row?: string }

type View =
  | { kind: 'board'; seed: BoardSeed }
  | { kind: 'source'; label: string }
  | { kind: 'ext'; id: string }
  | { kind: 'card'; card: CardSpec }

// ── the one composer slot ───────────────────────────────────────────────────

type Slot =
  | { mode: 'add'; text: string; busy: string | null; error: string | null }
  | { mode: 'filter'; text: string }
  | { mode: 'uninstall'; id: string; name: string; version: string; label: string; dataBytes: number; inPlace: boolean }
  | { mode: 'remove-source'; label: string; installedIds: string[] }
  | { mode: 'fetch'; id: string; name: string; url: string; ref: string | null }
  | { mode: 'option'; id: string; schema: NonNullable<ManifestNeeds['options']>; keys: string[]; index: number; text: string }

function bytesWord(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// ── the board ───────────────────────────────────────────────────────────────

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

  // The ONE dispatch path through the operator's keybindings (05 §2.3): the
  // resolver decides each action's character; the chassis rowActions grammar
  // stays the single dispatcher. Resolved once per board open.
  const kb = React.useMemo(() => resolveExtensionsBindings(), [])
  const kchar = (action: string): string | null => kb.chars.get(`extensions:${action}`) ?? null
  // A DECLINED action's spec-default character answers honestly when pressed.
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

  // ── the repaint after any records change: recompute the core's set (a pure
  //    read — the RUNNING session's memo is the reload's to swap) and publish
  //    it onto the one AppState slice every extensions renderer reads.
  const refresh = (): void => {
    const set = computeActiveSet()
    setAppState(prev => ({
      ...prev,
      extensions: extensionsStateFrom(set, isExtensionsPending(), prev.extensions.lastReloadLine),
    }))
    setSources(listSources())
  }

  // ── the swap (04 §4): `r`, and the uninstall path (its confirm was the act).
  const doReload = async (): Promise<void> => {
    const pending = reloadExtensions({
      onServersChanged: () =>
        setAppState(prev => ({ ...prev, mcp: { ...prev.mcp, extensionReconnectKey: prev.mcp.extensionReconnectKey + 1 } })),
    })
    noteReloaded(pending)
    const result = await pending
    setExtensionsPending(false)
    // The swap's own set was computed BEFORE it published its snapshot, so
    // its roster still carries the pre-swap pending flags; the settled truth
    // is a fresh read against the snapshot the swap just published.
    const settled = computeActiveSet()
    setAppState(prev => ({ ...prev, extensions: extensionsStateFrom(settled, false, result.line) }))
    setSources(listSources())
    appendTranscript(result.line)
    setNote(result.line)
  }

  const toBoard = (seed: BoardSeed): void => {
    // The chassis re-mounts on the way back and seeds itself from the view
    // state; the column mirror must land on the same section (the mount
    // fires no onSectionChange).
    setActiveSection(seed.section ?? 'installed')
    setView({ kind: 'board', seed })
  }

  // ── actions ───────────────────────────────────────────────────────────────

  const openCardForEntry = (entry: RosterEntry, back: BoardSeed): void => {
    if (entry.home === 'proposal' && entry.proposal) {
      setSlot({ mode: 'fetch', id: entry.id, name: entry.name, url: entry.proposal.source, ref: entry.proposal.ref ?? null })
      return
    }
    if (entry.root === null) {
      setNote(`${entry.name}: nothing to approve — ${entry.manifestErrors[0] ?? 'folder missing'}`)
      return
    }
    const pending = entry.record?.pendingUpdate
    if (pending) {
      setView({
        kind: 'card',
        card: {
          id: entry.id,
          cardKind: 'update',
          root: pending.path,
          label: entry.label,
          where: entry.source?.where ?? null,
          commit: pending.commit,
          previous: { root: entry.record!.path, version: entry.record!.version },
          back,
        },
      })
      return
    }
    setView({
      kind: 'card',
      card: {
        id: entry.id,
        cardKind: entry.home === 'project' ? 'project folder' : 'install',
        root: entry.root,
        label: entry.label,
        where: entry.source?.where ?? (entry.home === 'project' ? entry.root : null),
        commit: entry.record?.commit ?? null,
        previous: null,
        back,
      },
    })
  }

  const doInstall = async (label: string, name: string, back: BoardSeed): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setNote(`installing ${name}…`)
    try {
      const out = await installFromSource(label, name, { progress: line => setNote(line) })
      if (!out.ok) {
        setNote(out.reason)
        return
      }
      setNote(null)
      refresh()
      setView({
        kind: 'card',
        card: {
          id: out.id,
          cardKind: 'install',
          root: out.root,
          label,
          where: listSources().find(s => s.label === label)?.record.where ?? null,
          commit: out.record.commit,
          previous: null,
          back,
        },
      })
    } finally {
      busyRef.current = false
    }
  }

  const doUpdate = async (entry: RosterEntry, back: BoardSeed): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setNote(`updating ${entry.name}…`)
    try {
      const out = await update(entry.id, { progress: line => setNote(line) })
      if (!out.ok) {
        setNote(out.reason)
        return
      }
      if (out.outcome === 'current') {
        setNote(`${entry.name} is current`)
        refresh()
        return
      }
      refresh()
      if (out.outcome === 'carried') {
        setNote(`${entry.name} ${out.from} → ${out.to} · approval carried · r reloads`)
        return
      }
      const pending = out.record.pendingUpdate
      if (!pending) {
        setNote(`${entry.name}: the fetched update is missing its record`)
        return
      }
      setNote(null)
      setView({
        kind: 'card',
        card: {
          id: entry.id,
          cardKind: 'update',
          root: pending.path,
          label: entry.label,
          where: entry.source?.where ?? null,
          commit: pending.commit,
          previous: { root: out.record.path, version: out.from },
          back,
        },
      })
    } finally {
      busyRef.current = false
    }
  }

  const startOptionsWalk = (id: string, root: string): boolean => {
    const read = readManifest(root)
    if (read.status !== 'ok') return false
    const schema = read.manifest.needs?.options
    if (!schema) return false
    const keys = Object.entries(schema)
      .filter(([key, option]) => option.required && !isOptionSet(id, schema, key))
      .map(([key]) => key)
    if (keys.length === 0) return false
    setSlot({ mode: 'option', id, schema, keys, index: 0, text: '' })
    return true
  }

  const cardApprove = (card: CardSpec, scope: 'everywhere' | 'project'): void => {
    if (card.cardKind === 'update') {
      const out = approveUpdate(card.id)
      if (!out.ok) {
        setNote(out.reason)
        return
      }
    } else {
      const out = approve(card.id, { scope, root: card.root })
      if (!out.ok) {
        setNote(out.reason)
        return
      }
    }
    refresh()
    toBoard({ section: 'installed', row: `ext:${card.id}` })
    if (!startOptionsWalk(card.id, card.root)) setNote(`${card.id} approved · r reloads`)
  }

  const cardKeep = (card: CardSpec): void => {
    if (card.cardKind === 'update') {
      const out = discardUpdate(card.id)
      setNote(out.ok ? `${card.id} stays at ${card.previous?.version ?? 'its version'} — the fetched copy was removed` : out.reason)
    } else {
      setNote(`${card.id} kept installed, off`)
    }
    refresh()
    toBoard(card.back.row ? card.back : { section: 'installed', row: `ext:${card.id}` })
  }

  const doUninstallNow = async (id: string, keepData: boolean): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      const wasApproved = entries.find(e => e.id === id)?.record?.approval != null
      const out = uninstall(id, { keepData })
      if (!out.ok) {
        setNote(out.reason)
        return
      }
      setSlot(null)
      if (wasApproved) await doReload()
      refresh()
      setNote(`uninstalled ${id}${out.dataKept ? ' · data kept' : ''}`)
    } finally {
      busyRef.current = false
    }
  }

  const openUninstallConfirm = (entry: RosterEntry): void => {
    const preview = uninstallPreview(entry.id)
    setSlot({
      mode: 'uninstall',
      id: entry.id,
      name: entry.name,
      version: preview?.version ?? entry.version,
      label: entry.label,
      dataBytes: preview?.dataBytes ?? 0,
      inPlace: entry.home === 'project',
    })
  }

  const cardUninstall = (card: CardSpec): void => {
    toBoard(card.back)
    void doUninstallNow(card.id, false)
  }

  const cardEsc = (card: CardSpec): void => {
    if (card.cardKind === 'update') {
      const out = discardUpdate(card.id)
      if (!out.ok) setNote(out.reason)
      else setNote(`${card.id} stays at ${card.previous?.version ?? 'its version'} — the fetched copy was removed`)
      refresh()
    }
    toBoard(card.back.row ? card.back : { section: 'installed', row: `ext:${card.id}` })
  }

  const toggleRow = (entry: RosterEntry): void => {
    if (!entry.approved || entry.changedSinceApproval) {
      openCardForEntry(entry, { section: 'installed', row: `ext:${entry.id}` })
      return
    }
    const scope = entry.switchScope === 'project' ? 'project' : 'everywhere'
    const out = setSwitch(entry.id, !entry.switchedOn, scope)
    if (!out.ok) {
      setNote(out.reason)
      return
    }
    setNote(null)
    refresh()
  }

  const toggleBlockEntry = (entry: RosterEntry): void => {
    if (entry.blockedBy === 'policy') {
      setNote('blocked by policy — ask your administrator')
      return
    }
    if (entry.blockedBy === 'operator') {
      const match = matchBlock([entry.id, entry.label, entry.source?.where ?? null, entry.proposal?.source ?? null])
      const out = match ? unblock(match.entry) : { ok: true as const }
      if (!out.ok) {
        setNote(out.error)
        return
      }
    } else {
      const out = block(entry.id)
      if (!out.ok) {
        setNote(out.error)
        return
      }
    }
    setNote(null)
    refresh()
  }

  const toggleBlockSource = (row: SourceRow): void => {
    const match = matchBlock([row.label, row.record.where])
    if (match?.by === 'policy') {
      setNote('blocked by policy — ask your administrator')
      return
    }
    const out = match ? unblock(match.entry) : block(row.record.where)
    if (!out.ok) {
      setNote(out.error)
      return
    }
    setNote(null)
    refresh()
  }

  const doRefreshSource = async (label: string): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setNote(`checking ${label}…`)
    try {
      const out = await refreshSource(label, { progress: line => setNote(line) })
      if (out.ok) {
        const updates = out.updates.length
        setNote(`${label}: ${updates === 0 ? 'no updates' : `${updates} update${updates === 1 ? '' : 's'} found`}${out.delisted.length > 0 ? ` · ${out.delisted.length} no longer offered` : ''}`)
      } else {
        setNote(`${label}: ${out.reason}`)
      }
      refresh()
    } finally {
      busyRef.current = false
    }
  }

  const doRemoveSource = async (label: string, alsoUninstall: boolean): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      setSlot(null)
      let swapped = false
      if (alsoUninstall) {
        for (const id of installedFromSource(label)) {
          const wasApproved = entries.find(e => e.id === id)?.record?.approval != null
          const out = uninstall(id, {})
          if (!out.ok) {
            setNote(out.reason)
            return
          }
          swapped = swapped || wasApproved
        }
      }
      const out = removeSource(label)
      if (!out.ok) {
        setNote(out.reason)
        return
      }
      if (swapped) await doReload()
      refresh()
      setNote(`removed ${label}${alsoUninstall ? ' and its extensions' : out.installedFromIt.length > 0 ? ` · ${out.installedFromIt.length} installed cop${out.installedFromIt.length === 1 ? 'y keeps' : 'ies keep'} working` : ''}`)
    } finally {
      busyRef.current = false
    }
  }

  const runAdd = async (raw: string): Promise<void> => {
    if (busyRef.current) return
    if (raw.trim() === '') return
    busyRef.current = true
    setSlot({ mode: 'add', text: raw, busy: 'adding…', error: null })
    try {
      const out = await addSource(raw.trim(), {
        progress: line => setSlot(s => (s?.mode === 'add' ? { ...s, busy: line } : s)),
      })
      if (out.ok) {
        setSlot(null)
        setNote(null)
        refresh()
        setView({ kind: 'source', label: out.label })
      } else {
        setSlot(s => (s?.mode === 'add' ? { ...s, busy: null, error: out.reason } : s))
      }
    } finally {
      busyRef.current = false
    }
  }

  const runFetchProposal = async (fetchSlot: Extract<Slot, { mode: 'fetch' }>): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setSlot(null)
    try {
      let label = listSources().find(s => s.record.where === fetchSlot.url)?.label
      if (!label) {
        setNote(`fetching ${fetchSlot.url}…`)
        const added = await addSource(fetchSlot.url + (fetchSlot.ref ? `#${fetchSlot.ref}` : ''), {
          progress: line => setNote(line),
        })
        if (!added.ok) {
          setNote(added.reason)
          return
        }
        label = added.label
        refresh()
      }
      busyRef.current = false
      await doInstall(label, fetchSlot.name, { section: 'installed', row: `ext:${fetchSlot.id}` })
    } finally {
      busyRef.current = false
    }
  }

  const doSwapPrevious = (entry: RosterEntry): void => {
    const out = swapToPrevious(entry.id)
    if (!out.ok) {
      setNote(out.reason)
      return
    }
    setNote(`${entry.name} swapped back · r reloads`)
    refresh()
  }

  const openOptions = (entry: RosterEntry): void => {
    if (entry.root === null || entry.manifest === null) {
      setNote(`${entry.name}: no manifest to read options from`)
      return
    }
    const schema = entry.manifest.needs?.options
    if (!schema || Object.keys(schema).length === 0) {
      setNote(`${entry.name} declares no options`)
      return
    }
    setSlot({ mode: 'option', id: entry.id, schema, keys: Object.keys(schema), index: 0, text: '' })
  }

  // A view whose row vanished under it (uninstalled from another surface)
  // falls home instead of stranding a dead frame.
  useEffect(() => {
    if (view.kind === 'ext' && !entries.some(e => e.id === view.id)) toBoard({ section: 'installed' })
    if (view.kind === 'source' && !sources.some(s => s.label === view.label)) toBoard({ section: 'sources' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, entries, sources])

  // ── the deep links (once, at mount) ───────────────────────────────────────
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── the board's sections, filtered ────────────────────────────────────────
  const filter = filterText.trim().toLowerCase()
  const extRows: BoardRow[] = entries
    .filter(e => filter === '' || `${e.name} ${e.label} ${noteWords(e, healthOf(e.id))}`.toLowerCase().includes(filter))
    .map(entry => ({ kind: 'ext', entry, health: healthOf(entry.id) }))
  const srcRows: BoardRow[] = sources
    .filter(r => filter === '' || `${r.label} ${r.record.kind} ${r.record.where}`.toLowerCase().includes(filter))
    .map(row => ({ kind: 'src', row }))

  const reloadArmed = extensions.pending || entries.some(e => e.pending !== null)

  // Board-level keys (the sibling-useInput idiom the sibling boards ride):
  // add · filter · reload, on their RESOLVED characters. A declined action's
  // spec-default character answers with its honest line — never dead, never
  // silently the default. Never live while the composer slot owns input or a
  // view has replaced the board.
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

  // The rebind limits paint once at open — the operator sees WHY a stored
  // binding is not on the rail before any key goes dead.
  useEffect(() => {
    if (kb.declined.length === 0) return
    setNote(kb.declined.length === 1 ? kb.declined[0]! : `${kb.declined[0]!} (+${kb.declined.length - 1} more — /keys lists the table)`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── the slot's input ──────────────────────────────────────────────────────
  const onSlotInput = (input: string, key: Record<string, boolean>): void => {
    if (slot === null) return
    const typed = input && !key['ctrl'] && !key['meta'] && !key['tab'] && !key['return'] ? input : ''
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

  // ── the slot's face ───────────────────────────────────────────────────────
  // A confirm is one line while it fits (05 §6's one-line forms); when the
  // facts would push the exits off the canvas the KEYS take their own row —
  // the shedding law: the reserved exits never shed.
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
      // A note keeps its whole sentence: split at its own ' — ' joints into
      // rows when it would shed its tail (the file a rebind line names, the
      // key a refusal names).
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

  // ── columns per section (the section mirror) ──────────────────────────────
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
      // 11, not the installed section's 10: the taxonomy's own word
      // `○ unchecked` is eleven cells, and a state word never truncates.
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
      // 7, not the spec's 6: the taxonomy's own word `archive` is seven
      // cells, and a kind word never truncates (the state column's law).
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

  // ── row actions (armed exactly when advertised) ───────────────────────────
  const isExt = (r: BoardRow): r is Extract<BoardRow, { kind: 'ext' }> => r.kind === 'ext'
  const isSrc = (r: BoardRow): r is Extract<BoardRow, { kind: 'src' }> => r.kind === 'src'
  const toggleable = (r: BoardRow): boolean =>
    isExt(r) && (r.entry.home === 'installed' || r.entry.home === 'bundled' || (r.entry.home === 'project' && r.entry.record !== null))

  // Each action's character comes from the resolver; an unresolvable action
  // (chord-rebound, unbound, displaced) is OMITTED — never armed, never
  // advertised — and its default character answers with the honest line.
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
    // sources
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

  // ── the standing side pane / fold bottom card (05 §3) ─────────────────────
  const sideInfo = (r: BoardRow): React.ReactNode => {
    if (r.kind === 'ext') return <ExtensionSidePane entry={r.entry} health={healthOf(r.entry.id)} />
    return <SourceSidePane row={r.row} />
  }

  // ── views replace the board whole ─────────────────────────────────────────
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
    // The row vanished under the view (uninstalled elsewhere): fall home.
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

  // ── the board ─────────────────────────────────────────────────────────────
  const boardSeed: BoardSeed = view.kind === 'board' ? view.seed : { section: 'installed' }
  const sections: SectionDef<BoardRow>[] = [
    {
      id: 'installed',
      label: 'installed',
      count: extRows.length,
      rows: extRows,
      // Short lines: at the mid layout with no rows the chassis keeps its left
      // section nav, and a one-line hint would lose the maker doc's name.
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

// ── the side panes (05 §3) ──────────────────────────────────────────────────

function ExtensionSidePane({ entry, health }: { entry: RosterEntry; health: Health | null }): React.ReactNode {
  const tokens = useMercuryTokens()
  const w = trustWord(trustStateOf(entry), health)
  const counts = entry.manifest ? contributionCounts(entry.manifest) : {}
  const addsParts = Object.entries(counts).map(([kind, n]) => `${n} ${n === 1 ? kind.replace(/s$/, '') : kind}`)
  const lines: Array<{ k: string; v: string; tone?: string }> = []
  if (entry.home === 'proposal') {
    lines.push({ k: 'found', v: 'proposed by this project' })
    lines.push({ k: 'from', v: entry.proposal?.source ?? '' })
    lines.push({ k: 'next', v: 'i fetches, then the card' })
  } else {
    lines.push({ k: 'from', v: entry.home === 'project' ? 'this project' : entry.label })
    if (entry.source?.where) lines.push({ k: '', v: entry.source.where })
    else if (entry.home === 'project' && entry.root) lines.push({ k: '', v: entry.root })
    lines.push({ k: 'health', v: `${w.glyph} ${w.word}`, tone: tokens[w.role] })
    for (const reason of (health?.reasons ?? []).slice(0, 3)) lines.push({ k: '', v: reason, tone: tokens[w.role] })
    if (addsParts.length > 0) {
      lines.push({ k: 'adds', v: addsParts.slice(0, 2).join(' · ') })
      for (let i = 2; i < addsParts.length; i += 2) lines.push({ k: '', v: addsParts.slice(i, i + 2).join(' · ') })
    }
    const needs = entry.manifest?.needs
    if (needs?.binaries?.length) lines.push({ k: 'needs', v: needs.binaries.join(' · ') })
    if (needs?.env?.length) lines.push({ k: needs.binaries?.length ? '' : 'needs', v: needs.env.join(' · ') })
    if (entry.record?.approval) lines.push({ k: 'approved', v: `${entry.record.approval.at.slice(0, 10)} · ${entry.record.approval.version}` })
    else if (entry.home !== 'bundled') lines.push({ k: 'approved', v: 'not yet · i approves' })
    lines.push({ k: 'switch', v: entry.switchScope === 'project' ? 'this project' : entry.switchScope === 'everywhere' ? 'everywhere' : 'off' })
    if (entry.availableVersion) lines.push({ k: 'update', v: `↑ ${entry.availableVersion} · U applies`, tone: tokens.warning })
  }
  return (
    <Box flexDirection="column">
      <Text bold color={tokens.accent} wrap="truncate-end">
        {entry.name} {entry.version}
      </Text>
      {lines.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          <Text color={tokens.textMuted}>{(l.k + '          ').slice(0, 10)}</Text>
          <Text color={l.tone ?? tokens.textPrimary}>{l.v}</Text>
        </Text>
      ))}
    </Box>
  )
}

function SourceSidePane({ row }: { row: SourceRow }): React.ReactNode {
  const tokens = useMercuryTokens()
  const w = sourceStateWord(row.state)
  const lines: Array<{ k: string; v: string; tone?: string }> = [
    { k: 'kind', v: `${row.record.kind}${row.record.ref ? ` · ${row.record.ref}` : ''}` },
    { k: 'where', v: row.record.where },
    ...(row.record.commit ? [{ k: 'commit', v: row.record.commit.slice(0, 7) }] : []),
    { k: 'checked', v: `${age(row.record.checkedAt)} · ${w.word}`, tone: tokens[w.role] },
    ...(row.record.lastError ? [{ k: 'error', v: row.record.lastError, tone: tokens.failure }] : []),
    { k: 'offers', v: row.catalogue ? `${row.offered} extension${row.offered === 1 ? '' : 's'}` : row.catalogueError ?? 'unknown' },
    ...(row.installed > 0 || row.updates > 0
      ? [{ k: '', v: `${row.installed} installed${row.updates > 0 ? ` · ${row.updates} update${row.updates === 1 ? '' : 's'}` : ''}` }]
      : []),
    { k: 'added', v: row.record.addedAt.slice(0, 10) },
  ]
  return (
    <Box flexDirection="column">
      <Text bold color={tokens.accent} wrap="truncate-end">
        {row.label}
      </Text>
      {lines.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          <Text color={tokens.textMuted}>{(l.k + '          ').slice(0, 10)}</Text>
          <Text color={l.tone ?? tokens.textPrimary}>{l.v}</Text>
        </Text>
      ))}
      <Text color={tokens.textMuted}>↵ opens its extensions</Text>
    </Box>
  )
}
