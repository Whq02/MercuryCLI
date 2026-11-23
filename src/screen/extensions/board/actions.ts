import * as React from 'react'
import { computeActiveSet } from '../../../integrations/extensions/active.js'
import { isExtensionsPending, noteReloaded, reloadExtensions, setExtensionsPending } from '../../../integrations/extensions/boot.js'
import { block, matchBlock, unblock } from '../../../integrations/extensions/blocklist.js'
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
} from '../../../integrations/extensions/install.js'
import { readManifest } from '../../../integrations/extensions/manifest.js'
import { isOptionSet } from '../../../integrations/extensions/options.js'
import {
  addSource,
  installedFromSource,
  listSources,
  removeSource,
  refreshSource,
  type SourceRow,
} from '../../../integrations/extensions/sources.js'
import type { RosterEntry } from '../../../integrations/extensions/types.js'
import { extensionsStateFrom } from '../useExtensions.js'
import type { useSetAppState } from '../../app-state/AppState.js'
import type { BoardSeed, CardSpec, Slot, View } from './shapes.js'

type BoardHands = {
  setAppState: ReturnType<typeof useSetAppState>
  setSources: React.Dispatch<React.SetStateAction<SourceRow[]>>
  setView: React.Dispatch<React.SetStateAction<View>>
  setActiveSection: React.Dispatch<React.SetStateAction<'installed' | 'sources'>>
  setSlot: React.Dispatch<React.SetStateAction<Slot | null>>
  setNote: React.Dispatch<React.SetStateAction<string | null>>
  appendTranscript: (line: string) => void
  busyRef: { current: boolean }
  entries: RosterEntry[]
}

export function boardActions({ setAppState, setSources, appendTranscript, setNote, setActiveSection, setView }: Pick<BoardHands, 'setAppState' | 'setSources' | 'appendTranscript' | 'setNote' | 'setActiveSection' | 'setView'>) {
  const refresh = (): void => {
    const set = computeActiveSet()
    setAppState(prev => ({
      ...prev,
      extensions: extensionsStateFrom(set, isExtensionsPending(), prev.extensions.lastReloadLine),
    }))
    setSources(listSources())
  }

  const doReload = async (): Promise<void> => {
    const pending = reloadExtensions({
      onServersChanged: () =>
        setAppState(prev => ({ ...prev, mcp: { ...prev.mcp, extensionReconnectKey: prev.mcp.extensionReconnectKey + 1 } })),
    })
    noteReloaded(pending)
    const result = await pending
    setExtensionsPending(false)
    const settled = computeActiveSet()
    setAppState(prev => ({ ...prev, extensions: extensionsStateFrom(settled, false, result.line) }))
    setSources(listSources())
    appendTranscript(result.line)
    setNote(result.line)
  }

  const toBoard = (seed: BoardSeed): void => {
    setActiveSection(seed.section ?? 'installed')
    setView({ kind: 'board', seed })
  }
  return { refresh, doReload, toBoard }
}

type BoardActions = ReturnType<typeof boardActions>

export function installCardActions({ setSlot, setNote, setView, busyRef, entries, refresh, doReload, toBoard }: Pick<BoardHands, 'setSlot' | 'setNote' | 'setView' | 'busyRef' | 'entries'> & BoardActions) {
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
        setNote(`${entry.name} ${out.from} → ${out.to} · approval kept · r reloads`)
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
  return { openCardForEntry, doInstall, doUpdate, cardApprove, cardKeep, doUninstallNow, openUninstallConfirm, cardUninstall, cardEsc }
}

type InstallCardActions = ReturnType<typeof installCardActions>

export function rowSourceActions({ setNote, setSlot, setView, busyRef, entries, refresh, doReload, openCardForEntry, doInstall }: Pick<BoardHands, 'setNote' | 'setSlot' | 'setView' | 'busyRef' | 'entries'> & Pick<BoardActions, 'refresh' | 'doReload'> & Pick<InstallCardActions, 'openCardForEntry' | 'doInstall'>) {
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
  return { toggleRow, toggleBlockEntry, toggleBlockSource, doRefreshSource, doRemoveSource, runAdd, runFetchProposal, doSwapPrevious, openOptions }
}
