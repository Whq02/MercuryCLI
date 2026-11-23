import * as React from 'react'
import type { Key, InputEvent } from '../../themedRenderer.js'
import type { PageLine } from '../memoryCentreLayout.js'
import { type Page, type OpenRef, printable, type CentreCorrecting, type CentreFlatList } from './refs.js'

export type CentreKeys = {
  correcting: CentreCorrecting | null
  setCorrecting: React.Dispatch<React.SetStateAction<CentreCorrecting | null>>
  commitCorrection: () => void
  page: Page | null
  detail: OpenRef | null
  armed: number | string | null
  setArmed: React.Dispatch<React.SetStateAction<number | string | null>>
  fl: CentreFlatList
  setPage: React.Dispatch<React.SetStateAction<Page | null>>
  setDetail: React.Dispatch<React.SetStateAction<OpenRef | null>>
  setPageOffset: React.Dispatch<React.SetStateAction<number>>
  pageRows: number
  openLines: PageLine[]
  onOpenFile: ((path: string) => void) | undefined
  detailActs: boolean
  detailSeq: number | null
  detailPendingTs: string | null
  retirePending: (ts: string) => void
  pinPending: (ts: string) => void
  detailPendingPinned: boolean
  retireSelected: (seq: number) => void
  detailLive: boolean
  togglePin: (seq: number, pin: boolean) => void
  detailPinned: boolean
  loadError: CentreFlatList['loadError']
  query: string
  setQuery: React.Dispatch<React.SetStateAction<string>>
  setSearchFocus: React.Dispatch<React.SetStateAction<boolean>>
}

export function correctingKeys({ correcting, setCorrecting, commitCorrection }: CentreKeys, input: string, key: Key, event: InputEvent): boolean {
  if (correcting) {
    if (key.escape) {
      event.stopImmediatePropagation()
      setCorrecting(null)
    } else if (key.return) commitCorrection()
    else if (key.backspace || key.delete) setCorrecting(prev => (prev ? { ...prev, buffer: prev.buffer.slice(0, -1) } : prev))
    else if (input && !key.ctrl && !key.meta) setCorrecting(prev => (prev ? { ...prev, buffer: prev.buffer + input } : prev))
    return true
  }
  return false
}

export function openKeys({ setCorrecting, page, detail, armed, setArmed, fl, setPage, setDetail, setPageOffset, pageRows, openLines, onOpenFile, detailActs, detailSeq, detailPendingTs, retirePending, pinPending, detailPendingPinned, retireSelected, detailLive, togglePin, detailPinned }: CentreKeys, input: string, key: Key, event: InputEvent): boolean {
  if (page || detail) {
    if (key.escape || key.leftArrow) {
      event.stopImmediatePropagation()
      if (armed !== null) {
        setArmed(null)
        fl.setNote(null)
        return true
      }
      if (page) setPage(null)
      else setDetail(null)
      fl.reload()
      setPageOffset(0)
      return true
    }
    if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
      event.stopImmediatePropagation()
      const step = key.pageUp || key.pageDown ? Math.max(1, pageRows - 1) : 1
      const direction = key.upArrow || key.pageUp ? -1 : 1
      setPageOffset(offset => Math.max(0, Math.min(Math.max(0, openLines.length - pageRows), offset + direction * step)))
      return true
    }
    if (page) {
      if (input === 'e' && !key.ctrl && !key.meta && page.kind === 'file' && page.path && onOpenFile) onOpenFile(page.path)
      return true
    }
    if (key.ctrl || key.meta || !detailActs) return true
    if (detailSeq === null) {
      if (detailPendingTs === null) return true
      if (armed !== null) {
        if (input === 'x' && armed === detailPendingTs) {
          setArmed(null)
          retirePending(detailPendingTs)
        } else if (input) {
          setArmed(null)
          fl.setNote({ text: 'kept the pending fact — nothing changed', kind: 'warn' })
        }
        return true
      }
      if (input === 'c' && !key.ctrl && !key.meta) setCorrecting({ seq: null, ts: detailPendingTs, buffer: '' })
      else if (input === 'x') {
        setArmed(detailPendingTs)
        fl.setNote({ text: 'retire this pending fact? x again strikes it before it consolidates · any other key keeps it', kind: 'warn' })
      } else if (input === 'p' && !detailPendingPinned) pinPending(detailPendingTs)
      return true
    }
    if (armed !== null) {
      if (input === 'x' && armed === detailSeq) {
        setArmed(null)
        retireSelected(detailSeq)
      } else if (input) {
        setArmed(null)
        fl.setNote({ text: `kept seq ${detailSeq} — nothing changed`, kind: 'warn' })
      }
      return true
    }
    if (input === 'c' && !key.ctrl && !key.meta && detailLive) setCorrecting({ seq: detailSeq, ts: null, buffer: '' })
    else if (input === 'x' && detailLive) {
      setArmed(detailSeq)
      fl.setNote({ text: `retire seq ${detailSeq}? x again retires it (kept in history) · any other key keeps it`, kind: 'warn' })
    } else if (input === 'p' && !detailPinned && detailLive) togglePin(detailSeq, true)
    else if (input === 'u' && detailPinned) togglePin(detailSeq, false)
    return true
  }
  return false
}

export function listKeys({ fl, loadError, query, setQuery, setSearchFocus }: CentreKeys, input: string, key: Key): void {
  if (loadError && input === 'r' && !key.ctrl && !key.meta) {
    fl.reload()
    return
  }
  if (key.backspace || key.delete) {
    if (query.length > 0) setQuery(q => q.slice(0, -1))
    return
  }
  if (input === '/' && !key.ctrl && !key.meta && query === '') {
    setSearchFocus(true)
    return
  }
  if (input && !key.ctrl && !key.meta && !key.return && !key.upArrow && !key.downArrow && !key.tab && !key.escape && !key.leftArrow && !key.rightArrow) {
    const typed = printable(input)
    if (typed !== '') setQuery(q => q + typed)
  }
}
